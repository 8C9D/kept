import Foundation
import PDFKit
import UIKit

/// The text layer of an emailed PDF receipt, reassembled into the rows a
/// person would read off the page (2026-09-01) - the iOS half of what
/// `web/src/pdfText.ts` does in the browser, and deliberately the same
/// answer for the same document.
///
/// Why it exists: spec §6A consequence 2 - "the email backlog is a folder
/// of PDFs on a laptop" - and that folder is now reachable from the phone
/// through Files, iCloud Drive or the Mail attachment someone saved. An
/// emailed receipt is not a photograph: it carries a real text layer,
/// exact and noise-free, and the only thing between that text and the
/// server's LLM sweep was nobody extracting it.
///
/// ⚠ Nothing here parses a receipt. It produces TEXT, exactly as
/// `VisionReceiptTextRecognizer` does for a photograph; the server's
/// parsers are the authority on what an amount or a vendor is (CLAUDE.md:
/// the domain logic is the backend's, deliberately, so a second client
/// does not reimplement it). The owner's decision for this import is
/// explicit - read the text layer, send it, and let the server's LLM be
/// the parser - so no on-device heuristic runs over PDF text at all.
///
/// The row work PDFKit already does is taken as given: `PDFPage.string`
/// hands back reading-order text with line breaks in it, which is the
/// same thing `assemblePageRows` reconstructs from raw fragments in the
/// browser because pdf.js offers nothing better. Redoing it from
/// `PDFSelection` geometry here would be a second implementation of a
/// solved problem, and a worse one.
enum PDFReceiptText {
    /// The server's own `ocrRawText` bound (`z.string().max(100_000)`,
    /// server/src/http/schemas.ts). Sending more is a 400, not a
    /// truncation the server performs for us, so this is where the cap is
    /// applied - the same place and the same number as the web client's
    /// `OCR_RAW_TEXT_MAX_CHARS`.
    static let maxCharacters = 100_000

    /// What one PDF's text layer amounts to.
    struct Extraction: Equatable, Sendable {
        /// The assembled rows, pages separated by a blank line. Empty for
        /// a PDF with no text layer at all - a scanned one, which is the
        /// case the caller renders and reads with Vision instead.
        let text: String
        /// True when the cap above stopped the assembly early. Reported
        /// rather than swallowed: a truncated receipt is still worth
        /// parsing, but nobody should be told the whole document was read.
        let truncated: Bool

        var isEmpty: Bool { text.isEmpty }

        /// How many printed rows the text carries. Derived rather than
        /// counted during assembly: it is only ever read by a test, and a
        /// stored field nothing in the app looks at is a field that gets
        /// to be wrong without anyone noticing.
        var lineCount: Int {
            text.isEmpty ? 0 : text.split(separator: "\n").count
        }
    }

    /// Every page's text -> the one string the create request carries.
    ///
    /// Pages are separated by a blank line: a receipt emailed as a
    /// two-page PDF is one receipt, and the page break is context a parser
    /// can use rather than a document boundary. Blank lines inside a page
    /// are dropped - a PDF's line breaks are the typesetter's, and a
    /// three-line gap between a subtotal and a total says nothing the
    /// parser can use.
    ///
    /// The cap is applied at a LINE boundary, never mid-line: slicing a
    /// row in half could leave "TOTAL 14" where the paper says "TOTAL
    /// 14.35", and a plausible wrong number is worse than a short
    /// document. (Constraint 2 still has a human confirm every value - but
    /// the suggestion they start from should not be one this client
    /// manufactured by cutting a string.)
    static func assemble(pageTexts: [String]) -> Extraction {
        var parts: [String] = []
        var length = 0
        var truncated = false

        pages: for pageText in pageTexts {
            let rows = pageText
                .split(separator: "\n", omittingEmptySubsequences: false)
                .map { $0.trimmingCharacters(in: .whitespaces) }
                .filter { !$0.isEmpty }
            for (rowIndex, row) in rows.enumerated() {
                // A blank line at a page boundary, a single newline
                // between rows, and nothing before the document's first
                // row.
                let separator = parts.isEmpty ? "" : (rowIndex == 0 ? "\n\n" : "\n")
                if length + separator.count + row.count > maxCharacters {
                    truncated = true
                    break pages
                }
                parts.append(separator)
                parts.append(row)
                length += separator.count + row.count
            }
        }

        return Extraction(text: parts.joined(), truncated: truncated)
    }

    /// One document's text layer, page by page.
    ///
    /// A page PDFKit cannot give a string for contributes an empty page
    /// rather than aborting the document: a covering letter that is a
    /// scanned image in front of two typeset pages is still worth reading
    /// the typeset pages of.
    static func extract(from document: PDFDocument) -> Extraction {
        var pageTexts: [String] = []
        for index in 0..<document.pageCount {
            pageTexts.append(document.page(at: index)?.string ?? "")
        }
        return assemble(pageTexts: pageTexts)
    }

    /// Page one as an image, for the scanned-PDF fallback: a PDF with no
    /// text layer is a photograph in a wrapper, and the only way to read
    /// it is the same Vision pass every camera capture goes through.
    ///
    /// 2× the page's own size - the receipt is typically letter-sized
    /// artwork holding 8-point type, and Vision reads it markedly better
    /// with the extra pixels while a two-page render at this scale still
    /// costs a few megabytes of transient memory.
    ///
    /// ⚠ Only page one, deliberately, matching what the camera path does
    /// with a multi-page scan: the vendor, the date and the totals are on
    /// the first page, and reading a continuation page produces confident
    /// nonsense rather than more evidence. The ORIGINAL PDF is still what
    /// gets uploaded - this render exists to be read, never to be stored.
    static func renderFirstPage(of document: PDFDocument, scale: CGFloat = 2) -> UIImage? {
        guard let page = document.page(at: 0) else { return nil }
        let bounds = page.bounds(for: .mediaBox)
        guard bounds.width > 0, bounds.height > 0 else { return nil }
        let size = CGSize(width: bounds.width * scale, height: bounds.height * scale)
        // ⚠ `format.scale = 1`, explicitly. The default is the SCREEN's
        // scale, which on a 3× phone would multiply the `scale` above
        // again and render a letter page at 3672×4752 - seventeen
        // megapixels of transient bitmap per file, in a loop over a
        // folder of them, for no extra readability. This way the pixel
        // count is exactly what `scale` says it is. Opaque because the
        // page is filled white first; a white receipt needs no alpha
        // channel and the render is a quarter smaller without one.
        let format = UIGraphicsImageRendererFormat.preferred()
        format.scale = 1
        format.opaque = true
        let renderer = UIGraphicsImageRenderer(size: size, format: format)
        return renderer.image { context in
            UIColor.white.setFill()
            context.fill(CGRect(origin: .zero, size: size))
            // PDF user space has its origin at the bottom-left and grows
            // upward; UIKit's grows downward. Flip, then scale, then let
            // PDFKit draw the page into the box it now occupies.
            context.cgContext.translateBy(x: 0, y: size.height)
            context.cgContext.scaleBy(x: scale, y: -scale)
            page.draw(with: .mediaBox, to: context.cgContext)
        }
    }
}
