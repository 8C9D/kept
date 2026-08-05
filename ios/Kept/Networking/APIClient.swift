import Foundation

/// The one place requests are built, the session token is attached, and
/// responses - success or failure - are interpreted. Endpoint methods
/// (APIClient+Endpoints) say *what* to call; everything about *how* lives
/// here, so there is exactly one implementation of auth and error handling
/// rather than one per call site.
final class APIClient {
    /// Read per request rather than captured once, so changing the server
    /// address in settings applies to the next request immediately.
    private let baseURL: () -> URL
    private let transport: HTTPTransport
    private let tokenStore: SessionTokenStore

    /// Fired when the server rejects the session (or none is stored) so the
    /// app can return to signed-out. Set after construction by the
    /// composition root, because the SessionController that handles it is
    /// itself constructed with this client.
    var onSessionRejected: (@MainActor () -> Void)?

    init(baseURL: @escaping () -> URL, transport: HTTPTransport, tokenStore: SessionTokenStore) {
        self.baseURL = baseURL
        self.transport = transport
        self.tokenStore = tokenStore
    }

    // MARK: - Requests

    func get<Response: Decodable>(
        _ path: String,
        query: [URLQueryItem] = []
    ) async throws -> Response {
        try await perform(method: "GET", path: path, query: query, body: nil, requiresSession: true)
    }

    func post<Body: Encodable, Response: Decodable>(
        _ path: String,
        body: Body,
        requiresSession: Bool = true
    ) async throws -> Response {
        let bodyData = try Self.encoder.encode(body)
        return try await perform(method: "POST", path: path, query: [], body: bodyData, requiresSession: requiresSession)
    }

    private func perform<Response: Decodable>(
        method: String,
        path: String,
        query: [URLQueryItem],
        body: Data?,
        requiresSession: Bool
    ) async throws -> Response {
        var request = URLRequest(url: url(path: path, query: query))
        request.httpMethod = method
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        if requiresSession {
            // A missing token on a session-only call means the app thinks
            // it is signed in but has nothing to prove it - the same dead
            // end as a rejected token, handled the same way.
            guard let token = try tokenStore.load() else {
                await rejectSession()
                throw APIError.sessionRejected
            }
            request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let data: Data
        let response: HTTPURLResponse
        do {
            (data, response) = try await transport.send(request)
        } catch let urlError as URLError {
            throw APIError.network(urlError)
        }

        guard (200..<300).contains(response.statusCode) else {
            throw await mapFailure(status: response.statusCode, data: data, requiresSession: requiresSession)
        }

        do {
            return try Self.decoder.decode(Response.self, from: data)
        } catch let decodingError as DecodingError {
            throw APIError.undecodableResponse(decodingError)
        }
    }

    private func url(path: String, query: [URLQueryItem]) -> URL {
        var url = baseURL().appending(path: path)
        if !query.isEmpty {
            url.append(queryItems: query)
        }
        return url
    }

    // MARK: - Failure mapping

    /// The server's uniform error body: `{error: {code, message}}`.
    private struct ErrorEnvelope: Decodable {
        struct Payload: Decodable {
            let code: String
            let message: String
        }
        let error: Payload
    }

    private func mapFailure(status: Int, data: Data, requiresSession: Bool) async -> APIError {
        // A 401 on a session-authenticated call means the session is dead:
        // expired, or revoked via token_version. Sign-in's own 401 (a
        // rejected Apple identity token) is not a session death and falls
        // through to the envelope mapping below.
        if status == 401 && requiresSession {
            await rejectSession()
            return .sessionRejected
        }
        // A body that is not the API's error shape is an expected input
        // here (a proxy's HTML error page, say), so `try?` is a fallback,
        // not swallowed signal: the status code is preserved either way.
        if let envelope = try? Self.decoder.decode(ErrorEnvelope.self, from: data) {
            return .requestFailed(code: envelope.error.code, message: envelope.error.message, status: status)
        }
        return .unexpectedResponse(status: status)
    }

    private func rejectSession() async {
        guard let onSessionRejected else { return }
        await MainActor.run { onSessionRejected() }
    }

    // MARK: - Coding

    /// The server serializes timestamps with JavaScript's `toISOString()` -
    /// always UTC, always fractional seconds. The plain form is accepted
    /// too so a serialization-detail change server-side is not a client
    /// crash.
    static let decoder: JSONDecoder = {
        let withFractionalSeconds = ISO8601DateFormatter()
        withFractionalSeconds.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        plain.formatOptions = [.withInternetDateTime]

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            guard let date = withFractionalSeconds.date(from: value) ?? plain.date(from: value) else {
                throw DecodingError.dataCorruptedError(
                    in: container,
                    debugDescription: "Not an ISO 8601 timestamp: \(value)"
                )
            }
            return date
        }
        return decoder
    }()

    static let encoder = JSONEncoder()
}
