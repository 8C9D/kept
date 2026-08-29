import XCTest
@testable import Kept

/// `resolvePreset` (Export/ExportView.swift) - the thin mapping from one of
/// proposal #10's six presets to what `POST /api/export` actually receives.
/// `FiscalPresetsTests.swift` already pins the underlying date arithmetic;
/// these cases pin the OTHER thing that could go wrong: "Last fiscal year"
/// must go out as `{fiscalYearEndingIn}` (letting the server derive its own
/// dates, §4.1a/§5.1), while the other five have no such request shape and
/// must go out as the exact `{periodStart, periodEnd}` this module computed
/// - a preset silently sent as the wrong ExportRequest case would still
/// "work" (the server would just derive a different period than the one
/// shown), which is exactly the kind of mismatch a plain date-range
/// assertion would not catch.
final class ExportPresetResolutionTests: XCTestCase {
    private let december31 = FiscalYearEnd(month: 12, day: 31)
    private let june30 = FiscalYearEnd(month: 6, day: 30)
    private let today = CalendarDate(year: 2026, month: 8, day: 28)

    func testLastFiscalYearSendsFiscalYearEndingInAndLetsTheServerDeriveTheDates() {
        let resolved = resolvePreset(.lastFiscalYear, today: today, fiscalYearEnd: december31)

        XCTAssertEqual(resolved.request, .fiscalYear(endingIn: 2025))
        // The shown range still matches what the server would compute for
        // that year - a preview, not what is sent.
        XCTAssertEqual(resolved.range, DateRange(start: "2025-01-01", end: "2025-12-31"))
    }

    func testLastFiscalYearUnderAJune30YearEnd() {
        let resolved = resolvePreset(.lastFiscalYear, today: today, fiscalYearEnd: june30)

        XCTAssertEqual(resolved.request, .fiscalYear(endingIn: 2026))
        XCTAssertEqual(resolved.range, DateRange(start: "2025-07-01", end: "2026-06-30"))
    }

    func testYearToDateSendsAnExplicitRangeNeverFiscalYearEndingIn() {
        let resolved = resolvePreset(.yearToDate, today: today, fiscalYearEnd: december31)

        XCTAssertEqual(resolved.request, .range(periodStart: "2026-01-01", periodEnd: "2026-08-28"))
    }

    func testEachQuarterSendsItsOwnExplicitRangeUnderADecemberYearEnd() {
        XCTAssertEqual(
            resolvePreset(.q1, today: today, fiscalYearEnd: december31).request,
            .range(periodStart: "2026-01-01", periodEnd: "2026-03-31")
        )
        XCTAssertEqual(
            resolvePreset(.q2, today: today, fiscalYearEnd: december31).request,
            .range(periodStart: "2026-04-01", periodEnd: "2026-06-30")
        )
        XCTAssertEqual(
            resolvePreset(.q3, today: today, fiscalYearEnd: december31).request,
            .range(periodStart: "2026-07-01", periodEnd: "2026-09-30")
        )
        XCTAssertEqual(
            resolvePreset(.q4, today: today, fiscalYearEnd: december31).request,
            .range(periodStart: "2026-10-01", periodEnd: "2026-12-31")
        )
    }

    /// The trap the brief names by name: a quarter ending in a 31-day
    /// month, under a year end that is NOT the last month of the calendar
    /// year. Q2 of the fiscal year ending June 30, 2027 ends December 31,
    /// 2026 - not the 30th a naive "reuse the year end's day number"
    /// implementation would produce (FiscalPresetsTests carries the same
    /// case at the arithmetic layer; this pins it at the request-mapping
    /// layer too, since a right range sent as the wrong ExportRequest case
    /// would still silently fail this exact scenario).
    func testQ2EndingInDecemberUnderAJune30YearEndLandsOnThe31stNotThe30th() {
        let resolved = resolvePreset(.q2, today: today, fiscalYearEnd: june30)

        XCTAssertEqual(resolved.request, .range(periodStart: "2026-10-01", periodEnd: "2026-12-31"))
    }
}
