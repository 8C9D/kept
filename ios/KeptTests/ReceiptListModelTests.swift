import XCTest
@testable import Kept

/// The Home list's decisions: paging driven by the opaque cursor, the
/// pending badge from the list response's count, and honest failure
/// states - including the superseded-response cases GuardedReceiptLoader
/// exists for.
@MainActor
final class ReceiptListModelTests: XCTestCase {
    private var api = StubKeptAPI()

    override func setUp() async throws {
        try await super.setUp()
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
        // The cursor travels with the query it was minted under: the
        // server refuses one whose encoded sort disagrees.
        XCTAssertEqual(pagedCall?.query, .default)
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

    // MARK: - Search, sort, filter (2026-08-26)

    /// The rule the server forces: a cursor encodes the sort position of
    /// the result set it came from, and one presented under a different
    /// sort is a 400. So every query change starts again from page one -
    /// with the old rows and the old cursor dropped, not appended to.
    func testChangingTheSortRestartsFromPageOneAndDropsTheOldCursor() async {
        let firstSet = Fixtures.receipt()
        let secondSet = Fixtures.receipt()
        api.receiptsPageHandler = { cursor, query, _ in
            if query.sort == .total {
                // The re-sorted list must be asked for from the top.
                XCTAssertNil(cursor, "a cursor from the old sort must not be reused")
                return Fixtures.page([secondSet], pendingCount: 1)
            }
            return Fixtures.page([firstSet], nextCursor: "cursor-page-2", pendingCount: 1)
        }
        let model = makeModel()
        await model.loadFirstPage()
        XCTAssertEqual(model.receipts, [firstSet])

        await model.setSort(.total)

        XCTAssertEqual(model.query.sort, .total)
        XCTAssertEqual(model.receipts, [secondSet], "the new sort replaces the list, never appends")
        XCTAssertEqual(model.nextPage, .idle)
        // And the dropped cursor stays dropped: scrolling to the bottom of
        // the new list must not resurrect it.
        let callsAfterResort = api.receiptsPageCalls.count
        await model.loadMoreIfNeeded(after: secondSet)
        XCTAssertEqual(api.receiptsPageCalls.count, callsAfterResort)
    }

    func testEachFilterAndTheOrderReachTheServerAndRestartPaging() async {
        stubPages(byCursor: [nil: Fixtures.page([Fixtures.receipt()])])
        let model = makeModel()
        await model.loadFirstPage()

        await model.setStatus(.pending)
        XCTAssertEqual(api.receiptsPageCalls.last?.query.status, .pending)

        await model.setCategory("Office  supplies")
        // Free text, unnormalized: the doubled space is the person's own
        // data and the server matches it literally.
        XCTAssertEqual(api.receiptsPageCalls.last?.query.category, "Office  supplies")

        await model.setPaymentMethod("Visa ending 3735")
        XCTAssertEqual(api.receiptsPageCalls.last?.query.paymentMethod, "Visa ending 3735")

        await model.setDateRange(from: "2026-01-01", to: "2026-03-31")
        XCTAssertEqual(api.receiptsPageCalls.last?.query.from, "2026-01-01")
        XCTAssertEqual(api.receiptsPageCalls.last?.query.to, "2026-03-31")

        await model.setOrder(.asc)
        XCTAssertEqual(api.receiptsPageCalls.last?.query.order, .asc)

        // Every one of them asked from the top.
        XCTAssertTrue(api.receiptsPageCalls.allSatisfy { $0.cursor == nil })
        // And each one narrowed rather than replaced: the filters set
        // earlier are still on the last request.
        let last = api.receiptsPageCalls.last?.query
        XCTAssertEqual(last?.status, .pending)
        XCTAssertEqual(last?.category, "Office  supplies")
        XCTAssertEqual(last?.paymentMethod, "Visa ending 3735")
    }

    /// The range sheet applies both ends together, so narrowing a range
    /// costs one request - and one paging restart - not one per end.
    func testTheDateRangeAppliesBothEndsInOneRequest() async {
        let firstSet = Fixtures.receipt()
        let inRange = Fixtures.receipt()
        api.receiptsPageHandler = { cursor, query, _ in
            guard query.from != nil || query.to != nil else {
                return Fixtures.page([firstSet], nextCursor: "cursor-page-2", pendingCount: 1)
            }
            XCTAssertNil(cursor, "a filter change must not reuse the old list's cursor")
            return Fixtures.page([inRange], pendingCount: 1)
        }
        let model = makeModel()
        await model.loadFirstPage()
        let callsBefore = api.receiptsPageCalls.count

        await model.setDateRange(from: "2026-01-01", to: "2026-03-31")

        XCTAssertEqual(api.receiptsPageCalls.count, callsBefore + 1)
        XCTAssertEqual(model.receipts, [inRange], "the narrowed list replaces, never appends")
        XCTAssertEqual(model.nextPage, .idle)
        XCTAssertTrue(model.query.isFiltering)
    }

    /// One bound on its own is a legitimate question, and clearing one end
    /// must leave the other standing.
    func testEachEndOfTheRangeIsIndependentlyClearable() async {
        stubPages(byCursor: [nil: Fixtures.page([Fixtures.receipt()])])
        let model = makeModel()
        await model.loadFirstPage()

        await model.setDateRange(from: "2026-04-01", to: nil)
        XCTAssertEqual(model.query.from, "2026-04-01")
        XCTAssertNil(model.query.to)
        XCTAssertTrue(model.query.isFiltering)

        await model.setDateRange(from: nil, to: "2026-12-31")
        XCTAssertNil(model.query.from)
        XCTAssertEqual(model.query.to, "2026-12-31")
        XCTAssertTrue(model.query.isFiltering)

        await model.setDateRange(from: nil, to: nil)
        XCTAssertFalse(model.query.isFiltering)
    }

    /// The fragility this pins: `applySearch` used to rebuild the query
    /// field by field, so every filter it forgot to list was silently
    /// reset the next time anyone typed in the search box.
    func testSearchingDoesNotDropTheFiltersAlreadyApplied() async {
        stubPages(byCursor: [nil: Fixtures.page([Fixtures.receipt()])])
        let model = makeModel()
        await model.loadFirstPage()
        await model.setStatus(.confirmed)
        await model.setCategory("meals")
        await model.setPaymentMethod("Visa")
        await model.setDateRange(from: "2026-01-01", to: "2026-03-31")

        model.searchText = "maple"
        await model.applySearch()

        let sent = api.receiptsPageCalls.last?.query
        XCTAssertEqual(sent?.searchTerm, "maple")
        XCTAssertEqual(sent?.status, .confirmed)
        XCTAssertEqual(sent?.category, "meals")
        XCTAssertEqual(sent?.paymentMethod, "Visa")
        XCTAssertEqual(sent?.from, "2026-01-01")
        XCTAssertEqual(sent?.to, "2026-03-31")
    }

    func testTheSearchBoxIsOnlyAppliedWhenTheTermActuallyChanges() async {
        stubPages(byCursor: [nil: Fixtures.page([Fixtures.receipt()])])
        let model = makeModel()
        await model.loadFirstPage()
        let callsAfterFirstLoad = api.receiptsPageCalls.count

        // The view's debounce fires on appearance too, with the term
        // unchanged; that is not a search and must cost nothing.
        await model.applySearch()
        XCTAssertEqual(api.receiptsPageCalls.count, callsAfterFirstLoad)

        // Whitespace is not a search either: `q` has a server-side minimum
        // length of 1 and an all-spaces term would be rejected.
        model.searchText = "   "
        await model.applySearch()
        XCTAssertEqual(api.receiptsPageCalls.count, callsAfterFirstLoad)

        model.searchText = "  maple  "
        await model.applySearch()
        XCTAssertEqual(api.receiptsPageCalls.count, callsAfterFirstLoad + 1)
        XCTAssertEqual(api.receiptsPageCalls.last?.query.searchTerm, "maple")
        XCTAssertTrue(model.query.isFiltering)
    }

    func testClearingFiltersEmptiesTheSearchBoxAndLeavesTheOrderingAlone() async {
        stubPages(byCursor: [nil: Fixtures.page([Fixtures.receipt()])])
        let model = makeModel()
        await model.loadFirstPage()
        await model.setSort(.vendor)
        await model.setStatus(.pending)
        await model.setCategory("meals")
        await model.setPaymentMethod("Visa")
        await model.setDateRange(from: "2026-01-01", to: "2026-03-31")
        model.searchText = "maple"
        await model.applySearch()
        XCTAssertTrue(model.query.isFiltering)

        await model.clearFilters()

        // Every one of them, in one request - a "Clear filters" that left
        // one behind is worse than none, because the list stays narrowed
        // with nothing on screen saying why.
        XCTAssertFalse(model.query.isFiltering)
        XCTAssertEqual(model.searchText, "")
        let sent = api.receiptsPageCalls.last?.query
        XCTAssertNil(sent?.status)
        XCTAssertNil(sent?.searchTerm)
        XCTAssertNil(sent?.category)
        XCTAssertNil(sent?.paymentMethod)
        XCTAssertNil(sent?.from)
        XCTAssertNil(sent?.to)
        // Ordering is not a filter and is not cleared with them.
        XCTAssertEqual(model.query.sort, .vendor)
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
