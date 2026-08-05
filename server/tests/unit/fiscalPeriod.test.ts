import { describe, expect, it } from "vitest";
import { toIsoDate } from "../../src/domain/calendarDate.js";
import {
  InvalidFiscalYearEndError,
  fiscalPeriodContaining,
  fiscalPeriodEndingIn,
  isValidFiscalYearEnd,
} from "../../src/domain/fiscalPeriod.js";

function isoPeriod(period: {
  start: Parameters<typeof toIsoDate>[0];
  end: Parameters<typeof toIsoDate>[0];
}) {
  return { start: toIsoDate(period.start), end: toIsoDate(period.end) };
}

describe("fiscalPeriodEndingIn", () => {
  it("maps a Dec 31 year end onto the calendar year", () => {
    const period = fiscalPeriodEndingIn(2026, { month: 12, day: 31 });
    expect(isoPeriod(period)).toEqual({
      start: "2026-01-01",
      end: "2026-12-31",
    });
  });

  it("spans two calendar years for a Mar 31 year end", () => {
    const period = fiscalPeriodEndingIn(2026, { month: 3, day: 31 });
    expect(isoPeriod(period)).toEqual({
      start: "2025-04-01",
      end: "2026-03-31",
    });
  });

  it("handles a Feb 28 year end across a leap year boundary", () => {
    // 2024 is a leap year; the period still starts Mar 1 because the
    // configured end is the 28th, leaving Feb 29 2024 in the next period.
    const period = fiscalPeriodEndingIn(2024, { month: 2, day: 28 });
    expect(isoPeriod(period)).toEqual({
      start: "2023-03-01",
      end: "2024-02-28",
    });
  });

  it("clamps a Feb 29 year end to Feb 28 in non-leap years", () => {
    const period = fiscalPeriodEndingIn(2026, { month: 2, day: 29 });
    expect(isoPeriod(period)).toEqual({
      start: "2025-03-01",
      end: "2026-02-28",
    });
  });

  it("keeps Feb 29 in leap years", () => {
    const period = fiscalPeriodEndingIn(2028, { month: 2, day: 29 });
    expect(isoPeriod(period)).toEqual({
      start: "2027-03-01",
      end: "2028-02-29",
    });
  });

  it("rejects a year end that names no real day", () => {
    expect(() => fiscalPeriodEndingIn(2026, { month: 2, day: 30 })).toThrow(
      InvalidFiscalYearEndError,
    );
    expect(() => fiscalPeriodEndingIn(2026, { month: 6, day: 31 })).toThrow(
      InvalidFiscalYearEndError,
    );
    expect(() => fiscalPeriodEndingIn(2026, { month: 13, day: 1 })).toThrow(
      InvalidFiscalYearEndError,
    );
  });
});

describe("fiscalPeriodContaining", () => {
  const marchYearEnd = { month: 3, day: 31 };

  it("assigns a date before the year end to the period ending that year", () => {
    const period = fiscalPeriodContaining(
      { year: 2026, month: 2, day: 10 },
      marchYearEnd,
    );
    expect(isoPeriod(period).end).toBe("2026-03-31");
  });

  it("assigns a date after the year end to the period ending next year", () => {
    const period = fiscalPeriodContaining(
      { year: 2026, month: 5, day: 10 },
      marchYearEnd,
    );
    expect(isoPeriod(period)).toEqual({
      start: "2026-04-01",
      end: "2027-03-31",
    });
  });

  it("includes the boundary days themselves", () => {
    const onEnd = fiscalPeriodContaining(
      { year: 2026, month: 3, day: 31 },
      marchYearEnd,
    );
    expect(isoPeriod(onEnd).end).toBe("2026-03-31");

    const dayAfter = fiscalPeriodContaining(
      { year: 2026, month: 4, day: 1 },
      marchYearEnd,
    );
    expect(isoPeriod(dayAfter).start).toBe("2026-04-01");
  });
});

describe("isValidFiscalYearEnd", () => {
  it("accepts Feb 29 because leap years realize it", () => {
    expect(isValidFiscalYearEnd({ month: 2, day: 29 })).toBe(true);
  });

  it("rejects impossible month/day pairs", () => {
    expect(isValidFiscalYearEnd({ month: 2, day: 30 })).toBe(false);
    expect(isValidFiscalYearEnd({ month: 4, day: 31 })).toBe(false);
    expect(isValidFiscalYearEnd({ month: 0, day: 1 })).toBe(false);
  });
});
