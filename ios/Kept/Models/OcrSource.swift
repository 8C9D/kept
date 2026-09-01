import Foundation

/// Where a receipt's `ocrRawText` came from, in the server's own
/// vocabulary (`OCR_SOURCES`, server/src/domain/ocrSuggestions.ts):
/// a photograph read by Vision, or a PDF's own text layer read by PDFKit
/// (2026-09-01, the iOS PDF import).
///
/// The distinction is the server's business, not this client's: on a
/// `pdf-text` receipt the §7.3 merge deliberately falls through for the
/// money fields, so the LLM's amounts are what get served back as
/// suggestions. This client's only job is to say honestly which reader
/// produced the text it is sending - a photograph's OCR and a
/// typesetter's own characters are different kinds of evidence, and a
/// client that called both "vision" would be lying to the merge.
///
/// `String`-backed for the same reason `ReviewedField` is: a name this
/// client cannot spell is a compile error here rather than a rejected
/// request at runtime.
enum OcrSource: String, Codable, Equatable, Sendable {
    case vision
    case pdfText = "pdf-text"
}
