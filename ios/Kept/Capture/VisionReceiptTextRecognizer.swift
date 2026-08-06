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
        let request = VNRecognizeTextRequest()
        // .accurate over .fast: a receipt is read once and the numbers are
        // tax figures; recognition quality outranks latency (spec §4.2).
        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true

        let handler = VNImageRequestHandler(data: imageData)
        // Vision's perform is synchronous CPU-bound work; a detached task
        // keeps it off the main actor without inventing a queue.
        let observations = try await Task.detached(priority: .userInitiated) {
            do {
                try handler.perform([request])
            } catch {
                throw UnreadableImageError(underlying: error)
            }
            // After a successful perform, Vision's contract is an array -
            // empty when the page has no text. nil is "never performed",
            // unreachable here, and an empty parse is its honest reading.
            return request.results ?? []
        }.value

        let lines = observations.compactMap { observation -> RecognizedLine? in
            guard let candidate = observation.topCandidates(1).first else {
                return nil
            }
            // Vision's boundingBox is normalized with the origin at the
            // BOTTOM-left; RecognizedLine's verticalCenter is 0 at the TOP
            // (how a person reads a receipt), hence the flip. Horizontal
            // needs no flip.
            let box = observation.boundingBox
            return RecognizedLine(
                text: candidate.string,
                verticalCenter: 1.0 - box.midY,
                height: box.height,
                horizontalCenter: box.midX
            )
        }

        // Rows as printed, not fragments as recognized: this is what lets
        // the stored raw text keep "Subtotal 13.50" together for a future
        // re-parse, and the parser assembles again anyway (stable).
        return RecognizedText(lines: ReceiptRowAssembler.assembleRows(lines))
    }
}
