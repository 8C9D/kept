import PDFKit
import UIKit
import XCTest
@testable import Kept

/// The PDF import's reading half (2026-09-01): what comes out of a text
/// layer, where the server's 100 000-character bound is applied, and how a
/// scanned PDF - one with no text layer at all - is told apart from a
/// typeset one.
///
/// Every PDF here is generated in the test with `UIGraphicsPDFRenderer`,
/// so these run on the simulator with no fixture files and no camera. That
/// is the whole reason this logic sits where it does: the file picker
/// cannot be driven from a unit test, but everything it hands over can.
final class PDFReceiptTextTests: XCTestCase {
    // MARK: - Assembly (pure; no PDF needed)

    func testRowsAreTrimmedAndBlankLinesDropped() {
        let extraction = PDFReceiptText.assemble(pageTexts: [
            "  MAPLE FOODS MARKET  \n\n\n  TOTAL  113.00  \n",
        ])
        XCTAssertEqual(extraction.text, "MAPLE FOODS MARKET\nTOTAL  113.00")
        XCTAssertEqual(extraction.lineCount, 2)
        XCTAssertFalse(extraction.truncated)
    }

    /// A receipt emailed as a two-page PDF is ONE receipt; the page break
    /// is context a parser can use, so it survives as a blank line rather
    /// than being flattened away or treated as a document boundary.
    func testPagesAreSeparatedByABlankLine() {
        let extraction = PDFReceiptText.assemble(pageTexts: ["Page one line", "Page two line"])
        XCTAssertEqual(extraction.text, "Page one line\n\nPage two line")
        XCTAssertEqual(extraction.lineCount, 2)
    }

    func testAPageWithNoTextContributesNothing() {
        let extraction = PDFReceiptText.assemble(pageTexts: ["", "   \n  ", "Only line"])
        XCTAssertEqual(extraction.text, "Only line")
        XCTAssertEqual(extraction.lineCount, 1)
    }

    func testAnEmptyTextLayerIsEmpty() {
        let extraction = PDFReceiptText.assemble(pageTexts: ["", ""])
        XCTAssertTrue(extraction.isEmpty)
        XCTAssertEqual(extraction.lineCount, 0)
    }

    /// The cap is the server's own `z.string().max(100_000)`: over it is a
    /// 400, not a truncation the server performs for us.
    func testTheCapIsAppliedAtALineBoundaryNeverMidLine() {
        // Lines of 999 characters plus their newline: 100 of them is
        // 99 999 + 99 separators = 100 098, so the last one cannot fit.
        let line = String(repeating: "X", count: 999)
        let extraction = PDFReceiptText.assemble(
            pageTexts: [Array(repeating: line, count: 120).joined(separator: "\n")]
        )
        XCTAssertTrue(extraction.truncated)
        XCTAssertLessThanOrEqual(extraction.text.count, PDFReceiptText.maxCharacters)
        // Whole lines only - "TOTAL 14" where the paper says "TOTAL 14.35"
        // is the failure this rule exists to prevent.
        XCTAssertTrue(
            extraction.text.split(separator: "\n").allSatisfy { $0.count == 999 },
            "a row was cut in half"
        )
        XCTAssertEqual(extraction.lineCount, extraction.text.split(separator: "\n").count)
    }

    func testAnExactlyFittingDocumentIsNotReportedTruncated() {
        let line = String(repeating: "X", count: PDFReceiptText.maxCharacters)
        let extraction = PDFReceiptText.assemble(pageTexts: [line])
        XCTAssertFalse(extraction.truncated)
        XCTAssertEqual(extraction.text.count, PDFReceiptText.maxCharacters)
    }

    // MARK: - A real PDF, generated here

    func testATypesetPDFReadsItsOwnTextLayer() throws {
        let data = Self.pdf(pages: [
            ["MAPLE FOODS MARKET", "2026/01/14", "TOTAL 113.00"],
        ])
        let document = try XCTUnwrap(PDFDocument(data: data))
        let extraction = PDFReceiptText.extract(from: document)

        XCTAssertFalse(extraction.isEmpty)
        // PDFKit decides its own line breaks; what matters is that every
        // printed row is in there, in order, and that nothing had to be
        // guessed at.
        XCTAssertTrue(extraction.text.contains("MAPLE FOODS MARKET"), extraction.text)
        XCTAssertTrue(extraction.text.contains("2026/01/14"), extraction.text)
        XCTAssertTrue(extraction.text.contains("TOTAL 113.00"), extraction.text)
    }

    func testATwoPagePDFReadsBothPages() throws {
        let data = Self.pdf(pages: [["FIRST PAGE LINE"], ["SECOND PAGE LINE"]])
        let document = try XCTUnwrap(PDFDocument(data: data))
        let extraction = PDFReceiptText.extract(from: document)
        XCTAssertTrue(extraction.text.contains("FIRST PAGE LINE"), extraction.text)
        XCTAssertTrue(extraction.text.contains("SECOND PAGE LINE"), extraction.text)
    }

    // MARK: - The scanned-PDF fallback decision

    /// A PDF with a text layer never gets rendered: the typesetter's own
    /// characters are exact, and OCRing a picture of them could only make
    /// them worse.
    func testAPDFWithATextLayerReadsTheTextAndDoesNotRender() async throws {
        let data = Self.pdf(pages: [["MAPLE FOODS MARKET", "TOTAL 113.00"]])
        let reading = await PDFReceiptReading.read(documentData: data)
        guard case .textLayer(let extraction) = reading else {
            return XCTFail("Expected textLayer, got \(reading)")
        }
        XCTAssertTrue(extraction.text.contains("TOTAL 113.00"), extraction.text)
    }

    /// A scanned PDF - a photograph someone's scanner wrapped in a PDF -
    /// has no text layer, so page one is rendered for Vision to read,
    /// exactly as a camera capture is.
    func testAScannedPDFFallsBackToARenderedFirstPage() async throws {
        let data = Self.imageOnlyPDF()
        let reading = await PDFReceiptReading.read(documentData: data)
        guard case .rendered(let jpeg) = reading else {
            return XCTFail("Expected rendered, got \(reading)")
        }
        let rendered = try XCTUnwrap(UIImage(data: jpeg))
        // 2× the 612×792 page it was rendered from - the extra pixels are
        // the point of the scale factor.
        XCTAssertEqual(rendered.size.width, 1224, accuracy: 1)
        XCTAssertEqual(rendered.size.height, 1584, accuracy: 1)
    }

    func testBytesThatAreNotAPDFAreUnreadable() async {
        let reading = await PDFReceiptReading.read(documentData: Data("not a pdf at all".utf8))
        XCTAssertEqual(reading, .unreadable)
    }

    // MARK: - Fixtures

    private static let pageSize = CGRect(x: 0, y: 0, width: 612, height: 792)

    /// A typeset PDF: real text drawn with `NSAttributedString`, so PDFKit
    /// finds a real text layer in it.
    private static func pdf(pages: [[String]]) -> Data {
        let renderer = UIGraphicsPDFRenderer(bounds: pageSize)
        return renderer.pdfData { context in
            for lines in pages {
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
    }

    /// A PDF holding nothing but a drawn rectangle - no text at all, which
    /// is what a scanner's output looks like to PDFKit.
    private static func imageOnlyPDF() -> Data {
        let renderer = UIGraphicsPDFRenderer(bounds: pageSize)
        return renderer.pdfData { context in
            context.beginPage()
            UIColor.darkGray.setFill()
            context.cgContext.fill(CGRect(x: 50, y: 50, width: 300, height: 400))
        }
    }
}
