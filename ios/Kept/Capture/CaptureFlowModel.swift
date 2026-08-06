import CryptoKit
import Foundation

/// Turns scanned pages into stored pending receipts, one per page
/// (spec §6A: batch mode). For each page, in order: recognize text on
/// device, parse suggestions, get a presigned upload target, upload the
/// JPEG, create the receipt as `pending` with the suggestions and the raw
/// text. The confirm queue then works the batch down.
///
/// Every dependency is injected (API, recognizer, clock), so the whole
/// state machine is testable on the simulator; only the camera that
/// produced the page bytes is not (spec §10.2).
///
/// A failure mid-batch stops at the failing page and offers retry from
/// there - pages already saved stay saved (they are server-side pending
/// receipts, not local state). Until the wave-5 outbox exists, killing the
/// app mid-batch loses only the unsaved pages, and the paper is still in
/// the person's hand.
@MainActor
final class CaptureFlowModel: ObservableObject {
    enum Phase {
        case idle
        /// pageNumber is 1-based - it feeds "Saving receipt 2 of 5" directly.
        case saving(pageNumber: Int, pageCount: Int)
        case failed(String)
        case saved(count: Int)
    }

    @Published private(set) var phase: Phase = .idle

    private let api: any KeptAPI
    private let recognizer: any ReceiptTextRecognizer
    private let now: () -> Date

    /// Pages not yet saved; the head is the one being worked on. Kept so
    /// retry resumes at the failure, not from the top.
    private var remainingPages: [Data] = []
    private var savedCount = 0

    /// Re-entrancy guard: every await below is a suspension point where a
    /// second savePages or a double-tapped retry could start a second pass
    /// over the same head page - saving it twice and dropping a later one
    /// (the wave-3 interleave lesson, found again by this wave's reviewer).
    private var isProcessing = false

    init(
        api: any KeptAPI,
        recognizer: any ReceiptTextRecognizer,
        now: @escaping () -> Date = Date.init
    ) {
        self.api = api
        self.recognizer = recognizer
        self.now = now
    }

    /// Entry point after the scanner returns. Restarts the counters: one
    /// scan session, one batch. A call while a pass is already running is
    /// dropped - there is no legitimate second batch mid-batch.
    func savePages(_ pages: [Data]) async {
        guard !isProcessing else { return }
        remainingPages = pages
        savedCount = 0
        await saveRemaining()
    }

    func retry() async {
        await saveRemaining()
    }

    private func saveRemaining() async {
        guard !isProcessing else { return }
        isProcessing = true
        defer { isProcessing = false }

        let pageCount = savedCount + remainingPages.count
        while let page = remainingPages.first {
            phase = .saving(pageNumber: savedCount + 1, pageCount: pageCount)
            do {
                try await saveOnePage(page)
            } catch let error as APIError where error.isDuplicateImage {
                // These exact bytes are already attached to one of the
                // user's receipts. Off the camera path that has one cause:
                // a retry after a create whose response got lost - two
                // photographs of even the same paper never share bytes
                // (spec §5). The receipt exists server-side; continuing is
                // the honest recovery, not a masked failure.
            } catch {
                phase = .failed(failureMessage(for: error))
                return
            }
            savedCount += 1
            remainingPages.removeFirst()
        }
        phase = .saved(count: savedCount)
    }

    private func saveOnePage(_ page: Data) async throws {
        let recognized = try await recognizer.recognizeText(in: page)
        let suggestions = ReceiptParser.parse(lines: recognized.lines)

        let contentType = ImageUploadContentType.jpeg // the scanner emits JPEG
        let target = try await api.uploadTarget(contentType: contentType)
        try await api.uploadImage(to: target, data: page, contentType: contentType)

        let digest = SHA256.hash(data: page)
            .map { String(format: "%02x", $0) }
            .joined()

        _ = try await api.createReceipt(CreateReceiptRequest(
            // The parser's date when it found one; otherwise today, since
            // most single captures happen the day of purchase. Either way
            // the confirm screen presents it amber - a suggestion to check,
            // never silently trusted (spec §7.2).
            purchasedAt: suggestions.purchasedAt ?? Self.calendarDate(of: now()),
            capturedAt: Self.timestamp(of: now()),
            vendor: suggestions.vendor,
            vendorTaxNumber: suggestions.vendorTaxNumber,
            subtotalCents: suggestions.subtotalCents,
            hstCents: suggestions.hstCents,
            totalCents: suggestions.totalCents,
            ocrRawText: recognized.rawText.isEmpty ? nil : recognized.rawText,
            ocrSuggestions: OcrSuggestionsPayload(suggestions),
            image: CreateReceiptRequest.Image(objectKey: target.objectKey, sha256: digest)
        ))
    }

    private func failureMessage(for error: Error) -> String {
        let pageNumber = savedCount + 1
        let saved = savedCount > 0 ? " The first \(savedCount) saved." : ""
        return "Receipt \(pageNumber) could not be saved: \(error.localizedDescription)\(saved)"
    }

    // MARK: - Timestamps

    /// The capture day in the person's own calendar - the date they would
    /// write on the receipt, not UTC's opinion of it. Assembled from
    /// explicit components: a format style's output order belongs to the
    /// locale, and this string is API syntax, not display text.
    static func calendarDate(of date: Date) -> String {
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: date)
        guard let year = parts.year, let month = parts.month, let day = parts.day else {
            // dateComponents with these units always yields them; treat the
            // impossible as impossible rather than inventing a date.
            preconditionFailure("Calendar returned no year/month/day for \(date)")
        }
        return String(format: "%04d-%02d-%02d", year, month, day)
    }

    static func timestamp(of date: Date) -> String {
        date.formatted(.iso8601)
    }
}

private extension APIError {
    var isDuplicateImage: Bool {
        if case .requestFailed(let code, _, _) = self {
            return code == "duplicate_image"
        }
        return false
    }
}
