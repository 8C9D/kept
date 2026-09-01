import Foundation

/// State and decisions for the Home receipt list: what to fetch, when the
/// next page loads, what the pending count is. HomeView renders this and
/// decides nothing.
///
/// Concurrency: everything runs on the main actor, but each `await` is a
/// suspension point where another load can start - a pull-to-refresh while
/// a page fetch is in flight, for instance. The model therefore talks to
/// the API only through GuardedReceiptLoader, which stamps every request
/// with a load generation and reports a response overtaken by a newer
/// load as `.superseded` - an outcome the switch below cannot ignore.
@MainActor
final class ReceiptListModel: ObservableObject {
    /// The list as a whole. One enum, so "loading and failed at once" is
    /// unrepresentable.
    enum Phase: Equatable {
        case loading
        case empty
        case loaded
        case failed(String)
    }

    /// The state of fetching the page after the ones on screen.
    enum NextPage: Equatable {
        case idle
        case loading
        case failed(String)
    }

    /// The pending badge's number, from the list response's user-wide
    /// count. `unknown` is the stated truth when the list itself failed -
    /// never a quiet zero.
    enum PendingCount: Equatable {
        case exact(Int)
        case unknown
    }

    @Published private(set) var phase: Phase = .loading
    @Published private(set) var receipts: [Receipt] = []
    @Published private(set) var pendingCount: PendingCount = .exact(0)
    @Published private(set) var nextPage: NextPage = .idle
    /// Proposal #3 (2026-08-28): the running totals for the CURRENT
    /// filter (`query` below), fetched from GET /api/receipts/summary
    /// alongside the first page and re-fetched on every filter change -
    /// never computed from `receipts`, which is one 50-row page and would
    /// silently answer a different, narrower question than "the whole
    /// filter". `nil` is the resting state for three different reasons -
    /// nothing has loaded yet, the first page itself failed, or the
    /// summary fetch failed on its own - and HomeView degrades to no
    /// summary block for all three without needing to tell them apart:
    /// this is pure enhancement over the list, never load-bearing for it.
    @Published private(set) var summary: ReceiptSummary?

    /// What the list is currently asking the server for. Changed only
    /// through the methods below, each of which restarts from page one -
    /// a cursor encodes the sort position of the result set it came from,
    /// and the server refuses one minted under a different sort.
    @Published private(set) var query: ReceiptQuery = .default

    /// The search box's live text, bound straight to `.searchable`. It is
    /// not the query: the view debounces it and calls `applySearch()`,
    /// so a person typing "coffee" costs one request, not six.
    @Published var searchText: String = ""

    /// One outstanding swipe-to-delete undo opportunity (proposal #9,
    /// 2026-08-28) - what HomeView's toast renders and drives. The
    /// proposal's own gate, stated in full: a delete is soft server-side
    /// (§10B) and so recoverable in principle, but nothing exposed getting
    /// it back before this - a mis-swipe against a tax record was a
    /// one-gesture accident. `POST /api/receipts/:id/restore`
    /// (server/src/routes/receipts.ts) is the undo path this drives.
    struct PendingUndo: Equatable {
        let receiptId: UUID
        /// What the toast names - the vendor if there is one, "Receipt"
        /// otherwise - so "Receipt deleted" reads as which one when more
        /// than one delete happens in a session, the same identifying text
        /// the row itself showed a moment ago.
        let label: String
    }

    @Published private(set) var pendingUndo: PendingUndo?
    /// The reason a swipe-triggered delete, undo, or quick-confirm did not
    /// happen - the server's own words when there are any
    /// (`APIError.requestFailed`'s `errorDescription` already carries the
    /// message verbatim, spec: never invent wording, most pointedly for
    /// 409 `restore_conflict`), a transport failure's otherwise. One
    /// property for all three actions, the same shape
    /// `ReceiptDetailModel.deleteError` already uses for its own single
    /// mutation - HomeView shows it as one alert.
    @Published private(set) var actionError: String?

    private var nextCursor: String?
    private let loader: GuardedReceiptLoader
    private let eventLogger: EventLogger
    /// Held directly, alongside `loader`, ONLY for the three swipe actions
    /// below (delete, undo, quick-confirm) - one-off, id-scoped mutations,
    /// not list-page fetches. Deliberately NOT routed through
    /// `GuardedReceiptLoader`: that type's generation guard exists to drop
    /// a stale LIST response after a NEWER list load starts
    /// (`beginNewList()`), and applying the identical guard to a mutation
    /// would risk marking a delete or restore that genuinely reached the
    /// server as `.superseded` merely because a pull-to-refresh happened
    /// to land in the same async gap - silently skipping the undo toast
    /// (or the reload) for a mutation that actually succeeded. The exact
    /// same reasoning `ReceiptDetailModel` already applies to ITS own
    /// delete: a straight `api` reference for a mutation, not the paging
    /// loader's guard.
    private let api: any KeptAPI

    init(api: any KeptAPI, eventLogger: EventLogger) {
        loader = GuardedReceiptLoader(api: api)
        self.api = api
        self.eventLogger = eventLogger
    }

    /// First page; also the refresh path - pull-to-refresh re-runs it,
    /// replacing the list. On failure the stale rows would render as if
    /// they were current, so they are dropped in favour of the failure
    /// and Retry.
    func loadFirstPage() async {
        loader.beginNewList()
        // Dropped before the await, not after: the rows on screen still
        // belong to the old result set, and a scroll reaching the last of
        // them mid-flight would otherwise page with a cursor this request
        // is about to invalidate.
        nextCursor = nil
        nextPage = .idle
        if receipts.isEmpty {
            phase = .loading
        }

        switch await loader.firstPage(query: query) {
        case .superseded:
            return
        case .failure(let error):
            receipts = []
            nextCursor = nil
            nextPage = .idle
            pendingCount = .unknown
            summary = nil
            phase = .failed(error.localizedDescription)
            return
        case .success(let page):
            receipts = page.receipts
            nextCursor = page.nextCursor
            nextPage = .idle
            pendingCount = .exact(page.pendingCount)
            phase = receipts.isEmpty ? .empty : .loaded
        }

        await loadSummary()
    }

    /// Proposal #3's fetch, run after the page itself settles - nothing on
    /// screen needs the summary before the list is showing something, and
    /// sequencing keeps this load's superseded-guard story identical to
    /// every other one here (one outcome to switch on, not two interleaved
    /// requests racing each other into `summary`). Not called from
    /// `loadMore()`: paging never changes the filter, so the totals it
    /// already has are still the right answer (spec: "never compute
    /// totals from the loaded page... re-fetch when the filter changes" -
    /// this is the re-fetch; paging is the case where nothing changed).
    ///
    /// A failed fetch degrades to no summary - the proposal's own brief:
    /// this must never break the list - so `summary` simply becomes nil
    /// and nothing here surfaces the error, the same "never blocks, never
    /// invents" shape ReceiptOptionsStore already uses for a fetch that is
    /// pure enhancement rather than load-bearing.
    private func loadSummary() async {
        switch await loader.summary(query: query) {
        case .superseded, .failure:
            summary = nil
        case .success(let value):
            summary = value
        }
    }

    /// Row-appearance hook: fetch more only when the given receipt is the
    /// last one on screen and a next page exists.
    func loadMoreIfNeeded(after receipt: Receipt) async {
        guard receipt.id == receipts.last?.id else { return }
        await loadMore()
    }

    func retryLoadMore() async {
        await loadMore()
    }

    // MARK: - Search, sort, filter

    /// The debounced search box landing. A no-op when the term has not
    /// actually changed, so the view can call it freely - including the
    /// first time the field appears, which is not a search.
    func applySearch() async {
        // Copied from the current query and amended, never rebuilt field
        // by field: a rebuild silently resets whatever the next filter to
        // be added forgets to list.
        var pending = query
        pending.search = searchText
        guard pending.searchTerm != query.searchTerm else { return }
        await apply(pending, logging: .listSearched)
    }

    func setStatus(_ status: ReceiptStatus?) async {
        var pending = query
        pending.status = status
        await apply(pending, logging: .listFiltered)
    }

    func setCategory(_ category: String?) async {
        var pending = query
        pending.category = category
        await apply(pending, logging: .listFiltered)
    }

    func setPaymentMethod(_ paymentMethod: String?) async {
        var pending = query
        pending.paymentMethod = paymentMethod
        await apply(pending, logging: .listFiltered)
    }

    /// Both bounds in one call: the range sheet applies its two pickers
    /// together, so a range being narrowed costs one request rather than
    /// one per end - and never passes through a half-applied range that
    /// would fetch rows nobody asked for.
    func setDateRange(from: String?, to: String?) async {
        var pending = query
        pending.from = from
        pending.to = to
        await apply(pending, logging: .listFiltered)
    }

    func setSort(_ sort: ReceiptQuery.Sort) async {
        var pending = query
        pending.sort = sort
        // The new key's own natural direction, not the previous key's
        // (ReceiptQuery.Sort.naturalOrder states why): picking "Vendor"
        // off a date sort used to inherit "newest first" and serve the
        // alphabet backwards. One request either way - order travels with
        // the sort in the same `apply`, so this never fetches twice.
        pending.order = sort.naturalOrder
        await apply(pending, logging: .listSorted)
    }

    func setOrder(_ order: ReceiptQuery.Order) async {
        var pending = query
        pending.order = order
        await apply(pending, logging: .listSorted)
    }

    /// Clears every narrowing filter, ordering left alone - the "Show all"
    /// escape from a filter set that has hidden everything.
    func clearFilters() async {
        var pending = query
        pending.search = ""
        pending.status = nil
        pending.category = nil
        pending.paymentMethod = nil
        pending.from = nil
        pending.to = nil
        searchText = ""
        await apply(pending, logging: .listFiltered)
    }

    /// One route for every query change, so none of them can forget to
    /// start again from page one. `logging` is the behavioural-telemetry
    /// event (2026-08-28) to fire, and only when the query actually
    /// changed - re-picking the sort already in effect, say, is not a
    /// person doing anything worth counting.
    private func apply(_ pending: ReceiptQuery, logging event: EventAction) async {
        guard pending != query else { return }
        query = pending
        eventLogger.log(event)
        await loadFirstPage()
    }

    // MARK: - Paging

    private func loadMore() async {
        guard let cursor = nextCursor, nextPage != .loading else { return }
        nextPage = .loading
        switch await loader.page(cursor: cursor, query: query) {
        case .superseded:
            // A refresh replaced the list while this page was in flight;
            // the refresh path owns nextPage now.
            return
        case .failure(let error):
            nextPage = .failed(error.localizedDescription)
        case .success(let page):
            receipts.append(contentsOf: page.receipts)
            nextCursor = page.nextCursor
            nextPage = .idle
            // Every page carries the badge's number; applying it keeps the
            // count fresh as the user scrolls.
            pendingCount = .exact(page.pendingCount)
        }
    }

    // MARK: - Swipe actions: delete with undo, quick confirm (proposal #9, 2026-08-28)

    /// Swipe-to-delete: soft-deletes the receipt (§10B - tombstoned, kept
    /// for retention, never erased) and reloads the list the same way
    /// every other mutation that can change it already does
    /// (HomeView.onDeleted, the confirm queue's own completion) - never a
    /// local splice, so a deleted row cannot linger as a stale one and the
    /// keyset cursor never disagrees with what is on screen. Records the
    /// undo opportunity only once the delete - and so the reload - has
    /// actually happened; a failed delete leaves the row exactly where it
    /// was, with nothing to undo.
    func deleteReceipt(_ receipt: Receipt) async {
        do {
            try await api.deleteReceipt(id: receipt.id)
            eventLogger.log(.receiptDeleted, receiptId: receipt.id)
            pendingUndo = PendingUndo(receiptId: receipt.id, label: receipt.displayVendor ?? "Receipt")
            await loadFirstPage()
        } catch {
            actionError = error.localizedDescription
        }
    }

    /// The toast's Undo action. Clears the opportunity FIRST, unconditionally
    /// - a failed restore is not silently retryable by tapping Undo again
    /// against stale state, matching `ReceiptDetailModel.delete()`'s own
    /// `guard !isDeleting` shape for "a mutation may only be attempted
    /// once per opportunity." Can legitimately fail with 409
    /// `restore_conflict` (KeptAPI.restoreReceipt's own doc comment
    /// carries the trap in full); either way the message reaching
    /// `actionError` is the server's own, never reworded.
    func undoDelete() async {
        guard let pending = pendingUndo else { return }
        pendingUndo = nil
        do {
            _ = try await api.restoreReceipt(id: pending.receiptId)
            await loadFirstPage()
        } catch {
            actionError = error.localizedDescription
        }
    }

    /// The toast's timeout path (HomeView, `.task(id: model.pendingUndo)`)
    /// - simply clears whatever `pendingUndo` currently holds. A NEWER
    /// delete replacing `pendingUndo` while an older timer is still
    /// running cancels that timer by construction (`.task(id:)` restarts
    /// on every id change), so this can never clear an undo opportunity
    /// other than the one its own timer was watching.
    func dismissUndo() {
        pendingUndo = nil
    }

    func clearActionError() {
        actionError = nil
    }

    /// Swipe-to-confirm's "quick confirm": saves **what the row was
    /// showing** as final - the served §7.3 merge, which is what
    /// `ReceiptDisplay` renders and therefore what the person actually
    /// looked at before swiping (2026-09-01; before that this sent
    /// `status` alone and saved the stored column instead, so a row reading
    /// `JIMMY THE GREEK` confirmed as `In Store 392`). See
    /// `QuickConfirmRequest` for why absent keys, not nulls. Reloads the
    /// list the same way every mutation here does.
    ///
    /// Offered by the view whenever `receipt.canQuickConfirm`
    /// (ReceiptDisplay.swift) - a VISIBLE total, since this request now
    /// sends that total and so satisfies the server's own check on its own.
    /// `confirm_saved` is the closest fit in the server's fixed vocabulary
    /// (server/src/domain/userEvents.ts) - a receipt was confirmed and
    /// saved, which is exactly what happened, whichever screen it happened
    /// from; there is no separate action name for "confirmed without
    /// opening the form" to invent one for, per the brief's own rule.
    func quickConfirmReceipt(_ receipt: Receipt) async {
        do {
            _ = try await api.quickConfirmReceipt(id: receipt.id, QuickConfirmRequest(displaying: receipt))
            eventLogger.log(.confirmSaved, receiptId: receipt.id)
            await loadFirstPage()
        } catch {
            actionError = error.localizedDescription
        }
    }
}
