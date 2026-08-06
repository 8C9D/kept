import Foundation
@testable import Kept

/// Scripted OCR results, one per page in order - the camera-free half of
/// the §10.2 seam. A page beyond the script throws, same philosophy as
/// StubKeptAPI's unstubbed calls.
final class StubTextRecognizer: ReceiptTextRecognizer {
    struct UnscriptedPage: Error {}

    private let results: [RecognizedText]
    private let lock = NSLock()
    private var callCount = 0

    init(results: [RecognizedText]) {
        self.results = results
    }

    convenience init(repeating text: RecognizedText, count: Int) {
        self.init(results: Array(repeating: text, count: count))
    }

    func recognizeText(in imageData: Data) async throws -> RecognizedText {
        let index = lock.withLock {
            let current = callCount
            callCount += 1
            return current
        }
        guard index < results.count else { throw UnscriptedPage() }
        return results[index]
    }
}
