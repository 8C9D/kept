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
        ReceiptListModel(api: api, eventLogger: EventLogger(api: api))
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

    /// Picking a sort key carries that key's own direction with it
    /// (2026-09-01). Vendor is the case this exists for: it used to
    /// inherit whatever the date sort was on - "newest first", i.e.
    /// descending - and serve the alphabet from Z. Every other key still
    /// resolves to descending, so nothing about the list's opening
    /// ordering moved.
    func testPickingVendorSortsAToZAndTheOtherKeysStayBiggestFirst() async {
        stubPages(byCursor: [nil: Fixtures.page([Fixtures.receipt()])])
        let model = makeModel()
        await model.loadFirstPage()
        XCTAssertEqual(model.query.order, .desc)

        await model.setSort(.vendor)
        XCTAssertEqual(model.query.order, .asc)
        XCTAssertEqual(api.receiptsPageCalls.last?.query.order, .asc)
        XCTAssertEqual(api.receiptsPageCalls.last?.query.sort, .vendor)

        await model.setSort(.total)
        XCTAssertEqual(model.query.order, .desc)
        XCTAssertEqual(api.receiptsPageCalls.last?.query.order, .desc)
    }

    /// The flip stays flipped until the sort changes again: the default is
    /// where a key opens, not a rule that overrides the person.
    func testFlippingTheOrderSurvivesUntilTheSortChangesAgain() async {
        stubPages(byCursor: [nil: Fixtures.page([Fixtures.receipt()])])
        let model = makeModel()
        await model.loadFirstPage()

        await model.setSort(.vendor)
        await model.setOrder(.desc)
        XCTAssertEqual(model.query.order, .desc)
        XCTAssertEqual(model.query.sort, .vendor)
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

    // MARK: - Running totals (proposal #3, 2026-08-28)

    /// The summary loads alongside the first page, over the identical
    /// query - confirmed-only totals, pending kept separate.
    func testSummaryLoadsAlongsideTheFirstPage() async {
        stubPages(byCursor: [nil: Fixtures.page([Fixtures.receipt()])])
        api.receiptsSummaryHandler = { _ in
            Fixtures.summary(count: 3, hstCents: 900, totalCents: 33900, pendingCount: 2)
        }
        let model = makeModel()

        await model.loadFirstPage()

        XCTAssertEqual(model.summary?.confirmed.count, 3)
        XCTAssertEqual(model.summary?.confirmed.hstCents, 900)
        XCTAssertEqual(model.summary?.confirmed.totalCents, 33900)
        // Never blended into the confirmed totals - its own number.
        XCTAssertEqual(model.summary?.pendingCount, 2)
    }

    /// Re-fetched, over the new filter, whenever the filter changes -
    /// never computed from the loaded page, which is one bounded slice.
    func testSummaryRefetchesUnderTheNewFilterWhenTheFilterChanges() async {
        stubPages(byCursor: [nil: Fixtures.page([Fixtures.receipt()])])
        api.receiptsSummaryHandler = { query in
            Fixtures.summary(count: query.status == .pending ? 0 : 5)
        }
        let model = makeModel()
        await model.loadFirstPage()
        XCTAssertEqual(model.summary?.confirmed.count, 5)

        await model.setStatus(.pending)

        XCTAssertEqual(model.summary?.confirmed.count, 0)
        XCTAssertEqual(api.receiptsSummaryCalls.last?.status, .pending)
    }

    /// The proposal's own brief, verbatim: "a failed summary fetch must
    /// not break the list." An unstubbed - and so failing - summary
    /// handler must still leave the page itself loaded and usable.
    func testAFailedSummaryFetchDegradesToNoSummaryWithoutBreakingTheList() async {
        let receipt = Fixtures.receipt()
        stubPages(byCursor: [nil: Fixtures.page([receipt])])
        // receiptsSummaryHandler deliberately left nil - StubKeptAPI
        // throws UnstubbedCall, exactly an unexpected server failure.
        let model = makeModel()

        await model.loadFirstPage()

        XCTAssertEqual(model.phase, .loaded)
        XCTAssertEqual(model.receipts, [receipt])
        XCTAssertNil(model.summary)
    }

    /// When the page itself fails, there is nothing to summarize either -
    /// a stale summary sitting over a failed, now-empty list would answer
    /// a question about rows no longer on screen.
    func testSummaryClearsWhenTheFirstPageFails() async {
        stubPages(byCursor: [nil: Fixtures.page([Fixtures.receipt()])])
        api.receiptsSummaryHandler = { _ in Fixtures.summary(count: 5) }
        let model = makeModel()
        await model.loadFirstPage()
        XCTAssertNotNil(model.summary)

        api.receiptsPageHandler = { _, _, _ in throw APIError.network(URLError(.notConnectedToInternet)) }
        await model.loadFirstPage()

        guard case .failed = model.phase else {
            return XCTFail("Expected .failed, got \(model.phase)")
        }
        XCTAssertNil(model.summary)
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

    // MARK: - Swipe to delete, with undo (proposal #9, 2026-08-28)

    func testDeleteReceiptCallsTheAPIReloadsTheListAndRecordsTheUndoOpportunity() async {
        let receipt = Fixtures.receipt(vendor: "Staples")
        stubPages(byCursor: [nil: Fixtures.page([receipt])])
        let model = makeModel()
        await model.loadFirstPage()
        api.deleteReceiptHandler = { id in XCTAssertEqual(id, receipt.id) }
        // The reload after a successful delete - the same "never a local
        // splice" rule every other list mutation in this app follows.
        stubPages(byCursor: [nil: Fixtures.page([])])

        await model.deleteReceipt(receipt)

        XCTAssertEqual(api.deleteReceiptCalls, [receipt.id])
        XCTAssertEqual(model.phase, .empty)
        XCTAssertEqual(model.pendingUndo, ReceiptListModel.PendingUndo(receiptId: receipt.id, label: "Staples"))
        XCTAssertNil(model.actionError)
    }

    /// A vendor-less receipt still names something in the toast, rather
    /// than reading as a blank subject for "deleted".
    func testDeleteReceiptWithoutAVendorLabelsTheUndoGenerically() async {
        let receipt = Fixtures.receipt(vendor: nil)
        stubPages(byCursor: [nil: Fixtures.page([receipt])])
        let model = makeModel()
        await model.loadFirstPage()
        api.deleteReceiptHandler = { _ in }
        stubPages(byCursor: [nil: Fixtures.page([])])

        await model.deleteReceipt(receipt)

        XCTAssertEqual(model.pendingUndo?.label, "Receipt")
    }

    func testDeleteReceiptFailureSurfacesTheErrorAndRecordsNoUndo() async {
        let receipt = Fixtures.receipt()
        stubPages(byCursor: [nil: Fixtures.page([receipt])])
        let model = makeModel()
        await model.loadFirstPage()
        api.deleteReceiptHandler = { _ in
            throw APIError.requestFailed(code: "not_found", message: "Receipt not found", status: 404)
        }

        await model.deleteReceipt(receipt)

        XCTAssertEqual(model.actionError, "Receipt not found")
        XCTAssertNil(model.pendingUndo)
        // Nothing was reloaded - the row a failed delete left untouched is
        // still exactly what was already on screen.
        XCTAssertEqual(model.receipts, [receipt])
    }

    func testUndoDeleteRestoresReloadsAndClearsThePendingUndo() async {
        let receipt = Fixtures.receipt()
        stubPages(byCursor: [nil: Fixtures.page([receipt])])
        let model = makeModel()
        await model.loadFirstPage()
        api.deleteReceiptHandler = { _ in }
        stubPages(byCursor: [nil: Fixtures.page([])])
        await model.deleteReceipt(receipt)
        XCTAssertNotNil(model.pendingUndo)

        api.restoreReceiptHandler = { id in
            XCTAssertEqual(id, receipt.id)
            return receipt
        }
        // The restore's own reload brings the row back.
        stubPages(byCursor: [nil: Fixtures.page([receipt])])

        await model.undoDelete()

        XCTAssertEqual(api.restoreReceiptCalls, [receipt.id])
        XCTAssertNil(model.pendingUndo)
        XCTAssertEqual(model.receipts, [receipt])
        XCTAssertNil(model.actionError)
    }

    /// The trap the brief names by name: restoring can legitimately fail
    /// with 409 `restore_conflict` because the freed image slot collided
    /// with a different receipt's live image in the meantime - the
    /// server's own explanation must reach the person UNCHANGED.
    func testUndoDeleteSurfacesARestoreConflictVerbatim() async {
        let receipt = Fixtures.receipt()
        stubPages(byCursor: [nil: Fixtures.page([receipt])])
        let model = makeModel()
        await model.loadFirstPage()
        api.deleteReceiptHandler = { _ in }
        stubPages(byCursor: [nil: Fixtures.page([])])
        await model.deleteReceipt(receipt)

        let serverMessage = "This receipt can't be restored: one of its images was re-captured " +
            "onto a different receipt after this one was deleted, so restoring " +
            "it would collide with that receipt's live image. Delete or replace " +
            "the other receipt's image first, or leave this receipt deleted."
        api.restoreReceiptHandler = { _ in
            throw APIError.requestFailed(code: "restore_conflict", message: serverMessage, status: 409)
        }

        await model.undoDelete()

        XCTAssertEqual(model.actionError, serverMessage)
        // Cleared regardless of outcome - a failed restore is not silently
        // retryable against stale state by tapping Undo again.
        XCTAssertNil(model.pendingUndo)
    }

    func testUndoDeleteWithNoPendingUndoIsANoOp() async {
        let model = makeModel()

        await model.undoDelete()

        XCTAssertTrue(api.restoreReceiptCalls.isEmpty)
    }

    func testDismissUndoClearsThePendingUndoWithoutCallingTheAPI() async {
        let receipt = Fixtures.receipt()
        stubPages(byCursor: [nil: Fixtures.page([receipt])])
        let model = makeModel()
        await model.loadFirstPage()
        api.deleteReceiptHandler = { _ in }
        stubPages(byCursor: [nil: Fixtures.page([])])
        await model.deleteReceipt(receipt)
        XCTAssertNotNil(model.pendingUndo)

        model.dismissUndo()

        XCTAssertNil(model.pendingUndo)
        XCTAssertTrue(api.restoreReceiptCalls.isEmpty)
    }

    func testClearActionErrorResetsTheFailureState() async {
        let receipt = Fixtures.receipt()
        stubPages(byCursor: [nil: Fixtures.page([receipt])])
        let model = makeModel()
        await model.loadFirstPage()
        api.deleteReceiptHandler = { _ in throw APIError.network(URLError(.notConnectedToInternet)) }
        await model.deleteReceipt(receipt)
        XCTAssertNotNil(model.actionError)

        model.clearActionError()

        XCTAssertNil(model.actionError)
    }

    // MARK: - Swipe to confirm: quick confirm (proposal #9, 2026-08-28)

    func testQuickConfirmReceiptCallsTheAPIAndReloadsTheList() async {
        let pending = Fixtures.receipt(totalCents: 1500, status: .pending)
        stubPages(byCursor: [nil: Fixtures.page([pending])])
        let model = makeModel()
        await model.loadFirstPage()
        let confirmed = Fixtures.receipt(id: pending.id, totalCents: 1500, status: .confirmed)
        api.quickConfirmReceiptHandler = { id, _ in
            XCTAssertEqual(id, pending.id)
            return confirmed
        }
        stubPages(byCursor: [nil: Fixtures.page([confirmed])])

        await model.quickConfirmReceipt(pending)

        XCTAssertEqual(api.quickConfirmReceiptCalls.map(\.id), [pending.id])
        XCTAssertEqual(model.receipts, [confirmed])
        XCTAssertNil(model.actionError)
    }

    /// The server's own 400 when the row genuinely has no total (the CHECK
    /// constraint) - reachable in principle even though HomeView is not
    /// supposed to ever offer the swipe action in that state
    /// (`Receipt.canQuickConfirm`), so the model's own failure path is
    /// still exercised and still honest rather than assumed unreachable.
    func testQuickConfirmReceiptFailureSurfacesTheError() async {
        let pending = Fixtures.receipt(status: .pending)
        stubPages(byCursor: [nil: Fixtures.page([pending])])
        let model = makeModel()
        await model.loadFirstPage()
        api.quickConfirmReceiptHandler = { _, _ in
            throw APIError.requestFailed(
                code: "invalid_request",
                message: "a confirmed receipt requires a total",
                status: 400
            )
        }

        await model.quickConfirmReceipt(pending)

        XCTAssertEqual(model.actionError, "a confirmed receipt requires a total")
        XCTAssertEqual(model.receipts, [pending], "a failed quick-confirm leaves the row untouched")
    }
}

// MARK: - Swipe-to-confirm saves what the row shows (2026-09-01)

/// The bug this fixes shipped in 1.0 (4): the Home row renders the served
/// §7.3 merge (`ReceiptDisplay`) while the swipe PATCHed `status` alone, so
/// a row reading `JIMMY THE GREEK` confirmed as `In Store 392` - the
/// capture-time heuristic's guess, still sitting in the column.
@MainActor
final class QuickConfirmDisplayedValuesTests: XCTestCase {
    private func pendingRow() -> Receipt {
        Fixtures.receipt(
            purchasedAt: "2026-08-01",
            vendor: "In Store 392",
            subtotalCents: nil,
            hstCents: nil,
            tipCents: nil,
            totalCents: nil,
            status: .pending,
            suggestions: Fixtures.merged(
                vendor: "JIMMY THE GREEK",
                purchasedAt: "2026-08-29",
                totalCents: 1749,
                hstCents: 201,
                subtotalCents: 1548,
                tipCents: 100
            )
        )
    }

    func testTheRequestCarriesTheDisplayedValues() {
        let request = QuickConfirmRequest(displaying: pendingRow())

        XCTAssertEqual(request.vendor, "JIMMY THE GREEK")
        XCTAssertEqual(request.purchasedAt, "2026-08-29")
        XCTAssertEqual(request.totalCents, 1749)
        XCTAssertEqual(request.hstCents, 201)
        XCTAssertEqual(request.subtotalCents, 1548)
        XCTAssertEqual(request.tipCents, 100)
    }

    /// A confirmed row renders its own values, never the merge (the merge
    /// is still served on confirmed receipts, for the accuracy set), so
    /// re-confirming one must not rewrite it from a parser.
    func testAConfirmedRowsRequestCarriesItsOwnValues() {
        let confirmed = Fixtures.receipt(
            purchasedAt: "2026-08-01",
            vendor: "Jimmy The Greek",
            totalCents: 1750,
            status: .confirmed,
            suggestions: Fixtures.merged(vendor: "IN STORE 392", purchasedAt: "2026-01-01", totalCents: 1)
        )
        let request = QuickConfirmRequest(displaying: confirmed)

        XCTAssertEqual(request.vendor, "Jimmy The Greek")
        XCTAssertEqual(request.purchasedAt, "2026-08-01")
        XCTAssertEqual(request.totalCents, 1750)
    }

    /// The gate widened with the request: the swipe now writes the total
    /// the server's check reads, so it can be offered wherever a total is
    /// VISIBLE rather than only where the raw column holds one.
    func testTheGateFollowsWhatTheRowShows() {
        XCTAssertTrue(pendingRow().canQuickConfirm, "a merge-supplied total is a total the swipe can save")
        XCTAssertFalse(
            Fixtures.receipt(totalCents: nil, status: .pending, suggestions: nil).canQuickConfirm,
            "no total anywhere: nothing to confirm"
        )
        XCTAssertFalse(
            Fixtures.receipt(totalCents: 1750, status: .confirmed).canQuickConfirm,
            "already confirmed"
        )
    }

    func testTheModelSendsTheRequestBuiltFromTheRow() async {
        let api = StubKeptAPI()
        let row = pendingRow()
        api.receiptsPageHandler = { _, _, _ in Fixtures.page([row]) }
        api.receiptsSummaryHandler = { _ in Fixtures.summary() }
        let model = ReceiptListModel(
            api: api,
            eventLogger: EventLogger(
                api: api,
                connectivity: StubConnectivityMonitor(),
                backgroundContinuation: StubBackgroundContinuation()
            )
        )
        await model.loadFirstPage()
        api.quickConfirmReceiptHandler = { _, _ in Fixtures.receipt(id: row.id, totalCents: 1749, status: .confirmed) }

        await model.quickConfirmReceipt(row)

        XCTAssertEqual(api.quickConfirmReceiptCalls.count, 1)
        XCTAssertEqual(api.quickConfirmReceiptCalls.first?.request.vendor, "JIMMY THE GREEK")
        XCTAssertEqual(api.quickConfirmReceiptCalls.first?.request.totalCents, 1749)
        XCTAssertNil(model.actionError)
    }
}
