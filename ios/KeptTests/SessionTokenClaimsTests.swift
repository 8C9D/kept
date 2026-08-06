import XCTest
@testable import Kept

/// Reading the sub claim out of the app's own session token - the value
/// that scopes outbox items to the user who captured them (constraint 4).
final class SessionTokenClaimsTests: XCTestCase {
    func testReadsTheUserIdFromARealShapedToken() {
        let userId = UUID()
        let token = TestTokens.sessionToken(sub: userId.uuidString.lowercased())
        XCTAssertEqual(SessionTokenClaims.userId(inToken: token), userId)
    }

    func testHandlesEveryBase64PaddingRemainder() {
        // Payload length decides how much stripped base64 padding the
        // decoder must restore. A filler claim varies the length while the
        // sub stays a valid uuid, so every remainder must decode to the
        // SAME correct answer - if the padding restoration were deleted,
        // three of these four lengths would fail. (The first draft
        // asserted nil for the padded cases, which passes with or without
        // the padding logic - a test written to pass; reviewer finding.)
        for filler in ["", "a", "ab", "abc"] {
            let userId = UUID()
            let token = TestTokens.sessionToken(sub: userId.uuidString.lowercased(), filler: filler)
            XCTAssertEqual(
                SessionTokenClaims.userId(inToken: token),
                userId,
                "filler length \(filler.count)"
            )
        }
    }

    func testRejectsGarbageWithoutCrashing() {
        XCTAssertNil(SessionTokenClaims.userId(inToken: ""))
        XCTAssertNil(SessionTokenClaims.userId(inToken: "not-a-jwt"))
        XCTAssertNil(SessionTokenClaims.userId(inToken: "a.b"))
        XCTAssertNil(SessionTokenClaims.userId(inToken: "a.!!!.c"))
        XCTAssertNil(SessionTokenClaims.userId(inToken: "a.bm90IGpzb24.c")) // payload "not json"
    }

    func testRejectsANonUuidSubject() {
        XCTAssertNil(SessionTokenClaims.userId(inToken: TestTokens.sessionToken(sub: "not-a-uuid")))
    }
}
