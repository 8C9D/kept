import Foundation
@testable import Kept

/// An AppleReauthorizing whose outcome each test scripts, recording how
/// many times it was asked. Apple's sheet cannot be driven from a unit
/// test; what IS testable is everything the app decides around it - that a
/// cancel stops the deletion, that any other failure does not, and that the
/// code reaches the request.
@MainActor
final class StubAppleReauthorization: AppleReauthorizing {
    /// What the next call answers with. Defaults to a code, because the
    /// happy path is the one most tests are about.
    var result: Result<String, Error> = .success("stub-authorization-code")
    private(set) var callCount = 0

    func authorizationCode() async throws -> String {
        callCount += 1
        return try result.get()
    }
}
