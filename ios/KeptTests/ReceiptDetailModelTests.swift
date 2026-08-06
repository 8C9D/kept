import XCTest
@testable import Kept

@MainActor
final class ReceiptDetailModelTests: XCTestCase {
    func testLoadedDetailIsExposed() async {
        let api = StubKeptAPI()
        let receipt = Fixtures.receipt()
        let detail = Fixtures.detail(receipt: receipt, ocrRawText: "RAW")
        api.receiptDetailHandler = { id in
            XCTAssertEqual(id, receipt.id)
            return detail
        }
        let model = ReceiptDetailModel(api: api)

        await model.load(id: receipt.id)

        XCTAssertEqual(model.phase, .loaded(detail))
    }

    func testFailureIsTheFailedPhaseWithTheMappedMessage() async {
        let api = StubKeptAPI()
        api.receiptDetailHandler = { _ in
            throw APIError.requestFailed(code: "not_found", message: "Not found", status: 404)
        }
        let model = ReceiptDetailModel(api: api)

        await model.load(id: UUID())

        XCTAssertEqual(model.phase, .failed("Not found"))
    }
}
