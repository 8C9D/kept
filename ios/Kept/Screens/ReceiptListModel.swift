import Foundation

/// State and decisions for the Home receipt list: what to fetch, when the
/// next page loads, what the pending count is. HomeView renders this and
/// decides nothing.
///
/// Concurrency: everything runs on the main actor, but each `await` is a
/// suspension point where another load can start - a pull-to-refresh while
/// a page fetch is in flight, for instance. `generation` names the load
/// that currently owns the screen: it is incremented when a refresh
/// starts, captured before every await, and re-checked after, so a
/// superseded fetch discards its result instead of splicing a stale page
/// into a fresh list. (Wave-3 reviewer finding.)
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

    /// The server has no count endpoint, so the count comes from fetching
    /// the pending receipts themselves, up to one maximum-size page.
    /// Beyond that the truth is "at least N", and when the probe (or the
    /// list) fails the truth is "unknown" - stated as such, never silently
    /// rendered as zero.
    enum PendingCount: Equatable {
        case exact(Int)
        case atLeast(Int)
        case unknown
    }

    @Published private(set) var phase: Phase = .loading
    @Published private(set) var receipts: [Receipt] = []
    @Published private(set) var pendingCount: PendingCount = .exact(0)
    @Published private(set) var nextPage: NextPage = .idle

    private var nextCursor: String?
    private var generation = 0
    private let api: any KeptAPI

    /// The server's maximum list page size; requesting it makes the pending
    /// count exact for anyone with up to 200 unconfirmed receipts.
    static let pendingProbeLimit = 200

    init(api: any KeptAPI) {
        self.api = api
    }

    /// First page plus the pending probe, concurrently. Also the refresh
    /// path: pull-to-refresh re-runs it, replacing the list.
    func loadFirstPage() async {
        generation += 1
        let current = generation
        if receipts.isEmpty {
            phase = .loading
        }

        async let pendingProbe = api.receiptsPage(
            cursor: nil,
            status: .pending,
            limit: Self.pendingProbeLimit
        )

        // The list is the screen, so it succeeds or fails on its own. On a
        // failed refresh the stale rows would render as if they were
        // current, so they are dropped in favour of the failure and Retry.
        do {
            let page = try await api.receiptsPage(cursor: nil, status: nil, limit: nil)
            guard current == generation else { return }
            receipts = page.receipts
            nextCursor = page.nextCursor
            nextPage = .idle
            phase = receipts.isEmpty ? .empty : .loaded
        } catch {
            guard current == generation else { return }
            receipts = []
            nextCursor = nil
            nextPage = .idle
            pendingCount = .unknown
            phase = .failed(error.localizedDescription)
            // Returning here abandons the probe; async let cancels it on
            // the way out.
            return
        }

        // The badge is decoration on a working list; its failure must not
        // take a loaded screen down. It degrades to a stated unknown
        // instead. (Wave-3 reviewer finding.)
        do {
            let pending = try await pendingProbe
            guard current == generation else { return }
            pendingCount = pending.nextCursor == nil
                ? .exact(pending.receipts.count)
                : .atLeast(pending.receipts.count)
        } catch {
            guard current == generation else { return }
            pendingCount = .unknown
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
        let current = generation
        nextPage = .loading
        do {
            let page = try await api.receiptsPage(cursor: cursor, status: nil, limit: nil)
            // A refresh started while this page was in flight: the cursor
            // it used belongs to a list that no longer exists.
            guard current == generation else { return }
            receipts.append(contentsOf: page.receipts)
            nextCursor = page.nextCursor
            nextPage = .idle
        } catch {
            guard current == generation else { return }
            nextPage = .failed(error.localizedDescription)
        }
    }
}
