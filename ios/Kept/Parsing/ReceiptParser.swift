import Foundation

/// The §7.3 heuristics: recognized text lines in, field suggestions out.
///
/// Deliberately heuristic and deliberately humble (spec §3, design note on
/// constraint 2): this parser will be wrong sometimes, and that is fine by
/// design, because every value it produces is only a suggestion a human
/// reads before anything saves. It lives in a pure module - no VisionKit,
/// no UIKit - so all of it is testable against fixture text on the
/// simulator; the camera plumbing that feeds it stays thin (spec §10.2).
///
/// Wave 4 measures each heuristic's accuracy on real receipts
/// (`npm run parse-accuracy`); that number, not taste, decides whether a
/// heuristic is rewritten or a cloud parser is added later.
enum ReceiptParser {
    static func parse(lines unorderedLines: [RecognizedLine]) -> ReceiptSuggestions {
        // Reassemble printed rows first: a thermal receipt's "Subtotal"
        // and its amount arrive as separate fragments, and every heuristic
        // below matches label and amount within one string. Sorting and
        // assembly happen here as well as in the plumbing, so neither
        // depends on the caller remembering (assembly is stable on
        // already-assembled rows).
        let lines = ReceiptRowAssembler.assembleRows(unorderedLines)

        return ReceiptSuggestions(
            totalCents: total(in: lines),
            hstCents: hst(in: lines),
            subtotalCents: subtotal(in: lines),
            vendorTaxNumber: vendorTaxNumber(in: lines),
            purchasedAt: purchaseDate(in: lines),
            vendor: vendor(in: lines)
        )
    }

    // MARK: - Total

    /// The largest amount on a line containing "total" (but not a subtotal
    /// line); when no such line exists, the largest amount in the lower
    /// third of the receipt, where totals live.
    private static func total(in lines: [RecognizedLine]) -> Int? {
        let totalLineAmounts = lines
            .filter { containsWord("total", in: $0.text) && !isSubtotalLine($0.text) }
            .compactMap { ReceiptAmount.largestAmount(in: $0.text) }
        if let largest = totalLineAmounts.max() {
            return largest
        }
        return lines
            .filter { $0.verticalCenter > 2.0 / 3.0 }
            .compactMap { ReceiptAmount.largestAmount(in: $0.text) }
            .max()
    }

    // MARK: - HST

    /// The amount on the first line naming the tax. "HST"/"GST" outrank a
    /// bare "TAX", which also appears in phrases like "total before tax" -
    /// so tax-labelled lines that mention a total are skipped.
    private static func hst(in lines: [RecognizedLine]) -> Int? {
        let candidates = lines.filter { !isSubtotalLine($0.text) }
        if let hstLine = candidates.first(where: { line in
            (containsWord("hst", in: line.text) || containsWord("gst", in: line.text))
                && ReceiptAmount.lastAmount(in: line.text) != nil
        }) {
            return ReceiptAmount.lastAmount(in: hstLine.text)
        }
        if let taxLine = candidates.first(where: { line in
            containsWord("tax", in: line.text)
                && !containsWord("total", in: line.text)
                && ReceiptAmount.lastAmount(in: line.text) != nil
        }) {
            return ReceiptAmount.lastAmount(in: taxLine.text)
        }
        return nil
    }

    // MARK: - Subtotal

    private static func subtotal(in lines: [RecognizedLine]) -> Int? {
        guard let line = lines.first(where: { isSubtotalLine($0.text) }) else {
            return nil
        }
        return ReceiptAmount.lastAmount(in: line.text)
    }

    // MARK: - Vendor tax number

    /// A Canadian business number with its GST/HST program identifier:
    /// nine digits, "RT", four digits, spaces optional. Falls back to a
    /// bare nine-digit number on a line that labels itself GST/HST/BN.
    private static let businessNumberPattern = #/(\d{9})\s?[Rr][Tt]\s?(\d{4})/#
    private static let bareNineDigitsPattern = #/(?:^|\D)(\d{9})(?:\D|$)/#

    private static func vendorTaxNumber(in lines: [RecognizedLine]) -> String? {
        for line in lines {
            if let match = line.text.firstMatch(of: businessNumberPattern) {
                return "\(match.1)RT\(match.2)"
            }
        }
        for line in lines
        where containsWord("gst", in: line.text)
            || containsWord("hst", in: line.text)
            || containsWord("bn", in: line.text) {
            if let match = line.text.firstMatch(of: bareNineDigitsPattern) {
                return String(match.1)
            }
        }
        return nil
    }

    // MARK: - Date

    /// The first parseable date, preferring the top third of the receipt,
    /// where the header prints it.
    private static func purchaseDate(in lines: [RecognizedLine]) -> String? {
        let dated = lines.compactMap { line in
            ReceiptDateParser.firstDate(in: line.text).map { (line: line, date: $0) }
        }
        if let topThird = dated.first(where: { $0.line.verticalCenter < 1.0 / 3.0 }) {
            return topThird.date
        }
        return dated.first?.date
    }

    // MARK: - Vendor

    /// §7.3's "largest-font text block in the top quarter", made robust to
    /// measurement jitter: on a thermal receipt every header line is the
    /// same print size, and Vision's box heights vary a few percent per
    /// scan - the wave-4 re-test measured the address 5% taller than the
    /// store name on one photo and the reverse on another, flipping the
    /// suggested vendor between scans. So near-tallest is a band, not a
    /// single winner: among letter-bearing lines within 15% of the tallest,
    /// take the topmost, because the name prints above the address. A line
    /// genuinely larger than the band (a real logo-sized name) still wins
    /// outright wherever it sits in the quarter.
    private static func vendor(in lines: [RecognizedLine]) -> String? {
        let candidates = lines.filter { line in
            line.verticalCenter < 0.25
                && line.text.contains(where: \.isLetter)
        }
        guard let tallestHeight = candidates.map(\.height).max() else { return nil }
        let winner = candidates
            .filter { $0.height >= 0.85 * tallestHeight }
            .min { $0.verticalCenter < $1.verticalCenter }
        guard let winner else { return nil }
        let trimmed = winner.text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    // MARK: - Shared text tests

    /// Case-insensitive whole-word patterns, compiled once: "total"
    /// matches "TOTAL:" but not "totally" or "subtotal"; "tax" matches
    /// "Tax 13%" but not "taxable". Compiled per word rather than per call
    /// because the parser runs these over every line of every scan.
    private static let wordPatterns: [String: Regex<Substring>] = {
        var patterns: [String: Regex<Substring>] = [:]
        for word in ["total", "hst", "gst", "tax", "bn"] {
            // The words are literal constants, so compilation cannot fail;
            // try! here would still be a crash in a capture path, and a
            // missing entry already degrades to "not found" below.
            if let pattern = try? Regex<Substring>("\\b\(word)\\b").ignoresCase() {
                patterns[word] = pattern
            }
        }
        return patterns
    }()

    /// The same words fenced by LETTERS rather than \b, for matching text
    /// whose spaces were removed: despacing glues the label to its amount
    /// ("Total15.25"), and a digit is a word character, so \b would never
    /// fire there. Letters still fence - "TOTALSAVINGS" (from "TOTAL
    /// SAVINGS") does not read as a bare total. Consumed-prefix instead of
    /// lookbehind, same as ReceiptDateParser and for the same reason.
    private static let despacedWordPatterns: [String: Regex<AnyRegexOutput>] = {
        var patterns: [String: Regex<AnyRegexOutput>] = [:]
        for word in ["total", "hst", "gst", "tax", "bn"] {
            if let pattern = try? Regex("(?:^|[^A-Za-z])\(word)(?![A-Za-z])").ignoresCase() {
                patterns[word] = pattern
            }
        }
        return patterns
    }()

    private static func containsWord(_ word: String, in text: String) -> Bool {
        guard
            let pattern = wordPatterns[word],
            let despacedPattern = despacedWordPatterns[word]
        else {
            // Every caller passes one of the five words above; asking for
            // another is a programmer error, surfaced in debug builds and
            // degraded to "not found" in a capture path.
            assertionFailure("No compiled pattern for word: \(word)")
            return false
        }
        // Matched against the text as printed AND with spaces removed:
        // Vision sometimes splits a label mid-word ("Tot al 15.25" on the
        // wave-4 re-test receipt), which no within-word match can see.
        // The raw match still governs deliberate spacing - "SUB TOTAL"
        // stays a subtotal via the exclusion below, and "TOTAL SAVINGS"
        // stays a total line - while the despaced match ("Total15.25")
        // recovers the split ones.
        return text.contains(pattern) || despaced(text).contains(despacedPattern)
    }

    private static func isSubtotalLine(_ text: String) -> Bool {
        // The \s? in the pattern covers "SUB TOTAL"; the despaced check
        // covers a Vision mid-word split like "Subto tal".
        let pattern = #"sub[\s-]?total"#
        return text.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
            || despaced(text).range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
    }

    private static func despaced(_ text: String) -> String {
        text.replacingOccurrences(of: " ", with: "")
    }
}
