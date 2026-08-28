import Foundation
@testable import Kept

/// A KeptAPI whose behaviour each test scripts with closures, recording
/// calls for assertion. Model tests use this; transport-level behaviour
/// (headers, error mapping) is APIClientTests' job against StubTransport.
/// @MainActor satisfies the protocol's Sendable bound (wave 5) while
/// keeping the scripted state actor-protected; the async requirements
/// hop here implicitly.
@MainActor
final class StubKeptAPI: KeptAPI {
    struct UnstubbedCall: Error {
        let endpoint: String
    }

    var signInHandler: ((_ identityToken: String, _ displayName: String?) async throws -> SignInResponse)?
    var receiptsPageHandler: ((_ cursor: String?, _ query: ReceiptQuery, _ limit: Int?) async throws -> ReceiptListPage)?
    var receiptDetailHandler: ((_ id: UUID) async throws -> ReceiptDetail)?
    var addReceiptImageHandler: ((_ receiptId: UUID, _ objectKey: String, _ sha256: String) async throws -> ReceiptImage)?
    var replaceReceiptImageHandler: ((_ receiptId: UUID, _ page: Int, _ objectKey: String, _ sha256: String) async throws -> ReceiptImage)?
    var receiptOptionsHandler: (() async throws -> ReceiptOptions)?
    var receiptsSummaryHandler: ((_ query: ReceiptQuery) async throws -> ReceiptSummary)?
    var uploadTargetHandler: ((_ contentType: ImageUploadContentType) async throws -> UploadTarget)?
    var uploadImageHandler: ((_ target: UploadTarget, _ data: Data, _ contentType: ImageUploadContentType) async throws -> Void)?
    var createReceiptHandler: ((_ request: CreateReceiptRequest) async throws -> Receipt)?
    var confirmReceiptHandler: ((_ id: UUID, _ request: ConfirmReceiptRequest) async throws -> Receipt)?
    var deleteReceiptHandler: ((_ id: UUID) async throws -> Void)?
    var deleteAccountHandler: ((_ appleAuthorizationCode: String?) async throws -> Void)?
    var startExportHandler: ((_ request: ExportRequest) async throws -> ExportJob)?
    var exportJobsHandler: (() async throws -> [ExportJob])?
    var exportJobHandler: ((_ id: UUID) async throws -> ExportJob)?
    /// Defaults to succeeding trivially - most tests exercising something
    /// else entirely still route through EventLogger incidentally (a
    /// confirm save, say) and should not have to stub telemetry to avoid
    /// an UnstubbedCall failure they never meant to test.
    var postEventsHandler: ((_ request: PostEventsRequest) async throws -> Void)? = { _ in }

    /// ReceiptListModel fetches its first page and the pending probe with
    /// `async let`, so two tasks call receiptsPage concurrently; the call
    /// log must be lock-guarded or the appends are a data race. (Wave-3
    /// reviewer finding.)
    private let callLock = NSLock()
    private var recordedReceiptsPageCalls: [(cursor: String?, query: ReceiptQuery, limit: Int?)] = []
    private var recordedAddReceiptImageCalls: [(receiptId: UUID, objectKey: String, sha256: String)] = []
    private var recordedReplaceReceiptImageCalls: [(receiptId: UUID, page: Int, objectKey: String, sha256: String)] = []
    private var recordedCreateReceiptCalls: [CreateReceiptRequest] = []
    private var recordedConfirmReceiptCalls: [(id: UUID, request: ConfirmReceiptRequest)] = []
    private var recordedDeleteReceiptCalls: [UUID] = []
    private var recordedDeleteAccountCalls: [String?] = []
    private var recordedReceiptOptionsCalls = 0
    private var recordedReceiptsSummaryCalls: [ReceiptQuery] = []
    private var recordedStartExportCalls: [ExportRequest] = []
    private var recordedExportJobCalls: [UUID] = []
    private var recordedPostEventsCalls: [PostEventsRequest] = []

    var receiptsPageCalls: [(cursor: String?, query: ReceiptQuery, limit: Int?)] {
        callLock.withLock { recordedReceiptsPageCalls }
    }

    var receiptOptionsCalls: Int {
        callLock.withLock { recordedReceiptOptionsCalls }
    }

    var receiptsSummaryCalls: [ReceiptQuery] {
        callLock.withLock { recordedReceiptsSummaryCalls }
    }

    var addReceiptImageCalls: [(receiptId: UUID, objectKey: String, sha256: String)] {
        callLock.withLock { recordedAddReceiptImageCalls }
    }

    var replaceReceiptImageCalls: [(receiptId: UUID, page: Int, objectKey: String, sha256: String)] {
        callLock.withLock { recordedReplaceReceiptImageCalls }
    }

    var createReceiptCalls: [CreateReceiptRequest] {
        callLock.withLock { recordedCreateReceiptCalls }
    }

    var confirmReceiptCalls: [(id: UUID, request: ConfirmReceiptRequest)] {
        callLock.withLock { recordedConfirmReceiptCalls }
    }

    /// One entry per deleteAccount call, holding the authorization code the
    /// caller passed - nil included, because "deleted without revoking" is a
    /// distinct outcome worth asserting rather than an absent call.
    var deleteAccountCalls: [String?] {
        callLock.withLock { recordedDeleteAccountCalls }
    }

    var deleteReceiptCalls: [UUID] {
        callLock.withLock { recordedDeleteReceiptCalls }
    }

    var startExportCalls: [ExportRequest] {
        callLock.withLock { recordedStartExportCalls }
    }

    var exportJobCalls: [UUID] {
        callLock.withLock { recordedExportJobCalls }
    }

    /// Every batch actually posted, in order - what the queue/logger
    /// tests inspect to assert batching, capping and body content.
    var postEventsCalls: [PostEventsRequest] {
        callLock.withLock { recordedPostEventsCalls }
    }

    func signInWithApple(identityToken: String, displayName: String?) async throws -> SignInResponse {
        guard let signInHandler else { throw UnstubbedCall(endpoint: "signInWithApple") }
        return try await signInHandler(identityToken, displayName)
    }

    func receiptsPage(cursor: String?, query: ReceiptQuery, limit: Int?) async throws -> ReceiptListPage {
        callLock.withLock { recordedReceiptsPageCalls.append((cursor, query, limit)) }
        guard let receiptsPageHandler else { throw UnstubbedCall(endpoint: "receiptsPage") }
        return try await receiptsPageHandler(cursor, query, limit)
    }

    func receiptDetail(id: UUID) async throws -> ReceiptDetail {
        guard let receiptDetailHandler else { throw UnstubbedCall(endpoint: "receiptDetail") }
        return try await receiptDetailHandler(id)
    }

    func addReceiptImage(receiptId: UUID, objectKey: String, sha256: String) async throws -> ReceiptImage {
        callLock.withLock { recordedAddReceiptImageCalls.append((receiptId, objectKey, sha256)) }
        guard let addReceiptImageHandler else { throw UnstubbedCall(endpoint: "addReceiptImage") }
        return try await addReceiptImageHandler(receiptId, objectKey, sha256)
    }

    func replaceReceiptImage(receiptId: UUID, page: Int, objectKey: String, sha256: String) async throws -> ReceiptImage {
        callLock.withLock { recordedReplaceReceiptImageCalls.append((receiptId, page, objectKey, sha256)) }
        guard let replaceReceiptImageHandler else { throw UnstubbedCall(endpoint: "replaceReceiptImage") }
        return try await replaceReceiptImageHandler(receiptId, page, objectKey, sha256)
    }

    func receiptOptions() async throws -> ReceiptOptions {
        callLock.withLock { recordedReceiptOptionsCalls += 1 }
        guard let receiptOptionsHandler else { throw UnstubbedCall(endpoint: "receiptOptions") }
        return try await receiptOptionsHandler()
    }

    func receiptsSummary(query: ReceiptQuery) async throws -> ReceiptSummary {
        callLock.withLock { recordedReceiptsSummaryCalls.append(query) }
        guard let receiptsSummaryHandler else { throw UnstubbedCall(endpoint: "receiptsSummary") }
        return try await receiptsSummaryHandler(query)
    }

    func uploadTarget(contentType: ImageUploadContentType) async throws -> UploadTarget {
        guard let uploadTargetHandler else { throw UnstubbedCall(endpoint: "uploadTarget") }
        return try await uploadTargetHandler(contentType)
    }

    func uploadImage(to target: UploadTarget, data: Data, contentType: ImageUploadContentType) async throws {
        guard let uploadImageHandler else { throw UnstubbedCall(endpoint: "uploadImage") }
        try await uploadImageHandler(target, data, contentType)
    }

    func createReceipt(_ request: CreateReceiptRequest) async throws -> Receipt {
        callLock.withLock { recordedCreateReceiptCalls.append(request) }
        guard let createReceiptHandler else { throw UnstubbedCall(endpoint: "createReceipt") }
        return try await createReceiptHandler(request)
    }

    func confirmReceipt(id: UUID, _ request: ConfirmReceiptRequest) async throws -> Receipt {
        callLock.withLock { recordedConfirmReceiptCalls.append((id, request)) }
        guard let confirmReceiptHandler else { throw UnstubbedCall(endpoint: "confirmReceipt") }
        return try await confirmReceiptHandler(id, request)
    }

    func deleteReceipt(id: UUID) async throws {
        callLock.withLock { recordedDeleteReceiptCalls.append(id) }
        guard let deleteReceiptHandler else { throw UnstubbedCall(endpoint: "deleteReceipt") }
        try await deleteReceiptHandler(id)
    }

    func deleteAccount(appleAuthorizationCode: String?) async throws {
        callLock.withLock { recordedDeleteAccountCalls.append(appleAuthorizationCode) }
        guard let deleteAccountHandler else { throw UnstubbedCall(endpoint: "deleteAccount") }
        try await deleteAccountHandler(appleAuthorizationCode)
    }

    func startExport(_ request: ExportRequest) async throws -> ExportJob {
        callLock.withLock { recordedStartExportCalls.append(request) }
        guard let startExportHandler else { throw UnstubbedCall(endpoint: "startExport") }
        return try await startExportHandler(request)
    }

    func exportJobs() async throws -> [ExportJob] {
        guard let exportJobsHandler else { throw UnstubbedCall(endpoint: "exportJobs") }
        return try await exportJobsHandler()
    }

    func exportJob(id: UUID) async throws -> ExportJob {
        callLock.withLock { recordedExportJobCalls.append(id) }
        guard let exportJobHandler else { throw UnstubbedCall(endpoint: "exportJob") }
        return try await exportJobHandler(id)
    }

    func postEvents(_ request: PostEventsRequest) async throws {
        callLock.withLock { recordedPostEventsCalls.append(request) }
        guard let postEventsHandler else { throw UnstubbedCall(endpoint: "postEvents") }
        try await postEventsHandler(request)
    }
}
