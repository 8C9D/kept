import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { and, desc, eq, gte, ilike, isNull, lte, or } from "drizzle-orm";
import type { SessionTokens } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { isUniqueViolation } from "../db/errors.js";
import { visibleTo } from "../db/receiptQueries.js";
import { receiptImages, receipts } from "../db/schema.js";
import { ApiError, notFoundError } from "../http/errors.js";
import {
  createReceiptSchema,
  listReceiptsQuerySchema,
  updateReceiptSchema,
  uploadUrlSchema,
} from "../http/schemas.js";
import { parseOrThrow, readJsonBody } from "../http/validate.js";
import { sessionAuth, type AuthedEnv } from "../http/sessionAuth.js";
import type { ObjectStorage } from "../storage/objectStorage.js";

interface ReceiptRouteDependencies {
  db: Db;
  sessionTokens: SessionTokens;
  storage: ObjectStorage;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A malformed id cannot name any receipt, so it gets the same 404 a
 * missing or foreign receipt gets - one indistinguishable outcome for
 * "not yours to see" (spec §3 constraint 4).
 */
function receiptIdOrNotFound(param: string): string {
  if (!UUID_PATTERN.test(param)) {
    throw notFoundError();
  }
  return param;
}

export function receiptRoutes(deps: ReceiptRouteDependencies): Hono<AuthedEnv> {
  const router = new Hono<AuthedEnv>();
  router.use("*", sessionAuth(deps.sessionTokens));

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

    // The schema is strict, so `fields` holds exactly the receipt columns
    // the client sent: an omitted key stays absent and the column takes its
    // default (null for nullables, CAD, pending). userId comes last and
    // only ever from the session.
    const { image, capturedAt, ...fields } = body;

    let created;
    try {
      created = await deps.db.transaction(async (tx) => {
        const [receipt] = await tx
          .insert(receipts)
          .values({
            ...fields,
            capturedAt: new Date(capturedAt),
            userId,
          })
          .returning();
        await tx.insert(receiptImages).values({
          receiptId: receipt.id,
          userId,
          page: 1, // v1 captures a single page; the column is the multi-page seam (spec §5)
          objectKey: image.objectKey,
          sha256: image.sha256,
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

  /** GET /api/receipts - the user's receipts, newest purchase first. */
  router.get("/", async (c) => {
    const query = parseOrThrow(listReceiptsQuerySchema, c.req.query());
    const userId = c.get("userId");

    const conditions = [visibleTo(userId)];
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

    const rows = await deps.db
      .select()
      .from(receipts)
      .where(and(...conditions))
      .orderBy(desc(receipts.purchasedAt), desc(receipts.createdAt));
    // The list omits ocr_raw_text: it can run to 100 KB per receipt and
    // only the detail view has a use for it.
    return c.json({ receipts: rows.map(receiptResponse) });
  });

  /** GET /api/receipts/:id - one receipt plus presigned image downloads. */
  router.get("/:id", async (c) => {
    const id = receiptIdOrNotFound(c.req.param("id"));
    const userId = c.get("userId");

    const rows = await deps.db
      .select()
      .from(receipts)
      .where(and(eq(receipts.id, id), visibleTo(userId)));
    if (rows.length === 0) {
      throw notFoundError();
    }
    const receipt = rows[0];

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
    const id = receiptIdOrNotFound(c.req.param("id"));
    const body = parseOrThrow(updateReceiptSchema, await readJsonBody(c));
    const userId = c.get("userId");

    // The strict schema leaves only receipt columns the client actually
    // sent (absent keys are absent, not undefined), so the parsed body maps
    // straight onto the update; capturedAt alone needs its type converted.
    const { capturedAt, ...fields } = body;
    const changes: Partial<typeof receipts.$inferInsert> = {
      ...fields,
      ...(capturedAt !== undefined && { capturedAt: new Date(capturedAt) }),
    };

    const updated = await deps.db
      .update(receipts)
      .set(changes)
      .where(and(eq(receipts.id, id), visibleTo(userId)))
      .returning();
    if (updated.length === 0) {
      throw notFoundError();
    }
    return c.json(receiptResponse(updated[0]));
  });

  /** DELETE /api/receipts/:id - soft delete (spec §10B: retention). */
  router.delete("/:id", async (c) => {
    const id = receiptIdOrNotFound(c.req.param("id"));
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

const EXTENSION_BY_CONTENT_TYPE = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "application/pdf": "pdf",
} as const;

/** Treat %, _ and \ in a search term as literals, not LIKE wildcards. */
function escapeLikePattern(term: string): string {
  return term.replaceAll(/[\\%_]/g, (match) => `\\${match}`);
}
