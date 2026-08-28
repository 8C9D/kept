import CryptoKit
import XCTest
@testable import Kept

/// Adding a page and replacing a page's image (proposal #6, 2026-08-28).
/// Under test: the exact request sequence (presign, PUT, then the API
/// call), that a failed PUT never reaches the API - the test that prevents
/// recreating the §8 sharp edge this feature exists to repair - that a 409
/// surfaces the server's own message, multi-page ordering and resume-at-
/// the-failure, and the re-entrancy guard. The document scanner itself is
/// UIKit plumbing untestable off-device (DocumentScannerView's own doc
/// comment); this model is deliberately everything downstream of it, and
/// all of it runs on the simulator.
@MainActor
final class ReceiptImageUploadModelTests: XCTestCase {
    private func target(_ objectKey: String) -> UploadTarget {
        UploadTarget(objectKey: objectKey, uploadUrl: URL(string: "https://storage.example/put/\(objectKey)")!)
    }

    private func image(page: Int) -> ReceiptImage {
        ReceiptImage(page: page, downloadUrl: URL(string: "https://storage.example/presigned/\(page)")!)
    }

    /// SHA-256 of a single-byte payload, computed the same way the model
    /// does (CryptoKit), so tests can assert the exact hex the API call
    /// carried without duplicating a hand-written table of digests.
    private func sha256Hex(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Add: the request sequence and exact body

    func testAddPagesPresignsPutsThenCallsTheAPIWithExactlyObjectKeyAndSha256() async {
        let api = StubKeptAPI()
        let receiptId = UUID()
        api.uploadTargetHandler = { contentType in
            XCTAssertEqual(contentType, .jpeg)
            return self.target("issued-key")
        }
        var putData: Data?
        api.uploadImageHandler = { target, data, contentType in
            XCTAssertEqual(target.objectKey, "issued-key")
            XCTAssertEqual(contentType, .jpeg)
            putData = data
        }
        api.addReceiptImageHandler = { _, _, _ in self.image(page: 2) }
        let model = ReceiptImageUploadModel(api: api, eventLogger: EventLogger(api: api), receiptId: receiptId)
        let page = Data([0xAA, 0xBB])

        await model.addPages([page])

        guard case .finished = model.phase else {
            return XCTFail("Expected finished, got \(model.phase)")
        }
        // The PUT ran before the API was told anything - asserted by the
        // recorded bytes matching what was scanned, not by ordering
        // alone, since the ordering itself is the whole point of the
        // failed-PUT test below.
        XCTAssertEqual(putData, page)
        let call = api.addReceiptImageCalls.first
        XCTAssertEqual(call?.receiptId, receiptId)
        XCTAssertEqual(call?.objectKey, "issued-key")
        XCTAssertEqual(call?.sha256, sha256Hex(page))
    }

    func testReplacePageSendsTheGivenPageNumberWithExactlyObjectKeyAndSha256() async {
        let api = StubKeptAPI()
        let receiptId = UUID()
        api.uploadTargetHandler = { _ in self.target("replacement-key") }
        api.uploadImageHandler = { _, _, _ in }
        api.replaceReceiptImageHandler = { _, _, _, _ in self.image(page: 1) }
        let model = ReceiptImageUploadModel(api: api, eventLogger: EventLogger(api: api), receiptId: receiptId)
        let page = Data([0x01, 0x02, 0x03])

        await model.replacePage(1, data: page)

        guard case .finished = model.phase else {
            return XCTFail("Expected finished, got \(model.phase)")
        }
        let call = api.replaceReceiptImageCalls.first
        XCTAssertEqual(call?.receiptId, receiptId)
        XCTAssertEqual(call?.page, 1)
        XCTAssertEqual(call?.objectKey, "replacement-key")
        XCTAssertEqual(call?.sha256, sha256Hex(page))
        // Never the add route - replace is never confused with add.
        XCTAssertTrue(api.addReceiptImageCalls.isEmpty)
    }

    func testAddLogsReceiptEditedWithNoFieldValue() async {
        let api = StubKeptAPI()
        let receiptId = UUID()
        api.uploadTargetHandler = { _ in self.target("k") }
        api.uploadImageHandler = { _, _, _ in }
        api.addReceiptImageHandler = { _, _, _ in self.image(page: 1) }
        let logger = EventLogger(api: api)
        let model = ReceiptImageUploadModel(api: api, eventLogger: logger, receiptId: receiptId)

        await model.addPages([Data([0x01])])
        await logger.flush()

        let event = api.postEventsCalls.last?.events.first
        XCTAssertEqual(event?.action, .receiptEdited)
        XCTAssertEqual(event?.receiptId, receiptId)
        XCTAssertNil(event?.field)
    }

    // MARK: - A failed PUT never calls the API (the §8 sharp edge itself)

    func testAFailedPutNeverCallsAddReceiptImage() async {
        let api = StubKeptAPI()
        api.uploadTargetHandler = { _ in self.target("k") }
        struct PutFailed: LocalizedError {
            var errorDescription: String? { "The network connection was lost." }
        }
        api.uploadImageHandler = { _, _, _ in throw PutFailed() }
        api.addReceiptImageHandler = { _, _, _ in
            XCTFail("The API must never be told about bytes that did not land")
            return self.image(page: 1)
        }
        let model = ReceiptImageUploadModel(api: api, eventLogger: EventLogger(api: api), receiptId: UUID())

        await model.addPages([Data([0x01])])

        guard case .failed(let message) = model.phase else {
            return XCTFail("Expected failed, got \(model.phase)")
        }
        XCTAssertEqual(message, "The network connection was lost.")
        XCTAssertTrue(api.addReceiptImageCalls.isEmpty)
    }

    func testAFailedPutNeverCallsReplaceReceiptImage() async {
        let api = StubKeptAPI()
        api.uploadTargetHandler = { _ in self.target("k") }
        struct PutFailed: LocalizedError {
            var errorDescription: String? { "The server answered unexpectedly (HTTP 403)." }
        }
        api.uploadImageHandler = { _, _, _ in throw PutFailed() }
        api.replaceReceiptImageHandler = { _, _, _, _ in
            XCTFail("The API must never be told about bytes that did not land")
            return self.image(page: 1)
        }
        let model = ReceiptImageUploadModel(api: api, eventLogger: EventLogger(api: api), receiptId: UUID())

        await model.replacePage(1, data: Data([0x01]))

        guard case .failed(let message) = model.phase else {
            return XCTFail("Expected failed, got \(model.phase)")
        }
        XCTAssertEqual(message, "The server answered unexpectedly (HTTP 403).")
        XCTAssertTrue(api.replaceReceiptImageCalls.isEmpty)
    }

    // MARK: - A 409 surfaces the server's own message

    func testAddSurfacesTheServersDuplicateMessageVerbatim() async {
        let api = StubKeptAPI()
        api.uploadTargetHandler = { _ in self.target("k") }
        api.uploadImageHandler = { _, _, _ in }
        api.addReceiptImageHandler = { _, _, _ in
            throw APIError.requestFailed(
                code: "duplicate_image",
                message: "An identical image is already attached to one of your receipts",
                status: 409
            )
        }
        let model = ReceiptImageUploadModel(api: api, eventLogger: EventLogger(api: api), receiptId: UUID())

        await model.addPages([Data([0x01])])

        guard case .failed(let message) = model.phase else {
            return XCTFail("Expected failed, got \(model.phase)")
        }
        // Verbatim - a single-page add wraps nothing around the server's
        // own wording (§8's "a failure names its remedy").
        XCTAssertEqual(message, "An identical image is already attached to one of your receipts")
    }

    func testReplaceSurfacesTheServersDuplicateMessageVerbatim() async {
        let api = StubKeptAPI()
        api.uploadTargetHandler = { _ in self.target("k") }
        api.uploadImageHandler = { _, _, _ in }
        api.replaceReceiptImageHandler = { _, _, _, _ in
            throw APIError.requestFailed(
                code: "duplicate_image",
                message: "An identical image is already attached to one of your receipts",
                status: 409
            )
        }
        let model = ReceiptImageUploadModel(api: api, eventLogger: EventLogger(api: api), receiptId: UUID())

        await model.replacePage(1, data: Data([0x01]))

        guard case .failed(let message) = model.phase else {
            return XCTFail("Expected failed, got \(model.phase)")
        }
        XCTAssertEqual(message, "An identical image is already attached to one of your receipts")
    }

    // MARK: - Multi-page ordering, phase reporting, and resume-at-failure

    func testMultiPageAddUploadsEveryPageInScanOrder() async {
        let api = StubKeptAPI()
        var issuedKeys: [String] = []
        api.uploadTargetHandler = { _ in
            let key = "key-\(issuedKeys.count + 1)"
            issuedKeys.append(key)
            return self.target(key)
        }
        api.uploadImageHandler = { _, _, _ in }
        var addedObjectKeys: [String] = []
        api.addReceiptImageHandler = { _, objectKey, _ in
            addedObjectKeys.append(objectKey)
            return self.image(page: addedObjectKeys.count)
        }
        let model = ReceiptImageUploadModel(api: api, eventLogger: EventLogger(api: api), receiptId: UUID())
        let pages = [Data([0x01]), Data([0x02]), Data([0x03])]

        await model.addPages(pages)

        guard case .finished = model.phase else {
            return XCTFail("Expected finished, got \(model.phase)")
        }
        // Each page got its OWN presigned target (three keys, not one
        // reused) and every add call landed in scan order.
        XCTAssertEqual(addedObjectKeys, ["key-1", "key-2", "key-3"])
    }

    func testMultiPageAddStopsAtTheFailingPageAndRetryResumesThereWithoutResendingEarlierPages() async {
        let api = StubKeptAPI()
        var uploadTargetCallCount = 0
        api.uploadTargetHandler = { _ in
            uploadTargetCallCount += 1
            return self.target("key-\(uploadTargetCallCount)")
        }
        api.uploadImageHandler = { _, _, _ in }
        var addAttempt = 0
        var succeededObjectKeys: [String] = []
        api.addReceiptImageHandler = { _, objectKey, _ in
            addAttempt += 1
            if addAttempt == 2 {
                throw APIError.requestFailed(code: "server_error", message: "Try again", status: 500)
            }
            succeededObjectKeys.append(objectKey)
            return self.image(page: succeededObjectKeys.count)
        }
        let model = ReceiptImageUploadModel(api: api, eventLogger: EventLogger(api: api), receiptId: UUID())
        let pages = [Data([0x01]), Data([0x02]), Data([0x03])]

        await model.addPages(pages)

        guard case .failed(let message) = model.phase else {
            return XCTFail("Expected failed, got \(model.phase)")
        }
        XCTAssertTrue(message.contains("Page 2"), "Expected the failing page to be named, got: \(message)")
        XCTAssertTrue(message.contains("first 1"), "Expected the already-added count, got: \(message)")
        XCTAssertEqual(succeededObjectKeys, ["key-1"])

        await model.retry()

        guard case .finished = model.phase else {
            return XCTFail("Expected finished after retry, got \(model.phase)")
        }
        // Page 1 was never resent: attempts are page1(ok), page2(fail),
        // page2-retry(ok), page3(ok) - four, not five.
        XCTAssertEqual(addAttempt, 4)
        XCTAssertEqual(succeededObjectKeys, ["key-1", "key-3", "key-4"])
    }

    // MARK: - Re-entrancy

    func testASecondAddCallWhileOneIsInFlightIsANoOp() async {
        let api = StubKeptAPI()
        let gate = Gate()
        var uploadTargetCallCount = 0
        api.uploadTargetHandler = { _ in
            uploadTargetCallCount += 1
            await gate.wait()
            return self.target("k")
        }
        api.uploadImageHandler = { _, _, _ in }
        api.addReceiptImageHandler = { _, _, _ in self.image(page: 1) }
        let model = ReceiptImageUploadModel(api: api, eventLogger: EventLogger(api: api), receiptId: UUID())

        async let first: Void = model.addPages([Data([0x01])])
        while await !gate.hasWaiters {
            await Task.yield()
        }
        // Dispatched while the first call is still parked on the gate -
        // must be a no-op, not a second concurrent upload.
        await model.addPages([Data([0x02])])

        await gate.open()
        _ = await first

        XCTAssertEqual(uploadTargetCallCount, 1)
        guard case .finished = model.phase else {
            return XCTFail("Expected finished, got \(model.phase)")
        }
        XCTAssertEqual(api.addReceiptImageCalls.count, 1)
    }
}
