import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { receiptImages, receipts } from "../../src/db/schema.js";
import {
  createTestHarness,
  imageFor,
  receiptBody,
} from "../helpers/testApp.js";

const harness = createTestHarness();
afterAll(() => harness.close());

describe("DELETE /api/receipts/:id (soft delete)", () => {
  let token: string;
  let userId: string;
  let receiptId: string;

  beforeEach(async () => {
    await harness.resetDatabase();
    ({ token, userId } = await harness.signIn("delete-user"));
    const created = await harness.request(token, "POST", "/api/receipts",
      receiptBody({ image: imageFor(userId, "9".repeat(64)) }),
    );
    ({ id: receiptId } = (await created.json()) as { id: string });
  });

  it("keeps the row but stamps deleted_at - retention demands it", async () => {
    const response = await harness.request(
      token,
      "DELETE",
      `/api/receipts/${receiptId}`,
    );
    expect(response.status).toBe(204);

    // The row survives in the database; only visibility changes.
    const rows = await harness.db
      .select()
      .from(receipts)
      .where(eq(receipts.id, receiptId));
    expect(rows).toHaveLength(1);
    // toBeInstanceOf rather than not-null: with optional chaining an absent
    // row would yield undefined, which "not.toBeNull()" would wave through.
    expect(rows[0]?.deletedAt).toBeInstanceOf(Date);
  });

  it("does not move an image tombstone that is already set", async () => {
    // PR-11. The image update carried no `deleted_at IS NULL` of its own. That
    // it could not overwrite an older tombstone was a property of the CALLER,
    // not of the statement: the receipts update above returns zero rows and
    // short-circuits first, and only because `visibleTo` carries
    // `isNull(receipts.deletedAt)`.
    //
    // The state below - image tombstoned, receipt still visible - is reachable
    // by no route in this codebase (there is no image-delete endpoint), so it
    // is set by hand, exactly as the August 2026 audit reached PR-4's state.
    // A migration, a dev script or a future admin tool reaches it the same way.
    //
    // Falsification, predicted then run:
    //   Predicted: with `isNull(receiptImages.deletedAt)` removed, this fails
    //   on the final assertion, with the tombstone moved forward to the
    //   delete's own timestamp.
    //   Actual: exactly that, at :85 - expected '2026-01-15T10:00:00.000Z',
    //   received '2026-08-11T14:13:35.176Z', which is the moment the delete
    //   ran. No gap. The seven-month jump is the finding, rendered.
    const ORIGINAL_TOMBSTONE = new Date("2026-01-15T10:00:00.000Z");
    await harness.db
      .update(receiptImages)
      .set({ deletedAt: ORIGINAL_TOMBSTONE })
      .where(eq(receiptImages.receiptId, receiptId));

    // The receipt itself is untouched and still visible, which is what makes
    // the receipts update return a row and stop guarding the images update.
    const response = await harness.request(
      token,
      "DELETE",
      `/api/receipts/${receiptId}`,
    );
    expect(response.status).toBe(204);

    const images = await harness.db
      .select()
      .from(receiptImages)
      .where(eq(receiptImages.receiptId, receiptId));
    expect(images).toHaveLength(1);
    // The original tombstone survives. Without the guard this reads as the
    // delete's own `new Date()`, seconds ago rather than January.
    expect(images[0]?.deletedAt?.toISOString()).toBe(
      ORIGINAL_TOMBSTONE.toISOString(),
    );
  });

  it("excludes a deleted receipt from the list and its count", async () => {
    await harness.request(token, "DELETE", `/api/receipts/${receiptId}`);
    const response = await harness.request(token, "GET", "/api/receipts");
    const body = (await response.json()) as { receipts: unknown[] };
    expect(body.receipts).toHaveLength(0);
  });

  it("404s a direct fetch of a deleted receipt", async () => {
    await harness.request(token, "DELETE", `/api/receipts/${receiptId}`);
    const response = await harness.request(
      token,
      "GET",
      `/api/receipts/${receiptId}`,
    );
    expect(response.status).toBe(404);
  });

  it("404s a second delete instead of quietly re-deleting", async () => {
    await harness.request(token, "DELETE", `/api/receipts/${receiptId}`);
    const response = await harness.request(
      token,
      "DELETE",
      `/api/receipts/${receiptId}`,
    );
    expect(response.status).toBe(404);
  });

  it("frees the image's duplicate slot: re-capturing after a delete works", async () => {
    // The receipt was created with sha 999...; deleting it must release the
    // (user_id, sha256) uniqueness slot, or the same paper receipt could
    // never be re-captured after a fat-fingered delete.
    await harness.request(token, "DELETE", `/api/receipts/${receiptId}`);
    const recaptured = await harness.request(token, "POST", "/api/receipts",
      receiptBody({ image: imageFor(userId, "9".repeat(64)) }),
    );
    expect(recaptured.status).toBe(201);
  });

  it("404s an update to a deleted receipt", async () => {
    await harness.request(token, "DELETE", `/api/receipts/${receiptId}`);
    const response = await harness.request(token, "PATCH",
      `/api/receipts/${receiptId}`,
      { vendor: "Ghost" },
    );
    expect(response.status).toBe(404);
  });
});
