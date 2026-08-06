import XCTest
@testable import Kept

/// The Home list's decisions: paging driven by the opaque cursor, the
/// pending badge from the list response's count, and honest failure
/// states - including the superseded-response cases GuardedReceiptLoader
/// exists for.
@MainActor
final class ReceiptListModelTests: XCTestCase {
    private var api = StubKeptAPI()

    override func setUp() {
        super.setUp()
        api = StubKeptAPI()
    }

    private func makeModel() -> ReceiptListModel {
        ReceiptListModel(api: api)
    }

    /// Routes list requests by cursor; unknown cursors fail loudly.
    private func stubPages(byCursor: [String?: ReceiptListPage]) {
        api.receiptsPageHandler = { cursor, _, _ in
            guard let page = byCursor[cursor] else {
                throw StubKeptAPI.UnstubbedCall(endpoint: "receiptsPage(cursor: \(cursor ?? "nil"))")
            }
            return page
        }
    }

    // MARK: - First load

    func testFirstPageLoadsAndCarriesThePendingCount() async {
        let confirmed = Fixtures.receipt(status: .confirmed)
        let pending = Fixtures.receipt(status: .pending)
        stubPages(byCursor: [nil: Fixtures.page([confirmed, pending], pendingCount: 14)])
        let model = makeModel()

        await model.loadFirstPage()

        XCTAssertEqual(model.phase, .loaded)
        XCTAssertEqual(model.receipts, [confirmed, pending])
        // The badge is the response's user-wide count, not a count of the
        // rows on this page.
        XCTAssertEqual(model.pendingCount, .exact(14))
    }

    func testNoReceiptsIsTheEmptyPhase() async {
        stubPages(byCursor: [nil: Fixtures.page([])])
        let model = makeModel()

        await model.loadFirstPage()

        XCTAssertEqual(model.phase, .empty)
        XCTAssertEqual(model.pendingCount, .exact(0))
    }

    func testFirstPageFailureIsTheFailedPhase() async {
        api.receiptsPageHandler = { _, _, _ in
            throw APIError.network(URLError(.notConnectedToInternet))
        }
        let model = makeModel()

        await model.loadFirstPage()

        guard case .failed = model.phase else {
            return XCTFail("Expected .failed, got \(model.phase)")
        }
        XCTAssertTrue(model.receipts.isEmpty)
        // Nothing on a failed screen is current, including the badge.
        XCTAssertEqual(model.pendingCount, .unknown)
    }

    func testFailedRefreshResetsThePendingBadgeToUnknown() async {
        let pending = Fixtures.receipt(status: .pending)
        stubPages(byCursor: [nil: Fixtures.page([pending], pendingCount: 1)])
        let model = makeModel()
        await model.loadFirstPage()
        XCTAssertEqual(model.pendingCount, .exact(1))

        api.receiptsPageHandler = { _, _, _ in
            throw APIError.network(URLError(.notConnectedToInternet))
        }
        await model.loadFirstPage()

        guard case .failed = model.phase else {
            return XCTFail("Expected .failed, got \(model.phase)")
        }
        XCTAssertEqual(model.pendingCount, .unknown)
    }

    // MARK: - Paging

    func testScrollingToLastReceiptLoadsNextPageWithCursor() async {
        let first = Fixtures.receipt()
        let last = Fixtures.receipt()
        let nextPageReceipt = Fixtures.receipt()
        stubPages(byCursor: [
            nil: Fixtures.page([first, last], nextCursor: "cursor-page-2", pendingCount: 3),
            "cursor-page-2": Fixtures.page([nextPageReceipt], pendingCount: 4),
        ])
        let model = makeModel()
        await model.loadFirstPage()

        await model.loadMoreIfNeeded(after: last)

        XCTAssertEqual(model.receipts, [first, last, nextPageReceipt])
        XCTAssertEqual(model.nextPage, .idle)
        // Each page refreshes the badge with the count it carried.
        XCTAssertEqual(model.pendingCount, .exact(4))
        let pagedCall = api.receiptsPageCalls.last
        XCTAssertEqual(pagedCall?.cursor, "cursor-page-2")
        XCTAssertNil(pagedCall?.status)
    }

    func testMidListReceiptDoesNotTriggerPaging() async {
        let first = Fixtures.receipt()
        let last = Fixtures.receipt()
        stubPages(byCursor: [nil: Fixtures.page([first, last], nextCursor: "cursor-page-2")])
        let model = makeModel()
        await model.loadFirstPage()
        let callsAfterFirstLoad = api.receiptsPageCalls.count

        await model.loadMoreIfNeeded(after: first)

        XCTAssertEqual(api.receiptsPageCalls.count, callsAfterFirstLoad)
    }

    func testExhaustedListDoesNotRequestAnotherPage() async {
        let only = Fixtures.receipt()
        stubPages(byCursor: [nil: Fixtures.page([only], nextCursor: nil)])
        let model = makeModel()
        await model.loadFirstPage()
        let callsAfterFirstLoad = api.receiptsPageCalls.count

        await model.loadMoreIfNeeded(after: only)

        XCTAssertEqual(api.receiptsPageCalls.count, callsAfterFirstLoad)
    }

    func testRefreshDiscardsAPageFetchedForTheOldList() async {
        // The interleave GuardedReceiptLoader exists for: a next-page fetch
        // is in flight when a pull-to-refresh replaces the list. The stale
        // page belongs to a list that no longer exists and must be dropped,
        // not appended. (Wave-3 reviewer finding; loader added at the
        // wave-3 gate review.)
        let originalLast = Fixtures.receipt()
        let staleReceipt = Fixtures.receipt()
        let freshReceipt = Fixtures.receipt()
        let gate = Gate()

        api.receiptsPageHandler = { cursor, _, _ in
            if cursor == "stale-cursor" {
                await gate.wait()
                return Fixtures.page([staleReceipt])
            }
            return Fixtures.page([originalLast], nextCursor: "stale-cursor")
        }
        let model = makeModel()
        await model.loadFirstPage()

        // Start paging; it parks on the gate inside the stubbed call.
        let loadMoreTask = Task { await model.loadMoreIfNeeded(after: originalLast) }
        var attempts = 0
        while !(await gate.hasWaiters) {
            attempts += 1
            if attempts > 10_000 {
                return XCTFail("loadMore never reached the stubbed request")
            }
            await Task.yield()
        }

        // Refresh while the page fetch is suspended, then release it.
        api.receiptsPageHandler = { _, _, _ in
            Fixtures.page([freshReceipt])
        }
        await model.loadFirstPage()
        await gate.open()
        await loadMoreTask.value

        XCTAssertEqual(model.receipts, [freshReceipt])
        XCTAssertEqual(model.nextPage, .idle)
    }

    func testFailedPageCanBeRetried() async {
        let last = Fixtures.receipt()
        let recovered = Fixtures.receipt()
        var pagingAttempts = 0
        api.receiptsPageHandler = { cursor, _, _ in
            if cursor == nil { return Fixtures.page([last], nextCursor: "cursor-page-2") }
            pagingAttempts += 1
            if pagingAttempts == 1 {
                throw APIError.network(URLError(.timedOut))
            }
            return Fixtures.page([recovered])
        }
        let model = makeModel()
        await model.loadFirstPage()

        await model.loadMoreIfNeeded(after: last)
        guard case .failed = model.nextPage else {
            return XCTFail("Expected .failed next page, got \(model.nextPage)")
        }

        await model.retryLoadMore()
        XCTAssertEqual(model.nextPage, .idle)
        XCTAssertEqual(model.receipts, [last, recovered])
    }
}
