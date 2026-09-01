import Foundation
import Vision

/// On-device OCR via Vision (spec §4.2): free, offline, no per-scan cost -
/// which is what keeps capture-in-under-a-minute true in a store with no
/// signal (§7.3's argument against cloud OCR in v1).
///
/// This is the untestable half of the §10.2 seam: the simulator can run
/// this code, but only a real photograph of a real receipt exercises it
/// meaningfully. Everything it does is translation - Vision observations
/// into the parser's RecognizedLine - so the logic worth testing lives in
/// the parser, not here.
struct VisionReceiptTextRecognizer: ReceiptTextRecognizer {
    /// Carries Vision's own error: "could not be read" alone cannot tell a
    /// corrupt JPEG from memory pressure, and during the wave-4 device
    /// accuracy run this message is the only diagnostic there is.
    struct UnreadableImageError: LocalizedError {
        let underlying: Error

        var errorDescription: String? {
            "The scanned image could not be read for text recognition. (\(underlying.localizedDescription))"
        }
    }

    func recognizeText(in imageData: Data) async throws -> RecognizedText {
        // Vision's perform is synchronous CPU-bound work; a detached task
        // keeps it off the main actor without inventing a queue. The whole
        // Vision interaction lives inside the task - its request, handler,
        // and observations are not Sendable, so only the value-typed lines
        // may cross back out (strict concurrency, wave 5).
        let lines = try await Task.detached(priority: .userInitiated) {
            let request = VNRecognizeTextRequest()
            // .accurate over .fast: a receipt is read once and the numbers
            // are tax figures; recognition quality outranks latency (§4.2).
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = true

            let handler = VNImageRequestHandler(data: imageData)
            do {
                try handler.perform([request])
            } catch {
                throw UnreadableImageError(underlying: error)
            }
            // After a successful perform, Vision's contract is an array -
            // empty when the page has no text. nil is "never performed",
            // unreachable here, and an empty parse is its honest reading.
            let observations = request.results ?? []

            return observations.compactMap { observation -> RecognizedLine? in
                guard let candidate = observation.topCandidates(1).first else {
                    return nil
                }
                // Vision's boundingBox is normalized with the origin at the
                // BOTTOM-left; RecognizedLine's verticalCenter is 0 at the
                // TOP (how a person reads a receipt), hence the flip.
                // Horizontal needs no flip.
                let box = observation.boundingBox
                return RecognizedLine(
                    text: candidate.string,
                    verticalCenter: 1.0 - box.midY,
                    height: box.height,
                    horizontalCenter: box.midX
                )
            }
        }.value

        // Rows as printed, not fragments as recognized: this is what lets
        // the stored raw text keep "Subtotal 13.50" together for a future
        // re-parse.
        //
        // To a FIXED POINT since 2026-09-01. One pass is not idempotent
        // (ReceiptRowAssembler.assembledToFixedPoint carries the reasoning
        // and the receipt that proved it), so this line used to hand the
        // server one-pass text while the parser read two-pass text - the
        // stored `ocr_raw_text` the LLM re-parses had orphaned amount-only
        // lines on 16 of the 130 live receipts. Assembling to a fixed point
        // here makes the text the server sees the text this device read.
        return RecognizedText(lines: ReceiptRowAssembler.assembledToFixedPoint(lines))
    }
}
