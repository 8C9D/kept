import Foundation

/// Finds the first date-shaped thing in a line of receipt text and returns
/// it as the API's yyyy-mm-dd string. Parsing is done with regexes and an
/// explicit calendar-validity check rather than DateFormatter: a formatter
/// would invent a time and a timezone (the wave-3 lesson), and its lenient
/// modes are exactly how "13/45/2026" becomes a real date.
enum ReceiptDateParser {
    /// Every numeric pattern is fenced on both sides - a consumed non-digit
    /// (or start/end of text) - so a match can never start or stop in the
    /// middle of a longer number. Without the fences, "2026-02-30" (an
    /// invalid date) partially matched as "26-02-30" and yielded a
    /// fabricated 2030 date. Swift's regex engine has no lookbehind, hence
    /// the consumed prefix group rather than `(?<!\d)`.

    // nonisolated(unsafe) on the cached patterns here and below: Regex is
    // not (yet) marked Sendable, but these are immutable after
    // initialization and matching does not mutate the value, so sharing
    // them across tasks is safe. (Strict concurrency, wave 5.)

    /// yyyy-mm-dd, yyyy/mm/dd, yyyy.mm.dd
    private nonisolated(unsafe) static let yearFirst = #/(?:^|\D)(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/#
    /// dd/mm/yyyy or mm/dd/yyyy - disambiguated below.
    private nonisolated(unsafe) static let yearLast = #/(?:^|\D)(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2})(?!\d)/#
    /// mm/dd/yy (two-digit year, assumed 20xx; receipts do print these).
    private nonisolated(unsafe) static let shortYear = #/(?:^|\D)(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})(?!\d)/#
    /// "Jan 14, 2026" / "January 14 2026"
    private nonisolated(unsafe) static let monthNameFirst = #/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(20\d{2})(?!\d)/#
    /// "14 Jan 2026"
    private nonisolated(unsafe) static let dayFirst = #/(?:^|\D)(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(20\d{2})(?!\d)/#

    /// The first valid date found in the text, or nil.
    static func firstDate(in text: String) -> String? {
        if let match = text.firstMatch(of: yearFirst),
           let date = isoString(year: Int(match.1), month: Int(match.2), day: Int(match.3)) {
            return date
        }
        if let match = text.firstMatch(of: yearLast),
           let date = fromAmbiguousPair(first: Int(match.1), second: Int(match.2), year: Int(match.3)) {
            return date
        }
        if let match = text.firstMatch(of: monthNameFirst),
           let month = monthNumber(String(match.1)),
           let date = isoString(year: Int(match.3), month: month, day: Int(match.2)) {
            return date
        }
        if let match = text.firstMatch(of: dayFirst),
           let month = monthNumber(String(match.2)),
           let date = isoString(year: Int(match.3), month: month, day: Int(match.1)) {
            return date
        }
        if let match = text.firstMatch(of: shortYear),
           let twoDigitYear = Int(match.3),
           let date = fromAmbiguousPair(first: Int(match.1), second: Int(match.2), year: 2000 + twoDigitYear) {
            return date
        }
        return nil
    }

    /// "01/14/2026" versus "14/01/2026": genuinely ambiguous when both
    /// numbers could be a month. The tiebreak assumes month-first, the
    /// common POS print order in Canada and the US; when the first number
    /// cannot be a month, day-first is the only reading. A judgment call
    /// the wave-4 accuracy measurement exists to falsify.
    private static func fromAmbiguousPair(first: Int?, second: Int?, year: Int?) -> String? {
        guard let first, let second else { return nil }
        if let monthFirst = isoString(year: year, month: first, day: second) {
            return monthFirst
        }
        return isoString(year: year, month: second, day: first)
    }

    /// Builds yyyy-mm-dd only when the combination is a real calendar day;
    /// "2026-02-30" returns nil rather than a plausible-looking lie.
    private static func isoString(year: Int?, month: Int?, day: Int?) -> String? {
        guard let year, let month, let day else { return nil }
        guard (1...12).contains(month), day >= 1, day <= daysIn(month: month, year: year) else {
            return nil
        }
        let paddedMonth = String(format: "%02d", month)
        let paddedDay = String(format: "%02d", day)
        return "\(year)-\(paddedMonth)-\(paddedDay)"
    }

    private static func daysIn(month: Int, year: Int) -> Int {
        switch month {
        case 1, 3, 5, 7, 8, 10, 12: return 31
        case 4, 6, 9, 11: return 30
        case 2: return isLeapYear(year) ? 29 : 28
        default: return 0
        }
    }

    private static func isLeapYear(_ year: Int) -> Bool {
        (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
    }

    /// "Jan", "January", "SEPT" → month number. A prefix match against the
    /// English month names; receipts abbreviate unpredictably.
    private static func monthNumber(_ name: String) -> Int? {
        let lowered = name.lowercased()
        let months = [
            "january", "february", "march", "april", "may", "june",
            "july", "august", "september", "october", "november", "december",
        ]
        // Require at least three letters so "ma" cannot mean anything;
        // "sept" matches september by prefix.
        guard lowered.count >= 3 else { return nil }
        for (index, month) in months.enumerated() where month.hasPrefix(lowered) || lowered.hasPrefix(month) {
            return index + 1
        }
        return nil
    }
}
