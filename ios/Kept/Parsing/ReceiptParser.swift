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
/// **Reworked 2026-09-01 against the 130 live receipts** in the read-only
/// restore of production, one heuristic at a time, with the accuracy on
/// those 130 - not taste - deciding each rule (spec §7.3's own arbitration
/// clause). Every rule below that changed cites the receipt that changed
/// it. What this parser is FOR has not moved: it runs with no network, in
/// a store with no signal, and everything it produces is a suggestion.
enum ReceiptParser {
    /// - Parameters:
    ///   - capturedAt: when the photograph was taken. The date heuristic
    ///     scores every reading against it - a receipt is photographed
    ///     after it is printed, and 23 of the 25 wrong dates in production
    ///     were readings this one fact rules out. The capture-DAY fallback
    ///     when no reading survives stays the caller's (the confirm screen
    ///     says out loud when it is showing one).
    ///   - knownVendors: the person's own past vendor names
    ///     (`ReceiptOptionsStore.options.vendors`, cached on disk, so this
    ///     works offline). Passed in rather than fetched: the parser stays
    ///     pure and simulator-testable (§10.2).
    static func parse(
        lines unorderedLines: [RecognizedLine],
        capturedAt: Date,
        knownVendors: [String] = []
    ) -> ReceiptSuggestions {
        // Reassemble printed rows first: a thermal receipt's "Subtotal"
        // and its amount arrive as separate fragments, and every heuristic
        // below matches label and amount within one string.
        //
        // To a fixed point, and so genuinely a no-op on already-assembled
        // input (2026-09-01 - the comment here used to CLAIM that of a
        // single pass, which was false; ReceiptRowAssembler
        // .assembledToFixedPoint carries the receipt that proved it). The
        // plumbing now assembles to the same fixed point before it computes
        // the stored raw text, so the text the server's LLM re-parses is
        // the text this parser read. Kept here as well as there so a caller
        // handing over raw fragments still parses correctly.
        let lines = ReceiptRowAssembler.assembledToFixedPoint(unorderedLines)
        let subtotal = subtotal(in: lines)

        return ReceiptSuggestions(
            totalCents: total(in: lines),
            hstCents: hst(in: lines, subtotalCents: subtotal),
            subtotalCents: subtotal,
            tipCents: tip(in: lines),
            otherFeesCents: otherFees(in: lines),
            paymentMethod: paymentMethod(in: lines),
            purchasedAt: ReceiptDateParser.bestDate(inLines: lines.map(\.text), capturedAt: capturedAt),
            vendor: vendor(in: lines, knownVendors: knownVendors)
        )
    }

    // MARK: - Total

    /// Three tiers, tried in order (2026-09-01).
    ///
    /// 1. **A line that says "total" and is not saying something else.**
    ///    "Total" is the most over-printed word on a receipt: the restore
    ///    has `Total of your savings 3.25`, `TOTAL DISCOUNT(S) $ 8.50`,
    ///    `Total number of items sold = 2`, `Total Tax: $1.17`, `TOTAL …
    ///    POINTS`, `Balance Due`, `Change Due`, `Amount Tendered`. The old
    ///    largest-amount-on-any-total-line rule confirmed a $218.94 Costco
    ///    purchase at $8.50 off the discount line - the one materially
    ///    wrong amount in production - and read a $9.86 grocery bill as
    ///    $3.25. So the word alone no longer qualifies a line.
    /// 2. **A card slip's own AMOUNT / PURCHASE / PAYMENT line.** Five Guys
    ///    prints `Payment $39.17` and no total at all; Pho House prints
    ///    `AMOUNT CAD $20.33 / TIP CAD $2.64 / TOTAL CAD $22.97` (tier 1
    ///    still wins there, correctly, because the tax-inclusive AMOUNT is
    ///    not the total).
    /// 3. **The lower third**, where totals live - now minus the lines that
    ///    are never a total.
    private static func total(in lines: [RecognizedLine]) -> Int? {
        let candidates = lines.filter { !isDisqualifiedAsTotal($0.text) }

        let labelled = candidates
            .filter { containsWord("total", in: $0.text) && !isSubtotalLine($0.text) }
            .compactMap { ReceiptAmount.largestLabelledAmount(in: $0.text) }
        if let largest = labelled.max() {
            return largest
        }

        let cardSlip = candidates
            .filter { line in
                !isSubtotalLine(line.text)
                    && ["amount", "purchase", "payment"].contains { containsWord($0, in: line.text) }
            }
            .compactMap { ReceiptAmount.largestLabelledAmount(in: $0.text) }
        if let largest = cardSlip.max() {
            return largest
        }

        return candidates
            .filter { $0.verticalCenter > 2.0 / 3.0 && !isSubtotalLine($0.text) }
            .compactMap { ReceiptAmount.largestAmount(in: $0.text) }
            .max()
    }

    /// The words that mean a "total"-bearing line is totalling something
    /// other than this purchase. Matched as prefixes, not whole words, so
    /// "SAVINGS", "ITEMS", "DISCOUNT(S)", "POINTS" and "Tendered" are all
    /// caught by one entry each.
    ///
    /// `due` is the exception with an exception: `Balance Due` and `Change
    /// Due` are not the total, but `TOTAL DUE` and `Amount Due` are exactly
    /// it - so `due` disqualifies a line only when nothing else on it says
    /// this is the total or the amount.
    private static func isDisqualifiedAsTotal(_ text: String) -> Bool {
        let lowered = text.lowercased()
        let prefixes = ["saving", "discount", "point", "item", "number of", "balance", "change", "tender"]
        if prefixes.contains(where: { containsPrefix($0, in: lowered) }) {
            return true
        }
        // "Total Tax: $1.17" is a tax; "Total after Tax 20.85" and
        // "Total (incl. tax)" are the total, said the long way - Tone Tai
        // prints the first form on every receipt (`45d2c32a`).
        if containsWord("tax", in: text) || containsWord("taxes", in: text) {
            let totalIsAfterTax = ["after tax", "incl", "with tax", "tax incl"]
                .contains { lowered.contains($0) }
            return !totalIsAfterTax
        }
        if containsWord("cash", in: text) {
            return true
        }
        if containsWord("due", in: text) {
            return !(containsWord("total", in: text) || containsWord("amount", in: text))
        }
        return false
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
    ///
    /// **2026-09-01:** the tier that reads a bare `tax` label no longer
    /// skips lines that also say "total". That exclusion was written for
    /// the phrase "total before tax", which no receipt in the restore
    /// prints - while `Sales tax total $7.79` (UNIQLO, six receipts) and
    /// `Total Tax: $1.17` (Tim Hortons) are exactly the tax, and were
    /// being thrown away. The phrases that genuinely are not a tax amount
    /// (`before tax`, `after tax`, `taxable`, `tax exempt`) are excluded by
    /// name instead - see `taxRows(in:)`.
    private static func hst(in lines: [RecognizedLine], subtotalCents: Int?) -> Int? {
        let rows = taxRows(in: lines)

        // Split HST (2026-08-28 product feedback): checked first, and
        // narrowly guarded to fall through to the ranking below whenever
        // its shape is anything but the one it was built for - see the
        // function's own comment for why.
        if let split = splitOrCombinedHst(rows: rows, subtotalCents: subtotalCents) {
            return split
        }

        for allowZero in [false, true] {
            for tier in TaxTier.allCases {
                if let row = rows.first(where: { $0.tier == tier && (allowZero || $0.amount != 0) }) {
                    return row.amount
                }
            }
        }
        return nil
    }

    /// The three label tiers, most specific first.
    private enum TaxTier: CaseIterable {
        case hst, gst, tax
    }

    private struct TaxRow {
        let amount: Int
        let text: String
        let tier: TaxTier
        /// A label that names the SUM of the tax rows around it rather than
        /// one of them - `Total Tax`, `Sales tax total`, `HST Included in
        /// Total`, `HST (TOTAL GST+PST)`. See `splitOrCombinedHst`.
        let isSummaryLabel: Bool
    }

    /// Every line that is stating a tax amount, with the amount read by the
    /// outside-parentheses, ends-the-line rule
    /// (`ReceiptAmount.trailingAmountOutsideParentheses`, whose own comment
    /// carries the receipts behind it).
    ///
    /// Excluded by name (2026-09-01, all off real paper in the restore):
    /// `before tax` / `after tax` (`lotal after Tax 5.18` is the TOTAL of
    /// an Al-Premium receipt, not its tax), `pre-tax` (`(Pre-Tax: CAS
    /// 9.09)`), `taxable`, `tax exempt`, and any line that also carries a
    /// tip or gratuity - `TIP TOTAL 94.20 HST 13% …` is a tip line, and a
    /// tip is never a tax (a Pho House `TIP CAD $2.64` reached the HST
    /// field twice in production, by hand rather than by parser, which is
    /// its own argument for suggesting the right thing here).
    private static func taxRows(in lines: [RecognizedLine]) -> [TaxRow] {
        lines.compactMap { line -> TaxRow? in
            let text = line.text
            let lowered = text.lowercased()
            for phrase in ["before tax", "after tax", "pre-tax", "pre tax", "taxable", "tax exempt"]
            where lowered.contains(phrase) {
                return nil
            }
            if containsWord("tip", in: text) || containsWord("gratuity", in: text) {
                return nil
            }
            guard let tier = taxTier(of: text) else { return nil }
            guard let amount = ReceiptAmount.trailingAmountOutsideParentheses(in: text) else { return nil }
            return TaxRow(amount: amount, text: text, tier: tier, isSummaryLabel: isSummaryTaxLabel(lowered))
        }
    }

    /// Which tier a line's tax label belongs to, most specific label
    /// winning. Beyond the three bare words, the labels real paper prints
    /// (2026-09-01): `H.S.T.` (Domino's), `HST Included in Total` (MUJI),
    /// `H 13.000% of $109.80  $14.27` (UNIQLO - the "H" IS the label), and
    /// `Sales tax` / `Taxes` / `Food Tax` / `Total Tax` on the bare-tax
    /// tier.
    private static func taxTier(of text: String) -> TaxTier? {
        if containsWord("hst", in: text) || text.contains(dottedHstPattern) || text.contains(percentRateLabel) {
            return .hst
        }
        if containsWord("gst", in: text) || text.contains(dottedGstPattern) {
            return .gst
        }
        if containsWord("tax", in: text) || containsWord("taxes", in: text) {
            return .tax
        }
        return nil
    }

    private static func isSummaryTaxLabel(_ lowered: String) -> Bool {
        ["total tax", "tax total", "included in total", "total gst"].contains { lowered.contains($0) }
    }

    /// the owner's first-use product feedback (2026-08-28): some receipts
    /// print a harmonized tax as two provincial-rate lines rather than
    /// one combined line ("HST 8%" and "HST 5%" separately, 13% total),
    /// and the ranking above - by design, per its own comment - picks
    /// whichever one sorts highest and silently drops the other, which is
    /// exactly the ranking doing its job on a receipt shape it was never
    /// built for.
    ///
    /// This is a narrow, guarded set of cases laid on TOP of the ranking,
    /// not a replacement for it - the wave-5 device failure the ranking
    /// exists to prevent (a labelled zero shadowing a real amount) is still
    /// live on every receipt with one tax row. Zeros are never gathered,
    /// and fewer than two non-zero rows returns nil so the ranking decides
    /// unchanged. Given two or more, in order (the first three added
    /// 2026-09-01):
    ///
    /// 1. **One row equals the sum of the others (±1¢).** That row IS the
    ///    whole tax and the others are its parts - Tim Hortons `81cfa0eb`
    ///    prints `0.45`, `0.72` and `Total Tax: $1.17`, and Costco prints
    ///    the identical `7.34` twice (`TAX` and `P (H)HST 13%`), which this
    ///    rule reads as one amount rather than $14.68.
    /// 2. **A row whose label names the sum.** `Total Tax`, `Sales tax
    ///    total`, `HST Included in Total` - the label says outright that it
    ///    is the total of the rows beside it. Needed as well as rule 1
    ///    because OCR loses a sibling: `81cfa0eb`'s `GST1:` came back as
    ///    `NST1:`, which is no longer a tax label at all, so `0.45 + 0.72 =
    ///    1.17` cannot be checked - but `Total Tax` still means what it
    ///    says.
    /// 3. **The rows sum to a real Canadian rate on the subtotal.** Five
    ///    Guys `7a0f899c` prints `HST - ON 5% $1.20` and `HST - 001300
    ///    $1.93` - the second row's `%` marker mangled - and 120 + 193 =
    ///    313 is 13.00% of the 24.08 subtotal exactly. Integer
    ///    cross-multiplication, ±0.25pp, the same band and the same
    ///    technique as `checkHstRatePlausibility`.
    /// 4. **Every row carries its own distinct percentage marker** - the
    ///    original 2026-08-28 rule, unchanged: with that signal a genuine
    ///    split can be told from two unrelated tax lines, and the rows sum
    ///    (8% + 5% = 13%, never printed combined).
    ///
    /// Anything else returns nil rather than guess, because trading a
    /// visible absence for a wrong-but-plausible amount reaching an
    /// accountant is the one thing the ranking was written to avoid.
    private static func splitOrCombinedHst(rows: [TaxRow], subtotalCents: Int?) -> Int? {
        let nonZeroRows = rows.filter { $0.amount != 0 }
        guard nonZeroRows.count >= 2 else { return nil }

        // 1. One row equal to the sum of the others.
        let total = nonZeroRows.reduce(0) { $0 + $1.amount }
        for row in nonZeroRows where abs(row.amount - (total - row.amount)) <= 1 {
            return row.amount
        }

        // 2. A label that names the sum.
        let summaryRows = nonZeroRows.filter(\.isSummaryLabel)
        if summaryRows.count == 1, let summary = summaryRows.first {
            return summary.amount
        }

        // 3. The rows together are a real rate on the subtotal.
        if let subtotalCents, subtotalCents > 0, isPlausibleTaxRate(taxCents: total, subtotalCents: subtotalCents) {
            return total
        }

        // 4. Every row carrying its own distinct percentage marker.
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
        return total
    }

    /// Whether `taxCents / subtotalCents` lands within ±0.25 percentage
    /// points of a rate Canada actually charges - 5% (GST alone), 13%
    /// (Ontario), 14% or 15% (the Atlantic provinces). Integer
    /// cross-multiplication rather than floating-point division, the same
    /// technique `ReceiptArithmetic.checkHstRatePlausibility` uses and for
    /// the same reason: the boundary is exact rather than subject to
    /// rounding error.
    private static func isPlausibleTaxRate(taxCents: Int, subtotalCents: Int) -> Bool {
        let scaled = taxCents * 10_000
        for rateBps in [500, 1300, 1400, 1500] {
            if scaled >= (rateBps - 25) * subtotalCents && scaled <= (rateBps + 25) * subtotalCents {
                return true
            }
        }
        return false
    }

    // MARK: - Subtotal

    /// The bottom-most subtotal-labelled row. Audited alongside the HST
    /// fix for first-match-among-several-candidates: a long receipt can
    /// print section subtotals above its summary block, and the summary
    /// subtotal - the one the arithmetic check compares - prints last,
    /// beside the taxes and total. A single-subtotal receipt, the common
    /// case, is unaffected.
    private static func subtotal(in lines: [RecognizedLine]) -> Int? {
        guard let line = lines.last(where: { isSubtotalLine($0.text) }) else {
            return nil
        }
        return ReceiptAmount.lastLabelledAmount(in: line.text)
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
            guard let amount = ReceiptAmount.lastLabelledAmount(in: line.text) else { continue }
            return amount
        }
        return nil
    }

    // MARK: - Other fees (2026-09-01)

    /// Every non-tax, non-tip charge layered on the subtotal, summed: a
    /// delivery fee, a service charge, a card surcharge, a cash-rounding
    /// adjustment, an eco fee, a bottle deposit, a bag fee. Summed rather
    /// than first-match because a receipt can print two of them (delivery
    /// AND a service charge), and the field they fill is a single residual.
    ///
    /// Subtotal, total and tax lines are excluded so a merged row cannot
    /// double-count, and the same tip exclusion as everywhere else applies:
    /// a tip has its own field.
    private static func otherFees(in lines: [RecognizedLine]) -> Int? {
        let labels = [
            "service charge", "surcharge", "rounding", "delivery",
            "eco fee", "enviro", "deposit", "bag fee",
        ]
        var sum = 0
        var found = false
        for line in lines {
            let lowered = line.text.lowercased()
            guard labels.contains(where: { lowered.contains($0) }) else { continue }
            if isSubtotalLine(line.text) { continue }
            if containsWord("total", in: line.text) { continue }
            if taxTier(of: line.text) != nil { continue }
            if containsWord("tip", in: line.text) || containsWord("gratuity", in: line.text) { continue }
            guard let amount = ReceiptAmount.lastLabelledAmount(in: line.text) else { continue }
            sum += amount
            found = true
        }
        return found ? sum : nil
    }

    // MARK: - Payment method (2026-09-01)

    /// The card or cash label the slip prints, canonicalized to the upper
    /// case form a person would type. First match in reading order: the
    /// card type prints once near the transaction record and again in the
    /// EMV block below it, and they always agree.
    private static func paymentMethod(in lines: [RecognizedLine]) -> String? {
        // Longest first, so "MASTER CARD" is not read as two words and
        // "AMERICAN EXPRESS" is not missed for "AMEX".
        let labels: [(pattern: String, canonical: String)] = [
            ("american express", "AMEX"),
            ("master card", "MASTERCARD"),
            ("mastercard", "MASTERCARD"),
            ("apple pay", "APPLE PAY"),
            ("interac", "INTERAC"),
            ("visa", "VISA"),
            ("amex", "AMEX"),
            ("debit", "DEBIT"),
            ("cash", "CASH"),
        ]
        for line in lines {
            let lowered = line.text.lowercased()
            for label in labels where containsPhrase(label.pattern, in: lowered) {
                return label.canonical
            }
        }
        return nil
    }

    // MARK: - Vendor

    /// Two passes (2026-09-01), because the geometric one alone was right
    /// on 51 of 130 live receipts.
    ///
    /// **The person's own vendor list first.** The confirmed vendor string
    /// appears verbatim somewhere in the OCR text - normalized to letters
    /// and digits, case folded - on 119 of those 130 receipts, usually in a
    /// place the geometry will never look: `foodbasics.ca` in the footer,
    /// `WWW.UNIQLO.COM` under a two-line wordmark, `www.jimmythegreek.com`
    /// on the last line. `ReceiptOptionsStore` already carries that list
    /// and already caches it on disk, so this costs no network and works in
    /// a basement. It returns the person's OWN spelling, never the
    /// receipt's - the 2026-08-26 ruling that these free-text values are
    /// theirs and are never rewritten.
    ///
    /// **Then the §7.3 geometry**, hardened: the largest-font block in the
    /// top quarter, as a band rather than a single winner (measurement
    /// jitter flipped the vendor between scans on the wave-4 re-test), now
    /// with the header lines that are demonstrably not a name excluded by
    /// name, and with a two-line wordmark rejoined.
    private static func vendor(in lines: [RecognizedLine], knownVendors: [String]) -> String? {
        if let known = knownVendorInText(lines: lines, knownVendors: knownVendors) {
            return known
        }
        return geometricVendor(in: lines)
    }

    /// The first of the person's own vendor names to appear in the receipt
    /// text, longest breaking a tie at the same position.
    ///
    /// Four normalized characters is the floor: a shorter key ("BK",
    /// "A&W") matches inside unrelated words. Position leads rather than
    /// length because the name prints at the TOP and a mall or plaza name
    /// prints below it - a UNIQLO slip reads `UNI / QLO / … / UNIQLO Eaton
    /// Centre`, and "Food Court" is itself one of this person's confirmed
    /// vendors, so longest-wins handed six UNIQLO receipts to the food
    /// court. Measured on the 130 live receipts: first-match 116 right,
    /// longest-match 109.
    private static func knownVendorInText(lines: [RecognizedLine], knownVendors: [String]) -> String? {
        guard !knownVendors.isEmpty else { return nil }
        // Joined and normalized as one string, so a two-line wordmark
        // ("UNI" over "QLO") reads as the one word it is printed as.
        let haystack = normalizedForMatching(lines.map(\.text).joined(separator: " "))
        guard !haystack.isEmpty else { return nil }
        return knownVendors
            .map { (vendor: $0, key: normalizedForMatching($0)) }
            .filter { $0.key.count >= 4 }
            .compactMap { entry -> (vendor: String, length: Int, position: Int)? in
                guard let range = haystack.range(of: entry.key) else { return nil }
                return (
                    entry.vendor,
                    entry.key.count,
                    haystack.distance(from: haystack.startIndex, to: range.lowerBound)
                )
            }
            .min {
                $0.position != $1.position ? $0.position < $1.position : $0.length > $1.length
            }?
            .vendor
    }

    private static func normalizedForMatching(_ text: String) -> String {
        String(text.lowercased().unicodeScalars.filter(CharacterSet.alphanumerics.contains).map(Character.init))
    }

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
    ///
    /// The exclusions (2026-09-01) are all lines the old rule actually
    /// suggested as vendors in production: `In Store 392` (Jimmy the
    /// Greek), `#D2` / `Patio` / `Walk In` (table labels), `Store # 2065`
    /// and `Turn Me Over` (Burger King), `NOT A MEMBER YET? DOWNLOAD & JOIN
    /// NOW!` (T&T), `YINGHUA LI` - the customer's own name, on a Domino's
    /// slip - and a shelf of addresses and phone numbers. The customer-name
    /// case is the one this cannot exclude by rule; the known-vendor pass
    /// above is what catches it.
    private static func geometricVendor(in lines: [RecognizedLine]) -> String? {
        let candidates = lines.enumerated().filter { _, line in
            line.verticalCenter < 0.25
                && line.text.contains(where: \.isLetter)
                && !isDisqualifiedAsVendor(line.text)
        }
        guard let tallestHeight = candidates.map(\.element.height).max() else { return nil }
        let winner = candidates
            .filter { $0.element.height >= 0.85 * tallestHeight }
            .min { $0.element.verticalCenter < $1.element.verticalCenter }
        guard let winner else { return nil }
        let trimmed = winner.element.text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        // A two-line wordmark: Food Basics prints "food" small above
        // "Basics" large, and the band correctly picks the large half of a
        // name that is not a name on its own. Rejoin it when the line
        // directly above in reading order is the same kind of token.
        if isSingleShortWord(trimmed), winner.offset > 0 {
            let above = lines[winner.offset - 1].text.trimmingCharacters(in: .whitespacesAndNewlines)
            if isSingleShortWord(above) {
                return "\(above) \(trimmed)"
            }
        }
        return trimmed
    }

    private static func isSingleShortWord(_ text: String) -> Bool {
        text.count <= 10 && !text.isEmpty && text.allSatisfy(\.isLetter)
    }

    private static func isDisqualifiedAsVendor(_ text: String) -> Bool {
        let lowered = text.lowercased()
        for phrase in [
            "store #", "store#", "in store", "walk in", "walk-in", "patio", "welcome",
            "thank", "member", "download", "join", "www.", ".com", ".ca", "order",
            "table", "cashier", "server:", "receipt #", "customer copy",
        ] where lowered.contains(phrase) {
            return true
        }
        return text.contains(addressPattern)
            || text.contains(phonePattern)
            || text.contains(postalCodePattern)
            || text.contains(registrationPattern)
            || text.contains(shortHashLabelPattern)
    }

    // MARK: - Shared text tests

    /// The fixed list every label pattern below is compiled from - the
    /// one place a new labelled-amount word joins the parser (the tip
    /// heuristic added "tip" and "gratuity" here, 2026-08-28, rather than
    /// hand-rolling a parallel matcher; "taxes", "amount", "purchase",
    /// "payment", "cash" and "due" joined 2026-09-01).
    private static let labelWords = [
        "total", "hst", "gst", "tax", "taxes", "tip", "gratuity",
        "amount", "purchase", "payment", "cash", "due",
    ]

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

    /// `H.S.T.` / `G.S.T.` - Domino's prints the dotted form (2026-09-01).
    private nonisolated(unsafe) static let dottedHstPattern = #/(?:^|[^A-Za-z])[Hh]\.\s?[Ss]\.\s?[Tt]\b/#
    private nonisolated(unsafe) static let dottedGstPattern = #/(?:^|[^A-Za-z])[Gg]\.\s?[Ss]\.\s?[Tt]\b/#
    /// UNIQLO's tax line is `H 13.000% of $109.80   $14.27` - the bare "H"
    /// before a rate IS the label, and six receipts in the restore
    /// suggested nothing because nothing read it.
    private nonisolated(unsafe) static let percentRateLabel = #/(?:^|[^A-Za-z])[Hh]\s?\d{1,2}(?:\.\d+)?\s?%/#

    /// A street address: a number followed later on the line by a street
    /// word. Fenced on the street word so "Unit 1115" and "123 Main St"
    /// both match while a vendor name carrying a digit does not.
    private nonisolated(unsafe) static let addressPattern =
        #/(?i)\b\d+\b.*\b(st|ave|rd|blvd|dr|road|street|avenue|unit|suite)\b\.?/#
    private nonisolated(unsafe) static let phonePattern = #/\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/#
    private nonisolated(unsafe) static let postalCodePattern = #/(?i)\b[a-z]\d[a-z]\s?\d[a-z]\d\b/#
    /// A GST/HST registration line - never a vendor name, always printed
    /// in the header band where the geometry looks.
    private nonisolated(unsafe) static let registrationPattern = #/(?i)\b(gst|hst|bn|business)\s*#/#
    /// A bare table or order label: "#D2", "#1", "#86".
    private nonisolated(unsafe) static let shortHashLabelPattern = #/(?:^|\s)#\w{1,3}\s*$/#

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

    /// A word matched as a PREFIX rather than a whole word, so one entry
    /// covers "SAVINGS", "ITEMS", "DISCOUNT(S)", "POINTS", "Tendered".
    /// Only `isDisqualifiedAsTotal` uses this, and only for words whose
    /// prefixes have no innocent reading on a total-bearing line.
    private static func containsPrefix(_ word: String, in lowered: String) -> Bool {
        guard let pattern = try? Regex("(?:^|[^a-z])\(word)") else { return false }
        return lowered.contains(pattern) || despaced(lowered).contains(pattern)
    }

    /// A multi-word phrase, matched with a word fence at each end so
    /// "cashier" is not "cash" and "visable" is not "visa".
    private static func containsPhrase(_ phrase: String, in lowered: String) -> Bool {
        guard let pattern = try? Regex("(?:^|[^a-z0-9])\(phrase)(?![a-z0-9])") else { return false }
        return lowered.contains(pattern)
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
