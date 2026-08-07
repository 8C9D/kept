import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { receiptImages } from "../../src/db/schema.js";
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

  it("refuses an object key that walks out of the session user's prefix", async () => {
    // The key starts with A's prefix, so a prefix test would pass it, but
    // it names B's namespace once path segments resolve. Whether it would
    // actually reach B's object is then the storage layer's normalization
    // to decide - which is not where an isolation question belongs.
    const stolen = imageFor(userIdB, "e".repeat(64));
    const response = await harness.request(tokenA, "POST", "/api/receipts",
      receiptBody({
        image: {
          objectKey: `${userIdA}/../${stolen.objectKey}`,
          sha256: "e".repeat(64),
        },
      }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain("objectKey");
  });

  it("never hands A a download URL for an object B owns", async () => {
    // The whole point of the key rules above: the only presigned download
    // the API issues comes from a receipt row it already scoped to the
    // session user. Prove A cannot reach B's image bytes by any route -
    // by B's receipt id, or by naming B's key on a receipt of A's own.
    const bImage = await harness.db
      .select()
      .from(receiptImages)
      .where(eq(receiptImages.userId, userIdB));
    const bObjectKey = bImage[0]?.objectKey;
    expect(bObjectKey).toBeDefined();

    const byReceiptId = await harness.request(tokenA, "GET",
      `/api/receipts/${receiptOfB}`,
    );
    expect(byReceiptId.status).toBe(404);

    const byKey = await harness.request(tokenA, "POST", "/api/receipts",
      receiptBody({
        image: { objectKey: bObjectKey as string, sha256: "f".repeat(64) },
      }),
    );
    expect(byKey.status).toBe(400);

    // And the one response that DOES carry presigned download URLs - A's own
    // receipt detail - signs only A's key. Asserting this on A's list would
    // pass for two reasons that are not isolation: A owns nothing yet, and
    // the list projection carries no object keys at all. A owns a receipt
    // here, and the assertion is made where a leak could actually appear.
    const ownImage = imageFor(userIdA, "1".repeat(64));
    const ownCreated = await harness.request(tokenA, "POST", "/api/receipts",
      receiptBody({ image: ownImage }),
    );
    expect(ownCreated.status).toBe(201);
    const { id: receiptOfA } = (await ownCreated.json()) as { id: string };

    const ownDetail = await harness.request(tokenA, "GET",
      `/api/receipts/${receiptOfA}`,
    );
    expect(ownDetail.status).toBe(200);
    const detailText = await ownDetail.text();
    expect(detailText).toContain(ownImage.objectKey);
    expect(detailText).not.toContain(bObjectKey as string);
    expect(detailText).not.toContain(userIdB);
  });

  /**
   * Write-time validation cannot answer this, which is the whole point.
   * The August 2026 audit reached this state by hand and got back a 200
   * carrying a presigned URL that named another user's namespace: the
   * create route had validated the key it accepted, and the detail route
   * then presigned whatever the row held *now*.
   *
   * The row is edited directly rather than through the API on purpose - no
   * API route can produce this state, and a check that only defends against
   * reachable states is not defending the invariant, it is restating the
   * create route.
   */
  it("refuses to presign a stored key that no longer matches its owner", async () => {
    const ownImage = imageFor(userIdA, "2".repeat(64));
    const created = await harness.request(tokenA, "POST", "/api/receipts",
      receiptBody({ image: ownImage }),
    );
    expect(created.status).toBe(201);
    const { id: receiptOfA } = (await created.json()) as { id: string };

    const bImage = await harness.db
      .select()
      .from(receiptImages)
      .where(eq(receiptImages.userId, userIdB));
    const bObjectKey = bImage[0]?.objectKey as string;
    expect(bObjectKey).toBeDefined();

    // A's row, A's user_id, B's object key. Exactly the state db:claim used
    // to be able to produce, and the state a migration or an admin tool
    // could produce tomorrow.
    await harness.db
      .update(receiptImages)
      .set({ objectKey: bObjectKey })
      .where(eq(receiptImages.receiptId, receiptOfA));

    const detail = await harness.request(tokenA, "GET",
      `/api/receipts/${receiptOfA}`,
    );
    expect(detail.status).toBe(500);
    const text = await detail.text();
    expect(text).not.toContain(bObjectKey);
    expect(text).not.toContain(userIdB);
  });
});
