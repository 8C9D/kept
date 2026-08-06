import Foundation

/// Which server the app talks to. The default reaches a locally running
/// backend from the simulator; a device (or a future real deployment)
/// overrides it in the in-app server settings, persisted in UserDefaults.
/// Only the address lives here - the session token is in the keychain.
final class ServerConfig: ObservableObject {
    /// The address is invalid as a server base URL. The offending input is
    /// carried so settings can say what was wrong with what.
    struct InvalidBaseURL: Error, LocalizedError {
        let input: String
        var errorDescription: String? {
            "\"\(input)\" is not a usable server address. Use a full http(s) URL, like http://localhost:3000."
        }
    }

    static let defaultsKey = "apiBaseURLOverride"

    /// Where a simulator reaches a server running on the same Mac. On a
    /// device this default is knowingly wrong - there is no address that
    /// could be right - and the server settings screen is the fix.
    static let defaultBaseURL: URL = {
        guard let url = URL(string: "http://localhost:3000") else {
            // A hardcoded literal that fails to parse is a programmer
            // error, impossible to hit with real data.
            preconditionFailure("Default base URL literal failed to parse")
        }
        return url
    }()

    @Published private(set) var baseURL: URL

    /// Set when a stored override could not be used and the default took
    /// its place. Shown on the settings screen: a value the user
    /// explicitly saved must not be discarded in silence. (Wave-3 reviewer
    /// finding.)
    @Published private(set) var discardedOverrideNote: String?

    private let defaults: UserDefaults

    init(defaults: UserDefaults) {
        self.defaults = defaults
        // setOverride validates before storing, so an unparseable stored
        // value means the defaults were edited from outside; fall back to
        // the default rather than wedging the app, and say so.
        if let stored = defaults.string(forKey: Self.defaultsKey) {
            if let url = Self.parseBaseURL(stored) {
                baseURL = url
            } else {
                baseURL = Self.defaultBaseURL
                discardedOverrideNote =
                    "The saved server address \"\(stored)\" was not usable; using the default instead."
            }
        } else {
            baseURL = Self.defaultBaseURL
        }
    }

    var isOverridden: Bool {
        baseURL != Self.defaultBaseURL
    }

    /// The address APIClient's per-request closure reads. A static read of
    /// UserDefaults (thread-safe, Sendable) rather than a capture of this
    /// ObservableObject, which belongs to the UI and is not Sendable; both
    /// paths share parseBaseURL, so they cannot disagree about validity.
    static func currentBaseURL(defaults: UserDefaults) -> URL {
        if let stored = defaults.string(forKey: defaultsKey),
           let url = parseBaseURL(stored) {
            return url
        }
        return defaultBaseURL
    }

    func setOverride(_ input: String) throws {
        guard let url = Self.parseBaseURL(input) else {
            throw InvalidBaseURL(input: input)
        }
        defaults.set(url.absoluteString, forKey: Self.defaultsKey)
        baseURL = url
        discardedOverrideNote = nil
    }

    func resetToDefault() {
        defaults.removeObject(forKey: Self.defaultsKey)
        baseURL = Self.defaultBaseURL
        discardedOverrideNote = nil
    }

    /// A usable base URL is http or https and names a host. Anything else -
    /// a bare word, a mistyped scheme - is rejected at entry, not
    /// discovered as a confusing network error later.
    private static func parseBaseURL(_ input: String) -> URL? {
        let trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let url = URL(string: trimmed),
              let scheme = url.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = url.host, !host.isEmpty else {
            return nil
        }
        return url
    }
}
