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

    /// The decimal point OCR lost (2026-09-01). Food Basics prints
    /// `TOTAL 9-86` on the restore's `5eaa79c9` - the hyphen is Vision's
    /// reading of the point, and the strict pattern above sees no amount at
    /// all, which is how a $9.86 receipt suggested $3.25 (the savings line)
    /// instead. `Sub Total 4,58` (Al-Premium `f39f48b3`) and a plain space
    /// are the same damage.
    ///
    /// Deliberately narrow, because these separators are everywhere on a
    /// receipt: it is anchored to the END of the line, so `Store #1234
    /// (555) 555-0100` cannot reach it; a number immediately before it
    /// disqualifies it, which is what keeps `TVR: 00 00 00 80 01` from
    /// reading as $80.01; and the parser only ever asks for it on a
    /// LABELLED line whose strict reading came up empty.
    private nonisolated(unsafe) static let damagedDecimal = #/(?:^|[^\d.,-])(\d{1,7})[-, ](\d{2})[\s.]*$/#

    /// Characters allowed to trail the amount that ENDS a labelled line -
    /// a percent sign (`HST ONT 13% Soda TA 1.04%`) and sentence
    /// punctuation, nothing else. See `trailingAmountOutsideParentheses`.
    private static let permittedTrailing = Set(" \t%*.,;:")

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

    // MARK: - Labelled lines (2026-09-01)

    /// The amounts on a line the parser has already decided carries a
    /// label - strict readings when there are any, and otherwise the one
    /// OCR-damaged decimal at the end of the line.
    ///
    /// ⚠ A bare integer is deliberately NOT an amount here, even though the
    /// brief for this change proposed admitting one when no other amount on
    /// the receipt carries cents. The restore has exactly one receipt where
    /// that guard would have fired - Burger King `d15d1492`, which prints
    /// `Sub Total $7`, `Sales Tax $1` and `Order Total $9` and whose real
    /// values are $7.99, $1.04 and $9.03. The cents were clipped by OCR,
    /// not absent from the paper, so admitting the integers would have
    /// produced three wrong-but-plausible amounts on the one receipt the
    /// rule could reach. An absence demands attention; a round number
    /// beside a total gets ticked past (the same argument the HST ranking
    /// is built on).
    static func labelledAmounts(in text: String) -> [Int] {
        let strict = amounts(in: text)
        if !strict.isEmpty { return strict }
        guard let match = text.firstMatch(of: damagedDecimal) else { return [] }
        // Not when another number sits immediately before it: a run of
        // digit groups is an EMV field, not money. `TVR: 00 00 00 80 01`
        // prints on most card slips in the restore and would otherwise
        // read as $80.01.
        let before = text[..<match.1.startIndex].trimmingCharacters(in: .whitespaces)
        guard before.last?.isNumber != true else { return [] }
        return [cents(dollars: String(match.1), centsDigits: String(match.2))].compactMap { $0 }
    }

    static func largestLabelledAmount(in text: String) -> Int? {
        labelledAmounts(in: text).max()
    }

    static func lastLabelledAmount(in text: String) -> Int? {
        labelledAmounts(in: text).last
    }

    /// The tax heuristic's reading of a line: the last amount that is
    /// **outside any parentheses** and that **ends the line**.
    ///
    /// Both halves are load-bearing, and both come off real paper in the
    /// 2026-09-01 restore:
    ///
    /// - `HST (on 9.99)` (Dave's Hot Chicken `6e3856d7`) - the parenthesised
    ///   number is the base the tax was computed ON, and reading it put
    ///   $9.99 into the input tax credit field of a receipt whose HST was
    ///   $1.30. `HST (En 18.99) 2.47` is the same line with the real amount
    ///   printed after it, and that one must still read 2.47.
    /// - `… HST 863624433 DOLLARAMA • St Unit 112-3 … 1.25 H 1.25 H` - one
    ///   merged header row on Dollarama `0e21a062`, where the trailing `H`
    ///   tax flag means the last amount is an ITEM price, not the tax. The
    ///   ends-the-line rule refuses the whole row; the registration number
    ///   in it needs no separate exclusion (and a blanket one would have
    ///   thrown away `Tax HST #887605228: 13% 7.72` and
    ///   `HST (776246365RT0001) $2.01`, both of which are correct).
    static func trailingAmountOutsideParentheses(in text: String) -> Int? {
        var depth = 0
        var lastOutside: (range: Range<String.Index>, value: Int)?
        var index = text.startIndex
        let matches = text.matches(of: pattern)
        var matchIterator = matches.makeIterator()
        var nextMatch = matchIterator.next()

        while index < text.endIndex {
            if let match = nextMatch, match.range.lowerBound == index {
                if depth == 0, let value = cents(dollars: String(match.1), centsDigits: String(match.2)) {
                    lastOutside = (match.range, value)
                }
                index = match.range.upperBound
                nextMatch = matchIterator.next()
                continue
            }
            switch text[index] {
            case "(", "[": depth += 1
            case ")", "]": depth = max(0, depth - 1)
            default: break
            }
            index = text.index(after: index)
        }

        guard let lastOutside else { return nil }
        let trailing = text[lastOutside.range.upperBound...]
        guard trailing.allSatisfy({ permittedTrailing.contains($0) }) else { return nil }
        return lastOutside.value
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
