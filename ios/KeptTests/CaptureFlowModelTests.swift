import XCTest
@testable import Kept

/// The capture flow after wave 5 and its gate ratification: a single page
/// goes scan → on-device read → local-backed confirm screen, whose exits
/// both write durably into the outbox; a batch queues pending
/// immediately. Under test here: the split, the confirm screen's local
/// backing and both its exits, batch bookkeeping (order, resume at the
/// failing page, re-entrancy), and failed saves presented as exactly
/// that. Everything network-shaped lives in OutboxControllerTests.
@MainActor
final class CaptureFlowModelTests: XCTestCase {
    /// An OutboxEnqueuing that records pages (and what came with them)
    /// and fails on cue - the scripted stand-in for a full disk.
    @MainActor
    private final class StubOutbox: OutboxEnqueuing {
        struct DiskFull: LocalizedError {
            var errorDescription: String? { "There is not enough storage." }
        }

        struct EnqueuedReceipt {
            let document: OutboxDocument
            let parsed: ParsedReceipt?
            let confirmation: ConfirmedReceiptFields?
            /// What the confirm form had half-filled when "Later" was
            /// tapped (2026-09-01) - nil for a batch page and for a Later
            /// nobody had typed anything into.
            let partial: PendingReceiptFields?

            var imageData: Data { document.data }
            /// Pages two and up (2026-09-01, "one receipt with N pages").
            var additionalPages: [Data] { document.additionalPages }
        }

        private(set) var enqueued: [EnqueuedReceipt] = []
        var enqueuedPages: [Data] { enqueued.map(\.imageData) }
        /// 1-based call number that throws; consumed once, so a retry of
        /// the same page succeeds - the resume path.
        var failOnCallNumber: Int?
        /// Runs before each enqueue - the hook interleave tests park on.
        var onEnqueue: (() async -> Void)?

        private var callNumber = 0

        func enqueue(imageData: Data) async throws {
            try await record(document: .photo(imageData), parsed: nil, confirmation: nil, partial: nil)
        }

        func enqueue(
            document: OutboxDocument,
            parsed: ParsedReceipt,
            confirmation: ConfirmedReceiptFields?,
            partial: PendingReceiptFields?
        ) async throws {
            try await record(document: document, parsed: parsed, confirmation: confirmation, partial: partial)
        }

        private func record(
            document: OutboxDocument,
            parsed: ParsedReceipt?,
            confirmation: ConfirmedReceiptFields?,
            partial: PendingReceiptFields?
        ) async throws {
            await onEnqueue?()
            callNumber += 1
            if callNumber == failOnCallNumber {
                failOnCallNumber = nil
                throw DiskFull()
            }
            enqueued.append(EnqueuedReceipt(
                document: document, parsed: parsed, confirmation: confirmation, partial: partial
            ))
        }
    }

    private var outbox: StubOutbox!

    private nonisolated static let captureInstant = Date(timeIntervalSince1970: 1_775_000_000)

    private nonisolated static let parsedText = RecognizedText(lines: [
        RecognizedLine(text: "MAPLE FOODS MARKET", verticalCenter: 0.05, height: 0.04),
        RecognizedLine(text: "2026/01/14", verticalCenter: 0.14, height: 0.015),
        RecognizedLine(text: "TOTAL 113.00", verticalCenter: 0.80, height: 0.02),
    ])

    override func setUp() async throws {
        try await super.setUp()
        outbox = StubOutbox()
    }

    private func makeModel(recognizer: StubTextRecognizer = StubTextRecognizer(results: [])) -> CaptureFlowModel {
        CaptureFlowModel(outbox: outbox, recognizer: recognizer, now: { Self.captureInstant })
    }

    // MARK: - Single capture (scan → confirm, per the gate ratification)

    func testSingleCaptureOpensTheConfirmScreenAndSaveQueuesConfirmed() async {
        let page = Data("single page".utf8)
        let model = makeModel(recognizer: StubTextRecognizer(results: [Self.parsedText]))
        await model.savePages([page])

        guard case .confirming(let confirmModel) = model.phase else {
            return XCTFail("Expected confirming, got \(model.phase)")
        }
        // The form is local-backed: prefilled from the on-device parse,
        // showing the scanned bytes, with no server row behind it.
        XCTAssertEqual(confirmModel.totalText, "113.00")
        XCTAssertEqual(confirmModel.vendorText, "MAPLE FOODS MARKET")
        XCTAssertFalse(confirmModel.dateIsCaptureDayFallback)
        XCTAssertEqual(confirmModel.imageSource, .local(page))
        XCTAssertNil(confirmModel.receiptId)
        XCTAssertNil(confirmModel.ocrFailureNote)

        // Save = a durable outbox write carrying the human's fields AND
        // the parser's record (the §7.3 accuracy comparison needs both).
        let saved = await confirmModel.save()
        XCTAssertTrue(saved)
        XCTAssertEqual(outbox.enqueued.count, 1)
        let receipt = outbox.enqueued[0]
        XCTAssertEqual(receipt.imageData, page)
        XCTAssertEqual(receipt.confirmation?.totalCents, 11300)
        XCTAssertEqual(receipt.confirmation?.purchasedAt, "2026-01-14")
        XCTAssertEqual(receipt.parsed?.suggestions.totalCents, 11300)
        XCTAssertEqual(receipt.parsed?.ocrRawText, "MAPLE FOODS MARKET\n2026/01/14\nTOTAL 113.00")

        model.finishSingleCapture()
        if case .saved(let count) = model.phase {
            XCTAssertEqual(count, 1)
        } else {
            XCTFail("Expected saved, got \(model.phase)")
        }
    }

    func testSingleCaptureOcrFailureStillConfirmsOnABlankStatedForm() async {
        // Recognition dying must not block capture: the person is holding
        // the paper and the remedy - type what it says - is the confirm
        // screen itself. The failure is stated on it, not swallowed.
        let model = makeModel(recognizer: StubTextRecognizer(results: []))
        await model.savePages([Data("unreadable".utf8)])

        guard case .confirming(let confirmModel) = model.phase else {
            return XCTFail("Expected confirming, got \(model.phase)")
        }
        XCTAssertNotNil(confirmModel.ocrFailureNote)
        XCTAssertEqual(confirmModel.totalText, "")
        XCTAssertTrue(confirmModel.dateIsCaptureDayFallback)
        // The fallback date is the capture day, through the same
        // UTC-pinned round trip the picker renders in.
        XCTAssertEqual(
            ReceiptFormat.isoDate(fromPicker: confirmModel.purchasedDate),
            ReceiptFormat.calendarDate(of: Self.captureInstant)
        )
    }

    func testLaterQueuesTheSingleCapturePending() async {
        let model = makeModel(recognizer: StubTextRecognizer(results: [Self.parsedText]))
        await model.savePages([Data("single page".utf8)])
        await model.setAsideSingleCapture()

        // Leaving the screen never costs the scan: queued pending, like a
        // batch page, with the parse riding along.
        XCTAssertEqual(outbox.enqueued.count, 1)
        XCTAssertNil(outbox.enqueued[0].confirmation)
        XCTAssertEqual(outbox.enqueued[0].parsed?.suggestions.totalCents, 11300)
        if case .saved(let count) = model.phase {
            XCTAssertEqual(count, 1)
        } else {
            XCTFail("Expected saved, got \(model.phase)")
        }
    }

    /// "Later" used to discard whatever had been typed (2026-09-01): the
    /// vendor someone had just corrected was gone, the receipt queued
    /// carrying the parser's snapshot alone, and the confirm queue offered
    /// them the same wrong guesses again later. The typed fields now ride
    /// along, tagged with which ones a human actually looked at.
    func testLaterCarriesWhatWasTypedIntoThePendingCreate() async {
        let model = makeModel(recognizer: StubTextRecognizer(results: [Self.parsedText]))
        await model.savePages([Data("single page".utf8)])
        guard case .confirming(let confirmModel) = model.phase else {
            return XCTFail("Expected confirming, got \(model.phase)")
        }

        confirmModel.markTouched(.vendor)
        confirmModel.vendorText = "Maple Foods"
        confirmModel.markTouched(editable: .category)
        confirmModel.categoryText = "groceries"

        await model.setAsideSingleCapture()

        XCTAssertEqual(outbox.enqueued.count, 1)
        let queued = outbox.enqueued[0]
        XCTAssertNil(queued.confirmation, "Later never confirms")
        XCTAssertEqual(queued.partial?.reviewedFields, [.vendor, .category])
        XCTAssertEqual(queued.partial?.vendor, "Maple Foods")
        XCTAssertEqual(queued.partial?.category, "groceries")
        // The parse still rides along verbatim - it is the §7.3 accuracy
        // record, and nothing a human typed replaces it.
        XCTAssertEqual(queued.parsed?.suggestions.vendor, "MAPLE FOODS MARKET")
    }

    /// Nobody touched anything, so there is nothing to carry and the
    /// create body is exactly what it was before this existed.
    func testLaterCarriesNothingWhenNothingWasTouched() async {
        let model = makeModel(recognizer: StubTextRecognizer(results: [Self.parsedText]))
        await model.savePages([Data("single page".utf8)])
        await model.setAsideSingleCapture()
        XCTAssertNil(outbox.enqueued[0].partial)
    }

    /// A failed "Later" leaves the failure screen up, where the confirm
    /// model is no longer the phase - so the typed values are read once,
    /// before the phase moves, and the retry sends the same ones rather
    /// than silently falling back to the parser's snapshot.
    func testRetryingAFailedLaterStillCarriesWhatWasTyped() async {
        outbox.failOnCallNumber = 1
        let model = makeModel(recognizer: StubTextRecognizer(results: [Self.parsedText]))
        await model.savePages([Data("single page".utf8)])
        guard case .confirming(let confirmModel) = model.phase else {
            return XCTFail("Expected confirming, got \(model.phase)")
        }
        confirmModel.markTouched(.vendor)
        confirmModel.vendorText = "Maple Foods"

        await model.setAsideSingleCapture()
        XCTAssertTrue(outbox.enqueued.isEmpty)

        await model.retry()
        XCTAssertEqual(outbox.enqueued.count, 1)
        XCTAssertEqual(outbox.enqueued[0].partial?.vendor, "Maple Foods")
    }

    func testLaterFailureStopsLoudlyAndRetryResumes() async {
        outbox.failOnCallNumber = 1
        let model = makeModel(recognizer: StubTextRecognizer(results: [Self.parsedText]))
        await model.savePages([Data("single page".utf8)])
        await model.setAsideSingleCapture()

        guard case .failed(let message) = model.phase else {
            return XCTFail("Expected failed, got \(model.phase)")
        }
        XCTAssertTrue(message.contains("saved to this phone"), message)
        XCTAssertTrue(outbox.enqueued.isEmpty)

        await model.retry()
        XCTAssertEqual(outbox.enqueued.count, 1)
        XCTAssertNil(outbox.enqueued[0].confirmation)
        if case .saved = model.phase {} else {
            XCTFail("Expected saved after retry, got \(model.phase)")
        }
    }

    // MARK: - Several pages: separate receipts, or one receipt (2026-09-01)

    /// The scanner cannot tell a stack of receipts from a folio, so the
    /// person is asked before either path starts. Nothing is queued until
    /// they answer.
    func testSeveralPagesAskBeforeQueueingAnything() async {
        let model = makeModel()
        await model.savePages([Data([1]), Data([2]), Data([3])])

        guard case .choosingPageMode(let pageCount) = model.phase else {
            return XCTFail("Expected choosingPageMode, got \(model.phase)")
        }
        XCTAssertEqual(pageCount, 3)
        XCTAssertTrue(outbox.enqueued.isEmpty, "the question is asked before anything is queued")
    }

    /// One page is not a question: straight to the read and the confirm
    /// screen, exactly as before this choice existed.
    func testOnePageStillGoesStraightToTheConfirmScreen() async {
        let model = makeModel(recognizer: StubTextRecognizer(results: [Self.parsedText]))
        await model.savePages([Data("single page".utf8)])
        guard case .confirming = model.phase else {
            return XCTFail("Expected confirming, got \(model.phase)")
        }
    }

    /// "One receipt with N pages": one enqueue, carrying the rest of the
    /// pages, through the single-capture confirm screen. The read ran on
    /// page 1 alone.
    func testOneReceiptWithSeveralPagesConfirmsOnceAndCarriesTheRest() async {
        let pages = [Data([1]), Data([2]), Data([3])]
        let model = makeModel(recognizer: StubTextRecognizer(results: [Self.parsedText]))
        await model.savePages(pages)
        await model.saveScannedPagesAsOneReceipt()

        guard case .confirming(let confirmModel) = model.phase else {
            return XCTFail("Expected confirming, got \(model.phase)")
        }
        // Page 1 is what was read and what the form is backed by; every
        // page is reachable from the image section.
        XCTAssertEqual(confirmModel.imageSource, .local(pages[0]))
        XCTAssertEqual(confirmModel.imageSources, pages.map { .local($0) })
        XCTAssertEqual(confirmModel.totalText, "113.00")

        let saved = await confirmModel.save()
        XCTAssertTrue(saved)
        XCTAssertEqual(outbox.enqueued.count, 1, "one receipt, not three")
        XCTAssertEqual(outbox.enqueued[0].imageData, pages[0])
        XCTAssertEqual(outbox.enqueued[0].additionalPages, [pages[1], pages[2]])
        XCTAssertEqual(outbox.enqueued[0].document.contentType, .jpeg)
        XCTAssertEqual(outbox.enqueued[0].document.ocrSource, .vision)
    }

    /// The same pages, answered the other way: the batch path, unchanged -
    /// one pending receipt per page, none carrying extras.
    func testSeparateReceiptsQueuesOnePendingReceiptPerPage() async {
        let pages = [Data([1]), Data([2]), Data([3])]
        let model = makeModel()
        await model.savePages(pages)
        await model.saveScannedPagesAsSeparateReceipts()

        if case .saved(let count) = model.phase {
            XCTAssertEqual(count, 3)
        } else {
            XCTFail("Expected saved, got \(model.phase)")
        }
        XCTAssertEqual(outbox.enqueuedPages, pages)
        XCTAssertTrue(outbox.enqueued.allSatisfy { $0.additionalPages.isEmpty })
    }

    // MARK: - Batch

    func testEachPageIsQueuedInScanOrder() async {
        let pages = [Data([1]), Data([2]), Data([3])]
        let model = makeModel()
        await model.savePages(pages)
        await model.saveScannedPagesAsSeparateReceipts()

        if case .saved(let count) = model.phase {
            XCTAssertEqual(count, 3)
        } else {
            XCTFail("Expected saved, got \(model.phase)")
        }
        XCTAssertEqual(outbox.enqueuedPages, pages)
    }

    func testFullDiskStopsAtTheFailingPageAndRetryResumesThere() async {
        outbox.failOnCallNumber = 2
        let model = makeModel()
        await model.savePages([Data([1]), Data([2]), Data([3])])
        await model.saveScannedPagesAsSeparateReceipts()

        guard case .failed(let message) = model.phase else {
            return XCTFail("Expected failed, got \(model.phase)")
        }
        // The failure names the page, says the save was local, and states
        // what is already safe - never a false "saved".
        XCTAssertTrue(message.contains("Receipt 2"), message)
        XCTAssertTrue(message.contains("saved to this phone"), message)
        XCTAssertTrue(message.contains("The first 1 saved"), message)
        XCTAssertEqual(outbox.enqueuedPages, [Data([1])])

        // Retry resumes at page 2; page 1 is not queued twice.
        await model.retry()
        if case .saved(let count) = model.phase {
            XCTAssertEqual(count, 3)
        } else {
            XCTFail("Expected saved after retry, got \(model.phase)")
        }
        XCTAssertEqual(outbox.enqueuedPages, [Data([1]), Data([2]), Data([3])])
    }

    func testDoubleRetryCannotInterleaveThePipeline() async {
        // The wave-3 lesson, found again by the wave-4 reviewer: without a
        // re-entrancy guard, two concurrent passes both read the same head
        // page, queue it twice, and silently drop a later one. This parks
        // the first pass on a gate, fires a second entry, and asserts the
        // second was refused: one enqueue per page, none lost.
        let gate = Gate()
        outbox.onEnqueue = {
            await gate.wait()
        }
        let model = makeModel()

        await model.savePages([Data([1]), Data([2])])
        async let firstPass: Void = model.saveScannedPagesAsSeparateReceipts()
        // Let the first pass park on the gated enqueue, then re-enter.
        while await !gate.hasWaiters {
            await Task.yield()
        }
        async let reentry: Void = model.retry()
        await gate.open()
        _ = await (firstPass, reentry)

        if case .saved(let count) = model.phase {
            XCTAssertEqual(count, 2)
        } else {
            XCTFail("Expected saved, got \(model.phase)")
        }
        XCTAssertEqual(outbox.enqueuedPages, [Data([1]), Data([2])])
    }
}

// MARK: - The server's second opinion (2026-09-01)

/// The capture-time confirm screen's late-arriving LLM answer. Every one of
/// these runs with a stubbed `remoteParse`: there is no simulator camera,
/// so the network call on the capture path is covered here rather than by
/// anything that touches Vision.
@MainActor
final class CaptureFlowSecondOpinionTests: XCTestCase {
    @MainActor
    private final class StubOutbox: OutboxEnqueuing {
        private(set) var enqueuedParses: [ParsedReceipt] = []

        func enqueue(imageData: Data) async throws {}

        func enqueue(
            document: OutboxDocument,
            parsed: ParsedReceipt,
            confirmation: ConfirmedReceiptFields?,
            partial: PendingReceiptFields?
        ) async throws {
            enqueuedParses.append(parsed)
        }
    }

    private nonisolated static let captureInstant = Date(timeIntervalSince1970: 1_775_000_000)

    /// A receipt the on-device heuristic reads badly: the tallest line in
    /// the header is the CUSTOMER's name (a real Domino's slip, `4d3a8b24`,
    /// which no exclusion rule can catch), and no amount is found at all
    /// because the total's cents were clipped. Exactly the shape the LLM
    /// was right about 57 times out of 73 in production.
    private nonisolated static let thinRead = RecognizedText(lines: [
        RecognizedLine(text: "YINGHUA LI", verticalCenter: 0.05, height: 0.02),
        RecognizedLine(text: "Chicken Souvlaki $15.49", verticalCenter: 0.40, height: 0.02),
        RecognizedLine(text: "Total 50", verticalCenter: 0.80, height: 0.02),
    ])

    private func makeModel(
        outbox: StubOutbox,
        remoteParse: CaptureFlowModel.RemoteParse?,
        timeout: TimeInterval = 5
    ) -> CaptureFlowModel {
        CaptureFlowModel(
            outbox: outbox,
            recognizer: StubTextRecognizer(results: [Self.thinRead]),
            remoteParse: remoteParse,
            secondOpinionTimeout: timeout,
            now: { Self.captureInstant }
        )
    }

    /// Polls the main actor until `condition` holds - the fire-and-forget
    /// task has no completion to await, by design.
    private func waitUntil(
        _ condition: () -> Bool,
        timeout: TimeInterval = 2,
        _ message: String,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if condition() { return }
            await Task.yield()
            try? await Task.sleep(nanoseconds: 2_000_000)
        }
        XCTAssertTrue(condition(), message, file: file, line: line)
    }

    private func confirmModel(of model: CaptureFlowModel) -> ConfirmReceiptModel? {
        guard case .confirming(let confirmModel) = model.phase else { return nil }
        return confirmModel
    }

    func testServerAnswerFillsTheFieldsTheHeuristicLeftEmpty() async {
        let outbox = StubOutbox()
        let model = makeModel(outbox: outbox, remoteParse: { rawText, capturedAt in
            XCTAssertEqual(rawText, "YINGHUA LI\nChicken Souvlaki $15.49\nTotal 50")
            XCTAssertEqual(capturedAt, Self.captureInstant)
            return ReceiptSuggestions(
                totalCents: 1750,
                hstCents: 201,
                subtotalCents: 1549,
                paymentMethod: "MASTERCARD",
                purchasedAt: "2026-04-01",
                vendor: "JIMMY THE GREEK"
            )
        })
        await model.savePages([Data("page".utf8)])
        let confirm = try? XCTUnwrap(confirmModel(of: model))
        guard let confirm else { return XCTFail("no confirm screen") }

        // The heuristic's own answer is what the screen opens with.
        XCTAssertEqual(confirm.vendorText, "YINGHUA LI")
        XCTAssertEqual(confirm.totalText, "")

        await waitUntil({ confirm.vendorText == "JIMMY THE GREEK" }, "the server's vendor never applied")
        XCTAssertEqual(confirm.totalText, "17.50")
        XCTAssertEqual(confirm.hstText, "2.01")
        XCTAssertEqual(confirm.subtotalText, "15.49")
        XCTAssertEqual(confirm.paymentMethodText, "MASTERCARD")
        XCTAssertEqual(ReceiptFormat.isoDate(fromPicker: confirm.purchasedDate), "2026-04-01")
        // Replaced, not confirmed: every field it touched is still a
        // suggestion nobody has looked at.
        XCTAssertTrue(confirm.isUnreviewed(.vendor))
        XCTAssertTrue(confirm.isUnreviewed(.total))
    }

    /// The immutable record: whatever the server says, what travels to the
    /// server in `ocrSuggestions` is the ON-DEVICE parse, unchanged. That
    /// payload is the §7.3 accuracy measurement's input and must not be
    /// contaminated by the thing it is measuring against.
    func testServerAnswerNeverChangesTheRecordedOnDeviceParse() async {
        let outbox = StubOutbox()
        let model = makeModel(outbox: outbox, remoteParse: { _, _ in
            ReceiptSuggestions(totalCents: 1750, vendor: "JIMMY THE GREEK")
        })
        await model.savePages([Data("page".utf8)])
        guard let confirm = confirmModel(of: model) else { return XCTFail("no confirm screen") }
        await waitUntil({ confirm.vendorText == "JIMMY THE GREEK" }, "the server's vendor never applied")

        _ = await confirm.save()

        XCTAssertEqual(outbox.enqueuedParses.count, 1)
        XCTAssertEqual(outbox.enqueuedParses[0].suggestions.vendor, "YINGHUA LI")
        XCTAssertNil(outbox.enqueuedParses[0].suggestions.totalCents)
        // The human's confirmed fields, though, are what they saw and kept.
        XCTAssertEqual(confirm.vendorText, "JIMMY THE GREEK")
    }

    func testServerFailureChangesNothingAndSaysNothing() async {
        struct Offline: Error {}
        let outbox = StubOutbox()
        let model = makeModel(outbox: outbox, remoteParse: { _, _ in throw Offline() })
        await model.savePages([Data("page".utf8)])
        guard let confirm = confirmModel(of: model) else { return XCTFail("no confirm screen") }

        // Give the failing task every chance to do something wrong.
        try? await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(confirm.vendorText, "YINGHUA LI")
        XCTAssertEqual(confirm.totalText, "")
        XCTAssertNil(confirm.saveError)
        XCTAssertTrue(confirm.serverAmountAlternatives.isEmpty)
    }

    func testAnAnswerThatMissesTheTimeoutIsDiscarded() async {
        let outbox = StubOutbox()
        let model = makeModel(
            outbox: outbox,
            remoteParse: { _, _ in
                try await Task.sleep(nanoseconds: 3_000_000_000)
                return ReceiptSuggestions(vendor: "TOO LATE")
            },
            timeout: 0.02
        )
        await model.savePages([Data("page".utf8)])
        guard let confirm = confirmModel(of: model) else { return XCTFail("no confirm screen") }

        try? await Task.sleep(nanoseconds: 200_000_000)
        XCTAssertEqual(confirm.vendorText, "YINGHUA LI", "a late answer must not land")
    }

    /// The person hit Save before the answer arrived. The receipt is
    /// durable; writing into the form now would change nothing that
    /// matters and would look like a haunting.
    func testAnAnswerArrivingAfterSaveIsIgnored() async {
        let outbox = StubOutbox()
        let released = Gate()
        let model = makeModel(outbox: outbox, remoteParse: { _, _ in
            await released.wait()
            return ReceiptSuggestions(vendor: "TOO LATE")
        })
        await model.savePages([Data("page".utf8)])
        guard let confirm = confirmModel(of: model) else { return XCTFail("no confirm screen") }
        confirm.totalText = "17.50"

        let saved = await confirm.save()
        XCTAssertTrue(saved)
        await released.open()
        try? await Task.sleep(nanoseconds: 100_000_000)

        XCTAssertEqual(confirm.vendorText, "YINGHUA LI")
    }

    /// No injected parse at all - the app's own behaviour when it is built
    /// without one, and the shape every other capture test runs in.
    func testNoRemoteParseMeansNoNetworkCallAndNoChange() async {
        let outbox = StubOutbox()
        let model = makeModel(outbox: outbox, remoteParse: nil)
        await model.savePages([Data("page".utf8)])
        guard let confirm = confirmModel(of: model) else { return XCTFail("no confirm screen") }

        try? await Task.sleep(nanoseconds: 30_000_000)
        XCTAssertEqual(confirm.vendorText, "YINGHUA LI")
    }

    /// The vendor heuristic's known-vendor pass runs on the capture path
    /// with the person's own cached list, so the screen opens with the
    /// right name before any network answers.
    func testKnownVendorsReachTheCaptureTimeParse() async {
        let outbox = StubOutbox()
        let model = CaptureFlowModel(
            outbox: outbox,
            recognizer: StubTextRecognizer(results: [RecognizedText(lines: [
                RecognizedLine(text: "In Store 392", verticalCenter: 0.05, height: 0.02),
                RecognizedLine(text: "www.jimmythegreek.com", verticalCenter: 0.95, height: 0.02),
            ])]),
            knownVendors: { ["Jimmy The Greek"] },
            now: { Self.captureInstant }
        )
        await model.savePages([Data("page".utf8)])
        guard let confirm = confirmModel(of: model) else { return XCTFail("no confirm screen") }

        XCTAssertEqual(confirm.vendorText, "Jimmy The Greek")
    }
}
