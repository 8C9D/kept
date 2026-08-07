import XCTest
@testable import Kept

/// What a shipped build talks to, and what it refuses to be redirected to.
///
/// The security review's first wave-6 blocker was that the app defaulted to
/// `http://localhost:3000` with no deployed server to reach. The fix is not
/// only a different literal: in production the address stops being
/// configuration at all, so the stored override cannot move it. Both halves
/// are asserted here.
///
/// These run against `ServerEnvironment.production` explicitly rather than
/// against whatever this build is, because the test build is always the
/// Debug one - production behaviour is unreachable otherwise. Which
/// environment a build actually gets is a compile-time fact, covered by
/// `ServerConfigurationSourceTests`.
final class ServerEnvironmentTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() {
        super.setUp()
        suiteName = "ServerEnvironmentTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)
    }

    override func tearDown() {
        defaults.removePersistentDomain(forName: suiteName)
        defaults = nil
        suiteName = nil
        super.tearDown()
    }

    // MARK: - Production

    func testProductionReachesTheDeployedApiOverHttps() {
        let url = ServerEnvironment.production.baseURL
        XCTAssertEqual(url.scheme, "https")
        XCTAssertEqual(url.host, "api.keptapp.net")
    }

    func testProductionIgnoresAStoredOverride() {
        defaults.set("https://someone-elses-server.example.com", forKey: ServerConfig.defaultsKey)

        let config = ServerConfig(defaults: defaults, environment: .production)

        XCTAssertEqual(config.baseURL, ServerEnvironment.production.baseURL)
        XCTAssertEqual(
            ServerConfig.currentBaseURL(defaults: defaults, environment: .production),
            ServerEnvironment.production.baseURL,
            "The per-request read must ignore the override too - it is the one the API client uses"
        )
    }

    /// The override is what a Debug build leaves behind when the same phone
    /// later installs a shipped build. It must not carry over.
    func testProductionIgnoresAStoredPlainHttpOverride() {
        defaults.set("http://192.168.1.50:3000", forKey: ServerConfig.defaultsKey)

        XCTAssertEqual(
            ServerConfig.currentBaseURL(defaults: defaults, environment: .production),
            ServerEnvironment.production.baseURL
        )
    }

    func testProductionReportsNoOverrideEvenWithOneStored() {
        defaults.set("https://elsewhere.example.com", forKey: ServerConfig.defaultsKey)
        let config = ServerConfig(defaults: defaults, environment: .production)
        XCTAssertFalse(config.isOverridden)
    }

    // MARK: - Development

    /// The other half. Without this, deleting the override machinery
    /// entirely would satisfy every production assertion above while
    /// breaking every device run against the dev server.
    func testDevelopmentStillHonoursAStoredOverride() {
        defaults.set("http://dev-mac.local:3000", forKey: ServerConfig.defaultsKey)

        let config = ServerConfig(defaults: defaults, environment: .development)

        XCTAssertEqual(config.baseURL.absoluteString, "http://dev-mac.local:3000")
        XCTAssertTrue(config.isOverridden)
        XCTAssertEqual(
            ServerConfig.currentBaseURL(defaults: defaults, environment: .development),
            config.baseURL
        )
    }

    func testDevelopmentDefaultsToLocalhostWithNoOverride() {
        let config = ServerConfig(defaults: defaults, environment: .development)
        XCTAssertEqual(config.baseURL.absoluteString, "http://localhost:3000")
    }

    func testDevelopmentStillReportsADiscardedUnusableOverride() {
        defaults.set("not a url", forKey: ServerConfig.defaultsKey)

        let config = ServerConfig(defaults: defaults, environment: .development)

        XCTAssertEqual(config.baseURL, ServerEnvironment.development.baseURL)
        XCTAssertNotNil(config.discardedOverrideNote)
    }

    func testDevelopmentRejectsAnUnusableOverrideAtEntry() {
        let config = ServerConfig(defaults: defaults, environment: .development)
        XCTAssertThrowsError(try config.setOverride("ftp://nope"))
        XCTAssertEqual(config.baseURL, ServerEnvironment.development.baseURL)
    }
}
