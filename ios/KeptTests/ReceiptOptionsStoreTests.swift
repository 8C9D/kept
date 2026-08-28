import XCTest
@testable import Kept

/// The reusable category, payment and vendor values (2026-08-26; vendors
/// joined 2026-08-28): what fills the confirm form's pickers and Home's
/// category filter.
///
/// The three properties that matter are all failure-shaped: it must never
/// block a screen, never swallow a failed fetch, and never carry one
/// account's values into another's session.
@MainActor
final class ReceiptOptionsStoreTests: XCTestCase {
    private var api: StubKeptAPI!
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() async throws {
        try await super.setUp()
        api = StubKeptAPI()
        suiteName = "ReceiptOptionsStoreTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
        try await super.tearDown()
    }

    private func makeStore() -> ReceiptOptionsStore {
        ReceiptOptionsStore(api: api, defaults: defaults)
    }

    func testAFreshStoreOffersNothingUntilAFetchLands() async {
        api.receiptOptionsHandler = {
            ReceiptOptions(categories: ["meals", "supplies"], paymentMethods: ["Visa"], vendors: ["Maple Foods"])
        }
        let store = makeStore()
        // Nothing cached, nothing fetched: the pickers are simply absent
        // and every field is plain free text.
        XCTAssertTrue(store.options.isEmpty)
        XCTAssertNil(store.lastFailure)

        await store.refresh()

        XCTAssertEqual(store.options.categories, ["meals", "supplies"])
        XCTAssertEqual(store.options.paymentMethods, ["Visa"])
        XCTAssertEqual(store.options.vendors, ["Maple Foods"])
        XCTAssertNil(store.lastFailure)
    }

    /// The offline capture-time confirm: no fetch runs on that screen, so
    /// what it offers is whatever the last successful fetch left behind.
    func testTheLastFetchIsCachedForAStoreBuiltLater() async {
        api.receiptOptionsHandler = {
            ReceiptOptions(
                categories: ["Office  supplies"],
                paymentMethods: ["Amex"],
                vendors: ["Food Basics"]
            )
        }
        await makeStore().refresh()

        // A fresh launch: a new store over the same defaults, with an API
        // that would fail if asked.
        api.receiptOptionsHandler = nil
        let relaunched = makeStore()

        // Free text verbatim, doubled space and all - it is the user's own
        // data, and normalizing it here would offer them back something
        // they never typed.
        XCTAssertEqual(relaunched.options.categories, ["Office  supplies"])
        XCTAssertEqual(relaunched.options.paymentMethods, ["Amex"])
        XCTAssertEqual(relaunched.options.vendors, ["Food Basics"])
        XCTAssertEqual(api.receiptOptionsCalls, 1, "reading the cache must not touch the network")
    }

    /// A failed fetch is a stated fact, not a silently empty list: an empty
    /// picker after a failure means something different from an empty
    /// picker on a new account, and the UI says which.
    func testAFailedFetchKeepsTheStaleValuesAndStatesTheReason() async {
        struct Boom: LocalizedError {
            var errorDescription: String? { "the network went away" }
        }
        api.receiptOptionsHandler = {
            ReceiptOptions(categories: ["meals"], paymentMethods: [], vendors: ["Corner Cafe"])
        }
        let store = makeStore()
        await store.refresh()

        api.receiptOptionsHandler = { throw Boom() }
        await store.refresh()

        XCTAssertEqual(store.options.categories, ["meals"], "stale suggestions beat none")
        XCTAssertEqual(store.options.vendors, ["Corner Cafe"], "stale suggestions beat none")
        XCTAssertEqual(store.lastFailure, "the network went away")
    }

    func testASucceedingFetchClearsAnEarlierFailure() async {
        struct Boom: LocalizedError {
            var errorDescription: String? { "nope" }
        }
        api.receiptOptionsHandler = { throw Boom() }
        let store = makeStore()
        await store.refresh()
        XCTAssertNotNil(store.lastFailure)

        api.receiptOptionsHandler = {
            ReceiptOptions(categories: ["meals"], paymentMethods: [], vendors: [])
        }
        await store.refresh()

        XCTAssertNil(store.lastFailure)
        XCTAssertEqual(store.options.categories, ["meals"])
    }

    /// Constraint 4, on the one piece of another person's data this type
    /// holds. Sign out on a shared phone and the next account must not be
    /// offered the last one's category or vendor names - from memory or
    /// from disk.
    func testSigningOutLeavesNothingBehindForTheNextAccount() async {
        api.receiptOptionsHandler = {
            ReceiptOptions(
                categories: ["business supplies"],
                paymentMethods: ["Visa"],
                vendors: ["Shoppers Drug Mart"]
            )
        }
        let store = makeStore()
        await store.refresh()
        XCTAssertFalse(store.options.isEmpty)

        store.clear()

        XCTAssertTrue(store.options.isEmpty)
        XCTAssertNil(store.lastFailure)
        // And the cache too: a new store over the same defaults - which is
        // what the next sign-in on this phone reads - starts empty.
        XCTAssertTrue(makeStore().options.isEmpty)
    }

    /// A cache written by a build with a different shape, or edited from
    /// outside, is not worth a failure state: there is nothing to tell the
    /// person, and the next refresh replaces it.
    func testAnUnreadableCacheIsIgnoredRatherThanFatal() {
        defaults.set(Data("not json".utf8), forKey: ReceiptOptionsStore.defaultsKey)

        let store = makeStore()

        XCTAssertTrue(store.options.isEmpty)
        XCTAssertNil(store.lastFailure)
    }
}
