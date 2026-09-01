import Foundation

/// Finds the date-shaped things in receipt text and turns them into the
/// API's yyyy-mm-dd strings. Parsing is done with regexes and an explicit
/// calendar-validity check rather than DateFormatter: a formatter would
/// invent a time and a timezone (the wave-3 lesson), and its lenient modes
/// are exactly how "13/45/2026" becomes a real date.
///
/// **Rewritten 2026-09-01, from "the first hit wins" to "read every token,
/// then score".** The old rule took the first regex match on the first
/// line that had one, and it was wrong on 25 of the 130 live receipts. The
/// three shapes it lost to, all quoted off real paper in the restore:
///
/// - `DateTime: 26/07/19 10:41:03` - the Canadian card-slip form, printed
///   by Food Basics, No Frills, Dollarama, Shoppers, KORYO and Tone Tai.
///   The old `shortYear` pattern read the LAST group as the year, so this
///   became 2019-07-26; the unambiguous `07/19/2026 10:41 AM` printed 8
///   lines lower was never reached. 23 of the 25 wrong suggestions in
///   production are this one shape.
/// - `Sweepstakes ends 12/31/26.` (Five Guys) and `TIMED ORDER 7/17/20`
///   (Domino's) - a date on the paper that is not the purchase date, taken
///   because it printed first.
/// - `09/05/2026` on a MUJI slip captured 2026-08-30 - read month-first as
///   5 September, a date AFTER the capture, which nothing rejected.
///
/// So: every token on every line yields every reading it could honestly
/// have, and the readings are scored against the capture date. The
/// capture-day fallback when nothing survives stays the CALLER's job
/// (ConfirmReceiptModel says out loud when it is showing one).
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

    /// yyyy-mm-dd, yyyy/mm/dd, yyyy.mm.dd - including the
    /// `2026-05-27 19:47:17` form, whose time the date match simply stops
    /// before.
    private nonisolated(unsafe) static let yearFirst = #/(?:^|\D)(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})(?!\d)/#
    /// dd/mm/yyyy or mm/dd/yyyy - both readings are emitted (2026-09-01);
    /// MUJI prints the day first and every North American POS the month.
    private nonisolated(unsafe) static let yearLast = #/(?:^|\D)(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2})(?!\d)/#
    /// Two-digit year, assumed 20xx. All THREE readings are emitted
    /// (2026-09-01): yy/mm/dd is the card-slip form this parser used to
    /// misread as dd/mm/yy, and both of the others are printed by real
    /// receipts too.
    private nonisolated(unsafe) static let shortYear = #/(?:^|\D)(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})(?!\d)/#
    /// "Jan 14, 2026" / "January 14 2026" / "May 09 2026"
    private nonisolated(unsafe) static let monthNameFirst = #/([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(20\d{2})(?!\d)/#
    /// "14 Jan 2026", and (2026-09-01) the hyphenated forms real paper
    /// prints: "03-Feb.-2026", "31-Jul.-2026", "09-May-2026".
    private nonisolated(unsafe) static let dayFirst = #/(?:^|[^\dA-Za-z])(\d{1,2})[\s-]+([A-Za-z]{3,9})\.?[\s,-]+(20\d{2})(?!\d)/#

    /// A clock time on the same line as a date - weak corroboration that
    /// the line is a transaction stamp rather than prose (2026-09-01).
    private nonisolated(unsafe) static let timeOfDay = #/(?:^|\D)([01]?\d|2[0-3]):[0-5]\d(?!\d)/#

    /// Words that mean "this date is not when the purchase happened": a
    /// contest deadline, a return window, a scheduled order time. All
    /// quoted off real receipts in the 2026-09-01 restore except
    /// `warranty`, which is the same family and costs nothing to name.
    private static let decoyWords = [
        "sweepstake", "contest", "expire", "valid", "until",
        "timed order", "return by", "warranty",
    ]

    /// One calendar date some token on the receipt could be saying.
    struct Reading: Equatable {
        let iso: String
        /// The token this came from had exactly one valid calendar reading
        /// - `2026-07-19`, `Jul 28, 2026`, or `07/19/2026` (19 cannot be a
        /// month). Scored higher than a token that could honestly mean more
        /// than one day.
        let isUnambiguous: Bool
    }

    /// Every valid reading of every date-shaped token in one line, in the
    /// order the tokens print.
    static func readings(in text: String) -> [Reading] {
        var found: [(offset: Int, readings: [String])] = []

        func collect<Output>(_ pattern: Regex<Output>, _ dates: (Regex<Output>.Match) -> [String?]) {
            for match in text.matches(of: pattern) {
                let valid = dates(match).compactMap { $0 }
                guard !valid.isEmpty else { continue }
                found.append((text.distance(from: text.startIndex, to: match.range.lowerBound), valid))
            }
        }

        collect(yearFirst) { [isoString(year: Int($0.1), month: Int($0.2), day: Int($0.3))] }
        collect(monthNameFirst) { match in
            guard let month = monthNumber(String(match.1)) else { return [] }
            return [isoString(year: Int(match.3), month: month, day: Int(match.2))]
        }
        collect(dayFirst) { match in
            guard let month = monthNumber(String(match.2)) else { return [] }
            return [isoString(year: Int(match.3), month: month, day: Int(match.1))]
        }
        collect(yearLast) { match in
            let year = Int(match.3)
            return [
                isoString(year: year, month: Int(match.1), day: Int(match.2)),
                isoString(year: year, month: Int(match.2), day: Int(match.1)),
            ]
        }
        collect(shortYear) { match in
            // Month-first leads so `firstDate(in:)` keeps its documented
            // North-American tiebreak; the scorer below does not care about
            // the order within a token, only how many readings it had.
            guard let first = Int(match.1), let second = Int(match.2), let third = Int(match.3) else {
                return []
            }
            return [
                isoString(year: 2000 + third, month: first, day: second),
                isoString(year: 2000 + third, month: second, day: first),
                isoString(year: 2000 + first, month: second, day: third),
            ]
        }

        // Deduplicate within a token (a palindromic date like 05/05/26
        // reads the same three ways) before deciding whether it was
        // ambiguous, so an identical repeat is not counted as a second
        // possible meaning.
        return found
            .sorted { $0.offset < $1.offset }
            .flatMap { entry -> [Reading] in
                var seen: [String] = []
                for iso in entry.readings where !seen.contains(iso) {
                    seen.append(iso)
                }
                return seen.map { Reading(iso: $0, isUnambiguous: seen.count == 1) }
            }
    }

    /// The first valid date in one line - the pre-2026-09-01 entry point,
    /// kept for callers (and tests) that ask a single line what it says.
    /// The receipt-wide question is `bestDate(inLines:capturedAt:)` below,
    /// which is what the parser uses.
    static func firstDate(in text: String) -> String? {
        readings(in: text).first?.iso
    }

    /// The purchase date, chosen across the whole receipt (2026-09-01).
    ///
    /// A reading AFTER the capture date is discarded outright: a receipt is
    /// photographed after it is printed, and that one fact rules out the
    /// MUJI slip's month-first reading and every sweepstakes deadline in
    /// the restore. There is deliberately no lower bound (2026-09-01,
    /// second pass): a backlog of emailed receipts going back to 2022 was
    /// imported the same day, and a 2022 receipt scanned in 2026 is an
    /// ordinary thing to do - the date is on the paper and discarding it
    /// would replace a right answer with the capture day. Age is a
    /// penalty, not a veto. What survives is scored:
    ///
    /// - **+3** a token with exactly one valid reading, **+1** one with
    ///   more than one - a date that could honestly mean two days is
    ///   weaker evidence than one that could not;
    /// - **+2** when another line on the receipt reads the same calendar
    ///   day - the Food Basics card slip prints `26/07/19` and
    ///   `07/19/2026`, and their agreement is the strongest signal on the
    ///   page;
    /// - **+1** when a clock time sits on the same line - transaction
    ///   stamps carry one, prose does not;
    /// - **−3** for a decoy word on the line (`sweepstakes`, `expires`,
    ///   `timed order`…) - the date is on the paper but is not the
    ///   purchase;
    /// - **−1** per whole year between the reading and the capture day -
    ///   which is what still sinks `26/07/19` read as 2019 on the Food
    ///   Basics slip without ruling out a genuinely old receipt scanned
    ///   from a backlog.
    ///
    /// Ties go to the earlier line, where the header prints.
    static func bestDate(inLines lines: [String], capturedAt: Date) -> String? {
        let captureDay = calendarDay(of: capturedAt)

        struct Candidate {
            let iso: String
            let lineIndex: Int
            var score: Int
        }

        var candidates: [Candidate] = []
        for (index, text) in lines.enumerated() {
            let lowered = text.lowercased()
            let isDecoy = decoyWords.contains { lowered.contains($0) }
            let hasTime = text.firstMatch(of: timeOfDay) != nil
            var seenOnThisLine: Set<String> = []
            for reading in readings(in: text) {
                guard reading.iso <= captureDay else { continue }
                guard seenOnThisLine.insert(reading.iso).inserted else { continue }
                var score = reading.isUnambiguous ? 3 : 1
                if hasTime { score += 1 }
                if isDecoy { score -= 3 }
                score -= yearsBetween(reading.iso, and: captureDay)
                candidates.append(Candidate(iso: reading.iso, lineIndex: index, score: score))
            }
        }

        // Corroboration: the same calendar day read off a DIFFERENT line.
        let linesPerDate = Dictionary(grouping: candidates, by: \.iso)
            .mapValues { Set($0.map(\.lineIndex)).count }
        for index in candidates.indices where (linesPerDate[candidates[index].iso] ?? 0) > 1 {
            candidates[index].score += 2
        }

        return candidates
            .enumerated()
            .max { left, right in
                if left.element.score != right.element.score {
                    return left.element.score < right.element.score
                }
                if left.element.lineIndex != right.element.lineIndex {
                    // Earlier line wins the tie, so `max` must treat the
                    // LATER line as the smaller element.
                    return left.element.lineIndex > right.element.lineIndex
                }
                return left.offset > right.offset
            }?
            .element.iso
    }

    // MARK: - Calendar arithmetic

    /// The capture day in the person's own calendar, exactly the day
    /// `ReceiptFormat.calendarDate(of:)` would write on the receipt - not
    /// UTC's opinion of it. Computed here rather than borrowed so this
    /// module stays what §10.2 asks of it: pure, Foundation-only, with no
    /// dependency on the formatting layer.
    private static func calendarDay(of date: Date) -> String {
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: date)
        guard let year = parts.year, let month = parts.month, let day = parts.day else {
            // Unreachable - dateComponents with these units always yields
            // them - and surfaced in debug rather than swallowed. The
            // empty string degrades to "every reading is after the capture
            // day", so the parser suggests no date at all and the confirm
            // screen falls back to the capture day and says so. The other
            // direction (a far-future capture day) would accept every
            // reading on the receipt, which is the wrong way to be wrong.
            assertionFailure("Calendar returned no year/month/day for \(date)")
            return ""
        }
        return String(format: "%04d-%02d-%02d", year, month, day)
    }

    /// Whole years between two yyyy-mm-dd strings, by year component and a
    /// month/day comparison - integer arithmetic on the strings themselves,
    /// no Date round trip, and no floating point.
    private static func yearsBetween(_ iso: String, and captureDay: String) -> Int {
        guard iso.count >= 10, captureDay.count >= 10,
              let readingYear = Int(iso.prefix(4)), let captureYear = Int(captureDay.prefix(4))
        else { return 0 }
        var years = captureYear - readingYear
        if iso.suffix(5) > captureDay.suffix(5) {
            // The anniversary has not come round yet this year.
            years -= 1
        }
        return max(0, years)
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
