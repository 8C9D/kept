import XCTest

/// What ships, asserted as configuration.
///
/// App Transport Security is not observable from a simulator unit test -
/// there is no API that answers "would this build have been allowed to talk
/// to that host", and the shipping build is not the one running these
/// tests. So this suite reads the source tree and the project file the way
/// a reviewer would, which is framework §9.3 rule 5's substitute for a
/// behaviour a test cannot reach.
///
/// The defect being locked down: until August 2026 a single `Info.plist`
/// served both build configurations, so `NSAllowsLocalNetworking` and an
/// `NSLocalNetworkUsageDescription` reading "during development builds"
/// would have gone to TestFlight and the App Store. That was the security
/// review's wave-6 blocker, and nothing in the suite could have caught it.
final class InfoPlistConfigurationTests: XCTestCase {
    private static let iosRoot = URL(filePath: #filePath)
        .deletingLastPathComponent() // KeptTests
        .deletingLastPathComponent() // ios

    private static let releasePlist = iosRoot.appending(path: "Kept/Info.plist")
    private static let debugPlist = iosRoot.appending(path: "Kept/Info-Debug.plist")
    private static let projectFile = iosRoot.appending(path: "Kept.xcodeproj/project.pbxproj")

    private static let appTransportSecurityKey = "NSAppTransportSecurity"
    private static let localNetworkUsageKey = "NSLocalNetworkUsageDescription"

    // MARK: - What ships

    func testShippingPlistHasNoAppTransportSecurityException() throws {
        let release = try plist(at: Self.releasePlist)
        XCTAssertNil(
            release[Self.appTransportSecurityKey],
            "The Release plist must not relax App Transport Security"
        )
        XCTAssertNil(
            release[Self.localNetworkUsageKey],
            "The Release plist must not carry a local-network usage string"
        )
    }

    /// The other half, and not a formality: deleting the affordance
    /// outright would also make the test above pass, and would break every
    /// device run against the dev server on the way to doing it.
    func testDebugPlistKeepsTheLocalNetworkingException() throws {
        let debug = try plist(at: Self.debugPlist)
        let ats = try XCTUnwrap(
            debug[Self.appTransportSecurityKey] as? [String: Any],
            "Debug builds still need to reach a plain-http dev server"
        )
        XCTAssertEqual(ats["NSAllowsLocalNetworking"] as? Bool, true)
        XCTAssertNotNil(debug[Self.localNetworkUsageKey])
    }

    // MARK: - The cost of two files

    /// Two files that are meant to agree are two files that will
    /// eventually disagree - a camera usage string added to one and not
    /// the other ships an app that crashes on capture in Release only.
    func testThePlistsAgreeOnEveryOtherKey() throws {
        let release = try plist(at: Self.releasePlist)
        let debug = try plist(at: Self.debugPlist)
        let developmentOnly: Set<String> = [
            Self.appTransportSecurityKey,
            Self.localNetworkUsageKey,
        ]

        let releaseKeys = Set(release.keys)
        let debugKeys = Set(debug.keys).subtracting(developmentOnly)
        XCTAssertEqual(
            releaseKeys,
            debugKeys,
            "The two plists differ by more than the development-only keys"
        )

        // NSDictionary rather than String(describing:): a plist value can be
        // an array or a dictionary, and those describe themselves with their
        // pointer address, so two equal values would compare unequal.
        for key in releaseKeys.sorted() {
            let releaseValue = try XCTUnwrap(release[key]) as AnyObject
            let debugValue = try XCTUnwrap(debug[key]) as AnyObject
            XCTAssertTrue(
                releaseValue.isEqual(debugValue),
                "\(key) differs between the Debug and Release plists: "
                    + "\(releaseValue) vs \(debugValue)"
            )
        }
    }

    // MARK: - The wiring

    func testEachBuildConfigurationUsesItsOwnPlist() throws {
        let byConfiguration = try infoPlistFileByConfiguration()
        XCTAssertEqual(byConfiguration["Debug"], "Kept/Info-Debug.plist")
        XCTAssertEqual(byConfiguration["Release"], "Kept/Info.plist")
        XCTAssertNotEqual(
            byConfiguration["Debug"],
            byConfiguration["Release"],
            "One plist serving both configurations is the defect this suite exists for"
        )
    }

    /// The `Kept` folder is a file-system synchronized group, so anything
    /// dropped into it joins the target's resources automatically. Without
    /// an exception the debug plist would be copied into the shipping
    /// bundle - inert as configuration, but still a file describing a
    /// development server, shipped.
    func testDebugPlistIsExcludedFromTheBundle() throws {
        let project = try String(contentsOf: Self.projectFile, encoding: .utf8)
        let exceptions = try XCTUnwrap(
            project.range(of: "membershipExceptions = (")
                .map { project[$0.upperBound...] }
                .flatMap { tail in tail.range(of: ");").map { String(tail[..<$0.lowerBound]) } }
        )
        XCTAssertTrue(exceptions.contains("Info-Debug.plist"))
        XCTAssertTrue(exceptions.contains("Info.plist"))
    }

    // MARK: - Reading

    private func plist(at url: URL) throws -> [String: Any] {
        let data = try Data(contentsOf: url)
        let parsed = try PropertyListSerialization.propertyList(from: data, format: nil)
        return try XCTUnwrap(parsed as? [String: Any])
    }

    /// Pairs each `INFOPLIST_FILE` with the `name = ...` that closes its
    /// build configuration. Configurations without the setting (the test
    /// target generates its plist) simply never pair.
    private func infoPlistFileByConfiguration() throws -> [String: String] {
        let project = try String(contentsOf: Self.projectFile, encoding: .utf8)
        var result: [String: String] = [:]
        var pendingPlist: String?

        for rawLine in project.split(separator: "\n", omittingEmptySubsequences: false) {
            let line = rawLine.trimmingCharacters(in: .whitespaces)
            if let value = line.settingValue(named: "INFOPLIST_FILE") {
                pendingPlist = value
            } else if let name = line.settingValue(named: "name"), let plist = pendingPlist {
                result[name] = plist
                pendingPlist = nil
            }
        }
        return result
    }
}

private extension String {
    /// `KEY = value;` → `value`, or nil when the line is something else.
    func settingValue(named key: String) -> String? {
        let prefix = "\(key) = "
        guard hasPrefix(prefix), hasSuffix(";") else { return nil }
        return String(dropFirst(prefix.count).dropLast())
    }
}
