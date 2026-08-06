import Foundation

/// Turns scanned pages into durably queued receipts, one per page (spec
/// §6A: batch mode; §7.4: the queue). Saving a page is a disk write into
/// the outbox - no OCR, no network - so the person is back on Home in
/// about the time the scanner takes to dismiss, whatever the signal
/// situation. The outbox owns everything after that: recognition, upload,
/// create, retry.
///
/// A failure mid-batch (a full disk, realistically) stops at the failing
/// page and offers retry from there - pages already queued stay queued,
/// and the paper for the failed page is still in the person's hand.
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

    private let outbox: any OutboxEnqueuing

    /// Pages not yet queued; the head is the one being worked on. Kept so
    /// retry resumes at the failure, not from the top.
    private var remainingPages: [Data] = []
    private var savedCount = 0

    /// Re-entrancy guard: each enqueue below is a suspension point where a
    /// double-tapped retry could start a second pass over the same head
    /// page - queueing it twice and dropping a later one (the wave-3
    /// interleave lesson, found again by the wave-4 reviewer).
    private var isProcessing = false

    init(outbox: any OutboxEnqueuing) {
        self.outbox = outbox
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
                try await outbox.enqueue(imageData: page)
            } catch {
                phase = .failed(failureMessage(for: error))
                return
            }
            savedCount += 1
            remainingPages.removeFirst()
        }
        phase = .saved(count: savedCount)
    }

    private func failureMessage(for error: Error) -> String {
        let pageNumber = savedCount + 1
        let saved = savedCount > 0 ? " The first \(savedCount) saved." : ""
        return "Receipt \(pageNumber) could not be saved to this phone: \(error.localizedDescription)\(saved)"
    }
}
