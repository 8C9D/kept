import { describe, expect, it } from "vitest";
import { mergeSuggestions } from "../../src/domain/mergedSuggestions.js";
import type { OcrFieldSuggestions } from "../../src/domain/ocrSuggestions.js";

/**
 * The §7.3 field-level merge rule, exercised against every degenerate
 * shape: a whole record missing, either side null per field, both null.
 * These are pure-function tests; the wiring that puts the merge on the API
 * is pinned by tests/integration/llmParse.test.ts.
 */

function ocr(overrides: Partial<OcrFieldSuggestions> = {}): OcrFieldSuggestions {
  return {
    vendor: "HEURISTIC VENDOR",
    purchasedAt: "2026-07-11",
    totalCents: 4554,
    hstCents: 205,
    subtotalCents: 4349,
    vendorTaxNumber: "105216170RT0001",
    ...overrides,
  };
}

function llm(overrides: Partial<OcrFieldSuggestions> = {}): OcrFieldSuggestions {
  return {
    vendor: "Llm Vendor (BCE)",
    purchasedAt: "2026-07-11",
    totalCents: 4553,
    hstCents: 204,
    subtotalCents: 4348,
    vendorTaxNumber: "R105216170",
    ...overrides,
  };
}

describe("mergeSuggestions", () => {
  it("returns null when neither parser produced a record", () => {
    expect(mergeSuggestions(null, null)).toBeNull();
  });

  it("takes amounts from the heuristic and the vendor from the LLM when both are present", () => {
    const merged = mergeSuggestions(ocr(), llm());
    expect(merged).not.toBeNull();
    expect(merged?.totalCents).toEqual({ value: 4554, source: "heuristic" });
    expect(merged?.hstCents).toEqual({ value: 205, source: "heuristic" });
    expect(merged?.subtotalCents).toEqual({ value: 4349, source: "heuristic" });
    expect(merged?.vendor).toEqual({ value: "Llm Vendor (BCE)", source: "llm" });
  });

  it("merges no tax number at all - the field it fed is gone (2026-08-26)", () => {
    // Both records still CARRY one: they are immutable, and the shipped
    // client still extracts it. The merge is what stopped reading it.
    const merged = mergeSuggestions(ocr(), llm());
    expect(merged).not.toHaveProperty("vendorTaxNumber");
  });

  it("serves heuristic-only suggestions when there is no LLM record - the offline degradation", () => {
    const merged = mergeSuggestions(ocr(), null);
    expect(merged?.totalCents).toEqual({ value: 4554, source: "heuristic" });
    expect(merged?.vendor).toEqual({
      value: "HEURISTIC VENDOR",
      source: "heuristic",
    });
    expect(merged?.purchasedAt).toEqual({
      value: "2026-07-11",
      source: "heuristic",
      disagreement: false,
    });
  });

  it("serves LLM-only vendor and date - but no money - when the client sent no heuristic record", () => {
    const merged = mergeSuggestions(null, llm());
    expect(merged?.vendor).toEqual({ value: "Llm Vendor (BCE)", source: "llm" });
    expect(merged?.purchasedAt).toEqual({
      value: "2026-07-11",
      source: "llm",
      disagreement: false,
    });
    // No heuristic record means no money suggestions at all, even though
    // the LLM offered every amount.
    expect(merged?.totalCents).toEqual({ value: null, source: null });
    expect(merged?.hstCents).toEqual({ value: null, source: null });
    expect(merged?.subtotalCents).toEqual({ value: null, source: null });
  });

  it("falls back to the other parser for the vendor when the ruled source found nothing", () => {
    const merged = mergeSuggestions(ocr(), llm({ vendor: null }));
    // Ruled source (LLM) empty, heuristic has a value: the value is served
    // and its provenance says so.
    expect(merged?.vendor).toEqual({
      value: "HEURISTIC VENDOR",
      source: "heuristic",
    });
  });

  it("serves heuristic-absent money fields as absent, never LLM-filled", () => {
    // The 43.49 -> 3449 case: the heuristic missed the subtotal, the LLM
    // offered a transposed one. The merge serves the absence.
    const merged = mergeSuggestions(
      ocr({ totalCents: null, hstCents: null, subtotalCents: null }),
      llm(),
    );
    expect(merged?.totalCents).toEqual({ value: null, source: null });
    expect(merged?.hstCents).toEqual({ value: null, source: null });
    expect(merged?.subtotalCents).toEqual({ value: null, source: null });
  });

  it("never serves llm provenance on a money field, whatever the heuristic produced", () => {
    const shapes = [
      mergeSuggestions(ocr(), llm()),
      mergeSuggestions(ocr({ totalCents: null }), llm()),
      mergeSuggestions(ocr({ hstCents: null, subtotalCents: null }), llm()),
      mergeSuggestions(null, llm()),
    ];
    for (const merged of shapes) {
      for (const field of [
        merged?.totalCents,
        merged?.hstCents,
        merged?.subtotalCents,
      ]) {
        expect(field?.source).not.toBe("llm");
      }
    }
  });

  it("states a both-sides-null field as a null value with null provenance", () => {
    const merged = mergeSuggestions(
      ocr({ hstCents: null }),
      llm({ hstCents: null }),
    );
    expect(merged?.hstCents).toEqual({ value: null, source: null });
  });

  it("returns a full null-valued set when both parsers ran and found nothing", () => {
    const empty: OcrFieldSuggestions = {
      vendor: null,
      purchasedAt: null,
      totalCents: null,
      hstCents: null,
      subtotalCents: null,
      vendorTaxNumber: null,
    };
    const merged = mergeSuggestions(empty, empty);
    expect(merged).toEqual({
      vendor: { value: null, source: null },
      purchasedAt: { value: null, source: null, disagreement: false },
      totalCents: { value: null, source: null },
      hstCents: { value: null, source: null },
      subtotalCents: { value: null, source: null },
    });
  });

  describe("the date, which trusts neither source alone", () => {
    it("marks agreement as source 'both' with no disagreement", () => {
      const merged = mergeSuggestions(
        ocr({ purchasedAt: "2026-07-11" }),
        llm({ purchasedAt: "2026-07-11" }),
      );
      expect(merged?.purchasedAt).toEqual({
        value: "2026-07-11",
        source: "both",
        disagreement: false,
      });
    });

    it("flags disagreement and serves the deterministic side's value", () => {
      const merged = mergeSuggestions(
        ocr({ purchasedAt: "2011-07-26" }),
        llm({ purchasedAt: "2026-07-11" }),
      );
      expect(merged?.purchasedAt).toEqual({
        value: "2011-07-26",
        source: "heuristic",
        disagreement: true,
      });
    });

    it("does not flag a date only one parser found", () => {
      const heuristicOnly = mergeSuggestions(
        ocr({ purchasedAt: "2026-07-11" }),
        llm({ purchasedAt: null }),
      );
      expect(heuristicOnly?.purchasedAt).toEqual({
        value: "2026-07-11",
        source: "heuristic",
        disagreement: false,
      });

      const llmOnly = mergeSuggestions(
        ocr({ purchasedAt: null }),
        llm({ purchasedAt: "2026-07-11" }),
      );
      expect(llmOnly?.purchasedAt).toEqual({
        value: "2026-07-11",
        source: "llm",
        disagreement: false,
      });
    });
  });
});
