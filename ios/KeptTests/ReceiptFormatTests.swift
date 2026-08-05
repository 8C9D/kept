import XCTest
@testable import Kept

/// Formatting at the edge: integer cents to currency strings, ISO dates to
/// display dates. Locales are pinned - these tests assert exact renderings,
/// and the device's settings must not be able to change what they mean.
final class ReceiptFormatTests: XCTestCase {
    private let enCA = Locale(identifier: "en_CA")
    private let enUS = Locale(identifier: "en_US")

    // MARK: - Money

    func testFormatsCadInCanadianEnglish() {
        XCTAssertEqual(ReceiptFormat.money(cents: 11300, currency: "CAD", locale: enCA), "$113.00")
    }

    func testFormatsCentsOnlyAmounts() {
        XCTAssertEqual(ReceiptFormat.money(cents: 5, currency: "CAD", locale: enCA), "$0.05")
    }

    func testFormatsNegativeAmounts() {
        // Refunds are real receipts (the wave-2 export carries one); the
        // sign must survive formatting.
        XCTAssertEqual(ReceiptFormat.money(cents: -2925, currency: "CAD", locale: enCA), "-$29.25")
    }

    func testForeignCurrencyIsDistinguishable() {
        // A US receipt must not render identically to a CAD one in a
        // Canadian locale; the exact marker ("US$") is locale data, so the
        // assertion is on the distinction, not the spelling.
        let cad = ReceiptFormat.money(cents: 999, currency: "CAD", locale: enCA)
        let usd = ReceiptFormat.money(cents: 999, currency: "USD", locale: enCA)
        XCTAssertNotEqual(cad, usd)
    }

    func testZeroFormatsAsMoneyNotBlank() {
        // A zero-total receipt is legal; it must render as an amount.
        XCTAssertEqual(ReceiptFormat.money(cents: 0, currency: "CAD", locale: enCA), "$0.00")
    }

    // MARK: - Dates

    func testFormatsPurchaseDateForDisplay() {
        XCTAssertEqual(ReceiptFormat.purchaseDate("2026-01-14", locale: enUS), "Jan 14, 2026")
    }

    func testPurchaseDateIsNotShiftedByTimeZone() {
        // The classic off-by-one: UTC midnight rendered in a western zone
        // shows the previous day. The formatter pins UTC on both sides, so
        // the calendar date survives regardless of device zone.
        XCTAssertEqual(ReceiptFormat.purchaseDate("2026-01-01", locale: enUS), "Jan 1, 2026")
    }

    func testUnparseableDateFallsBackToTheRawValue() {
        XCTAssertEqual(ReceiptFormat.purchaseDate("not-a-date", locale: enUS), "not-a-date")
    }
}
