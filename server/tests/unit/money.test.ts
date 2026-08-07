import { describe, expect, it } from "vitest";
import {
  InvalidMoneyError,
  MAX_STORABLE_CENTS,
  MIN_STORABLE_CENTS,
  cents,
  centsToDecimalString,
} from "../../src/domain/money.js";

describe("cents", () => {
  it("accepts whole numbers of cents, including zero and refunds", () => {
    expect(cents(11300)).toBe(11300);
    expect(cents(0)).toBe(0);
    expect(cents(-4200)).toBe(-4200); // a refund receipt is a real receipt
  });

  it("accepts amounts at the storable boundary", () => {
    expect(cents(MAX_STORABLE_CENTS)).toBe(MAX_STORABLE_CENTS);
    expect(cents(MIN_STORABLE_CENTS)).toBe(MIN_STORABLE_CENTS);
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

  /**
   * This replaces a test that asserted cents(MAX_SAFE_INTEGER) is accepted.
   * That assertion encoded a deliberate intent - the domain does not know
   * about storage - which the August 2026 audit showed to be wrong: every
   * money column is int4, so the domain was promising a range the database
   * refuses, and the refusal surfaced as a 500 that logged the whole
   * receipt. Recorded here rather than silently deleted, because the old
   * test was not failing by accident.
   */
  it("rejects amounts the money columns cannot store", () => {
    expect(() => cents(MAX_STORABLE_CENTS + 1)).toThrow(InvalidMoneyError);
    expect(() => cents(MIN_STORABLE_CENTS - 1)).toThrow(InvalidMoneyError);
    expect(() => cents(Number.MAX_SAFE_INTEGER)).toThrow(InvalidMoneyError);
  });

  it("names the range as the reason, not fractional cents", () => {
    expect(() => cents(MAX_STORABLE_CENTS + 1)).toThrow(
      /outside the storable amount range/,
    );
    expect(() => cents(113.5)).toThrow(/must be an integer number of cents/);
  });
});

describe("centsToDecimalString", () => {
  it("renders whole and fractional dollar amounts", () => {
    expect(centsToDecimalString(cents(11300))).toBe("113.00");
    expect(centsToDecimalString(cents(1234567))).toBe("12345.67");
  });

  it("pads sub-dollar amounts to two places", () => {
    expect(centsToDecimalString(cents(5))).toBe("0.05");
    expect(centsToDecimalString(cents(50))).toBe("0.50");
    expect(centsToDecimalString(cents(0))).toBe("0.00");
  });

  it("keeps the sign on refunds, including sub-dollar ones", () => {
    expect(centsToDecimalString(cents(-4200))).toBe("-42.00");
    expect(centsToDecimalString(cents(-7))).toBe("-0.07");
  });
});
