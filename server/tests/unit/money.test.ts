import { describe, expect, it } from "vitest";
import { InvalidMoneyError, cents } from "../../src/domain/money.js";

describe("cents", () => {
  it("accepts whole numbers of cents, including zero and refunds", () => {
    expect(cents(11300)).toBe(11300);
    expect(cents(0)).toBe(0);
    expect(cents(-4200)).toBe(-4200); // a refund receipt is a real receipt
  });

  it("accepts amounts at the safe-integer boundary", () => {
    expect(cents(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("rejects fractional cents - floats never enter the money path", () => {
    expect(() => cents(113.5)).toThrow(InvalidMoneyError);
    expect(() => cents(0.1 + 0.2)).toThrow(InvalidMoneyError);
  });

  it("rejects values that are not finite integers", () => {
    expect(() => cents(Number.NaN)).toThrow(InvalidMoneyError);
    expect(() => cents(Number.POSITIVE_INFINITY)).toThrow(InvalidMoneyError);
    expect(() => cents(Number.MAX_SAFE_INTEGER + 1)).toThrow(InvalidMoneyError);
  });
});
