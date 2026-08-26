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

    // MARK: - Whole receipts

    func testCrispGroceryReceiptParsesEveryField() {
        let suggestions = ReceiptParser.parse(lines: [
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
        let suggestions = ReceiptParser.parse(lines: [
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
    }

    func testPdfStyleInvoiceWithThousandsSeparators() {
        let suggestions = ReceiptParser.parse(lines: [
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
        let suggestions = ReceiptParser.parse(lines: [
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
        let suggestions = ReceiptParser.parse(lines: [])
        XCTAssertTrue(suggestions.isEmpty)
    }

    func testSplitLabelStillReadsAsItsWord() {
        // Vision split "Total" mid-word on the real receipt; the despaced
        // match recovers it without loosening the deliberate-spacing rules.
        let split = ReceiptParser.parse(lines: [
            RecognizedLine(text: "Tot al 15.25", verticalCenter: 0.5, height: 0.02),
        ])
        XCTAssertEqual(split.totalCents, 1525)

        // "SUB TOTAL" is still a subtotal, not a total, both spellings.
        let spaced = ReceiptParser.parse(lines: [
            RecognizedLine(text: "SUB TOTAL 10.00", verticalCenter: 0.5, height: 0.02),
        ])
        XCTAssertEqual(spaced.subtotalCents, 1000)
        XCTAssertNil(spaced.totalCents)
    }

    func testVendorSurvivesHeightJitterButYieldsToGenuinelyBiggerPrint() {
        // Same print size, measurement jitter: the address measures a few
        // percent taller, and the topmost of the near-tallest band wins.
        let jittered = ReceiptParser.parse(lines: [
            line("Corner Noodle Bar", y: 0.07, height: 0.0306),
            line("12 Main Street", y: 0.10, height: 0.0323),
        ])
        XCTAssertEqual(jittered.vendor, "Corner Noodle Bar")

        // A genuinely larger name below a small header line still wins:
        // the band excludes the small line, position never enters into it.
        let bigNameLower = ReceiptParser.parse(lines: [
            line("Welcome to", y: 0.03, height: 0.012),
            line("BIG BOX HARDWARE", y: 0.08, height: 0.045),
        ])
        XCTAssertEqual(bigNameLower.vendor, "BIG BOX HARDWARE")
    }

    // MARK: - Total heuristics

    func testTotalPrefersLabelledLineOverLargerAmountElsewhere() {
        // The card-payment line is larger than the total (cash back), but
        // the labelled line wins outright.
        let suggestions = ReceiptParser.parse(lines: [
            line("TOTAL 20.00", y: 0.70),
            line("DEBIT 40.00", y: 0.80),
        ])
        XCTAssertEqual(suggestions.totalCents, 2000)
    }

    func testTotalTakesLargestAcrossTotalLines() {
        // "TOTAL SAVINGS" is a total-labelled line too; largest-wins is the
        // §7.3 rule for exactly this.
        let suggestions = ReceiptParser.parse(lines: [
            line("TOTAL SAVINGS 5.00", y: 0.60),
            line("TOTAL 20.00", y: 0.70),
        ])
        XCTAssertEqual(suggestions.totalCents, 2000)
    }

    func testSubTotalWithASpaceIsNeverTheTotal() {
        let suggestions = ReceiptParser.parse(lines: [
            line("SUB TOTAL 10.00", y: 0.60),
            line("TOTAL 11.30", y: 0.70),
        ])
        XCTAssertEqual(suggestions.subtotalCents, 1000)
        XCTAssertEqual(suggestions.totalCents, 1130)
    }

    // MARK: - Tax heuristics

    func testBareTaxLabelCountsOnlyAwayFromTotalPhrasing() {
        let suggestions = ReceiptParser.parse(lines: [
            line("TOTAL BEFORE TAX 100.00", y: 0.60),
            line("TAX 13.00", y: 0.65),
            line("TOTAL 113.00", y: 0.70),
        ])
        XCTAssertEqual(suggestions.hstCents, 1300)
        XCTAssertEqual(suggestions.totalCents, 11300)
    }

    func testTaxableDoesNotReadAsTax() {
        let suggestions = ReceiptParser.parse(lines: [
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
        let suggestions = ReceiptParser.parse(lines: [
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
        let suggestions = ReceiptParser.parse(lines: [
            line("SUBTOTAL 12.00", y: 0.60),
            line("GST 0.60", y: 0.65),
            line("TOTAL 12.60", y: 0.70),
        ])
        XCTAssertEqual(suggestions.hstCents, 60)
    }

    func testZeroHstRowLosesToTheNonZeroGstRow() {
        // The wave-5 receipt's mirror image: the zero is the shadow, the
        // sibling label carries the tax actually charged.
        let suggestions = ReceiptParser.parse(lines: [
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
        let suggestions = ReceiptParser.parse(lines: [
            line("GST 0.60", y: 0.62),
            line("HST 2.05", y: 0.66),
            line("TOTAL 20.00", y: 0.72),
        ])
        XCTAssertEqual(suggestions.hstCents, 205)
    }

    func testAllZeroTaxRowsSuggestTheHonestZero() {
        // An exempt receipt genuinely charged no tax: zero is the truth
        // here, not a shadowing artifact.
        let suggestions = ReceiptParser.parse(lines: [
            line("GST $0.00", y: 0.62),
            line("HST $0.00", y: 0.66),
            line("TOTAL 10.00", y: 0.72),
        ])
        XCTAssertEqual(suggestions.hstCents, 0)
    }

    func testMultipleSubtotalRowsPreferTheBottomMost() {
        // The same audit's subtotal finding: section subtotals print
        // above the summary block, and the summary subtotal - the one
        // the arithmetic check compares - prints last, beside the taxes.
        let suggestions = ReceiptParser.parse(lines: [
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
        let suggestions = ReceiptParser.parse(lines: [
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
        let suggestions = ReceiptParser.parse(lines: [
            line("2026-04-02 09:12", y: 0.15),
            line("Returns until 2026-05-02", y: 0.95),
        ])
        XCTAssertEqual(suggestions.purchasedAt, "2026-04-02")
    }

    func testDateAnywhereWhenTopThirdHasNone() {
        let suggestions = ReceiptParser.parse(lines: [
            line("VENDOR", y: 0.05, height: 0.03),
            line("Date: 03/15/2026", y: 0.80),
        ])
        XCTAssertEqual(suggestions.purchasedAt, "2026-03-15")
    }

    // MARK: - Vendor heuristics

    func testVendorIsTallestTextInTopQuarter() {
        let suggestions = ReceiptParser.parse(lines: [
            line("Welcome to", y: 0.03, height: 0.01),
            line("BIG BOX HARDWARE", y: 0.07, height: 0.045),
            line("Store #42", y: 0.12, height: 0.012),
        ])
        XCTAssertEqual(suggestions.vendor, "BIG BOX HARDWARE")
    }

    func testAllDigitLinesCannotBeTheVendor() {
        let suggestions = ReceiptParser.parse(lines: [
            line("613 555 0142", y: 0.05, height: 0.05),
            line("Corner Cafe", y: 0.10, height: 0.02),
        ])
        XCTAssertEqual(suggestions.vendor, "Corner Cafe")
    }

    func testVendorOutsideTopQuarterIsNotGuessed() {
        let suggestions = ReceiptParser.parse(lines: [
            line("MID-RECEIPT BANNER", y: 0.50, height: 0.05),
        ])
        XCTAssertNil(suggestions.vendor)
    }

    func testUnsortedLinesStillParseInReadingOrder() {
        // Same grocery fixture, shuffled: the parser must sort, not trust.
        let suggestions = ReceiptParser.parse(lines: [
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
