import XCTest
@testable import Kept

/// Session lifecycle: cold launch, sign-in outcomes, and the expiry path
/// the wave-3 gate requires - a rejected session must land back at
/// signed-out, never hang.
@MainActor
final class SessionControllerTests: XCTestCase {
    private var api = StubKeptAPI()
    private var tokenStore = InMemoryTokenStore()

    override func setUp() {
        super.setUp()
        api = StubKeptAPI()
        tokenStore = InMemoryTokenStore()
    }

    private func makeController() -> SessionController {
        SessionController(api: api, tokenStore: tokenStore)
    }

    // MARK: - Cold launch

    func testLaunchWithStoredTokenIsSignedIn() {
        tokenStore.stored = "stored-session-token"
        XCTAssertEqual(makeController().state, .signedIn)
    }

    func testLaunchWithoutTokenIsSignedOut() {
        XCTAssertEqual(makeController().state, .signedOut)
    }

    func testLaunchWithUnreadableTokenIsSignedOutWithMessage() {
        tokenStore.loadError = KeychainError(operation: "read", status: -1)
        let controller = makeController()
        XCTAssertEqual(controller.state, .signedOut)
        XCTAssertEqual(
            controller.signInMessage,
            "The saved session could not be read. Keychain read failed (OSStatus -1)."
        )
    }

    // MARK: - Signing in

    func testSuccessfulSignInStoresTokenAndSignsIn() async {
        api.signInHandler = { identityToken, displayName in
            XCTAssertEqual(identityToken, "apple-identity-token")
            XCTAssertEqual(displayName, "Test User")
            return Fixtures.signInResponse(token: "issued-session-jwt")
        }
        let controller = makeController()

        await controller.signIn(identityToken: "apple-identity-token", displayName: "Test User")

        XCTAssertEqual(controller.state, .signedIn)
        XCTAssertEqual(tokenStore.stored, "issued-session-jwt")
        XCTAssertNil(controller.signInMessage)
    }

    func testRejectedIdentityTokenReturnsCleanlyToSignedOut() async {
        api.signInHandler = { _, _ in
            throw APIError.requestFailed(
                code: "invalid_identity_token",
                message: "Apple identity token failed verification",
                status: 401
            )
        }
        let controller = makeController()

        await controller.signIn(identityToken: "rejected-token", displayName: nil)

        // The gate's anti-hang requirement: never stuck in .signingIn.
        XCTAssertEqual(controller.state, .signedOut)
        XCTAssertEqual(controller.signInMessage, "Apple identity token failed verification")
        XCTAssertNil(tokenStore.stored)
    }

    func testTokenSaveFailureReturnsToSignedOutWithMessage() async {
        api.signInHandler = { _, _ in Fixtures.signInResponse() }
        tokenStore.saveError = KeychainError(operation: "add", status: -34018)
        let controller = makeController()

        await controller.signIn(identityToken: "apple-identity-token", displayName: nil)

        XCTAssertEqual(controller.state, .signedOut)
        XCTAssertEqual(controller.signInMessage, "Keychain add failed (OSStatus -34018).")
    }

    // MARK: - Session expiry

    func testRejectedSessionClearsTokenAndSignsOut() {
        tokenStore.stored = "stale-session-token"
        let controller = makeController()
        XCTAssertEqual(controller.state, .signedIn)

        controller.handleSessionRejected()

        XCTAssertEqual(controller.state, .signedOut)
        XCTAssertNil(tokenStore.stored)
        XCTAssertEqual(controller.signInMessage, "Your session has expired. Sign in again.")
    }

    func testSignOutClearsTokenWithoutAMessage() {
        tokenStore.stored = "stored-session-token"
        let controller = makeController()

        controller.signOut()

        XCTAssertEqual(controller.state, .signedOut)
        XCTAssertNil(tokenStore.stored)
        XCTAssertNil(controller.signInMessage)
    }

    func testSignOutWithUnclearableTokenStillSignsOutAndSaysSo() {
        tokenStore.stored = "stored-session-token"
        tokenStore.clearError = KeychainError(operation: "delete", status: -1)
        let controller = makeController()

        controller.signOut()

        XCTAssertEqual(controller.state, .signedOut)
        XCTAssertNotNil(controller.signInMessage)
    }

    // MARK: - Display name extraction

    func testDisplayNameFormatsComponents() {
        var components = PersonNameComponents()
        components.givenName = "Test"
        components.familyName = "User"
        XCTAssertEqual(SessionController.displayName(from: components), "Test User")
    }

    func testDisplayNameIsNilForNilComponents() {
        XCTAssertNil(SessionController.displayName(from: nil))
    }

    func testDisplayNameIsNilForEmptyComponents() {
        // Apple can return a components value with nothing in it; the
        // server rejects "", so it must become nil.
        XCTAssertNil(SessionController.displayName(from: PersonNameComponents()))
    }
}
