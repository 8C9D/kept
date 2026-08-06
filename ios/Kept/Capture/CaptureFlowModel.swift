import Foundation

/// One page scanned and parsed, held in memory while the person confirms
/// it (the single-capture flow). It becomes durable the moment either
/// exit fires - Save queues it confirmed, Later queues it pending. Until
/// then the paper is still in the person's hand, which is the §7.4
/// guarantee's actual anchor: safety starts at Save, not at scan.
struct CapturedReceiptDraft {
    let imageData: Data
    let suggestions: ReceiptSuggestions
    let ocrRawText: String?
    let capturedAt: Date
    /// Stated when on-device recognition failed outright, so the blank
    /// form reads as "recognition failed", not "the receipt is blank".
    let ocrFailureNote: String?
}

/// Turns scanned pages into durably queued receipts (spec §6A, §7.4),
/// down one of two paths the wave-5 gate ratification split:
///
/// - **A single page goes straight to the confirm screen** - OCR runs on
///   device (no network), the form prefills, and Save writes the
///   confirmed receipt into the outbox as a disk-only, immediately-
///   returning operation. Online is the common case and confirming in
///   the moment is the §1 success test; the outbox still owns everything
///   after Save. "Later" queues it pending instead - either exit leaves
///   the receipt safe.
/// - **A batch queues immediately, one pending receipt per page**, and is
///   worked down through the confirm queue afterwards - correct for a
///   stack of eighty, where confirming in the moment is exactly wrong.
///
/// A failure mid-batch (a full disk, realistically) stops at the failing
/// page and offers retry from there - pages already queued stay queued.
@MainActor
final class CaptureFlowModel: ObservableObject {
    enum Phase {
        case idle
        /// Single capture: on-device OCR is running. Quick, and never a
        /// network wait.
        case reading
        /// Single capture: the §7.2 form is up, backed by local data.
        case confirming(ConfirmReceiptModel)
        /// Batch: pageNumber is 1-based - it feeds "Saving receipt 2 of 5"
        /// directly.
        case saving(pageNumber: Int, pageCount: Int)
        case failed(String)
        case saved(count: Int)
    }

    @Published private(set) var phase: Phase = .idle

    private let outbox: any OutboxEnqueuing
    private let recognizer: any ReceiptTextRecognizer
    private let now: @Sendable () -> Date

    /// Batch pages not yet saved; the head is the one being worked on.
    /// Kept so retry resumes at the failure, not from the top.
    private var remainingPages: [Data] = []
    private var savedCount = 0

    /// The single capture awaiting its confirm-screen exit, kept so a
    /// failed "Later" enqueue can be retried from the failure screen.
    private var singleDraft: CapturedReceiptDraft?
    /// True when the pending failure screen belongs to a single capture's
    /// "Later" exit rather than a batch page - retry() re-runs that exit.
    private var retryIsSingleSetAside = false

    /// Re-entrancy guard: each enqueue below is a suspension point where a
    /// double-tapped retry could start a second pass over the same head
    /// page - queueing it twice and dropping a later one (the wave-3
    /// interleave lesson, found again by the wave-4 reviewer).
    private var isProcessing = false

    init(
        outbox: any OutboxEnqueuing,
        recognizer: any ReceiptTextRecognizer,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.outbox = outbox
        self.recognizer = recognizer
        self.now = now
    }

    /// Entry point after the scanner returns. A call while a pass is
    /// already running is dropped - there is no legitimate second batch
    /// mid-batch.
    func savePages(_ pages: [Data]) async {
        guard !isProcessing else { return }
        if pages.count == 1, let page = pages.first {
            await prepareSingleCapture(page)
        } else {
            remainingPages = pages
            savedCount = 0
            await saveRemaining()
        }
    }

    func retry() async {
        if retryIsSingleSetAside {
            await setAsideSingleCapture()
        } else {
            await saveRemaining()
        }
    }

    // MARK: - Single capture (scan → confirm, per the gate ratification)

    private func prepareSingleCapture(_ page: Data) async {
        isProcessing = true
        defer { isProcessing = false }

        phase = .reading
        var suggestions = ReceiptSuggestions()
        var rawText: String?
        var ocrFailureNote: String?
        do {
            let recognized = try await recognizer.recognizeText(in: page)
            suggestions = ReceiptParser.parse(lines: recognized.lines)
            rawText = recognized.rawText.isEmpty ? nil : recognized.rawText
        } catch {
            // Recognition failing must not block capture: the paper is in
            // the person's hand and the remedy - type what it says - is
            // the very screen coming up next. The failure is stated on
            // that screen rather than swallowed.
            ocrFailureNote = "The image could not be read for text: \(error.localizedDescription)"
        }
        let draft = CapturedReceiptDraft(
            imageData: page,
            suggestions: suggestions,
            ocrRawText: rawText,
            capturedAt: now(),
            ocrFailureNote: ocrFailureNote
        )
        singleDraft = draft
        // Weak: the phase below retains the confirm model, whose closure
        // would otherwise retain this model back into a cycle. The model
        // being gone means the flow was torn down; nothing to save into.
        let confirmModel = ConfirmReceiptModel(draft: draft) { [weak self] fields in
            guard let self else { throw CaptureFlowTornDownError() }
            try await self.outbox.enqueue(
                imageData: draft.imageData,
                parsed: ParsedReceipt(suggestions: draft.suggestions, ocrRawText: draft.ocrRawText),
                confirmation: fields
            )
        }
        phase = .confirming(confirmModel)
    }

    /// "Later" on the capture-time confirm screen: the receipt still gets
    /// queued - pending, like a batch page - because leaving the screen
    /// must never cost the scan.
    func setAsideSingleCapture() async {
        guard !isProcessing, let draft = singleDraft else { return }
        isProcessing = true
        defer { isProcessing = false }

        do {
            try await outbox.enqueue(
                imageData: draft.imageData,
                parsed: ParsedReceipt(suggestions: draft.suggestions, ocrRawText: draft.ocrRawText),
                confirmation: nil
            )
            retryIsSingleSetAside = false
            singleDraft = nil
            phase = .saved(count: 1)
        } catch {
            retryIsSingleSetAside = true
            phase = .failed("This receipt could not be saved to this phone: \(error.localizedDescription)")
        }
    }

    /// The confirm screen saved successfully; its saveAction has already
    /// queued the confirmed receipt durably.
    func finishSingleCapture() {
        singleDraft = nil
        phase = .saved(count: 1)
    }

    /// Thrown only if the confirm screen outlives the capture flow that
    /// created it - a wiring bug, stated rather than silently succeeded.
    struct CaptureFlowTornDownError: LocalizedError {
        var errorDescription: String? {
            "The capture screen was closed before the receipt could be saved. Scan it again."
        }
    }

    // MARK: - Batch (each page queues pending; the queue confirms later)

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
