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
    /// GET /api/me (proposal #10, 2026-08-28) - read-only here. This client
    /// never edits fiscal year settings; ExportView.swift reads the two
    /// fields to drive the export period presets against the person's
    /// actual configured year end rather than an assumed calendar year.
    func fetchProfile() async throws -> Profile
    /// GET /api/receipts/possible-duplicates (proposal #8, 2026-08-28) - a
    /// QUERY, never a blocker (the server route's own comment,
    /// receipts.ts, states this in full): the confirm screen calls this
    /// once it has a date and a total and WARNS if something comes back;
    /// nothing here ever refuses a save. `vendor` is sent exactly as
    /// typed - the server compares it case-and-whitespace-insensitively on
    /// its own side, so normalizing it here would just be duplicating work
    /// the query string already asks the server to do. `excludeId` is the
    /// receipt already open, when there is one, so it does not match
    /// itself - the obvious bug the proposal calls out by name.
    func possibleDuplicates(
        purchasedAt: String,
        totalCents: Int,
        vendor: String?,
        excludeId: UUID?
    ) async throws -> [Receipt]
    /// POST /api/receipts/parse (2026-09-01) - the server's LLM reading the
    /// same OCR text the on-device heuristic just read, as a second opinion
    /// on the capture-time confirm screen. Writes nothing: no receipt
    /// exists yet. Throws `ServerParseError` for the two "not now" answers
    /// (503 `parse_unavailable`, 502 `parse_failed`), which callers swallow
    /// - see `ServerParseResult`'s own doc comment for why this is a bonus
    /// laid on an offline screen and never a dependency of it.
    func parseReceiptText(ocrRawText: String, capturedAt: Date) async throws -> ServerParseResult
    func uploadTarget(contentType: ImageUploadContentType) async throws -> UploadTarget
    func uploadImage(to target: UploadTarget, data: Data, contentType: ImageUploadContentType) async throws
    func createReceipt(_ request: CreateReceiptRequest) async throws -> Receipt
    func confirmReceipt(id: UUID, _ request: ConfirmReceiptRequest) async throws -> Receipt
    /// PATCH /api/receipts/:id from the confirm screen's "Save for later"
    /// (2026-09-01) - the same route as `confirmReceipt`, with **no
    /// `status`**, so the receipt stays pending and keeps its place in the
    /// queue and in the Home badge's count. Its own method rather than a
    /// `ConfirmReceiptRequest` for the reason that request's own doc
    /// comment gives: it encodes every field explicitly, nulls included,
    /// because a confirm IS the person accepting the whole form - reusing
    /// it here would write the parser's untouched guesses into the row,
    /// which is exactly what constraint 2 forbids.
    func saveReceiptForLater(id: UUID, _ request: SaveForLaterRequest) async throws -> Receipt
    /// Soft delete (spec §10B): tombstones the row and its image, excluded
    /// from every list, count and export from that moment on, bytes kept
    /// for CRA's six-year retention. Not the account-deletion hard delete.
    func deleteReceipt(id: UUID) async throws
    /// PATCH /api/receipts/:id for proposal #9's swipe-to-confirm on the
    /// Home list - carrying **the values the row was showing** since
    /// 2026-09-01 (`QuickConfirmRequest`, whose own doc comment carries the
    /// bug this fixes: the row rendered the served merge while the swipe
    /// saved the stored column, so a row reading `JIMMY THE GREEK` saved
    /// `In Store 392`).
    ///
    /// Still its own method rather than a `ConfirmReceiptRequest`: that
    /// request encodes every field explicitly, nulls included, because the
    /// confirm FORM always sends the whole reviewed form - reusing it here
    /// would clear whatever the row does not render. Sending the displayed
    /// total in the same PATCH is also what satisfies the server's
    /// no-confirmed-receipt-without-a-total check, which is why the
    /// affordance can now be offered wherever a total is VISIBLE rather
    /// than only where the raw column holds one.
    func quickConfirmReceipt(id: UUID, _ request: QuickConfirmRequest) async throws -> Receipt
    /// POST /api/receipts/:id/restore (proposal #9, 2026-08-28) - undo a
    /// soft delete. Can legitimately fail with 409 `restore_conflict` when
    /// the freed image slot collided with a different receipt's live image
    /// in the meantime (server/src/routes/receipts.ts's own doc comment
    /// carries the full trap); callers surface `error.localizedDescription`
    /// verbatim - `APIError.requestFailed` already carries the server's
    /// message unchanged, so there is nothing to reword here.
    func restoreReceipt(id: UUID) async throws -> Receipt
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

    func fetchProfile() async throws -> Profile {
        try await get("/api/me")
    }

    /// The route is a literal path registered above `/:id` (same shadowing
    /// reason as `/options` and `/summary`, both above), so it is never
    /// mistaken for a receipt id either. `totalCents` is sent as a plain
    /// decimal string - the server's schema parses it back with a regex
    /// before piping it through the same cents validation every money
    /// field gets (`possibleDuplicatesQuerySchema`, http/schemas.ts).
    func possibleDuplicates(
        purchasedAt: String,
        totalCents: Int,
        vendor: String?,
        excludeId: UUID?
    ) async throws -> [Receipt] {
        struct Response: Decodable {
            let receipts: [Receipt]
        }
        var items = [
            URLQueryItem(name: "purchasedAt", value: purchasedAt),
            URLQueryItem(name: "totalCents", value: String(totalCents)),
        ]
        if let vendor {
            items.append(URLQueryItem(name: "vendor", value: vendor))
        }
        if let excludeId {
            items.append(URLQueryItem(name: "excludeId", value: excludeId.uuidString.lowercased()))
        }
        let response: Response = try await get("/api/receipts/possible-duplicates", query: items)
        return response.receipts
    }

    /// The route is a literal path registered above `/:id`, same shadowing
    /// reason as `/options` and `/summary`. `capturedAt` rides along so the
    /// model can reject a date after the photograph the same way the
    /// on-device date scorer does - the server owns that rule for its own
    /// parser, and sending the instant costs one field.
    ///
    /// The two "not now" statuses are re-thrown as `ServerParseError`
    /// rather than left as `APIError.requestFailed`, so a caller that must
    /// stay silent about them (the capture screen) can say so in its own
    /// types instead of matching on string codes.
    func parseReceiptText(ocrRawText: String, capturedAt: Date) async throws -> ServerParseResult {
        struct Body: Encodable {
            let ocrRawText: String
            let capturedAt: String
        }
        do {
            return try await post(
                "/api/receipts/parse",
                body: Body(ocrRawText: ocrRawText, capturedAt: ReceiptFormat.timestamp(of: capturedAt))
            )
        } catch APIError.requestFailed(let code, _, _) where code == "parse_unavailable" {
            throw ServerParseError.unavailable
        } catch APIError.requestFailed(let code, _, _) where code == "parse_failed" {
            throw ServerParseError.failed
        }
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

    func saveReceiptForLater(id: UUID, _ request: SaveForLaterRequest) async throws -> Receipt {
        try await patch("/api/receipts/\(id.uuidString.lowercased())", body: request)
    }

    func quickConfirmReceipt(id: UUID, _ request: QuickConfirmRequest) async throws -> Receipt {
        try await patch("/api/receipts/\(id.uuidString.lowercased())", body: request)
    }

    /// POST /api/receipts/:id/restore - no body; the server has everything
    /// it needs from the id and the session (routes/receipts.ts).
    func restoreReceipt(id: UUID) async throws -> Receipt {
        try await post("/api/receipts/\(id.uuidString.lowercased())/restore")
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
