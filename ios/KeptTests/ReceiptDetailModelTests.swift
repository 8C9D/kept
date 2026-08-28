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
        let model = ReceiptDetailModel(api: api, eventLogger: EventLogger(api: api))

        await model.load(id: receipt.id)

        XCTAssertEqual(model.phase, .loaded(detail))
    }

    func testFailureIsTheFailedPhaseWithTheMappedMessage() async {
        let api = StubKeptAPI()
        api.receiptDetailHandler = { _ in
            throw APIError.requestFailed(code: "not_found", message: "Not found", status: 404)
        }
        let model = ReceiptDetailModel(api: api, eventLogger: EventLogger(api: api))

        await model.load(id: UUID())

        XCTAssertEqual(model.phase, .failed("Not found"))
    }

    // MARK: - Delete (spec §10B: soft delete)

    func testDeleteCallsTheAPIWithTheReceiptIdAndReportsSuccess() async {
        let api = StubKeptAPI()
        let id = UUID()
        api.deleteReceiptHandler = { _ in }
        let model = ReceiptDetailModel(api: api, eventLogger: EventLogger(api: api))

        let succeeded = await model.delete(id: id)

        XCTAssertTrue(succeeded)
        XCTAssertEqual(api.deleteReceiptCalls, [id])
        XCTAssertNil(model.deleteError)
        XCTAssertFalse(model.isDeleting)
    }

    func testDeleteFailureIsReportedAndNothingIsClaimedSucceeded() async {
        let api = StubKeptAPI()
        api.deleteReceiptHandler = { _ in
            throw APIError.requestFailed(code: "not_found", message: "Receipt not found", status: 404)
        }
        let model = ReceiptDetailModel(api: api, eventLogger: EventLogger(api: api))

        let succeeded = await model.delete(id: UUID())

        XCTAssertFalse(succeeded)
        XCTAssertEqual(model.deleteError, "Receipt not found")
    }

    func testClearDeleteErrorResetsTheFailureState() async {
        let api = StubKeptAPI()
        api.deleteReceiptHandler = { _ in
            throw APIError.requestFailed(code: "not_found", message: "Receipt not found", status: 404)
        }
        let model = ReceiptDetailModel(api: api, eventLogger: EventLogger(api: api))
        _ = await model.delete(id: UUID())
        XCTAssertNotNil(model.deleteError)

        model.clearDeleteError()

        XCTAssertNil(model.deleteError)
    }

    func testASecondDeleteWhileOneIsInFlightIsANoOp() async {
        let api = StubKeptAPI()
        let gate = Gate()
        api.deleteReceiptHandler = { _ in
            await gate.wait()
        }
        let model = ReceiptDetailModel(api: api, eventLogger: EventLogger(api: api))

        async let first = model.delete(id: UUID())
        // Give the first call a chance to set isDeleting before the
        // second is attempted - the guard this asserts exists precisely
        // so a double-tapped delete button cannot fire two requests.
        while await !gate.hasWaiters {
            await Task.yield()
        }
        let second = await model.delete(id: UUID())
        XCTAssertFalse(second)
        XCTAssertEqual(api.deleteReceiptCalls.count, 1)

        await gate.open()
        _ = await first
    }
}
