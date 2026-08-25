import XCTest
@testable import Kept

/// Session lifecycle: cold launch, sign-in outcomes, and the expiry path
/// the wave-3 gate requires - a rejected session must land back at
/// signed-out, never hang.
@MainActor
final class SessionControllerTests: XCTestCase {
    private var api = StubKeptAPI()
    private var tokenStore = InMemoryTokenStore()
    private var reauthorization = StubAppleReauthorization()

    override func setUp() async throws {
        try await super.setUp()
        api = StubKeptAPI()
        tokenStore = InMemoryTokenStore()
        reauthorization = StubAppleReauthorization()
    }

    private func makeController() -> SessionController {
        SessionController(api: api, tokenStore: tokenStore, reauthorization: reauthorization)
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

    func testSignInSuccessFiresOnSignedInAndFailureDoesNot() async {
        // The wave-5 outbox resumes on this callback: receipts queued when
        // a session expired must start uploading the moment their owner is
        // back - and must NOT be poked by a failed attempt.
        api.signInHandler = { _, _ in
            Fixtures.signInResponse(token: "issued-session-jwt")
        }
        let controller = makeController()
        var signedInCalls = 0
        controller.onSignedIn = { signedInCalls += 1 }

        await controller.signIn(identityToken: "token", displayName: nil)
        XCTAssertEqual(signedInCalls, 1)

        struct Boom: Error {}
        api.signInHandler = { _, _ in throw Boom() }
        await controller.signIn(identityToken: "token", displayName: nil)
        XCTAssertEqual(signedInCalls, 1, "a failed sign-in fires nothing")
    }

    func testEveryTransitionToSignedOutFiresOnSignedOut() {
        // The outbox listens on this to stop displaying the departed
        // user's queue; both flavours of sign-out must reach it.
        tokenStore.stored = "a-token"
        let controller = makeController()
        var signedOutCalls = 0
        controller.onSignedOut = { signedOutCalls += 1 }

        controller.signOut()
        XCTAssertEqual(signedOutCalls, 1)

        tokenStore.stored = "another-token"
        controller.handleSessionRejected()
        XCTAssertEqual(signedOutCalls, 2)
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

    // MARK: - Deleting the account (App Store Guideline 5.1.1(v))

    /// A controller already signed in as `userId`, with a token that really
    /// carries that subject - the deletion path reads it to tell the outbox
    /// whose queued receipts to discard.
    private func signedInController(as userId: UUID) -> SessionController {
        tokenStore.stored = TestTokens.sessionToken(sub: userId.uuidString.lowercased())
        return makeController()
    }

    func testDeleteAccountRevokesSignsOutAndSaysSo() async {
        let userId = UUID()
        reauthorization.result = .success("fresh-apple-code")
        api.deleteAccountHandler = { _ in }
        let controller = signedInController(as: userId)
        var deletedUserIds: [UUID] = []
        controller.onAccountDeleted = { deletedUserIds.append($0) }

        await controller.deleteAccount()

        // The code Apple just minted reached the request, which is the only
        // thing that lets the server revoke anything.
        XCTAssertEqual(api.deleteAccountCalls.count, 1)
        XCTAssertEqual(api.deleteAccountCalls.first ?? nil, "fresh-apple-code")
        XCTAssertEqual(controller.state, .signedOut)
        XCTAssertNil(tokenStore.stored)
        XCTAssertEqual(controller.accountDeletion, .idle)
        XCTAssertEqual(
            controller.signInMessage,
            "Your account and all its receipts have been deleted."
        )
        // The outbox is told whose local copies to destroy - "delete all my
        // receipts" has to include the ones still on this phone.
        XCTAssertEqual(deletedUserIds, [userId])
    }

    func testCancellingApplesSheetCancelsTheWholeDeletion() async {
        // The last point at which a person can change their mind, and it
        // must mean what it says: nothing is requested, nothing is deleted,
        // and no error is shown for a decision.
        reauthorization.result = .failure(AppleReauthorizationError.cancelled)
        let controller = signedInController(as: UUID())

        await controller.deleteAccount()

        XCTAssertEqual(api.deleteAccountCalls.count, 0)
        XCTAssertEqual(controller.state, .signedIn)
        XCTAssertEqual(controller.accountDeletion, .idle)
        XCTAssertNotNil(tokenStore.stored)
    }

    func testReauthorizationFailureStillDeletesTheAccountWithoutACode() async {
        // Apple's own guidance: fulfil the deletion even with nothing
        // revocable in hand. A person who cannot delete their account
        // because Apple's sheet errored is what 5.1.1(v) forbids.
        struct Boom: Error {}
        reauthorization.result = .failure(Boom())
        api.deleteAccountHandler = { _ in }
        let controller = signedInController(as: UUID())

        await controller.deleteAccount()

        XCTAssertEqual(api.deleteAccountCalls.count, 1)
        XCTAssertNil(api.deleteAccountCalls.first ?? nil, "no code was available to send")
        XCTAssertEqual(controller.state, .signedOut)
    }

    func testFailedDeletionLeavesTheSessionIntactAndStatesWhy() async {
        api.deleteAccountHandler = { _ in
            throw APIError.requestFailed(
                code: "internal_error",
                message: "Internal server error",
                status: 500
            )
        }
        let controller = signedInController(as: UUID())
        var deletedUserIds: [UUID] = []
        controller.onAccountDeleted = { deletedUserIds.append($0) }

        await controller.deleteAccount()

        // Still signed in, still holding the token: the account is there.
        XCTAssertEqual(controller.state, .signedIn)
        XCTAssertNotNil(tokenStore.stored)
        XCTAssertEqual(controller.accountDeletion.failureMessage, "Internal server error")
        XCTAssertEqual(deletedUserIds, [], "nothing was deleted, so nothing is discarded locally")

        controller.clearAccountDeletionFailure()
        XCTAssertEqual(controller.accountDeletion, .idle)
    }

    func testARejectedSessionDuringDeletionIsNotReportedTwice() async {
        // APIClient has already run handleSessionRejected by the time this
        // error arrives; adding "your account was not deleted" on top would
        // be two contradictory sentences about one event.
        api.deleteAccountHandler = { _ in throw APIError.sessionRejected }
        let controller = signedInController(as: UUID())

        await controller.deleteAccount()

        XCTAssertEqual(controller.accountDeletion, .idle)
        XCTAssertNil(controller.accountDeletion.failureMessage)
    }

    func testDeleteAccountDoesNothingWhenSignedOut() async {
        let controller = makeController()
        XCTAssertEqual(controller.state, .signedOut)

        await controller.deleteAccount()

        XCTAssertEqual(reauthorization.callCount, 0)
        XCTAssertEqual(api.deleteAccountCalls.count, 0)
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
