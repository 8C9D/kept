import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { SessionTokens } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { isUniqueViolation } from "../db/errors.js";
import { visibleTo } from "../db/receiptQueries.js";
import { receiptFieldOptions, receiptImages, receipts } from "../db/schema.js";
import { ApiError, notFoundError } from "../http/errors.js";
import type { z } from "zod";
import type { OcrFieldSuggestions } from "../domain/ocrSuggestions.js";
import type { ReceiptOptionField } from "../domain/receiptFieldOptions.js";
import {
  createReceiptSchema,
  deleteReceiptOptionQuerySchema,
  listCursorSchema,
  listOrderSchema,
  listReceiptsQuerySchema,
  listSortSchema,
  ocrSuggestionsSchema,
  parseOcrTextSchema,
  possibleDuplicatesQuerySchema,
  receiptFilterQuerySchema,
  receiptImageSchema,
  receiptOptionFieldSchema,
  renameReceiptOptionSchemas,
  updateReceiptSchema,
  uploadUrlSchema,
  type ReceiptOptionApiField,
} from "../http/schemas.js";
import {
  parseOrThrow,
  readJsonBody,
  uuidParamOrNotFound,
} from "../http/validate.js";
import { sessionAuth, type AuthedEnv } from "../http/sessionAuth.js";
import {
  mergeSuggestions,
  type MergedSuggestions,
} from "../domain/mergedSuggestions.js";
import type { LlmParseSweepHandle } from "../parse/llmParseSweep.js";
import { LlmParseError } from "../parse/claudeReceiptParser.js";
import { RECEIPT_PARSE_PROMPT_VERSION } from "../domain/llmSuggestions.js";
import {
  assertIssuedObjectKey,
  isIssuedObjectKey,
  receiptImageObjectKey,
} from "../storage/objectKeys.js";
import type { ObjectStorage } from "../storage/objectStorage.js";

/**
 * The bound LLM parse, as `POST /api/receipts/parse` calls it: text in,
 * suggestions out, nothing written anywhere (2026-09-01). The entrypoint
 * binds the same function into the sweep, so both paths always run the same
 * model over the same prompt.
 *
 * The model id travels WITH the binding rather than beside it, for the
 * reason `LlmParseSweepDependencies.model` spells out: the route answers
 * with the id that produced the suggestions, and two separately injected
 * values are two values that can disagree - a response naming a model that
 * did not do the work is exactly the corruption that stamp exists to
 * prevent.
 */
export interface ParseOcrText {
  /** Exact model id `parse` calls; echoed in the response. */
  model: string;
  parse(ocrRawText: string, capturedAt: Date): Promise<OcrFieldSuggestions>;
}

interface ReceiptRouteDependencies {
  db: Db;
  sessionTokens: SessionTokens;
  storage: ObjectStorage;
  /**
   * Absent when no ANTHROPIC_API_KEY is configured (local dev without a
   * key): receipts then carry heuristic suggestions only. Production
   * refuses to start without the key (productionEnv.ts), so the handle is
   * always present there.
   */
  llmParseSweep?: LlmParseSweepHandle;
  /** Absent on exactly the sweep's terms; the route then answers 503. */
  parseOcrText?: ParseOcrText;
}

export function receiptRoutes(deps: ReceiptRouteDependencies): Hono<AuthedEnv> {
  const router = new Hono<AuthedEnv>();
  router.use("*", sessionAuth(deps.sessionTokens, deps.db));

  /**
   * POST /api/receipts/upload-url - a presigned PUT the client uploads the
   * image to before creating the receipt. The object key is prefixed with
   * the session user's id and made unguessable by a uuid (spec §10B);
   * the calendar-based yyyy/mm segment follows §5.1.
   */
  router.post("/upload-url", async (c) => {
    const body = parseOrThrow(uploadUrlSchema, await readJsonBody(c));
    const objectKey = receiptImageObjectKey(
      c.get("userId"),
      new Date(),
      randomUUID(),
      body.contentType,
    );
    if (!isIssuedObjectKey(objectKey, c.get("userId"))) {
      // The shape this route issues and the shape the create route accepts
      // are one rule; if they ever disagree, uploads would succeed and
      // creates would refuse them. Asserting here keeps the pair honest.
      throw new Error(`Issued an object key the create route would refuse: ${objectKey}`);
    }
    const uploadUrl = await deps.storage.presignUpload(
      objectKey,
      body.contentType,
    );
    return c.json({ objectKey, uploadUrl });
  });

  /** POST /api/receipts - create a receipt for its already-uploaded image. */
  router.post("/", async (c) => {
    const body = parseOrThrow(createReceiptSchema, await readJsonBody(c));
    const userId = c.get("userId");

    // Every object key in the system is issued by the upload-url route
    // above, so a key that does not match that exact shape was not issued
    // by us. Accepting an arbitrary key would let a receipt point at (and
    // later presign a download for) an object the user does not own.
    if (!isIssuedObjectKey(body.image.objectKey, userId)) {
      throw new ApiError(
        400,
        "invalid_request",
        "image.objectKey was not issued for this user",
      );
    }

    // Explicit field map, not a spread of the parsed body: a spread would
    // silently drop a schema key with no matching column, trading a visible
    // failure for an invisible one. Omitted nullable fields become null;
    // omitted currency/status stay absent so the column defaults apply.
    // userId only ever comes from the session.
    //
    // It is also what discards the retired keys the shipped iOS 1.0 (1)
    // build still sends (schemas.ts, `retiredReceiptFields`): they are named
    // nowhere below, so they reach no column.
    let created;
    try {
      created = await deps.db.transaction(async (tx) => {
        const [receipt] = await tx
          .insert(receipts)
          .values({
            userId,
            purchasedAt: body.purchasedAt,
            capturedAt: new Date(body.capturedAt),
            vendor: body.vendor ?? null,
            subtotalCents: body.subtotalCents ?? null,
            hstCents: body.hstCents ?? null,
            tipCents: body.tipCents ?? null,
            otherFeesCents: body.otherFeesCents ?? null,
            // Null while pending means "not read yet" - a stated absence,
            // never a fabricated value. The schema has already rejected a
            // confirmed create missing it.
            totalCents: body.totalCents ?? null,
            ...(body.currency !== undefined && { currency: body.currency }),
            ...(body.status !== undefined && { status: body.status }),
            category: body.category ?? null,
            paymentMethod: body.paymentMethod ?? null,
            notes: body.notes ?? null,
            ocrRawText: body.ocrRawText ?? null,
            // Where that text came from (2026-09-01). Omitted by every
            // client that predates the field, which is what null means:
            // vision-era, the only capture path there was.
            ocrSource: body.ocrSource ?? null,
            ocrSuggestions: normalizeOcrSuggestions(body.ocrSuggestions),
            // Left to the column default when the client says nothing:
            // "this client does not report reviews" and "nothing has been
            // reviewed yet" suppress the same set of suggestions, which is
            // none (domain/reviewedFields.ts).
            ...(body.reviewedFields !== undefined && {
              reviewedFields: body.reviewedFields,
            }),
          })
          .returning();
        if (receipt === undefined) {
          // An insert with .returning() always yields the row; its absence
          // means something is genuinely broken.
          throw new Error("Receipt insert returned no row");
        }
        await tx.insert(receiptImages).values({
          receiptId: receipt.id,
          userId,
          page: 1, // v1 captures a single page; the column is the multi-page seam (spec §5)
          objectKey: body.image.objectKey,
          sha256: body.image.sha256,
        });
        await rememberFieldOptions(tx, userId, receipt);
        return receipt;
      });
    } catch (error) {
      if (isUniqueViolation(error, "receipt_images_user_id_sha256_uq")) {
        throw duplicateImageError();
      }
      throw error;
    }

    // Fire-and-forget: the sweep parses this receipt's OCR text server-side
    // (spec §7.3). A kick never throws, so a model outage degrades to
    // heuristic-only suggestions - the create has already succeeded and
    // never waits on the model.
    if (created.ocrRawText !== null) {
      deps.llmParseSweep?.kick();
    }

    return c.json(receiptResponse(created), 201);
  });

  /**
   * GET /api/receipts - the user's receipts in pages, newest purchase first
   * unless `sort`/`order` say otherwise. Keyset pagination on (sort key,
   * created_at, id): stable under concurrent inserts, unlike offsets, which
   * matters during a backlog import.
   */
  router.get("/", async (c) => {
    const query = parseOrThrow(listReceiptsQuerySchema, c.req.query());
    const userId = c.get("userId");
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;
    const sort = query.sort ?? DEFAULT_SORT;
    const order = query.order ?? DEFAULT_ORDER;
    const spec = LIST_SORTS[sort];

    const conditions = buildReceiptFilterConditions(userId, query);
    if (query.cursor !== undefined) {
      const cursor = decodeListCursor(query.cursor);
      // A cursor is a position inside one specific ordering. Replaying it
      // against another would hand back a slice of a list nobody asked for,
      // silently; refusing is the only honest answer.
      if (cursor.sort !== sort || cursor.order !== order) {
        throw new ApiError(
          400,
          "invalid_request",
          "cursor was issued for a different sort order",
        );
      }
      if (cursor.sortKeyNull && !sortKeyCanBeNull(spec)) {
        throw new ApiError(400, "invalid_request", "cursor is not valid");
      }
      conditions.push(afterCursorInSort(spec, order, cursor));
    }

    // Fetch one row beyond the page: its presence means another page
    // exists, and the last row actually returned seeds the next cursor.
    const rows = await deps.db
      .select()
      .from(receipts)
      .where(and(...conditions))
      .orderBy(...listOrderBy(spec, order))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const lastRow = page[page.length - 1];
    const nextCursor =
      rows.length > limit && lastRow !== undefined
        ? encodeListCursor(lastRow, sort, order)
        : null;

    // The §5.2a pending badge on both clients reads this from the list
    // response they already fetch (wave-3 gate review; the server had no
    // count and the iOS client was probing 200 rows to display a number).
    // It is the user's total pending count, deliberately independent of
    // this request's filters and paging: the badge means "receipts
    // awaiting confirmation", not "pending rows on this page".
    const pendingRows = await deps.db
      .select({ count: sql<number>`count(*)::int` })
      .from(receipts)
      .where(and(visibleTo(userId), eq(receipts.status, "pending")));
    const pendingCount = pendingRows[0]?.count;
    if (pendingCount === undefined) {
      // count(*) always yields one row; its absence means something is
      // genuinely broken.
      throw new Error("Pending-count query returned no row");
    }

    // The list omits ocr_raw_text: it can run to 100 KB per receipt and
    // only the detail view has a use for it.
    return c.json({ receipts: page.map(receiptResponse), nextCursor, pendingCount });
  });

  /**
   * GET /api/receipts/options - the category, payment-method and vendor
   * values this user has used before, most recently used first, so both
   * clients can offer them for reuse instead of asking someone to retype
   * "office supplies" (or "Staples #4021") for the fortieth time.
   *
   * Registered ABOVE /:id: that handler 404s a non-uuid, so a literal path
   * declared after it would be shadowed into a 404 by whichever router Hono
   * picks.
   *
   * Free text in, free text out. Nothing is trimmed, case-folded or merged -
   * these are the person's own values (2026-08-26 ruling), and an options
   * list that quietly rewrote them would offer a string the exact-match
   * filter then fails to find.
   *
   * `vendors` (2026-08-28) belongs in this set even though it is a
   * transcription rather than a chosen label like category or payment
   * method: a person shops at the same handful of places, and the LLM's
   * verbatim-vendor rule (spec §7.3) is what keeps the stored strings stable
   * enough to match each other reuse after reuse. Existing clients ignore
   * the new key - the response is additive.
   *
   * `vendorDefaults` (2026-08-28, proposal #2) keys the category and
   * payment method to prefill for a vendor the person has bought from
   * before - see `vendorDefaultCandidates` below for the query and the
   * confirmed-only decision. Existing clients ignore this key too.
   *
   * **Reads `receipt_field_options` rather than re-deriving from `receipts`
   * (2026-09-01).** The response shape is unchanged - this is a change of
   * source, not of contract - but three things follow from it:
   *
   * - A value survives the deletion of the last receipt carrying it. That
   *   is the point: an option is now a thing a person keeps, and
   *   `DELETE /api/receipts/options/:field` is how it goes away, rather
   *   than deleting a retained tax record to get rid of a typo.
   * - `last_used_at` is maintained by the writes (see `rememberFieldOptions`)
   *   instead of being recomputed as `max(created_at)` on every read.
   * - **The 100-value cap is gone.** It existed because the retired query
   *   scanned every receipt a person had, and it silently truncated the
   *   list the exact-match filter is supposed to be able to reach - a
   *   category on receipt 101 could not be offered back. Reading a table
   *   indexed on `(user_id, field, last_used_at desc)` makes the whole
   *   vocabulary cheap to serve, and a person's own vocabulary is bounded
   *   by how many distinct things they have ever typed, not by their
   *   receipt count.
   */
  router.get("/options", async (c) => {
    const userId = c.get("userId");
    const [optionRows, vendorDefaultRows] = await Promise.all([
      // One query for all three fields: they share a table, an ordering and
      // a user scope, and three round-trips would only be three chances to
      // scope one of them differently.
      deps.db
        .select({
          field: receiptFieldOptions.field,
          value: receiptFieldOptions.value,
        })
        .from(receiptFieldOptions)
        .where(eq(receiptFieldOptions.userId, userId))
        .orderBy(
          desc(receiptFieldOptions.lastUsedAt),
          // A deterministic tiebreak, so a backfilled batch that shares one
          // timestamp - and the two values saved in the same millisecond -
          // do not shuffle between requests. Alphabetical is arbitrary but
          // stable, which is the whole requirement.
          asc(receiptFieldOptions.value),
        ),
      vendorDefaultCandidates(deps.db, userId),
    ]);

    const categories: string[] = [];
    const paymentMethods: string[] = [];
    const vendors: string[] = [];
    for (const row of optionRows) {
      switch (row.field) {
        case "category":
          categories.push(row.value);
          break;
        case "payment_method":
          paymentMethods.push(row.value);
          break;
        case "vendor":
          vendors.push(row.value);
          break;
        default:
          // The database's check constraint allows exactly these three, so
          // a fourth means the constraint and this switch have drifted -
          // which is worth failing on rather than dropping the row.
          throw new Error(
            `receipt_field_options holds an unknown field: ${String(row.field)}`,
          );
      }
    }

    // Scoped to the vendors this response already serves: a default for a
    // vendor string the client cannot also see in `vendors` is a default it
    // has nothing to match against.
    const knownVendors = new Set(vendors);
    const vendorDefaults: Record<
      string,
      { category: string | null; paymentMethod: string | null }
    > = {};
    for (const row of vendorDefaultRows) {
      if (row.vendor === null || !knownVendors.has(row.vendor)) {
        continue;
      }
      // A vendor whose confirmed receipts never carried either field has
      // nothing to offer - omitted rather than served as {null, null},
      // which a client would otherwise have to learn is not a default.
      if (row.category === null && row.paymentMethod === null) {
        continue;
      }
      vendorDefaults[row.vendor] = {
        category: row.category,
        paymentMethod: row.paymentMethod,
      };
    }

    return c.json({ categories, paymentMethods, vendors, vendorDefaults });
  });

  /**
   * PATCH /api/receipts/options/:field - rename one remembered value
   * everywhere it appears (2026-09-01).
   *
   * The problem: a vendor transcribed as "Loblwas" on eleven receipts was,
   * until now, eleven separate edits - and the misspelling stayed in the
   * pick-list offering itself back the whole time. One request rewrites the
   * receipts and the option together, in one transaction, so the two can
   * never end up disagreeing about what the value is.
   *
   * **Every one of the caller's receipts carrying that exact value is
   * rewritten - pending, confirmed AND soft-deleted.** The soft-deleted ones
   * are the deliberate part: a deleted receipt is a retained record that can
   * come back through POST /:id/restore, and one restored a month after a
   * rename must not reintroduce the misspelling the person removed - which
   * is exactly what scoping this to `visibleTo` would do. That is why the
   * UPDATE below scopes on `user_id` alone rather than reusing `visibleTo`.
   *
   * Exact match, never normalized, for the same reason /options serves its
   * values verbatim: `from` names a stored string, and a rename that tidied
   * it first would rewrite rows nobody asked it to touch (or none at all).
   *
   * A no-op rename (`from === to`) answers 200 with 0 without looking
   * anything up. Renaming a value to itself asks for no change, and whether
   * the option exists is not a question a request for no change needs
   * answered.
   *
   * ⚠ **Known and accepted: this takes its two locks in the opposite order
   * from an ordinary save.** PATCH /:id locks the receipt row and then
   * upserts the option; this locks the option row and then updates the
   * receipts. Two of those running at the same moment, on the same user's
   * same receipt and same value, can deadlock - which Postgres DETECTS and
   * aborts one side of, so the failure is a 500 on one request rather than
   * a hang. Left unhandled deliberately at this scale: a rename is a
   * deliberate, occasional act by one of two people, the window is a few
   * milliseconds wide, and a retry loop or a lock-ordering convention
   * spanning two routes is more machinery than the risk earns. If a third
   * writer ever appears, or renames become routine, that judgement changes.
   *
   * Registered ABOVE /:id like every other literal path in this file.
   */
  router.patch("/options/:field", async (c) => {
    const field = optionFieldParamOrBadRequest(c.req.param("field"));
    const spec = RECEIPT_OPTION_FIELDS[field];
    const body = parseOrThrow(
      renameReceiptOptionSchemas[field],
      await readJsonBody(c),
    );
    const userId = c.get("userId");

    if (body.from === body.to) {
      return c.json({ receiptsUpdated: 0 });
    }

    const receiptsUpdated = await deps.db.transaction(async (tx) => {
      // Both the row being renamed and the row it might merge into, locked
      // in ONE statement. Two sequential `FOR UPDATE` selects would take the
      // same two locks in an order that depends on which rename ran, which
      // is the shape a deadlock takes; one statement lets Postgres pick a
      // consistent order for every session.
      const locked = await tx
        .select()
        .from(receiptFieldOptions)
        .where(
          and(
            eq(receiptFieldOptions.userId, userId),
            eq(receiptFieldOptions.field, spec.stored),
            inArray(receiptFieldOptions.value, [body.from, body.to]),
          ),
        )
        .for("update");
      const source = locked.find((row) => row.value === body.from);
      if (source === undefined) {
        // Not this user's option, or no such option at all - one answer for
        // both, the same isolation rule every :id route follows (spec §3
        // constraint 4).
        throw notFoundError();
      }
      const target = locked.find((row) => row.value === body.to);

      const rewritten = await tx
        .update(receipts)
        .set(spec.set(body.to))
        // ⚠ NOT `visibleTo`: soft-deleted receipts are rewritten too, so a
        // later restore brings back the renamed value. See the doc comment.
        .where(and(eq(receipts.userId, userId), eq(spec.column, body.from)))
        .returning({ id: receipts.id });

      if (target === undefined) {
        await tx
          .update(receiptFieldOptions)
          .set({ value: body.to })
          // `last_used_at` deliberately untouched: renaming a value is
          // housekeeping, not a use of it, and bumping it would push a
          // corrected typo to the top of a list it may not belong at.
          .where(eq(receiptFieldOptions.id, source.id));
      } else {
        // The destination already exists - "Loblwas" renamed onto the
        // "Loblaws" the person had been using all along. Two rows cannot
        // both survive (the unique constraint says so), so they merge: the
        // destination keeps its place in the list, taking the LATER of the
        // two recencies, because the merged value has genuinely been used
        // as recently as the more recent of its two spellings.
        if (source.lastUsedAt > target.lastUsedAt) {
          await tx
            .update(receiptFieldOptions)
            .set({ lastUsedAt: source.lastUsedAt })
            .where(eq(receiptFieldOptions.id, target.id));
        }
        await tx
          .delete(receiptFieldOptions)
          .where(eq(receiptFieldOptions.id, source.id));
      }

      return rewritten.length;
    });

    return c.json({ receiptsUpdated });
  });

  /**
   * DELETE /api/receipts/options/:field?value=... - stop offering one
   * remembered value (2026-09-01).
   *
   * **Deletes the option row and nothing else.** Every receipt carrying the
   * text keeps it: these are tax records under a six-year retention rule
   * (spec §10B), and "stop suggesting this" is a statement about a
   * pick-list, not about history. That separation is the whole reason the
   * values live in their own table - before it, the only way to drop an
   * option was to delete the last receipt that carried it.
   *
   * It is therefore not permanent, and that is correct: saving a receipt
   * with the same value again re-adds it (`rememberFieldOptions`). A person
   * who deletes "grocries" and then types it again has typed it again.
   *
   * The value arrives as a query parameter because a DELETE in this API
   * carries no body; it is matched verbatim, unnormalized, exactly like the
   * rename's `from`.
   */
  router.delete("/options/:field", async (c) => {
    const field = optionFieldParamOrBadRequest(c.req.param("field"));
    const spec = RECEIPT_OPTION_FIELDS[field];
    const query = parseOrThrow(deleteReceiptOptionQuerySchema, c.req.query());
    const userId = c.get("userId");

    const deleted = await deps.db
      .delete(receiptFieldOptions)
      .where(
        and(
          eq(receiptFieldOptions.userId, userId),
          eq(receiptFieldOptions.field, spec.stored),
          eq(receiptFieldOptions.value, query.value),
        ),
      )
      .returning({ id: receiptFieldOptions.id });
    if (deleted.length === 0) {
      throw notFoundError();
    }
    return c.body(null, 204);
  });

  /**
   * GET /api/receipts/summary - proposal #2's companion route, #3 itself:
   * the same running-totals question `checkReceiptArithmetic` answers for
   * one receipt, asked over a whole filtered list instead.
   *
   * Takes exactly the filter parameters GET / accepts (`receiptFilterQuerySchema`)
   * and none of its paging ones - an aggregate has no pages to turn - and
   * reuses that route's own `buildReceiptFilterConditions` rather than a
   * second filter implementation that could quietly drift from it (the
   * brief's own named risk: "two filter implementations that can disagree
   * is precisely the bug this route would otherwise introduce").
   *
   * ⚠ The risk the proposal names by name: "the number invites being read
   * as a tax figure... it must exclude [pending receipts], matching the
   * export's rule exactly." Nothing with status = 'pending' may ever reach
   * an export (spec §5.2a, §6); a summary that quietly folded pending rows
   * into its totals would disagree with the export sitting next to it. So
   * this never serves one blended number - `confirmed` is the count and
   * summed money fields over confirmed rows only, and `pendingCount` is the
   * same filter's pending rows, counted and nothing else, so a client can
   * say "$X, and N pending, not counted" instead of a figure someone could
   * mistake for a finished claim.
   *
   * One query, not two: every count and sum is a `FILTER (WHERE ...)`
   * aggregate in the same SELECT, so the confirmed and pending halves are
   * computed from one snapshot of the filtered rows rather than two
   * queries that could race a concurrent write between them.
   *
   * `COALESCE(..., 0)` on every sum: a filter matching zero confirmed rows
   * must answer 0, not null - a client rendering "$0.00" is correct, and a
   * null would hand every client an absence to special-case that is really
   * just a zero.
   *
   * Registered ABOVE /:id for the same reason /options is (see that
   * route's comment): the :id handler 404s a non-uuid, so a literal path
   * declared after it would be shadowed.
   */
  router.get("/summary", async (c) => {
    const query = parseOrThrow(receiptFilterQuerySchema, c.req.query());
    const userId = c.get("userId");
    const conditions = buildReceiptFilterConditions(userId, query);

    const rows = await deps.db
      .select({
        confirmedCount: sql<number>`count(*) filter (where ${receipts.status} = ${"confirmed"})::int`,
        subtotalCents: sql<number>`coalesce(sum(${receipts.subtotalCents}) filter (where ${receipts.status} = ${"confirmed"}), 0)::int`,
        hstCents: sql<number>`coalesce(sum(${receipts.hstCents}) filter (where ${receipts.status} = ${"confirmed"}), 0)::int`,
        tipCents: sql<number>`coalesce(sum(${receipts.tipCents}) filter (where ${receipts.status} = ${"confirmed"}), 0)::int`,
        otherFeesCents: sql<number>`coalesce(sum(${receipts.otherFeesCents}) filter (where ${receipts.status} = ${"confirmed"}), 0)::int`,
        totalCents: sql<number>`coalesce(sum(${receipts.totalCents}) filter (where ${receipts.status} = ${"confirmed"}), 0)::int`,
        pendingCount: sql<number>`count(*) filter (where ${receipts.status} = ${"pending"})::int`,
      })
      .from(receipts)
      .where(and(...conditions));

    const row = rows[0];
    if (row === undefined) {
      // An aggregate with no GROUP BY always yields exactly one row, even
      // over zero matching receipts; its absence means something is
      // genuinely broken.
      throw new Error("Summary aggregate query returned no row");
    }

    return c.json({
      confirmed: {
        count: row.confirmedCount,
        subtotalCents: row.subtotalCents,
        hstCents: row.hstCents,
        tipCents: row.tipCents,
        otherFeesCents: row.otherFeesCents,
        totalCents: row.totalCents,
      },
      pendingCount: row.pendingCount,
    });
  });

  /**
   * GET /api/receipts/possible-duplicates - proposal #8 (2026-08-28), built
   * as a QUERY, never a blocker. §5's `(user_id, sha256)` partial unique
   * index only catches a byte-identical re-upload; it can never catch a
   * re-photographed piece of paper, because two photographs of one receipt
   * share no pixels. Same date + same total + (roughly) the same vendor is
   * the answer to that - the client calls this at confirm time and WARNS;
   * nothing here refuses a save, ever. A false positive is real and cheap to
   * dismiss (two identical coffees on one day is a normal Tuesday), and
   * blocking on it would be worse than the duplicate it is meant to catch.
   *
   * **Vendor comparison is normalized here, deliberately unlike every other
   * filter in this file.** `buildReceiptFilterConditions`'s category and
   * paymentMethod filters below are exact-match on purpose, because they
   * pair with /options, which hands back the person's OWN stored strings
   * verbatim - normalizing there would refuse to match a value this server
   * just offered. A duplicate warning is a different job: the case this
   * route exists to catch is two scans of the SAME paper landing as
   * "Tim Hortons" and "TIM HORTONS", which an exact match would treat as
   * unrelated. So vendor is compared case-and-whitespace-insensitively
   * (trimmed, folded) inside the SQL predicate below, and ONLY for this
   * comparison - what any route stores or returns is never normalized; the
   * response below still carries every matched receipt's vendor exactly as
   * stored (`receiptResponse`).
   *
   * **A null vendor matches a null vendor - decided.** `vendor` is optional
   * because the confirm screen's vendor field can itself be blank (an
   * illegible receipt), and that is exactly the shape a re-scanned
   * illegible receipt takes twice: two live receipts, same date, same
   * total, neither one naming a vendor. Omitting the parameter is read as
   * "compare against no vendor", matching only the caller's OWN receipts
   * that also have none - not as "ignore vendor entirely", which would make
   * this route warn on every same-date-same-total receipt regardless of
   * vendor, a much noisier signal than the proposal asks for.
   *
   * Scoped to the caller and excludes soft-deleted rows via the same
   * `visibleTo` every other read uses (spec §3 constraint 3, tested
   * explicitly in the isolation test below). `excludeId` lets a caller
   * re-checking an already-created pending receipt ask "does anything ELSE
   * match" instead of matching itself.
   *
   * Registered ABOVE /:id, the same shadowing reason as /options and
   * /summary just above.
   */
  router.get("/possible-duplicates", async (c) => {
    const query = parseOrThrow(possibleDuplicatesQuerySchema, c.req.query());
    const userId = c.get("userId");

    const conditions = [
      visibleTo(userId),
      eq(receipts.purchasedAt, query.purchasedAt),
      eq(receipts.totalCents, query.totalCents),
      query.vendor !== undefined
        ? sql`lower(trim(${receipts.vendor})) = lower(trim(${query.vendor}))`
        : isNull(receipts.vendor),
    ];
    if (query.excludeId !== undefined) {
      conditions.push(ne(receipts.id, query.excludeId));
    }

    const rows = await deps.db
      .select()
      .from(receipts)
      .where(and(...conditions))
      .orderBy(desc(receipts.createdAt))
      // A defensive cap, not a real pagination need: three exact-matched
      // fields (date, total, and vendor unless omitted) make a large result
      // pathological rather than expected. (/options carried a comparable
      // cap until 2026-09-01; that one was removed with the query that
      // needed it - see that route. This one guards a genuinely unbounded
      // match, not a list of a person's own vocabulary.)
      .limit(MAX_POSSIBLE_DUPLICATES);

    return c.json({ receipts: rows.map(receiptResponse) });
  });

  /**
   * POST /api/receipts/parse - the capture-time LLM parse (2026-09-01).
   *
   * ⚠ Registered above `/:id` like every other literal path in this router:
   * Hono matches in registration order, so a `/parse` declared after `/:id`
   * would be shadowed by it and answered as a receipt lookup for the id
   * "parse" - a 404 that looks like a missing route rather than a mis-order.
   *
   * **Why a synchronous endpoint beside the asynchronous sweep.** The sweep
   * exists so a parse survives restarts and fills `llm_suggestions` for the
   * §7.3 accuracy set; it is deliberately not on the capture path. But the
   * diagnosis over 136 production receipts found that 51 of 54 confirmations
   * happened AT CAPTURE TIME - the person is standing there with the paper
   * in hand - and that over the same receipts the model got the vendor right
   * 63% of the time against the on-device heuristic's 39%. A suggestion that
   * arrives after the receipt is confirmed helps nobody; the confirm screen
   * calls this fire-and-forget and fills in what comes back.
   *
   * **It writes nothing.** No row is read, created or updated: the request
   * carries its own text, the answer goes straight back, and the immutable
   * `llm_suggestions` record still belongs to the sweep alone. That is what
   * keeps §7.3's "written once, never updated" clause true while a second
   * caller exists - and it is pinned by a test that re-reads the receipts
   * table afterwards.
   *
   * Session-scoped like every route here. Not because it touches a person's
   * data - it does not - but because it spends money per call, and an
   * endpoint that spends money without a session is an open bill.
   */
  router.post("/parse", async (c) => {
    const body = parseOrThrow(parseOcrTextSchema, await readJsonBody(c));
    const parser = deps.parseOcrText;
    if (parser === undefined) {
      // Local development without an ANTHROPIC_API_KEY. Stated rather than
      // faked: a 200 carrying all-null suggestions would be indistinguishable
      // from a receipt the model could not read, and the client would render
      // "nothing found" for a parse that never ran.
      throw new ApiError(
        503,
        "parse_unavailable",
        "Receipt parsing is not configured on this server",
      );
    }

    try {
      const suggestions = await parser.parse(
        body.ocrRawText,
        new Date(body.capturedAt),
      );
      return c.json({
        suggestions,
        // What produced this answer, in the same two stamps every stored
        // llm_suggestions record carries, so a suggestion a person saw at
        // capture time stays attributable to a prompt generation.
        model: parser.model,
        promptVersion: RECEIPT_PARSE_PROMPT_VERSION,
      });
    } catch (error) {
      if (error instanceof LlmParseError) {
        // LlmParseError messages are written by this codebase and carry no
        // model output and no receipt text - the parser sanitizes its own
        // causes for exactly that reason (claudeReceiptParser.ts). The
        // `cause` chain is NOT rendered here regardless: only the message.
        throw new ApiError(502, "parse_failed", error.message);
      }
      throw error;
    }
  });

  /** GET /api/receipts/:id - one receipt plus presigned image downloads. */
  router.get("/:id", async (c) => {
    const id = uuidParamOrNotFound(c.req.param("id"));
    const userId = c.get("userId");

    const rows = await deps.db
      .select()
      .from(receipts)
      .where(and(eq(receipts.id, id), visibleTo(userId)));
    const receipt = rows[0];
    if (receipt === undefined) {
      throw notFoundError();
    }

    // Scoped to the session user even though the receipt lookup already
    // was: no read of receipt_images should ever rely on a caller having
    // scoped a different query correctly.
    const imageRows = await deps.db
      .select()
      .from(receiptImages)
      .where(
        and(
          eq(receiptImages.receiptId, receipt.id),
          eq(receiptImages.userId, userId),
          isNull(receiptImages.deletedAt),
        ),
      )
      .orderBy(receiptImages.page);
    // Re-checked on the way out, not only on the way in: the create route
    // validates what it accepts, which says nothing about what the row
    // holds now. This is the one place a stored key becomes a URL somebody
    // can fetch, so it is the last place the ownership question can be
    // asked (see assertIssuedObjectKey).
    const images = await Promise.all(
      imageRows.map(async (image) => {
        assertIssuedObjectKey(image.objectKey, userId);
        return {
          page: image.page,
          downloadUrl: await deps.storage.presignDownload(image.objectKey),
        };
      }),
    );

    return c.json({
      ...receiptResponse(receipt),
      ocrRawText: receipt.ocrRawText,
      // The confirm screen marks exactly the fields the parser suggested
      // (wave-4 reviewer pass): value-presence is a lying proxy once a
      // fallback (the capture-day date) or a non-OCR writer exists.
      ocrSuggestions: receipt.ocrSuggestions,
      images,
    });
  });

  /**
   * POST /api/receipts/:id/images - add a page to an existing receipt
   * (proposal #6, 2026-08-28: "`receipt_images` has had a `page` column
   * since wave 1 and nothing has ever written page 2"). The image is
   * uploaded to storage first via POST /api/receipts/upload-url, exactly
   * like the create route's image, and this route only records where it
   * landed - the same two-step shape.
   *
   * `page` is assigned by the SERVER, never taken from the request: the
   * receipt's current maximum LIVE page plus one. A client-chosen page
   * number is a client-chosen primary key, and two devices adding a page to
   * the same receipt at the same moment would collide on it. The receipt
   * row is locked FOR UPDATE for the read-then-insert below, which is what
   * turns "two devices at once" into "one goes first, the other computes
   * its next page from the first's result" instead of a TOCTOU race where
   * both read the same max and both insert page N+1.
   *
   * Scoped to the caller's own receipt exactly like every other :id route -
   * a receipt that does not exist, or exists but is someone else's, is a
   * 404 either way (spec §3 constraint 4). This check is why the row lock
   * is taken on `receipts`, not on `receiptImages`: adding a page inserts a
   * row that does not exist yet, so there is no existing receipt_images row
   * whose own user_id could do the scoping the way the replace route below
   * gets to rely on.
   */
  router.post("/:id/images", async (c) => {
    const id = uuidParamOrNotFound(c.req.param("id"));
    const body = parseOrThrow(receiptImageSchema, await readJsonBody(c));
    const userId = c.get("userId");

    if (!isIssuedObjectKey(body.objectKey, userId)) {
      throw new ApiError(
        400,
        "invalid_request",
        "objectKey was not issued for this user",
      );
    }

    let created: typeof receiptImages.$inferSelect;
    try {
      created = await deps.db.transaction(async (tx) => {
        const receiptRows = await tx
          .select({ id: receipts.id })
          .from(receipts)
          .where(and(eq(receipts.id, id), visibleTo(userId)))
          .for("update");
        if (receiptRows.length === 0) {
          throw notFoundError();
        }

        const maxPageRows = await tx
          .select({ maxPage: sql<number | null>`max(${receiptImages.page})` })
          .from(receiptImages)
          .where(
            and(
              eq(receiptImages.receiptId, id),
              eq(receiptImages.userId, userId),
              isNull(receiptImages.deletedAt),
            ),
          );
        // Every receipt is created with a page-1 image (the create route
        // requires one), so maxPage is null only if that invariant has
        // already broken - in which case starting again at page 1 is the
        // correct recovery, not a second failure on top of the first.
        const nextPage = (maxPageRows[0]?.maxPage ?? 0) + 1;

        const inserted = await tx
          .insert(receiptImages)
          .values({
            receiptId: id,
            userId,
            page: nextPage,
            objectKey: body.objectKey,
            sha256: body.sha256,
          })
          .returning();
        const image = inserted[0];
        if (image === undefined) {
          // An insert with .returning() always yields the row; its absence
          // means something is genuinely broken.
          throw new Error("Image insert returned no row");
        }
        return image;
      });
    } catch (error) {
      if (isUniqueViolation(error, "receipt_images_user_id_sha256_uq")) {
        throw duplicateImageError();
      }
      throw error;
    }

    return c.json(await imageResponse(deps.storage, userId, created), 201);
  });

  /**
   * PUT /api/receipts/:id/images/:page - replace the bytes behind one page
   * (proposal #6, 2026-08-28). The repair path for the §8 sharp edge: a
   * receipt whose image object is missing - a presigned PUT that failed or
   * was interrupted, followed by a create the client still sent - jams
   * every export of its period, and until this route existed the only
   * remedy was deleting the receipt and capturing it again, which throws
   * away its vendor, date, total and HST from every future export.
   *
   * Soft-deletes the live row at that page and inserts a new one at the
   * same page number, in one transaction - the same retention rule every
   * other delete in this codebase follows: the old row is kept, `deleted_at`
   * stamped, never hard-deleted. This is exactly why migration 0008 exists:
   * `receipt_images_receipt_id_page_uq` was a plain unique constraint
   * (wave 1), so a tombstoned row would still occupy its (receipt_id, page)
   * slot forever and this insert would 23505 against its own just-deleted
   * predecessor. The migration makes that index partial on
   * `deleted_at IS NULL`, the identical fix wave 1 already made once on the
   * sha256 index below.
   *
   * ⚠ Mind the sha256 constraint here too. Soft-deleting the OLD row first,
   * in the same transaction as the insert, is what lets an identical
   * re-upload of the SAME broken bytes succeed (the tombstoned row no
   * longer occupies the slot) - the same delete-first-then-capture ordering
   * spec §5 and Runbook §6 already teach for a whole-receipt recapture,
   * applied here to one page. A re-photographed piece of paper produces
   * different bytes and collides with nothing, ordering or not. What still
   * 409s, correctly, is a file whose bytes are byte-identical to some OTHER
   * live image this user owns - a real duplicate, not a repair - and that
   * answers the same named `duplicate_image` error the create and add-page
   * routes do, never a raw constraint violation.
   *
   * Scoping deliberately does NOT re-check the `receipts` table the way the
   * add-page route above does. The UPDATE's WHERE clause requires
   * `receiptImages.userId = <caller>` in addition to matching the page, and
   * `user_id` is denormalized onto this table for exactly this reason (spec
   * §5: "a constraint that needs a join is not a constraint") - a row can
   * only match if this caller already owns the receipt it belongs to, so a
   * foreign receipt id or a foreign or nonexistent page both fall out as
   * zero rows updated, the same 404 the detail route gives.
   */
  router.put("/:id/images/:page", async (c) => {
    const id = uuidParamOrNotFound(c.req.param("id"));
    const page = pageParamOrBadRequest(c.req.param("page"));
    const body = parseOrThrow(receiptImageSchema, await readJsonBody(c));
    const userId = c.get("userId");

    if (!isIssuedObjectKey(body.objectKey, userId)) {
      throw new ApiError(
        400,
        "invalid_request",
        "objectKey was not issued for this user",
      );
    }

    let created: typeof receiptImages.$inferSelect;
    try {
      created = await deps.db.transaction(async (tx) => {
        const replaced = await tx
          .update(receiptImages)
          .set({ deletedAt: new Date() })
          .where(
            and(
              eq(receiptImages.receiptId, id),
              eq(receiptImages.userId, userId),
              eq(receiptImages.page, page),
              isNull(receiptImages.deletedAt),
            ),
          )
          .returning({ id: receiptImages.id });
        if (replaced.length === 0) {
          // No live image at this page for this user: either the receipt
          // is not theirs, the receipt does not exist, or this page never
          // existed. All three are "not found", never "forbidden" (spec §3
          // constraint 4).
          throw notFoundError();
        }

        const inserted = await tx
          .insert(receiptImages)
          .values({
            receiptId: id,
            userId,
            page,
            objectKey: body.objectKey,
            sha256: body.sha256,
          })
          .returning();
        const image = inserted[0];
        if (image === undefined) {
          throw new Error("Image insert returned no row");
        }
        return image;
      });
    } catch (error) {
      if (isUniqueViolation(error, "receipt_images_user_id_sha256_uq")) {
        throw duplicateImageError();
      }
      throw error;
    }

    return c.json(await imageResponse(deps.storage, userId, created), 200);
  });

  /**
   * POST /api/receipts/:id/restore - undo a soft delete (proposal #9,
   * 2026-08-28: swipe-to-delete is landing on iOS, and a delete that is only
   * "recoverable in principle" - the row is still there, but nothing exposes
   * getting it back - makes a swipe a one-gesture accident against a tax
   * record). Clears `deleted_at` on the receipt AND on the image rows
   * tombstoned WITH it, scoped to the caller, in one transaction.
   *
   * **A POST action route, not `PATCH {deletedAt: null}` or a DELETE-style
   * body.** Restoring is not a field edit: it can legitimately FAIL (the
   * trap below), and it touches a second table in the same transaction -
   * exactly the two reasons add-a-page and replace-a-page above are their
   * own routes instead of folding into PATCH.
   *
   * **Not time-limited, decided.** §10B's retention window is six years,
   * and this is not `DELETE /api/me`'s hard, irreversible destruction - a
   * soft-deleted receipt is a retained record, kept for exactly the same
   * reason an un-deleted one is, so there is no principled cutoff before
   * which a restore should start refusing. (Nothing sweeps a soft-deleted
   * row today either; if that ever changes, this route changes with it.)
   *
   * **Only images tombstoned by THIS delete come back - never one
   * tombstoned earlier by a page replace.** A receipt's images can be
   * tombstoned two different ways: `PUT .../images/:page` retires a
   * superseded page (spec §5) at whatever moment that replace happened, and
   * `DELETE /:id` retires every LIVE image at the moment of deletion,
   * stamping the receipt and those images with the exact same `deleted_at`
   * value in one transaction (see the DELETE handler above - `deletedAt` is
   * one `new Date()` shared by both updates). That shared timestamp is what
   * this route matches on: only image rows whose `deleted_at` equals the
   * receipt's OWN `deleted_at` are un-tombstoned. A row retired earlier by a
   * replace keeps an earlier timestamp and is left alone, correctly still
   * retired as the superseded version it is - restoring the receipt must
   * not resurrect a page image the person had already replaced before ever
   * deleting the receipt.
   *
   * ⚠ **THE TRAP, and handling it is most of this route.** Both of
   * `receipt_images`' unique indexes are partial, `WHERE deleted_at IS
   * NULL` (spec §5) - which is what lets a slot be reused after a delete.
   * So: delete a receipt, re-capture the identical file (now allowed - the
   * slot freed), then try to restore the FIRST receipt - its tombstoned
   * image's sha256 now collides with the second receipt's LIVE row.
   * Un-tombstoning it would violate the very constraint that made the
   * recapture possible. This can only be discovered at the UPDATE, so it is
   * caught there and turned into a clean, named 409 rather than a raw
   * constraint violation reaching the caller - in the same spirit as §8's
   * missing-image export failure and the create/add-page/replace routes'
   * own `duplicate_image` 409. It happens inside the SAME transaction as the
   * receipt's own un-delete, so a failure here leaves the receipt DELETED,
   * never restored without its images.
   *
   * Scoping is deliberately INDISTINGUISHABLE across three cases - an id
   * that does not exist, one that belongs to someone else, and one that
   * exists and is the caller's own but is not currently deleted - all three
   * are the same 404. A 400 that said "this receipt isn't deleted" would
   * confirm to a caller that an id exists and belongs to them: the exact
   * cross-user leak `notFoundError()` exists to prevent everywhere else in
   * this file (spec §3 constraint 3, the detail route's own rule).
   */
  router.post("/:id/restore", async (c) => {
    const id = uuidParamOrNotFound(c.req.param("id"));
    const userId = c.get("userId");

    let restored: typeof receipts.$inferSelect;
    try {
      restored = await deps.db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(receipts)
          .where(
            and(
              eq(receipts.id, id),
              eq(receipts.userId, userId),
              isNotNull(receipts.deletedAt),
            ),
          )
          .for("update");
        const existing = rows[0];
        if (existing === undefined) {
          // Nonexistent, someone else's, or not currently deleted - one
          // answer for all three (see the doc comment above).
          throw notFoundError();
        }
        if (existing.deletedAt === null) {
          // Guaranteed non-null by isNotNull() above; narrows the type for
          // TS and, if it is ever somehow wrong, fails loudly instead of
          // matching every other receipt's null deletedAt below.
          throw new Error("Receipt selected as deleted has a null deletedAt");
        }
        const tombstonedAt = existing.deletedAt;

        const updated = await tx
          .update(receipts)
          .set({ deletedAt: null })
          .where(and(eq(receipts.id, id), eq(receipts.userId, userId)))
          .returning();
        const receipt = updated[0];
        if (receipt === undefined) {
          // Selected FOR UPDATE moments ago in this same transaction; its
          // absence means something is genuinely broken.
          throw new Error("Receipt restore update returned no row");
        }

        const restoredImages = await tx
          .update(receiptImages)
          .set({ deletedAt: null })
          .where(
            and(
              eq(receiptImages.receiptId, id),
              eq(receiptImages.userId, userId),
              eq(receiptImages.deletedAt, tombstonedAt),
            ),
          )
          .returning({ id: receiptImages.id });
        if (restoredImages.length === 0) {
          // Every receipt is created with a page-1 image (the create route
          // requires one), and DELETE /:id tombstones every image live at
          // the moment of deletion with the receipt's own deletedAt - so
          // finding none tombstoned alongside this receipt means that
          // invariant has already broken, not that this receipt
          // legitimately has zero images to bring back.
          throw new Error(
            `Restoring receipt ${id} found no images tombstoned alongside it`,
          );
        }

        return receipt;
      });
    } catch (error) {
      if (
        isUniqueViolation(error, "receipt_images_user_id_sha256_uq") ||
        isUniqueViolation(error, "receipt_images_receipt_id_page_uq")
      ) {
        throw restoreConflictError();
      }
      throw error;
    }

    return c.json(receiptResponse(restored));
  });

  /**
   * PATCH /api/receipts/:id - edit fields; only provided keys change.
   *
   * A confirmed receipt is editable, deliberately and not incidentally: a
   * human corrects a typed total or a mis-keyed vendor after confirming it,
   * and nothing in the spec makes confirmation a lock. What confirming does
   * mean is that the row can no longer become incomplete - see the gate
   * below.
   */
  router.patch("/:id", async (c) => {
    const id = uuidParamOrNotFound(c.req.param("id"));
    const body = parseOrThrow(updateReceiptSchema, await readJsonBody(c));
    const userId = c.get("userId");

    // Explicit field map, same reasoning as the create handler: only keys
    // the client sent change, every field named here is one the compiler
    // checks against its column, and the retired keys the shipped iOS
    // 1.0 (1) build still sends are discarded by being named nowhere.
    const changes: Partial<typeof receipts.$inferInsert> = {};
    if (body.purchasedAt !== undefined) changes.purchasedAt = body.purchasedAt;
    if (body.capturedAt !== undefined)
      changes.capturedAt = new Date(body.capturedAt);
    if (body.vendor !== undefined) changes.vendor = body.vendor;
    if (body.subtotalCents !== undefined)
      changes.subtotalCents = body.subtotalCents;
    if (body.hstCents !== undefined) changes.hstCents = body.hstCents;
    if (body.tipCents !== undefined) changes.tipCents = body.tipCents;
    if (body.otherFeesCents !== undefined)
      changes.otherFeesCents = body.otherFeesCents;
    if (body.totalCents !== undefined) changes.totalCents = body.totalCents;
    if (body.currency !== undefined) changes.currency = body.currency;
    if (body.category !== undefined) changes.category = body.category;
    if (body.paymentMethod !== undefined)
      changes.paymentMethod = body.paymentMethod;
    if (body.notes !== undefined) changes.notes = body.notes;
    if (body.status !== undefined) changes.status = body.status;
    if (body.ocrRawText !== undefined) changes.ocrRawText = body.ocrRawText;
    // Replaces the stored set outright - the client sends the full set it
    // knows (schemas.ts). A patch that confirms the receipt keeps whatever
    // was sent or already stored: the record stops mattering once the row
    // is confirmed, and clearing it would be a write whose only purpose is
    // tidiness, thrown away exactly when an unconfirm would want it back.
    if (body.reviewedFields !== undefined)
      changes.reviewedFields = body.reviewedFields;

    // Read-check-write in one transaction: whether this edit leaves the
    // receipt complete depends on the row's current values, not just the
    // patch. The database's check constraint backstops this; the point of
    // doing it here is a clean 400 naming the missing field.
    const updatedReceipt = await deps.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(receipts)
        .where(and(eq(receipts.id, id), visibleTo(userId)))
        .for("update");
      const existing = rows[0];
      if (existing === undefined) {
        throw notFoundError();
      }

      const resulting = {
        status: body.status ?? existing.status,
        totalCents:
          body.totalCents !== undefined ? body.totalCents : existing.totalCents,
      };
      if (resulting.status === "confirmed" && resulting.totalCents === null) {
        throw new ApiError(
          400,
          "invalid_request",
          "a confirmed receipt requires a total",
        );
      }

      // A body carrying nothing but the retired keys above asks for no
      // change to any column. The shipped client's patch is answered with
      // the row as it stands rather than with an empty UPDATE (which the
      // driver refuses) or a 400 (which would break that client's save).
      const resultingRow = await (async () => {
        if (Object.keys(changes).length === 0) {
          return existing;
        }
        const updated = await tx
          .update(receipts)
          .set(changes)
          .where(and(eq(receipts.id, id), visibleTo(userId)))
          .returning();
        const row = updated[0];
        if (row === undefined) {
          // The row was selected FOR UPDATE moments ago in this
          // transaction; its absence means something is genuinely broken.
          throw new Error("Receipt update returned no row");
        }
        return row;
      })();

      // Every save touches the vocabulary, including the no-change one
      // above: "used" means "saved on a receipt", not "edited in this
      // request", so a save that leaves the vendor alone still says this
      // person is still using that vendor. The alternative - bumping
      // recency only when a field CHANGED - would push the vendor someone
      // shops at weekly steadily down their own list.
      await rememberFieldOptions(tx, userId, resultingRow);
      return resultingRow;
    });

    // A patch can supply OCR text a create omitted; same fire-and-forget
    // degradation as the create route's kick.
    if (body.ocrRawText !== undefined && updatedReceipt.ocrRawText !== null) {
      deps.llmParseSweep?.kick();
    }

    return c.json(receiptResponse(updatedReceipt));
  });

  /** DELETE /api/receipts/:id - soft delete (spec §10B: retention). */
  router.delete("/:id", async (c) => {
    const id = uuidParamOrNotFound(c.req.param("id"));
    const userId = c.get("userId");
    const deletedAt = new Date();

    const deleted = await deps.db.transaction(async (tx) => {
      const rows = await tx
        .update(receipts)
        .set({ deletedAt })
        .where(and(eq(receipts.id, id), visibleTo(userId)))
        .returning({ id: receipts.id });
      if (rows.length === 0) {
        return rows;
      }
      // Stamp the images too: a deleted receipt's image must stop occupying
      // its (user_id, sha256) uniqueness slot, or re-capturing the same
      // file after a deletion would 409 forever.
      await tx
        .update(receiptImages)
        .set({ deletedAt })
        .where(
          and(
            eq(receiptImages.receiptId, id),
            eq(receiptImages.userId, userId),
            // ⚠ The statement carries its own tombstone guard rather than
            // borrowing the receipts update's. Nothing above stops this from
            // rewriting an ALREADY-tombstoned image forward: the short-circuit
            // at the top of this transaction only proves the RECEIPT is still
            // visible, and an image tombstoned while its receipt is not is a
            // state no route produces but a migration, a dev script or a
            // future admin tool can. `deleted_at` is what a §10B retention
            // sweep would be written against, so the value this moves is the
            // one that decides when an object may be swept.
            isNull(receiptImages.deletedAt),
          ),
        );
      return rows;
    });
    if (deleted.length === 0) {
      throw notFoundError();
    }
    return c.body(null, 204);
  });

  return router;
}

/**
 * The WHERE conditions GET / and GET /summary both filter on
 * (`receiptFilterQuerySchema`, `http/schemas.ts`): scoped to the session
 * user, then every optional filter the two routes accept identically.
 * Defined once so a summary that disagreed with the list sitting next to it
 * - counting a receipt the list's own filter would have excluded, or the
 * reverse - is structurally impossible rather than a thing a future edit to
 * one route quietly stops matching the other.
 *
 * Deliberately returns the cursor-free half only: keyset paging is a
 * GET-/-only concept (an aggregate has no pages), so the cursor condition
 * is pushed onto this array by the list handler itself, after the fact.
 */
function buildReceiptFilterConditions(
  userId: string,
  query: z.infer<typeof receiptFilterQuerySchema>,
): (SQL | undefined)[] {
  const conditions = [visibleTo(userId)];
  if (query.from !== undefined) {
    conditions.push(gte(receipts.purchasedAt, query.from));
  }
  if (query.to !== undefined) {
    conditions.push(lte(receipts.purchasedAt, query.to));
  }
  if (query.status !== undefined) {
    conditions.push(eq(receipts.status, query.status));
  }
  // Exact match, deliberately: these pair with /options, which serves the
  // user's own stored strings verbatim. Normalizing here would refuse to
  // match a value this same server offered.
  if (query.category !== undefined) {
    conditions.push(eq(receipts.category, query.category));
  }
  if (query.paymentMethod !== undefined) {
    conditions.push(eq(receipts.paymentMethod, query.paymentMethod));
  }
  if (query.q !== undefined) {
    const pattern = `%${escapeLikePattern(query.q)}%`;
    conditions.push(
      or(
        ilike(receipts.vendor, pattern),
        ilike(receipts.category, pattern),
        ilike(receipts.notes, pattern),
      ),
    );
  }
  return conditions;
}

/**
 * The API shape of a receipt. A projection rather than the raw row, for the
 * same reason /api/me has one: user_id and deleted_at are internal, and the
 * row's shape should be free to change without changing the API's.
 * ocr_raw_text is added by the detail route only.
 */
function receiptResponse(row: typeof receipts.$inferSelect) {
  const suggestions = mergeSuggestions(
    row.ocrSuggestions,
    row.llmSuggestions?.suggestions ?? null,
    // The row's own state decides what is served, not just what the two
    // parsers said (2026-09-01): a reviewed field on a pending receipt has
    // its suggestion withheld, and a PDF's extracted text layer merges money
    // differently from a photograph's OCR. Both rules live in the domain
    // layer; this passes it what it needs to apply them.
    {
      status: row.status,
      reviewedFields: row.reviewedFields,
      ocrSource: row.ocrSource,
    },
  );
  return {
    id: row.id,
    purchasedAt: row.purchasedAt,
    capturedAt: row.capturedAt,
    vendor: row.vendor,
    subtotalCents: row.subtotalCents,
    hstCents: row.hstCents,
    tipCents: row.tipCents,
    otherFeesCents: row.otherFeesCents,
    totalCents: row.totalCents,
    currency: row.currency,
    category: row.category,
    paymentMethod: row.paymentMethod,
    notes: row.notes,
    status: row.status,
    // Which fields a human has already entered or accepted on this draft,
    // and where its OCR text came from (2026-09-01). Served on every
    // receipt so a client resuming a pending capture on another device
    // knows what it may prefill from a suggestion and what it may not.
    reviewedFields: row.reviewedFields,
    ocrSource: row.ocrSource,
    // The two parse paths merged under §7.3's field-level rule, with
    // per-field provenance and the date-disagreement flag. Computed by the
    // domain layer on every read path: both clients render it, neither
    // decides it (spec §4.1).
    suggestions: suggestions === null ? null : servedSuggestions(suggestions),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * ⚠ TRANSITIONAL (2026-08-26 field reduction). The merge no longer computes
 * a tax-number suggestion - the domain type dropped it with the column - but
 * the shipped iOS build 1.0 (1) decodes `suggestions.vendorTaxNumber` with a
 * NON-optional key, so omitting it from the wire breaks list and detail
 * decoding on the second user's installed build. The key is served as a stated absence,
 * in the same `{value, source}` shape every merge-absent field has.
 *
 * Removal trigger: when no installed build decodes the key. Deleting this
 * function and inlining the merge is the whole removal.
 */
function servedSuggestions(merged: MergedSuggestions) {
  return { ...merged, vendorTaxNumber: { value: null, source: null } };
}

/**
 * 409 for a sha256 that already occupies another live image's uniqueness
 * slot (spec §5's partial index). One message, in one place, for every
 * route that can hit it - the create route, add-a-page, and replace - so
 * the wording that turns a raw constraint violation into a comprehensible
 * answer cannot drift between them.
 */
function duplicateImageError(): ApiError {
  return new ApiError(
    409,
    "duplicate_image",
    "An identical image is already attached to one of your receipts",
  );
}

/**
 * 409 for the trap POST /:id/restore's own doc comment names: restoring
 * would un-tombstone an image whose sha256 (or, defensively, page number -
 * see that route's comment on why both indexes are checked) now collides
 * with a DIFFERENT live image, because the same bytes were re-captured -
 * or the same page re-added on a new receipt - after this receipt was
 * deleted and before it was restored. Named, not raw: the person is told
 * what happened and what they can do about it, the same treatment
 * `duplicateImageError` above gives a live duplicate and the spirit of
 * §8's missing-image export failure.
 */
function restoreConflictError(): ApiError {
  return new ApiError(
    409,
    "restore_conflict",
    "This receipt can't be restored: one of its images was re-captured " +
      "onto a different receipt after this one was deleted, so restoring " +
      "it would collide with that receipt's live image. Delete or replace " +
      "the other receipt's image first, or leave this receipt deleted.",
  );
}

/**
 * The API shape of a receipt image row: what add-a-page and replace both
 * return. Re-checked on the way out for the same reason the detail route's
 * `images` projection is (see that route's comment) - this is a place a
 * stored key becomes a URL, so it is asked again here rather than trusted
 * from the insert that just happened in this same request.
 */
async function imageResponse(
  storage: ObjectStorage,
  userId: string,
  row: typeof receiptImages.$inferSelect,
) {
  assertIssuedObjectKey(row.objectKey, userId);
  return {
    id: row.id,
    page: row.page,
    downloadUrl: await storage.presignDownload(row.objectKey),
    createdAt: row.createdAt,
  };
}

/**
 * A page number is a positive 1-based ordering (spec §5), not an opaque id:
 * unlike a uuid, there is no isolation reason to blur "malformed" into 404,
 * so a page that cannot possibly be valid is a plain 400. Whether THIS
 * page exists on THIS user's receipt is a separate question the route
 * answers afterward, as a 404.
 *
 * Bounded to what the `page` column (smallint) can hold, same reasoning as
 * `centsSchema` bounding to the money columns' range: a boundary that stops
 * short of what the layer behind it accepts is not a boundary, and an
 * unbounded value would reach Postgres as a 500 instead of a 400.
 */
const MAX_SMALLINT = 32767;

function pageParamOrBadRequest(param: string): number {
  if (!/^[1-9]\d*$/.test(param) || Number(param) > MAX_SMALLINT) {
    throw new ApiError(
      400,
      "invalid_request",
      "page must be a positive integer",
    );
  }
  return Number(param);
}

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_SORT: ListSort = "purchasedAt";
const DEFAULT_ORDER: ListOrder = "desc";

/** How many matches GET /possible-duplicates returns - see that route's comment. */
const MAX_POSSIBLE_DUPLICATES = 20;

type ListSort = z.infer<typeof listSortSchema>;
type ListOrder = z.infer<typeof listOrderSchema>;
type ListCursor = z.infer<typeof listCursorSchema>;

/**
 * What one sortable column needs: the column itself (for the null rank and
 * for whether it can be null at all), the EXPRESSION rows are ordered and
 * compared by, how a row's value is written into a cursor, and how that
 * string is turned back into something comparable with the expression.
 *
 * `sortKey` is separate from `column` only because of vendor - see that
 * entry. For the other three it is the bare column, so the SQL those sorts
 * emit, and the index it uses, are byte-for-byte what they were before the
 * expression existed.
 */
interface ListSortSpec {
  column: PgColumn;
  sortKey: SQL;
  encodeKey(row: typeof receipts.$inferSelect): string | null;
  bindKey(value: string): SQL;
}

const LIST_SORTS = {
  purchasedAt: {
    column: receipts.purchasedAt,
    sortKey: sql`${receipts.purchasedAt}`,
    encodeKey: (row) => row.purchasedAt,
    bindKey: (value) => sql`${value}::date`,
  },
  capturedAt: {
    column: receipts.capturedAt,
    sortKey: sql`${receipts.capturedAt}`,
    encodeKey: (row) => row.capturedAt.toISOString(),
    bindKey: (value) => sql`${value}::timestamptz`,
  },
  total: {
    column: receipts.totalCents,
    sortKey: sql`${receipts.totalCents}`,
    encodeKey: (row) =>
      row.totalCents === null ? null : String(row.totalCents),
    bindKey: (value) => sql`${value}::integer`,
  },
  /**
   * Case-insensitive (2026-09-01), stated in the query rather than
   * inherited from the database.
   *
   * ⚠ The reason this is worth writing down: sorted by the RAW column, what
   * a person sees depends on the collation the database happens to have
   * been created with. Under `C` (or `POSIX`) it is byte order, and every
   * capitalised vendor lands ahead of every lowercase one - "Apple",
   * "Dell", "amazon", "costco" - which reads as a broken alphabet, and
   * hand-typed vendors are exactly the ones whose capitalisation is
   * inconsistent. Under `en_US.utf8` the same query already folds case.
   * Both are ordinary Postgres setups; the local docker-compose database
   * and production need not agree, and neither is a thing this list should
   * silently depend on. `lower()` makes the answer the same everywhere.
   *
   * It also makes "Apple" and "apple" genuinely EQUAL rather than merely
   * adjacent, so two spellings of one vendor are separated by the
   * (created_at, id) tiebreak like any other tie, instead of by a
   * collation's tertiary rule.
   *
   * Ordering and the keyset comparison BOTH move to `lower(vendor)`, which
   * is the part that has to be got right: a page boundary compares the same
   * expression the ORDER BY sorted on, or rows either repeat or vanish
   * across it.
   *
   * The cursor still encodes the row's vendor as stored, and `bindKey`
   * lowers it on the way back in. Encoding the lowered key instead would
   * have worked equally well for paging and thrown away the one thing a
   * cursor is otherwise good for - saying which row it stood on. Lowering
   * on bind also keeps every cursor already in flight valid, since a raw
   * vendor and its lowered form are the same string to `lower()`.
   */
  vendor: {
    column: receipts.vendor,
    sortKey: sql`lower(${receipts.vendor})`,
    encodeKey: (row) => row.vendor,
    bindKey: (value) => sql`lower(${value}::text)`,
  },
} as const satisfies Record<ListSort, ListSortSpec>;

/**
 * Whether a sort key can be absent, and so whether the null-rank term and
 * the keyset's null branch are needed at all. Read off the column rather
 * than restated beside it: a restated flag is one schema change away from
 * quietly putting absent values first again.
 */
function sortKeyCanBeNull(spec: ListSortSpec): boolean {
  return !spec.column.notNull;
}

/**
 * A total order for every sort, so a page boundary can never fall inside a
 * group of rows the database is free to shuffle between queries.
 *
 * Rows with no sort key come LAST in both directions: an absent total is not
 * a small one, and Postgres's own default (nulls first under DESC, last
 * under ASC) would move them when the direction flipped. Ties break on
 * (created_at, id) descending, which is the tiebreak keyset paging has
 * always used.
 *
 * A NOT NULL column's null-rank term would be a constant, so it is left out
 * - which is what keeps the default sort's plan, and its index, exactly what
 * it was before sorting became a parameter.
 */
function listOrderBy(spec: ListSortSpec, order: ListOrder): SQL[] {
  const byKey = order === "asc" ? asc(spec.sortKey) : desc(spec.sortKey);
  const tiebreak = [desc(receipts.createdAt), desc(receipts.id)];
  return sortKeyCanBeNull(spec)
    ? [sql`(${spec.column} IS NULL) ASC`, byKey, ...tiebreak]
    : [byKey, ...tiebreak];
}

/**
 * The keyset predicate matching `listOrderBy`: rows strictly after the
 * cursor row in that same order. Written out rather than as a row-wise
 * tuple comparison because the terms do not share a direction - the null
 * rank ascends while the tiebreak descends, whatever the key does.
 */
function afterCursorInSort(
  spec: ListSortSpec,
  order: ListOrder,
  cursor: ListCursor,
): SQL {
  const afterTiebreak = sql`(${receipts.createdAt}, ${receipts.id}) < (${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`;
  if (cursor.sortKey === null) {
    // The cursor row had no key, so it is already in the trailing null
    // group: every keyed row is behind us, and the remaining null-keyed
    // rows are separated by the tiebreak alone.
    //
    // Asked of the COLUMN rather than the sort expression, here and in
    // `listOrderBy`'s null rank: `lower(NULL)` is null too, so the two agree
    // either way, and the bare column is the form an index can answer.
    return sql`(${spec.column} IS NULL AND ${afterTiebreak})`;
  }
  const key = spec.bindKey(cursor.sortKey);
  // Compared as the sort expression, never as the raw column: under
  // `sort=vendor` this is `lower(vendor)` against a lowered cursor key, or
  // the boundary between "amazon" and "Apple" would fall in a different
  // place than the ORDER BY put it - which is how a keyset silently skips
  // or repeats rows.
  const afterKey =
    order === "asc"
      ? sql`${spec.sortKey} > ${key}`
      : sql`${spec.sortKey} < ${key}`;
  // A null-keyed row sorts last in both directions, so it is after every
  // cursor row that had a key.
  const nullRowsFollow = sortKeyCanBeNull(spec)
    ? sql`${spec.column} IS NULL OR `
    : sql``;
  return sql`(${nullRowsFollow}${afterKey} OR (${spec.sortKey} = ${key} AND ${afterTiebreak}))`;
}

function encodeListCursor(
  row: typeof receipts.$inferSelect,
  sort: ListSort,
  order: ListOrder,
): string {
  const sortKey = LIST_SORTS[sort].encodeKey(row);
  const cursor: ListCursor = {
    sort,
    order,
    sortKeyNull: sortKey === null,
    sortKey,
    createdAt: row.createdAt.toISOString(),
    id: row.id,
  };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** A cursor is client input like any other: parsed strictly, 400 on junk. */
function decodeListCursor(encoded: string): ListCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new ApiError(400, "invalid_request", "cursor is not valid");
  }
  const result = listCursorSchema.safeParse(parsed);
  if (!result.success) {
    throw new ApiError(400, "invalid_request", "cursor is not valid");
  }
  return result.data;
}

/** The transaction handle drizzle hands a `db.transaction` callback. */
type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/**
 * The three remembered fields, in one table: how the API spells each one
 * (`vendor | category | paymentMethod`, the `:field` path parameter), how
 * the database spells it (`receipt_field_options.field`, snake_case like the
 * receipt column it mirrors), which receipt column a rename rewrites, and
 * how to write that column.
 *
 * `set` is a function rather than a column name because drizzle's `.set()`
 * needs a statically-known key: a computed one off a union would widen to
 * `Record<string, string>` and typecheck against nothing. Spelling the three
 * out is what keeps the compiler checking that a rename writes the column
 * the same entry says it reads.
 */
const RECEIPT_OPTION_FIELDS = {
  vendor: {
    stored: "vendor",
    column: receipts.vendor,
    set: (value: string) => ({ vendor: value }),
  },
  category: {
    stored: "category",
    column: receipts.category,
    set: (value: string) => ({ category: value }),
  },
  paymentMethod: {
    stored: "payment_method",
    column: receipts.paymentMethod,
    set: (value: string) => ({ paymentMethod: value }),
  },
} as const satisfies Record<
  ReceiptOptionApiField,
  {
    stored: ReceiptOptionField;
    column: PgColumn;
    set: (value: string) => Partial<typeof receipts.$inferInsert>;
  }
>;

/**
 * The `:field` path parameter of the rename and delete routes. A plain 400
 * rather than a 404, on the same reasoning `pageParamOrBadRequest` states:
 * unlike a receipt id, there is no isolation question here - the set of
 * fields is public API, so a field that is not one of the three is
 * malformed input, not a thing that might or might not belong to someone.
 */
function optionFieldParamOrBadRequest(param: string): ReceiptOptionApiField {
  const parsed = receiptOptionFieldSchema.safeParse(param);
  if (!parsed.success) {
    throw new ApiError(
      400,
      "invalid_request",
      `field must be one of ${receiptOptionFieldSchema.options.join(", ")}`,
    );
  }
  return parsed.data;
}

/**
 * Records every non-null vendor, category and payment method of a receipt
 * that was just written, so `GET /api/receipts/options` can offer them back
 * (2026-09-01).
 *
 * Called from INSIDE the create and PATCH transactions, deliberately: a
 * receipt that saved and a vocabulary that did not is a state where the
 * person's own list disagrees with their own receipts, and doing it after
 * the commit is precisely how that state gets reached. It reads the
 * RESULTING row, never the request body, so a PATCH that changed only the
 * total still records the vendor the row actually carries.
 *
 * Upsert, so a value used again moves back to the top of the list rather
 * than colliding: `last_used_at` is the whole ordering, and "used" means
 * "saved on a receipt". Soft-delete and restore call nothing here - see the
 * table's comment in db/schema.ts for why deleting a receipt is not a
 * statement about the vocabulary.
 */
async function rememberFieldOptions(
  tx: DbTransaction,
  userId: string,
  row: typeof receipts.$inferSelect,
): Promise<void> {
  const lastUsedAt = new Date();
  const values = (
    [
      ["vendor", row.vendor],
      ["category", row.category],
      ["payment_method", row.paymentMethod],
    ] as const satisfies readonly (readonly [ReceiptOptionField, string | null])[]
  ).flatMap(([field, value]) =>
    // A null field is not a value the person chose, it is a line the
    // receipt did not have. Nothing to remember.
    value === null ? [] : [{ userId, field, value, lastUsedAt }],
  );
  if (values.length === 0) {
    return;
  }
  await tx
    .insert(receiptFieldOptions)
    .values(values)
    .onConflictDoUpdate({
      target: [
        receiptFieldOptions.userId,
        receiptFieldOptions.field,
        receiptFieldOptions.value,
      ],
      set: { lastUsedAt },
    });
}

interface VendorDefaultCandidate {
  vendor: string | null;
  category: string | null;
  paymentMethod: string | null;
}

/**
 * Proposal #2 (2026-08-28): per vendor, the category and payment method
 * from that vendor's most recent receipt that has them - independently per
 * field, not "the vendor's single most recent receipt's two fields", so a
 * category set three visits ago still offers itself even if last week's
 * visit to the same vendor left the field blank. Same recency philosophy as
 * `recentDistinctValues` just above: what was chosen most recently is what
 * is offered.
 *
 * **Confirmed receipts only - deliberately, and not the same rule
 * `recentDistinctValues` uses.** That function counts a pending receipt's
 * value on the reasoning that "a value typed at capture is still a value
 * the person chose" for the OPTIONS LIST it feeds - a pick-list the person
 * is about to look at and choose from themselves. A default is different in
 * kind: it PREFILLS a field on a different receipt without the person
 * having looked at this one yet, and a pending receipt's category may
 * itself be nothing more than an unreviewed heuristic guess sitting in a
 * text field no human has confirmed. Sourcing a default from a value
 * nobody has confirmed risks compounding one unreviewed guess into a second
 * one. And unlike HST, the stakes of getting this wrong are asymmetric in
 * the other direction too: category is free text with no tax consequence
 * (spec's category rule), so a wrong default costs a mislabelled row an
 * accountant re-reads, never a wrong claim - which is exactly why
 * prefilling it at all is defensible where prefilling an amount is not
 * (deriveMissingAmount's own doc comment, arithmetic.ts). Confirmed-only is
 * the more conservative reading of "chose" for a value about to be reused
 * elsewhere without a second look.
 *
 * One query, not one per vendor: two window functions, each partitioned by
 * vendor and ordered so the first row in the window is the most recent row
 * carrying a non-null value for that one column (`(column IS NULL)`
 * ascending puts every non-null row before every null row within a vendor,
 * then `created_at DESC` picks the most recent of those) - falling through
 * to a null window value only when every one of that vendor's confirmed
 * receipts left the column blank. `DISTINCT ON (vendor)` then collapses the
 * (unchanged, per-partition-constant) window columns to one row per vendor.
 * The route scopes the result to the vendors it is already serving before
 * turning it into a response - see routes/receipts.ts's /options handler.
 */
async function vendorDefaultCandidates(
  db: Db,
  userId: string,
): Promise<VendorDefaultCandidate[]> {
  return db
    .selectDistinctOn([receipts.vendor], {
      vendor: receipts.vendor,
      category: sql<string | null>`first_value(${receipts.category}) over (
        partition by ${receipts.vendor}
        order by (${receipts.category} is null), ${receipts.createdAt} desc
      )`,
      paymentMethod: sql<string | null>`first_value(${receipts.paymentMethod}) over (
        partition by ${receipts.vendor}
        order by (${receipts.paymentMethod} is null), ${receipts.createdAt} desc
      )`,
    })
    .from(receipts)
    .where(
      and(
        visibleTo(userId),
        eq(receipts.status, "confirmed"),
        isNotNull(receipts.vendor),
      ),
    )
    .orderBy(receipts.vendor, desc(receipts.createdAt));
}

/**
 * The stored suggestion record has every field present so a later reader
 * (the accuracy report, a future re-parse comparison) never distinguishes
 * "key absent" from "parser found nothing" - they are the same fact.
 */
function normalizeOcrSuggestions(
  suggestions: z.infer<typeof ocrSuggestionsSchema> | undefined,
): OcrFieldSuggestions | null {
  if (suggestions === undefined) {
    return null;
  }
  return {
    vendor: suggestions.vendor ?? null,
    purchasedAt: suggestions.purchasedAt ?? null,
    totalCents: suggestions.totalCents ?? null,
    hstCents: suggestions.hstCents ?? null,
    subtotalCents: suggestions.subtotalCents ?? null,
    tipCents: suggestions.tipCents ?? null,
    // Prompt v5's two fields (2026-09-01). No shipped client reports either
    // - the on-device heuristic has no rule for a fee line or a payment
    // brand - so null here is the literal truth about what the heuristic
    // found, not a default standing in for an answer.
    otherFeesCents: suggestions.otherFeesCents ?? null,
    paymentMethod: suggestions.paymentMethod ?? null,
    vendorTaxNumber: suggestions.vendorTaxNumber ?? null,
  };
}

/** Treat %, _ and \ in a search term as literals, not LIKE wildcards. */
function escapeLikePattern(term: string): string {
  return term.replaceAll(/[\\%_]/g, (match) => `\\${match}`);
}
