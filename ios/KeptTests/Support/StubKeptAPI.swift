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
    var receiptOptionsHandler: (() async throws -> ReceiptOptions)?
    var uploadTargetHandler: ((_ contentType: ImageUploadContentType) async throws -> UploadTarget)?
    var uploadImageHandler: ((_ target: UploadTarget, _ data: Data, _ contentType: ImageUploadContentType) async throws -> Void)?
    var createReceiptHandler: ((_ request: CreateReceiptRequest) async throws -> Receipt)?
    var confirmReceiptHandler: ((_ id: UUID, _ request: ConfirmReceiptRequest) async throws -> Receipt)?
    var deleteAccountHandler: ((_ appleAuthorizationCode: String?) async throws -> Void)?

    /// ReceiptListModel fetches its first page and the pending probe with
    /// `async let`, so two tasks call receiptsPage concurrently; the call
    /// log must be lock-guarded or the appends are a data race. (Wave-3
    /// reviewer finding.)
    private let callLock = NSLock()
    private var recordedReceiptsPageCalls: [(cursor: String?, query: ReceiptQuery, limit: Int?)] = []
    private var recordedCreateReceiptCalls: [CreateReceiptRequest] = []
    private var recordedConfirmReceiptCalls: [(id: UUID, request: ConfirmReceiptRequest)] = []
    private var recordedDeleteAccountCalls: [String?] = []
    private var recordedReceiptOptionsCalls = 0

    var receiptsPageCalls: [(cursor: String?, query: ReceiptQuery, limit: Int?)] {
        callLock.withLock { recordedReceiptsPageCalls }
    }

    var receiptOptionsCalls: Int {
        callLock.withLock { recordedReceiptOptionsCalls }
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

    func receiptOptions() async throws -> ReceiptOptions {
        callLock.withLock { recordedReceiptOptionsCalls += 1 }
        guard let receiptOptionsHandler else { throw UnstubbedCall(endpoint: "receiptOptions") }
        return try await receiptOptionsHandler()
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

    func deleteAccount(appleAuthorizationCode: String?) async throws {
        callLock.withLock { recordedDeleteAccountCalls.append(appleAuthorizationCode) }
        guard let deleteAccountHandler else { throw UnstubbedCall(endpoint: "deleteAccount") }
        try await deleteAccountHandler(appleAuthorizationCode)
    }
}
