import XCTest
@testable import Kept

/// The parsing module against fixture receipts (spec §10.2): everything
/// here runs on the simulator with no camera, which is the whole point of
/// the module's purity. Fixtures imitate the shapes real receipts take -
/// crisp, labelled, faded, tip-bearing, PDF-styled - and the wave-4 device
/// run measures the same heuristics against real paper.
final class ReceiptParserTests: XCTestCase {
    /// Fixture shorthand: a line at a vertical position (0 top … 1 bottom).
    private func line(_ text: String, y: Double, height: Double = 0.015) -> RecognizedLine {
        RecognizedLine(text: text, verticalCenter: y, height: height)
    }

    /// The capture instant every fixture here is scored against
    /// (2026-09-01): the date heuristic discards a reading printed after
    /// the photograph or more than two years before it, so every fixture
    /// needs one. Later than every date in this file and well within two
    /// years of the earliest.
    static let capturedAt = Date(timeIntervalSince1970: 1_788_264_000)

    private func parse(
        _ lines: [RecognizedLine],
        capturedAt: Date = ReceiptParserTests.capturedAt,
        knownVendors: [String] = []
    ) -> ReceiptSuggestions {
        ReceiptParser.parse(lines: lines, capturedAt: capturedAt, knownVendors: knownVendors)
    }

    // MARK: - Whole receipts

    func testCrispGroceryReceiptParsesEveryField() {
        let suggestions = parse([
            line("MAPLE FOODS MARKET", y: 0.05, height: 0.04),
            line("123 Main St, Ottawa ON", y: 0.10),
            line("2026/01/14 15:32", y: 0.14),
            line("Milk 2%              4.99", y: 0.35),
            line("Bread                3.49", y: 0.40),
            line("SUBTOTAL           100.00", y: 0.72),
            line("HST 13%             13.00", y: 0.76),
            line("TOTAL              113.00", y: 0.80, height: 0.02),
            line("GST/HST # 123456789 RT0001", y: 0.92),
        ])

        XCTAssertEqual(suggestions.vendor, "MAPLE FOODS MARKET")
        XCTAssertEqual(suggestions.purchasedAt, "2026-01-14")
        XCTAssertEqual(suggestions.subtotalCents, 10000)
        XCTAssertEqual(suggestions.hstCents, 1300)
        XCTAssertEqual(suggestions.totalCents, 11300)
    }

    func testRestaurantReceiptWithTipKeepsTipOutOfTax() {
        let suggestions = parse([
            line("The Galley Bistro", y: 0.06, height: 0.035),
            line("Jan 3, 2026 7:41 PM", y: 0.12),
            line("Pasta                26.00", y: 0.30),
            line("Wine                 58.00", y: 0.35),
            line("Subtotal             84.00", y: 0.60),
            line("HST                  10.92", y: 0.65),
            line("Tip                  15.00", y: 0.70),
            line("TOTAL               109.92", y: 0.78),
        ])

        XCTAssertEqual(suggestions.hstCents, 1092)
        XCTAssertEqual(suggestions.totalCents, 10992)
        XCTAssertEqual(suggestions.subtotalCents, 8400)
        XCTAssertEqual(suggestions.purchasedAt, "2026-01-03")
        // 2026-08-28: tips get their own field and their own heuristic,
        // rather than only being "kept out of tax" as the test name
        // (pre-dating the field) still says.
        XCTAssertEqual(suggestions.tipCents, 1500)
    }

    func testPdfStyleInvoiceWithThousandsSeparators() {
        let suggestions = parse([
            line("ACME OFFICE SUPPLIES INC.", y: 0.04, height: 0.05),
            line("Invoice date: 2026-03-01", y: 0.15),
            line("Subtotal                        $1,000.00", y: 0.55),
            line("HST (13%)                         $130.00", y: 0.60),
            line("TOTAL DUE                       $1,130.00", y: 0.66, height: 0.025),
            line("BN 987654321 RT 0002", y: 0.90),
        ])

        XCTAssertEqual(suggestions.vendor, "ACME OFFICE SUPPLIES INC.")
        XCTAssertEqual(suggestions.purchasedAt, "2026-03-01")
        XCTAssertEqual(suggestions.subtotalCents, 100000)
        XCTAssertEqual(suggestions.hstCents, 13000)
        XCTAssertEqual(suggestions.totalCents, 113000)
    }

    func testFadedReceiptFallsBackAndStatesAbsences() {
        // No "total" label survived, no date, nothing tall in the top
        // quarter - the total falls back to the largest amount in the
        // lower third, and everything else is honestly nil.
        let suggestions = parse([
            line("Item              12.00", y: 0.45),
            line("Item               8.50", y: 0.55),
            line("45.20", y: 0.85),
            line("40.00", y: 0.90),
        ])

        XCTAssertEqual(suggestions.totalCents, 4520)
        XCTAssertNil(suggestions.vendor)
        XCTAssertNil(suggestions.purchasedAt)
        XCTAssertNil(suggestions.hstCents)
        XCTAssertNil(suggestions.subtotalCents)
    }

    func testEmptyScanSuggestsNothing() {
        let suggestions = parse([])
        XCTAssertTrue(suggestions.isEmpty)
    }

    func testSplitLabelStillReadsAsItsWord() {
        // Vision split "Total" mid-word on the real receipt; the despaced
        // match recovers it without loosening the deliberate-spacing rules.
        let split = parse([
            RecognizedLine(text: "Tot al 15.25", verticalCenter: 0.5, height: 0.02),
        ])
        XCTAssertEqual(split.totalCents, 1525)

        // "SUB TOTAL" is still a subtotal, not a total, both spellings.
        let spaced = parse([
            RecognizedLine(text: "SUB TOTAL 10.00", verticalCenter: 0.5, height: 0.02),
        ])
        XCTAssertEqual(spaced.subtotalCents, 1000)
        XCTAssertNil(spaced.totalCents)
    }

    func testVendorSurvivesHeightJitterButYieldsToGenuinelyBiggerPrint() {
        // Same print size, measurement jitter: the address measures a few
        // percent taller, and the topmost of the near-tallest band wins.
        let jittered = parse([
            line("Corner Noodle Bar", y: 0.07, height: 0.0306),
            line("12 Main Street", y: 0.10, height: 0.0323),
        ])
        XCTAssertEqual(jittered.vendor, "Corner Noodle Bar")

        // A genuinely larger name below a small header line still wins:
        // the band excludes the small line, position never enters into it.
        let bigNameLower = parse([
            line("Welcome to", y: 0.03, height: 0.012),
            line("BIG BOX HARDWARE", y: 0.08, height: 0.045),
        ])
        XCTAssertEqual(bigNameLower.vendor, "BIG BOX HARDWARE")
    }

    // MARK: - Total heuristics

    func testTotalPrefersLabelledLineOverLargerAmountElsewhere() {
        // The card-payment line is larger than the total (cash back), but
        // the labelled line wins outright.
        let suggestions = parse([
            line("TOTAL 20.00", y: 0.70),
            line("DEBIT 40.00", y: 0.80),
        ])
        XCTAssertEqual(suggestions.totalCents, 2000)
    }

    func testTotalTakesLargestAcrossTotalLines() {
        // "TOTAL SAVINGS" is a total-labelled line too; largest-wins is the
        // §7.3 rule for exactly this.
        let suggestions = parse([
            line("TOTAL SAVINGS 5.00", y: 0.60),
            line("TOTAL 20.00", y: 0.70),
        ])
        XCTAssertEqual(suggestions.totalCents, 2000)
    }

    func testSubTotalWithASpaceIsNeverTheTotal() {
        let suggestions = parse([
            line("SUB TOTAL 10.00", y: 0.60),
            line("TOTAL 11.30", y: 0.70),
        ])
        XCTAssertEqual(suggestions.subtotalCents, 1000)
        XCTAssertEqual(suggestions.totalCents, 1130)
    }

    // MARK: - Tax heuristics

    func testBareTaxLabelCountsOnlyAwayFromTotalPhrasing() {
        let suggestions = parse([
            line("TOTAL BEFORE TAX 100.00", y: 0.60),
            line("TAX 13.00", y: 0.65),
            line("TOTAL 113.00", y: 0.70),
        ])
        XCTAssertEqual(suggestions.hstCents, 1300)
        XCTAssertEqual(suggestions.totalCents, 11300)
    }

    func testTaxableDoesNotReadAsTax() {
        let suggestions = parse([
            line("TAXABLE ITEMS 50.00", y: 0.50),
            line("TOTAL 50.00", y: 0.70),
        ])
        XCTAssertNil(suggestions.hstCents)
    }

    // MARK: - HST label priority (wave-5 device step 1)

    func testLabelledZeroGstRowDoesNotShadowTheHstRow() {
        // The ranking rule in isolation, on already-clean rows: a tax
        // block printing "GST: $0.00" above "HST: $2.05" must not put the
        // GST zero into the HST field (the old lumped HST|GST|TAX first
        // match did). The real-geometry version of this receipt lives in
        // testRealSkewedReceiptPairsTheTaxBlockCorrectly, which also
        // exercises the assembly that feeds this rule.
        let suggestions = parse([
            line("Subtotal $15.79", y: 0.60),
            line("GST: $0.00", y: 0.64),
            line("HST: $2.05", y: 0.68),
            line("Total: $17.84", y: 0.72),
        ])
        XCTAssertEqual(suggestions.hstCents, 205)
        XCTAssertEqual(suggestions.subtotalCents, 1579)
        XCTAssertEqual(suggestions.totalCents, 1784)
    }

    func testGstOnlyReceiptSuggestsTheGstAmount() {
        // A non-harmonized province prints GST alone; it is the same CRA
        // program and belongs in this field.
        let suggestions = parse([
            line("SUBTOTAL 12.00", y: 0.60),
            line("GST 0.60", y: 0.65),
            line("TOTAL 12.60", y: 0.70),
        ])
        XCTAssertEqual(suggestions.hstCents, 60)
    }

    func testZeroHstRowLosesToTheNonZeroGstRow() {
        // The wave-5 receipt's mirror image: the zero is the shadow, the
        // sibling label carries the tax actually charged.
        let suggestions = parse([
            line("HST: $0.00", y: 0.62),
            line("GST: $0.60", y: 0.66),
            line("TOTAL 12.60", y: 0.72),
        ])
        XCTAssertEqual(suggestions.hstCents, 60)
    }

    func testBothTaxesNonZeroPreferTheHstRow() {
        // A receipt charging both is charging the tax twice; the HST row
        // wins as the more specific label, and the arithmetic warning is
        // what surfaces the mess (rule recorded in DECISIONS.md).
        let suggestions = parse([
            line("GST 0.60", y: 0.62),
            line("HST 2.05", y: 0.66),
            line("TOTAL 20.00", y: 0.72),
        ])
        XCTAssertEqual(suggestions.hstCents, 205)
    }

    // MARK: - Split HST (2026-08-28 product feedback)

    /// the owner's own receipt shape: one harmonized tax printed as two
    /// provincial-rate HST lines rather than one combined line. Each row
    /// carries its own distinct percentage marker, so the two must sum
    /// rather than have the ranking silently pick one and drop the other.
    /// Predicted before running: 800 + 500 = 1300.
    func testSplitHstRowsWithDistinctPercentagesSum() {
        let suggestions = parse([
            line("Subtotal 100.00", y: 0.60),
            line("HST 8% 8.00", y: 0.64),
            line("HST 5% 5.00", y: 0.68),
            line("TOTAL 113.00", y: 0.72),
        ])
        XCTAssertEqual(suggestions.hstCents, 1300)
        XCTAssertEqual(suggestions.subtotalCents, 10000)
    }

    /// The receipt the split case must NOT sum: a 13% row that already
    /// equals the sum of the other two rates (5% + 8%) is the combined
    /// harmonized amount by itself - summing all three would double-count
    /// the province's share on top of the row that already carries it.
    /// Predicted before running: the HST row's own 1300, not 500+800+1300.
    func testThirteenPercentRowSubsumingFivePlusEightWinsOutright() {
        let suggestions = parse([
            line("GST 5% 5.00", y: 0.60),
            line("TAX 8% 8.00", y: 0.64),
            line("HST 13% 13.00", y: 0.68),
            line("TOTAL 100.00", y: 0.72),
        ])
        XCTAssertEqual(suggestions.hstCents, 1300)
    }

    /// Multiple non-zero tax rows with no percentage marker at all carry
    /// none of the split case's required signal, so the shape must fall
    /// through untouched to the ranking (HST beats GST beats TAX) -
    /// exactly today's behaviour, unmodified. Predicted before running:
    /// 205, the HST row, same as the pre-existing ranking tests.
    func testMultiRowTaxBlockWithoutPercentagesFallsBackToTheRanking() {
        let suggestions = parse([
            line("GST 0.60", y: 0.60),
            line("TAX 0.80", y: 0.64),
            line("HST 2.05", y: 0.68),
            line("TOTAL 20.00", y: 0.72),
        ])
        XCTAssertEqual(suggestions.hstCents, 205)
    }

    /// Two rows sharing one percentage are not a genuine split - the
    /// guard requires pairwise-distinct rates - so this also falls back
    /// to the ranking. Predicted before running: 205, the HST row.
    func testRepeatedPercentageMarkersFallBackToTheRanking() {
        let suggestions = parse([
            line("GST 8% 0.60", y: 0.62),
            line("HST 8% 2.05", y: 0.66),
            line("TOTAL 20.00", y: 0.72),
        ])
        XCTAssertEqual(suggestions.hstCents, 205)
    }

    /// The wave-5 regression, unmodified by the split case: a GST zero
    /// still must not shadow a real HST amount. The split case's own
    /// guard already excludes this shape (a zero row is never gathered,
    /// leaving only one non-zero candidate), but this receipt is the one
    /// the original ranking exists to protect, so it is asserted again
    /// here rather than trusted to the guard's logic alone. Predicted
    /// before running: 205 - unchanged from before this feature existed.
    func testWaveFiveZeroGstStillDoesNotShadowHstAfterSplitHstChange() {
        let suggestions = parse([
            line("Subtotal $15.79", y: 0.60),
            line("GST: $0.00", y: 0.64),
            line("HST: $2.05", y: 0.68),
            line("Total: $17.84", y: 0.72),
        ])
        XCTAssertEqual(suggestions.hstCents, 205)
    }

    func testAllZeroTaxRowsSuggestTheHonestZero() {
        // An exempt receipt genuinely charged no tax: zero is the truth
        // here, not a shadowing artifact.
        let suggestions = parse([
            line("GST $0.00", y: 0.62),
            line("HST $0.00", y: 0.66),
            line("TOTAL 10.00", y: 0.72),
        ])
        XCTAssertEqual(suggestions.hstCents, 0)
    }

    // MARK: - Tip heuristic (2026-08-28)

    func testGratuityLabelSuggestsTip() {
        let suggestions = parse([
            line("Subtotal 84.00", y: 0.55),
            line("Gratuity 15.00", y: 0.60),
            line("TOTAL 99.00", y: 0.65),
        ])
        XCTAssertEqual(suggestions.tipCents, 1500)
    }

    func testDespacedTipLabelStillReadsAsTip() {
        // Vision's mid-word split, the same shape "Tot al" exercises for
        // total - the tip heuristic reuses the same despaced-label
        // machinery rather than a parallel matcher.
        let split = parse([
            RecognizedLine(text: "TI P 15.00", verticalCenter: 0.5, height: 0.02),
        ])
        XCTAssertEqual(split.tipCents, 1500)
    }

    func testNoTipLineSuggestsNothing() {
        let suggestions = parse([
            line("Subtotal 84.00", y: 0.55),
            line("HST 10.92", y: 0.60),
            line("TOTAL 94.92", y: 0.65),
        ])
        XCTAssertNil(suggestions.tipCents)
    }

    func testMultipleSubtotalRowsPreferTheBottomMost() {
        // The same audit's subtotal finding: section subtotals print
        // above the summary block, and the summary subtotal - the one
        // the arithmetic check compares - prints last, beside the taxes.
        let suggestions = parse([
            line("GROCERY SUBTOTAL 20.00", y: 0.40),
            line("PHARMACY SUBTOTAL 10.00", y: 0.50),
            line("SUBTOTAL 30.00", y: 0.62),
            line("HST 3.90", y: 0.66),
            line("TOTAL 33.90", y: 0.72),
        ])
        XCTAssertEqual(suggestions.subtotalCents, 3000)
        XCTAssertEqual(suggestions.totalCents, 3390)
    }

    /// The tax-number heuristic and its field went on 2026-08-26 (the
    /// receipt reduced to date, vendor, subtotal, HST, total, category,
    /// payment, notes). A GST/HST registration line still prints on real
    /// paper, so what matters now is that removing its reader left nothing
    /// else reading it: it carries no two-decimal amount, and the money
    /// heuristics around it are unmoved.
    func testARegistrationNumberLineFeedsNoOtherHeuristic() {
        let suggestions = parse([
            line("SUBTOTAL 10.00", y: 0.60),
            line("HST 1.30", y: 0.65),
            line("TOTAL 11.30", y: 0.70),
            line("GST/HST # 123456789 RT0001", y: 0.92),
        ])
        XCTAssertEqual(suggestions.subtotalCents, 1000)
        XCTAssertEqual(suggestions.hstCents, 130)
        XCTAssertEqual(suggestions.totalCents, 1130)
    }

    // MARK: - Date heuristics

    func testDatePrefersTopThirdOverEarlierMatchLowerDown() {
        // Reading order finds the return-policy date last; the top-third
        // preference must pick the header date even though both parse.
        let suggestions = parse([
            line("2026-04-02 09:12", y: 0.15),
            line("Returns until 2026-05-02", y: 0.95),
        ])
        XCTAssertEqual(suggestions.purchasedAt, "2026-04-02")
    }

    func testDateAnywhereWhenTopThirdHasNone() {
        let suggestions = parse([
            line("VENDOR", y: 0.05, height: 0.03),
            line("Date: 03/15/2026", y: 0.80),
        ])
        XCTAssertEqual(suggestions.purchasedAt, "2026-03-15")
    }

    // MARK: - Vendor heuristics

    func testVendorIsTallestTextInTopQuarter() {
        let suggestions = parse([
            line("Welcome to", y: 0.03, height: 0.01),
            line("BIG BOX HARDWARE", y: 0.07, height: 0.045),
            line("Store #42", y: 0.12, height: 0.012),
        ])
        XCTAssertEqual(suggestions.vendor, "BIG BOX HARDWARE")
    }

    func testAllDigitLinesCannotBeTheVendor() {
        let suggestions = parse([
            line("613 555 0142", y: 0.05, height: 0.05),
            line("Corner Cafe", y: 0.10, height: 0.02),
        ])
        XCTAssertEqual(suggestions.vendor, "Corner Cafe")
    }

    func testVendorOutsideTopQuarterIsNotGuessed() {
        let suggestions = parse([
            line("MID-RECEIPT BANNER", y: 0.50, height: 0.05),
        ])
        XCTAssertNil(suggestions.vendor)
    }

    func testUnsortedLinesStillParseInReadingOrder() {
        // Same grocery fixture, shuffled: the parser must sort, not trust.
        let suggestions = parse([
            line("TOTAL 113.00", y: 0.80),
            line("MAPLE FOODS MARKET", y: 0.05, height: 0.04),
            line("Returns until 2026-05-02", y: 0.95),
            line("2026/01/14 15:32", y: 0.14),
        ])
        XCTAssertEqual(suggestions.vendor, "MAPLE FOODS MARKET")
        XCTAssertEqual(suggestions.purchasedAt, "2026-01-14")
    }
}

final class ReceiptAmountTests: XCTestCase {
    func testFindsAmountsInTextOrder() {
        XCTAssertEqual(ReceiptAmount.amounts(in: "45.20 CHANGE 50.00"), [4520, 5000])
    }

    func testDollarSignAndThousandsSeparators() {
        XCTAssertEqual(ReceiptAmount.amounts(in: "$1,234.56"), [123456])
        XCTAssertEqual(ReceiptAmount.amounts(in: "$ 12.00"), [1200])
    }

    func testRequiresExactlyTwoDecimals() {
        XCTAssertEqual(ReceiptAmount.amounts(in: "1.234"), [])
        XCTAssertEqual(ReceiptAmount.amounts(in: "QTY 3"), [])
        XCTAssertEqual(ReceiptAmount.amounts(in: "13%"), [])
    }

    func testLargestAndLast() {
        XCTAssertEqual(ReceiptAmount.largestAmount(in: "5.00 20.00 10.00"), 2000)
        XCTAssertEqual(ReceiptAmount.lastAmount(in: "5.00 20.00 10.00"), 1000)
        XCTAssertNil(ReceiptAmount.largestAmount(in: "no money here"))
    }

    func testAbsurdOcrNumbersAreDroppedNotACrash() {
        // A digit run Vision misreads off a barcode: Int.max dollars fits
        // Int but overflows the cents scale-up, which must drop the match,
        // never trap mid-batch.
        XCTAssertEqual(ReceiptAmount.amounts(in: "9223372036854775807.00"), [])
        XCTAssertEqual(ReceiptAmount.amounts(in: "99999999999999999999.00"), [])
        // A large but representable amount still parses.
        XCTAssertEqual(ReceiptAmount.amounts(in: "92233720368547758.06"), [9223372036854775806])
    }
}

final class ReceiptDateParserTests: XCTestCase {
    func testIsoAndSlashedYearFirst() {
        XCTAssertEqual(ReceiptDateParser.firstDate(in: "2026-01-14"), "2026-01-14")
        XCTAssertEqual(ReceiptDateParser.firstDate(in: "2026/01/14 15:32"), "2026-01-14")
    }

    func testAmbiguousPairPrefersMonthFirst() {
        XCTAssertEqual(ReceiptDateParser.firstDate(in: "01/14/2026"), "2026-01-14")
        // 14 cannot be a month, so day-first is the only reading.
        XCTAssertEqual(ReceiptDateParser.firstDate(in: "14/01/2026"), "2026-01-14")
    }

    func testMonthNames() {
        XCTAssertEqual(ReceiptDateParser.firstDate(in: "Jan 14, 2026"), "2026-01-14")
        XCTAssertEqual(ReceiptDateParser.firstDate(in: "14 September 2026"), "2026-09-14")
        XCTAssertEqual(ReceiptDateParser.firstDate(in: "Sept 2, 2026"), "2026-09-02")
    }

    func testTwoDigitYear() {
        XCTAssertEqual(ReceiptDateParser.firstDate(in: "01/14/26"), "2026-01-14")
    }

    func testImpossibleDatesReturnNilNotALie() {
        XCTAssertNil(ReceiptDateParser.firstDate(in: "2026-02-30"))
        XCTAssertNil(ReceiptDateParser.firstDate(in: "13/45/2026"))
        XCTAssertNil(ReceiptDateParser.firstDate(in: "no date at all"))
    }

    func testLeapYearFebruary() {
        XCTAssertEqual(ReceiptDateParser.firstDate(in: "2028-02-29"), "2028-02-29")
        XCTAssertNil(ReceiptDateParser.firstDate(in: "2026-02-29"))
    }
}

final class ReceiptDateReadingTests: XCTestCase {
    /// The hyphenated month-name forms real paper prints, none of which the
    /// pre-2026-09-01 patterns matched: `03-Feb.-2026`, `31-Jul.-2026`,
    /// `09-May-2026`, `15-Jun.-2026`.
    func testHyphenatedMonthNameForms() {
        XCTAssertEqual(ReceiptDateParser.firstDate(in: "03-Feb.-2026"), "2026-02-03")
        XCTAssertEqual(ReceiptDateParser.firstDate(in: "31-Jul.-2026"), "2026-07-31")
        XCTAssertEqual(ReceiptDateParser.firstDate(in: "09-May-2026"), "2026-05-09")
        XCTAssertEqual(ReceiptDateParser.firstDate(in: "15-Jun.-2026"), "2026-06-15")
    }

    func testMonthNameWithoutACommaAndAnIsoTimestamp() {
        XCTAssertEqual(ReceiptDateParser.firstDate(in: "May 09 2026"), "2026-05-09")
        XCTAssertEqual(ReceiptDateParser.firstDate(in: "2026-05-27 19:47:17"), "2026-05-27")
    }

    /// A two-digit-year token means all three readings, not one. The old
    /// parser emitted only mm/dd/yy and so read `26/07/19` as 2019-07-26.
    func testTwoDigitYearTokenYieldsEveryValidReading() {
        let readings = ReceiptDateParser.readings(in: "DateTime: 26/07/19 10:41:03").map(\.iso)
        XCTAssertTrue(readings.contains("2026-07-19"), "yy/mm/dd")
        XCTAssertTrue(readings.contains("2019-07-26"), "dd/mm/yy")
        XCTAssertEqual(readings.count, 2, "26 cannot be a month, so mm/dd/yy is not a reading")
        XCTAssertTrue(readings.allSatisfy { _ in true })
        XCTAssertFalse(
            ReceiptDateParser.readings(in: "DateTime: 26/07/19").allSatisfy(\.isUnambiguous),
            "a token with two readings is not unambiguous"
        )
    }

    /// A four-digit-year token yields both orders when both are real days,
    /// and exactly one when only one is.
    func testFourDigitYearTokenYieldsBothOrdersWhenBothAreValid() {
        XCTAssertEqual(
            Set(ReceiptDateParser.readings(in: "Receipt Date: 09/05/2026").map(\.iso)),
            ["2026-09-05", "2026-05-09"]
        )
        let single = ReceiptDateParser.readings(in: "PAID 7/17/2026 4:41 PM")
        XCTAssertEqual(single.map(\.iso), ["2026-07-17"])
        XCTAssertTrue(single[0].isUnambiguous, "19 cannot be a month, so this token means one day")
    }

    private func best(_ lines: [String], captured: String) -> String? {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss"
        guard let capturedAt = formatter.date(from: captured) else {
            XCTFail("bad timestamp")
            return nil
        }
        return ReceiptDateParser.bestDate(inLines: lines, capturedAt: capturedAt)
    }

    /// A receipt is photographed after it is printed.
    func testAReadingAfterTheCaptureIsDiscarded() {
        XCTAssertNil(best(["Receipt Date: 12/31/2026"], captured: "2026-08-30T12:00:00"))
    }

    /// Age is a penalty, not a veto (2026-09-01, second pass). An emailed
    /// backlog going back to 2022 was imported the same day this parser was
    /// reworked, and a 2022 receipt scanned in 2026 is an ordinary thing to
    /// do: the date is on the paper, and discarding it would replace a
    /// right answer with the capture day.
    func testAnOldReceiptScannedFromABacklogKeepsItsOwnDate() {
        XCTAssertEqual(best(["2022-11-06"], captured: "2026-09-01T12:00:00"), "2022-11-06")
        XCTAssertEqual(best(["Nov 6, 2022 3:14 PM"], captured: "2026-09-01T12:00:00"), "2022-11-06")
    }

    /// What the age penalty still has to do: `TIMED ORDER 7/17/20` reads as
    /// 2020 and must lose to the `PAID 7/17/2026` printed below it - by six
    /// years of distance and a decoy word, not by a cutoff.
    func testAnOldMisreadingLosesToAContemporaryOneOnTheSameReceipt() {
        XCTAssertEqual(
            best(["TIMED ORDER 7/17/20 #10572", "PAID 7/17/2026 4:41 PM"], captured: "2026-08-28T12:00:00"),
            "2026-07-17"
        )
        XCTAssertEqual(
            best(["DateTime: 26/07/19 10:41:03", "07/19/2026 10:41 AM"], captured: "2026-08-30T12:00:00"),
            "2026-07-19",
            "yy/mm/dd beats dd/mm/yy read as 2019 on the same token"
        )
    }

    /// Two lines reading the same calendar day is the strongest signal on
    /// the page, and it is what settles the Food Basics card slip.
    func testTwoLinesAgreeingOnADayBeatOneThatDoesNot() {
        XCTAssertEqual(
            best(
                ["Returns until 2026-08-01", "DateTime: 26/07/19 10:41:03", "07/19/2026 10:41 AM"],
                captured: "2026-08-30T12:00:00"
            ),
            "2026-07-19"
        )
    }

    /// A decoy word costs more than a clock time is worth.
    func testDecoyWordsLoseToAPlainDate() {
        XCTAssertEqual(
            best(["Sweepstakes ends 12/31/25 11:59 PM", "2026-04-25"], captured: "2026-08-27T12:00:00"),
            "2026-04-25"
        )
    }

    /// Ties go to the earlier line, where the header prints.
    func testTiesGoToTheEarlierLine() {
        XCTAssertEqual(
            best(["2026-04-02", "2026-04-09"], captured: "2026-08-27T12:00:00"),
            "2026-04-02"
        )
    }
}

/// The amount reader's 2026-09-01 additions: the decimal point OCR loses,
/// the bare integer it refuses, and the tax reader's two guards.
final class ReceiptDamagedAmountTests: XCTestCase {
    func testAHyphenOrCommaOrSpaceAtTheEndOfALineIsADecimalPoint() {
        XCTAssertEqual(ReceiptAmount.lastLabelledAmount(in: "TOTAL 9-86"), 986)
        XCTAssertEqual(ReceiptAmount.lastLabelledAmount(in: "Sub Total 4,58"), 458)
        XCTAssertEqual(ReceiptAmount.lastLabelledAmount(in: "TOTAL 24 18"), 2418)
    }

    /// Only at the END of the line, and only when the strict reading found
    /// nothing - or every phone number and EMV field on a card slip becomes
    /// money.
    func testTheDamagedFormIsAnchoredAndOnlyAFallback() {
        XCTAssertNil(ReceiptAmount.lastLabelledAmount(in: "Store #1234 (555) 555-0100"))
        XCTAssertNil(ReceiptAmount.lastLabelledAmount(in: "TVR: 00 00 00 80 01"))
        XCTAssertNil(ReceiptAmount.lastLabelledAmount(in: "HST# 76049 5606 RT0001"))
        XCTAssertEqual(
            ReceiptAmount.lastLabelledAmount(in: "SUBTOTAL 24.18"),
            2418,
            "a line with a real amount never reaches the damaged form"
        )
    }

    /// `Sub Total $7` on a receipt whose real subtotal is $7.99. A round
    /// number beside a total gets ticked past; a blank does not.
    func testABareIntegerIsNeverAnAmount() {
        XCTAssertNil(ReceiptAmount.lastLabelledAmount(in: "Sub Total $7"))
        XCTAssertNil(ReceiptAmount.lastLabelledAmount(in: "Order Total $9"))
        XCTAssertNil(ReceiptAmount.lastLabelledAmount(in: "Total 50"))
        XCTAssertNil(ReceiptAmount.lastLabelledAmount(in: "SUBTOTAL - 60"))
    }

    func testTheTaxReaderTakesTheLastAmountOutsideParenthesesEndingTheLine() {
        XCTAssertEqual(ReceiptAmount.trailingAmountOutsideParentheses(in: "HST 13% $0.26"), 26)
        XCTAssertEqual(ReceiptAmount.trailingAmountOutsideParentheses(in: "HST : $ 2.05"), 205)
        XCTAssertEqual(ReceiptAmount.trailingAmountOutsideParentheses(in: "H 13.000% of $109.80 $14.28"), 1428)
        XCTAssertEqual(
            ReceiptAmount.trailingAmountOutsideParentheses(in: "HST ONT 13% Soda TA 1.04%"),
            104,
            "a trailing percent sign is punctuation, not another token"
        )
        XCTAssertNil(ReceiptAmount.trailingAmountOutsideParentheses(in: "HST (on 9.99)"))
        XCTAssertNil(
            ReceiptAmount.trailingAmountOutsideParentheses(in: "of $9.90 (+tax) will be applied. Merchandise"),
            "prose is not a tax line even when it says tax"
        )
        XCTAssertNil(
            ReceiptAmount.trailingAmountOutsideParentheses(in: "HST 863624433 667888060849 5X2 1.25 H 1.25 H"),
            "the amount must end the line"
        )
    }
}
