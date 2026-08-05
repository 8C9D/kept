import Foundation

/// The three calls wave 3 uses, as a protocol so view models can be tested
/// against a stub API without building HTTP responses. APIClient is the
/// production implementation; endpoints are added here as waves need them,
/// not speculatively.
protocol KeptAPI {
    func signInWithApple(identityToken: String, displayName: String?) async throws -> SignInResponse
    func receiptsPage(cursor: String?, status: ReceiptStatus?, limit: Int?) async throws -> ReceiptListPage
    func receiptDetail(id: UUID) async throws -> ReceiptDetail
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

    func receiptsPage(cursor: String?, status: ReceiptStatus?, limit: Int?) async throws -> ReceiptListPage {
        var query: [URLQueryItem] = []
        if let cursor {
            query.append(URLQueryItem(name: "cursor", value: cursor))
        }
        if let status {
            query.append(URLQueryItem(name: "status", value: status.rawValue))
        }
        if let limit {
            query.append(URLQueryItem(name: "limit", value: String(limit)))
        }
        return try await get("/api/receipts", query: query)
    }

    func receiptDetail(id: UUID) async throws -> ReceiptDetail {
        // Lowercased to match the server's canonical uuid form; its route
        // pattern is case-insensitive, but sending what the server stores
        // costs nothing.
        try await get("/api/receipts/\(id.uuidString.lowercased())")
    }
}
