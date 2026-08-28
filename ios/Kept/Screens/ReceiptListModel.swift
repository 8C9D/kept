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

    /// What the list is currently asking the server for. Changed only
    /// through the methods below, each of which restarts from page one -
    /// a cursor encodes the sort position of the result set it came from,
    /// and the server refuses one minted under a different sort.
    @Published private(set) var query: ReceiptQuery = .default

    /// The search box's live text, bound straight to `.searchable`. It is
    /// not the query: the view debounces it and calls `applySearch()`,
    /// so a person typing "coffee" costs one request, not six.
    @Published var searchText: String = ""

    private var nextCursor: String?
    private let loader: GuardedReceiptLoader
    private let eventLogger: EventLogger

    init(api: any KeptAPI, eventLogger: EventLogger) {
        loader = GuardedReceiptLoader(api: api)
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
            phase = .failed(error.localizedDescription)
        case .success(let page):
            receipts = page.receipts
            nextCursor = page.nextCursor
            nextPage = .idle
            pendingCount = .exact(page.pendingCount)
            phase = receipts.isEmpty ? .empty : .loaded
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
}
