import XCTest
@testable import Kept

/// `FiscalPresets.swift` is a line-for-line port of `web/src/
/// fiscalPresets.ts`; these cases are the identical port of that module's
/// own test suite (`web/tests/fiscalPresets.test.ts`, read-only reference),
/// kept in exact correspondence on purpose so the two clients cannot drift.
/// Every expected value below was predicted by hand against the fiscal
/// year end before running the test (CLAUDE.md: "predict before
/// verifying") - the comments state the prediction, not just the answer.
final class FiscalPresetsTests: XCTestCase {
    private let december31 = FiscalYearEnd(month: 12, day: 31)
    /// Proposal #10's own named risk: "a preset that computes the wrong
    /// boundary is the one thing to test, against a non-December fiscal
    /// year end." A business or small business with a June 30 year end is a
    /// completely ordinary configuration, not a contrived edge case.
    private let june30 = FiscalYearEnd(month: 6, day: 30)

    private func date(_ year: Int, _ month: Int, _ day: Int) -> CalendarDate {
        CalendarDate(year: year, month: month, day: day)
    }

    // MARK: - currentFiscalYearEndYear

    func testDecemberYearEndTodaysFiscalYearEndsThisCalendarYear() {
        XCTAssertEqual(
            FiscalPresets.currentFiscalYearEndYear(today: date(2026, 8, 28), fiscalYearEnd: december31),
            2026
        )
    }

    func testDecemberYearEndIsInclusiveOfTheYearEndDateItself() {
        XCTAssertEqual(
            FiscalPresets.currentFiscalYearEndYear(today: date(2026, 12, 31), fiscalYearEnd: december31),
            2026
        )
    }

    func testDecemberYearEndRollsToNextYearTheDayAfter() {
        XCTAssertEqual(
            FiscalPresets.currentFiscalYearEndYear(today: date(2027, 1, 1), fiscalYearEnd: december31),
            2027
        )
    }

    func testJune30YearEndADateAfterJuneRollsIntoNextYearsFiscalYear() {
        // Predicted before writing: 2026-08-28 is past this calendar
        // year's June 30 end, so it belongs to the fiscal year ending
        // June 30, 2027.
        XCTAssertEqual(
            FiscalPresets.currentFiscalYearEndYear(today: date(2026, 8, 28), fiscalYearEnd: june30),
            2027
        )
    }

    func testJune30YearEndADateBeforeJulyStaysInThisCalendarYearsFiscalYear() {
        XCTAssertEqual(
            FiscalPresets.currentFiscalYearEndYear(today: date(2027, 2, 15), fiscalYearEnd: june30),
            2027
        )
    }

    func testJune30YearEndIsInclusiveOfTheNonDecemberYearEndDateToo() {
        XCTAssertEqual(
            FiscalPresets.currentFiscalYearEndYear(today: date(2026, 6, 30), fiscalYearEnd: june30),
            2026
        )
    }

    func testJune30YearEndRollsOverTheDayAfter() {
        XCTAssertEqual(
            FiscalPresets.currentFiscalYearEndYear(today: date(2026, 7, 1), fiscalYearEnd: june30),
            2027
        )
    }

    // MARK: - fiscalYearRange (the whole-fiscal-year preview)

    func testFiscalYearRangeIsTheCalendarYearForADecemberYearEnd() {
        XCTAssertEqual(
            FiscalPresets.fiscalYearRange(endingIn: 2026, fiscalYearEnd: december31),
            DateRange(start: "2026-01-01", end: "2026-12-31")
        )
    }

    func testFiscalYearRangeSpansTwoCalendarYearsForAJune30YearEnd() {
        // Predicted: the fiscal year ending in 2027 runs July 1, 2026
        // through June 30, 2027 - the same shape spec §5.1's own Mar 31
        // example uses.
        XCTAssertEqual(
            FiscalPresets.fiscalYearRange(endingIn: 2027, fiscalYearEnd: june30),
            DateRange(start: "2026-07-01", end: "2027-06-30")
        )
    }

    // MARK: - lastFiscalYear

    func testDecemberLastFiscalYearIsThePreviousCalendarYear() {
        let result = FiscalPresets.lastFiscalYear(today: date(2026, 8, 28), fiscalYearEnd: december31)
        XCTAssertEqual(result.endYear, 2025)
        XCTAssertEqual(result.range, DateRange(start: "2025-01-01", end: "2025-12-31"))
    }

    func testJune30LastFiscalYearIsJulyToJuneOneYearBack() {
        // Predicted: today (2026-08-28) is in the fiscal year ending
        // June 30, 2027, so "last fiscal year" is the one ending
        // June 30, 2026 - July 1, 2025 through June 30, 2026.
        let result = FiscalPresets.lastFiscalYear(today: date(2026, 8, 28), fiscalYearEnd: june30)
        XCTAssertEqual(result.endYear, 2026)
        XCTAssertEqual(result.range, DateRange(start: "2025-07-01", end: "2026-06-30"))
    }

    // MARK: - fiscalYearToDate

    func testDecemberYearToDateIsFromJanuary1ThroughToday() {
        XCTAssertEqual(
            FiscalPresets.fiscalYearToDate(today: date(2026, 8, 28), fiscalYearEnd: december31),
            DateRange(start: "2026-01-01", end: "2026-08-28")
        )
    }

    func testJune30YearToDateIsFromTheFiscalYearsOwnJuly1StartThroughToday() {
        // Predicted: today (2027-02-15) sits inside the fiscal year that
        // started July 1, 2026.
        XCTAssertEqual(
            FiscalPresets.fiscalYearToDate(today: date(2027, 2, 15), fiscalYearEnd: june30),
            DateRange(start: "2026-07-01", end: "2027-02-15")
        )
    }

    func testOnTheYearEndDateItselfYearToDateStillBelongsToTheFiscalYearThatJustClosed() {
        // Predicted: June 30, 2026 is the LAST day of the fiscal year
        // ending 2026 (the inclusive-boundary test above), so "this fiscal
        // year to date" spans the whole year, July 1, 2025 through
        // June 30, 2026 - not a one-day range.
        XCTAssertEqual(
            FiscalPresets.fiscalYearToDate(today: date(2026, 6, 30), fiscalYearEnd: june30),
            DateRange(start: "2025-07-01", end: "2026-06-30")
        )
    }

    // MARK: - fiscalQuarters (always explicit ranges - the API has no quarter concept, §12)

    func testDecemberYearEndCalendarQuarters() {
        // Predicted before writing: an ordinary Jan-Mar / Apr-Jun / Jul-Sep
        // / Oct-Dec split.
        let quarters = FiscalPresets.fiscalQuarters(today: date(2026, 8, 28), fiscalYearEnd: december31)
        XCTAssertEqual(quarters.q1, DateRange(start: "2026-01-01", end: "2026-03-31"))
        XCTAssertEqual(quarters.q2, DateRange(start: "2026-04-01", end: "2026-06-30"))
        XCTAssertEqual(quarters.q3, DateRange(start: "2026-07-01", end: "2026-09-30"))
        XCTAssertEqual(quarters.q4, DateRange(start: "2026-10-01", end: "2026-12-31"))
    }

    func testJune30YearEndQuartersShiftedBySixMonths() {
        // Predicted before writing, by hand: fiscal year ending
        // June 30, 2027 runs July 2026 - June 2027. Q1 Jul-Sep 2026,
        // Q2 Oct-Dec 2026, Q3 Jan-Mar 2027, Q4 Apr-Jun 2027. A
        // calendar-quarter implementation would instead produce Jan-Mar as
        // "Q1", which is this fiscal year's Q3 - silently wrong in exactly
        // the way the proposal warns about.
        let quarters = FiscalPresets.fiscalQuarters(today: date(2027, 2, 15), fiscalYearEnd: june30)
        XCTAssertEqual(quarters.q1, DateRange(start: "2026-07-01", end: "2026-09-30"))
        XCTAssertEqual(quarters.q2, DateRange(start: "2026-10-01", end: "2026-12-31"))
        XCTAssertEqual(quarters.q3, DateRange(start: "2027-01-01", end: "2027-03-31"))
        XCTAssertEqual(quarters.q4, DateRange(start: "2027-04-01", end: "2027-06-30"))
    }

    func testQuartersAreContiguousAndSpanExactlyTheFiscalYear() {
        let quarters = FiscalPresets.fiscalQuarters(today: date(2026, 8, 28), fiscalYearEnd: june30)
        let year = FiscalPresets.fiscalYearRange(endingIn: 2027, fiscalYearEnd: june30)
        XCTAssertEqual(quarters.q1.start, year.start)
        XCTAssertEqual(quarters.q4.end, year.end)
        // Each quarter starts the day after the previous one ends - written
        // as exact strings rather than a date-math helper, so a
        // contiguity bug cannot hide behind the same helper this test
        // would otherwise reuse.
        XCTAssertEqual(quarters.q1.end, "2026-09-30")
        XCTAssertEqual(quarters.q2.start, "2026-10-01")
        XCTAssertEqual(quarters.q2.end, "2026-12-31")
        XCTAssertEqual(quarters.q3.start, "2027-01-01")
    }

    /// ⚠ The trap the brief names explicitly: a naive "reuse fye.day for
    /// every quarter" implementation puts Q2's end on December 30th
    /// instead of the 31st, silently dropping the last day of every export
    /// that used it - June has 30 days, December has 31. June 30 is a
    /// month-end config, so every quarter must land on the actual last day
    /// of ITS OWN month, not the number 30.
    func testDoesNotCarryTheYearEndsLiteralDayNumberAcrossALongerMonth() {
        let quarters = FiscalPresets.fiscalQuarters(today: date(2026, 8, 28), fiscalYearEnd: june30)
        XCTAssertEqual(quarters.q2.end, "2026-12-31")
        XCTAssertNotEqual(quarters.q2.end, "2026-12-30")
    }

    func testAFeb29YearEndReResolvesEachQuarterToThatMonthsOwnLastDayLeapOrNot() {
        let feb29 = FiscalYearEnd(month: 2, day: 29)
        // Fiscal year ending Feb 29, 2028 (2028 is a leap year): starts
        // March 1, 2027. Q1 ends May 31, 2027; Q2 ends Aug 31, 2027; Q3
        // ends Nov 30, 2027; Q4 ends Feb 29, 2028 - each the real last day
        // of its month, never a clamped-down 28 or a carried-over 29 in a
        // 30-day month.
        let quarters = FiscalPresets.fiscalQuarters(today: date(2027, 6, 1), fiscalYearEnd: feb29)
        XCTAssertEqual(quarters.q1, DateRange(start: "2027-03-01", end: "2027-05-31"))
        XCTAssertEqual(quarters.q2, DateRange(start: "2027-06-01", end: "2027-08-31"))
        XCTAssertEqual(quarters.q3, DateRange(start: "2027-09-01", end: "2027-11-30"))
        XCTAssertEqual(quarters.q4, DateRange(start: "2027-12-01", end: "2028-02-29"))
    }

    func testAMidMonthYearEndKeepsItsLiteralDayRatherThanSnappingToMonthEnd() {
        let midMonth = FiscalYearEnd(month: 3, day: 15)
        // Not a real-world config this app expects, but the function must
        // not silently reinterpret an explicit day-15 config as "end of
        // month."
        let quarters = FiscalPresets.fiscalQuarters(today: date(2026, 4, 1), fiscalYearEnd: midMonth)
        XCTAssertEqual(quarters.q1.end, "2026-06-15")
    }

    // MARK: - todayCalendarDate

    func testTodayCalendarDateReadsYearMonthDayFromTheInjectedDateInLocalTime() throws {
        var components = DateComponents()
        components.year = 2026
        components.month = 8
        components.day = 28
        components.hour = 12
        let date = try XCTUnwrap(Calendar.current.date(from: components))

        XCTAssertEqual(FiscalPresets.todayCalendarDate(now: date), CalendarDate(year: 2026, month: 8, day: 28))
    }
}
