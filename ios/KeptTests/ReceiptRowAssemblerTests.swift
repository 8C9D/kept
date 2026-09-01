import XCTest
@testable import Kept

final class ReceiptRowAssemblerTests: XCTestCase {
    private func fragment(
        _ text: String, y: Double, x: Double, height: Double = 0.014
    ) -> RecognizedLine {
        RecognizedLine(text: text, verticalCenter: y, height: height, horizontalCenter: x)
    }

    func testWideGapLabelAndAmountBecomeOneRow() {
        let rows = ReceiptRowAssembler.assembleRows([
            fragment("Subtotal", y: 0.60, x: 0.15),
            fragment("13.50", y: 0.601, x: 0.85),
        ])
        XCTAssertEqual(rows.map(\.text), ["Subtotal 13.50"])
    }

    func testDistinctRowsStaySeparate() {
        let rows = ReceiptRowAssembler.assembleRows([
            fragment("Subtotal", y: 0.60, x: 0.15),
            fragment("13.50", y: 0.601, x: 0.85),
            fragment("HST", y: 0.63, x: 0.15),
            fragment("1.76", y: 0.631, x: 0.85),
        ])
        XCTAssertEqual(rows.map(\.text), ["Subtotal 13.50", "HST 1.76"])
    }

    func testFragmentsJoinLeftToRightWhateverTheInputOrder() {
        let rows = ReceiptRowAssembler.assembleRows([
            fragment("15.25", y: 0.70, x: 0.85),
            fragment("Total", y: 0.699, x: 0.15),
        ])
        XCTAssertEqual(rows.map(\.text), ["Total 15.25"])
    }

    func testRowHeightIsTheTallestFragment() {
        let rows = ReceiptRowAssembler.assembleRows([
            fragment("BIG", y: 0.05, x: 0.3, height: 0.04),
            fragment("MART", y: 0.052, x: 0.7, height: 0.012),
        ])
        XCTAssertEqual(rows.first?.height, 0.04)
    }

    /// ⚠ One pass is NOT idempotent, and this is the shape that proves it -
    /// which matters because the plumbing stored one pass as
    /// `ocr_raw_text` while the parser ran a second over the same
    /// fragments, so the text the server's LLM re-parses disagreed with the
    /// text this device read on 16 of the 130 live receipts.
    ///
    /// Here a stray unpaired amount drags the column-skew estimate, so its
    /// row lands one place off on the first pass; by the second pass the
    /// label/amount pairs have merged, the skew estimate has no column left
    /// to compute from, and the stray joins the row it belongs to.
    func testOnePassIsNotAFixedPointButAssemblyToOneIs() {
        let fragments = [
            fragment("Subtotal", y: 0.600, x: 0.15, height: 0.02),
            fragment("15.79", y: 0.588, x: 0.90, height: 0.02),
            fragment("HST", y: 0.640, x: 0.15, height: 0.02),
            fragment("2.05", y: 0.628, x: 0.90, height: 0.02),
            fragment("Total", y: 0.680, x: 0.15, height: 0.02),
            fragment("17.84", y: 0.668, x: 0.90, height: 0.02),
            fragment("17.84", y: 0.682, x: 0.90, height: 0.02),
        ]
        let once = ReceiptRowAssembler.assembleRows(fragments)
        XCTAssertEqual(once.map(\.text), ["Subtotal 15.79", "HST 2.05", "Total 17.84", "17.84"])
        XCTAssertNotEqual(
            ReceiptRowAssembler.assembleRows(once),
            once,
            "a second pass changes this receipt - which is exactly the defect"
        )

        let settled = ReceiptRowAssembler.assembledToFixedPoint(fragments)
        XCTAssertEqual(settled.map(\.text), ["Subtotal 15.79", "HST 2.05", "Total 17.84 17.84"])
        XCTAssertEqual(
            ReceiptRowAssembler.assembleRows(settled),
            settled,
            "the whole point: what the recognizer stores is what the parser reads"
        )
    }

    /// The two real-geometry device fixtures settle in one pass, and must
    /// still come out unchanged through the fixed-point path.
    func testFixedPointLeavesAlreadySettledRowsAlone() {
        let rows = ReceiptRowAssembler.assembleRows([
            fragment("Subtotal", y: 0.60, x: 0.15),
            fragment("13.50", y: 0.601, x: 0.85),
            fragment("HST", y: 0.63, x: 0.15),
            fragment("1.76", y: 0.631, x: 0.85),
        ])
        XCTAssertEqual(ReceiptRowAssembler.assembledToFixedPoint(rows), rows)
        XCTAssertEqual(ReceiptRowAssembler.assembledToFixedPoint([]), [])
    }

    func testAssemblyIsStableOnItsOwnOutput() {
        let once = ReceiptRowAssembler.assembleRows([
            fragment("Subtotal", y: 0.60, x: 0.15),
            fragment("13.50", y: 0.601, x: 0.85),
            fragment("HST", y: 0.63, x: 0.15),
            fragment("1.76", y: 0.631, x: 0.85),
        ])
        XCTAssertEqual(ReceiptRowAssembler.assembleRows(once), once)
    }

    func testSingleFragmentAndEmptyInputPassThrough() {
        let single = fragment("Thank You!", y: 0.9, x: 0.5)
        XCTAssertEqual(ReceiptRowAssembler.assembleRows([single]), [single])
        XCTAssertEqual(ReceiptRowAssembler.assembleRows([]), [])
    }
}
