import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { SessionTokens } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { isUniqueViolation } from "../db/errors.js";
import { visibleTo } from "../db/receiptQueries.js";
import { receiptImages, receipts } from "../db/schema.js";
import { ApiError, notFoundError } from "../http/errors.js";
import type { z } from "zod";
import type { OcrFieldSuggestions } from "../domain/ocrSuggestions.js";
import {
  createReceiptSchema,
  listCursorSchema,
  listOrderSchema,
  listReceiptsQuerySchema,
  listSortSchema,
  ocrSuggestionsSchema,
  updateReceiptSchema,
  uploadUrlSchema,
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
import {
  assertIssuedObjectKey,
  isIssuedObjectKey,
  receiptImageObjectKey,
} from "../storage/objectKeys.js";
import type { ObjectStorage } from "../storage/objectStorage.js";

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
            ocrSuggestions: normalizeOcrSuggestions(body.ocrSuggestions),
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
        return receipt;
      });
    } catch (error) {
      if (isUniqueViolation(error, "receipt_images_user_id_sha256_uq")) {
        throw new ApiError(
          409,
          "duplicate_image",
          "An identical image is already attached to one of your receipts",
        );
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

    const conditions = [visibleTo(userId)];
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
   */
  router.get("/options", async (c) => {
    const userId = c.get("userId");
    const [categories, paymentMethods, vendors] = await Promise.all([
      recentDistinctValues(deps.db, userId, receipts.category),
      recentDistinctValues(deps.db, userId, receipts.paymentMethod),
      recentDistinctValues(deps.db, userId, receipts.vendor),
    ]);
    return c.json({ categories, paymentMethods, vendors });
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
        // The row was selected FOR UPDATE moments ago in this transaction;
        // its absence means something is genuinely broken.
        throw new Error("Receipt update returned no row");
      }
      return row;
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
 * The API shape of a receipt. A projection rather than the raw row, for the
 * same reason /api/me has one: user_id and deleted_at are internal, and the
 * row's shape should be free to change without changing the API's.
 * ocr_raw_text is added by the detail route only.
 */
function receiptResponse(row: typeof receipts.$inferSelect) {
  const suggestions = mergeSuggestions(
    row.ocrSuggestions,
    row.llmSuggestions?.suggestions ?? null,
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

const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_SORT: ListSort = "purchasedAt";
const DEFAULT_ORDER: ListOrder = "desc";

type ListSort = z.infer<typeof listSortSchema>;
type ListOrder = z.infer<typeof listOrderSchema>;
type ListCursor = z.infer<typeof listCursorSchema>;

/**
 * What one sortable column needs: the column itself, how a row's value is
 * written into a cursor, and how that string is cast back to the column's
 * own type for comparison.
 */
interface ListSortSpec {
  column: PgColumn;
  encodeKey(row: typeof receipts.$inferSelect): string | null;
  bindKey(value: string): SQL;
}

const LIST_SORTS = {
  purchasedAt: {
    column: receipts.purchasedAt,
    encodeKey: (row) => row.purchasedAt,
    bindKey: (value) => sql`${value}::date`,
  },
  capturedAt: {
    column: receipts.capturedAt,
    encodeKey: (row) => row.capturedAt.toISOString(),
    bindKey: (value) => sql`${value}::timestamptz`,
  },
  total: {
    column: receipts.totalCents,
    encodeKey: (row) =>
      row.totalCents === null ? null : String(row.totalCents),
    bindKey: (value) => sql`${value}::integer`,
  },
  vendor: {
    column: receipts.vendor,
    encodeKey: (row) => row.vendor,
    bindKey: (value) => sql`${value}::text`,
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
  const byKey = order === "asc" ? asc(spec.column) : desc(spec.column);
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
    return sql`(${spec.column} IS NULL AND ${afterTiebreak})`;
  }
  const key = spec.bindKey(cursor.sortKey);
  const afterKey =
    order === "asc" ? sql`${spec.column} > ${key}` : sql`${spec.column} < ${key}`;
  // A null-keyed row sorts last in both directions, so it is after every
  // cursor row that had a key.
  const nullRowsFollow = sortKeyCanBeNull(spec)
    ? sql`${spec.column} IS NULL OR `
    : sql``;
  return sql`(${nullRowsFollow}${afterKey} OR (${spec.column} = ${key} AND ${afterTiebreak}))`;
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

/** How many past values /options offers per field. */
const MAX_REUSABLE_OPTIONS = 100;

/**
 * One field's distinct non-null values for one user, most recently used
 * first. Recency is `max(created_at)` over the receipts carrying the value:
 * what someone used yesterday is what they are most likely to use again,
 * and alphabetical order would bury it under a year of one-offs.
 *
 * Pending receipts count - a value typed at capture is still a value the
 * person chose - and soft-deleted ones do not, via `visibleTo`.
 */
async function recentDistinctValues(
  db: Db,
  userId: string,
  column: PgColumn,
): Promise<string[]> {
  const rows = await db
    .select({ value: column })
    .from(receipts)
    .where(and(visibleTo(userId), isNotNull(column)))
    .groupBy(column)
    .orderBy(desc(sql`max(${receipts.createdAt})`))
    .limit(MAX_REUSABLE_OPTIONS);
  return rows.map((row) => {
    if (typeof row.value !== "string") {
      // Filtered to non-null above, and every column this runs over is
      // text; anything else means the query broke.
      throw new Error("Reusable-options query returned a non-string value");
    }
    return row.value;
  });
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
    vendorTaxNumber: suggestions.vendorTaxNumber ?? null,
  };
}

/** Treat %, _ and \ in a search term as literals, not LIKE wildcards. */
function escapeLikePattern(term: string): string {
  return term.replaceAll(/[\\%_]/g, (match) => `\\${match}`);
}
