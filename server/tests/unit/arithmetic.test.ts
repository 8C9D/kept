import { describe, expect, it } from "vitest";
import { checkReceiptArithmetic } from "../../src/domain/arithmetic.js";
import { cents } from "../../src/domain/money.js";

describe("checkReceiptArithmetic", () => {
  it("reconciles when subtotal + hst equals total", () => {
    const result = checkReceiptArithmetic({
      subtotalCents: cents(10000),
      hstCents: cents(1300),
      totalCents: cents(11300),
    });
    expect(result).toBe("reconciles");
  });

  it("treats a missing hst line as contributing nothing", () => {
    const result = checkReceiptArithmetic({
      subtotalCents: cents(10000),
      hstCents: null,
      totalCents: cents(10000),
    });
    expect(result).toBe("reconciles");
  });

  it("reports a mismatch when the numbers do not add up", () => {
    const result = checkReceiptArithmetic({
      subtotalCents: cents(10000),
      hstCents: cents(1300),
      totalCents: cents(11400),
    });
    expect(result).toBe("mismatch");
  });

  /**
   * The 2026-08-26 field reduction removed other_tax. A receipt whose paper
   * carries a second tax line no longer reconciles, and that is the correct
   * answer rather than a bug: the check has always been advisory, and the
   * amount it cannot see is genuinely not in the record any more.
   */
  it("reports a mismatch when a tax the receipt no longer records is what closed the gap", () => {
    const result = checkReceiptArithmetic({
      subtotalCents: cents(10000),
      hstCents: cents(1300),
      totalCents: cents(11500),
    });
    expect(result).toBe("mismatch");
  });

  it("is not applicable without a subtotal to reconcile against", () => {
    const result = checkReceiptArithmetic({
      subtotalCents: null,
      hstCents: cents(1300),
      totalCents: cents(11300),
    });
    expect(result).toBe("not-applicable");
  });

  it("reconciles negative amounts on a refund receipt", () => {
    const result = checkReceiptArithmetic({
      subtotalCents: cents(-10000),
      hstCents: cents(-1300),
      totalCents: cents(-11300),
    });
    expect(result).toBe("reconciles");
  });
});
