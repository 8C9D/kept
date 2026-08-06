import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { and, desc, eq, gte, ilike, isNull, lte, or, sql } from "drizzle-orm";
import type { SessionTokens } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { isUniqueViolation } from "../db/errors.js";
import { visibleTo } from "../db/receiptQueries.js";
import { receiptImages, receipts } from "../db/schema.js";
import { ApiError, notFoundError } from "../http/errors.js";
import {
  createReceiptSchema,
  listCursorSchema,
  listReceiptsQuerySchema,
  updateReceiptSchema,
  uploadUrlSchema,
} from "../http/schemas.js";
import {
  parseOrThrow,
  readJsonBody,
  uuidParamOrNotFound,
} from "../http/validate.js";
import { sessionAuth, type AuthedEnv } from "../http/sessionAuth.js";
import type { ObjectStorage } from "../storage/objectStorage.js";

interface ReceiptRouteDependencies {
  db: Db;
  sessionTokens: SessionTokens;
  storage: ObjectStorage;
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
    const extension = EXTENSION_BY_CONTENT_TYPE[body.contentType];
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, "0");
    const objectKey = `${c.get("userId")}/${year}/${month}/${randomUUID()}.${extension}`;
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

    // Upload keys are issued under the session user's prefix. Accepting an
    // arbitrary key here would let a receipt point at (and later presign a
    // download for) an object the user does not own.
    if (!body.image.objectKey.startsWith(`${userId}/`)) {
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
            vendorTaxNumber: body.vendorTaxNumber ?? null,
            subtotalCents: body.subtotalCents ?? null,
            hstCents: body.hstCents ?? null,
            otherTaxCents: body.otherTaxCents ?? null,
            totalCents: body.totalCents,
            ...(body.currency !== undefined && { currency: body.currency }),
            ...(body.status !== undefined && { status: body.status }),
            category: body.category ?? null,
            paymentMethod: body.paymentMethod ?? null,
            isBusiness: body.isBusiness,
            notes: body.notes ?? null,
            ocrRawText: body.ocrRawText ?? null,
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

    return c.json(receiptResponse(created), 201);
  });

  /**
   * GET /api/receipts - the user's receipts, newest purchase first, in
   * pages. Keyset pagination on (purchased_at, created_at, id) descending:
   * stable under concurrent inserts, unlike offsets, which matters during a
   * backlog import.
   */
  router.get("/", async (c) => {
    const query = parseOrThrow(listReceiptsQuerySchema, c.req.query());
    const userId = c.get("userId");
    const limit = query.limit ?? DEFAULT_PAGE_SIZE;

    const conditions = [visibleTo(userId)];
    if (query.cursor !== undefined) {
      const cursor = decodeListCursor(query.cursor);
      conditions.push(
        // Row-wise comparison: strictly after the cursor row in the
        // descending sort order below.
        sql`(${receipts.purchasedAt}, ${receipts.createdAt}, ${receipts.id})
            < (${cursor.purchasedAt}::date, ${cursor.createdAt}::timestamptz, ${cursor.id}::uuid)`,
      );
    }
    if (query.from !== undefined) {
      conditions.push(gte(receipts.purchasedAt, query.from));
    }
    if (query.to !== undefined) {
      conditions.push(lte(receipts.purchasedAt, query.to));
    }
    if (query.isBusiness !== undefined) {
      conditions.push(eq(receipts.isBusiness, query.isBusiness));
    }
    if (query.status !== undefined) {
      conditions.push(eq(receipts.status, query.status));
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
      .orderBy(
        desc(receipts.purchasedAt),
        desc(receipts.createdAt),
        desc(receipts.id),
      )
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    const lastRow = page[page.length - 1];
    const nextCursor =
      rows.length > limit && lastRow !== undefined
        ? encodeListCursor(lastRow)
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
    const images = await Promise.all(
      imageRows.map(async (image) => ({
        page: image.page,
        downloadUrl: await deps.storage.presignDownload(image.objectKey),
      })),
    );

    return c.json({
      ...receiptResponse(receipt),
      ocrRawText: receipt.ocrRawText,
      images,
    });
  });

  /** PATCH /api/receipts/:id - edit fields; only provided keys change. */
  router.patch("/:id", async (c) => {
    const id = uuidParamOrNotFound(c.req.param("id"));
    const body = parseOrThrow(updateReceiptSchema, await readJsonBody(c));
    const userId = c.get("userId");

    // Explicit field map, same reasoning as the create handler: only keys
    // the client sent change, and every field named here is one the
    // compiler checks against its column.
    const changes: Partial<typeof receipts.$inferInsert> = {};
    if (body.purchasedAt !== undefined) changes.purchasedAt = body.purchasedAt;
    if (body.capturedAt !== undefined)
      changes.capturedAt = new Date(body.capturedAt);
    if (body.vendor !== undefined) changes.vendor = body.vendor;
    if (body.vendorTaxNumber !== undefined)
      changes.vendorTaxNumber = body.vendorTaxNumber;
    if (body.subtotalCents !== undefined)
      changes.subtotalCents = body.subtotalCents;
    if (body.hstCents !== undefined) changes.hstCents = body.hstCents;
    if (body.otherTaxCents !== undefined)
      changes.otherTaxCents = body.otherTaxCents;
    if (body.totalCents !== undefined) changes.totalCents = body.totalCents;
    if (body.currency !== undefined) changes.currency = body.currency;
    if (body.category !== undefined) changes.category = body.category;
    if (body.paymentMethod !== undefined)
      changes.paymentMethod = body.paymentMethod;
    if (body.isBusiness !== undefined) changes.isBusiness = body.isBusiness;
    if (body.notes !== undefined) changes.notes = body.notes;
    if (body.status !== undefined) changes.status = body.status;
    if (body.ocrRawText !== undefined) changes.ocrRawText = body.ocrRawText;

    const updated = await deps.db
      .update(receipts)
      .set(changes)
      .where(and(eq(receipts.id, id), visibleTo(userId)))
      .returning();
    const updatedReceipt = updated[0];
    if (updatedReceipt === undefined) {
      throw notFoundError();
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
  return {
    id: row.id,
    purchasedAt: row.purchasedAt,
    capturedAt: row.capturedAt,
    vendor: row.vendor,
    vendorTaxNumber: row.vendorTaxNumber,
    subtotalCents: row.subtotalCents,
    hstCents: row.hstCents,
    otherTaxCents: row.otherTaxCents,
    totalCents: row.totalCents,
    currency: row.currency,
    category: row.category,
    paymentMethod: row.paymentMethod,
    isBusiness: row.isBusiness,
    notes: row.notes,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const DEFAULT_PAGE_SIZE = 50;

function encodeListCursor(row: {
  purchasedAt: string;
  createdAt: Date;
  id: string;
}): string {
  const cursor = {
    purchasedAt: row.purchasedAt,
    createdAt: row.createdAt.toISOString(),
    id: row.id,
  };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

/** A cursor is client input like any other: parsed strictly, 400 on junk. */
function decodeListCursor(encoded: string) {
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

const EXTENSION_BY_CONTENT_TYPE = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "application/pdf": "pdf",
} as const;

/** Treat %, _ and \ in a search term as literals, not LIKE wildcards. */
function escapeLikePattern(term: string): string {
  return term.replaceAll(/[\\%_]/g, (match) => `\\${match}`);
}
