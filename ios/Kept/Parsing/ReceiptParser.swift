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
            tipCents: tip(in: lines),
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

    /// The GST/HST program amount - the input tax credit field, where a
    /// wrong-but-plausible suggestion is more dangerous than a missing
    /// one: an absence demands attention, a 0.00 gets ticked past.
    ///
    /// Labels are ranked, never lumped (wave-5 device step 1: a receipt
    /// printing "GST $0.00" above "HST $2.05" put the GST zero into this
    /// field under the old any-of-HST|GST|TAX first match):
    ///
    ///   non-zero HST > non-zero GST > non-zero TAX >
    ///   zero HST     > zero GST     > zero TAX
    ///
    /// HST outranks GST because it is the more specific label and the
    /// harmonized amount already contains the federal part - a receipt
    /// printing both non-zero is charging the tax twice, and preferring
    /// the HST row leaves the arithmetic warning to surface that. A GST
    /// row still suggests into this field when it is the only tax printed
    /// (a non-harmonized province): GST and HST are one CRA program,
    /// claimed on the same return line. Every zero is demoted below every
    /// non-zero because an explicit 0.00 beside a non-zero sibling label
    /// means the tax was charged under the sibling program - the wave-5
    /// receipt exactly, and its GST-province mirror - while a receipt
    /// whose every tax row is zero genuinely charged none, and suggesting
    /// that zero is honest. Within one tier, the topmost row wins.
    private static func hst(in lines: [RecognizedLine]) -> Int? {
        let candidates = lines.filter { !isSubtotalLine($0.text) }

        // Split HST (2026-08-28 product feedback): checked first, and
        // narrowly guarded to fall through to the ranking below whenever
        // its shape is anything but the one it was built for - see the
        // function's own comment for why.
        if let split = splitOrCombinedHst(in: candidates) {
            return split
        }

        func amount(labelled label: String, allowZero: Bool, excludingTotalLines: Bool) -> Int? {
            for line in candidates {
                guard containsWord(label, in: line.text) else { continue }
                if excludingTotalLines && containsWord("total", in: line.text) { continue }
                guard let amount = ReceiptAmount.lastAmount(in: line.text) else { continue }
                if amount == 0 && !allowZero { continue }
                return amount
            }
            return nil
        }

        for allowZero in [false, true] {
            if let hst = amount(labelled: "hst", allowZero: allowZero, excludingTotalLines: false) {
                return hst
            }
            if let gst = amount(labelled: "gst", allowZero: allowZero, excludingTotalLines: false) {
                return gst
            }
            // A bare "tax" also appears in phrases like "total before
            // tax", so tax-labelled lines that mention a total are
            // skipped - unchanged from wave 4.
            if let tax = amount(labelled: "tax", allowZero: allowZero, excludingTotalLines: true) {
                return tax
            }
        }
        return nil
    }

    /// the owner's first-use product feedback (2026-08-28): some receipts
    /// print a harmonized tax as two provincial-rate lines rather than
    /// one combined line ("HST 8%" and "HST 5%" separately, 13% total),
    /// and the ranking above - by design, per its own comment - picks
    /// whichever one sorts highest and silently drops the other, which is
    /// exactly the ranking doing its job on a receipt shape it was never
    /// built for.
    ///
    /// This is a narrow, guarded case laid on TOP of the ranking, not a
    /// replacement for it - the wave-5 device failure the ranking exists
    /// to prevent (a labelled zero shadowing a real amount) is still live
    /// on every receipt with one tax row or with rows that don't carry
    /// their own percentage. So: gather every non-zero HST/GST/TAX-tier
    /// row (the same pool the ranking draws from, zeros and subtotal/total
    /// lines excluded exactly as above). Fewer than two rows is exactly
    /// today's shape - return nil and let the ranking decide it unchanged.
    /// Two or more only resolve here when EVERY row carries its own,
    /// pairwise-distinct percentage marker ("13%", "8%", "5%") - that is
    /// the only signal that can tell a genuine split apart from two
    /// unrelated tax lines, and without it, guessing would trade a
    /// visible absence for a wrong-but-plausible amount reaching an
    /// accountant, which is the one thing the ranking was written to
    /// avoid. Given that signal: if one row's rate equals the sum of the
    /// others' (a GST 5% / TAX 8% / HST 13% receipt, the 13% line already
    /// combined), that row IS the whole tax and wins outright - summing
    /// all three would double-count the province's share. Otherwise every
    /// row is its own slice of one harmonized tax and they sum (the owner's
    /// receipt: 8% + 5% = 13%, never printed combined).
    private static func splitOrCombinedHst(in candidates: [RecognizedLine]) -> Int? {
        let nonZeroRows: [(amount: Int, text: String)] = candidates.compactMap { line in
            let isTaxLabelled = containsWord("hst", in: line.text)
                || containsWord("gst", in: line.text)
                || (containsWord("tax", in: line.text) && !containsWord("total", in: line.text))
            guard
                isTaxLabelled,
                let amount = ReceiptAmount.lastAmount(in: line.text),
                amount != 0
            else { return nil }
            return (amount, line.text)
        }
        guard nonZeroRows.count >= 2 else { return nil }

        let percentages = nonZeroRows.map { percentage(in: $0.text) }
        guard percentages.allSatisfy({ $0 != nil }) else { return nil }
        let rates = percentages.map { $0! }
        guard Set(rates).count == rates.count else { return nil }

        for index in rates.indices {
            let othersSum = rates.indices
                .filter { $0 != index }
                .reduce(0.0) { $0 + rates[$1] }
            if abs(rates[index] - othersSum) < 0.01 {
                return nonZeroRows[index].amount
            }
        }
        return nonZeroRows.reduce(0) { $0 + $1.amount }
    }

    // MARK: - Subtotal

    /// The bottom-most subtotal-labelled row. Audited alongside the HST
    /// fix for first-match-among-several-candidates: a long receipt can
    /// print section subtotals above its summary block, and the summary
    /// subtotal - the one the arithmetic check compares - prints last,
    /// beside the taxes and total. A single-subtotal receipt, the common
    /// case, is unaffected. No real receipt has exercised the
    /// multi-subtotal case yet; the accuracy table arbitrates this guess.
    private static func subtotal(in lines: [RecognizedLine]) -> Int? {
        guard let line = lines.last(where: { isSubtotalLine($0.text) }) else {
            return nil
        }
        return ReceiptAmount.lastAmount(in: line.text)
    }

    // MARK: - Tip

    /// A row labelled TIP or GRATUITY (2026-08-28 product feedback): a
    /// human-entered amount on most receipts, so a heuristic guess here
    /// saves the same keystroke subtotal and HST do - and is exactly as
    /// replaceable, since every value this parser produces is only a
    /// suggestion a human confirms (spec §3). Same family as subtotal's
    /// heuristic: last amount on the labelled row, excluding a line that
    /// mentions a total (uniform with every other labelled-amount rule
    /// here, even though "total tip" is not phrasing real paper uses).
    private static func tip(in lines: [RecognizedLine]) -> Int? {
        let candidates = lines.filter { !isSubtotalLine($0.text) }
        for line in candidates {
            guard containsWord("tip", in: line.text) || containsWord("gratuity", in: line.text) else {
                continue
            }
            if containsWord("total", in: line.text) { continue }
            guard let amount = ReceiptAmount.lastAmount(in: line.text) else { continue }
            return amount
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

    /// The fixed list every label pattern below is compiled from - the
    /// one place a new labelled-amount word joins the parser (the tip
    /// heuristic added "tip" and "gratuity" here, 2026-08-28, rather than
    /// hand-rolling a parallel matcher).
    private static let labelWords = ["total", "hst", "gst", "tax", "tip", "gratuity"]

    /// Case-insensitive whole-word patterns, compiled once: "total"
    /// matches "TOTAL:" but not "totally" or "subtotal"; "tax" matches
    /// "Tax 13%" but not "taxable". Compiled per word rather than per call
    /// because the parser runs these over every line of every scan.
    /// nonisolated(unsafe) on the cached patterns in this file: Regex is
    /// not (yet) marked Sendable, but these are immutable after
    /// initialization and matching does not mutate the value.
    private nonisolated(unsafe) static let wordPatterns: [String: Regex<Substring>] = {
        var patterns: [String: Regex<Substring>] = [:]
        for word in labelWords {
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
    private nonisolated(unsafe) static let despacedWordPatterns: [String: Regex<AnyRegexOutput>] = {
        var patterns: [String: Regex<AnyRegexOutput>] = [:]
        for word in labelWords {
            if let pattern = try? Regex("(?:^|[^A-Za-z])\(word)(?![A-Za-z])").ignoresCase() {
                patterns[word] = pattern
            }
        }
        return patterns
    }()

    /// A percentage token on a tax-labelled line ("13%", "8.5 %") - the
    /// signal `splitOrCombinedHst` uses to tell a genuine multi-line
    /// harmonized tax apart from unrelated tax rows. Not part of
    /// `labelWords`: this matches a number-and-percent shape, not a word.
    /// nonisolated(unsafe) for the same reason as the patterns above.
    private nonisolated(unsafe) static let percentagePattern = #/(\d+(?:\.\d+)?)\s?%/#

    private static func percentage(in text: String) -> Double? {
        guard let match = text.firstMatch(of: percentagePattern) else { return nil }
        return Double(match.1)
    }

    private static func containsWord(_ word: String, in text: String) -> Bool {
        guard
            let pattern = wordPatterns[word],
            let despacedPattern = despacedWordPatterns[word]
        else {
            // Every caller passes one of the words in labelWords; asking
            // for another is a programmer error, surfaced in debug builds
            // and degraded to "not found" in a capture path.
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
