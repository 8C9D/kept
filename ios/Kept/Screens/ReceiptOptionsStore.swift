import Foundation

/// The user's own previously-used categories and payment methods, offered
/// back as pickable values on the confirm form and as the Home list's
/// category filter (2026-08-26 field reduction).
///
/// Three rules shape this type:
/// - **It never blocks.** Every screen that wants options renders fully
///   without them; the fetch runs beside the screen and fills the pickers
///   when it lands. A field with no options is a plain free-text field,
///   which is the same field it has always been.
/// - **It never invents.** A failed fetch keeps whatever was cached and
///   records the reason in `lastFailure`, so an empty picker is either
///   "this person has used nothing yet" or a stated failure - never a
///   swallowed error.
/// - **It is one person's data.** The cache is wiped on sign-out and on
///   account deletion (wired in AppEnvironment): another account signing
///   in on this phone must never see the last one's category names
///   (constraint 4).
@MainActor
final class ReceiptOptionsStore: ObservableObject {
    @Published private(set) var options: ReceiptOptions
    /// Why the last refresh failed, in the server's or the transport's own
    /// words; nil once one succeeds. Read by the Home filter menu, which
    /// says "Categories unavailable" rather than showing an empty list
    /// that reads as "you have never used one".
    @Published private(set) var lastFailure: String?

    static let defaultsKey = "receiptOptionsCache"

    private let api: any KeptAPI
    private let defaults: UserDefaults
    /// Home's load and a confirm screen opening can ask at the same
    /// moment; one request answers both.
    private var isRefreshing = false

    init(api: any KeptAPI, defaults: UserDefaults) {
        self.api = api
        self.defaults = defaults
        // The last fetch, so a capture-time confirm with no connection
        // still offers something. Stale by construction, and harmless:
        // these are suggestions into a free-text field.
        options = Self.cached(in: defaults) ?? .none
    }

    func refresh() async {
        guard !isRefreshing else { return }
        isRefreshing = true
        defer { isRefreshing = false }

        do {
            let fetched = try await api.receiptOptions()
            options = fetched
            lastFailure = nil
            store(fetched)
        } catch {
            // Keep the cached values: stale suggestions beat none, and the
            // reason is stated rather than dropped.
            lastFailure = error.localizedDescription
        }
    }

    /// The account is going away from this phone. Both the live values and
    /// the cache go with it.
    func clear() {
        options = .none
        lastFailure = nil
        defaults.removeObject(forKey: Self.defaultsKey)
    }

    private func store(_ options: ReceiptOptions) {
        guard let encoded = try? JSONEncoder().encode(options) else {
            // Two arrays of strings cannot fail to encode; if that ever
            // changed, the live values still work and only the offline
            // fallback is lost.
            assertionFailure("ReceiptOptions failed to encode")
            return
        }
        defaults.set(encoded, forKey: Self.defaultsKey)
    }

    /// The last-fetched vendor list straight off disk, with no store
    /// instance and no network (2026-09-01). The outbox drain's vendor
    /// heuristic needs the person's own past vendor names
    /// (`ReceiptParser.parse`), and the drain runs offline by design - so
    /// it reads the same cache a capture-time confirm already relies on,
    /// and an empty answer simply means the geometric heuristic decides
    /// alone. Empty rather than nil for a missing cache: "no names known"
    /// and "no cache" are the same instruction to the parser.
    static func cachedVendors(in defaults: UserDefaults) -> [String] {
        cached(in: defaults)?.vendors ?? []
    }

    private static func cached(in defaults: UserDefaults) -> ReceiptOptions? {
        guard let data = defaults.data(forKey: Self.defaultsKey) else { return nil }
        // A cache written by another build, or edited from outside, is not
        // worth a failure state: there is nothing to tell the person and
        // the next refresh replaces it.
        return try? JSONDecoder().decode(ReceiptOptions.self, from: data)
    }
}
