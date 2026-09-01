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

    /// How long the capture-time second opinion is given before it is
    /// abandoned silently (2026-09-01). The model answers in a median 5
    /// seconds and the median dwell on the confirm screen is 47, so twelve
    /// is generous for the answer and short enough that a dead network
    /// costs a task that nobody is waiting on.
    static let secondOpinionTimeout: TimeInterval = 12

    /// The server's LLM reading the same OCR text - injected as a plain
    /// async function so this model still holds no `KeptAPI` of its own and
    /// stays testable with no server (spec §10.2). Nil in every path that
    /// has no network to offer.
    typealias RemoteParse = @Sendable (_ ocrRawText: String, _ capturedAt: Date) async throws -> ReceiptSuggestions

    private let outbox: any OutboxEnqueuing
    private let recognizer: any ReceiptTextRecognizer
    /// The person's own past vendor names, read at parse time rather than
    /// captured at construction, so a fetch that lands while the capture
    /// screen is up is already in effect for the next scan. Read, never
    /// fetched: this screen is the offline path.
    private let knownVendors: @MainActor () -> [String]
    private let remoteParse: RemoteParse?
    /// Injectable only so the timeout path itself is testable in
    /// milliseconds rather than twelve seconds; production always uses
    /// `secondOpinionTimeout`.
    private let secondOpinionTimeout: TimeInterval
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
    /// What the confirm form held when "Later" was tapped (2026-09-01),
    /// read off the model before `phase` moves on. Kept here rather than
    /// re-read at enqueue time because a failed "Later" leaves `phase` on
    /// the failure screen, and `retry()` must send the same typed values
    /// the first attempt did rather than silently fall back to the
    /// parser's snapshot.
    private var singlePartial: PendingReceiptFields?

    /// Re-entrancy guard: each enqueue below is a suspension point where a
    /// double-tapped retry could start a second pass over the same head
    /// page - queueing it twice and dropping a later one (the wave-3
    /// interleave lesson, found again by the wave-4 reviewer).
    private var isProcessing = false

    init(
        outbox: any OutboxEnqueuing,
        recognizer: any ReceiptTextRecognizer,
        knownVendors: @escaping @MainActor () -> [String] = { [] },
        remoteParse: RemoteParse? = nil,
        secondOpinionTimeout: TimeInterval = CaptureFlowModel.secondOpinionTimeout,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.outbox = outbox
        self.recognizer = recognizer
        self.knownVendors = knownVendors
        self.remoteParse = remoteParse
        self.secondOpinionTimeout = secondOpinionTimeout
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
        let capturedAt = now()
        var suggestions = ReceiptSuggestions()
        var rawText: String?
        var ocrFailureNote: String?
        do {
            let recognized = try await recognizer.recognizeText(in: page)
            suggestions = ReceiptParser.parse(
                lines: recognized.lines,
                capturedAt: capturedAt,
                knownVendors: knownVendors()
            )
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
            capturedAt: capturedAt,
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

        if let rawText {
            requestSecondOpinion(rawText: rawText, capturedAt: capturedAt, for: confirmModel)
        }
    }

    /// The server's LLM reading the same text, applied to the confirm
    /// screen when and if it answers (2026-09-01).
    ///
    /// Fire and forget, in every direction that matters: the screen is
    /// already up before this starts, it is never awaited, a failure or a
    /// timeout does nothing and says nothing, and there is no log line -
    /// this is the offline screen, and the network is a bonus laid on top
    /// of it. `ConfirmSuggestionSet(parse:)` runs the same
    /// arithmetic-sanity rule over the server's answer that the on-device
    /// one goes through, because a set of amounts that cannot be true is
    /// not made truer by which parser produced it.
    private func requestSecondOpinion(rawText: String, capturedAt: Date, for model: ConfirmReceiptModel) {
        guard let remoteParse else { return }
        let timeout = secondOpinionTimeout
        Task { [weak model] in
            guard
                let suggestions = await Self.parseWithinTimeout(remoteParse, rawText, capturedAt, timeout),
                let model
            else { return }
            model.applyServerSuggestions(ConfirmSuggestionSet(parse: suggestions))
        }
    }

    /// The request, or nil - a thrown error and a timeout are the same
    /// outcome here, because the caller does the same thing with both.
    private static func parseWithinTimeout(
        _ parse: @escaping RemoteParse,
        _ rawText: String,
        _ capturedAt: Date,
        _ timeout: TimeInterval
    ) async -> ReceiptSuggestions? {
        await withTaskGroup(of: ReceiptSuggestions?.self) { group in
            group.addTask { try? await parse(rawText, capturedAt) }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(max(0, timeout) * 1_000_000_000))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }

    /// "Later" on the capture-time confirm screen: the receipt still gets
    /// queued - pending, like a batch page - because leaving the screen
    /// must never cost the scan.
    ///
    /// ⚠ It must not cost the TYPING either (2026-09-01). Until now this
    /// discarded whatever had been entered: the vendor someone had just
    /// corrected, the total they had just read off the paper, all of it
    /// gone, and the receipt queued carrying the parser's snapshot alone -
    /// so the confirm queue offered them the same wrong guesses again
    /// later. The confirm form's own reviewed set
    /// (`pendingReceiptFields()`) rides along instead, and the drain's
    /// create writes those columns and reports them reviewed. Nil when
    /// nobody had touched anything, which is the ordinary case, and the
    /// create body is then exactly what it always was.
    func setAsideSingleCapture() async {
        guard !isProcessing, let draft = singleDraft else { return }
        isProcessing = true
        defer { isProcessing = false }

        if case .confirming(let model) = phase {
            singlePartial = model.pendingReceiptFields()
        }

        do {
            try await outbox.enqueue(
                imageData: draft.imageData,
                parsed: ParsedReceipt(suggestions: draft.suggestions, ocrRawText: draft.ocrRawText),
                confirmation: nil,
                partial: singlePartial
            )
            retryIsSingleSetAside = false
            singleDraft = nil
            singlePartial = nil
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
        singlePartial = nil
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
