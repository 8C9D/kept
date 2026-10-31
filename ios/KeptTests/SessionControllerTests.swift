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
    private var defaultsSuite = ""
    private var defaults = UserDefaults.standard

    override func setUp() async throws {
        try await super.setUp()
        api = StubKeptAPI()
        tokenStore = InMemoryTokenStore()
        reauthorization = StubAppleReauthorization()
        defaultsSuite = "SessionControllerTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: defaultsSuite) ?? .standard
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: defaultsSuite)
        try await super.tearDown()
    }

    private func makeController() -> SessionController {
        SessionController(
            api: api,
            tokenStore: tokenStore,
            reauthorization: reauthorization,
            eventLogger: EventLogger(api: api),
            defaults: defaults
        )
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

    /// iOS can start the process before the phone is unlocked, and the
    /// token is `WhenUnlocked`. `init` was the only read there was, so a
    /// valid session showed sign-in for the rest of the run.
    func testAnUnreadableLaunchRecoversWhenTheSceneComesActive() {
        tokenStore.stored = "stored-session-token"
        tokenStore.loadError = KeychainError(operation: "read", status: -25308)
        let controller = makeController()
        XCTAssertEqual(controller.state, .signedOut)
        var signedInCalls = 0
        controller.onSignedIn = { signedInCalls += 1 }

        // Still locked: nothing changes, and the reason stays stated.
        controller.retrySavedSessionIfUnread()
        XCTAssertEqual(controller.state, .signedOut)
        XCTAssertNotNil(controller.signInMessage)
        XCTAssertEqual(signedInCalls, 0)

        tokenStore.loadError = nil
        controller.retrySavedSessionIfUnread()

        XCTAssertEqual(controller.state, .signedIn)
        XCTAssertNil(controller.signInMessage)
        XCTAssertEqual(signedInCalls, 1, "the queue has to hear about it")
    }

    /// Unlocked, and there was simply no session: the error stops being
    /// true, so it stops being said.
    func testAnUnreadableLaunchWithNoTokenSettlesAsSignedOut() {
        tokenStore.loadError = KeychainError(operation: "read", status: -25308)
        let controller = makeController()

        tokenStore.loadError = nil
        controller.retrySavedSessionIfUnread()

        XCTAssertEqual(controller.state, .signedOut)
        XCTAssertNil(controller.signInMessage)
    }

    /// Scoped to that one failure: a person who signed out stays signed out
    /// however many times the scene comes active.
    func testAnOrdinarySignedOutStateIsNotReRead() {
        let controller = makeController()
        tokenStore.stored = "appeared-from-nowhere"

        controller.retrySavedSessionIfUnread()

        XCTAssertEqual(controller.state, .signedOut)
    }

    // MARK: - Signing in

    /// Contract item 4: the server could not reach Apple. Nothing here is
    /// the person's to fix, and the message says so.
    func testAppleBeingUnavailableIsStatedAtSignIn() async {
        api.signInHandler = { _, _ in
            throw APIError.requestFailed(code: "apple_unavailable", message: "upstream", status: 503)
        }
        let controller = makeController()

        await controller.signIn(identityToken: "apple-identity-token", displayName: nil)

        XCTAssertEqual(controller.state, .signedOut)
        XCTAssertEqual(
            controller.signInMessage,
            "Sign in with Apple isn't reachable right now. Try again in a few minutes."
        )
    }

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

        // A second controller rather than a second call: since 2026-10-31 a
        // rejection only acts on a live session (see
        // testALateRejectionDoesNotRefireOnSignedOut).
        tokenStore.stored = "another-token"
        let rejected = makeController()
        rejected.onSignedOut = { signedOutCalls += 1 }
        rejected.handleSessionRejected()
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

    /// A straggler arriving at the sign-in screen has nothing left to end,
    /// and it used to replace that screen's message.
    func testALateRejectionLeavesTheSignInScreenAlone() async {
        api.deleteAccountHandler = { _ in }
        let controller = signedInController(as: UUID())
        await controller.deleteAccount()
        XCTAssertEqual(controller.signInMessage, "Your account and all its receipts have been deleted.")

        controller.handleSessionRejected()

        XCTAssertEqual(controller.signInMessage, "Your account and all its receipts have been deleted.")
    }

    func testALateRejectionDoesNotRefireOnSignedOut() {
        tokenStore.stored = "a-token"
        let controller = makeController()
        controller.signOut()
        var signedOutCalls = 0
        controller.onSignedOut = { signedOutCalls += 1 }

        controller.handleSessionRejected()

        XCTAssertEqual(signedOutCalls, 0)
    }

    // MARK: - Capture holds a rejection back

    /// Signing out replaces Home, which takes the capture cover and the only
    /// copy of the scan with it. The token stays on file while it waits:
    /// the outbox reads who owns the capture from it.
    func testARejectionDuringCaptureWaitsUntilCaptureEnds() {
        tokenStore.stored = "expired-session-token"
        let controller = makeController()
        var signedOutCalls = 0
        controller.onSignedOut = { signedOutCalls += 1 }

        controller.beginHold()
        controller.handleSessionRejected()

        XCTAssertEqual(controller.state, .signedIn, "the cover stays up")
        XCTAssertEqual(tokenStore.stored, "expired-session-token", "and Save can still say whose receipt it is")
        XCTAssertEqual(signedOutCalls, 0)

        controller.endHold()

        XCTAssertEqual(controller.state, .signedOut)
        XCTAssertNil(tokenStore.stored)
        XCTAssertEqual(controller.signInMessage, "Your session has expired. Sign in again.")
        XCTAssertEqual(signedOutCalls, 1)
    }

    func testACaptureWithNoRejectionEndsWithNothingToDo() {
        tokenStore.stored = "a-token"
        let controller = makeController()

        controller.beginHold()
        controller.endHold()

        XCTAssertEqual(controller.state, .signedIn)
    }

    /// Several 401s while the cover is up are one sign-out when it goes.
    func testRepeatedRejectionsDuringCaptureLandOnce() {
        tokenStore.stored = "a-token"
        let controller = makeController()
        var signedOutCalls = 0
        controller.onSignedOut = { signedOutCalls += 1 }

        controller.beginHold()
        controller.handleSessionRejected()
        controller.handleSessionRejected()
        controller.endHold()
        controller.endHold()

        XCTAssertEqual(signedOutCalls, 1)
    }

    /// The hold is about the capture, and nothing after it: a later session
    /// dies the ordinary way.
    func testARejectionAfterCaptureEndsSignsOutAtOnce() {
        tokenStore.stored = "a-token"
        let controller = makeController()

        controller.beginHold()
        controller.endHold()
        controller.handleSessionRejected()

        XCTAssertEqual(controller.state, .signedOut)
    }

    /// They nest: the detail screen's confirm form can open from inside the
    /// queue's, and the rejection has to outlast the outermost.
    func testARejectionWaitsForTheLastHold() {
        tokenStore.stored = "a-token"
        let controller = makeController()

        controller.beginHold()
        controller.beginHold()
        controller.handleSessionRejected()
        XCTAssertTrue(controller.rejectionIsHeld)

        controller.endHold()
        XCTAssertEqual(controller.state, .signedIn, "one screen is still up")

        controller.endHold()
        XCTAssertEqual(controller.state, .signedOut)
        XCTAssertFalse(controller.rejectionIsHeld)
    }

    // MARK: - Renewing a held session

    /// A signed-in controller holding a rejection for `userId`.
    private func heldController(as userId: UUID) -> SessionController {
        let controller = signedInController(as: userId)
        controller.beginHold()
        controller.handleSessionRejected()
        return controller
    }

    private func renewalResponse(for userId: UUID, token: String = "renewed-token") -> SignInResponse {
        SignInResponse(token: token, user: SessionUser(id: userId, displayName: nil, email: nil))
    }

    /// The screen stays up throughout, which is the whole point: `state`
    /// never moves, because `.signingIn` is what makes RootView replace Home.
    func testRenewalReplacesTheTokenWithoutLeavingTheScreen() async {
        let userId = UUID()
        let controller = heldController(as: userId)
        var states: [SessionController.State] = []
        let watcher = controller.$state.sink { states.append($0) }
        defer { watcher.cancel() }
        var signedInCalls = 0
        controller.onSignedIn = { signedInCalls += 1 }
        api.signInHandler = { [self] _, _ in renewalResponse(for: userId) }

        await controller.renewHeldSession(identityToken: "apple-identity-token", displayName: nil)

        XCTAssertEqual(states, [.signedIn], "the session never left .signedIn")
        XCTAssertEqual(tokenStore.stored, "renewed-token")
        XCTAssertFalse(controller.rejectionIsHeld)
        XCTAssertEqual(signedInCalls, 1, "the outbox waits on this too")

        // Nothing is left to land when the screen goes.
        controller.endHold()
        XCTAssertEqual(controller.state, .signedIn)
    }

    /// The screen on show is one person's receipt (constraint 3). A second
    /// Apple ID must not end up signed in underneath it.
    func testRenewalByADifferentPersonIsRefusedAndChangesNothing() async {
        let controller = heldController(as: UUID())
        let heldToken = tokenStore.stored
        api.signInHandler = { [self] _, _ in renewalResponse(for: UUID()) }

        await controller.renewHeldSession(identityToken: "apple-identity-token", displayName: nil)

        XCTAssertEqual(tokenStore.stored, heldToken, "their token is never saved")
        XCTAssertTrue(controller.rejectionIsHeld)
        XCTAssertEqual(controller.sessionRenewalMessage, "That Apple ID isn't the account this receipt belongs to.")

        // Leaving lands the rejection and the ordinary sign-in takes over.
        controller.endHold()
        XCTAssertEqual(controller.state, .signedOut)
        XCTAssertNil(controller.sessionRenewalMessage)
    }

    func testAFailedRenewalKeepsTheHoldAndSaysWhy() async {
        let controller = heldController(as: UUID())
        api.signInHandler = { _, _ in
            throw APIError.requestFailed(code: "apple_unavailable", message: "upstream", status: 503)
        }

        await controller.renewHeldSession(identityToken: "apple-identity-token", displayName: nil)

        XCTAssertTrue(controller.rejectionIsHeld, "the form is still up, and can try again")
        XCTAssertEqual(
            controller.sessionRenewalMessage,
            "Sign in with Apple isn't reachable right now. Try again in a few minutes."
        )
        XCTAssertFalse(controller.isRenewingSession)
    }

    func testNothingToRenewIsANoOp() async {
        let controller = signedInController(as: UUID())
        var calls = 0
        api.signInHandler = { _, _ in
            calls += 1
            return Fixtures.signInResponse()
        }

        await controller.renewHeldSession(identityToken: "apple-identity-token", displayName: nil)

        XCTAssertEqual(calls, 0)
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
        // A 4xx since 2026-10-31: this test used a 500, which is no longer a
        // refusal anybody can vouch for (see the next test).
        api.deleteAccountHandler = { _ in
            throw APIError.requestFailed(
                code: "invalid_request",
                message: "The request was refused",
                status: 400
            )
        }
        let controller = signedInController(as: UUID())
        var deletedUserIds: [UUID] = []
        controller.onAccountDeleted = { deletedUserIds.append($0) }

        await controller.deleteAccount()

        // Still signed in, still holding the token: the account is there.
        XCTAssertEqual(controller.state, .signedIn)
        XCTAssertNotNil(tokenStore.stored)
        XCTAssertEqual(controller.accountDeletion.failureMessage, "The request was refused")
        XCTAssertEqual(controller.accountDeletion.alertTitle, "Your account was not deleted")
        XCTAssertEqual(deletedUserIds, [], "nothing was deleted, so nothing is discarded locally")

        controller.clearAccountDeletionFailure()
        XCTAssertEqual(controller.accountDeletion, .idle)
    }

    // MARK: A deletion whose answer never arrived

    /// The account may be gone, and nothing can tell yet: the 401 a deleted
    /// account gets is the 401 an expired token gets. The next sign-in can,
    /// because a new id means the old user row is gone.
    func testALostDeletionResponseIsSettledByANewIdentityAtSignIn() async {
        let deletedUserId = UUID()
        api.deleteAccountHandler = { _ in throw APIError.network(URLError(.networkConnectionLost)) }
        let controller = signedInController(as: deletedUserId)
        var deletedUserIds: [UUID] = []
        controller.onAccountDeleted = { deletedUserIds.append($0) }

        await controller.deleteAccount()
        XCTAssertEqual(deletedUserIds, [], "not yet: this may be a dropped connection and nothing more")
        XCTAssertNotNil(controller.accountDeletion.failureMessage)

        // The next request's 401, then a sign-in under a NEW user row.
        controller.handleSessionRejected()
        api.signInHandler = { _, _ in Fixtures.signInResponse() }
        await controller.signIn(identityToken: "apple-identity-token", displayName: nil)

        XCTAssertEqual(deletedUserIds, [deletedUserId])
    }

    /// The same id means the account survived, and its receipts are safe.
    func testALostDeletionResponseThatChangedNothingDiscardsNothing() async {
        let userId = UUID()
        api.deleteAccountHandler = { _ in throw APIError.network(URLError(.timedOut)) }
        let controller = signedInController(as: userId)
        var deletedUserIds: [UUID] = []
        controller.onAccountDeleted = { deletedUserIds.append($0) }

        await controller.deleteAccount()
        controller.handleSessionRejected()
        api.signInHandler = { _, _ in
            SignInResponse(token: "t", user: SessionUser(id: userId, displayName: nil, email: nil))
        }
        await controller.signIn(identityToken: "apple-identity-token", displayName: nil)

        XCTAssertEqual(deletedUserIds, [])
    }

    /// It outlives the launch that lost the response.
    func testALostDeletionResponseSurvivesARelaunch() async {
        let deletedUserId = UUID()
        api.deleteAccountHandler = { _ in throw APIError.network(URLError(.timedOut)) }
        let first = signedInController(as: deletedUserId)
        await first.deleteAccount()

        tokenStore.stored = nil
        let relaunched = makeController()
        var deletedUserIds: [UUID] = []
        relaunched.onAccountDeleted = { deletedUserIds.append($0) }
        api.signInHandler = { _, _ in Fixtures.signInResponse() }
        await relaunched.signIn(identityToken: "apple-identity-token", displayName: nil)

        XCTAssertEqual(deletedUserIds, [deletedUserId])
    }

    /// A refusal is an answer, so there is nothing to settle later.
    func testARefusedDeletionLeavesNothingToSettle() async {
        api.deleteAccountHandler = { _ in
            throw APIError.requestFailed(code: "invalid_request", message: "no", status: 400)
        }
        let controller = signedInController(as: UUID())
        var deletedUserIds: [UUID] = []
        controller.onAccountDeleted = { deletedUserIds.append($0) }

        await controller.deleteAccount()
        controller.handleSessionRejected()
        api.signInHandler = { _, _ in Fixtures.signInResponse() }
        await controller.signIn(identityToken: "apple-identity-token", displayName: nil)

        XCTAssertEqual(deletedUserIds, [])
    }

    /// Retried and answered: the record of doubt goes with the success.
    func testARetriedDeletionThatLandsClearsTheRecord() async {
        let deletedUserId = UUID()
        var attempts = 0
        api.deleteAccountHandler = { _ in
            attempts += 1
            if attempts == 1 { throw APIError.network(URLError(.timedOut)) }
        }
        let controller = signedInController(as: deletedUserId)
        var deletedUserIds: [UUID] = []
        controller.onAccountDeleted = { deletedUserIds.append($0) }

        await controller.deleteAccount()
        await controller.deleteAccount()
        XCTAssertEqual(deletedUserIds, [deletedUserId])

        api.signInHandler = { _, _ in Fixtures.signInResponse() }
        await controller.signIn(identityToken: "apple-identity-token", displayName: nil)

        XCTAssertEqual(deletedUserIds, [deletedUserId], "once, and not again at the next sign-in")
    }

    /// A lost response leaves "not deleted" unproven, and that sentence is
    /// the one a person acts on. Only a refusal may say it.
    func testAnUnknownDeletionOutcomeSaysItIsUnknown() async {
        for failure in [
            APIError.network(URLError(.networkConnectionLost)),
            APIError.requestFailed(code: "internal_error", message: "Internal server error", status: 500),
            APIError.unexpectedResponse(status: 502),
        ] {
            api.deleteAccountHandler = { _ in throw failure }
            let controller = signedInController(as: UUID())

            await controller.deleteAccount()

            XCTAssertEqual(controller.accountDeletion.alertTitle, "We couldn't confirm your account was deleted")
            let message = controller.accountDeletion.failureMessage
            XCTAssertTrue(message?.contains("may or may not have gone through") == true, String(describing: message))
            XCTAssertEqual(controller.state, .signedIn, "nothing here proves the session is over")

            controller.clearAccountDeletionFailure()
            XCTAssertEqual(controller.accountDeletion, .idle)
        }
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
