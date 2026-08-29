import { describe, expect, it } from "vitest";
import {
  currentFiscalYearEndYear,
  fiscalQuarters,
  fiscalYearRange,
  fiscalYearToDate,
  lastFiscalYear,
  todayCalendarDate,
  type CalendarDate,
  type FiscalYearEnd,
} from "../src/fiscalPresets.js";

const DECEMBER_31: FiscalYearEnd = { month: 12, day: 31 };
/** Proposal #10's own named risk: "a preset that computes the wrong
 * boundary is the one thing to test, against a non-December fiscal year
 * end." A business or small business with a June 30 year end is a completely
 * ordinary configuration, not a contrived edge case. */
const JUNE_30: FiscalYearEnd = { month: 6, day: 30 };

function date(year: number, month: number, day: number): CalendarDate {
  return { year, month, day };
}

describe("currentFiscalYearEndYear", () => {
  it("with a December year end, today's fiscal year ends this calendar year", () => {
    expect(currentFiscalYearEndYear(date(2026, 8, 28), DECEMBER_31)).toBe(2026);
  });

  it("is inclusive of the year-end date itself", () => {
    expect(currentFiscalYearEndYear(date(2026, 12, 31), DECEMBER_31)).toBe(2026);
  });

  it("rolls to next year the day after the year-end date", () => {
    expect(currentFiscalYearEndYear(date(2027, 1, 1), DECEMBER_31)).toBe(2027);
  });

  it("with a June 30 year end, a date after June rolls into next year's fiscal year", () => {
    // Predicted before writing (CLAUDE.md: predict before verifying):
    // 2026-08-28 is past this calendar year's June 30 end, so it belongs
    // to the fiscal year ending June 30, 2027.
    expect(currentFiscalYearEndYear(date(2026, 8, 28), JUNE_30)).toBe(2027);
  });

  it("with a June 30 year end, a date before July stays in this calendar year's fiscal year", () => {
    expect(currentFiscalYearEndYear(date(2027, 2, 15), JUNE_30)).toBe(2027);
  });

  it("is inclusive of a non-December year-end date too", () => {
    expect(currentFiscalYearEndYear(date(2026, 6, 30), JUNE_30)).toBe(2026);
  });

  it("rolls over the day after a non-December year end", () => {
    expect(currentFiscalYearEndYear(date(2026, 7, 1), JUNE_30)).toBe(2027);
  });
});

describe("fiscalYearRange - the whole-fiscal-year preview (the actual request is {fiscalYearEndingIn})", () => {
  it("is the calendar year for a December year end", () => {
    expect(fiscalYearRange(2026, DECEMBER_31)).toEqual({
      start: "2026-01-01",
      end: "2026-12-31",
    });
  });

  it("spans two calendar years for a June 30 year end", () => {
    // Predicted: the fiscal year ending in 2027 runs July 1, 2026 through
    // June 30, 2027 - the same shape the spec's own Mar 31 example uses
    // (§5.1: "with a Mar 31 year end it is 2025-04-01 .. 2026-03-31").
    expect(fiscalYearRange(2027, JUNE_30)).toEqual({
      start: "2026-07-01",
      end: "2027-06-30",
    });
  });
});

describe("lastFiscalYear", () => {
  it("December year end: last fiscal year is the previous calendar year", () => {
    const result = lastFiscalYear(date(2026, 8, 28), DECEMBER_31);
    expect(result.endYear).toBe(2025);
    expect(result.range).toEqual({ start: "2025-01-01", end: "2025-12-31" });
  });

  it("June 30 year end: last fiscal year is July-to-June, one year back", () => {
    // Predicted: today (2026-08-28) is in the fiscal year ending June 30,
    // 2027, so "last fiscal year" is the one ending June 30, 2026 - July 1,
    // 2025 through June 30, 2026.
    const result = lastFiscalYear(date(2026, 8, 28), JUNE_30);
    expect(result.endYear).toBe(2026);
    expect(result.range).toEqual({ start: "2025-07-01", end: "2026-06-30" });
  });
});

describe("fiscalYearToDate", () => {
  it("December year end: from January 1 through today", () => {
    expect(fiscalYearToDate(date(2026, 8, 28), DECEMBER_31)).toEqual({
      start: "2026-01-01",
      end: "2026-08-28",
    });
  });

  it("June 30 year end: from the fiscal year's own July 1 start through today", () => {
    // Predicted: today (2027-02-15) sits inside the fiscal year that
    // started July 1, 2026.
    expect(fiscalYearToDate(date(2027, 2, 15), JUNE_30)).toEqual({
      start: "2026-07-01",
      end: "2027-02-15",
    });
  });

  it("on the year-end date itself, still belongs to the fiscal year that just closed", () => {
    // Predicted: June 30, 2026 is the LAST day of the fiscal year ending
    // 2026 (currentFiscalYearEndYear's own inclusive-boundary test above),
    // so "this fiscal year to date" spans the whole year, July 1, 2025
    // through June 30, 2026 - not a one-day range.
    expect(fiscalYearToDate(date(2026, 6, 30), JUNE_30)).toEqual({
      start: "2025-07-01",
      end: "2026-06-30",
    });
  });
});

describe("fiscalQuarters - always explicit ranges, the API has no quarter concept (§12)", () => {
  it("December year end: calendar quarters", () => {
    // Predicted before writing: an ordinary Jan-Mar / Apr-Jun / Jul-Sep /
    // Oct-Dec split.
    const [q1, q2, q3, q4] = fiscalQuarters(date(2026, 8, 28), DECEMBER_31);
    expect(q1).toEqual({ start: "2026-01-01", end: "2026-03-31" });
    expect(q2).toEqual({ start: "2026-04-01", end: "2026-06-30" });
    expect(q3).toEqual({ start: "2026-07-01", end: "2026-09-30" });
    expect(q4).toEqual({ start: "2026-10-01", end: "2026-12-31" });
  });

  it("June 30 year end: quarters shifted by six months - the case that breaks a calendar-quarter assumption", () => {
    // Predicted before writing (CLAUDE.md: predict before verifying), by
    // hand: fiscal year ending June 30, 2027 runs July 2026 - June 2027.
    // Q1 Jul-Sep 2026, Q2 Oct-Dec 2026, Q3 Jan-Mar 2027, Q4 Apr-Jun 2027.
    // A calendar-quarter implementation would instead produce Jan-Mar as
    // "Q1", which is this fiscal year's Q3 - silently wrong in exactly the
    // way the proposal warns about.
    const [q1, q2, q3, q4] = fiscalQuarters(date(2027, 2, 15), JUNE_30);
    expect(q1).toEqual({ start: "2026-07-01", end: "2026-09-30" });
    expect(q2).toEqual({ start: "2026-10-01", end: "2026-12-31" });
    expect(q3).toEqual({ start: "2027-01-01", end: "2027-03-31" });
    expect(q4).toEqual({ start: "2027-04-01", end: "2027-06-30" });
  });

  it("quarters are contiguous and span exactly the fiscal year", () => {
    const [q1, q2, q3, q4] = fiscalQuarters(date(2026, 8, 28), JUNE_30);
    const year = fiscalYearRange(2027, JUNE_30);
    expect(q1.start).toBe(year.start);
    expect(q4.end).toBe(year.end);
    // Each quarter starts the day after the previous one ends - written as
    // exact strings rather than a date-math helper, so a contiguity bug
    // cannot hide behind the same helper this test would otherwise reuse.
    expect(q1.end).toBe("2026-09-30");
    expect(q2.start).toBe("2026-10-01");
    expect(q2.end).toBe("2026-12-31");
    expect(q3.start).toBe("2027-01-01");
  });

  it("does not carry the year end's literal day number across a longer month", () => {
    // The bug this module's own first draft had, found by this exact test:
    // June has 30 days, so a naive "reuse fye.day for every quarter"
    // implementation put Q2's end on December 30th instead of the 31st,
    // silently dropping the last day of every export that used it. June
    // 30 is a month-end config, so every quarter must land on the actual
    // last day of ITS OWN month, not the number 30.
    const [, q2] = fiscalQuarters(date(2026, 8, 28), JUNE_30);
    expect(q2.end).toBe("2026-12-31");
    expect(q2.end).not.toBe("2026-12-30");
  });

  it("a Feb 29 year end re-resolves each quarter to that month's own last day, leap or not", () => {
    const FEB_29: FiscalYearEnd = { month: 2, day: 29 };
    // Fiscal year ending Feb 29, 2028 (2028 is a leap year): starts March
    // 1, 2027. Q1 ends May 31, 2027; Q2 ends Aug 31, 2027; Q3 ends Nov 30,
    // 2027; Q4 ends Feb 29, 2028 - each the real last day of its month,
    // never a clamped-down 28 or a carried-over 29 in a 30-day month.
    const [q1, q2, q3, q4] = fiscalQuarters(date(2027, 6, 1), FEB_29);
    expect(q1).toEqual({ start: "2027-03-01", end: "2027-05-31" });
    expect(q2).toEqual({ start: "2027-06-01", end: "2027-08-31" });
    expect(q3).toEqual({ start: "2027-09-01", end: "2027-11-30" });
    expect(q4).toEqual({ start: "2027-12-01", end: "2028-02-29" });
  });

  it("a mid-month year end keeps its literal day rather than snapping to month-end", () => {
    const MID_MONTH: FiscalYearEnd = { month: 3, day: 15 };
    // Not a real-world config this app expects, but the function must not
    // silently reinterpret an explicit day-15 config as "end of month."
    const [q1] = fiscalQuarters(date(2026, 4, 1), MID_MONTH);
    expect(q1.end).toBe("2026-06-15");
  });
});

describe("todayCalendarDate", () => {
  it("reads year/month/day from the injected Date in local time", () => {
    // month is 0-based on the Date object, 1-based on CalendarDate.
    expect(todayCalendarDate(new Date(2026, 7, 28))).toEqual({
      year: 2026,
      month: 8,
      day: 28,
    });
  });
});
