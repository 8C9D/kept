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
    tipCents: 700,
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
    // The LLM path never extracts a tip (Aug 8, 2026 ruling: amounts are
    // heuristic-only, and this request never asks the model for one), so
    // every stored record - real or synthetic - carries null here.
    tipCents: null,
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
    // The fixtures' hstCents happen to differ (205 vs the LLM's 204), so
    // this incidentally exercises the disagreement case too; see "the HST
    // disagreement flag" below for the dedicated, deliberate coverage.
    expect(merged?.hstCents).toEqual({
      value: 205,
      source: "heuristic",
      disagreement: true,
    });
    expect(merged?.subtotalCents).toEqual({ value: 4349, source: "heuristic" });
    expect(merged?.tipCents).toEqual({ value: 700, source: "heuristic" });
    expect(merged?.vendor).toEqual({ value: "Llm Vendor (BCE)", source: "llm" });
  });

  it("merges tip heuristic-only, like every other amount", () => {
    const merged = mergeSuggestions(ocr({ tipCents: 250 }), llm());
    expect(merged?.tipCents).toEqual({ value: 250, source: "heuristic" });
  });

  it("never serves an LLM-only tip - amounts have no fallthrough", () => {
    // The heuristic found no tip, but a synthetic LLM record carries one:
    // the merge must not fill it in from the other path.
    const merged = mergeSuggestions(
      ocr({ tipCents: null }),
      llm({ tipCents: 250 }),
    );
    expect(merged?.tipCents).toEqual({ value: null, source: null });
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
    // LLM-only is not disagreement - there is nothing on the heuristic side
    // to disagree with.
    expect(merged?.hstCents).toEqual({
      value: null,
      source: null,
      disagreement: false,
    });
    expect(merged?.subtotalCents).toEqual({ value: null, source: null });
    expect(merged?.tipCents).toEqual({ value: null, source: null });
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
      ocr({
        totalCents: null,
        hstCents: null,
        subtotalCents: null,
        tipCents: null,
      }),
      llm(),
    );
    expect(merged?.totalCents).toEqual({ value: null, source: null });
    // Heuristic-absent, LLM present (204): still not a disagreement - one
    // side has nothing to disagree with, and the served value is still
    // absent, not the LLM's 204.
    expect(merged?.hstCents).toEqual({
      value: null,
      source: null,
      disagreement: false,
    });
    expect(merged?.subtotalCents).toEqual({ value: null, source: null });
    expect(merged?.tipCents).toEqual({ value: null, source: null });
  });

  it("never serves llm provenance on a money field, whatever the heuristic produced", () => {
    const shapes = [
      mergeSuggestions(ocr(), llm({ tipCents: 250 })),
      mergeSuggestions(ocr({ totalCents: null }), llm({ tipCents: 250 })),
      mergeSuggestions(
        ocr({ hstCents: null, subtotalCents: null, tipCents: null }),
        llm({ tipCents: 250 }),
      ),
      mergeSuggestions(null, llm({ tipCents: 250 })),
    ];
    for (const merged of shapes) {
      for (const field of [
        merged?.totalCents,
        merged?.hstCents,
        merged?.subtotalCents,
        merged?.tipCents,
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
    expect(merged?.hstCents).toEqual({
      value: null,
      source: null,
      disagreement: false,
    });
  });

  it("returns a full null-valued set when both parsers ran and found nothing", () => {
    const empty: OcrFieldSuggestions = {
      vendor: null,
      purchasedAt: null,
      totalCents: null,
      hstCents: null,
      subtotalCents: null,
      tipCents: null,
      vendorTaxNumber: null,
    };
    const merged = mergeSuggestions(empty, empty);
    expect(merged).toEqual({
      vendor: { value: null, source: null },
      purchasedAt: { value: null, source: null, disagreement: false },
      totalCents: { value: null, source: null },
      hstCents: { value: null, source: null, disagreement: false },
      subtotalCents: { value: null, source: null },
      tipCents: { value: null, source: null },
    });
  });

  /**
   * The HST disagreement flag (2026-08-28, spec §7.3): same free-signal
   * reasoning as the date flag, but layered on top of the money merge
   * rather than replacing it - hstCents keeps the plain heuristic-or-absent
   * rule (Aug 8, 2026 ruling) in every case below; only the flag varies.
   * Motivation restated from mergedSuggestions.ts: HST is the input tax
   * credit, and it is exactly the field a split-HST misread corrupts into a
   * wrong-but-plausible single-component number.
   */
  describe("the HST disagreement flag", () => {
    it("is true when both parsers produced different amounts - and still serves the heuristic's value", () => {
      // The classic split-HST failure this flag exists to surface: the
      // heuristic read one 8% component (160), the LLM correctly summed
      // both components to the full 13% (260).
      const merged = mergeSuggestions(
        ocr({ hstCents: 160 }),
        llm({ hstCents: 260 }),
      );
      expect(merged?.hstCents).toEqual({
        value: 160,
        source: "heuristic",
        disagreement: true,
      });
    });

    it("is false when both parsers agree - and still serves the heuristic's value", () => {
      const merged = mergeSuggestions(
        ocr({ hstCents: 260 }),
        llm({ hstCents: 260 }),
      );
      expect(merged?.hstCents).toEqual({
        value: 260,
        source: "heuristic",
        disagreement: false,
      });
    });

    it("is false when only the heuristic produced a value - and serves it", () => {
      const merged = mergeSuggestions(
        ocr({ hstCents: 260 }),
        llm({ hstCents: null }),
      );
      expect(merged?.hstCents).toEqual({
        value: 260,
        source: "heuristic",
        disagreement: false,
      });
    });

    it("is false when only the LLM produced a value - and serves absence, not the LLM's number", () => {
      const merged = mergeSuggestions(
        ocr({ hstCents: null }),
        llm({ hstCents: 260 }),
      );
      // Pins the merge rule against a future accidental fallthrough: a
      // disagreement flag is not a licence to fill the field from the LLM.
      expect(merged?.hstCents).toEqual({
        value: null,
        source: null,
        disagreement: false,
      });
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
