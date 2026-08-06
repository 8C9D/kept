import Foundation
@testable import Kept

/// Scripted OCR results, one per page in order - the camera-free half of
/// the §10.2 seam. A page beyond the script throws, same philosophy as
/// StubKeptAPI's unstubbed calls. @MainActor for the protocol's Sendable
/// bound, like StubKeptAPI.
@MainActor
final class StubTextRecognizer: ReceiptTextRecognizer {
    struct UnscriptedPage: Error {}

    /// The scripted OCR failure for `failOnCalls` - the stand-in for
    /// Vision choking on one image while others read fine.
    struct ScriptedFailure: Error {}

    private let results: [RecognizedText]
    /// 0-based call numbers that throw instead of answering; the call
    /// still consumes its slot in `results`, so scripts stay positional.
    private let failOnCalls: Set<Int>
    private let lock = NSLock()
    private var callCount = 0

    init(results: [RecognizedText], failOnCalls: Set<Int> = []) {
        self.results = results
        self.failOnCalls = failOnCalls
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
        if failOnCalls.contains(index) { throw ScriptedFailure() }
        guard index < results.count else { throw UnscriptedPage() }
        return results[index]
    }
}
