import { describe, expect, it } from "vitest";
import {
  checkAmountFloor,
  checkHstRatePlausibility,
  checkReceiptArithmetic,
  deriveMissingAmount,
  suggestDefaultRateHst,
} from "../../src/domain/arithmetic.js";
import { MAX_STORABLE_CENTS, cents } from "../../src/domain/money.js";

describe("checkReceiptArithmetic", () => {
  it("reconciles when subtotal + hst equals total", () => {
    const result = checkReceiptArithmetic({
      subtotalCents: cents(10000),
      hstCents: cents(1300),
      tipCents: null,
      otherFeesCents: null,
      totalCents: cents(11300),
    });
    expect(result).toBe("reconciles");
  });

  it("treats a missing hst line as contributing nothing", () => {
    const result = checkReceiptArithmetic({
      subtotalCents: cents(10000),
      hstCents: null,
      tipCents: null,
      otherFeesCents: null,
      totalCents: cents(10000),
    });
    expect(result).toBe("reconciles");
  });

  it("reports a mismatch when the numbers do not add up", () => {
    const result = checkReceiptArithmetic({
      subtotalCents: cents(10000),
      hstCents: cents(1300),
      tipCents: null,
      otherFeesCents: null,
      totalCents: cents(11400),
    });
    expect(result).toBe("mismatch");
  });

  /**
   * The case that motivated bringing tip back (2026-08-28 product feedback):
   * a restaurant receipt with a printed tip line now reconciles instead of
   * showing the advisory amber warning the 2026-08-26 field reduction
   * knowingly accepted.
   */
  it("reconciles a tipped restaurant receipt: subtotal + hst + tip = total", () => {
    const result = checkReceiptArithmetic({
      subtotalCents: cents(10000),
      hstCents: cents(1300),
      tipCents: cents(2000),
      otherFeesCents: null,
      totalCents: cents(13300),
    });
    expect(result).toBe("reconciles");
  });

  it("treats a missing tip line as contributing nothing", () => {
    const result = checkReceiptArithmetic({
      subtotalCents: cents(10000),
      hstCents: cents(1300),
      tipCents: null,
      otherFeesCents: null,
      totalCents: cents(11300),
    });
    expect(result).toBe("reconciles");
  });

  it("reconciles other fees the same way tip does - a delivery fee or foreign tax line", () => {
    const result = checkReceiptArithmetic({
      subtotalCents: cents(10000),
      hstCents: null,
      tipCents: null,
      otherFeesCents: cents(500),
      totalCents: cents(10500),
    });
    expect(result).toBe("reconciles");
  });

  it("reconciles when subtotal, hst, tip and other fees all contribute", () => {
    const result = checkReceiptArithmetic({
      subtotalCents: cents(10000),
      hstCents: cents(1300),
      tipCents: cents(2000),
      otherFeesCents: cents(500),
      totalCents: cents(13800),
    });
    expect(result).toBe("reconciles");
  });

  it("reports a mismatch when tip or other fees do not close the gap", () => {
    const result = checkReceiptArithmetic({
      subtotalCents: cents(10000),
      hstCents: cents(1300),
      tipCents: cents(2000),
      otherFeesCents: null,
      totalCents: cents(13301),
    });
    expect(result).toBe("mismatch");
  });

  it("is not applicable without a subtotal to reconcile against", () => {
    const result = checkReceiptArithmetic({
      subtotalCents: null,
      hstCents: cents(1300),
      tipCents: null,
      otherFeesCents: null,
      totalCents: cents(11300),
    });
    expect(result).toBe("not-applicable");
  });

  it("reconciles negative amounts on a refund receipt", () => {
    const result = checkReceiptArithmetic({
      subtotalCents: cents(-10000),
      hstCents: cents(-1300),
      tipCents: null,
      otherFeesCents: null,
      totalCents: cents(-11300),
    });
    expect(result).toBe("reconciles");
  });
});

/**
 * Proposal #1's derivation: given four of the five money fields, what value
 * closes the gap on the fifth. A suggestion generator only - see the
 * function's own doc comment for why no route may call it.
 */
describe("deriveMissingAmount", () => {
  // A full, reconciling set of five fields to null out one at a time, so
  // every case below is checking the same arithmetic from a different
  // missing corner.
  const full = {
    subtotalCents: cents(10000),
    hstCents: cents(1300),
    tipCents: cents(2000),
    otherFeesCents: cents(500),
    totalCents: cents(13800),
  };

  it("derives subtotal when it is the only field missing", () => {
    const result = deriveMissingAmount({ ...full, subtotalCents: null });
    expect(result).toEqual({ field: "subtotalCents", cents: 10000 });
  });

  it("derives hst when it is the only field missing", () => {
    const result = deriveMissingAmount({ ...full, hstCents: null });
    expect(result).toEqual({ field: "hstCents", cents: 1300 });
  });

  it("derives tip when it is the only field missing", () => {
    const result = deriveMissingAmount({ ...full, tipCents: null });
    expect(result).toEqual({ field: "tipCents", cents: 2000 });
  });

  it("derives other fees when it is the only field missing", () => {
    const result = deriveMissingAmount({ ...full, otherFeesCents: null });
    expect(result).toEqual({ field: "otherFeesCents", cents: 500 });
  });

  it("derives total when it is the only field missing", () => {
    const result = deriveMissingAmount({ ...full, totalCents: null });
    expect(result).toEqual({ field: "totalCents", cents: 13800 });
  });

  it("has nothing to derive when zero fields are missing", () => {
    expect(deriveMissingAmount(full)).toBeNull();
  });

  it("has nothing to derive when two fields are missing", () => {
    const result = deriveMissingAmount({
      ...full,
      tipCents: null,
      otherFeesCents: null,
    });
    expect(result).toBeNull();
  });

  /**
   * The proposal's own example: a restaurant bill where subtotal, HST and
   * total are printed and tip is the gap. Other fees is present as an
   * explicit zero (no delivery fee on this bill) so tip is the ONLY
   * missing field - the derivation needs exactly one unknown.
   */
  it("derives the restaurant case: subtotal + hst + total known, tip missing", () => {
    const result = deriveMissingAmount({
      subtotalCents: cents(10000),
      hstCents: cents(1300),
      tipCents: null,
      otherFeesCents: cents(0),
      totalCents: cents(13300),
    });
    expect(result).toEqual({ field: "tipCents", cents: 2000 });
  });

  it("has nothing to derive when the balancing value is outside the storable range", () => {
    const result = deriveMissingAmount({
      subtotalCents: cents(MAX_STORABLE_CENTS),
      hstCents: cents(MAX_STORABLE_CENTS),
      tipCents: cents(MAX_STORABLE_CENTS),
      otherFeesCents: cents(MAX_STORABLE_CENTS),
      totalCents: null,
    });
    expect(result).toBeNull();
  });

  it("refuses a derived negative tip - there is no such thing on a receipt", () => {
    // subtotal + hst + otherFees already exceeds total, so closing the gap
    // with tip alone would require a negative tip.
    const result = deriveMissingAmount({
      subtotalCents: cents(10000),
      hstCents: cents(1300),
      tipCents: null,
      otherFeesCents: cents(0),
      totalCents: cents(11000),
    });
    expect(result).toBeNull();
  });

  it("refuses a derived negative other-fees amount for the same reason", () => {
    const result = deriveMissingAmount({
      subtotalCents: cents(10000),
      hstCents: cents(1300),
      tipCents: cents(0),
      otherFeesCents: null,
      totalCents: cents(11000),
    });
    expect(result).toBeNull();
  });

  /**
   * Unlike tip and other fees, a negative subtotal, HST or total is a real
   * receipt (a refund) and deriveMissingAmount must not refuse it.
   */
  it("allows a derived negative subtotal on a refund receipt", () => {
    const result = deriveMissingAmount({
      subtotalCents: null,
      hstCents: cents(-1300),
      tipCents: cents(0),
      otherFeesCents: cents(0),
      totalCents: cents(-11300),
    });
    expect(result).toEqual({ field: "subtotalCents", cents: -10000 });
  });

  it("allows a derived negative hst on a refund receipt", () => {
    const result = deriveMissingAmount({
      subtotalCents: cents(-10000),
      hstCents: null,
      tipCents: cents(0),
      otherFeesCents: cents(0),
      totalCents: cents(-11300),
    });
    expect(result).toEqual({ field: "hstCents", cents: -1300 });
  });

  it("allows a derived negative total on a refund receipt", () => {
    const result = deriveMissingAmount({
      subtotalCents: cents(-10000),
      hstCents: cents(-1300),
      tipCents: cents(0),
      otherFeesCents: cents(0),
      totalCents: null,
    });
    expect(result).toEqual({ field: "totalCents", cents: -11300 });
  });

  /**
   * 2026-09-01: a blank tip and a blank other-fees line stopped counting as
   * unknowns when the field being solved for is HST, subtotal or total.
   * Before this, the commonest receipt shape there is - a subtotal and a
   * total, no tip, no fees - had three nulls and derived nothing, which made
   * the feature almost unreachable.
   */
  describe("a blank tip or other-fees line, which most receipts have", () => {
    it("derives hst from a subtotal and a total alone", () => {
      // The proposal's own worked example.
      const result = deriveMissingAmount({
        subtotalCents: cents(1270),
        hstCents: null,
        tipCents: null,
        otherFeesCents: null,
        totalCents: cents(1435),
      });
      expect(result).toEqual({ field: "hstCents", cents: 165 });
    });

    it("derives the total from a subtotal and an hst alone", () => {
      const result = deriveMissingAmount({
        subtotalCents: cents(1270),
        hstCents: cents(165),
        tipCents: null,
        otherFeesCents: null,
        totalCents: null,
      });
      expect(result).toEqual({ field: "totalCents", cents: 1435 });
    });

    it("derives the subtotal from an hst and a total alone", () => {
      const result = deriveMissingAmount({
        subtotalCents: null,
        hstCents: cents(165),
        tipCents: null,
        otherFeesCents: null,
        totalCents: cents(1435),
      });
      expect(result).toEqual({ field: "subtotalCents", cents: 1270 });
    });

    it("derives nothing from a subtotal alone - two real unknowns", () => {
      const result = deriveMissingAmount({
        subtotalCents: cents(1270),
        hstCents: null,
        tipCents: null,
        otherFeesCents: null,
        totalCents: null,
      });
      expect(result).toBeNull();
    });

    it("still refuses to invent a tip from four other numbers that do not balance", () => {
      // The asymmetry, pinned: "the tip line is blank, so there was no tip"
      // is a reading anyone would make; "the tip is whatever makes these
      // balance" invents a gratuity out of a rounding difference. Solving
      // FOR tip still needs the other four present.
      const result = deriveMissingAmount({
        subtotalCents: cents(1270),
        hstCents: cents(165),
        tipCents: null,
        otherFeesCents: null,
        totalCents: cents(1635),
      });
      // otherFeesCents is blank too, so there is no single soft unknown to
      // solve for - and neither of the two may be conjured.
      expect(result).toBeNull();
    });

    it("still derives a negative hst on a refund receipt with no tip line", () => {
      const result = deriveMissingAmount({
        subtotalCents: cents(-1270),
        hstCents: null,
        tipCents: null,
        otherFeesCents: null,
        totalCents: cents(-1435),
      });
      expect(result).toEqual({ field: "hstCents", cents: -165 });
    });

    it("treats a blank line beside one real unknown as zero, not as a second unknown", () => {
      // Subtotal missing, tip blank, everything else present: one unknown.
      const result = deriveMissingAmount({
        subtotalCents: null,
        hstCents: cents(165),
        tipCents: null,
        otherFeesCents: cents(300),
        totalCents: cents(1735),
      });
      expect(result).toEqual({ field: "subtotalCents", cents: 1270 });
    });
  });
});

/**
 * Proposal #7's plausibility hint: catches a heuristic reading one half of a
 * split-printed 13% HST (8% provincial + 5% federal, Ontario) as though it
 * were the whole tax. Deliberately narrow - see the function's own doc
 * comment for the false-positive reasoning this suite exists to pin down.
 */
describe("checkHstRatePlausibility", () => {
  it("is not applicable without a subtotal", () => {
    expect(
      checkHstRatePlausibility({ subtotalCents: null, hstCents: cents(800) }),
    ).toBe("not-applicable");
  });

  it("is not applicable without an HST amount", () => {
    expect(
      checkHstRatePlausibility({ subtotalCents: cents(10000), hstCents: null }),
    ).toBe("not-applicable");
  });

  it("is not applicable with a zero subtotal - no rate to anchor", () => {
    expect(
      checkHstRatePlausibility({ subtotalCents: cents(0), hstCents: cents(0) }),
    ).toBe("not-applicable");
  });

  it("is not applicable with a negative subtotal", () => {
    expect(
      checkHstRatePlausibility({
        subtotalCents: cents(-10000),
        hstCents: cents(-800),
      }),
    ).toBe("not-applicable");
  });

  it("does not flag a legitimate 5% GST-only receipt", () => {
    // A lone GST row is a real tax (§7.3's own ranking treats it that way) -
    // flagging near-5% would fire on every GST-only-province receipt.
    expect(
      checkHstRatePlausibility({ subtotalCents: cents(10000), hstCents: cents(500) }),
    ).toBe("plausible");
  });

  it("does not flag a legitimate 13% Ontario receipt", () => {
    expect(
      checkHstRatePlausibility({
        subtotalCents: cents(10000),
        hstCents: cents(1300),
      }),
    ).toBe("plausible");
  });

  it("does not flag a legitimate 15% Atlantic-province receipt", () => {
    expect(
      checkHstRatePlausibility({
        subtotalCents: cents(10000),
        hstCents: cents(1500),
      }),
    ).toBe("plausible");
  });

  it("does not flag a genuinely exempt (0%) receipt", () => {
    expect(
      checkHstRatePlausibility({ subtotalCents: cents(10000), hstCents: cents(0) }),
    ).toBe("plausible");
  });

  it("flags an 8% receipt as looking like half a split", () => {
    expect(
      checkHstRatePlausibility({ subtotalCents: cents(10000), hstCents: cents(800) }),
    ).toBe("looks-like-half-split");
  });

  it("flags the exact lower boundary of the tolerance (7.75%)", () => {
    expect(
      checkHstRatePlausibility({ subtotalCents: cents(10000), hstCents: cents(775) }),
    ).toBe("looks-like-half-split");
  });

  it("does not flag just below the lower boundary (7.74%)", () => {
    expect(
      checkHstRatePlausibility({ subtotalCents: cents(10000), hstCents: cents(774) }),
    ).toBe("plausible");
  });

  it("flags the exact upper boundary of the tolerance (8.25%)", () => {
    expect(
      checkHstRatePlausibility({ subtotalCents: cents(10000), hstCents: cents(825) }),
    ).toBe("looks-like-half-split");
  });

  it("does not flag just above the upper boundary (8.26%)", () => {
    expect(
      checkHstRatePlausibility({ subtotalCents: cents(10000), hstCents: cents(826) }),
    ).toBe("plausible");
  });

  it("holds the same boundary at a different subtotal scale", () => {
    // $1,000 subtotal - the boundary is a RATE, not a fixed cents offset.
    expect(
      checkHstRatePlausibility({
        subtotalCents: cents(100000),
        hstCents: cents(7750), // exactly 7.75%
      }),
    ).toBe("looks-like-half-split");
    expect(
      checkHstRatePlausibility({
        subtotalCents: cents(100000),
        hstCents: cents(7749), // just under 7.75%
      }),
    ).toBe("plausible");
  });
});

/**
 * `suggestDefaultRateHst` (2026-09-01): the HST a rate would produce on a
 * subtotal, for a confirm screen to offer as a one-tap fill on a receipt
 * whose tax line the parser could not read. A suggestion generator like
 * everything else in this file - nothing here writes.
 */
describe("suggestDefaultRateHst", () => {
  it("applies Ontario's 13% by default", () => {
    expect(suggestDefaultRateHst(cents(10000))).toEqual({
      hstCents: 1300,
      totalCents: 11300,
    });
  });

  it("rounds half up, in integer arithmetic", () => {
    // 1270 * 1300 / 10000 = 165.1 -> 165
    expect(suggestDefaultRateHst(cents(1270))?.hstCents).toBe(165);
    // 50 * 1300 / 10000 = 6.5 -> 7, the exact half that decides the rule
    expect(suggestDefaultRateHst(cents(50))?.hstCents).toBe(7);
    // 1 * 1300 / 10000 = 0.13 -> 0: a penny is not taxed into another penny
    expect(suggestDefaultRateHst(cents(1))).toEqual({
      hstCents: 0,
      totalCents: 1,
    });
  });

  it("adds the derived tax to the subtotal for the total", () => {
    const result = suggestDefaultRateHst(cents(4349));
    expect(result).toEqual({ hstCents: 565, totalCents: 4914 });
  });

  it("takes another rate in basis points", () => {
    // GST-only, 5%.
    expect(suggestDefaultRateHst(cents(10000), 500)).toEqual({
      hstCents: 500,
      totalCents: 10500,
    });
    // A zero-rated basket: a real answer, not a refusal.
    expect(suggestDefaultRateHst(cents(10000), 0)).toEqual({
      hstCents: 0,
      totalCents: 10000,
    });
  });

  it("suggests nothing for a subtotal that cannot anchor a rate", () => {
    // Zero and a refund's negative both have no honest 13% to offer - the
    // same guard checkHstRatePlausibility uses.
    expect(suggestDefaultRateHst(cents(0))).toBeNull();
    expect(suggestDefaultRateHst(cents(-10000))).toBeNull();
  });

  it("suggests nothing when the total would not be storable", () => {
    expect(suggestDefaultRateHst(cents(MAX_STORABLE_CENTS))).toBeNull();
  });

  it("throws on a rate that is not a non-negative integer of basis points", () => {
    // A programming error, not a receipt: loud rather than quietly computed.
    expect(() => suggestDefaultRateHst(cents(10000), -100)).toThrow(RangeError);
    expect(() => suggestDefaultRateHst(cents(10000), 13.5)).toThrow(RangeError);
  });
});

/**
 * `checkAmountFloor` (2026-09-01): the one direction of arithmetic mismatch
 * that is never a legitimate receipt - a total below the sum of the lines
 * the receipt itself prints. Advisory like everything else here.
 */
describe("checkAmountFloor", () => {
  const base = {
    subtotalCents: cents(10000),
    hstCents: cents(1300),
    tipCents: null,
    otherFeesCents: null,
    totalCents: cents(11300),
  };

  it("is ok when the total exactly covers the components", () => {
    expect(checkAmountFloor(base)).toBe("ok");
  });

  it("is ok when the total exceeds the components", () => {
    // An unprinted line, a rounding entry: a mismatch checkReceiptArithmetic
    // reports, but not this one - the total still covers what is printed.
    expect(checkAmountFloor({ ...base, totalCents: cents(11500) })).toBe("ok");
  });

  it("flags a total that falls below the components", () => {
    expect(checkAmountFloor({ ...base, totalCents: cents(11299) })).toBe(
      "total-below-components",
    );
  });

  it("counts a missing tip or other-fees line as nothing", () => {
    expect(
      checkAmountFloor({
        ...base,
        tipCents: cents(2000),
        totalCents: cents(13300),
      }),
    ).toBe("ok");
    expect(
      checkAmountFloor({
        ...base,
        tipCents: cents(2000),
        totalCents: cents(13299),
      }),
    ).toBe("total-below-components");
  });

  it("is not applicable without a subtotal or without a total", () => {
    expect(checkAmountFloor({ ...base, subtotalCents: null })).toBe(
      "not-applicable",
    );
    expect(checkAmountFloor({ ...base, totalCents: null })).toBe(
      "not-applicable",
    );
  });

  it("reads a refund receipt by the same rule, not by sign", () => {
    // -11300 covers -10000 + -1300 exactly; nothing about a negative
    // receipt makes it a floor violation.
    expect(
      checkAmountFloor({
        subtotalCents: cents(-10000),
        hstCents: cents(-1300),
        tipCents: null,
        otherFeesCents: null,
        totalCents: cents(-11300),
      }),
    ).toBe("ok");
    expect(
      checkAmountFloor({
        subtotalCents: cents(-10000),
        hstCents: cents(-1300),
        tipCents: null,
        otherFeesCents: null,
        totalCents: cents(-11301),
      }),
    ).toBe("total-below-components");
  });
});
