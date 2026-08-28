import XCTest
@testable import Kept

/// The read-only display rule (ReceiptDisplay, spec §7.1): a pending
/// receipt renders the served §7.3 merge exactly as the confirm screen
/// prefills from it - suggestion over row copy, row filling fields no
/// suggestion covers - and a confirmed receipt renders its row, which
/// holds the human's values.
final class ReceiptDisplayTests: XCTestCase {
    /// The device-pass defect verbatim: the row carries the capture-time
    /// heuristic snapshot ("Basics", a misparsed 2011 date) while the
    /// merge carries the corrections. Every screen must read the
    /// corrections.
    func testPendingRendersTheMergeOverTheRowCopy() {
        let receipt = Fixtures.receipt(
            purchasedAt: "2011-07-26",
            vendor: "Basics",
            subtotalCents: 1000,
            hstCents: 111,
            tipCents: 90,
            totalCents: 1111,
            status: .pending,
            suggestions: Fixtures.merged(
                vendor: "Food Basics",
                purchasedAt: "2026-07-26",
                totalCents: 1131,
                hstCents: 131,
                subtotalCents: 1020,
                tipCents: 150
            )
        )
        XCTAssertEqual(receipt.displayVendor, "Food Basics")
        XCTAssertEqual(receipt.displayPurchasedAt, "2026-07-26")
        XCTAssertEqual(receipt.displayTotalCents, 1131)
        XCTAssertEqual(receipt.displayHstCents, 131)
        XCTAssertEqual(receipt.displaySubtotalCents, 1020)
        XCTAssertEqual(receipt.displayTipCents, 150)
    }

    func testRowFillsFieldsNoSuggestionCovers() {
        // The merge served only a vendor; everything else falls back to
        // the row - the same per-field rule the confirm screen prefills
        // by, so the two renderings cannot disagree.
        let receipt = Fixtures.receipt(
            purchasedAt: "2026-03-20",
            vendor: "Basics",
            totalCents: 2925,
            status: .pending,
            suggestions: Fixtures.merged(vendor: "Food Basics")
        )
        XCTAssertEqual(receipt.displayVendor, "Food Basics")
        XCTAssertEqual(receipt.displayPurchasedAt, "2026-03-20")
        XCTAssertEqual(receipt.displayTotalCents, 2925)
        XCTAssertNil(receipt.displayHstCents)
        XCTAssertNil(receipt.displaySubtotalCents)
    }

    func testConfirmedRendersTheRowWhateverTheMergeSays() {
        // Confirmed receipts are swept and served suggestions too (the
        // accuracy set needs them), but the row holds what a human
        // confirmed and the merge overrides it nowhere. Since 2026-08-26 a
        // confirmed receipt is editable, which makes this the rule that
        // stops an edit being undone on screen by a stale parse.
        let receipt = Fixtures.receipt(
            purchasedAt: "2026-03-20",
            vendor: "Maple Foods",
            subtotalCents: 10000,
            hstCents: 1300,
            tipCents: 1500,
            totalCents: 11300,
            status: .confirmed,
            suggestions: Fixtures.merged(
                vendor: "Maple Foods Market",
                purchasedAt: "2026-03-22",
                totalCents: 99999,
                hstCents: 9999,
                subtotalCents: 90000,
                tipCents: 9000
            )
        )
        XCTAssertEqual(receipt.displayVendor, "Maple Foods")
        XCTAssertEqual(receipt.displayPurchasedAt, "2026-03-20")
        XCTAssertEqual(receipt.displayTotalCents, 11300)
        XCTAssertEqual(receipt.displayHstCents, 1300)
        XCTAssertEqual(receipt.displaySubtotalCents, 10000)
        XCTAssertEqual(receipt.displayTipCents, 1500)
    }

    func testPendingWithNoSuggestionSetRendersTheRow() {
        // A receipt neither parser ever saw (pre-wave-4 rows): the row is
        // all there is.
        let receipt = Fixtures.receipt(
            vendor: "Basics",
            totalCents: 2925,
            status: .pending,
            suggestions: nil
        )
        XCTAssertEqual(receipt.displayVendor, "Basics")
        XCTAssertEqual(receipt.displayPurchasedAt, "2026-03-20")
        XCTAssertEqual(receipt.displayTotalCents, 2925)
    }

    func testMergeAbsentEverywhereIsAStatedAbsenceNotAFabrication() {
        // Both parsers ran and found nothing, and the row has nothing:
        // nil reaches the views, which state the absence ("No total yet",
        // "Not recorded") rather than rendering a blank.
        let receipt = Fixtures.receipt(
            vendor: nil,
            totalCents: nil,
            status: .pending,
            suggestions: Fixtures.merged()
        )
        XCTAssertNil(receipt.displayVendor)
        XCTAssertNil(receipt.displayTotalCents)
        XCTAssertNil(receipt.displayHstCents)
        XCTAssertNil(receipt.displaySubtotalCents)
        XCTAssertNil(receipt.displayTipCents)
    }
}
