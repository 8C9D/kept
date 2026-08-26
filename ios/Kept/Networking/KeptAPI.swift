import Foundation

/// The calls the app uses, as a protocol so view models can be tested
/// against a stub API without building HTTP responses. APIClient is the
/// production implementation; endpoints are added here as waves need them,
/// not speculatively. (Waves 1-3 added the first three; wave 4 added the
/// capture-and-confirm four.) Sendable because the main-actor models hand
/// it into nonisolated request tasks.
protocol KeptAPI: Sendable {
    func signInWithApple(identityToken: String, displayName: String?) async throws -> SignInResponse
    func receiptsPage(cursor: String?, query: ReceiptQuery, limit: Int?) async throws -> ReceiptListPage
    func receiptDetail(id: UUID) async throws -> ReceiptDetail
    func receiptOptions() async throws -> ReceiptOptions
    func uploadTarget(contentType: ImageUploadContentType) async throws -> UploadTarget
    func uploadImage(to target: UploadTarget, data: Data, contentType: ImageUploadContentType) async throws
    func createReceipt(_ request: CreateReceiptRequest) async throws -> Receipt
    func confirmReceipt(id: UUID, _ request: ConfirmReceiptRequest) async throws -> Receipt
    func deleteAccount(appleAuthorizationCode: String?) async throws
}

extension APIClient: KeptAPI {
    func signInWithApple(identityToken: String, displayName: String?) async throws -> SignInResponse {
        struct Body: Encodable {
            let identityToken: String
            // Encoded with encodeIfPresent, so a nil name omits the key
            // entirely - the server's strict schema allows an absent
            // displayName but rejects an explicit null.
            let displayName: String?
        }
        return try await post(
            "/api/auth/apple",
            body: Body(identityToken: identityToken, displayName: displayName),
            requiresSession: false
        )
    }

    func receiptsPage(cursor: String?, query: ReceiptQuery, limit: Int?) async throws -> ReceiptListPage {
        // The cursor leads: it is opaque, and it encodes the sort it was
        // minted under, which the server checks against the sort sent
        // alongside it.
        var items: [URLQueryItem] = []
        if let cursor {
            items.append(URLQueryItem(name: "cursor", value: cursor))
        }
        items.append(contentsOf: query.queryItems)
        if let limit {
            items.append(URLQueryItem(name: "limit", value: String(limit)))
        }
        return try await get("/api/receipts", query: items)
    }

    func receiptDetail(id: UUID) async throws -> ReceiptDetail {
        // Lowercased to match the server's canonical uuid form; its route
        // pattern is case-insensitive, but sending what the server stores
        // costs nothing.
        try await get("/api/receipts/\(id.uuidString.lowercased())")
    }

    /// The values this user has already used for category and payment.
    /// The route is a literal path registered above `/:id`, so it is not
    /// a receipt id and never collides with one.
    func receiptOptions() async throws -> ReceiptOptions {
        try await get("/api/receipts/options")
    }

    func uploadTarget(contentType: ImageUploadContentType) async throws -> UploadTarget {
        struct Body: Encodable {
            let contentType: ImageUploadContentType
        }
        return try await post("/api/receipts/upload-url", body: Body(contentType: contentType))
    }

    func uploadImage(to target: UploadTarget, data: Data, contentType: ImageUploadContentType) async throws {
        try await uploadToPresignedURL(target.uploadUrl, data: data, contentType: contentType.rawValue)
    }

    func createReceipt(_ request: CreateReceiptRequest) async throws -> Receipt {
        try await post("/api/receipts", body: request)
    }

    func confirmReceipt(id: UUID, _ request: ConfirmReceiptRequest) async throws -> Receipt {
        try await patch("/api/receipts/\(id.uuidString.lowercased())", body: request)
    }

    /// Destroys the account and every receipt in it. The code is a fresh,
    /// single-use one from a Sign in with Apple re-authorization run moments
    /// earlier, which the server exchanges to revoke the person's Apple
    /// tokens; nil when that re-authorization did not produce one, and the
    /// server deletes the account regardless (Apple's own guidance).
    func deleteAccount(appleAuthorizationCode: String?) async throws {
        struct Body: Encodable {
            // Encoded with encodeIfPresent, so a nil code omits the key
            // entirely - the server's strict schema allows an absent
            // appleAuthorizationCode but rejects an explicit null.
            let appleAuthorizationCode: String?
        }
        try await delete("/api/me", body: Body(appleAuthorizationCode: appleAuthorizationCode))
    }
}
