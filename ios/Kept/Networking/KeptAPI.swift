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
    /// POST /api/receipts/:id/images (proposal #6, 2026-08-28) - add a
    /// page to an existing receipt. The bytes are already uploaded via
    /// `uploadTarget`/`uploadImage` exactly like the create route's own
    /// image; this call only records where they landed. The server
    /// assigns the page number - never taken from here (see
    /// routes/receipts.ts's own comment on why) - so callers refresh the
    /// receipt detail afterward rather than trust this response's `page`
    /// into local state.
    func addReceiptImage(receiptId: UUID, objectKey: String, sha256: String) async throws -> ReceiptImage
    /// PUT /api/receipts/:id/images/:page (proposal #6, 2026-08-28) -
    /// replace the bytes behind one page: the repair path for a page
    /// whose photo never finished uploading, without losing the
    /// receipt's vendor, date, total or HST. The server soft-deletes the
    /// old row and inserts a new one at the same page number (spec
    /// §5/§10B) - the old bytes stay retained, never erased.
    func replaceReceiptImage(receiptId: UUID, page: Int, objectKey: String, sha256: String) async throws -> ReceiptImage
    func receiptOptions() async throws -> ReceiptOptions
    /// GET /api/receipts/summary (proposal #3, 2026-08-28) - confirmed-only
    /// totals plus a separate pending count, for the same filter the list
    /// is currently showing. No cursor, no limit: an aggregate has no
    /// pages to turn.
    func receiptsSummary(query: ReceiptQuery) async throws -> ReceiptSummary
    func uploadTarget(contentType: ImageUploadContentType) async throws -> UploadTarget
    func uploadImage(to target: UploadTarget, data: Data, contentType: ImageUploadContentType) async throws
    func createReceipt(_ request: CreateReceiptRequest) async throws -> Receipt
    func confirmReceipt(id: UUID, _ request: ConfirmReceiptRequest) async throws -> Receipt
    /// Soft delete (spec §10B): tombstones the row and its image, excluded
    /// from every list, count and export from that moment on, bytes kept
    /// for CRA's six-year retention. Not the account-deletion hard delete.
    func deleteReceipt(id: UUID) async throws
    func deleteAccount(appleAuthorizationCode: String?) async throws
    func startExport(_ request: ExportRequest) async throws -> ExportJob
    func exportJobs() async throws -> [ExportJob]
    func exportJob(id: UUID) async throws -> ExportJob
    /// POST /api/events - behavioural telemetry (EventLogger is the only
    /// caller). Returns nothing: the response body `{accepted: n}` exists
    /// for the server's own bookkeeping, not for this client to act on -
    /// this is a fire-and-forget endpoint by contract (spec, 2026-08-28),
    /// and a client that inspected the count would be looking for a
    /// reason to react to it.
    func postEvents(_ request: PostEventsRequest) async throws
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

    /// The wire body both add-a-page and replace-a-page send - identical
    /// to what the create route's `image` key and the server's
    /// `receiptImageSchema` both accept (server/src/http/schemas.ts):
    /// `{objectKey, sha256}`, nothing else. One place both call sites
    /// share so the shape cannot drift between them.
    private struct ImageUploadBody: Encodable {
        let objectKey: String
        let sha256: String
    }

    func addReceiptImage(receiptId: UUID, objectKey: String, sha256: String) async throws -> ReceiptImage {
        try await post(
            "/api/receipts/\(receiptId.uuidString.lowercased())/images",
            body: ImageUploadBody(objectKey: objectKey, sha256: sha256)
        )
    }

    func replaceReceiptImage(receiptId: UUID, page: Int, objectKey: String, sha256: String) async throws -> ReceiptImage {
        try await put(
            "/api/receipts/\(receiptId.uuidString.lowercased())/images/\(page)",
            body: ImageUploadBody(objectKey: objectKey, sha256: sha256)
        )
    }

    /// The values this user has already used for category and payment.
    /// The route is a literal path registered above `/:id`, so it is not
    /// a receipt id and never collides with one.
    func receiptOptions() async throws -> ReceiptOptions {
        try await get("/api/receipts/options")
    }

    /// The filter-only query (no sort/order/cursor/limit): the server's
    /// `receiptFilterQuerySchema` is a strict object and 400s an unknown
    /// key, so sending the paging route's own `sort`/`order` here would
    /// fail the request rather than being ignored.
    func receiptsSummary(query: ReceiptQuery) async throws -> ReceiptSummary {
        try await get("/api/receipts/summary", query: query.filterQueryItems)
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

    /// ⚠ Ordering trap this call site inherits (spec §5, Runbook §6): the
    /// create route's duplicate-image index keys on (user, sha256), and a
    /// tombstoned image still holds that slot until this DELETE stamps its
    /// own `deleted_at` alongside the receipt's. Re-uploading the exact
    /// same image bytes 409s as `duplicate_image` until the receipt that
    /// holds them is deleted - so "delete, then recapture" is the only
    /// order that works for an identical file. A re-photographed paper
    /// produces different bytes and collides with nothing.
    func deleteReceipt(id: UUID) async throws {
        try await delete("/api/receipts/\(id.uuidString.lowercased())")
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

    // MARK: - Export (2026-08-28: iOS export screen, reversing §4.1a/§7.1's
    // web-only decision - see Export/ExportView.swift for why)

    /// Starts generating a zip for a period; the job runs after this
    /// returns, and the caller polls `exportJob(id:)`. 409
    /// `export_already_running` when one is already live for this user -
    /// refused, not queued (spec §8).
    func startExport(_ request: ExportRequest) async throws -> ExportJob {
        try await post("/api/export", body: request)
    }

    /// The caller's own jobs, newest first - the export screen's history.
    func exportJobs() async throws -> [ExportJob] {
        struct Response: Decodable {
            let jobs: [ExportJob]
        }
        let response: Response = try await get("/api/export")
        return response.jobs
    }

    /// One job's current state. `status` already carries the server's
    /// computed `expired`/`stale` outcomes alongside the stored ones - this
    /// client renders whichever string comes back and decides nothing.
    func exportJob(id: UUID) async throws -> ExportJob {
        try await get("/api/export/\(id.uuidString.lowercased())")
    }

    // MARK: - Events (2026-08-28: behavioural telemetry)

    func postEvents(_ request: PostEventsRequest) async throws {
        struct Response: Decodable {
            let accepted: Int
        }
        let _: Response = try await post("/api/events", body: request)
    }
}
