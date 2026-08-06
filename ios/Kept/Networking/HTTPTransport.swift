import Foundation

/// The seam between APIClient and the network. Production uses URLSession;
/// tests substitute a stub and the whole networking layer above this line
/// becomes unit-testable on the simulator (spec §10.2). Sendable because
/// APIClient is shared across actors and holds it.
protocol HTTPTransport: Sendable {
    func send(_ request: URLRequest) async throws -> (data: Data, response: HTTPURLResponse)
}

struct URLSessionTransport: HTTPTransport {
    var session: URLSession = URLSessionTransport.uncachedSession

    /// API traffic must never be answered from a local HTTP cache: with
    /// the shared session's default policy, CFNetwork heuristically
    /// cached list responses and served one to an OFFLINE pull-to-refresh
    /// as a fresh 200 - the app's failure UI never fired because the app
    /// was lied to along with the user (wave-5 device diagnostic; the
    /// server now also sends Cache-Control: no-store). No cache object
    /// and an ignore-cache policy each suffice alone; both are set so
    /// neither is load-bearing.
    static let uncachedSession: URLSession = {
        let configuration = URLSessionConfiguration.default
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        return URLSession(configuration: configuration)
    }()

    func send(_ request: URLRequest) async throws -> (data: Data, response: HTTPURLResponse) {
        let (data, response) = try await session.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            // URLSession only returns a non-HTTP response for non-HTTP URL
            // schemes, which this app never constructs; refuse loudly
            // rather than assume.
            throw APIError.network(URLError(.badServerResponse))
        }
        return (data, httpResponse)
    }
}
