import { describe, expect, it } from "vitest";
import {
  InvalidDateError,
  isValidCalendarDate,
  parseIsoDate,
} from "../../src/domain/calendarDate.js";

describe("the calendar's first year", () => {
  it("has no year zero: Postgres refuses it, so this must", () => {
    expect(() => parseIsoDate("0000-01-01")).toThrow(InvalidDateError);
    expect(() => parseIsoDate("0000-02-29")).toThrow(InvalidDateError);
    expect(isValidCalendarDate({ year: 0, month: 1, day: 1 })).toBe(false);
  });

  it("starts at AD 1, which Postgres stores", () => {
    expect(parseIsoDate("0001-01-01")).toEqual({ year: 1, month: 1, day: 1 });
  });

  it("still takes an ordinary date and still refuses an impossible one", () => {
    expect(parseIsoDate("2026-02-28")).toEqual({
      year: 2026,
      month: 2,
      day: 28,
    });
    expect(() => parseIsoDate("2026-02-30")).toThrow(InvalidDateError);
  });
});
