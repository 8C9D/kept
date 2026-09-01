import { afterEach, describe, expect, it, vi } from "vitest";
import { API_ORIGIN, KeptApi } from "../src/api.js";
import {
  OPTION_LISTS,
  deleteConfirmText,
  deleteResultMessage,
  optionFieldNoun,
  renameResultMessage,
  validateRename,
} from "../src/manageValues.js";

/**
 * Manage values (2026-09-01). Two things are worth pinning without a DOM,
 * the same split every screen in this client follows: the exact requests
 * the two new routes get, and the rules that decide whether a rename is
 * worth sending and what either action tells the person afterwards.
 *
 * The wording is under test on purpose rather than as an afterthought. A
 * delete here removes a SUGGESTION and leaves every receipt's text alone;
 * a confirmation that failed to say so would be read as "erase this from
 * my records", and that misreading costs a person data they cannot get
 * back from this screen.
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

describe("KeptApi.renameReceiptOption", () => {
  it("PATCHes the field's own path with exactly {from, to}", async () => {
    const { calls } = stubFetch(
      new Response(JSON.stringify({ receiptsUpdated: 12 }), { status: 200 }),
    );

    const result = await new KeptApi("session-jwt", vi.fn()).renameReceiptOption(
      "paymentMethod",
      "visa",
      "Visa",
    );

    expect(result).toEqual({ receiptsUpdated: 12 });
    const [url, init] = calls[0] as [string, RequestInit];
    // The singular field name in the path - `paymentMethod`, the receipt's
    // own field, not `paymentMethods` the list.
    expect(url).toBe(`${API_ORIGIN}/api/receipts/options/paymentMethod`);
    expect(init.method).toBe("PATCH");
    expect(init.headers).toMatchObject({ Authorization: "Bearer session-jwt" });
    expect(JSON.parse(String(init.body))).toEqual({ from: "visa", to: "Visa" });
  });

  it("sends the from-value verbatim, spaces and all", async () => {
    // Free text is never normalized on the way out (2026-08-26): a value
    // that only exists because of a stray space is exactly the value
    // someone opens this screen to fix, and trimming it here would send a
    // `from` the server has no record of - a 404 instead of a rename.
    const { calls } = stubFetch(
      new Response(JSON.stringify({ receiptsUpdated: 1 }), { status: 200 }),
    );
    await new KeptApi("t", vi.fn()).renameReceiptOption(
      "category",
      "meals ",
      "meals",
    );
    expect(JSON.parse(String((calls[0] as [string, RequestInit])[1].body))).toEqual({
      from: "meals ",
      to: "meals",
    });
  });
});

describe("KeptApi.deleteReceiptOption", () => {
  it("DELETEs with the value URL-encoded in the query string", async () => {
    const { calls } = stubFetch(new Response(null, { status: 204 }));

    await new KeptApi("session-jwt", vi.fn()).deleteReceiptOption(
      "vendor",
      "Tim Hortons #4021",
    );

    const [url, init] = calls[0] as [string, RequestInit];
    // The `#` is the one that matters: unencoded it would truncate the
    // request path at the fragment and delete nothing.
    expect(url).toBe(
      `${API_ORIGIN}/api/receipts/options/vendor?value=Tim%20Hortons%20%234021`,
    );
    expect(init.method).toBe("DELETE");
    expect(init.body).toBeUndefined();
  });

  it("resolves on the server's 204, which carries no body to read", async () => {
    stubFetch(new Response(null, { status: 204 }));
    await expect(
      new KeptApi("t", vi.fn()).deleteReceiptOption("category", "meals"),
    ).resolves.toBeUndefined();
  });
});

describe("validateRename", () => {
  const existing = ["Food Basics", "Staples"];

  it("accepts a new value and reports that it merges with nothing", () => {
    expect(validateRename("Staples", "Staples Canada", existing)).toEqual({
      state: "ready",
      to: "Staples Canada",
      merges: false,
    });
  });

  it("flags a rename onto a value that already exists as a merge", () => {
    // Allowed - collapsing a near-duplicate is the commonest reason to
    // rename at all - but the screen says so before the button is pressed,
    // because it is the one rename that also removes a list entry.
    expect(validateRename("food basics", "Food Basics", existing)).toEqual({
      state: "ready",
      to: "Food Basics",
      merges: true,
    });
  });

  it("refuses a blank target rather than reading it as a delete", () => {
    expect(validateRename("Staples", "   ", existing)).toEqual({ state: "blank" });
  });

  it("reports an unchanged target as nothing to do", () => {
    expect(validateRename("Staples", "Staples", existing)).toEqual({
      state: "unchanged",
    });
    // Trailing whitespace on the typed replacement is a slip, not a new
    // value - the same trim every other free-text box in this client does
    // on save (`assignText`).
    expect(validateRename("Staples", " Staples ", existing)).toEqual({
      state: "unchanged",
    });
  });
});

describe("the words the screen uses", () => {
  it("counts receipts in a rename's result, singular and plural and none", () => {
    expect(renameResultMessage("visa", "Visa", 12)).toBe(
      "Renamed “visa” to “Visa”. 12 receipts updated.",
    );
    expect(renameResultMessage("visa", "Visa", 1)).toBe(
      "Renamed “visa” to “Visa”. 1 receipt updated.",
    );
    expect(renameResultMessage("visa", "Visa", 0)).toBe(
      "Renamed “visa” to “Visa”. No receipts carried it.",
    );
  });

  it("states in the delete confirmation that receipts keep their text", () => {
    const text = deleteConfirmText("category", "meals");
    expect(text).toContain("category list");
    expect(text).toContain("keep the text");
    // Never a word that could be read as erasing the data.
    expect(text).not.toMatch(/delete|erase/i);
  });

  it("repeats that promise after the delete, not only before it", () => {
    expect(deleteResultMessage("meals")).toBe(
      "Removed “meals” from the list. Receipts that used it still say so.",
    );
  });

  it("names each field the way it reads in a sentence", () => {
    expect(optionFieldNoun("paymentMethod")).toBe("payment method");
    expect(optionFieldNoun("vendor")).toBe("vendor");
    expect(optionFieldNoun("category")).toBe("category");
  });
});

describe("OPTION_LISTS", () => {
  it("names one receipt field and one options list per section", () => {
    // The pairing is the part worth pinning: `vendor` the receipt field
    // (which the route path takes) beside `vendors` the served list.
    expect(OPTION_LISTS.map((list) => [list.field, list.key])).toEqual([
      ["vendor", "vendors"],
      ["category", "categories"],
      ["paymentMethod", "paymentMethods"],
    ]);
  });
});
