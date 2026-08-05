import {
  type CalendarDate,
  daysInMonth,
  isOnOrBefore,
  isValidCalendarDate,
  nextDay,
} from "./calendarDate.js";

/**
 * Fiscal year end is per-user config, not an assumption (spec §5.1). Storage
 * only ever records purchased_at; the fiscal period is derived at query time
 * from these two numbers, so a changed year end re-runs an export instead of
 * triggering a migration.
 */
export interface FiscalYearEnd {
  month: number; // 1-12
  day: number; // 1-31, must exist in the month (Feb 29 is allowed; see below)
}

/**
 * Feb 29 is a valid configured year end: in non-leap years the period ends
 * on Feb 28 instead. Validity is therefore checked against a leap year.
 */
export function isValidFiscalYearEnd(fye: FiscalYearEnd): boolean {
  return isValidCalendarDate({ year: 2024, month: fye.month, day: fye.day });
}

export interface FiscalPeriod {
  start: CalendarDate; // inclusive
  end: CalendarDate; // inclusive
}

export class InvalidFiscalYearEndError extends Error {
  constructor(fye: FiscalYearEnd) {
    super(`Not a valid fiscal year end: month ${fye.month}, day ${fye.day}`);
    this.name = "InvalidFiscalYearEndError";
  }
}

/**
 * The fiscal period that ends in the given calendar year.
 *
 * With a Dec 31 year end, the period ending in 2026 is
 * 2026-01-01 .. 2026-12-31; with a Mar 31 year end it is
 * 2025-04-01 .. 2026-03-31.
 */
export function fiscalPeriodEndingIn(
  endYear: number,
  fye: FiscalYearEnd,
): FiscalPeriod {
  if (!isValidFiscalYearEnd(fye)) {
    throw new InvalidFiscalYearEndError(fye);
  }
  return {
    start: nextDay(fiscalYearEndDateIn(endYear - 1, fye)),
    end: fiscalYearEndDateIn(endYear, fye),
  };
}

/**
 * The fiscal period containing the given date.
 *
 * Only the end bound needs checking: the period ending in the date's year
 * starts in the previous year (or on Jan 1 with a Dec 31 year end), so any
 * date on or before that period's end is necessarily also on or after its
 * start.
 */
export function fiscalPeriodContaining(
  date: CalendarDate,
  fye: FiscalYearEnd,
): FiscalPeriod {
  const periodEndingThisYear = fiscalPeriodEndingIn(date.year, fye);
  if (isOnOrBefore(date, periodEndingThisYear.end)) {
    return periodEndingThisYear;
  }
  // E.g. May 2026 with a Mar 31 year end: after this year's end date, so it
  // belongs to the period ending next year.
  return fiscalPeriodEndingIn(date.year + 1, fye);
}

/**
 * The configured year end, realized in a concrete year. A Feb 29 year end
 * clamps to Feb 28 in non-leap years.
 */
function fiscalYearEndDateIn(year: number, fye: FiscalYearEnd): CalendarDate {
  const day = Math.min(fye.day, daysInMonth(year, fye.month));
  return { year, month: fye.month, day };
}
