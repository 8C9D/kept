import Foundation

/// Export-period presets for the iOS export screen (proposal #10,
/// docs/proposals/2026-08-28-ux-enhancements.md, approved 2026-08-28):
/// "Last fiscal year", "This fiscal year to date", and the four quarters of
/// the current fiscal year, all driven by the user's own
/// `fiscalYearEndMonth`/`fiscalYearEndDay` (GET /api/me, §5.1) rather than
/// the calendar year - the proposal names a non-December year end as the
/// one thing to get right, since a preset that assumed Dec 31 would produce
/// a plausible-looking but wrong export for anyone who has set a different
/// one.
///
/// **This is a deliberate, line-for-line port of `web/src/fiscalPresets.ts`
/// (read-only reference)**, kept in exact correspondence on purpose: the
/// brief's own instruction is "keep the two clients consistent," and a
/// date-arithmetic bug here is exactly the kind of thing that looks right
/// until checked against a non-December year end by hand (CLAUDE.md:
/// "predict before verifying"). Every function below mirrors its web
/// counterpart's name, shape and comments; only the language changes.
///
/// Pure and unit-tested on purpose - kept out of ExportView.swift and
/// ExportViewModel.swift entirely so the arithmetic is testable with no
/// SwiftUI, matching `ReceiptArithmetic.swift`'s identical precedent for
/// "domain-ish logic that has to run client-side" (root CLAUDE.md's one
/// deliberate exception, restated there).
///
/// ⚠ This does NOT reimplement `POST /api/export`'s fiscal-period slicing
/// for the request the server actually receives. For a whole fiscal year
/// ("Last fiscal year"), the request this module drives is
/// `{fiscalYearEndingIn}` alone - the server derives both dates itself
/// (server/src/domain/fiscalPeriod.ts), same as the pre-existing "Fiscal
/// year ending in" control. The date range this module computes for that
/// case is a PREVIEW only, shown so a person can see what they are about to
/// ask for before generating anything (proposal #10's own requirement) - if
/// this preview and the server's own arithmetic ever disagreed, the
/// exported zip would still be right, only the preview would be stale,
/// which is why it mirrors `fiscalPeriodEndingIn`'s exact clamp rule
/// (`yearEndDateIn` below) rather than approximating it.
///
/// "This fiscal year to date" and the quarters DO need real arithmetic here
/// - the API has no "current fiscal year" or "quarter" concept at all, only
/// `{periodStart, periodEnd}` (§12: "a quarterly picker would be a UI
/// affordance on the period picker, not an architecture change"), so this
/// module's output for those three presets is not a preview of a
/// server-computed value; it IS the value that gets sent.

/// The two numbers §5.1 calls "config, not an assumption" - mirrors
/// `Profile`'s own two fields (APIModels.swift) so this module has no
/// dependency on that type either.
struct FiscalYearEnd: Equatable {
    let month: Int // 1-12
    let day: Int // 1-31
}

/// A plain calendar date - no `Date` object anywhere in this module below
/// `todayCalendarDate`. Fiscal periods are calendar concepts; `Date` drags
/// in timezones that have no business here (the server's own
/// `calendarDate.ts` makes the identical choice, for the identical reason).
struct CalendarDate: Equatable {
    let year: Int
    let month: Int // 1-12
    let day: Int // 1-31
}

/// An inclusive date range, in the ISO `yyyy-mm-dd` strings both
/// `POST /api/export`'s explicit body and `ReceiptFormat.isoDate` use.
struct DateRange: Equatable {
    let start: String
    let end: String
}

/// The four quarters of one fiscal year, Q1 first - a named struct rather
/// than a tuple (unlike the TS module's 4-tuple) so `ExportView.swift` can
/// address one quarter by name instead of by position.
struct FiscalQuarters: Equatable {
    let q1: DateRange
    let q2: DateRange
    let q3: DateRange
    let q4: DateRange
}

enum FiscalPresets {
    private static func isLeapYear(_ year: Int) -> Bool {
        (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
    }

    private static func daysInMonth(_ year: Int, _ month: Int) -> Int {
        if month == 2 {
            return isLeapYear(year) ? 29 : 28
        }
        return [4, 6, 9, 11].contains(month) ? 30 : 31
    }

    private static func pad2(_ value: Int) -> String {
        value < 10 ? "0\(value)" : "\(value)"
    }

    private static func toIso(_ date: CalendarDate) -> String {
        "\(date.year)-\(pad2(date.month))-\(pad2(date.day))"
    }

    private static func isOnOrBefore(_ a: CalendarDate, _ b: CalendarDate) -> Bool {
        if a.year != b.year { return a.year < b.year }
        if a.month != b.month { return a.month < b.month }
        return a.day <= b.day
    }

    private static func nextDay(_ date: CalendarDate) -> CalendarDate {
        if date.day < daysInMonth(date.year, date.month) {
            return CalendarDate(year: date.year, month: date.month, day: date.day + 1)
        }
        if date.month < 12 {
            return CalendarDate(year: date.year, month: date.month + 1, day: 1)
        }
        return CalendarDate(year: date.year + 1, month: 1, day: 1)
    }

    /// A month/day pair realized in a concrete year, clamping to the last
    /// day that month actually has - the same Feb 29 -> Feb 28 clamp
    /// `fiscalPeriod.ts`'s `fiscalYearEndDateIn` applies to the configured
    /// year end itself, reused here (below) both for the year end and for
    /// each quarter boundary, which is the same kind of "day of month"
    /// value.
    private static func clampedDate(_ year: Int, _ month: Int, _ day: Int) -> CalendarDate {
        CalendarDate(year: year, month: month, day: min(day, daysInMonth(year, month)))
    }

    /// The configured fiscal year end, realized in the given calendar year.
    private static func yearEndDateIn(_ year: Int, _ fye: FiscalYearEnd) -> CalendarDate {
        clampedDate(year, fye.month, fye.day)
    }

    /// Whether the configured year end names the LAST day of its month -
    /// true for every ordinary fiscal year end (Dec 31, Jun 30, Mar 31, Feb
    /// 29 in a leap year) and false only for a genuinely mid-month one.
    /// Checked against both a leap (2024) and non-leap (2023) reference
    /// year, mirroring `isValidFiscalYearEnd`'s own leap-year reference
    /// (fiscalPeriod.ts) - `day: 28` and `day: 29` both read as "last day
    /// of February" here, since either is what a person configuring a Feb
    /// year end almost certainly means.
    ///
    /// Why this matters for quarters, found by the web module's own test:
    /// a June 30 year end's `fye.day` is 30, but naively reusing the
    /// literal number 30 for every quarter boundary makes a quarter ending
    /// in December land on the 30th instead of the 31st - December has 31
    /// days, so a config that plainly means "the end of the month" silently
    /// loses a day the moment the target month is longer than June.
    /// `quarterEndDate` below uses this flag to re-resolve "end of month"
    /// per quarter instead of carrying the literal day number across
    /// months of different lengths.
    private static func isMonthEndConfig(_ fye: FiscalYearEnd) -> Bool {
        fye.day == daysInMonth(2023, fye.month) || fye.day == daysInMonth(2024, fye.month)
    }

    /// `month` shifted by `delta` (positive or negative), rolling the
    /// calendar year over as needed - e.g. month 2 (Feb) shifted by -3
    /// lands on month 11 (Nov) of the PREVIOUS year. Used to walk backward
    /// from the fiscal year end to each quarter's own end month.
    private static func shiftMonth(_ year: Int, _ month: Int, _ delta: Int) -> (year: Int, month: Int) {
        let zeroBased = month - 1 + delta
        let shiftedYear = year + floorDiv(zeroBased, 12)
        let shiftedMonth = ((zeroBased % 12) + 12) % 12 + 1
        return (shiftedYear, shiftedMonth)
    }

    /// Floor division (unlike Swift's `/`, which truncates toward zero) -
    /// matches JavaScript's `Math.floor(a / b)` for the negative deltas
    /// `shiftMonth` above needs. `b` is always 12 here.
    private static func floorDiv(_ a: Int, _ b: Int) -> Int {
        let quotient = a / b
        let remainder = a % b
        return (remainder != 0 && (remainder < 0) != (b < 0)) ? quotient - 1 : quotient
    }

    /// Which calendar year a fiscal year ENDS in, for the fiscal year
    /// containing `today` - mirrors the server's own `fiscalPeriodContaining`
    /// (fiscalPeriod.ts): only the end bound needs checking, since any date
    /// on or before that year's end date is necessarily on or after its
    /// start.
    static func currentFiscalYearEndYear(today: CalendarDate, fiscalYearEnd fye: FiscalYearEnd) -> Int {
        let endThisCalendarYear = yearEndDateIn(today.year, fye)
        return isOnOrBefore(today, endThisCalendarYear) ? today.year : today.year + 1
    }

    /// The full fiscal year ending in `endYear`, as a date range - the
    /// PREVIEW this module's own doc comment describes:
    /// `{fiscalYearEndingIn: endYear}` is what actually gets sent for "Last
    /// fiscal year", and the server computes this identical range itself.
    static func fiscalYearRange(endingIn endYear: Int, fiscalYearEnd fye: FiscalYearEnd) -> DateRange {
        DateRange(
            start: toIso(nextDay(yearEndDateIn(endYear - 1, fye))),
            end: toIso(yearEndDateIn(endYear, fye))
        )
    }

    /// "Last fiscal year" - the fiscal year immediately before the one
    /// containing `today`. Returns both the year to send as
    /// `{fiscalYearEndingIn}` and the range to show as its preview, so a
    /// caller never has to re-derive `endYear` from the range or vice
    /// versa.
    static func lastFiscalYear(
        today: CalendarDate,
        fiscalYearEnd fye: FiscalYearEnd
    ) -> (endYear: Int, range: DateRange) {
        let endYear = currentFiscalYearEndYear(today: today, fiscalYearEnd: fye) - 1
        return (endYear, fiscalYearRange(endingIn: endYear, fiscalYearEnd: fye))
    }

    /// "This fiscal year to date" - from the start of the fiscal year
    /// containing `today` through `today` itself. Always an explicit
    /// range: unlike the whole-year presets, the end date is "today", not
    /// the configured year end, so there is no `{fiscalYearEndingIn}`
    /// request that could express it - the server has nothing to derive
    /// this from.
    static func fiscalYearToDate(today: CalendarDate, fiscalYearEnd fye: FiscalYearEnd) -> DateRange {
        let endYear = currentFiscalYearEndYear(today: today, fiscalYearEnd: fye)
        return DateRange(
            start: toIso(nextDay(yearEndDateIn(endYear - 1, fye))),
            end: toIso(today)
        )
    }

    /// The four quarters of the fiscal year containing `today`, Q1 first.
    /// Always explicit ranges (§12: the API has no quarter concept). Each
    /// quarter's end is computed the same way the fiscal year end itself
    /// is - the configured DAY of month, realized in the quarter's own end
    /// month, clamped to that month's real length - which is what keeps a
    /// non-last-day year end (were one ever configured) internally
    /// consistent across all four quarters rather than only at the year
    /// boundary. Contiguous by construction: each quarter's start is
    /// `nextDay` of the previous quarter's end, so Q1's start is exactly
    /// the fiscal year's own start and Q4's end is exactly the fiscal
    /// year's own end (`fiscalYearRange`'s `end`), never independently
    /// computed and liable to drift from it.
    static func fiscalQuarters(today: CalendarDate, fiscalYearEnd fye: FiscalYearEnd) -> FiscalQuarters {
        let endYear = currentFiscalYearEndYear(today: today, fiscalYearEnd: fye)
        let yearStart = nextDay(yearEndDateIn(endYear - 1, fye))
        let yearEnd = yearEndDateIn(endYear, fye)

        let q1End = quarterEndDate(endingIn: endYear, fiscalYearEnd: fye, monthsBeforeYearEnd: 9)
        let q2End = quarterEndDate(endingIn: endYear, fiscalYearEnd: fye, monthsBeforeYearEnd: 6)
        let q3End = quarterEndDate(endingIn: endYear, fiscalYearEnd: fye, monthsBeforeYearEnd: 3)
        let q4End = yearEnd

        return FiscalQuarters(
            q1: DateRange(start: toIso(yearStart), end: toIso(q1End)),
            q2: DateRange(start: toIso(nextDay(q1End)), end: toIso(q2End)),
            q3: DateRange(start: toIso(nextDay(q2End)), end: toIso(q3End)),
            q4: DateRange(start: toIso(nextDay(q3End)), end: toIso(q4End))
        )
    }

    /// The quarter-end date `monthsBeforeYearEnd` months before the fiscal
    /// year end in `endYear` - e.g. 9 months before a June 30 year end is
    /// the previous September 30 (Q1's end for that fiscal year). For a
    /// month-end year end (`isMonthEndConfig`, the ordinary case), each
    /// quarter re-lands on the end of ITS OWN month rather than carrying
    /// the year end's literal day number across months of different
    /// lengths (that function's own comment has the bug this avoids). A
    /// genuinely mid-month year end has no equivalent "end of month" to
    /// re-resolve to, so it keeps the literal day, clamped the same way
    /// the year end itself is.
    private static func quarterEndDate(
        endingIn endYear: Int,
        fiscalYearEnd fye: FiscalYearEnd,
        monthsBeforeYearEnd: Int
    ) -> CalendarDate {
        let shifted = shiftMonth(endYear, fye.month, -monthsBeforeYearEnd)
        let day = isMonthEndConfig(fye) ? daysInMonth(shifted.year, shifted.month) : fye.day
        return clampedDate(shifted.year, shifted.month, day)
    }

    /// `now` as a `CalendarDate`, in the device's own local time - matches
    /// `ReceiptFormat.calendarDate(of:)`'s identical choice for the
    /// identical reason: "today" for someone opening the export screen
    /// means their own local calendar date, not a UTC one that could
    /// already be tomorrow or still be yesterday depending where they are.
    /// The one place in this module that touches the `Date`/`Calendar`
    /// types at all.
    ///
    /// Takes `now` rather than reading the clock itself - `ExportView.swift`
    /// passes `Date()` once per screen appearance, and a test passes a
    /// fixed date instead, so this function itself never needs a
    /// fake-clock setup to pin.
    static func todayCalendarDate(now: Date) -> CalendarDate {
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: now)
        guard let year = parts.year, let month = parts.month, let day = parts.day else {
            // dateComponents with these units always yields them; treat
            // the impossible as impossible rather than inventing a date.
            preconditionFailure("Calendar returned no year/month/day for \(now)")
        }
        return CalendarDate(year: year, month: month, day: day)
    }
}
