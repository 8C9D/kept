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

interface SummaryFigures {
  count: number;
  subtotalCents: number;
  hstCents: number;
  tipCents: number;
  otherFeesCents: number;
  totalCents: number;
}

interface SummaryResponse {
  confirmed: SummaryFigures;
  byCurrency: (SummaryFigures & { currency: string })[];
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
      byCurrency: [],
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

describe("GET /api/receipts/summary by currency", () => {
  const confirmedIn = (
    currency: string,
    totalCents: number,
    extra: Record<string, unknown> = {},
  ) =>
    create(token, userId, {
      currency,
      status: "confirmed",
      subtotalCents: null,
      hstCents: null,
      totalCents,
      ...extra,
    });

  const read = async (query = ""): Promise<SummaryResponse> =>
    (await (await summary(token, query)).json()) as SummaryResponse;

  it("reports each currency apart, CAD first and the rest alphabetical", async () => {
    await confirmedIn("USD", 5000, { tipCents: 100 });
    await confirmedIn("EUR", 700);
    await confirmedIn("CAD", 11300, { subtotalCents: 10000, hstCents: 1300 });
    await confirmedIn("USD", 2500);
    await confirmedIn("AUD", 900);

    const body = await read();

    expect(body.byCurrency).toEqual([
      {
        currency: "CAD",
        count: 1,
        subtotalCents: 10000,
        hstCents: 1300,
        tipCents: 0,
        otherFeesCents: 0,
        totalCents: 11300,
      },
      {
        currency: "AUD",
        count: 1,
        subtotalCents: 0,
        hstCents: 0,
        tipCents: 0,
        otherFeesCents: 0,
        totalCents: 900,
      },
      {
        currency: "EUR",
        count: 1,
        subtotalCents: 0,
        hstCents: 0,
        tipCents: 0,
        otherFeesCents: 0,
        totalCents: 700,
      },
      {
        currency: "USD",
        count: 2,
        subtotalCents: 0,
        hstCents: 0,
        tipCents: 100,
        otherFeesCents: 0,
        totalCents: 7500,
      },
    ]);
  });

  it("keeps `confirmed` for shipped clients, narrowed to CAD so its label is true", async () => {
    await confirmedIn("CAD", 11300, { subtotalCents: 10000, hstCents: 1300 });
    await confirmedIn("USD", 5000, { hstCents: 999 });

    const body = await read();

    // Not 16300: shipped iOS prints this figure labelled "CAD".
    expect(body.confirmed).toEqual({
      count: 1,
      subtotalCents: 10000,
      hstCents: 1300,
      tipCents: 0,
      otherFeesCents: 0,
      totalCents: 11300,
    });
  });

  it("answers `confirmed` zeros when only another currency matched, with the money in byCurrency", async () => {
    await confirmedIn("USD", 5000);

    const body = await read();

    expect(body.confirmed).toEqual({
      count: 0,
      subtotalCents: 0,
      hstCents: 0,
      tipCents: 0,
      otherFeesCents: 0,
      totalCents: 0,
    });
    expect(body.byCurrency.map((entry) => entry.currency)).toEqual(["USD"]);
  });

  it("counts pending rows across every currency and sums none of them", async () => {
    await confirmedIn("CAD", 1000);
    await create(token, userId, { currency: "USD", totalCents: 5000 });
    await create(token, userId, { currency: "EUR", totalCents: 6000 });
    await create(token, userId, { currency: "CAD", totalCents: 7000 });

    const body = await read();

    expect(body.pendingCount).toBe(3);
    // A currency seen only on pending rows has nothing confirmed to report.
    expect(body.byCurrency.map((entry) => entry.currency)).toEqual(["CAD"]);
    expect(body.confirmed.totalCents).toBe(1000);
  });

  it("applies the same filter to every currency", async () => {
    await confirmedIn("USD", 5000, { purchasedAt: "2026-01-10" });
    await confirmedIn("USD", 2500, { purchasedAt: "2026-06-10" });
    await confirmedIn("CAD", 1000, { purchasedAt: "2026-06-10" });

    const body = await read("?from=2026-06-01");

    expect(
      body.byCurrency.map(({ currency, totalCents }) => ({
        currency,
        totalCents,
      })),
    ).toEqual([
      { currency: "CAD", totalCents: 1000 },
      { currency: "USD", totalCents: 2500 },
    ]);
  });

  it("sums past 2^31 as a JSON number, where the old ::int cast answered 500", async () => {
    await confirmedIn("CAD", 2_000_000_000, { hstCents: 2_000_000_000 });
    await confirmedIn("CAD", 2_000_000_000, { hstCents: 2_000_000_000 });
    await confirmedIn("USD", 2_100_000_000);
    await confirmedIn("USD", 2_100_000_000);

    const response = await summary(token);
    expect(response.status).toBe(200);
    const raw = await response.text();
    // Numbers on the wire, not the strings the driver hands back for bigint.
    expect(raw).toContain('"totalCents":4000000000');
    expect(raw).toContain('"totalCents":4200000000');

    const body = JSON.parse(raw) as SummaryResponse;
    expect(body.confirmed.totalCents).toBe(4_000_000_000);
    expect(body.confirmed.hstCents).toBe(4_000_000_000);
    expect(body.byCurrency[1]?.totalCents).toBe(4_200_000_000);
  });

  it("sums negative refunds as well", async () => {
    await confirmedIn("CAD", 5000);
    await confirmedIn("CAD", -2000);

    expect((await read()).confirmed.totalCents).toBe(3000);
  });

  it("never reports another user's currency", async () => {
    const other = await harness.signIn("summary-currency-other");
    await create(other.token, other.userId, {
      currency: "JPY",
      status: "confirmed",
      totalCents: 99900,
    });
    await confirmedIn("CAD", 1000);

    expect((await read()).byCurrency.map((entry) => entry.currency)).toEqual([
      "CAD",
    ]);
  });
});
