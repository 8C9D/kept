import { afterEach, describe, expect, it, vi } from "vitest";
import { API_ORIGIN, KeptApi } from "../src/api.js";
import { NO_OPTIONS, introducesNewValue } from "../src/options.js";
import type { ReceiptOptions } from "../src/types.js";

/**
 * Category and payment reuse. Two things are worth pinning without a DOM:
 * the request the client makes for the lists, and the rule that decides
 * when the fetched lists have gone stale - the datalists themselves are
 * markup over whatever those two produce.
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

describe("KeptApi.receiptOptions", () => {
  it("GETs /api/receipts/options with the session token and no body", async () => {
    const body: ReceiptOptions = {
      categories: ["office supplies", "meals"],
      paymentMethods: ["visa"],
      vendors: ["Food Basics", "Staples"],
    };
    const { calls } = stubFetch(
      new Response(JSON.stringify(body), { status: 200 }),
    );
    const signOut = vi.fn();

    const options = await new KeptApi("session-jwt", signOut).receiptOptions();

    expect(options).toEqual(body);
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0] as [string, RequestInit];
    // The literal path, not a receipt id: the server registers this route
    // above /:id so the uuid param cannot shadow it.
    expect(url).toBe(`${API_ORIGIN}/api/receipts/options`);
    expect(init.method).toBe("GET");
    expect(init.headers).toMatchObject({ Authorization: "Bearer session-jwt" });
    expect(init.body).toBeUndefined();
    expect(signOut).not.toHaveBeenCalled();
  });
});

describe("introducesNewValue - when a save makes the lists stale", () => {
  const options: ReceiptOptions = {
    categories: ["meals"],
    paymentMethods: ["visa"],
    vendors: ["Food Basics"],
  };

  it("is false when the saved values are already offered", () => {
    expect(
      introducesNewValue(options, {
        category: "meals",
        paymentMethod: "visa",
        vendor: "Food Basics",
      }),
    ).toBe(false);
  });

  it("is false when the save cleared all three fields", () => {
    expect(
      introducesNewValue(options, {
        category: null,
        paymentMethod: null,
        vendor: null,
      }),
    ).toBe(false);
  });

  it("is true for a value none of the three lists carries", () => {
    expect(
      introducesNewValue(options, {
        category: "parking",
        paymentMethod: "visa",
        vendor: "Food Basics",
      }),
    ).toBe(true);
    expect(
      introducesNewValue(options, {
        category: "meals",
        paymentMethod: "amex",
        vendor: "Food Basics",
      }),
    ).toBe(true);
  });

  it("is true for a vendor the list does not carry", () => {
    expect(
      introducesNewValue(options, {
        category: "meals",
        paymentMethod: "visa",
        vendor: "Staples",
      }),
    ).toBe(true);
  });

  it("compares exactly - free text is the user's own, never normalized", () => {
    // The 2026-08-26 ruling on a doubled-space category: "meals " is a
    // different value from "meals", and the server's filters agree. Vendor
    // is the same free-text rule (2026-08-28: reusable "the way categories
    // already are", not a taxonomy either).
    expect(
      introducesNewValue(options, {
        category: "meals ",
        paymentMethod: null,
        vendor: null,
      }),
    ).toBe(true);
    expect(
      introducesNewValue(options, {
        category: "Meals",
        paymentMethod: null,
        vendor: null,
      }),
    ).toBe(true);
    expect(
      introducesNewValue(options, {
        category: null,
        paymentMethod: null,
        vendor: "Food Basics ",
      }),
    ).toBe(true);
  });

  it("treats any value as new before the first fetch answers", () => {
    expect(
      introducesNewValue(NO_OPTIONS, {
        category: "meals",
        paymentMethod: null,
        vendor: null,
      }),
    ).toBe(true);
    expect(
      introducesNewValue(NO_OPTIONS, {
        category: null,
        paymentMethod: null,
        vendor: "Food Basics",
      }),
    ).toBe(true);
  });
});
