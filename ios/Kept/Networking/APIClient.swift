import Foundation

/// Where "the server rejected the session" is delivered to whoever handles
/// it (SessionController). A main-actor box rather than a settable closure
/// property on APIClient: the client is Sendable and shared across actors,
/// and a mutable property on it would be exactly the shared mutable state
/// strict concurrency exists to forbid. The box is wired once by the
/// composition root, after construction, because the SessionController
/// that handles the event is itself constructed with the client.
@MainActor
final class SessionRejectionRelay {
    var onSessionRejected: (() -> Void)?

    func sessionRejected() {
        onSessionRejected?()
    }
}

/// The one place requests are built, the session token is attached, and
/// responses - success or failure - are interpreted. Endpoint methods
/// (APIClient+Endpoints) say *what* to call; everything about *how* lives
/// here, so there is exactly one implementation of auth and error handling
/// rather than one per call site.
///
/// Sendable by construction - every stored property is immutable and
/// itself Sendable - because view models on the main actor and the wave-5
/// outbox share this one instance.
final class APIClient: Sendable {
    /// Read per request rather than captured once, so changing the server
    /// address in settings applies to the next request immediately.
    private let baseURL: @Sendable () -> URL
    private let transport: HTTPTransport
    private let tokenStore: SessionTokenStore
    private let rejectionRelay: SessionRejectionRelay

    init(
        baseURL: @escaping @Sendable () -> URL,
        transport: HTTPTransport,
        tokenStore: SessionTokenStore,
        rejectionRelay: SessionRejectionRelay
    ) {
        self.baseURL = baseURL
        self.transport = transport
        self.tokenStore = tokenStore
        self.rejectionRelay = rejectionRelay
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

    func patch<Body: Encodable, Response: Decodable>(
        _ path: String,
        body: Body
    ) async throws -> Response {
        let bodyData = try Self.encoder.encode(body)
        return try await perform(method: "PATCH", path: path, query: [], body: bodyData, requiresSession: true)
    }

    /// DELETE with a JSON body and no response body. Separate from
    /// `perform` because 204 No Content is the success shape here - there is
    /// nothing to decode, and a decoder pointed at an empty body would turn
    /// the server's correct answer into `.undecodableResponse`.
    func delete<Body: Encodable>(_ path: String, body: Body) async throws {
        let bodyData = try Self.encoder.encode(body)
        _ = try await send(method: "DELETE", path: path, query: [], body: bodyData, requiresSession: true)
    }

    /// The one non-API request in the app: uploading image bytes to the
    /// presigned URL the server issued. The URL is absolute (it points at
    /// object storage, not the API), authorization is in its signature -
    /// no session token attaches - and the content type must be exactly
    /// the one presigned, because the signature covers it (wave-3 gate).
    func uploadToPresignedURL(_ url: URL, data: Data, contentType: String) async throws {
        var request = URLRequest(url: url)
        request.httpMethod = "PUT"
        request.httpBody = data
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")

        let response: HTTPURLResponse
        do {
            (_, response) = try await transport.send(request)
        } catch let urlError as URLError {
            throw APIError.network(urlError)
        }
        guard (200..<300).contains(response.statusCode) else {
            // Storage errors are XML, not the API's JSON envelope; the
            // status code is the only signal worth mapping.
            throw APIError.unexpectedResponse(status: response.statusCode)
        }
    }

    private func perform<Response: Decodable>(
        method: String,
        path: String,
        query: [URLQueryItem],
        body: Data?,
        requiresSession: Bool
    ) async throws -> Response {
        let data = try await send(
            method: method,
            path: path,
            query: query,
            body: body,
            requiresSession: requiresSession
        )
        do {
            return try Self.decoder.decode(Response.self, from: data)
        } catch let decodingError as DecodingError {
            throw APIError.undecodableResponse(decodingError)
        }
    }

    /// Everything up to and including "did the server accept this": auth
    /// attached, transport failures mapped, a non-2xx turned into the right
    /// APIError. What the caller does with the bytes is the caller's - which
    /// is the whole difference between `perform` above and `delete`.
    private func send(
        method: String,
        path: String,
        query: [URLQueryItem],
        body: Data?,
        requiresSession: Bool
    ) async throws -> Data {
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
        return data
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
        await rejectionRelay.sessionRejected()
    }

    // MARK: - Coding

    /// The server serializes timestamps with JavaScript's `toISOString()` -
    /// always UTC, always fractional seconds. The plain form is accepted
    /// too so a serialization-detail change server-side is not a client
    /// crash. ISO8601FormatStyle rather than ISO8601DateFormatter because
    /// the strategy closure is @Sendable and the format style is a Sendable
    /// value; the formatter class is not.
    static let decoder: JSONDecoder = {
        let withFractionalSeconds = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        let plain = Date.ISO8601FormatStyle()

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let value = try container.decode(String.self)
            guard let date = (try? withFractionalSeconds.parse(value)) ?? (try? plain.parse(value)) else {
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
