import Foundation

/// Finds currency amounts in receipt text and converts them to integer
/// cents with pure integer arithmetic - no value ever passes through a
/// floating-point type (the same rule as everywhere else money moves).
enum ReceiptAmount {
    /// Matches money-shaped numbers: an optional dollar sign, digits with
    /// optional thousands separators, then exactly two decimal places.
    /// Requiring the two decimals is deliberate: it is what separates
    /// "45.20" from quantities, SKU codes, and percentages, which receipts
    /// are full of. A negative-lookahead keeps "1.234" from yielding a
    /// false "1.23".
    /// nonisolated(unsafe): Regex is not (yet) Sendable, but the pattern is
    /// immutable and matching does not mutate it.
    private nonisolated(unsafe) static let pattern = #/(?:\$\s*)?(\d{1,3}(?:,\d{3})*|\d+)\.(\d{2})(?!\d)/#

    /// Every amount on a line, in text order, as integer cents.
    static func amounts(in text: String) -> [Int] {
        text.matches(of: pattern).compactMap { match in
            cents(dollars: String(match.1), centsDigits: String(match.2))
        }
    }

    static func largestAmount(in text: String) -> Int? {
        amounts(in: text).max()
    }

    /// Receipts print the money for a labelled line ("HST 13%   5.20") at
    /// the end of the line, so the last amount is the labelled one.
    static func lastAmount(in text: String) -> Int? {
        amounts(in: text).last
    }

    private static func cents(dollars: String, centsDigits: String) -> Int? {
        guard
            let dollarPart = Int(dollars.replacingOccurrences(of: ",", with: "")),
            let centPart = Int(centsDigits)
        else {
            // The regex only admits digits, so a failed Int conversion can
            // only mean an amount too large for Int - drop it rather than
            // suggest a corrupted number.
            return nil
        }
        // Checked arithmetic, not `*`: a 19-digit run Vision misreads off
        // a barcode fits in Int but overflows here, and a trap would crash
        // the app mid-batch (wave-4 reviewer pass). Same rule: drop it.
        let (scaled, multiplyOverflowed) = dollarPart.multipliedReportingOverflow(by: 100)
        guard !multiplyOverflowed else { return nil }
        let (total, addOverflowed) = scaled.addingReportingOverflow(centPart)
        guard !addOverflowed else { return nil }
        return total
    }
}
