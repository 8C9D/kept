import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness, imageFor, receiptBody } from "../helpers/testApp.js";

/**
 * GET /api/receipts/possible-duplicates - proposal #8 (2026-08-28), the
 * server half of near-duplicate detection deferred to v2 since wave 1 (spec
 * §11, §5): the `(user_id, sha256)` constraint catches a re-uploaded
 * IDENTICAL file and can never catch a re-photographed piece of paper,
 * because two photographs of one receipt share no pixels. This is a QUERY,
 * never a blocker - the client calls it at confirm time and warns; nothing
 * is ever refused on these grounds, and this suite asserts no route change
 * here refuses anything either.
 */

const harness = createTestHarness();
afterAll(() => harness.close());

let token: string;
let userId: string;

beforeEach(async () => {
  await harness.resetDatabase();
  ({ token, userId } = await harness.signIn("dup-user"));
});

let shaCounter = 0;

async function create(
  sessionToken: string,
  owner: string,
  fields: Record<string, unknown>,
): Promise<{ id: string }> {
  shaCounter += 1;
  const sha = shaCounter.toString(16).padStart(64, "0");
  const response = await harness.request(sessionToken, "POST", "/api/receipts", {
    ...receiptBody(fields),
    image: imageFor(owner, sha),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string };
}

interface DuplicatesResponse {
  receipts: { id: string; vendor: string | null }[];
}

async function possibleDuplicates(
  sessionToken: string | null,
  query: string,
): Promise<Response> {
  return harness.request(
    sessionToken,
    "GET",
    `/api/receipts/possible-duplicates${query}`,
  );
}

function q(params: Record<string, string>): string {
  return `?${new URLSearchParams(params).toString()}`;
}

describe("GET /api/receipts/possible-duplicates", () => {
  it("warns when a live receipt matches date, total and vendor exactly", async () => {
    const existing = await create(token, userId, {
      vendor: "Tim Hortons",
      purchasedAt: "2026-04-01",
      totalCents: 550,
    });

    const response = await possibleDuplicates(
      token,
      q({ purchasedAt: "2026-04-01", totalCents: "550", vendor: "Tim Hortons" }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as DuplicatesResponse;
    expect(body.receipts.map((r) => r.id)).toEqual([existing.id]);
  });

  it("matches vendor case-insensitively, and returns the vendor as stored", async () => {
    // Exactly the case named in the proposal: two scans of the same paper
    // land as "Tim Hortons" and "TIM HORTONS".
    const existing = await create(token, userId, {
      vendor: "Tim Hortons",
      purchasedAt: "2026-04-01",
      totalCents: 550,
    });

    const response = await possibleDuplicates(
      token,
      q({ purchasedAt: "2026-04-01", totalCents: "550", vendor: "TIM HORTONS" }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as DuplicatesResponse;
    expect(body.receipts.map((r) => r.id)).toEqual([existing.id]);
    // The comparison is normalized; what comes back is not - the stored
    // string, verbatim, exactly as receiptResponse always renders it.
    expect(body.receipts[0]?.vendor).toBe("Tim Hortons");
  });

  it("matches vendor ignoring only leading/trailing whitespace", async () => {
    const existing = await create(token, userId, {
      vendor: "Tim Hortons",
      purchasedAt: "2026-04-01",
      totalCents: 550,
    });

    const response = await possibleDuplicates(
      token,
      q({
        purchasedAt: "2026-04-01",
        totalCents: "550",
        vendor: "  Tim Hortons  ",
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as DuplicatesResponse;
    expect(body.receipts.map((r) => r.id)).toEqual([existing.id]);
  });

  it("does not match a different vendor on the same date and total", async () => {
    await create(token, userId, {
      vendor: "Tim Hortons",
      purchasedAt: "2026-04-01",
      totalCents: 550,
    });

    const response = await possibleDuplicates(
      token,
      q({ purchasedAt: "2026-04-01", totalCents: "550", vendor: "Starbucks" }),
    );
    const body = (await response.json()) as DuplicatesResponse;
    expect(body.receipts).toHaveLength(0);
  });

  it("does not match a different date", async () => {
    await create(token, userId, {
      vendor: "Tim Hortons",
      purchasedAt: "2026-04-01",
      totalCents: 550,
    });

    const response = await possibleDuplicates(
      token,
      q({ purchasedAt: "2026-04-02", totalCents: "550", vendor: "Tim Hortons" }),
    );
    const body = (await response.json()) as DuplicatesResponse;
    expect(body.receipts).toHaveLength(0);
  });

  it("does not match a different total", async () => {
    await create(token, userId, {
      vendor: "Tim Hortons",
      purchasedAt: "2026-04-01",
      totalCents: 550,
    });

    const response = await possibleDuplicates(
      token,
      q({ purchasedAt: "2026-04-01", totalCents: "551", vendor: "Tim Hortons" }),
    );
    const body = (await response.json()) as DuplicatesResponse;
    expect(body.receipts).toHaveLength(0);
  });

  /**
   * Decision: a null vendor matches a null vendor. Omitting `vendor` reads
   * as "compare against no vendor" - exactly the shape a re-scanned
   * illegible receipt takes twice - not as "ignore vendor entirely".
   */
  it("with vendor omitted, matches another of the caller's receipts that also has no vendor", async () => {
    const existing = await create(token, userId, {
      vendor: null,
      purchasedAt: "2026-04-01",
      totalCents: 550,
    });

    const response = await possibleDuplicates(
      token,
      q({ purchasedAt: "2026-04-01", totalCents: "550" }),
    );
    const body = (await response.json()) as DuplicatesResponse;
    expect(body.receipts.map((r) => r.id)).toEqual([existing.id]);
  });

  it("with vendor omitted, does NOT match a receipt that has a vendor - null is not a wildcard", async () => {
    await create(token, userId, {
      vendor: "Tim Hortons",
      purchasedAt: "2026-04-01",
      totalCents: 550,
    });

    const response = await possibleDuplicates(
      token,
      q({ purchasedAt: "2026-04-01", totalCents: "550" }),
    );
    const body = (await response.json()) as DuplicatesResponse;
    expect(body.receipts).toHaveLength(0);
  });

  it("with vendor provided, does NOT match a receipt that has no vendor", async () => {
    await create(token, userId, {
      vendor: null,
      purchasedAt: "2026-04-01",
      totalCents: 550,
    });

    const response = await possibleDuplicates(
      token,
      q({ purchasedAt: "2026-04-01", totalCents: "550", vendor: "Tim Hortons" }),
    );
    const body = (await response.json()) as DuplicatesResponse;
    expect(body.receipts).toHaveLength(0);
  });

  it("excludeId omits the receipt being confirmed from its own duplicate check", async () => {
    const self = await create(token, userId, {
      vendor: "Tim Hortons",
      purchasedAt: "2026-04-01",
      totalCents: 550,
    });

    const withoutExclude = await possibleDuplicates(
      token,
      q({ purchasedAt: "2026-04-01", totalCents: "550", vendor: "Tim Hortons" }),
    );
    expect(
      ((await withoutExclude.json()) as DuplicatesResponse).receipts,
    ).toHaveLength(1);

    const withExclude = await possibleDuplicates(
      token,
      q({
        purchasedAt: "2026-04-01",
        totalCents: "550",
        vendor: "Tim Hortons",
        excludeId: self.id,
      }),
    );
    const body = (await withExclude.json()) as DuplicatesResponse;
    expect(body.receipts).toHaveLength(0);
  });

  it("excludes a soft-deleted receipt", async () => {
    const deleted = await create(token, userId, {
      vendor: "Tim Hortons",
      purchasedAt: "2026-04-01",
      totalCents: 550,
    });
    expect(
      (await harness.request(token, "DELETE", `/api/receipts/${deleted.id}`))
        .status,
    ).toBe(204);

    const response = await possibleDuplicates(
      token,
      q({ purchasedAt: "2026-04-01", totalCents: "550", vendor: "Tim Hortons" }),
    );
    const body = (await response.json()) as DuplicatesResponse;
    expect(body.receipts).toHaveLength(0);
  });

  it("matches a pending receipt too - a duplicate scanned twice is worth flagging before either is confirmed", async () => {
    const pendingBody = receiptBody({
      vendor: "Tim Hortons",
      purchasedAt: "2026-04-01",
      status: "pending",
    });
    const response = await harness.request(token, "POST", "/api/receipts", {
      ...pendingBody,
      totalCents: 550,
      image: imageFor(userId, (++shaCounter).toString(16).padStart(64, "0")),
    });
    expect(response.status).toBe(201);
    const pending = (await response.json()) as { id: string; status: string };
    expect(pending.status).toBe("pending");

    const dupResponse = await possibleDuplicates(
      token,
      q({ purchasedAt: "2026-04-01", totalCents: "550", vendor: "Tim Hortons" }),
    );
    const body = (await dupResponse.json()) as DuplicatesResponse;
    expect(body.receipts.map((r) => r.id)).toEqual([pending.id]);
  });

  /** §3 constraint 3 - full per-user isolation - tested explicitly. */
  it("never matches another user's receipt, even with the same date, total and vendor", async () => {
    const other = await harness.signIn("dup-other-user");
    await create(other.token, other.userId, {
      vendor: "Tim Hortons",
      purchasedAt: "2026-04-01",
      totalCents: 550,
    });

    const response = await possibleDuplicates(
      token,
      q({ purchasedAt: "2026-04-01", totalCents: "550", vendor: "Tim Hortons" }),
    );
    const body = (await response.json()) as DuplicatesResponse;
    expect(body.receipts).toHaveLength(0);
  });

  it("is reachable as a literal path, not swallowed by the /:id route", async () => {
    const response = await possibleDuplicates(
      token,
      q({ purchasedAt: "2026-04-01", totalCents: "550" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("receipts");
  });

  it("rejects a request missing purchasedAt", async () => {
    const response = await possibleDuplicates(token, q({ totalCents: "550" }));
    expect(response.status).toBe(400);
  });

  it("rejects a request missing totalCents", async () => {
    const response = await possibleDuplicates(
      token,
      q({ purchasedAt: "2026-04-01" }),
    );
    expect(response.status).toBe(400);
  });

  it("rejects a non-integer totalCents", async () => {
    const response = await possibleDuplicates(
      token,
      q({ purchasedAt: "2026-04-01", totalCents: "5.50" }),
    );
    expect(response.status).toBe(400);
  });

  it("rejects an unknown query parameter", async () => {
    const response = await possibleDuplicates(
      token,
      q({ purchasedAt: "2026-04-01", totalCents: "550", userId: "abc" }),
    );
    expect(response.status).toBe(400);
  });

  it("refuses without a session", async () => {
    const response = await possibleDuplicates(
      null,
      q({ purchasedAt: "2026-04-01", totalCents: "550" }),
    );
    expect(response.status).toBe(401);
  });
});
