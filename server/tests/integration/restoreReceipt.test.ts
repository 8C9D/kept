import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { listExportableReceipts } from "../../src/db/receiptQueries.js";
import { receiptImages, receipts } from "../../src/db/schema.js";
import {
  createTestHarness,
  imageFor,
  receiptBody,
} from "../helpers/testApp.js";

/**
 * POST /api/receipts/:id/restore - proposal #9's server half (2026-08-28):
 * swipe-to-delete is landing on iOS, and a delete that is "recoverable in
 * principle" but exposes no way back is a one-gesture accident against a tax
 * record. Deletes stay soft (spec §10B retention); this is what makes that
 * actually mean something.
 */

const harness = createTestHarness();
afterAll(() => harness.close());

let token: string;
let userId: string;
let receiptId: string;

beforeEach(async () => {
  await harness.resetDatabase();
  ({ token, userId } = await harness.signIn("restore-user"));
  const created = await harness.request(
    token,
    "POST",
    "/api/receipts",
    receiptBody({
      vendor: "Restorable Co",
      status: "confirmed",
      image: imageFor(userId, "1".repeat(64)),
    }),
  );
  expect(created.status).toBe(201);
  ({ id: receiptId } = (await created.json()) as { id: string });
});

async function restore(sessionToken: string | null, id: string): Promise<Response> {
  return harness.request(sessionToken, "POST", `/api/receipts/${id}/restore`);
}

describe("POST /api/receipts/:id/restore", () => {
  it("restores a deleted receipt: it returns to the list, the detail route, and export eligibility", async () => {
    expect(
      (await harness.request(token, "DELETE", `/api/receipts/${receiptId}`))
        .status,
    ).toBe(204);
    // Predicted before restoring: gone from the list, 404 on detail, absent
    // from the exportable set.
    const listedGone = await harness.request(token, "GET", "/api/receipts");
    expect(
      ((await listedGone.json()) as { receipts: unknown[] }).receipts,
    ).toHaveLength(0);
    expect(
      (await harness.request(token, "GET", `/api/receipts/${receiptId}`))
        .status,
    ).toBe(404);

    const response = await restore(token, receiptId);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { id: string; deletedAt?: unknown };
    expect(body.id).toBe(receiptId);
    expect(body).not.toHaveProperty("deletedAt"); // internal column, projected out

    // Predicted after restoring: back in the list, 200 on detail, present in
    // the exportable set (it was confirmed before deletion).
    const listedBack = await harness.request(token, "GET", "/api/receipts");
    expect(
      ((await listedBack.json()) as { receipts: { id: string }[] }).receipts.map(
        (r) => r.id,
      ),
    ).toEqual([receiptId]);
    expect(
      (await harness.request(token, "GET", `/api/receipts/${receiptId}`))
        .status,
    ).toBe(200);

    const exportable = await listExportableReceipts(harness.db, userId, {
      start: "2020-01-01",
      end: "2030-12-31",
    });
    expect(exportable.map((r) => r.id)).toEqual([receiptId]);

    // And the row itself: deleted_at is actually null, not merely hidden by
    // a query - verify the artifact, not the API's word for it.
    const rows = await harness.db
      .select()
      .from(receipts)
      .where(eq(receipts.id, receiptId));
    expect(rows[0]?.deletedAt).toBeNull();
  });

  it("brings the receipt's image back live too", async () => {
    await harness.request(token, "DELETE", `/api/receipts/${receiptId}`);

    const imagesBeforeRestore = await harness.db
      .select()
      .from(receiptImages)
      .where(eq(receiptImages.receiptId, receiptId));
    expect(imagesBeforeRestore).toHaveLength(1);
    expect(imagesBeforeRestore[0]?.deletedAt).not.toBeNull();

    const response = await restore(token, receiptId);
    expect(response.status).toBe(200);

    const detail = await harness.request(token, "GET", `/api/receipts/${receiptId}`);
    const body = (await detail.json()) as {
      images: { page: number; downloadUrl: string }[];
    };
    expect(body.images).toHaveLength(1);
    expect(body.images[0]?.page).toBe(1);

    const imagesAfterRestore = await harness.db
      .select()
      .from(receiptImages)
      .where(eq(receiptImages.receiptId, receiptId));
    expect(imagesAfterRestore).toHaveLength(1);
    expect(imagesAfterRestore[0]?.deletedAt).toBeNull();
  });

  it("leaves an earlier page-replace's superseded image tombstoned - only the delete's own tombstones come back", async () => {
    // Replace page 1's bytes BEFORE deleting the receipt: the old row is
    // tombstoned at replace time, a new live row takes its place.
    const replaced = await harness.request(
      token,
      "PUT",
      `/api/receipts/${receiptId}/images/1`,
      imageFor(userId, "2".repeat(64)),
    );
    expect(replaced.status).toBe(200);
    const replacedBody = (await replaced.json()) as { id: string };

    // Now delete the receipt: only the CURRENT live image (the replacement)
    // gets tombstoned by this delete.
    expect(
      (await harness.request(token, "DELETE", `/api/receipts/${receiptId}`))
        .status,
    ).toBe(204);

    const response = await restore(token, receiptId);
    expect(response.status).toBe(200);

    const allRows = await harness.db
      .select()
      .from(receiptImages)
      .where(eq(receiptImages.receiptId, receiptId));
    expect(allRows).toHaveLength(2);
    const original = allRows.find((row) => row.sha256 === "1".repeat(64));
    const replacement = allRows.find((row) => row.id === replacedBody.id);
    // The original page-1 image was superseded by the replace, long before
    // the delete - it stays tombstoned, exactly as a replace always leaves it.
    expect(original?.deletedAt).not.toBeNull();
    // The replacement was LIVE at the moment of deletion, so the delete
    // tombstoned it - and the restore brings exactly that one back.
    expect(replacement?.deletedAt).toBeNull();

    const detail = await harness.request(token, "GET", `/api/receipts/${receiptId}`);
    const body = (await detail.json()) as { images: { page: number }[] };
    expect(body.images.map((image) => image.page)).toEqual([1]);
  });

  /**
   * The trap named in the route's own doc comment: the (user_id, sha256)
   * partial unique index frees its slot once a receipt is deleted, so a
   * DIFFERENT receipt can legitimately re-capture the identical file. Then
   * restoring the original collides with that new live row. This must fail
   * cleanly and atomically - the receipt stays deleted, not half-restored.
   */
  it("fails cleanly and atomically when the image's sha256 now collides with a different live receipt", async () => {
    const sameBytes = "3".repeat(64);
    const first = await harness.request(
      token,
      "POST",
      "/api/receipts",
      receiptBody({ vendor: "Original", image: imageFor(userId, sameBytes) }),
    );
    expect(first.status).toBe(201);
    const { id: firstId } = (await first.json()) as { id: string };

    // Delete-first-then-capture (spec §5 / Runbook §6): only possible
    // because the delete freed the (user_id, sha256) slot.
    expect(
      (await harness.request(token, "DELETE", `/api/receipts/${firstId}`))
        .status,
    ).toBe(204);
    const second = await harness.request(
      token,
      "POST",
      "/api/receipts",
      receiptBody({ vendor: "Recaptured", image: imageFor(userId, sameBytes) }),
    );
    expect(second.status).toBe(201);
    const { id: secondId } = (await second.json()) as { id: string };

    // Predicted: 409, naming what happened and what to do, never a raw
    // constraint violation - and the first receipt stays deleted rather
    // than ending up restored without its image.
    const response = await restore(token, firstId);
    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("restore_conflict");
    expect(body.error.message).toMatch(/re-captured/i);
    expect(body.error.message).toMatch(/delete|replace/i);
    expect(body.error.message).not.toMatch(/23505|constraint|duplicate key/i);

    // Atomic: the first receipt is still deleted, not half-restored.
    const rows = await harness.db
      .select()
      .from(receipts)
      .where(eq(receipts.id, firstId));
    expect(rows[0]?.deletedAt).not.toBeNull();
    const firstImages = await harness.db
      .select()
      .from(receiptImages)
      .where(eq(receiptImages.receiptId, firstId));
    expect(firstImages[0]?.deletedAt).not.toBeNull();
    // The second receipt's own live image is completely untouched.
    const secondImages = await harness.db
      .select()
      .from(receiptImages)
      .where(eq(receiptImages.receiptId, secondId));
    expect(secondImages[0]?.deletedAt).toBeNull();
    expect(
      (await harness.request(token, "GET", `/api/receipts/${firstId}`)).status,
    ).toBe(404);
  });

  it("404s a receipt that is not deleted at all", async () => {
    const response = await restore(token, receiptId);
    expect(response.status).toBe(404);
  });

  it("404s a receipt id that does not exist", async () => {
    const response = await restore(token, randomUUID());
    expect(response.status).toBe(404);
  });

  /** §3 constraint 3 - full per-user isolation - tested explicitly. */
  it("404s another user's deleted receipt, indistinguishable from not-found or not-deleted", async () => {
    await harness.request(token, "DELETE", `/api/receipts/${receiptId}`);
    const other = await harness.signIn("restore-outsider");

    const response = await restore(other.token, receiptId);
    expect(response.status).toBe(404);

    // And nothing changed: the owner's receipt is still deleted, not
    // restored by the attacker's attempt.
    const rows = await harness.db
      .select()
      .from(receipts)
      .where(eq(receipts.id, receiptId));
    expect(rows[0]?.deletedAt).not.toBeNull();
  });

  it("does not restore or touch another live receipt's images", async () => {
    const untouched = await harness.request(
      token,
      "POST",
      "/api/receipts",
      receiptBody({ vendor: "Untouched", image: imageFor(userId, "4".repeat(64)) }),
    );
    const { id: untouchedId } = (await untouched.json()) as { id: string };

    await harness.request(token, "DELETE", `/api/receipts/${receiptId}`);
    await restore(token, receiptId);

    const rows = await harness.db
      .select()
      .from(receiptImages)
      .where(
        and(
          eq(receiptImages.receiptId, untouchedId),
          eq(receiptImages.userId, userId),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.deletedAt).toBeNull();
  });

  it("refuses without a session", async () => {
    const response = await restore(null, receiptId);
    expect(response.status).toBe(401);
  });
});
