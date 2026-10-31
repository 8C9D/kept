import { describe, expect, it } from "vitest";
import { displayedTotalCents } from "../src/suggestions.js";
import type { MergedSuggestions } from "../src/types.js";

const withheldTotal = {
  totalCents: { value: null, source: null, withheld: true },
} as unknown as MergedSuggestions;

describe("displayedTotalCents", () => {
  it("shows nothing for a pending row whose total was withheld", () => {
    expect(
      displayedTotalCents({
        status: "pending",
        totalCents: 850,
        suggestions: withheldTotal,
      }),
    ).toBeNull();
  });

  it("shows a confirmed row's total whatever the merge says", () => {
    expect(
      displayedTotalCents({
        status: "confirmed",
        totalCents: 21894,
        suggestions: withheldTotal,
      }),
    ).toBe(21894);
  });

  it("shows an ordinary pending row's total", () => {
    expect(
      displayedTotalCents({
        status: "pending",
        totalCents: 1130,
        suggestions: null,
      }),
    ).toBe(1130);
  });
});
