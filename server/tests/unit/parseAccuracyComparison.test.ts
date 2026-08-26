import { describe, expect, it } from "vitest";
import {
  compareSuggestionPaths,
  suggestionValuesAgree,
  type TwoPathReceipt,
} from "../../src/domain/parseAccuracy.js";
import type { OcrFieldSuggestions } from "../../src/domain/ocrSuggestions.js";

function suggestions(
  overrides: Partial<OcrFieldSuggestions> = {},
): OcrFieldSuggestions {
  return {
    vendor: "Food Basics",
    purchasedAt: "2026-07-11",
    totalCents: 4554,
    hstCents: 89,
    subtotalCents: 4465,
    vendorTaxNumber: "R105216170",
    ...overrides,
  };
}

function receipt(overrides: Partial<TwoPathReceipt>): TwoPathReceipt {
  return {
    id: "receipt-1",
    heuristic: suggestions(),
    llm: suggestions(),
    confirmed: suggestions(),
    ...overrides,
  };
}

describe("suggestionValuesAgree", () => {
  it("treats both-null as agreement: both paths say 'not printed'", () => {
    expect(suggestionValuesAgree("hstCents", null, null)).toBe(true);
  });

  it("treats null against a value as disagreement", () => {
    expect(suggestionValuesAgree("hstCents", null, 89)).toBe(false);
    expect(suggestionValuesAgree("hstCents", 89, null)).toBe(false);
  });

  it("normalizes text the same way the accuracy tallies do", () => {
    expect(suggestionValuesAgree("vendor", "FOOD  BASICS", "food basics")).toBe(
      true,
    );
  });

  it("compares money exactly", () => {
    expect(suggestionValuesAgree("totalCents", 4554, 4553)).toBe(false);
  });
});

describe("compareSuggestionPaths", () => {
  it("reports nothing when the paths agree everywhere", () => {
    expect(compareSuggestionPaths([receipt({})])).toEqual([]);
  });

  /**
   * `vendorTaxNumber` is still a key of a stored suggestion record - old
   * clients report one and the records are immutable - but it is no longer
   * scored: the 2026-08-26 field reduction took away the confirmed column it
   * was compared against, so a disagreement about it must not appear.
   */
  it("ignores a field with no confirmed counterpart left to score against", () => {
    const r = receipt({
      heuristic: suggestions({ vendorTaxNumber: null }),
      llm: suggestions({ vendorTaxNumber: "R105216170" }),
    });
    expect(compareSuggestionPaths([r])).toEqual([]);
  });

  it("does not report a case-only vendor difference as a disagreement", () => {
    const r = receipt({ llm: suggestions({ vendor: "FOOD BASICS" }) });
    expect(compareSuggestionPaths([r])).toEqual([]);
  });

  it("sides with the LLM when its value is what the human confirmed", () => {
    const r = receipt({
      heuristic: suggestions({ purchasedAt: "2011-07-26" }),
      llm: suggestions({ purchasedAt: "2026-07-11" }),
      confirmed: suggestions({ purchasedAt: "2026-07-11" }),
    });
    const [d] = compareSuggestionPaths([r]);
    expect(d).toMatchObject({
      field: "purchasedAt",
      heuristicSuggested: "2011-07-26",
      llmSuggested: "2026-07-11",
      matchedConfirmed: "llm",
    });
  });

  it("sides with the heuristics when their value is what the human confirmed", () => {
    const r = receipt({
      heuristic: suggestions({ hstCents: 89 }),
      llm: suggestions({ hstCents: 688 }),
      confirmed: suggestions({ hstCents: 89 }),
    });
    const [d] = compareSuggestionPaths([r]);
    expect(d).toMatchObject({ field: "hstCents", matchedConfirmed: "heuristic" });
  });

  it("reports 'neither' when the human corrected both paths", () => {
    const r = receipt({
      heuristic: suggestions({ vendor: "Basics" }),
      llm: suggestions({ vendor: "food" }),
      confirmed: suggestions({ vendor: "Food Basics" }),
    });
    const [d] = compareSuggestionPaths([r]);
    expect(d).toMatchObject({ field: "vendor", matchedConfirmed: "neither" });
  });

  it("treats one path finding a value the other missed as a disagreement", () => {
    const r = receipt({
      heuristic: suggestions({ hstCents: null }),
      llm: suggestions({ hstCents: 89 }),
      confirmed: suggestions({ hstCents: 89 }),
    });
    const [d] = compareSuggestionPaths([r]);
    expect(d).toMatchObject({
      field: "hstCents",
      heuristicSuggested: null,
      matchedConfirmed: "llm",
    });
  });

  it("collects disagreements across fields and receipts", () => {
    const first = receipt({
      id: "receipt-1",
      heuristic: suggestions({ purchasedAt: "2011-07-26", vendor: "Basics" }),
      confirmed: suggestions(),
    });
    const second = receipt({
      id: "receipt-2",
      llm: suggestions({ subtotalCents: null }),
    });
    const disagreements = compareSuggestionPaths([first, second]);
    expect(disagreements.map((d) => [d.receiptId, d.field])).toEqual([
      ["receipt-1", "vendor"],
      ["receipt-1", "purchasedAt"],
      ["receipt-2", "subtotalCents"],
    ]);
  });
});
