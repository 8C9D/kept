import XCTest
@testable import Kept

@MainActor
final class CaptureFlowModelTests: XCTestCase {
    private var api: StubKeptAPI!

    override func setUp() {
        super.setUp()
        api = StubKeptAPI()
        api.uploadTargetHandler = { _ in
            UploadTarget(
                objectKey: "user/2026/08/image.jpg",
                uploadUrl: URL(string: "https://storage.example/put")!
            )
        }
        api.uploadImageHandler = { _, _, _ in }
        api.createReceiptHandler = { _ in Fixtures.receipt(status: .pending) }
    }

    private func model(
        recognizer: StubTextRecognizer,
        now: Date = Date(timeIntervalSince1970: 1_775_000_000)
    ) -> CaptureFlowModel {
        CaptureFlowModel(api: api, recognizer: recognizer, now: { now })
    }

    private static let parsedText = RecognizedText(lines: [
        RecognizedLine(text: "MAPLE FOODS MARKET", verticalCenter: 0.05, height: 0.04),
        RecognizedLine(text: "2026/01/14", verticalCenter: 0.14, height: 0.015),
        RecognizedLine(text: "TOTAL 113.00", verticalCenter: 0.80, height: 0.02),
    ])

    private static let unreadableText = RecognizedText(lines: [])

    func testEachPageBecomesItsOwnPendingReceipt() async {
        let model = model(recognizer: StubTextRecognizer(repeating: Self.parsedText, count: 3))
        await model.savePages([Data([1]), Data([2]), Data([3])])

        if case .saved(let count) = model.phase {
            XCTAssertEqual(count, 3)
        } else {
            XCTFail("Expected saved, got \(model.phase)")
        }
        XCTAssertEqual(api.createReceiptCalls.count, 3)
    }

    func testCreateCarriesSuggestionsRawTextAndParsedDate() async {
        let model = model(recognizer: StubTextRecognizer(results: [Self.parsedText]))
        await model.savePages([Data([1])])

        let request = api.createReceiptCalls.first
        XCTAssertEqual(request?.purchasedAt, "2026-01-14") // parsed, not today
        XCTAssertEqual(request?.totalCents, 11300)
        XCTAssertEqual(request?.vendor, "MAPLE FOODS MARKET")
        XCTAssertEqual(request?.ocrRawText, "MAPLE FOODS MARKET\n2026/01/14\nTOTAL 113.00")
        XCTAssertEqual(request?.ocrSuggestions.totalCents, 11300)
        XCTAssertEqual(request?.ocrSuggestions.purchasedAt, "2026-01-14")
    }

    func testUnreadablePageFallsBackToCaptureDayAndStatesAbsences() async {
        let captureInstant = Date(timeIntervalSince1970: 1_775_000_000)
        let model = model(
            recognizer: StubTextRecognizer(results: [Self.unreadableText]),
            now: captureInstant
        )
        await model.savePages([Data([1])])

        let request = api.createReceiptCalls.first
        XCTAssertEqual(request?.purchasedAt, CaptureFlowModel.calendarDate(of: captureInstant))
        XCTAssertNil(request?.totalCents)
        XCTAssertNil(request?.vendor)
        XCTAssertNil(request?.ocrRawText)
        XCTAssertNil(request?.ocrSuggestions.totalCents)
    }

    func testImageBytesAreHashedAndUploadedBeforeCreate() async {
        let page = Data("receipt bytes".utf8)
        var uploadedData: Data?
        api.uploadImageHandler = { _, data, contentType in
            uploadedData = data
            XCTAssertEqual(contentType, .jpeg)
        }
        let model = model(recognizer: StubTextRecognizer(results: [Self.parsedText]))
        await model.savePages([page])

        XCTAssertEqual(uploadedData, page)
        // SHA-256 of "receipt bytes", computed independently with shasum.
        XCTAssertEqual(
            api.createReceiptCalls.first?.image.sha256,
            "9e85aa95f04db5f108534e48b63e75e8045a7ecab59988405e70a9260300a0d6"
        )
        XCTAssertEqual(api.createReceiptCalls.first?.image.objectKey, "user/2026/08/image.jpg")
    }

    func testFailureMidBatchKeepsSavedPagesAndRetriesTheRest() async {
        struct Boom: LocalizedError {
            var errorDescription: String? { "network died" }
        }
        var createCalls = 0
        api.createReceiptHandler = { _ in
            createCalls += 1
            if createCalls == 2 {
                throw Boom()
            }
            return Fixtures.receipt(status: .pending)
        }

        let model = model(recognizer: StubTextRecognizer(repeating: Self.parsedText, count: 4))
        await model.savePages([Data([1]), Data([2]), Data([3])])

        guard case .failed(let message) = model.phase else {
            return XCTFail("Expected failed, got \(model.phase)")
        }
        XCTAssertTrue(message.contains("Receipt 2"), message)
        XCTAssertTrue(message.contains("The first 1 saved"), message)

        // Retry resumes at page 2 - page 1 is not re-created.
        await model.retry()
        if case .saved(let count) = model.phase {
            XCTAssertEqual(count, 3)
        } else {
            XCTFail("Expected saved after retry, got \(model.phase)")
        }
        XCTAssertEqual(api.createReceiptCalls.count, 4) // 2 + failed attempt + 2 retried
    }

    func testDuplicateImageMeansAlreadySavedAndTheBatchContinues() async {
        var createCalls = 0
        api.createReceiptHandler = { _ in
            createCalls += 1
            if createCalls == 1 {
                throw APIError.requestFailed(
                    code: "duplicate_image",
                    message: "already attached",
                    status: 409
                )
            }
            return Fixtures.receipt(status: .pending)
        }

        let model = model(recognizer: StubTextRecognizer(repeating: Self.parsedText, count: 2))
        await model.savePages([Data([1]), Data([2])])

        if case .saved(let count) = model.phase {
            XCTAssertEqual(count, 2)
        } else {
            XCTFail("Expected saved, got \(model.phase)")
        }
        // Both pages attempted exactly one create each: the 409 is treated
        // as "the receipt already exists", never as licence to skip a page.
        XCTAssertEqual(api.createReceiptCalls.count, 2)
    }

    func testDoubleRetryCannotInterleaveThePipeline() async {
        // The wave-3 lesson, found again here by the reviewer: without a
        // re-entrancy guard, two concurrent passes both read the same head
        // page, save it twice, and silently drop a later page. This parks
        // the first pass on a gate, fires a second entry, and asserts the
        // second was refused: one create per page, none lost.
        let gate = Gate()
        api.createReceiptHandler = { _ in
            await gate.wait()
            return Fixtures.receipt(status: .pending)
        }

        let model = model(recognizer: StubTextRecognizer(repeating: Self.parsedText, count: 4))
        async let firstPass: Void = model.savePages([Data([1]), Data([2])])
        // Let the first pass reach the gated create, then try to re-enter.
        while api.createReceiptCalls.isEmpty {
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
        XCTAssertEqual(api.createReceiptCalls.count, 2) // one per page, no repeats
    }

    func testCalendarDateUsesLocalDayInApiOrder() {
        // Expected value built through DateFormatter - an independent
        // implementation path from the Calendar components the code uses -
        // so a wrong calendar, zone, or component order fails the test.
        let instant = Date(timeIntervalSince1970: 1_775_000_000)
        let independent = DateFormatter()
        independent.locale = Locale(identifier: "en_US_POSIX")
        independent.timeZone = .current
        independent.dateFormat = "yyyy-MM-dd"
        XCTAssertEqual(CaptureFlowModel.calendarDate(of: instant), independent.string(from: instant))
    }

    func testTimestampIsIso8601Utc() {
        // The other API-syntax string the client emits; the server's
        // schema requires an offset (Z counts).
        let instant = Date(timeIntervalSince1970: 1_775_000_000)
        let rendered = CaptureFlowModel.timestamp(of: instant)
        XCTAssertNotNil(rendered.wholeMatch(of: #/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/#))
        XCTAssertEqual(ISO8601DateFormatter().date(from: rendered), instant)
    }
}
