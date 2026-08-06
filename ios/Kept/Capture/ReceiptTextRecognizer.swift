import Foundation

/// The seam between the capture flow and OCR, mirroring HTTPTransport's
/// role for networking: models depend on this protocol, the Vision
/// implementation is plumbing only a device can exercise, and tests script
/// recognition results without a camera (spec §10.2).
protocol ReceiptTextRecognizer {
    func recognizeText(in imageData: Data) async throws -> RecognizedText
}

/// Everything OCR hands onward: the lines the parser consumes, plus the
/// raw text stored on the receipt so a better parser can re-run over old
/// receipts later (spec §7.3).
struct RecognizedText: Equatable {
    /// In reading order, top of the receipt first.
    let lines: [RecognizedLine]

    /// One recognized line per row, newline-joined, top to bottom.
    var rawText: String {
        lines.map(\.text).joined(separator: "\n")
    }
}
