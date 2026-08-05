/**
 * Plain calendar-date arithmetic on { year, month, day }, deliberately
 * avoiding the Date object: fiscal periods are calendar concepts, and Date
 * drags in timezones that have no business here.
 */
export interface CalendarDate {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
}

export function daysInMonth(year: number, month: number): number {
  // A nonexistent month has no days; callers checking "day <= daysInMonth"
  // then reject every day of it.
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return 0;
  }
  const lengths = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month === 2 && isLeapYear(year)) {
    return 29;
  }
  return lengths[month - 1];
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function isValidCalendarDate(date: CalendarDate): boolean {
  return (
    Number.isInteger(date.year) &&
    Number.isInteger(date.month) &&
    Number.isInteger(date.day) &&
    date.month >= 1 &&
    date.month <= 12 &&
    date.day >= 1 &&
    date.day <= daysInMonth(date.year, date.month)
  );
}

export function nextDay(date: CalendarDate): CalendarDate {
  if (date.day < daysInMonth(date.year, date.month)) {
    return { ...date, day: date.day + 1 };
  }
  if (date.month < 12) {
    return { year: date.year, month: date.month + 1, day: 1 };
  }
  return { year: date.year + 1, month: 1, day: 1 };
}

/** Format as ISO yyyy-mm-dd, the shape Postgres date columns use. */
export function toIsoDate(date: CalendarDate): string {
  const mm = String(date.month).padStart(2, "0");
  const dd = String(date.day).padStart(2, "0");
  return `${date.year}-${mm}-${dd}`;
}

export class InvalidDateError extends Error {
  constructor(value: string) {
    super(`Not a valid calendar date: ${value}`);
    this.name = "InvalidDateError";
  }
}

export function parseIsoDate(value: string): CalendarDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) {
    throw new InvalidDateError(value);
  }
  const date = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
  if (!isValidCalendarDate(date)) {
    throw new InvalidDateError(value);
  }
  return date;
}

/** True when a is on or before b in calendar order. */
export function isOnOrBefore(a: CalendarDate, b: CalendarDate): boolean {
  if (a.year !== b.year) return a.year < b.year;
  if (a.month !== b.month) return a.month < b.month;
  return a.day <= b.day;
}
