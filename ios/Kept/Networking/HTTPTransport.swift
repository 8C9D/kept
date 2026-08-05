import Foundation

/// The seam between APIClient and the network. Production uses URLSession;
/// tests substitute a stub and the whole networking layer above this line
/// becomes unit-testable on the simulator (spec §10.2).
protocol HTTPTransport {
    func send(_ request: URLRequest) async throws -> (data: Data, response: HTTPURLResponse)
}

struct URLSessionTransport: HTTPTransport {
    var session: URLSession = .shared

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
