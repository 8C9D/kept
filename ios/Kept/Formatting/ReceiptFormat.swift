import Foundation

/// Every user-facing rendering of the API's raw values, in one place
/// (wave-3 kickoff §4: one formatter, one place). Money arrives as integer
/// cents and becomes a string here via Decimal - it never passes through a
/// floating-point type on the way to the screen.
///
/// Rendering uses FormatStyle rather than NSFormatter objects: the values
/// are formatted per row per render pass, and FormatStyle is the
/// allocation-free modern API for exactly that. (Wave-3 reviewer finding:
/// a NumberFormatter built per call is a known list-scrolling cost.)
enum ReceiptFormat {
    /// 11300, "CAD" → "$113.00" (in an en_CA locale). The locale parameter
    /// exists for tests, which pin one; the app always uses the user's.
    static func money(cents: Int, currency: String, locale: Locale = .autoupdatingCurrent) -> String {
        let amount = Decimal(cents) / 100
        return amount.formatted(.currency(code: currency).locale(locale))
    }

    /// "2026-01-14" → "Jan 14, 2026" (in an en_US locale). The receipt date
    /// is a calendar date with no time or zone, so both the parse and the
    /// rendering are pinned to UTC - letting the device's zone in would
    /// show the previous day west of Greenwich.
    static func purchaseDate(_ isoDate: String, locale: Locale = .autoupdatingCurrent) -> String {
        guard let date = isoDateParser.date(from: isoDate) else {
            // The API guarantees yyyy-mm-dd; if that ever breaks, showing
            // the raw value is honest and visible, where "" would hide it.
            return isoDate
        }
        let style = Date.FormatStyle(date: .abbreviated, time: .omitted, locale: locale, timeZone: utc)
        return date.formatted(style)
    }

    /// The confirm screen's date picker needs a Date; these two are the
    /// only place the yyyy-mm-dd string and Date meet, both pinned to UTC.
    /// ⚠ The round trip only holds if the DatePicker between them is ALSO
    /// pinned - via `pickerEnvironment` below - otherwise a Toronto
    /// evening renders March 20 as March 19 and "fixing" it saves the 21st
    /// (wave-4 reviewer pass, the wave's highest finding).
    static func pickerDate(fromIso isoDate: String) -> Date? {
        isoDateParser.date(from: isoDate)
    }

    static func isoDate(fromPicker date: Date) -> String {
        isoDateParser.string(from: date)
    }

    /// The capture day in the person's own calendar - the date they would
    /// write on the receipt, not UTC's opinion of it. Assembled from
    /// explicit components: a format style's output order belongs to the
    /// locale, and this string is API syntax, not display text. (Moved
    /// from CaptureFlowModel in wave 5; the outbox builds the create
    /// request now.)
    static func calendarDate(of date: Date) -> String {
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: date)
        guard let year = parts.year, let month = parts.month, let day = parts.day else {
            // dateComponents with these units always yields them; treat the
            // impossible as impossible rather than inventing a date.
            preconditionFailure("Calendar returned no year/month/day for \(date)")
        }
        return String(format: "%04d-%02d-%02d", year, month, day)
    }

    /// The capture instant as the API's ISO 8601 timestamp.
    static func timestamp(of date: Date) -> String {
        date.formatted(.iso8601)
    }

    /// "Aug 6, 2026 at 3:04 PM" - when a queued receipt was captured, for
    /// the Home outbox rows. The device's own zone on purpose: a capture
    /// is a local moment, unlike `purchasedAt`, which is a zoneless
    /// calendar date and pins UTC above.
    static func captureMoment(_ date: Date, locale: Locale = .autoupdatingCurrent) -> String {
        date.formatted(Date.FormatStyle(date: .abbreviated, time: .shortened, locale: locale))
    }

    /// The calendar and timezone any DatePicker editing `purchasedAt` must
    /// run in, so the picker, the parser, and the formatter agree on which
    /// day an instant belongs to.
    static let utcTimeZone: TimeZone = TimeZone(identifier: "UTC") ?? .gmt

    static let utcCalendar: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = utcTimeZone
        return calendar
    }()

    private static var utc: TimeZone { utcTimeZone }

    /// en_US_POSIX + UTC is the standard recipe for parsing a fixed-format
    /// date: immune to the user's locale, calendar, and zone settings.
    private static let isoDateParser: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = utc
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter
    }()
}
