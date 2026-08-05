import XCTest
@testable import Kept

/// The real keychain, on the simulator, under a test-only service name so
/// the app's actual token slot is never touched. This is deliberately not
/// a stub: the store's SecItem plumbing is exactly what these tests exist
/// to prove.
final class KeychainSessionTokenStoreTests: XCTestCase {
    private var store = KeychainSessionTokenStore(service: "com.arthurzhang.kept.tests")

    override func setUpWithError() throws {
        try super.setUpWithError()
        store = KeychainSessionTokenStore(service: "com.arthurzhang.kept.tests")
        try store.clear()
    }

    override func tearDownWithError() throws {
        try store.clear()
        try super.tearDownWithError()
    }

    func testLoadIsNilWhenNothingStored() throws {
        XCTAssertNil(try store.load())
    }

    func testSaveThenLoadRoundTrips() throws {
        try store.save("first-session-token")
        XCTAssertEqual(try store.load(), "first-session-token")
    }

    func testSaveOverwritesExistingToken() throws {
        try store.save("first-session-token")
        try store.save("second-session-token")
        XCTAssertEqual(try store.load(), "second-session-token")
    }

    func testClearRemovesToken() throws {
        try store.save("first-session-token")
        try store.clear()
        XCTAssertNil(try store.load())
    }

    func testClearingNothingIsNotAnError() throws {
        try store.clear()
        try store.clear()
    }

    func testStoresAreIsolatedByService() throws {
        let other = KeychainSessionTokenStore(service: "com.arthurzhang.kept.tests-other")
        defer { try? other.clear() }

        try store.save("token-in-main-test-store")
        XCTAssertNil(try other.load())
    }
}
