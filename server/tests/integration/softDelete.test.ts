import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { receipts } from "../../src/db/schema.js";
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
