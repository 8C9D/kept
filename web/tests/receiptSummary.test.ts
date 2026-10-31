import { afterEach, describe, expect, it, vi } from "vitest";
import { API_ORIGIN, KeptApi, summaryQuery } from "../src/api.js";
import { describeSummary, summaryCurrencies } from "../src/views/ReceiptsTable.js";
import type { ReceiptSummary } from "../src/types.js";

/**
 * Proposal #3, running totals for the current filter
 * (docs/proposals/2026-08-28-ux-enhancements.md #3, approved). Three
 * things are worth pinning without a DOM: the query string this shares
 * with `listQuery` (so a summary can never silently drift from the list's
 * own filter), the request `KeptApi.receiptSummary` makes, and the summary
 * line's own copy - the one place this screen states that the money
 * excludes pending receipts and states the pending count separately, which
 * is the proposal's own named risk mitigation.
 */

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(response: Response): { calls: [string, RequestInit][] } {
  const calls: [string, RequestInit][] = [];
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push([url, init]);
    return response;
  });
  return { calls };
}

function summary(overrides: Partial<ReceiptSummary["confirmed"]> = {}): ReceiptSummary {
  return {
    confirmed: {
      count: 3,
      subtotalCents: 20000,
      hstCents: 2815,
      tipCents: 4000,
      otherFeesCents: 500,
      totalCents: 24500 + 500,
      ...overrides,
    },
    pendingCount: 2,
  };
}

describe("summaryQuery - shares its filter assembly with listQuery, no sort/order/cursor", () => {
  it("sends nothing for no filters", () => {
    expect(summaryQuery({})).toBe("");
  });

  it("sends exactly the shared filter parameters", () => {
    const query = summaryQuery({
      from: "2026-01-01",
      to: "2026-12-31",
      status: "confirmed",
      category: "meals",
      paymentMethod: "visa",
      q: "thai",
    });
    const params = new URLSearchParams(query);
    expect(params.get("from")).toBe("2026-01-01");
    expect(params.get("to")).toBe("2026-12-31");
    expect(params.get("status")).toBe("confirmed");
    expect(params.get("category")).toBe("meals");
    expect(params.get("paymentMethod")).toBe("visa");
    expect(params.get("q")).toBe("thai");
  });

  it("carries no sort, order or cursor - an aggregate has no pages or order", () => {
    // Passing sort/order through ListFilters (as the list route accepts
    // them) must not leak into the summary's query - proposal #3's own
    // scoping: "takes exactly the filter parameters ... and none of its
    // paging ones."
    const query = summaryQuery({ sort: "total", order: "asc", q: "meal" });
    expect(query).not.toContain("sort");
    expect(query).not.toContain("order");
    expect(query).toBe("q=meal");
  });

  it("drops a blank search the same way listQuery does", () => {
    expect(summaryQuery({ q: "   " })).toBe("");
  });
});

describe("KeptApi.receiptSummary", () => {
  it("GETs /api/receipts/summary with the filter query and no body", async () => {
    const body = summary();
    const { calls } = stubFetch(new Response(JSON.stringify(body), { status: 200 }));
    const signOut = vi.fn();

    const result = await new KeptApi("session-jwt", signOut).receiptSummary({
      status: "confirmed",
    });

    expect(result).toEqual(body);
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_ORIGIN}/api/receipts/summary?status=confirmed`);
    expect(init.method).toBe("GET");
    expect(init.headers).toMatchObject({ Authorization: "Bearer session-jwt" });
    expect(init.body).toBeUndefined();
    expect(signOut).not.toHaveBeenCalled();
  });

  it("omits the query string entirely for no filters", async () => {
    const { calls } = stubFetch(
      new Response(JSON.stringify(summary()), { status: 200 }),
    );
    await new KeptApi("session-jwt", vi.fn()).receiptSummary({});
    const [url] = calls[0] as [string, RequestInit];
    expect(url).toBe(`${API_ORIGIN}/api/receipts/summary`);
  });
});

describe("describeSummary - per currency, from byCurrency (2026-10)", () => {
  const totals = {
    subtotalCents: 0,
    tipCents: 0,
    otherFeesCents: 0,
  };
  const cad = {
    ...totals,
    currency: "CAD",
    count: 3,
    totalCents: 24515,
    hstCents: 2815,
  };
  const usd = {
    ...totals,
    currency: "USD",
    count: 2,
    totalCents: 3000,
    hstCents: 120,
  };

  it("states each currency on its own and never sums across them", () => {
    const text = describeSummary({
      ...summary({ count: 3, totalCents: 24515, hstCents: 2815 }),
      byCurrency: [cad, usd],
    });
    expect(text).toBe(
      "5 confirmed receipts · $245.15 spent · $28.15 HST · USD 30.00 spent · USD 1.20 HST - confirmed only, excludes 2 pending",
    );
    // $245.15 + $30.00 would be the bug this exists to prevent.
    expect(text).not.toContain("275.15");
  });

  it("reads exactly as it always has for a CAD-only account", () => {
    const text = describeSummary({
      ...summary({ count: 3, totalCents: 24515, hstCents: 2815 }),
      byCurrency: [cad],
    });
    expect(text).toBe(
      "3 confirmed receipts · $245.15 spent · $28.15 HST - confirmed only, excludes 2 pending",
    );
  });

  it("prefers byCurrency over the CAD-only `confirmed` when a filter holds only USD", () => {
    const text = describeSummary({
      ...summary({ count: 0, totalCents: 0, hstCents: 0 }),
      byCurrency: [{ ...cad, count: 0, totalCents: 0, hstCents: 0 }, usd],
    });
    expect(text).toContain("2 confirmed receipts · USD 30.00 spent");
    expect(text).not.toContain("$");
  });

  it("still states $0.00 when nothing matches", () => {
    const empty = summary({ count: 0, totalCents: 0, hstCents: 0 });
    for (const byCurrency of [[], [{ ...cad, count: 0, totalCents: 0, hstCents: 0 }]]) {
      expect(describeSummary({ ...empty, byCurrency })).toContain(
        "0 confirmed receipts · $0.00 spent · $0.00 HST",
      );
    }
  });

  it("falls back to `confirmed` for a server that does not send byCurrency yet", () => {
    expect(summaryCurrencies(summary())).toEqual([
      expect.objectContaining({ currency: "CAD", count: 3 }),
    ]);
  });
});

describe("describeSummary - the summary line's own copy", () => {
  it("states confirmed count, spent and HST, all confirmed-only money", () => {
    const text = describeSummary(summary({ count: 3, totalCents: 24515, hstCents: 2815 }));
    expect(text).toContain("3 confirmed receipts");
    expect(text).toContain("$245.15 spent");
    expect(text).toContain("$28.15 HST");
  });

  it("states the pending count as its own clause, saying the money excludes it", () => {
    const text = describeSummary(summary());
    expect(text).toContain("confirmed only");
    expect(text).toContain("excludes 2 pending");
  });

  it("still states zero pending explicitly - never silently omitted", () => {
    const text = describeSummary({ ...summary(), pendingCount: 0 });
    expect(text).toContain("excludes 0 pending");
  });

  it("singular for exactly one confirmed receipt", () => {
    const text = describeSummary(summary({ count: 1 }));
    expect(text).toContain("1 confirmed receipt ");
    expect(text).not.toContain("1 confirmed receipts");
  });

  it("never lets a change in pendingCount alone change the confirmed money figures", () => {
    // Predicted before writing (CLAUDE.md: predict before verifying): the
    // two halves are read from separate fields (`confirmed` vs
    // `pendingCount`) and never combined, so varying one must leave the
    // other's rendered text byte-identical.
    const base = summary({ totalCents: 10000, hstCents: 1300 });
    const withMorePending = { ...base, pendingCount: 99 };
    const before = describeSummary(base).split(" - ")[0];
    const after = describeSummary(withMorePending).split(" - ")[0];
    expect(before).toBe(after);
  });
});
