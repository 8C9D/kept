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
            let imageData: Data
            let parsed: ParsedReceipt?
            let confirmation: ConfirmedReceiptFields?
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
            try await record(imageData: imageData, parsed: nil, confirmation: nil)
        }

        func enqueue(
            imageData: Data,
            parsed: ParsedReceipt,
            confirmation: ConfirmedReceiptFields?
        ) async throws {
            try await record(imageData: imageData, parsed: parsed, confirmation: confirmation)
        }

        private func record(
            imageData: Data,
            parsed: ParsedReceipt?,
            confirmation: ConfirmedReceiptFields?
        ) async throws {
            await onEnqueue?()
            callNumber += 1
            if callNumber == failOnCallNumber {
                failOnCallNumber = nil
                throw DiskFull()
            }
            enqueued.append(EnqueuedReceipt(imageData: imageData, parsed: parsed, confirmation: confirmation))
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

    // MARK: - Batch

    func testEachPageIsQueuedInScanOrder() async {
        let pages = [Data([1]), Data([2]), Data([3])]
        let model = makeModel()
        await model.savePages(pages)

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

        async let firstPass: Void = model.savePages([Data([1]), Data([2])])
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
