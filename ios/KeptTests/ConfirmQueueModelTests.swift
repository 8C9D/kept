import XCTest
@testable import Kept

@MainActor
final class ConfirmQueueModelTests: XCTestCase {
    private var api: StubKeptAPI!
    private var queue: ConfirmQueueModel!

    override func setUp() {
        super.setUp()
        api = StubKeptAPI()
        queue = ConfirmQueueModel(api: api)
    }

    private func stubPendingList(_ receipts: [Receipt], pendingCount: Int) {
        api.receiptsPageHandler = { _, status, _ in
            XCTAssertEqual(status, .pending) // the queue only ever asks for pending
            return Fixtures.page(receipts, pendingCount: pendingCount)
        }
        api.receiptDetailHandler = { id in
            guard let receipt = receipts.first(where: { $0.id == id }) else {
                throw StubKeptAPI.UnstubbedCall(endpoint: "receiptDetail(\(id))")
            }
            return Fixtures.detail(receipt: receipt)
        }
    }

    func testLoadsTheNextPendingReceiptIntoAConfirmForm() async {
        let pending = Fixtures.receipt(isBusiness: nil, status: .pending)
        stubPendingList([pending], pendingCount: 3)

        await queue.loadNext()

        guard case .confirming(let model) = queue.phase else {
            return XCTFail("Expected confirming, got \(queue.phase)")
        }
        XCTAssertEqual(model.receiptId, pending.id)
        XCTAssertEqual(queue.pendingCount, 3)
    }

    func testEmptyQueueIsDone() async {
        stubPendingList([], pendingCount: 0)
        await queue.loadNext()

        guard case .done(let setAsideCount) = queue.phase else {
            return XCTFail("Expected done, got \(queue.phase)")
        }
        XCTAssertEqual(setAsideCount, 0)
    }

    func testSetAsideSkipsTheReceiptForTheRestOfTheSitting() async {
        let first = Fixtures.receipt(isBusiness: nil, status: .pending)
        let second = Fixtures.receipt(isBusiness: nil, status: .pending)
        stubPendingList([first, second], pendingCount: 2)

        await queue.loadNext()
        await queue.setAsideCurrent()

        guard case .confirming(let model) = queue.phase else {
            return XCTFail("Expected confirming, got \(queue.phase)")
        }
        XCTAssertEqual(model.receiptId, second.id)

        // Setting the last one aside too ends the sitting, with the count
        // stated - they are still pending server-side.
        await queue.setAsideCurrent()
        guard case .done(let setAsideCount) = queue.phase else {
            return XCTFail("Expected done, got \(queue.phase)")
        }
        XCTAssertEqual(setAsideCount, 2)
    }

    func testAFailedFetchStatesItselfAndRetries() async {
        struct Boom: LocalizedError {
            var errorDescription: String? { "no network" }
        }
        api.receiptsPageHandler = { _, _, _ in throw Boom() }

        await queue.loadNext()
        guard case .failed(let message) = queue.phase else {
            return XCTFail("Expected failed, got \(queue.phase)")
        }
        XCTAssertEqual(message, "no network")

        // Retry is the same loadNext; a recovered network proceeds.
        stubPendingList([], pendingCount: 0)
        await queue.loadNext()
        if case .done = queue.phase {} else {
            XCTFail("Expected done after retry, got \(queue.phase)")
        }
    }
}
