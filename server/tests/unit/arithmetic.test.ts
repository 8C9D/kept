import { describe, expect, it } from "vitest";
import { checkReceiptArithmetic } from "../../src/domain/arithmetic.js";
import { cents } from "../../src/domain/money.js";

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
