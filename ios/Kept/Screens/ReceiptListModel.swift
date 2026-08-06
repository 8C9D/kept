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

    private var nextCursor: String?
    private let loader: GuardedReceiptLoader

    init(api: any KeptAPI) {
        loader = GuardedReceiptLoader(api: api)
    }

    /// First page; also the refresh path - pull-to-refresh re-runs it,
    /// replacing the list. On failure the stale rows would render as if
    /// they were current, so they are dropped in favour of the failure
    /// and Retry.
    func loadFirstPage() async {
        loader.beginNewList()
        if receipts.isEmpty {
            phase = .loading
        }

        switch await loader.firstPage() {
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

    private func loadMore() async {
        guard let cursor = nextCursor, nextPage != .loading else { return }
        nextPage = .loading
        switch await loader.page(cursor: cursor) {
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
