import Foundation

/// The installed build's version, read from the app's own Info.plist -
/// the same pair TestFlight itself uses to decide whether an update is
/// offered (ios/CLAUDE.md: "TestFlight offers an update only when the
/// (CFBundleShortVersionString, CFBundleVersion) pair strictly exceeds
/// what is installed"). Telemetry needs the same pair for the same
/// reason: 1.0 (1) and 1.0 (2) are both live in the field at once (spec,
/// 2026-08-27 status), and telling them apart is most of the point of
/// sending `appVersion` at all.
///
/// No prior code in this app reads Info.plist directly - every existing
/// value from it (bundle id, encryption-exemption flag) is read by the
/// OS or by Xcode, never by this app's own Swift. This is that pattern's
/// first use, kept to the plainest form: `Bundle.main`'s own dictionary,
/// no caching, no formatter object - it is read once per app launch, not
/// once per row.
enum AppVersion {
    /// "1.0 (2)". Nil only if Info.plist is missing both keys, which
    /// would mean the bundle itself is malformed - handled rather than
    /// force-unwrapped, because a telemetry helper crashing the app it is
    /// supposed to be invisible to would be the one unforgivable failure
    /// mode for this whole feature (EventLogger's own doc comment states
    /// the same priority).
    static var current: String? {
        string(shortVersion: shortVersion, build: build)
    }

    private static var shortVersion: String? {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    }

    private static var build: String? {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
    }

    /// Split out from `current` so a test can exercise every combination
    /// without needing a Bundle whose Info.plist it controls.
    static func string(shortVersion: String?, build: String?) -> String? {
        switch (shortVersion, build) {
        case let (.some(shortVersion), .some(build)):
            return "\(shortVersion) (\(build))"
        case let (.some(shortVersion), .none):
            return shortVersion
        case let (.none, .some(build)):
            return build
        case (.none, .none):
            return nil
        }
    }
}
