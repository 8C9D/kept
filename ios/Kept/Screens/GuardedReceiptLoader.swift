import Foundation

/// The only route from the receipt list to the API - and the reason a
/// stale response cannot be applied by accident.
///
/// Wave 3's reviewer found the interleave (a pull-to-refresh racing an
/// in-flight page fetch spliced a stale page into a fresh list), and the
/// first fix was a generation counter checked by convention at every
/// await. This type is the second fix, from the wave-3 gate review: the
/// model holds no raw API reference, so every request necessarily comes
/// through here, and the result arrives as an `Outcome` whose
/// `.superseded` case the compiler forces callers to handle. Forgetting
/// the guard is no longer expressible.
@MainActor
final class GuardedReceiptLoader {
    enum Outcome<Value> {
        case success(Value)
        case failure(Error)
        /// A newer list load started while this request was in flight; the
        /// response belongs to a screen state that no longer exists and
        /// must not be applied.
        case superseded
    }

    private let api: any KeptAPI
    private var generation = 0

    init(api: any KeptAPI) {
        self.api = api
    }

    /// Marks the start of a load that replaces the list, invalidating
    /// every response still in flight.
    func beginNewList() {
        generation += 1
    }

    func firstPage(query: ReceiptQuery) async -> Outcome<ReceiptListPage> {
        await run { api in
            try await api.receiptsPage(cursor: nil, query: query, limit: nil)
        }
    }

    /// The query travels with the cursor deliberately: the server refuses
    /// a cursor whose encoded sort disagrees with the one sent beside it,
    /// so the two must not be able to drift apart between pages.
    func page(cursor: String, query: ReceiptQuery) async -> Outcome<ReceiptListPage> {
        await run { api in
            try await api.receiptsPage(cursor: cursor, query: query, limit: nil)
        }
    }

    /// The one place the generation is captured and re-checked. New
    /// endpoints for this screen get a method above and inherit the guard;
    /// they cannot opt out of it.
    private func run<Value>(
        _ request: (any KeptAPI) async throws -> Value
    ) async -> Outcome<Value> {
        let current = generation
        do {
            let value = try await request(api)
            guard current == generation else { return .superseded }
            return .success(value)
        } catch {
            guard current == generation else { return .superseded }
            return .failure(error)
        }
    }
}
