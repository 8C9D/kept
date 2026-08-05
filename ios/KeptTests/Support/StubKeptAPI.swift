import Foundation
@testable import Kept

/// A KeptAPI whose behaviour each test scripts with closures, recording
/// calls for assertion. Model tests use this; transport-level behaviour
/// (headers, error mapping) is APIClientTests' job against StubTransport.
final class StubKeptAPI: KeptAPI {
    struct UnstubbedCall: Error {
        let endpoint: String
    }

    var signInHandler: ((_ identityToken: String, _ displayName: String?) async throws -> SignInResponse)?
    var receiptsPageHandler: ((_ cursor: String?, _ status: ReceiptStatus?, _ limit: Int?) async throws -> ReceiptListPage)?
    var receiptDetailHandler: ((_ id: UUID) async throws -> ReceiptDetail)?

    /// ReceiptListModel fetches its first page and the pending probe with
    /// `async let`, so two tasks call receiptsPage concurrently; the call
    /// log must be lock-guarded or the appends are a data race. (Wave-3
    /// reviewer finding.)
    private let callLock = NSLock()
    private var recordedReceiptsPageCalls: [(cursor: String?, status: ReceiptStatus?, limit: Int?)] = []

    var receiptsPageCalls: [(cursor: String?, status: ReceiptStatus?, limit: Int?)] {
        callLock.withLock { recordedReceiptsPageCalls }
    }

    func signInWithApple(identityToken: String, displayName: String?) async throws -> SignInResponse {
        guard let signInHandler else { throw UnstubbedCall(endpoint: "signInWithApple") }
        return try await signInHandler(identityToken, displayName)
    }

    func receiptsPage(cursor: String?, status: ReceiptStatus?, limit: Int?) async throws -> ReceiptListPage {
        callLock.withLock { recordedReceiptsPageCalls.append((cursor, status, limit)) }
        guard let receiptsPageHandler else { throw UnstubbedCall(endpoint: "receiptsPage") }
        return try await receiptsPageHandler(cursor, status, limit)
    }

    func receiptDetail(id: UUID) async throws -> ReceiptDetail {
        guard let receiptDetailHandler else { throw UnstubbedCall(endpoint: "receiptDetail") }
        return try await receiptDetailHandler(id)
    }
}
