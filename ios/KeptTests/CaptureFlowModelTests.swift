import XCTest
@testable import Kept

/// The capture flow after wave 5: pages go into the outbox, not to the
/// network. What is under test is the batch bookkeeping - order, resume
/// at the failing page, re-entrancy - and that a failed save is presented
/// as exactly that. Everything network-shaped lives in
/// OutboxControllerTests now.
@MainActor
final class CaptureFlowModelTests: XCTestCase {
    /// An OutboxEnqueuing that records pages and fails on cue - the
    /// scripted stand-in for a full disk.
    @MainActor
    private final class StubOutbox: OutboxEnqueuing {
        struct DiskFull: LocalizedError {
            var errorDescription: String? { "There is not enough storage." }
        }

        private(set) var enqueuedPages: [Data] = []
        /// 1-based call number that throws; consumed once, so a retry of
        /// the same page succeeds - the resume path.
        var failOnCallNumber: Int?
        /// Runs before each enqueue - the hook interleave tests park on.
        var onEnqueue: (() async -> Void)?

        private var callNumber = 0

        func enqueue(imageData: Data) async throws {
            await onEnqueue?()
            callNumber += 1
            if callNumber == failOnCallNumber {
                failOnCallNumber = nil
                throw DiskFull()
            }
            enqueuedPages.append(imageData)
        }
    }

    private var outbox: StubOutbox!

    override func setUp() async throws {
        try await super.setUp()
        outbox = StubOutbox()
    }

    func testEachPageIsQueuedInScanOrder() async {
        let pages = [Data([1]), Data([2]), Data([3])]
        let model = CaptureFlowModel(outbox: outbox)
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
        let model = CaptureFlowModel(outbox: outbox)
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
        let model = CaptureFlowModel(outbox: outbox)

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
