import { describe, expect, it } from "vitest";
import {
  mergeSuggestions,
  type SuggestionContext,
} from "../../src/domain/mergedSuggestions.js";
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
    // 43.49 + 2.05 tax + 7.00 tip = 52.54. The total used to be 4554 here,
    // which was the subtotal plus the tax and ignored the tip - a set the
    // 2026-09-01 arithmetic rule now (correctly) calls impossible and
    // withholds the total from. A fixture that trips a rule on every case
    // tests the rule, not the merge, so the default set balances and the
    // impossible ones are written out explicitly below.
    totalCents: 5254,
    hstCents: 205,
    subtotalCents: 4349,
    tipCents: 700,
    // The on-device heuristic has no rule for either field and never will
    // (ocrSuggestions.ts): null is what a real heuristic record carries.
    otherFeesCents: null,
    paymentMethod: null,
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
    // Prompt v5 asks the model for both (2026-09-01). The fee stays null in
    // the default fixture so it cannot silently unbalance the sums above;
    // the cases that want one say so.
    otherFeesCents: null,
    paymentMethod: "MASTERCARD",
    vendorTaxNumber: "R105216170",
    ...overrides,
  };
}

/**
 * The context every case written before 2026-09-01 ran under, and still
 * runs under: a photographed receipt whose confirm screen nobody has been
 * through yet. Both of that date's additions are no-ops in this shape, which
 * is what makes the block below a regression test for the rules it did not
 * change.
 */
const UNREVIEWED_VISION: SuggestionContext = {
  status: "pending",
  reviewedFields: [],
  ocrSource: "vision",
};

describe("mergeSuggestions", () => {
  it("returns null when neither parser produced a record", () => {
    expect(mergeSuggestions(null, null, UNREVIEWED_VISION)).toBeNull();
  });

  it("takes amounts from the heuristic and the vendor from the LLM when both are present", () => {
    const merged = mergeSuggestions(ocr(), llm(), UNREVIEWED_VISION);
    expect(merged).not.toBeNull();
    expect(merged?.totalCents).toEqual({
      value: 5254,
      source: "heuristic",
      disagreement: false,
      withheld: false,
    });
    // The fixtures' hstCents happen to differ (205 vs the LLM's 204), so
    // this incidentally exercises the disagreement case too; see "the HST
    // disagreement flag" below for the dedicated, deliberate coverage.
    expect(merged?.hstCents).toEqual({
      value: 205,
      source: "heuristic",
      disagreement: true,
      withheld: false,
    });
    expect(merged?.subtotalCents).toEqual({
      value: 4349,
      source: "heuristic",
      disagreement: false,
      withheld: false,
    });
    expect(merged?.tipCents).toEqual({ value: 700, source: "heuristic" });
    expect(merged?.vendor).toEqual({ value: "Llm Vendor (BCE)", source: "llm" });
  });

  it("merges tip heuristic-only, like every other amount", () => {
    const merged = mergeSuggestions(ocr({ tipCents: 250 }), llm(), UNREVIEWED_VISION);
    expect(merged?.tipCents).toEqual({ value: 250, source: "heuristic" });
  });

  it("never serves an LLM-only tip - amounts have no fallthrough", () => {
    // The heuristic found no tip, but a synthetic LLM record carries one:
    // the merge must not fill it in from the other path.
    const merged = mergeSuggestions(
      ocr({ tipCents: null }),
      llm({ tipCents: 250 }),
      UNREVIEWED_VISION,
    );
    expect(merged?.tipCents).toEqual({ value: null, source: null });
  });

  it("merges no tax number at all - the field it fed is gone (2026-08-26)", () => {
    // Both records still CARRY one: they are immutable, and the shipped
    // client still extracts it. The merge is what stopped reading it.
    const merged = mergeSuggestions(ocr(), llm(), UNREVIEWED_VISION);
    expect(merged).not.toHaveProperty("vendorTaxNumber");
  });

  it("serves heuristic-only suggestions when there is no LLM record - the offline degradation", () => {
    const merged = mergeSuggestions(ocr(), null, UNREVIEWED_VISION);
    expect(merged?.totalCents).toEqual({
      value: 5254,
      source: "heuristic",
      disagreement: false,
      withheld: false,
    });
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
    const merged = mergeSuggestions(null, llm(), UNREVIEWED_VISION);
    expect(merged?.vendor).toEqual({ value: "Llm Vendor (BCE)", source: "llm" });
    expect(merged?.purchasedAt).toEqual({
      value: "2026-07-11",
      source: "llm",
      disagreement: false,
    });
    // No heuristic record means no money suggestions at all, even though
    // the LLM offered every amount.
    expect(merged?.totalCents).toEqual({
      value: null,
      source: null,
      disagreement: false,
      withheld: false,
    });
    // LLM-only is not disagreement - there is nothing on the heuristic side
    // to disagree with.
    expect(merged?.hstCents).toEqual({
      value: null,
      source: null,
      disagreement: false,
      withheld: false,
    });
    expect(merged?.subtotalCents).toEqual({
      value: null,
      source: null,
      disagreement: false,
      withheld: false,
    });
    expect(merged?.tipCents).toEqual({ value: null, source: null });
  });

  it("falls back to the other parser for the vendor when the ruled source found nothing", () => {
    const merged = mergeSuggestions(ocr(), llm({ vendor: null }), UNREVIEWED_VISION);
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
      UNREVIEWED_VISION,
    );
    expect(merged?.totalCents).toEqual({
      value: null,
      source: null,
      disagreement: false,
      withheld: false,
    });
    // Heuristic-absent, LLM present (204): still not a disagreement - one
    // side has nothing to disagree with, and the served value is still
    // absent, not the LLM's 204.
    expect(merged?.hstCents).toEqual({
      value: null,
      source: null,
      disagreement: false,
      withheld: false,
    });
    expect(merged?.subtotalCents).toEqual({
      value: null,
      source: null,
      disagreement: false,
      withheld: false,
    });
    expect(merged?.tipCents).toEqual({ value: null, source: null });
  });

  it("never serves llm provenance on a money field, whatever the heuristic produced", () => {
    const shapes = [
      mergeSuggestions(ocr(), llm({ tipCents: 250 }), UNREVIEWED_VISION),
      mergeSuggestions(ocr({ totalCents: null }), llm({ tipCents: 250 }), UNREVIEWED_VISION),
      mergeSuggestions(
        ocr({ hstCents: null, subtotalCents: null, tipCents: null }),
        llm({ tipCents: 250 }),
        UNREVIEWED_VISION,
      ),
      mergeSuggestions(null, llm({ tipCents: 250 }), UNREVIEWED_VISION),
    ];
    for (const merged of shapes) {
      for (const field of [
        merged?.totalCents,
        merged?.hstCents,
        merged?.subtotalCents,
        merged?.tipCents,
        merged?.otherFeesCents,
      ]) {
        expect(field?.source).not.toBe("llm");
      }
    }
  });

  it("states a both-sides-null field as a null value with null provenance", () => {
    const merged = mergeSuggestions(
      ocr({ hstCents: null }),
      llm({ hstCents: null }),
      UNREVIEWED_VISION,
    );
    expect(merged?.hstCents).toEqual({
      value: null,
      source: null,
      disagreement: false,
      withheld: false,
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
      otherFeesCents: null,
      paymentMethod: null,
      vendorTaxNumber: null,
    };
    const merged = mergeSuggestions(empty, empty, UNREVIEWED_VISION);
    expect(merged).toEqual({
      vendor: { value: null, source: null },
      purchasedAt: { value: null, source: null, disagreement: false },
      totalCents: {
        value: null,
        source: null,
        disagreement: false,
        withheld: false,
      },
      hstCents: { value: null, source: null, disagreement: false, withheld: false },
      subtotalCents: {
        value: null,
        source: null,
        disagreement: false,
        withheld: false,
      },
      tipCents: { value: null, source: null },
      otherFeesCents: { value: null, source: null },
      paymentMethod: { value: null, source: null },
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
        UNREVIEWED_VISION,
      );
      expect(merged?.hstCents).toEqual({
        value: 160,
        source: "heuristic",
        disagreement: true,
        withheld: false,
      });
    });

    it("is false when both parsers agree - and still serves the heuristic's value", () => {
      const merged = mergeSuggestions(
        ocr({ hstCents: 260 }),
        llm({ hstCents: 260 }),
        UNREVIEWED_VISION,
      );
      expect(merged?.hstCents).toEqual({
        value: 260,
        source: "heuristic",
        disagreement: false,
        withheld: false,
      });
    });

    it("is false when only the heuristic produced a value - and serves it", () => {
      const merged = mergeSuggestions(
        ocr({ hstCents: 260 }),
        llm({ hstCents: null }),
        UNREVIEWED_VISION,
      );
      expect(merged?.hstCents).toEqual({
        value: 260,
        source: "heuristic",
        disagreement: false,
        withheld: false,
      });
    });

    it("is false when only the LLM produced a value - and serves absence, not the LLM's number", () => {
      const merged = mergeSuggestions(
        ocr({ hstCents: null }),
        llm({ hstCents: 260 }),
        UNREVIEWED_VISION,
      );
      // Pins the merge rule against a future accidental fallthrough: a
      // disagreement flag is not a licence to fill the field from the LLM.
      expect(merged?.hstCents).toEqual({
        value: null,
        source: null,
        disagreement: false,
        withheld: false,
      });
    });
  });

  describe("the date, which trusts neither source alone", () => {
    it("marks agreement as source 'both' with no disagreement", () => {
      const merged = mergeSuggestions(
        ocr({ purchasedAt: "2026-07-11" }),
        llm({ purchasedAt: "2026-07-11" }),
        UNREVIEWED_VISION,
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
        UNREVIEWED_VISION,
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
        UNREVIEWED_VISION,
      );
      expect(heuristicOnly?.purchasedAt).toEqual({
        value: "2026-07-11",
        source: "heuristic",
        disagreement: false,
      });

      const llmOnly = mergeSuggestions(
        ocr({ purchasedAt: null }),
        llm({ purchasedAt: "2026-07-11" }),
        UNREVIEWED_VISION,
      );
      expect(llmOnly?.purchasedAt).toEqual({
        value: "2026-07-11",
        source: "llm",
        disagreement: false,
      });
    });
  });

  /**
   * A reviewed field is served ABSENT on a pending receipt (2026-09-01):
   * once a person has entered or accepted a value, the parser has nothing
   * left to suggest for it, and both clients prefill an empty field from
   * its suggestion - so continuing to serve one would re-offer a guess over
   * the person's own work every time the draft reopens.
   */
  describe("fields a human has already reviewed", () => {
    function reviewed(
      fields: SuggestionContext["reviewedFields"],
      status: SuggestionContext["status"] = "pending",
    ): SuggestionContext {
      return { status, reviewedFields: fields, ocrSource: "vision" };
    }

    it("withholds the suggestion for a reviewed money field, and only that one", () => {
      const merged = mergeSuggestions(ocr(), llm(), reviewed(["totalCents"]));
      expect(merged?.totalCents).toEqual({
        value: null,
        source: null,
        disagreement: false,
        // Absent because a human has been through the field, which is a
        // DIFFERENT fact from the arithmetic rule declining to serve a
        // parser's number - and the flag is what tells them apart. See the
        // arithmetic block below for the other one.
        withheld: false,
      });
      // Its neighbours are untouched: this is a per-field rule.
      expect(merged?.subtotalCents).toEqual({
        value: 4349,
        source: "heuristic",
        disagreement: false,
        withheld: false,
      });
      expect(merged?.tipCents).toEqual({ value: 700, source: "heuristic" });
    });

    it("withholds a reviewed vendor, the field the LLM would otherwise win", () => {
      const merged = mergeSuggestions(ocr(), llm(), reviewed(["vendor"]));
      expect(merged?.vendor).toEqual({ value: null, source: null });
    });

    it("clears the disagreement flag with the value on a reviewed date", () => {
      // The fixtures disagree on nothing by default, so make them disagree:
      // a withheld field must not keep flying an amber flag about a value it
      // is no longer serving.
      const merged = mergeSuggestions(
        ocr({ purchasedAt: "2011-07-26" }),
        llm({ purchasedAt: "2026-07-11" }),
        reviewed(["purchasedAt"]),
      );
      expect(merged?.purchasedAt).toEqual({
        value: null,
        source: null,
        disagreement: false,
      });
    });

    it("clears the disagreement flag with the value on a reviewed HST", () => {
      const merged = mergeSuggestions(
        ocr({ hstCents: 160 }),
        llm({ hstCents: 260 }),
        reviewed(["hstCents"]),
      );
      expect(merged?.hstCents).toEqual({
        value: null,
        source: null,
        disagreement: false,
        withheld: false,
      });
    });

    it("withholds every reviewed field at once", () => {
      const merged = mergeSuggestions(
        ocr(),
        llm(),
        reviewed([
          "purchasedAt",
          "vendor",
          "subtotalCents",
          "hstCents",
          "tipCents",
          "otherFeesCents",
          "paymentMethod",
          "totalCents",
        ]),
      );
      expect(merged).toEqual({
        vendor: { value: null, source: null },
        purchasedAt: { value: null, source: null, disagreement: false },
        totalCents: {
          value: null,
          source: null,
          disagreement: false,
          withheld: false,
        },
        hstCents: {
          value: null,
          source: null,
          disagreement: false,
          withheld: false,
        },
        subtotalCents: {
          value: null,
          source: null,
          disagreement: false,
          withheld: false,
        },
        tipCents: { value: null, source: null },
        otherFeesCents: { value: null, source: null },
        paymentMethod: { value: null, source: null },
      });
    });

    it("ignores the two reviewable names that no parser suggests", () => {
      // `category` and `notes` are real entries in the vocabulary and have
      // nothing to withhold; naming them must change nothing rather than
      // being refused. This list was four names until 2026-09-01, when
      // prompt v5 gave otherFeesCents and paymentMethod suggestions of
      // their own - they are withheld like any other field now, which the
      // whole-set case above covers.
      const merged = mergeSuggestions(
        ocr(),
        llm(),
        reviewed(["category", "notes"]),
      );
      expect(merged).toEqual(mergeSuggestions(ocr(), llm(), UNREVIEWED_VISION));
    });

    it("withholds a reviewed payment method, the other field the LLM wins", () => {
      const merged = mergeSuggestions(ocr(), llm(), reviewed(["paymentMethod"]));
      expect(merged?.paymentMethod).toEqual({ value: null, source: null });
    });

    it("serves a confirmed receipt's suggestions in full, reviewed or not", () => {
      // Nothing prefills from a confirmed receipt, and these records are
      // what the §7.3 accuracy comparison reads - suppressing them would
      // delete the measurement's own input.
      const merged = mergeSuggestions(
        ocr(),
        llm(),
        reviewed(["totalCents", "vendor", "purchasedAt"], "confirmed"),
      );
      expect(merged?.totalCents).toEqual({
        value: 5254,
        source: "heuristic",
        disagreement: false,
        withheld: false,
      });
      expect(merged?.vendor).toEqual({ value: "Llm Vendor (BCE)", source: "llm" });
    });

    it("still returns null when neither parser produced a record", () => {
      expect(mergeSuggestions(null, null, reviewed(["totalCents"]))).toBeNull();
    });
  });

  /**
   * The scoped exception to the no-fallthrough money rule (2026-09-01): a
   * PDF's text layer is extracted, not recognised, so the digit-transposition
   * failure the rule was written for cannot occur - and no on-device
   * heuristic reads PDF text at all, so heuristic-only would mean no amounts,
   * ever, on a PDF receipt.
   */
  describe("money on a PDF's text layer", () => {
    const PDF: SuggestionContext = {
      status: "pending",
      reviewedFields: [],
      ocrSource: "pdf-text",
    };

    it("falls through to the LLM's amounts, with the provenance stated", () => {
      const merged = mergeSuggestions(null, llm(), PDF);
      expect(merged?.totalCents).toEqual({
        value: 4553,
        source: "llm",
        disagreement: false,
        withheld: false,
      });
      expect(merged?.hstCents).toEqual({
        value: 204,
        source: "llm",
        disagreement: false,
        withheld: false,
      });
      expect(merged?.subtotalCents).toEqual({
        value: 4348,
        source: "llm",
        disagreement: false,
        withheld: false,
      });
    });

    it("falls through for other fees too - a new amount gets no exception", () => {
      const merged = mergeSuggestions(null, llm({ otherFeesCents: 199 }), PDF);
      expect(merged?.otherFeesCents).toEqual({ value: 199, source: "llm" });
    });

    it("still prefers a heuristic value when there somehow is one", () => {
      const merged = mergeSuggestions(ocr(), llm(), PDF);
      expect(merged?.totalCents).toEqual({
        value: 5254,
        source: "heuristic",
        disagreement: false,
        withheld: false,
      });
      expect(merged?.subtotalCents).toEqual({
        value: 4349,
        source: "heuristic",
        disagreement: false,
        withheld: false,
      });
    });

    it("keeps the disagreement flag meaning what it means", () => {
      // Both parsers produced an HST and they differ: flagged, and the
      // heuristic's value is the one served, exactly as on a photo.
      const merged = mergeSuggestions(
        ocr({ hstCents: 160 }),
        llm({ hstCents: 260 }),
        PDF,
      );
      expect(merged?.hstCents).toEqual({
        value: 160,
        source: "heuristic",
        disagreement: true,
        withheld: false,
      });
    });

    it("serves absence when neither side has an amount", () => {
      const merged = mergeSuggestions(
        ocr({ totalCents: null }),
        llm({ totalCents: null }),
        PDF,
      );
      expect(merged?.totalCents).toEqual({
        value: null,
        source: null,
        disagreement: false,
        withheld: false,
      });
    });

    it("withholds a reviewed field on a PDF too - the two rules compose", () => {
      const merged = mergeSuggestions(null, llm(), {
        ...PDF,
        reviewedFields: ["totalCents"],
      });
      expect(merged?.totalCents).toEqual({
        value: null,
        source: null,
        disagreement: false,
        withheld: false,
      });
      expect(merged?.subtotalCents).toEqual({
        value: 4348,
        source: "llm",
        disagreement: false,
        withheld: false,
      });
    });

    it("leaves a vision receipt's no-fallthrough rule untouched", () => {
      // The pin: the exception is scoped to pdf-text and to nothing else,
      // including the null ocr_source of every pre-2026-09-01 receipt.
      for (const ocrSource of ["vision", null] as const) {
        const merged = mergeSuggestions(null, llm(), {
          status: "pending",
          reviewedFields: [],
          ocrSource,
        });
        expect(merged?.totalCents).toEqual({
          value: null,
          source: null,
          disagreement: false,
          withheld: false,
        });
        expect(merged?.subtotalCents).toEqual({
          value: null,
          source: null,
          disagreement: false,
          withheld: false,
        });
      }
    });
  });

  /**
   * The two fields prompt v5 added (2026-09-01). Both follow rules that
   * already existed - payment method merges like the vendor, other fees
   * like every other amount - so what these pin is that neither got an
   * exception for arriving late.
   */
  describe("payment method and other fees", () => {
    it("serves the LLM's payment method: the heuristic has no rule for one", () => {
      const merged = mergeSuggestions(ocr(), llm(), UNREVIEWED_VISION);
      expect(merged?.paymentMethod).toEqual({
        value: "MASTERCARD",
        source: "llm",
      });
    });

    it("falls back to a heuristic payment method if one ever exists", () => {
      const merged = mergeSuggestions(
        ocr({ paymentMethod: "VISA" }),
        llm({ paymentMethod: null }),
        UNREVIEWED_VISION,
      );
      expect(merged?.paymentMethod).toEqual({
        value: "VISA",
        source: "heuristic",
      });
    });

    it("serves absence when neither parser read a payment method", () => {
      const merged = mergeSuggestions(
        ocr(),
        llm({ paymentMethod: null }),
        UNREVIEWED_VISION,
      );
      expect(merged?.paymentMethod).toEqual({ value: null, source: null });
    });

    it("never serves an LLM-only fee on a photographed receipt", () => {
      // The money rule, unchanged: on a photo it is the heuristic or
      // nothing, and the heuristic has no fee rule - so this field is
      // absent on every vision receipt today, by construction.
      const merged = mergeSuggestions(
        ocr(),
        llm({ otherFeesCents: 599 }),
        UNREVIEWED_VISION,
      );
      expect(merged?.otherFeesCents).toEqual({ value: null, source: null });
    });
  });

  /**
   * The arithmetic rule (2026-09-01, domain/suggestedAmounts.ts): a total
   * below the sum of its own parts is a misread label, and the outlier is
   * withheld rather than served. Every case here is shaped after a receipt
   * the 136-receipt diagnosis actually found.
   */
  describe("amounts that cannot all be true", () => {
    /** A heuristic record carrying exactly the amounts a case names. */
    function amounts(
      values: Partial<OcrFieldSuggestions>,
    ): OcrFieldSuggestions {
      return ocr({
        totalCents: null,
        hstCents: null,
        subtotalCents: null,
        tipCents: null,
        ...values,
      });
    }

    it("withholds the total when the subtotal and tax corroborate each other", () => {
      // Costco: "TOTAL DISCOUNT(S) $ 8.50" taken as the total on a $218.94
      // purchase whose subtotal (211.60) and HST (7.34) were both read
      // correctly. 7.34/211.60 is a plausible rate, so the total is the
      // outlier and the pair stands.
      const merged = mergeSuggestions(
        amounts({ subtotalCents: 21160, hstCents: 734, totalCents: 850 }),
        null,
        UNREVIEWED_VISION,
      );
      expect(merged?.totalCents).toEqual({
        value: null,
        source: null,
        disagreement: false,
        withheld: true,
      });
      expect(merged?.subtotalCents).toEqual({
        value: 21160,
        source: "heuristic",
        disagreement: false,
        withheld: false,
      });
      expect(merged?.hstCents).toEqual({
        value: 734,
        source: "heuristic",
        disagreement: false,
        withheld: false,
      });
    });

    it("withholds the total when there is no tax to corroborate with", () => {
      // A nonsense pair, no HST line: nothing says the subtotal is wrong.
      const merged = mergeSuggestions(
        amounts({ subtotalCents: 986, totalCents: 325 }),
        null,
        UNREVIEWED_VISION,
      );
      expect(merged?.totalCents).toEqual({
        value: null,
        source: null,
        disagreement: false,
        withheld: true,
      });
      expect(merged?.subtotalCents).toEqual({
        value: 986,
        source: "heuristic",
        disagreement: false,
        withheld: false,
      });
    });

    it("withholds both when the tax is not a plausible rate on the subtotal", () => {
      // 40% is not a Canadian tax rate, so the subtotal and the HST are
      // already inconsistent with each other: there is nothing left to
      // trust, and the person types both from the paper.
      const merged = mergeSuggestions(
        amounts({ subtotalCents: 1000, hstCents: 400, totalCents: 500 }),
        null,
        UNREVIEWED_VISION,
      );
      expect(merged?.totalCents).toEqual({
        value: null,
        source: null,
        disagreement: false,
        withheld: true,
      });
      expect(merged?.subtotalCents).toEqual({
        value: null,
        source: null,
        disagreement: false,
        withheld: true,
      });
      // The HST itself is still served: it is not one of the two fields
      // this rule ever withholds.
      expect(merged?.hstCents).toEqual({
        value: 400,
        source: "heuristic",
        disagreement: false,
        withheld: false,
      });
    });

    it("leaves a tax-inclusive card slip alone: AMOUNT + TIP = TOTAL", () => {
      // 20.33 with no printed tax line, a 2.64 tip, 22.97 charged. The sum
      // is exact and nothing is withheld.
      const merged = mergeSuggestions(
        amounts({ subtotalCents: 2033, tipCents: 264, totalCents: 2297 }),
        null,
        UNREVIEWED_VISION,
      );
      expect(merged?.totalCents).toEqual({
        value: 2297,
        source: "heuristic",
        disagreement: false,
        withheld: false,
      });
      expect(merged?.subtotalCents).toEqual({
        value: 2033,
        source: "heuristic",
        disagreement: false,
        withheld: false,
      });
    });

    it("tolerates the one-cent gap three real receipts actually print", () => {
      // 13.50 + 1.76 = 15.26 against a printed 15.25: the merchant rounded
      // the tax and the total independently. A zero-tolerance rule would
      // withhold a correctly-read total on a correctly-printed receipt.
      const merged = mergeSuggestions(
        amounts({ subtotalCents: 1350, hstCents: 176, totalCents: 1525 }),
        null,
        UNREVIEWED_VISION,
      );
      expect(merged?.totalCents).toEqual({
        value: 1525,
        source: "heuristic",
        disagreement: false,
        withheld: false,
      });
    });

    it("counts other fees among the parts the total must cover", () => {
      const merged = mergeSuggestions(
        null,
        llm({
          subtotalCents: 1000,
          hstCents: 130,
          tipCents: null,
          otherFeesCents: 599,
          totalCents: 1130,
        }),
        // pdf-text, so the LLM's amounts are the served ones and the rule
        // has something to judge.
        { status: "pending", reviewedFields: [], ocrSource: "pdf-text" },
      );
      expect(merged?.totalCents).toEqual({
        value: null,
        source: null,
        disagreement: false,
        withheld: true,
      });
      expect(merged?.otherFeesCents).toEqual({ value: 599, source: "llm" });
    });

    it("says nothing when there is no subtotal to compare a total against", () => {
      const merged = mergeSuggestions(
        amounts({ hstCents: 734, totalCents: 850 }),
        null,
        UNREVIEWED_VISION,
      );
      expect(merged?.totalCents).toEqual({
        value: 850,
        source: "heuristic",
        disagreement: false,
        withheld: false,
      });
    });
  });
});
