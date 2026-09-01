import UIKit
import XCTest
@testable import Kept

/// The PDF import end to end, minus the file picker (2026-09-01): real
/// PDFs written to disk, read back through the same code the picker feeds,
/// and queued.
///
/// The picker itself is not driven here or anywhere - `.fileImporter`
/// presents a system document browser that a test process cannot reach
/// past, and every screen behind it in this app is behind Sign in with
/// Apple. What a test CAN own is everything from "here are some file URLs"
/// onward, which is where all the decisions are.
@MainActor
final class PDFImportModelTests: XCTestCase {
    /// Records what was queued, and fails on cue - the stand-in for a full
    /// disk, same shape as `CaptureFlowModelTests`'.
    @MainActor
    private final class StubOutbox: OutboxEnqueuing {
        struct DiskFull: LocalizedError {
            var errorDescription: String? { "There is not enough storage." }
        }

        struct Enqueued {
            let document: OutboxDocument
            let parsed: ParsedReceipt
            let confirmation: ConfirmedReceiptFields?
            let partial: PendingReceiptFields?
        }

        private(set) var enqueued: [Enqueued] = []
        var failOnCallNumber: Int?
        private var callNumber = 0

        func enqueue(imageData: Data) async throws {
            XCTFail("the import never queues a bare photograph")
        }

        func enqueue(
            document: OutboxDocument,
            parsed: ParsedReceipt,
            confirmation: ConfirmedReceiptFields?,
            partial: PendingReceiptFields?
        ) async throws {
            callNumber += 1
            if callNumber == failOnCallNumber {
                failOnCallNumber = nil
                throw DiskFull()
            }
            enqueued.append(Enqueued(
                document: document, parsed: parsed, confirmation: confirmation, partial: partial
            ))
        }
    }

    private var outbox: StubOutbox!
    private var directory: URL!

    private nonisolated static let importInstant = Date(timeIntervalSince1970: 1_775_000_000)

    override func setUp() async throws {
        try await super.setUp()
        outbox = StubOutbox()
        directory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appending(path: "PDFImportModelTests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: directory)
        try await super.tearDown()
    }

    private func makeModel(recognizer: StubTextRecognizer = StubTextRecognizer(results: [])) -> PDFImportModel {
        PDFImportModel(
            outbox: outbox,
            recognizer: recognizer,
            knownVendors: { [] },
            now: { Self.importInstant }
        )
    }

    // MARK: - The text-layer path (the owner's decision)

    /// The whole point of the import: an emailed receipt's own characters
    /// travel as `ocrRawText` with `ocrSource: pdf-text`, and the SERVER's
    /// LLM is the parser. No on-device heuristic runs over PDF text, so
    /// the immutable `ocrSuggestions` record stays empty rather than
    /// claiming a reading nobody made.
    func testATypesetPDFQueuesItsTextLayerWithNoOnDeviceSuggestions() async throws {
        let url = try write(Self.typesetPDF(), named: "maple.pdf")
        let model = makeModel()

        await model.importFiles([url])

        XCTAssertEqual(model.phase, .finished(count: 1, truncatedFiles: []))
        XCTAssertEqual(outbox.enqueued.count, 1)
        let queued = outbox.enqueued[0]
        XCTAssertEqual(queued.document.contentType, .pdf)
        XCTAssertEqual(queued.document.ocrSource, .pdfText)
        XCTAssertTrue(queued.document.additionalPages.isEmpty)
        XCTAssertTrue(queued.parsed.ocrRawText?.contains("TOTAL 113.00") == true, "\(queued.parsed)")
        XCTAssertNil(queued.parsed.suggestions.totalCents)
        XCTAssertNil(queued.parsed.suggestions.vendor)
        // Pending, always: an import is a desk backlog, not a capture with
        // someone standing there holding the paper.
        XCTAssertNil(queued.confirmation)
        XCTAssertNil(queued.partial)
    }

    /// The bytes queued are the ORIGINAL document - what a tax record
    /// stores is the file that was emailed, never a re-rendered picture of
    /// it.
    func testTheOriginalPDFBytesAreWhatGetQueued() async throws {
        let pdf = Self.typesetPDF()
        let url = try write(pdf, named: "maple.pdf")
        let model = makeModel()

        await model.importFiles([url])

        XCTAssertEqual(outbox.enqueued.first?.document.data, pdf)
    }

    // MARK: - The scanned-PDF fallback

    func testAScannedPDFIsReadByVisionAndReportsVision() async throws {
        let url = try write(Self.imageOnlyPDF(), named: "scan.pdf")
        let recognized = RecognizedText(lines: [
            RecognizedLine(text: "MAPLE FOODS MARKET", verticalCenter: 0.05, height: 0.04),
            RecognizedLine(text: "2026/01/14", verticalCenter: 0.14, height: 0.015),
            RecognizedLine(text: "TOTAL 113.00", verticalCenter: 0.80, height: 0.02),
        ])
        let model = makeModel(recognizer: StubTextRecognizer(results: [recognized]))

        await model.importFiles([url])

        XCTAssertEqual(outbox.enqueued.count, 1)
        let queued = outbox.enqueued[0]
        // The document is still the PDF; only the READING came from a
        // render of its first page.
        XCTAssertEqual(queued.document.contentType, .pdf)
        XCTAssertEqual(queued.document.ocrSource, .vision)
        XCTAssertEqual(queued.parsed.suggestions.totalCents, 11300)
        XCTAssertEqual(queued.parsed.suggestions.vendor, "MAPLE FOODS MARKET")
        XCTAssertEqual(queued.parsed.ocrRawText, "MAPLE FOODS MARKET\n2026/01/14\nTOTAL 113.00")
    }

    /// Recognition dying is not fatal: the document is still queued, and
    /// the confirm queue is where a person types what it says - the same
    /// rule the camera path follows.
    func testAScannedPDFStillQueuesWhenRecognitionFails() async throws {
        let url = try write(Self.imageOnlyPDF(), named: "scan.pdf")
        let model = makeModel(recognizer: StubTextRecognizer(results: []))

        await model.importFiles([url])

        XCTAssertEqual(model.phase, .finished(count: 1, truncatedFiles: []))
        XCTAssertEqual(outbox.enqueued.count, 1)
        XCTAssertNil(outbox.enqueued[0].parsed.ocrRawText)
        XCTAssertNil(outbox.enqueued[0].parsed.suggestions.totalCents)
    }

    // MARK: - Several files, and failures

    func testEveryPickedFileBecomesItsOwnPendingReceipt() async throws {
        let urls = try [
            write(Self.typesetPDF(), named: "one.pdf"),
            write(Self.typesetPDF(lines: ["SECOND SHOP", "TOTAL 42.00"]), named: "two.pdf"),
        ]
        let model = makeModel()

        await model.importFiles(urls)

        XCTAssertEqual(model.phase, .finished(count: 2, truncatedFiles: []))
        XCTAssertEqual(outbox.enqueued.count, 2)
        XCTAssertTrue(outbox.enqueued[1].parsed.ocrRawText?.contains("SECOND SHOP") == true)
    }

    /// A file that is not a PDF is named, not skipped. A picked file that
    /// never became a receipt is exactly the silent loss this app does not
    /// do.
    func testAFileThatIsNotAPDFStopsAndNamesItself() async throws {
        let urls = try [
            write(Self.typesetPDF(), named: "good.pdf"),
            write(Data("not a pdf".utf8), named: "broken.pdf"),
        ]
        let model = makeModel()

        await model.importFiles(urls)

        guard case .failed(let message) = model.phase else {
            return XCTFail("Expected failed, got \(model.phase)")
        }
        XCTAssertTrue(message.contains("broken.pdf"), message)
        XCTAssertTrue(message.contains("The first 1 imported"), message)
        XCTAssertEqual(outbox.enqueued.count, 1, "the good one stays queued")
    }

    /// A full disk stops at the failing file; retry resumes there rather
    /// than re-importing what already landed.
    func testAFailedQueueingStopsAndRetryResumesAtTheSameFile() async throws {
        let urls = try [
            write(Self.typesetPDF(), named: "one.pdf"),
            write(Self.typesetPDF(lines: ["SECOND SHOP"]), named: "two.pdf"),
        ]
        outbox.failOnCallNumber = 2
        let model = makeModel()

        await model.importFiles(urls)
        guard case .failed(let message) = model.phase else {
            return XCTFail("Expected failed, got \(model.phase)")
        }
        XCTAssertTrue(message.contains("two.pdf"), message)
        XCTAssertEqual(outbox.enqueued.count, 1)

        await model.retry()
        XCTAssertEqual(model.phase, .finished(count: 2, truncatedFiles: []))
        XCTAssertEqual(outbox.enqueued.count, 2, "file one was not queued twice")
    }

    /// A document whose text runs past the server's 100 000-character
    /// bound is queued - carrying everything up to the cap - and SAYS so,
    /// naming the file. The bound is the server's (`z.string().max`), so
    /// exceeding it silently would be a 400 rather than a short receipt.
    func testADocumentLongerThanTheServerAcceptsIsQueuedAndSaidSo() async throws {
        let url = try write(Self.longPDF(), named: "very-long.pdf")
        let model = makeModel()

        await model.importFiles([url])

        guard case .finished(let count, let truncatedFiles) = model.phase else {
            return XCTFail("Expected finished, got \(model.phase)")
        }
        XCTAssertEqual(count, 1)
        XCTAssertEqual(truncatedFiles, ["very-long.pdf"])
        XCTAssertEqual(outbox.enqueued.count, 1, "it is still a receipt")
        let text = try XCTUnwrap(outbox.enqueued[0].parsed.ocrRawText)
        XCTAssertLessThanOrEqual(text.count, PDFReceiptText.maxCharacters)
        // The DOCUMENT is stored whole; only the text a parser reads was
        // shortened, and the note says exactly that.
        let note = PDFImportView.truncationNote(truncatedFiles)
        XCTAssertTrue(note.contains("very-long.pdf"), note)
        XCTAssertTrue(note.contains("document is stored whole"), note)
    }

    /// The view starts the import from a `task`; a second run of that task
    /// on the same presentation must not import the folder again.
    func testStartingTheSameImportTwiceDoesNothingTheSecondTime() async throws {
        let url = try write(Self.typesetPDF(), named: "one.pdf")
        let model = makeModel()

        await model.importFiles([url])
        await model.importFiles([url])

        XCTAssertEqual(outbox.enqueued.count, 1)
    }

    // MARK: - Fixtures

    private func write(_ data: Data, named name: String) throws -> URL {
        let url = directory.appending(path: name)
        try data.write(to: url)
        return url
    }

    private static let pageBounds = CGRect(x: 0, y: 0, width: 612, height: 792)

    private static func typesetPDF(
        lines: [String] = ["MAPLE FOODS MARKET", "2026/01/14", "TOTAL 113.00"]
    ) -> Data {
        let renderer = UIGraphicsPDFRenderer(bounds: pageBounds)
        return renderer.pdfData { context in
            context.beginPage()
            var y: CGFloat = 40
            for line in lines {
                (line as NSString).draw(
                    at: CGPoint(x: 40, y: y),
                    withAttributes: [.font: UIFont.systemFont(ofSize: 14)]
                )
                y += 24
            }
        }
    }

    /// More than 100 000 characters of real text layer: 40 pages of
    /// 50 rows of 80 characters is roughly 160 000.
    private static func longPDF() -> Data {
        let row = String(repeating: "AB CD EF GH ", count: 6)
        let renderer = UIGraphicsPDFRenderer(bounds: pageBounds)
        return renderer.pdfData { context in
            for _ in 0..<40 {
                context.beginPage()
                var y: CGFloat = 10
                for _ in 0..<50 {
                    (row as NSString).draw(
                        at: CGPoint(x: 10, y: y),
                        withAttributes: [.font: UIFont.systemFont(ofSize: 8)]
                    )
                    y += 15
                }
            }
        }
    }

    private static func imageOnlyPDF() -> Data {
        let renderer = UIGraphicsPDFRenderer(bounds: pageBounds)
        return renderer.pdfData { context in
            context.beginPage()
            UIColor.darkGray.setFill()
            context.cgContext.fill(CGRect(x: 50, y: 50, width: 300, height: 400))
        }
    }
}
