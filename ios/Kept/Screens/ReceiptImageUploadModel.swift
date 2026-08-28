import CryptoKit
import Foundation

/// Adding a page and replacing a page's image (proposal #6, 2026-08-28):
/// the two ways bytes attach to a receipt that already exists, rather than
/// only at creation. Both go through the exact request sequence the create
/// route's own image handling already uses - presign (`uploadTarget`), PUT
/// the bytes, THEN tell the API - because that ordering is the whole
/// defense against the §8 sharp edge: a receipt row (or, here, an image
/// row) pointing at bytes that were never actually written, which jams
/// every export of its period. `uploadOnePage` below is a straight-line
/// `try` chain for exactly that reason - a failed PUT throws before the
/// API is ever told about it, by construction, not by a check someone
/// could forget.
///
/// **Deliberately NOT routed through the offline outbox (§7.4).** The
/// outbox's guarantee is that a receipt is safe the instant someone hits
/// save while standing in a shop with bad signal; adding or replacing a
/// page happens against a receipt that is already durably stored server-
/// side, ordinarily as a desk activity (fixing something noticed later),
/// not a shop-floor capture. Queuing this instead of failing it would let
/// a scanned image sit unsent for hours with no visible reason on a screen
/// that looks synchronous, and - for replace specifically - risk a stale
/// objectKey outliving the presigned URL it was issued against. This
/// requires connectivity and fails clearly, with a retry the person
/// controls (`retry()`), exactly like every other desk-time edit in this
/// app (a PATCH from the confirm screen, a delete). Reconsider only if
/// this screen starts seeing capture-time-style usage - scanning a repair
/// while actually standing in the store, offline - which nothing today
/// suggests; short of that, failing clearly and letting a human retry
/// costs nothing the outbox's guarantee is there to protect.
@MainActor
final class ReceiptImageUploadModel: ObservableObject {
    enum Phase {
        case idle
        /// `pageCount` is always 1 for a replace (exactly one image) and
        /// the scanned page count for an add - callers use it only to
        /// decide whether "page N of M" framing is worth showing.
        case uploading(pageNumber: Int, pageCount: Int)
        case failed(String)
        case finished
    }

    @Published private(set) var phase: Phase = .idle

    private let api: any KeptAPI
    private let eventLogger: EventLogger
    private let receiptId: UUID

    /// Nil while adding pages (the server assigns each one's number, never
    /// this client - routes/receipts.ts's own comment on why); set while
    /// replacing, since a replace always targets one specific,
    /// already-existing page number.
    private var replacingPage: Int?
    /// Pages not yet sent; the head is the one in flight. Kept so retry()
    /// resumes at the failure rather than from the top - the same shape
    /// CaptureFlowModel's batch path uses for the identical reason.
    private var remainingPages: [Data] = []
    private var completedCount = 0
    /// Re-entrancy guard: two taps in quick succession (or a stray second
    /// call while one run is in flight) must not upload the same page
    /// twice or silently drop one - the same lesson CaptureFlowModel's
    /// `isProcessing` and ReceiptDetailModel's `isDeleting` already encode.
    private var isProcessing = false

    init(api: any KeptAPI, eventLogger: EventLogger, receiptId: UUID) {
        self.api = api
        self.eventLogger = eventLogger
        self.receiptId = receiptId
    }

    /// "Add a page" (proposal #6): the scanner can return several pages in
    /// one session (batch scanning, §6A), and every one of them is added,
    /// in scan order. The server assigns page numbers; this model never
    /// guesses one either - the caller reloads the receipt detail once
    /// `finished` to see what the server actually assigned, rather than
    /// hand-mutating local state into a shape the server has not
    /// confirmed.
    func addPages(_ pages: [Data]) async {
        guard !isProcessing else { return }
        replacingPage = nil
        remainingPages = pages
        completedCount = 0
        await uploadRemaining()
    }

    /// "Replace this page's image" (proposal #6): the repair path for a
    /// page whose photo never finished uploading, without losing the
    /// receipt's vendor, date, total or HST - the old row is soft-deleted
    /// and kept server-side (spec §5/§10B), never erased. Always exactly
    /// one image; modelled as a one-item `remainingPages` so the upload
    /// loop below needs no second code path.
    func replacePage(_ page: Int, data: Data) async {
        guard !isProcessing else { return }
        replacingPage = page
        remainingPages = [data]
        completedCount = 0
        await uploadRemaining()
    }

    /// Resumes after a failure, starting at the page that failed - pages
    /// the server already confirmed are not resent.
    func retry() async {
        await uploadRemaining()
    }

    private func uploadRemaining() async {
        guard !isProcessing else { return }
        isProcessing = true
        defer { isProcessing = false }

        let pageCount = completedCount + remainingPages.count
        while let page = remainingPages.first {
            phase = .uploading(pageNumber: completedCount + 1, pageCount: pageCount)
            do {
                try await uploadOnePage(page)
            } catch {
                phase = .failed(failureMessage(for: error, pageCount: pageCount))
                return
            }
            completedCount += 1
            remainingPages.removeFirst()
        }
        // `receipt_edited` (2026-08-28 vocabulary): a page's bytes
        // changed, the same class of thing an edited field is. No `field`
        // value is attached - there is no EventField for "images", and the
        // rule (EventLogger's own doc comment) is never to log a value
        // anyway.
        eventLogger.log(.receiptEdited, receiptId: receiptId)
        phase = .finished
    }

    /// The one request sequence, in order: presign, PUT the bytes, THEN
    /// tell the API. This is the line that matters most on this type
    /// (see ReceiptImageUploadModelTests) - a thrown error from
    /// `uploadImage` exits this function before either
    /// `addReceiptImage`/`replaceReceiptImage` call is reached, so a
    /// failed PUT can never be followed by an API call about bytes that
    /// are not there. Recreating that ordering bug here would be strictly
    /// worse than the original create-route sharp edge (§8), because this
    /// path exists specifically to repair it.
    private func uploadOnePage(_ data: Data) async throws {
        let target = try await api.uploadTarget(contentType: .jpeg)
        try await api.uploadImage(to: target, data: data, contentType: .jpeg)
        let sha256 = Self.sha256Hex(data)
        if let page = replacingPage {
            _ = try await api.replaceReceiptImage(
                receiptId: receiptId,
                page: page,
                objectKey: target.objectKey,
                sha256: sha256
            )
        } else {
            _ = try await api.addReceiptImage(
                receiptId: receiptId,
                objectKey: target.objectKey,
                sha256: sha256
            )
        }
    }

    /// A single add or any replace surfaces the server's own message
    /// unwrapped (spec §8's design principle: "a failure names its
    /// remedy" - this client invents no wording of its own for a 409
    /// duplicate_image or any other server refusal). A multi-page add
    /// gets "page N of M" framing on top, the same shape
    /// CaptureFlowModel's batch failures already use, since which page
    /// failed is itself useful information there.
    private func failureMessage(for error: Error, pageCount: Int) -> String {
        guard pageCount > 1 else {
            return error.localizedDescription
        }
        let pageNumber = completedCount + 1
        let done = completedCount > 0 ? " The first \(completedCount) added." : ""
        return "Page \(pageNumber) could not be added: \(error.localizedDescription)\(done)"
    }

    private static func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data)
            .map { String(format: "%02x", $0) }
            .joined()
    }
}
