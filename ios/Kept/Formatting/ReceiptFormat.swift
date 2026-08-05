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

    private static let utc = TimeZone(identifier: "UTC") ?? .gmt

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
