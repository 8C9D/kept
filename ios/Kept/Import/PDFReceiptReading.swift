import Foundation
import PDFKit
import UIKit

/// How one imported PDF got read (2026-09-01), and therefore what the
/// receipt it becomes will carry.
///
/// the owner's decision, in a type: **the text layer first, a render only
/// when there is none.** An emailed receipt's own characters are exact -
/// no OCR error is possible on them - and the server's LLM is a far better
/// parser of that text than the on-device heuristics are, so the text
/// travels as `ocrRawText` with `ocrSource: pdf-text` and NO on-device
/// suggestions at all. The heuristics are not "also run, just in case":
/// running them would put a guess into `ocr_suggestions`, which is the
/// immutable record of what a parser said, and claim a reading nobody
/// made.
///
/// A scanned PDF - a photograph someone's scanner wrapped in a PDF - has
/// no text layer at all, and for it the fallback is exactly the camera
/// path: render page one, read it with Vision, parse it with the same
/// heuristics every capture goes through, `ocrSource: vision`. What gets
/// UPLOADED is the original PDF either way; the render exists to be read,
/// never to be stored.
enum PDFReceiptReading: Equatable, Sendable {
    /// The document's own text layer, non-empty.
    case textLayer(PDFReceiptText.Extraction)
    /// No text layer: page one, rendered to JPEG bytes for Vision to read.
    ///
    /// Bytes rather than a `UIImage` for two reasons that agree:
    /// `ReceiptTextRecognizer` takes `Data` (so a `UIImage` would only be
    /// encoded a line later anyway), and `UIImage` is not `Sendable`, so
    /// carrying one out of the off-main read below would be exactly the
    /// crossing strict concurrency exists to flag.
    case rendered(Data)
    /// Not a PDF this device can open, or a PDF with no pages in it.
    /// Reported to the person by name rather than skipped - a file they
    /// picked and that never became a receipt is exactly the silent loss
    /// this app does not do.
    case unreadable

    /// Reads the bytes of one picked file.
    ///
    /// `nonisolated` and `async` so a caller on the main actor hops off it
    /// for the parse and the render: a scanned letter-size page at 2× is
    /// a few million pixels, and doing that under someone's thumb is a
    /// visible stall.
    static func read(documentData: Data) async -> PDFReceiptReading {
        guard let document = PDFDocument(data: documentData), document.pageCount > 0 else {
            return .unreadable
        }
        let extraction = PDFReceiptText.extract(from: document)
        if !extraction.isEmpty {
            return .textLayer(extraction)
        }
        guard
            let image = PDFReceiptText.renderFirstPage(of: document),
            // The same quality the scanner encodes its pages at. These
            // bytes are never uploaded - the ORIGINAL PDF is what the
            // receipt stores - so this is purely what Vision reads.
            let jpeg = image.jpegData(compressionQuality: 0.8)
        else {
            return .unreadable
        }
        return .rendered(jpeg)
    }
}
