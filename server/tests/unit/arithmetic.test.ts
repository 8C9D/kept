import { describe, expect, it } from "vitest";
import {
  checkHstRatePlausibility,
  checkReceiptArithmetic,
  deriveMissingAmount,
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
