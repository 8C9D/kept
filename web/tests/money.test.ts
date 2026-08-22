import { describe, expect, it } from "vitest";
import { MoneyParseError, formatCents, parseMoneyInput } from "../src/money.js";

/**
 * Money is integer cents, never floats (CLAUDE.md) - here that means the
 * round trip person-sees -> person-types -> server-stores moves through
 * strings and integers only, and anything unparseable refuses rather than
 * rounds.
 */
describe("formatCents", () => {
  it("renders cents as dollars without float arithmetic artifacts", () => {
    expect(formatCents(0)).toBe("$0.00");
    expect(formatCents(5)).toBe("$0.05");
    expect(formatCents(1234)).toBe("$12.34");
    expect(formatCents(-1234)).toBe("-$12.34");
    expect(formatCents(11300)).toBe("$113.00");
    // The classic float trap: 0.1 + 0.2. As cents it is exact.
    expect(formatCents(30)).toBe("$0.30");
    // int4 boundary, the largest amount the server stores.
    expect(formatCents(2147483647)).toBe("$21474836.47");
  });

  it("renders null as empty - the stated 'not on this receipt'", () => {
    expect(formatCents(null)).toBe("");
  });

  it("refuses a non-integer instead of rounding it", () => {
    expect(() => formatCents(12.5)).toThrow(/Not an integer/);
  });
});

describe("parseMoneyInput", () => {
  it("parses the shapes a person types", () => {
    expect(parseMoneyInput("12.34")).toBe(1234);
    expect(parseMoneyInput("$12.34")).toBe(1234);
    expect(parseMoneyInput("113")).toBe(11300);
    expect(parseMoneyInput("-3.50")).toBe(-350);
    expect(parseMoneyInput("-$3.50")).toBe(-350);
    // One decimal digit means tenths of a dollar - textual, not float.
    expect(parseMoneyInput("3.5")).toBe(350);
    expect(parseMoneyInput("0.05")).toBe(5);
  });

  it("treats empty input as null, the cleared-field case", () => {
    expect(parseMoneyInput("")).toBeNull();
    expect(parseMoneyInput("   ")).toBeNull();
  });

  it("refuses what it cannot parse instead of guessing", () => {
    for (const bad of ["12.345", "abc", "12,34", "1.2.3", "$"]) {
      expect(() => parseMoneyInput(bad), bad).toThrow(MoneyParseError);
    }
  });

  it("round-trips every formatted value", () => {
    for (const cents of [0, 5, 99, 100, 1234, -1234, 2147483647]) {
      expect(parseMoneyInput(formatCents(cents))).toBe(cents);
    }
  });
});
