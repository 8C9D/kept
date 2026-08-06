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
