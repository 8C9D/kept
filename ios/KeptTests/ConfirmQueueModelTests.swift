import XCTest
@testable import Kept

@MainActor
final class ConfirmQueueModelTests: XCTestCase {
    private var api: StubKeptAPI!
    private var queue: ConfirmQueueModel!

    override func setUp() async throws {
        try await super.setUp()
        api = StubKeptAPI()
        queue = ConfirmQueueModel(api: api)
    }

    private func stubPendingList(_ receipts: [Receipt], pendingCount: Int) {
        api.receiptsPageHandler = { _, query, _ in
            // The queue only ever asks for pending, in the order Home
            // defaults to - it is the same pile, worked from the top.
            XCTAssertEqual(query.status, .pending)
            XCTAssertNil(query.searchTerm)
            XCTAssertNil(query.category)
            XCTAssertNil(query.paymentMethod)
            // No date bounds either: the queue works the whole pending
            // pile, and a range left over from Home's filters would hide
            // receipts the §5.2a badge is still counting.
            XCTAssertNil(query.from)
            XCTAssertNil(query.to)
            XCTAssertEqual(query.sort, .purchasedAt)
            XCTAssertEqual(query.order, .desc)
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
        let pending = Fixtures.receipt(status: .pending)
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

    func testHandledCountDrivesTheSummaryRule() async {
        // §10A.1: a single confirmed receipt must return straight to Home
        // (the view shows a summary only for handledCount > 1 or set-
        // asides); the model's count is what that decision reads.
        let only = Fixtures.receipt(status: .pending)
        stubPendingList([only], pendingCount: 1)

        await queue.loadNext()
        XCTAssertEqual(queue.handledCount, 0)

        stubPendingList([], pendingCount: 0)
        await queue.advanceAfterSave()

        XCTAssertEqual(queue.handledCount, 1)
        guard case .done(let setAsideCount) = queue.phase else {
            return XCTFail("Expected done, got \(queue.phase)")
        }
        XCTAssertEqual(setAsideCount, 0)
    }

    func testSetAsideSkipsTheReceiptForTheRestOfTheSitting() async {
        let first = Fixtures.receipt(status: .pending)
        let second = Fixtures.receipt(status: .pending)
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
        XCTAssertEqual(queue.handledCount, 2) // set-asides were dealt with too
    }

    /// Deleting from inside the queue moves it on exactly as a save does
    /// (2026-09-01): the receipt was dealt with, so it counts, and the
    /// next pending one is loaded. Without this the queue would sit on a
    /// row the server no longer calls pending.
    func testDeletingTheCurrentReceiptCountsAsHandledAndLoadsTheNext() async {
        let first = Fixtures.receipt(status: .pending)
        let second = Fixtures.receipt(status: .pending)
        stubPendingList([first, second], pendingCount: 2)

        await queue.loadNext()
        // The server has tombstoned the first row, so the next page no
        // longer carries it - which is what makes this different from a
        // set-aside, where the row stays pending and the queue itself has
        // to remember to skip it.
        stubPendingList([second], pendingCount: 1)
        await queue.advanceAfterDelete()

        XCTAssertEqual(queue.handledCount, 1)
        guard case .confirming(let model) = queue.phase else {
            return XCTFail("Expected confirming, got \(queue.phase)")
        }
        XCTAssertEqual(model.receiptId, second.id)

        stubPendingList([], pendingCount: 0)
        await queue.advanceAfterDelete()
        XCTAssertEqual(queue.handledCount, 2)
        guard case .done(let setAsideCount) = queue.phase else {
            return XCTFail("Expected done, got \(queue.phase)")
        }
        // Nothing was set aside: a deleted receipt is finished with, not
        // deferred, so the done screen must not claim anything is still
        // pending.
        XCTAssertEqual(setAsideCount, 0)
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
