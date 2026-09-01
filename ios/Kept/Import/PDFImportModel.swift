import Foundation

/// Importing emailed PDF receipts from Files (2026-09-01).
///
/// The shape is the batch capture's, deliberately, because it is the same
/// job: several documents in, one durably queued PENDING receipt each,
/// worked down through the confirm queue afterwards. Nobody confirms an
/// import in the moment - a backlog of emailed receipts is worked at a
/// desk, not while standing in a shop with the paper in hand, and §1's
/// "under a minute" is about the capture that has a person waiting on it.
/// So there is no capture-time confirm screen here, and every import lands
/// pending exactly as a scanned batch page does.
///
/// A failure stops at the failing file and offers retry from there - the
/// documents already queued stay queued, and the remaining ones are still
/// in hand. Same rule, same wording shape, as `CaptureFlowModel`'s batch.
@MainActor
final class PDFImportModel: ObservableObject {
    enum Phase: Equatable {
        case idle
        /// `fileNumber` is 1-based, so it feeds "Importing 2 of 5"
        /// directly.
        case importing(fileNumber: Int, fileCount: Int)
        case failed(String)
        /// `truncatedFiles` names any document whose text layer ran past
        /// the server's 100 000-character bound - vanishingly rare (that
        /// is around thirty dense pages), and stated rather than swallowed
        /// when it happens, because the receipt was queued carrying part
        /// of its document's text and nobody should be told otherwise.
        case finished(count: Int, truncatedFiles: [String])
    }

    @Published private(set) var phase: Phase = .idle

    private let outbox: any OutboxEnqueuing
    private let recognizer: any ReceiptTextRecognizer
    /// The person's own past vendor names, for the heuristic's
    /// known-vendor pass - read, never fetched, exactly as the capture
    /// screen reads them. Only ever consulted on the scanned-PDF fallback:
    /// a text-layer import runs no on-device heuristic at all.
    private let knownVendors: @MainActor () -> [String]
    private let now: @Sendable () -> Date

    /// Files not yet imported; the head is the one being worked on. Kept
    /// so retry resumes at the failure rather than re-importing what
    /// already landed - a re-import would 409 on the identical bytes
    /// anyway, but "already queued" is not a failure to show anyone.
    private var remainingFiles: [URL] = []
    private var importedCount = 0
    /// Names of files whose text layer hit the server's cap, collected
    /// across the pass so the finish can state them.
    private var truncatedFiles: [String] = []
    /// Re-entrancy guard, the same one the capture flow carries: a
    /// double-tapped retry must not start a second pass over the head
    /// file and queue it twice.
    private var isProcessing = false

    init(
        outbox: any OutboxEnqueuing,
        recognizer: any ReceiptTextRecognizer = VisionReceiptTextRecognizer(),
        knownVendors: @escaping @MainActor () -> [String] = { [] },
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.outbox = outbox
        self.recognizer = recognizer
        self.knownVendors = knownVendors
        self.now = now
    }

    /// Entry point from the file importer. A call while a pass is running
    /// is dropped - there is no legitimate second import mid-import.
    func importFiles(_ urls: [URL]) async {
        // `.idle` as well as the re-entrancy guard: the view starts this
        // from a `task`, and a task that ran a second time on the same
        // presentation would import the same folder twice.
        guard case .idle = phase, !isProcessing, !urls.isEmpty else { return }
        remainingFiles = urls
        importedCount = 0
        truncatedFiles = []
        await importRemaining()
    }

    func retry() async {
        await importRemaining()
    }

    private func importRemaining() async {
        guard !isProcessing else { return }
        isProcessing = true
        defer { isProcessing = false }

        let fileCount = importedCount + remainingFiles.count
        while let url = remainingFiles.first {
            phase = .importing(fileNumber: importedCount + 1, fileCount: fileCount)
            do {
                try await importOne(url)
            } catch {
                phase = .failed(failureMessage(for: error, url: url))
                return
            }
            importedCount += 1
            remainingFiles.removeFirst()
        }
        phase = .finished(count: importedCount, truncatedFiles: truncatedFiles)
    }

    /// One picked file: read its bytes, read the document, queue it.
    ///
    /// ⚠ The bytes are copied out of the security-scoped URL immediately
    /// and everything after works from `Data`. The scope's grant is tied
    /// to this call - it is released the moment this function returns, and
    /// the outbox may not reach the upload for hours - so holding the URL
    /// and reading it later is a read that would simply fail, silently,
    /// long after the person was told the import worked.
    private func importOne(_ url: URL) async throws {
        let documentData = try await Self.readDocument(at: url)
        let reading = await PDFReceiptReading.read(documentData: documentData)
        let capturedAt = now()

        switch reading {
        case .unreadable:
            throw ImportFailure.unreadableDocument(name: url.lastPathComponent)

        case .textLayer(let extraction):
            if extraction.truncated {
                truncatedFiles.append(url.lastPathComponent)
            }
            // the owner's decision: the text layer travels and the SERVER's
            // LLM parses it. No on-device suggestions ride along - an
            // empty `ReceiptSuggestions` is the honest record that no
            // parser on this phone read this document (the create's
            // `ocrSuggestions` is immutable and is the §7.3 accuracy
            // record; a guess written into it would be a reading nobody
            // made).
            try await outbox.enqueue(
                document: OutboxDocument(
                    data: documentData,
                    contentType: .pdf,
                    ocrSource: .pdfText
                ),
                parsed: ParsedReceipt(suggestions: ReceiptSuggestions(), ocrRawText: extraction.text),
                confirmation: nil,
                partial: nil
            )

        case .rendered(let pageImage):
            // A scanned PDF: no text layer to read, so it goes down the
            // camera path - Vision, then the same heuristics. Recognition
            // failing is not fatal here either (the capture flow's rule):
            // the document is still worth queueing, and the confirm queue
            // is where a person types what it says.
            //
            // ⚠ The recognizer's own error is deliberately dropped rather
            // than surfaced: unlike the camera path, there is no confirm
            // screen up at this moment to state it on, and the receipt is
            // going to the confirm queue either way. What is lost is the
            // distinction between "this scan has no readable text" and
            // "Vision failed on it" - accepted, because the remedy a
            // person has for both is identical and is the same queue.
            var suggestions = ReceiptSuggestions()
            var rawText: String?
            if let recognized = try? await recognizer.recognizeText(in: pageImage) {
                suggestions = ReceiptParser.parse(
                    lines: recognized.lines,
                    capturedAt: capturedAt,
                    knownVendors: knownVendors()
                )
                rawText = recognized.rawText.isEmpty ? nil : recognized.rawText
            }
            try await outbox.enqueue(
                // The ORIGINAL PDF, never the render: what a tax record
                // stores is the document that was emailed.
                document: OutboxDocument(
                    data: documentData,
                    contentType: .pdf,
                    ocrSource: .vision
                ),
                parsed: ParsedReceipt(suggestions: suggestions, ocrRawText: rawText),
                confirmation: nil,
                partial: nil
            )
        }
    }

    /// `nonisolated` AND `async`, both deliberately: a nonisolated
    /// synchronous function called from the main actor still runs ON the
    /// main thread, so only the async form actually hops off it - and a
    /// folder of emailed receipts can hold multi-megabyte files whose read
    /// under someone's thumb is a visible stall.
    private nonisolated static func readDocument(at url: URL) async throws -> Data {
        // A file picked through UIDocumentPicker arrives security-scoped;
        // without this the read fails outright. `false` is a legitimate
        // answer for a URL that needs no scope (an in-sandbox file), so it
        // gates only the matching stop, never the read.
        let scoped = url.startAccessingSecurityScopedResource()
        defer {
            if scoped {
                url.stopAccessingSecurityScopedResource()
            }
        }
        do {
            return try Data(contentsOf: url)
        } catch {
            throw ImportFailure.unreadableFile(name: url.lastPathComponent, underlying: error)
        }
    }

    private func failureMessage(for error: Error, url: URL) -> String {
        let fileNumber = importedCount + 1
        let done = importedCount > 0 ? " The first \(importedCount) imported." : ""
        return "File \(fileNumber) (\(url.lastPathComponent)) could not be imported: \(error.localizedDescription)\(done)"
    }

    /// The two ways a picked file fails to become a receipt, both named
    /// rather than folded into a generic message: one is a file the app
    /// could not open at all, the other a file that opened and was not a
    /// PDF with pages in it. A person looking at a folder of attachments
    /// can act on the difference.
    enum ImportFailure: LocalizedError {
        case unreadableFile(name: String, underlying: Error)
        case unreadableDocument(name: String)

        var errorDescription: String? {
            switch self {
            case .unreadableFile(_, let underlying):
                return "the file could not be read (\(underlying.localizedDescription))"
            case .unreadableDocument:
                return "it is not a PDF this phone can open"
            }
        }
    }
}
