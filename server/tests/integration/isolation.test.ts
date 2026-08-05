import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestHarness,
  imageFor,
  receiptBody,
} from "../helpers/testApp.js";

/**
 * The security property of the entire project (spec §3 constraint 4):
 * user A can never see, change, or learn about user B's receipts.
 * Every denial must be a 404 - a 403 would confirm the resource exists.
 */
const harness = createTestHarness();
afterAll(() => harness.close());

describe("per-user isolation", () => {
  let tokenA: string;
  let userIdA: string;
  let tokenB: string;
  let userIdB: string;
  let receiptOfB: string;

  beforeEach(async () => {
    await harness.resetDatabase();
    ({ token: tokenA, userId: userIdA } = await harness.signIn("user-a"));
    ({ token: tokenB, userId: userIdB } = await harness.signIn("user-b"));
    const created = await harness.request(tokenB, "POST", "/api/receipts",
      receiptBody({ image: imageFor(userIdB, "b".repeat(64)) }),
    );
    expect(created.status).toBe(201);
    ({ id: receiptOfB } = (await created.json()) as { id: string });
  });

  it("returns 404, not 403, when A requests B's receipt by its real id", async () => {
    const response = await harness.request(
      tokenA,
      "GET",
      `/api/receipts/${receiptOfB}`,
    );
    expect(response.status).toBe(404);
  });

  it("returns 404 when A tries to update B's receipt", async () => {
    const response = await harness.request(
      tokenA,
      "PATCH",
      `/api/receipts/${receiptOfB}`,
      { totalCents: 1 },
    );
    expect(response.status).toBe(404);

    // And the attempt changed nothing: B still sees the original total.
    const untouched = await harness.request(
      tokenB,
      "GET",
      `/api/receipts/${receiptOfB}`,
    );
    const body = (await untouched.json()) as { totalCents: number };
    expect(body.totalCents).toBe(11300);
  });

  it("returns 404 when A tries to delete B's receipt", async () => {
    const response = await harness.request(
      tokenA,
      "DELETE",
      `/api/receipts/${receiptOfB}`,
    );
    expect(response.status).toBe(404);

    const stillThere = await harness.request(
      tokenB,
      "GET",
      `/api/receipts/${receiptOfB}`,
    );
    expect(stillThere.status).toBe(200);
  });

  it("never includes B's receipts in A's list", async () => {
    const response = await harness.request(tokenA, "GET", "/api/receipts");
    const body = (await response.json()) as { receipts: unknown[] };
    expect(body.receipts).toHaveLength(0);
  });

  it("rejects a create body that tries to smuggle in a user id", async () => {
    // Everything else about this request is valid for A - including A's own
    // image key - so the 400 can only come from the smuggled userId key.
    const response = await harness.request(tokenA, "POST", "/api/receipts", {
      ...receiptBody({ image: imageFor(userIdA, "c".repeat(64)) }),
      userId: userIdB,
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain("userId");
  });

  it("rejects an update body that tries to smuggle in a user id", async () => {
    // vendor alone would be a legal update, so only the userId key can
    // cause the 400.
    const response = await harness.request(tokenB, "PATCH",
      `/api/receipts/${receiptOfB}`,
      { vendor: "Legit Change", userId: userIdA },
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain("userId");

    // And nothing changed.
    const fetched = await harness.request(tokenB, "GET",
      `/api/receipts/${receiptOfB}`,
    );
    const receipt = (await fetched.json()) as { vendor: string };
    expect(receipt.vendor).toBe("Test Vendor");
  });

  it("refuses to attach an image stored under another user's key prefix", async () => {
    // A signs the create request, but the object key belongs to B's space.
    const response = await harness.request(
      tokenA,
      "POST",
      "/api/receipts",
      receiptBody({ image: imageFor(userIdB, "d".repeat(64)) }),
    );
    expect(response.status).toBe(400);
  });
});
