import { afterEach, describe, expect, it, vi } from "vitest";
import { API_ORIGIN, KeptApi, possibleDuplicatesQuery } from "../src/api.js";
import {
  duplicateLookupParams,
  lookupPossibleDuplicates,
} from "../src/duplicates.js";
import type { Receipt } from "../src/types.js";

/**
 * Proposal #8 (docs/proposals/2026-08-28-ux-enhancements.md #8, approved):
 * the near-duplicate warning. Three things worth pinning without a
 * component, matching this suite's own "keep logic testable outside
 * components" style (receiptImages.test.ts, receiptSummary.test.ts): what
 * `duplicateLookupParams` decides is worth sending, that the query string
 * carries exactly what the server's strict schema names, and that a
 * failed lookup never throws.
 */

// Only the `KeptApi.possibleDuplicates` describe block below stubs
// `fetch`; unstubbing after every test is harmless for the others and
// matches receiptSummary.test.ts's own top-level cleanup.
afterEach(() => {
  vi.unstubAllGlobals();
});

const MATCH: Receipt = {
  id: "match-1",
  purchasedAt: "2026-08-21",
  capturedAt: "2026-08-21T12:00:00.000Z",
  vendor: "Food Basics",
  subtotalCents: 10000,
  hstCents: 1300,
  tipCents: null,
  otherFeesCents: null,
  totalCents: 11300,
  currency: "CAD",
  category: null,
  paymentMethod: null,
  notes: null,
  status: "confirmed",
  suggestions: null,
  reviewedFields: [],
  ocrSource: null,
  createdAt: "2026-08-21T12:00:00.000Z",
  updatedAt: "2026-08-21T12:00:00.000Z",
};

describe("duplicateLookupParams - deciding there is enough to look up at all", () => {
  it("builds the params when date and total are both present", () => {
    expect(
      duplicateLookupParams(
        { purchasedAt: "2026-08-21", total: "$113.00", vendor: "Food Basics" },
        "self-1",
      ),
    ).toEqual({
      purchasedAt: "2026-08-21",
      totalCents: 11300,
      vendor: "Food Basics",
      excludeId: "self-1",
    });
  });

  it("returns null with no date typed yet", () => {
    expect(
      duplicateLookupParams(
        { purchasedAt: "", total: "$113.00", vendor: "" },
        "self-1",
      ),
    ).toBeNull();
  });

  it("returns null with no total typed yet", () => {
    expect(
      duplicateLookupParams(
        { purchasedAt: "2026-08-21", total: "", vendor: "" },
        "self-1",
      ),
    ).toBeNull();
  });

  it("stays silent on a mid-keystroke unparseable total rather than guessing", () => {
    expect(
      duplicateLookupParams(
        { purchasedAt: "2026-08-21", total: "113.", vendor: "" },
        "self-1",
      ),
    ).toBeNull();
  });

  it("omits vendor - never sends an empty string - when the field is blank", () => {
    const params = duplicateLookupParams(
      { purchasedAt: "2026-08-21", total: "$113.00", vendor: "   " },
      "self-1",
    );
    expect(params).not.toBeNull();
    expect(params).not.toHaveProperty("vendor");
  });

  it("trims vendor before sending it", () => {
    const params = duplicateLookupParams(
      { purchasedAt: "2026-08-21", total: "$113.00", vendor: "  Food Basics  " },
      "self-1",
    );
    expect(params?.vendor).toBe("Food Basics");
  });

  it("always carries excludeId - the obvious self-match bug this exists to prevent", () => {
    // A receipt whose own date/vendor/total is what a person is currently
    // editing must never match ITSELF - excludeId is what stops that, and
    // it must be present on every non-null result, not just some of them.
    const params = duplicateLookupParams(
      { purchasedAt: "2026-08-21", total: "$113.00", vendor: "Food Basics" },
      "the-receipt-being-edited",
    );
    expect(params?.excludeId).toBe("the-receipt-being-edited");
  });
});

describe("possibleDuplicatesQuery - exactly what the strict server schema names", () => {
  it("sends purchasedAt and totalCents only, when vendor and excludeId are absent", () => {
    const query = possibleDuplicatesQuery({
      purchasedAt: "2026-08-21",
      totalCents: 11300,
    });
    const params = new URLSearchParams(query);
    expect(params.get("purchasedAt")).toBe("2026-08-21");
    expect(params.get("totalCents")).toBe("11300");
    expect([...params.keys()].sort()).toEqual(["purchasedAt", "totalCents"]);
  });

  it("sends vendor and excludeId when both are present", () => {
    const query = possibleDuplicatesQuery({
      purchasedAt: "2026-08-21",
      totalCents: 11300,
      vendor: "Food Basics",
      excludeId: "r-1",
    });
    const params = new URLSearchParams(query);
    expect([...params.keys()].sort()).toEqual([
      "excludeId",
      "purchasedAt",
      "totalCents",
      "vendor",
    ]);
    expect(params.get("vendor")).toBe("Food Basics");
    expect(params.get("excludeId")).toBe("r-1");
  });

  it("sends a negative total as a bare integer string, matching the schema's regex", () => {
    const query = possibleDuplicatesQuery({
      purchasedAt: "2026-08-21",
      totalCents: -500,
    });
    expect(new URLSearchParams(query).get("totalCents")).toBe("-500");
  });
});

describe("KeptApi.possibleDuplicates - the request this client actually sends", () => {
  it("GETs /api/receipts/possible-duplicates with exactly the built query", async () => {
    const body = { receipts: [MATCH] };
    const calls: [string, RequestInit][] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push([url, init]);
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const signOut = vi.fn();

    const result = await new KeptApi("session-jwt", signOut).possibleDuplicates({
      purchasedAt: "2026-08-21",
      totalCents: 11300,
      vendor: "Food Basics",
      excludeId: "r-1",
    });

    expect(result).toEqual(body);
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0] as [string, RequestInit];
    expect(url).toBe(
      `${API_ORIGIN}/api/receipts/possible-duplicates?purchasedAt=2026-08-21&totalCents=11300&vendor=Food+Basics&excludeId=r-1`,
    );
    expect(init.method).toBe("GET");
    expect(init.body).toBeUndefined();
    expect(signOut).not.toHaveBeenCalled();
  });
});

describe("lookupPossibleDuplicates - isolated from React, never throws", () => {
  it("returns the matches the API answers with", async () => {
    const api = {
      possibleDuplicates: async () => ({ receipts: [MATCH] }),
    } as unknown as KeptApi;
    const found = await lookupPossibleDuplicates(api, {
      purchasedAt: "2026-08-21",
      totalCents: 11300,
    });
    expect(found).toEqual([MATCH]);
  });

  it("returns no matches when the server finds none", async () => {
    const api = {
      possibleDuplicates: async () => ({ receipts: [] }),
    } as unknown as KeptApi;
    const found = await lookupPossibleDuplicates(api, {
      purchasedAt: "2026-08-21",
      totalCents: 11300,
    });
    expect(found).toEqual([]);
  });

  it("is silent on a failed lookup - resolves to no matches, never throws", async () => {
    const api = {
      possibleDuplicates: async () => {
        throw new Error("network error");
      },
    } as unknown as KeptApi;
    await expect(
      lookupPossibleDuplicates(api, { purchasedAt: "2026-08-21", totalCents: 11300 }),
    ).resolves.toEqual([]);
  });
});
