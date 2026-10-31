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

/// What a dead session on one request means for the session as a whole.
///
/// Almost every call is `.endsSession`: a screen asked for something, the
/// answer is "you are not signed in", and the app goes back to sign-in.
/// `.leavesSession` exists for the calls no person asked for (2026-10-31).
/// The 30-day token has no refresh, so a 401 is a certainty on a long
/// enough timeline, and these two were able to deliver it at any moment: a
/// 401 on the capture screen's second opinion returned the app to sign-in
/// mid-confirm, which tore down the capture cover and destroyed the unsaved
/// scan and whatever had been typed over it. An enhancement must not be
/// able to do that, and neither must telemetry. Both already treat every
/// failure as nothing, so a 401 can join them.
enum SessionFailureHandling: Sendable {
    case endsSession
    case leavesSession
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
        requiresSession: Bool = true,
        sessionFailure: SessionFailureHandling = .endsSession
    ) async throws -> Response {
        let bodyData = try Self.encoder.encode(body)
        return try await perform(
            method: "POST",
            path: path,
            query: [],
            body: bodyData,
            requiresSession: requiresSession,
            sessionFailure: sessionFailure
        )
    }

    /// POST with no body at all - `/api/receipts/:id/restore` (proposal
    /// #9, 2026-08-28) reads nothing beyond the id in the path and the
    /// session; the same reasoning as `delete(_ path:)`'s bodyless overload
    /// below.
    func post<Response: Decodable>(_ path: String) async throws -> Response {
        try await perform(method: "POST", path: path, query: [], body: nil, requiresSession: true)
    }

    func patch<Body: Encodable, Response: Decodable>(
        _ path: String,
        body: Body
    ) async throws -> Response {
        let bodyData = try Self.encoder.encode(body)
        return try await perform(method: "PATCH", path: path, query: [], body: bodyData, requiresSession: true)
    }

    /// PUT /api/receipts/:id/images/:page (proposal #6, 2026-08-28) is the
    /// only caller today - a whole-resource replace at a known path,
    /// unlike PATCH's partial update.
    func put<Body: Encodable, Response: Decodable>(
        _ path: String,
        body: Body
    ) async throws -> Response {
        let bodyData = try Self.encoder.encode(body)
        return try await perform(method: "PUT", path: path, query: [], body: bodyData, requiresSession: true)
    }

    /// DELETE with a JSON body and no response body. Separate from
    /// `perform` because 204 No Content is the success shape here - there is
    /// nothing to decode, and a decoder pointed at an empty body would turn
    /// the server's correct answer into `.undecodableResponse`.
    func delete<Body: Encodable>(_ path: String, body: Body) async throws {
        let bodyData = try Self.encoder.encode(body)
        _ = try await send(method: "DELETE", path: path, query: [], body: bodyData, requiresSession: true)
    }

    /// DELETE with no body and no response body - `/api/receipts/:id`
    /// (spec §10B) needs neither, unlike `/api/me`'s optional Apple
    /// reauthorization code. `query` carries what a bodiless DELETE has
    /// nowhere else to put: `/api/receipts/options/:field?value=`
    /// (2026-09-01) names the value it is forgetting there.
    func delete(_ path: String, query: [URLQueryItem] = []) async throws {
        _ = try await send(method: "DELETE", path: path, query: query, body: nil, requiresSession: true)
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
        requiresSession: Bool,
        sessionFailure: SessionFailureHandling = .endsSession
    ) async throws -> Response {
        let data = try await send(
            method: method,
            path: path,
            query: query,
            body: body,
            requiresSession: requiresSession,
            sessionFailure: sessionFailure
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
        requiresSession: Bool,
        sessionFailure: SessionFailureHandling = .endsSession
    ) async throws -> Data {
        var request = URLRequest(url: url(path: path, query: query))
        request.httpMethod = method
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }

        var sentToken: String?
        if requiresSession {
            // A missing token on a session-only call means the app thinks
            // it is signed in but has nothing to prove it - the same dead
            // end as a rejected token, handled the same way. Except for a
            // best-effort call, where it usually means the opposite: an
            // event flush landing after a sign-out has nobody to tell, and
            // used to replace the sign-in screen's own message with
            // "session expired".
            guard let token = try tokenStore.load() else {
                if sessionFailure == .endsSession {
                    await rejectSession()
                }
                throw APIError.sessionRejected
            }
            sentToken = token
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
            throw await mapFailure(
                status: response.statusCode,
                data: data,
                sentToken: sentToken,
                sessionFailure: sessionFailure
            )
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
            /// On a 409 `duplicate_image` from the create (2026-10-31). A
            /// string rather than a `UUID`, so a value that fails to parse
            /// costs the id and not the whole error body - an older server
            /// sends no such key, and the mapping below is identical for
            /// the two.
            let existingReceiptId: String?
        }
        let error: Payload
    }

    private func mapFailure(
        status: Int,
        data: Data,
        sentToken: String?,
        sessionFailure: SessionFailureHandling
    ) async -> APIError {
        // A 401 on a session-authenticated call means the session is dead:
        // expired, or revoked via token_version. Sign-in's own 401 (a
        // rejected Apple identity token) is not a session death and falls
        // through to the envelope mapping below.
        if status == 401, let sentToken {
            // The refusal is about the token this request carried, and
            // about nothing else (2026-10-31). A slow request sent before a
            // sign-in can answer after it, and treating that as a verdict
            // on the session would clear the new token the person just
            // obtained.
            if sessionFailure == .endsSession, isSavedToken(sentToken) {
                await rejectSession()
            }
            return .sessionRejected
        }
        // A body that is not the API's error shape is an expected input
        // here (a proxy's HTML error page, say), so `try?` is a fallback,
        // not swallowed signal: the status code is preserved either way.
        if let envelope = try? Self.decoder.decode(ErrorEnvelope.self, from: data) {
            if envelope.error.code == "duplicate_image",
               let id = envelope.error.existingReceiptId.flatMap(UUID.init(uuidString:)) {
                return .duplicateImage(existingReceiptId: id, message: envelope.error.message)
            }
            return .requestFailed(code: envelope.error.code, message: envelope.error.message, status: status)
        }
        return .unexpectedResponse(status: status)
    }

    /// Whether `token` is still the one on file. A keychain that refuses
    /// the read (the phone locked mid-request) answers no: that is not
    /// evidence the session died, and the next request made on an unlocked
    /// phone gets the same 401 and settles it with a token in hand.
    private func isSavedToken(_ token: String) -> Bool {
        do {
            return try tokenStore.load() == token
        } catch {
            return false
        }
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
