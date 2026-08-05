import Foundation
@testable import Kept

/// A scripted HTTPTransport: tests enqueue responses, the client under
/// test consumes them in order, and every request is recorded for
/// assertion. This is the seam spec §10.2 requires - the entire networking
/// layer above it runs for real.
final class StubTransport: HTTPTransport {
    enum Outcome {
        case respond(status: Int, body: Data)
        case fail(URLError)
    }

    /// Thrown when the client makes a request the test did not script -
    /// itself a finding, so it fails loudly rather than answering 200.
    struct UnscriptedRequest: Error {}

    /// Thrown when a scripted response cannot be assembled; never expected.
    struct ResponseConstructionFailure: Error {}

    private var queue: [Outcome] = []
    private(set) var requests: [URLRequest] = []

    func enqueue(status: Int, jsonBody: String) {
        queue.append(.respond(status: status, body: Data(jsonBody.utf8)))
    }

    func enqueueFailure(_ error: URLError) {
        queue.append(.fail(error))
    }

    func send(_ request: URLRequest) async throws -> (data: Data, response: HTTPURLResponse) {
        requests.append(request)
        guard !queue.isEmpty else {
            throw UnscriptedRequest()
        }
        switch queue.removeFirst() {
        case .fail(let error):
            throw error
        case .respond(let status, let body):
            guard let url = request.url,
                  let response = HTTPURLResponse(
                    url: url,
                    statusCode: status,
                    httpVersion: "HTTP/1.1",
                    headerFields: ["Content-Type": "application/json"]
                  ) else {
                throw ResponseConstructionFailure()
            }
            return (body, response)
        }
    }
}
