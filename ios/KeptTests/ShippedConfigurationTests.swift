import XCTest
@testable import Kept

/// The rest of what ships, asserted as configuration.
///
/// Companion to `InfoPlistConfigurationTests`, and for the same reason: a
/// build setting, a `#if DEBUG` fence, and a resource file's presence in a
/// bundle are all invisible to a runtime test on a simulator, and the test
/// build is always the Debug one. So this suite reads the source tree the
/// way a reviewer would (framework §9.3 rule 5).
///
/// Two defects being locked down, both wave-6 blockers from the August 2026
/// security review: an app shipping with a development server affordance,
/// and an app shipping with no privacy manifest.
final class ShippedConfigurationTests: XCTestCase {
    private static let iosRoot = URL(filePath: #filePath)
        .deletingLastPathComponent() // KeptTests
        .deletingLastPathComponent() // ios

    private static let appRoot = iosRoot.appending(path: "Kept")
    private static let privacyManifest = appRoot.appending(path: "PrivacyInfo.xcprivacy")
    private static let projectFile = iosRoot.appending(path: "Kept.xcodeproj/project.pbxproj")

    // MARK: - The build knows which environment it is

    /// The one runtime observation available: this is a Debug build, so it
    /// must resolve to `.development`. If the condition in
    /// `ServerEnvironment.current` were inverted, every ServerEnvironment
    /// test would still pass - they pass an environment in explicitly -
    /// and a device would silently talk to production. This is what catches
    /// that.
    func testThisDebugBuildResolvesToDevelopment() {
        XCTAssertEqual(ServerEnvironment.current, .development)
        XCTAssertTrue(ServerEnvironment.current.allowsOverride)
    }

    func testTheTwoEnvironmentsAreNotTheSameAddress() {
        XCTAssertNotEqual(
            ServerEnvironment.production.baseURL,
            ServerEnvironment.development.baseURL
        )
        XCTAssertFalse(ServerEnvironment.production.allowsOverride)
    }

    // MARK: - The development affordance cannot reach a shipped build

    /// Every mention of the server settings screen in app source must sit
    /// inside a `#if DEBUG` region. A single unfenced entry point puts a
    /// "point this app at another server" control in a build installable by
    /// anyone holding the unlisted link.
    ///
    /// ⚠ The label is checked as well as the type, and that is not
    /// belt-and-braces. Written against `ServerSettingsView` alone, this
    /// test passed while an unfenced `Button("Server settings")` sat in
    /// SignInView - the presentation was compiled out and the button was
    /// not, which ships a visibly dead control. The user-facing string is
    /// the affordance; the type is only how it is built.
    func testEverySettingsScreenReferenceIsFencedOutOfReleaseBuilds() throws {
        let tokens = ["ServerSettingsView", settingsButtonLabel]
        var unfenced: [String] = []

        for file in try swiftSources() {
            let source = try String(contentsOf: file, encoding: .utf8)
            for (number, line) in debugFencing(of: source)
            where tokens.contains(where: line.contains) {
                unfenced.append("\(file.lastPathComponent):\(number)")
            }
        }

        XCTAssertEqual(
            unfenced,
            [],
            "These expose the server settings screen outside a #if DEBUG region"
        )
    }

    /// The label a person taps, kept in one place so the assertion above
    /// and the one below cannot drift apart from each other.
    private let settingsButtonLabel = "\"Server settings\""

    /// And the affordance still exists in Debug - deleting it outright
    /// would also make the assertion above pass, while breaking every
    /// device run against the dev server.
    func testTheSettingsScreenStillExistsForDevelopmentBuilds() throws {
        let sources = try swiftSources()
        let presenting = sources.filter { file in
            file.lastPathComponent != "ServerSettingsView.swift"
                && ((try? String(contentsOf: file, encoding: .utf8)) ?? "")
                    .contains("ServerSettingsView()")
        }
        XCTAssertFalse(
            presenting.isEmpty,
            "No screen presents ServerSettingsView; a device can no longer be pointed at a dev server"
        )

        let labelling = sources.filter { file in
            ((try? String(contentsOf: file, encoding: .utf8)) ?? "")
                .contains(settingsButtonLabel)
        }
        XCTAssertFalse(
            labelling.isEmpty,
            "Nothing offers the settings button; the fencing test would then guard an absence"
        )
    }

    // MARK: - The privacy manifest

    func testPrivacyManifestExists() {
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: Self.privacyManifest.path(percentEncoded: false)),
            "PrivacyInfo.xcprivacy is required for submission (UserDefaults is a required-reason API)"
        )
    }

    func testPrivacyManifestDeclaresCollectionRatherThanNone() throws {
        let manifest = try plist(at: Self.privacyManifest)
        let collected = try XCTUnwrap(
            manifest["NSPrivacyCollectedDataTypes"] as? [[String: Any]]
        )
        XCTAssertFalse(
            collected.isEmpty,
            "\"Data Not Collected\" would be false - receipts are uploaded and retained six years"
        )

        let declared = Set(collected.compactMap { $0["NSPrivacyCollectedDataType"] as? String })
        // The three the security review named, verbatim from its finding 9:
        // financial info, user content, and identifiers.
        XCTAssertTrue(declared.contains("NSPrivacyCollectedDataTypeOtherFinancialInfo"))
        XCTAssertTrue(declared.contains("NSPrivacyCollectedDataTypePhotosorVideos"))
        XCTAssertTrue(declared.contains("NSPrivacyCollectedDataTypeOtherUserContent"))
        XCTAssertTrue(declared.contains("NSPrivacyCollectedDataTypeUserID"))
        // The behavioural-telemetry entry (2026-08-28, POST /api/events):
        // Product Interaction under Usage Data, declared for Analytics -
        // see PrivacyInfo.xcprivacy's own comment for why not App
        // Functionality.
        XCTAssertTrue(declared.contains("NSPrivacyCollectedDataTypeProductInteraction"))
        let productInteraction = try XCTUnwrap(
            collected.first { $0["NSPrivacyCollectedDataType"] as? String == "NSPrivacyCollectedDataTypeProductInteraction" }
        )
        XCTAssertEqual(
            productInteraction["NSPrivacyCollectedDataTypePurposes"] as? [String],
            ["NSPrivacyCollectedDataTypePurposeAnalytics"]
        )
    }

    func testEveryDeclaredDataTypeIsLinkedToIdentityAndNotUsedForTracking() throws {
        let manifest = try plist(at: Self.privacyManifest)
        let collected = try XCTUnwrap(
            manifest["NSPrivacyCollectedDataTypes"] as? [[String: Any]]
        )

        XCTAssertEqual(manifest["NSPrivacyTracking"] as? Bool, false)
        XCTAssertEqual((manifest["NSPrivacyTrackingDomains"] as? [String])?.isEmpty, true)

        for entry in collected {
            let name = (entry["NSPrivacyCollectedDataType"] as? String) ?? "unnamed"
            // Every row is joined to the Apple subject identifier; an
            // unlinked declaration would be the flattering answer and the
            // false one.
            XCTAssertEqual(entry["NSPrivacyCollectedDataTypeLinked"] as? Bool, true, "\(name)")
            XCTAssertEqual(entry["NSPrivacyCollectedDataTypeTracking"] as? Bool, false, "\(name)")
        }
    }

    func testPrivacyManifestGivesTheRequiredReasonForUserDefaults() throws {
        let manifest = try plist(at: Self.privacyManifest)
        let accessed = try XCTUnwrap(
            manifest["NSPrivacyAccessedAPITypes"] as? [[String: Any]]
        )
        let userDefaults = try XCTUnwrap(
            accessed.first {
                $0["NSPrivacyAccessedAPIType"] as? String
                    == "NSPrivacyAccessedAPICategoryUserDefaults"
            },
            "UserDefaults is used (the server address override) and is a required-reason API"
        )
        XCTAssertEqual(
            userDefaults["NSPrivacyAccessedAPITypeReasons"] as? [String],
            ["CA92.1"],
            "CA92.1 is 'accessible only to the app itself', which is what one key of app config is"
        )
    }

    /// The manifest has to be *in the bundle* to count. The `Kept` folder is
    /// a file-system synchronized group, so a file dropped in joins the
    /// target automatically - unless it is listed as a membership
    /// exception, which is exactly what the two Info.plists are.
    func testPrivacyManifestIsNotExcludedFromTheBundle() throws {
        let project = try String(contentsOf: Self.projectFile, encoding: .utf8)
        let exceptions = try XCTUnwrap(
            project.range(of: "membershipExceptions = (")
                .map { project[$0.upperBound...] }
                .flatMap { tail in tail.range(of: ");").map { String(tail[..<$0.lowerBound]) } }
        )
        XCTAssertFalse(exceptions.contains("PrivacyInfo.xcprivacy"))
    }

    // MARK: - Reading

    private func plist(at url: URL) throws -> [String: Any] {
        let data = try Data(contentsOf: url)
        let parsed = try PropertyListSerialization.propertyList(from: data, format: nil)
        return try XCTUnwrap(parsed as? [String: Any])
    }

    private func swiftSources() throws -> [URL] {
        let enumerator = try XCTUnwrap(
            FileManager.default.enumerator(at: Self.appRoot, includingPropertiesForKeys: nil)
        )
        return enumerator.compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" }
    }

    /// Every line of `source` that is NOT inside a `#if DEBUG` region,
    /// paired with its 1-based line number. Deliberately simple: it tracks
    /// `#if DEBUG` / `#else` / `#endif` nesting and nothing more, because
    /// this codebase has no other conditional compilation and a parser
    /// nobody can read would be worse than the defect it guards.
    private func debugFencing(of source: String) -> [(Int, String)] {
        var outside: [(Int, String)] = []
        var debugDepth = 0
        var nesting: [Bool] = []

        for (index, raw) in source.split(separator: "\n", omittingEmptySubsequences: false).enumerated() {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("#if") {
                let isDebug = line == "#if DEBUG"
                nesting.append(isDebug)
                if isDebug { debugDepth += 1 }
                continue
            }
            if line.hasPrefix("#endif") {
                if let wasDebug = nesting.popLast(), wasDebug { debugDepth -= 1 }
                continue
            }
            if line.hasPrefix("#else") {
                // The #else of a `#if DEBUG` is the release branch.
                if nesting.last == true { debugDepth -= 1 }
                continue
            }
            if debugDepth == 0 {
                outside.append((index + 1, String(raw)))
            }
        }
        return outside
    }
}
