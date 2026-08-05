import { describe, expect, it } from "vitest";
import { checkReceiptArithmetic } from "../../src/domain/arithmetic.js";
import { cents } from "../../src/domain/money.js";

describe("checkReceiptArithmetic", () => {
  it("reconciles when subtotal + hst + other tax equals total", () => {
    const result = checkReceiptArithmetic({
      subtotalCents: cents(10000),
      hstCents: cents(1300),
      otherTaxCents: cents(200),
      totalCents: cents(11500),
    });
    expect(result).toBe("reconciles");
  });

  it("treats missing tax lines as contributing nothing", () => {
    const result = checkReceiptArithmetic({
      subtotalCents: cents(10000),
      hstCents: null,
      otherTaxCents: null,
      totalCents: cents(10000),
    });
    expect(result).toBe("reconciles");
  });

  it("reports a mismatch when the numbers do not add up", () => {
    const result = checkReceiptArithmetic({
      subtotalCents: cents(10000),
      hstCents: cents(1300),
      otherTaxCents: null,
      totalCents: cents(11400),
    });
    expect(result).toBe("mismatch");
  });

  it("is not applicable without a subtotal to reconcile against", () => {
    const result = checkReceiptArithmetic({
      subtotalCents: null,
      hstCents: cents(1300),
      otherTaxCents: null,
      totalCents: cents(11300),
    });
    expect(result).toBe("not-applicable");
  });

  it("reconciles negative amounts on a refund receipt", () => {
    const result = checkReceiptArithmetic({
      subtotalCents: cents(-10000),
      hstCents: cents(-1300),
      otherTaxCents: null,
      totalCents: cents(-11300),
    });
    expect(result).toBe("reconciles");
  });
});
