import Foundation

/// Which server the app talks to, and - the part that changed at wave 6 -
/// whether that is negotiable at runtime.
///
/// Development builds reach a backend on this Mac or on the local network,
/// and the in-app settings sheet is how a device is pointed at it. A
/// shipped build reaches exactly one address: the deployed API, over
/// https, with no way to redirect it. That is not tidiness. An unlisted
/// App Store link is installable by anyone who has it (spec §10B), and a
/// settings sheet in a shipped build is a control that sends the session
/// bearer token, and every request made with it, to an address of the
/// holder's choosing.
enum ServerEnvironment {
    /// The deployed API. One address, https, no override.
    case production
    /// A server on this Mac or the local network, overridable in-app.
    case development

    /// What this build is. The only place the compile-time condition
    /// appears, so everything below can be exercised for both cases from a
    /// test build - which is otherwise always the Debug one.
    static let current: ServerEnvironment = {
        #if DEBUG
        return .development
        #else
        return .production
        #endif
    }()

    var baseURL: URL {
        switch self {
        case .production: return Self.parsed("https://api.keptapp.net")
        case .development: return Self.parsed("http://localhost:3000")
        }
    }

    /// Only development reads the stored override. In production the
    /// address is not configuration, so a value left in UserDefaults by an
    /// earlier development build - or written there by anything else - has
    /// no effect on a shipped app.
    var allowsOverride: Bool {
        switch self {
        case .production: return false
        case .development: return true
        }
    }

    private static func parsed(_ literal: String) -> URL {
        guard let url = URL(string: literal) else {
            // A hardcoded literal that fails to parse is a programmer
            // error, impossible to hit with real data.
            preconditionFailure("Base URL literal failed to parse: \(literal)")
        }
        return url
    }
}

/// The address the API client reads, and the settings screen's model.
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

    @Published private(set) var baseURL: URL

    /// Set when a stored override could not be used and the default took
    /// its place. Shown on the settings screen: a value the user
    /// explicitly saved must not be discarded in silence. (Wave-3 reviewer
    /// finding.)
    @Published private(set) var discardedOverrideNote: String?

    private let defaults: UserDefaults
    private let environment: ServerEnvironment

    init(defaults: UserDefaults, environment: ServerEnvironment = .current) {
        self.defaults = defaults
        self.environment = environment

        guard environment.allowsOverride else {
            baseURL = environment.baseURL
            return
        }
        // setOverride validates before storing, so an unparseable stored
        // value means the defaults were edited from outside; fall back to
        // the default rather than wedging the app, and say so.
        if let stored = defaults.string(forKey: Self.defaultsKey) {
            if let url = Self.parseBaseURL(stored) {
                baseURL = url
            } else {
                baseURL = environment.baseURL
                discardedOverrideNote =
                    "The saved server address \"\(stored)\" was not usable; using the default instead."
            }
        } else {
            baseURL = environment.baseURL
        }
    }

    var defaultBaseURL: URL {
        environment.baseURL
    }

    var isOverridden: Bool {
        baseURL != environment.baseURL
    }

    /// The address APIClient's per-request closure reads. A static read of
    /// UserDefaults (thread-safe, Sendable) rather than a capture of this
    /// ObservableObject, which belongs to the UI and is not Sendable; both
    /// paths share parseBaseURL and the same environment, so they cannot
    /// disagree about validity or about whether an override counts.
    static func currentBaseURL(
        defaults: UserDefaults,
        environment: ServerEnvironment = .current
    ) -> URL {
        if environment.allowsOverride,
           let stored = defaults.string(forKey: defaultsKey),
           let url = parseBaseURL(stored) {
            return url
        }
        return environment.baseURL
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
        baseURL = environment.baseURL
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
