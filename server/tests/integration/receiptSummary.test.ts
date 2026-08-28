import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness, imageFor, receiptBody } from "../helpers/testApp.js";

/**
 * GET /api/receipts/summary - proposal #3 (2026-08-28): running totals for
 * whatever filter is currently applied, so the app can answer "how much
 * have I spent" without generating an export.
 *
 * Every test here mirrors a filter test from `receipts.test.ts`'s "GET
 * /api/receipts filters" describe block on purpose (same shape of fixture:
 * Staples/office supplies/visa, Loblaws/groceries/debit, Shell/fuel/visa
 * with a "client trip" note) - the brief for this route is that a filter
 * must behave identically here and in the list, and mirroring the list's
 * own fixtures is what makes a future divergence between the two fail a
 * test instead of only showing up as a support question.
 */

const harness = createTestHarness();
afterAll(() => harness.close());

let token: string;
let userId: string;

beforeEach(async () => {
  await harness.resetDatabase();
  ({ token, userId } = await harness.signIn("summary-user"));
});

let shaCounter = 0;

async function create(
  sessionToken: string,
  owner: string,
  fields: Record<string, unknown>,
): Promise<{ id: string; status: string }> {
  shaCounter += 1;
  const sha = shaCounter.toString(16).padStart(64, "0");
  const response = await harness.request(sessionToken, "POST", "/api/receipts", {
    ...receiptBody(fields),
    image: imageFor(owner, sha),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as { id: string; status: string };
}

interface SummaryResponse {
  confirmed: {
    count: number;
    subtotalCents: number;
    hstCents: number;
    tipCents: number;
    otherFeesCents: number;
    totalCents: number;
  };
  pendingCount: number;
}

async function summary(
  sessionToken: string | null,
  query = "",
): Promise<Response> {
  return harness.request(sessionToken, "GET", `/api/receipts/summary${query}`);
}

describe("GET /api/receipts/summary", () => {
  beforeEach(async () => {
    // Three confirmed receipts, chosen to exercise every filter the same
    // way receipts.test.ts's list-filter fixtures do.
    await create(token, userId, {
      vendor: "Staples",
      purchasedAt: "2026-01-10",
      category: "office supplies",
      paymentMethod: "visa",
      status: "confirmed",
      subtotalCents: 10000,
      hstCents: 1300,
      totalCents: 11300,
    });
    await create(token, userId, {
      vendor: "Loblaws",
      purchasedAt: "2026-02-10",
      category: "groceries",
      paymentMethod: "debit",
      status: "confirmed",
      subtotalCents: 5000,
      hstCents: 650,
      totalCents: 5650,
    });
    await create(token, userId, {
      vendor: "Shell",
      purchasedAt: "2026-03-10",
      category: "fuel",
      paymentMethod: "visa",
      notes: "client trip",
      status: "confirmed",
      subtotalCents: 8000,
      hstCents: 1040,
      totalCents: 9040,
    });
  });

  it("sums count and every money field over confirmed receipts matching the filter", async () => {
    const body = (await (await summary(token)).json()) as SummaryResponse;
    expect(body.confirmed).toEqual({
      count: 3,
      subtotalCents: 23000, // 10000 + 5000 + 8000
      hstCents: 2990, // 1300 + 650 + 1040
      tipCents: 0,
      otherFeesCents: 0,
      totalCents: 25990, // 11300 + 5650 + 9040
    });
  });

  it("excludes pending receipts from the money totals and counts them separately - matching the export's rule", async () => {
    // Nothing with status = 'pending' may ever reach an export (spec §5.2a,
    // §6). A summary that folded this receipt's total into `confirmed`
    // would disagree with the export sitting next to it.
    const pendingBody = receiptBody({ vendor: "Pending Vendor" });
    delete (pendingBody as Record<string, unknown>).totalCents;
    const pendingResponse = await harness.request(
      token,
      "POST",
      "/api/receipts",
      { ...pendingBody, image: imageFor(userId, "aa".repeat(32)) },
    );
    expect(pendingResponse.status).toBe(201);
    expect(
      ((await pendingResponse.json()) as { status: string }).status,
    ).toBe("pending");

    const body = (await (await summary(token)).json()) as SummaryResponse;
    expect(body.confirmed.count).toBe(3);
    expect(body.confirmed.totalCents).toBe(25990);
    expect(body.pendingCount).toBe(1);
  });

  it("filters by date range, inclusive of its bounds - same as the list", async () => {
    const body = (await (
      await summary(token, "?from=2026-02-10&to=2026-03-10")
    ).json()) as SummaryResponse;
    expect(body.confirmed).toEqual({
      count: 2,
      subtotalCents: 13000,
      hstCents: 1690,
      tipCents: 0,
      otherFeesCents: 0,
      totalCents: 14690,
    });
  });

  it("filters by category, matching the stored free text exactly - same as the list", async () => {
    const body = (await (
      await summary(token, `?category=${encodeURIComponent("office supplies")}`)
    ).json()) as SummaryResponse;
    expect(body.confirmed.count).toBe(1);
    expect(body.confirmed.totalCents).toBe(11300);
  });

  it("filters by payment method - same as the list", async () => {
    const body = (await (
      await summary(token, "?paymentMethod=visa")
    ).json()) as SummaryResponse;
    expect(body.confirmed.count).toBe(2);
    expect(body.confirmed.totalCents).toBe(11300 + 9040);
  });

  it("searches vendor, category and notes together - same as the list", async () => {
    const body = (await (
      await summary(token, "?q=client")
    ).json()) as SummaryResponse;
    expect(body.confirmed.count).toBe(1);
    expect(body.confirmed.totalCents).toBe(9040);
  });

  it("excludes a soft-deleted receipt from the totals", async () => {
    const created = await create(token, userId, {
      vendor: "Deleted Co",
      status: "confirmed",
      subtotalCents: 1000,
      hstCents: 130,
      totalCents: 1130,
    });
    expect(
      (await harness.request(token, "DELETE", `/api/receipts/${created.id}`))
        .status,
    ).toBe(204);

    const body = (await (await summary(token)).json()) as SummaryResponse;
    expect(body.confirmed.count).toBe(3);
    expect(body.confirmed.totalCents).toBe(25990);
  });

  /** §3 constraint 3 - full per-user isolation - tested explicitly. */
  it("never includes another user's receipts in the totals or the pending count", async () => {
    const other = await harness.signIn("summary-other-user");
    await create(other.token, other.userId, {
      vendor: "Their Vendor",
      status: "confirmed",
      subtotalCents: 99900,
      hstCents: 12987,
      totalCents: 112887,
    });
    const theirPending = receiptBody({ vendor: "Their Pending Vendor" });
    delete (theirPending as Record<string, unknown>).totalCents;
    await harness.request(other.token, "POST", "/api/receipts", {
      ...theirPending,
      image: imageFor(other.userId, "cc".repeat(32)),
    });

    const mine = (await (await summary(token)).json()) as SummaryResponse;
    expect(mine.confirmed.count).toBe(3);
    expect(mine.confirmed.totalCents).toBe(25990);
    expect(mine.pendingCount).toBe(0);

    const theirs = (await (
      await summary(other.token)
    ).json()) as SummaryResponse;
    expect(theirs.confirmed).toEqual({
      count: 1,
      subtotalCents: 99900,
      hstCents: 12987,
      tipCents: 0,
      otherFeesCents: 0,
      totalCents: 112887,
    });
    expect(theirs.pendingCount).toBe(1);
  });

  it("answers zeros, not nulls, when the filter matches nothing", async () => {
    const body = (await (
      await summary(token, `?category=${encodeURIComponent("nonexistent")}`)
    ).json()) as SummaryResponse;
    expect(body).toEqual({
      confirmed: {
        count: 0,
        subtotalCents: 0,
        hstCents: 0,
        tipCents: 0,
        otherFeesCents: 0,
        totalCents: 0,
      },
      pendingCount: 0,
    });
  });

  it("is reachable as a literal path, not swallowed by the /:id route", async () => {
    // GET /api/receipts/:id answers 404 to anything that is not a uuid, so
    // a route order that let it match first would turn this endpoint into
    // a permanent 404 with nothing else failing.
    const response = await summary(token);
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty("confirmed");
  });

  it("rejects a paging parameter - summary has no pages to turn", async () => {
    const response = await summary(token, "?limit=10");
    expect(response.status).toBe(400);
  });

  it("rejects a sort parameter - summary has no rows to order", async () => {
    const response = await summary(token, "?sort=total");
    expect(response.status).toBe(400);
  });

  it("rejects an unknown query parameter", async () => {
    const response = await summary(token, "?userId=abc");
    expect(response.status).toBe(400);
  });

  it("refuses without a session", async () => {
    const response = await summary(null);
    expect(response.status).toBe(401);
  });
});
