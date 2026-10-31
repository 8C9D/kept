import AuthenticationServices
import Foundation

/// Owns the answer to "who, if anyone, is signed in". Views render its
/// state; the decisions - what a credential means, when a session dies -
/// are made here (spec §4 of the wave-3 kickoff: views render, something
/// else decides).
@MainActor
final class SessionController: ObservableObject {
    /// One value that cannot contradict itself, instead of is-signed-in /
    /// is-busy booleans that can.
    enum State: Equatable {
        case signedOut
        case signingIn
        case signedIn
    }

    /// Where an account deletion is, as one value rather than a pair of
    /// booleans - same reasoning as State above. Deliberately NOT a fourth
    /// case of State: "who is signed in" and "is a destructive request in
    /// flight" are different questions, and folding them would make every
    /// switch on State answer both.
    enum AccountDeletion: Equatable {
        case idle
        case inProgress
        /// The deletion did not happen, and this says why. The person is
        /// still signed in with everything intact.
        case failed(String)
        /// The request went out and no clear answer came back, so nobody
        /// can say whether it happened (2026-10-31). Never `failed`: "your
        /// account was not deleted" would be a claim about an account that
        /// may be gone, and it is the claim a person acts on.
        case unconfirmed(String)

        /// The reason, when there is one - the shape a SwiftUI alert binding
        /// needs, so the view does not pattern-match the enum inline.
        var failureMessage: String? {
            switch self {
            case .failed(let message), .unconfirmed(let message):
                return message
            case .idle, .inProgress:
                return nil
            }
        }

        /// The alert's title, which is where the two outcomes differ.
        var alertTitle: String {
            if case .unconfirmed = self {
                return "We couldn't confirm your account was deleted"
            }
            return "Your account was not deleted"
        }
    }

    @Published private(set) var state: State
    /// Why the user is looking at the sign-in screen, when there is a
    /// reason worth stating: a failed sign-in, an expired session. Cleared
    /// when a new attempt starts.
    @Published private(set) var signInMessage: String?
    @Published private(set) var accountDeletion: AccountDeletion = .idle
    /// The session has been refused and a screen is holding that back
    /// (`beginHold`). What makes `SessionRenewalView` appear.
    @Published private(set) var rejectionIsHeld = false
    /// A renewal is on its way to the server.
    @Published private(set) var isRenewingSession = false
    /// Why the last renewal did not take, when it did not.
    @Published private(set) var sessionRenewalMessage: String?

    /// Fired after a sign-in completes. Wired by the composition root to
    /// wake the outbox: receipts queued when a session expired resume
    /// uploading the moment their owner is back (wave-5 kickoff §3).
    var onSignedIn: (() -> Void)?

    /// Fired after any transition to signed-out. The outbox drops its
    /// scheduled retries (pointless until someone signs in) and stops
    /// displaying the departed user's queue.
    var onSignedOut: (() -> Void)?

    /// Fired after the server has destroyed an account, with the id of the
    /// user it destroyed, BEFORE the sign-out that follows. The outbox
    /// discards that user's queued receipts: "delete everything" has to mean
    /// the images still on this phone too, and an item tagged with a user id
    /// that no longer exists could never upload - it would sit in the queue
    /// forever, labelled as another account's.
    var onAccountDeleted: ((UUID) -> Void)?

    private let api: any KeptAPI
    private let tokenStore: SessionTokenStore
    private let reauthorization: any AppleReauthorizing
    private let eventLogger: EventLogger
    /// Where an account deletion whose answer never arrived is remembered
    /// (`unconfirmedDeletionKey`). A user id and nothing else - no secret,
    /// and it has to outlive the launch that lost the response.
    private let defaults: UserDefaults

    /// How many screens are holding the session (`beginHold`). A count, not
    /// a flag, because they nest: a detail screen's confirm form opened from
    /// inside the queue's.
    private var holdCount = 0
    /// The launch's keychain read failed - which means "unknown", not
    /// "signed out" (`retrySavedSessionIfUnread`).
    private var savedSessionUnread = false

    private static let unconfirmedDeletionKey = "unconfirmedAccountDeletionUserId"

    init(
        api: any KeptAPI,
        tokenStore: SessionTokenStore,
        reauthorization: any AppleReauthorizing,
        eventLogger: EventLogger,
        defaults: UserDefaults = .standard
    ) {
        self.api = api
        self.tokenStore = tokenStore
        self.reauthorization = reauthorization
        self.eventLogger = eventLogger
        self.defaults = defaults
        // Cold launch: a stored token is a live session until the server
        // says otherwise - the first 401 will land in handleSessionRejected.
        do {
            state = try tokenStore.load() == nil ? .signedOut : .signedIn
            signInMessage = nil
        } catch {
            state = .signedOut
            savedSessionUnread = true
            signInMessage = "The saved session could not be read. \(error.localizedDescription)"
        }
    }

    /// Reads the keychain again after a launch that could not (2026-10-31).
    /// Wired to the scene going active.
    ///
    /// The token is `WhenUnlocked`, and iOS can start this process before
    /// the phone has been unlocked - prewarming, most often. That read
    /// throws, and `init` was the only read there is, so a valid session
    /// showed the sign-in screen for the rest of the run. Scoped to that
    /// one failure: an ordinary signed-out state has nothing to re-read.
    /// Still refused means still locked, and the message already says so.
    func retrySavedSessionIfUnread() {
        guard savedSessionUnread, state == .signedOut else { return }
        do {
            let token = try tokenStore.load()
            savedSessionUnread = false
            signInMessage = nil
            if token != nil {
                state = .signedIn
                onSignedIn?()
            }
        } catch {
            signInMessage = "The saved session could not be read. \(error.localizedDescription)"
        }
    }

    // MARK: - Signing in

    /// What came back from Apple's sheet, read once for both ways of
    /// signing in.
    private enum AppleSignInOutcome {
        case cancelled
        case failed(String)
        case identity(token: String, displayName: String?)
    }

    private static func outcome(of result: Result<ASAuthorization, Error>) -> AppleSignInOutcome {
        switch result {
        case .failure(let error):
            // Tapping Cancel on Apple's sheet is a decision, not a failure;
            // showing an error for it would scold the user for choosing.
            if let authError = error as? ASAuthorizationError, authError.code == .canceled {
                return .cancelled
            }
            return .failed("Sign in with Apple failed: \(error.localizedDescription)")
        case .success(let authorization):
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                  let tokenData = credential.identityToken,
                  let identityToken = String(data: tokenData, encoding: .utf8) else {
                return .failed("Apple returned a credential this app cannot use.")
            }
            return .identity(token: identityToken, displayName: displayName(from: credential.fullName))
        }
    }

    /// Completion handler for SwiftUI's SignInWithAppleButton.
    func handleSignInWithApple(_ result: Result<ASAuthorization, Error>) async {
        switch Self.outcome(of: result) {
        case .cancelled:
            return
        case .failed(let message):
            signInMessage = message
        case .identity(let token, let displayName):
            await signIn(identityToken: token, displayName: displayName)
        }
    }

    /// Exchanges the Apple identity token for a session. Separated from the
    /// ASAuthorization plumbing above so the whole outcome path - including
    /// the server rejecting the token - is unit-testable.
    func signIn(identityToken: String, displayName: String?) async {
        state = .signingIn
        signInMessage = nil
        do {
            let response = try await api.signInWithApple(
                identityToken: identityToken,
                displayName: displayName
            )
            try tokenStore.save(response.token)
            state = .signedIn
            // Logged with a session already saved, so the batch this
            // lands in has a real token to post with - the mirror-image
            // race signOut() below accepts losing.
            eventLogger.log(.signIn)
            settleUnconfirmedDeletion(signedInAs: response.user.id)
            onSignedIn?()
        } catch {
            // A rejected identity token lands here as a plain request
            // failure and returns cleanly to signed-out - never a hang in
            // .signingIn.
            state = .signedOut
            signInMessage = Self.signInFailureMessage(error)
        }
    }

    /// 503 `apple_unavailable`: the server could not reach Apple to check
    /// the token. Worded here rather than passed through because it is the
    /// one sign-in failure with nothing for the person to fix - the wording
    /// to get right is "this is not you, and try again".
    private static func signInFailureMessage(_ error: Error) -> String {
        if case APIError.requestFailed(let code, _, _) = error, code == "apple_unavailable" {
            return "Sign in with Apple isn't reachable right now. Try again in a few minutes."
        }
        return error.localizedDescription
    }

    /// Apple provides the name once, at first authorization, and possibly
    /// never; an empty formatting result must become nil, not "" - the
    /// server rejects an empty displayName, and rightly so.
    static func displayName(from components: PersonNameComponents?) -> String? {
        guard let components else { return nil }
        let formatted = PersonNameComponentsFormatter.localizedString(from: components, style: .default)
        return formatted.isEmpty ? nil : formatted
    }

    // MARK: - Signing out

    /// Called by APIClient when the server rejects the session token -
    /// expired, or revoked by a token_version bump. The keychain is
    /// cleared and the app returns to signed-out with the reason stated.
    ///
    /// Only a live session can be rejected (2026-10-31). A straggler
    /// arriving once the person is already at the sign-in screen, or part
    /// way through signing in, has nothing left to end - and running this
    /// anyway replaced whatever that screen was saying ("Your account and
    /// all its receipts have been deleted.") with "session expired".
    func handleSessionRejected() {
        guard state == .signedIn else { return }
        // A screen is up holding work that exists nowhere else. See
        // `beginHold`.
        guard holdCount == 0 else {
            rejectionIsHeld = true
            return
        }
        transitionToSignedOut(message: "Your session has expired. Sign in again.")
    }

    // MARK: - Holding the session (2026-10-31)

    /// A screen holding unsaved work is going up: hold any session rejection
    /// until it has gone. Used through `.holdsSession()`, by the capture
    /// flow, the confirm queue, the confirm form wherever else it opens, and
    /// the Add a page scan.
    ///
    /// Signing out replaces Home, which takes every cover with it, and with
    /// them the only copy of a scan or of what was typed. Making the two
    /// best-effort calls quiet (`SessionFailureHandling`) does not close
    /// that, because a queued receipt draining behind the cover or the list
    /// reloading under it answers 401 just the same, and the 30-day token
    /// has no refresh, so this WILL happen with work on screen.
    ///
    /// The token stays on file while the rejection waits, and that is the
    /// point, twice over. The outbox reads who owns a capture from it, so
    /// clearing it is what would make a capture's Save fail with "you are
    /// signed out". And `renewHeldSession` needs it to prove the person
    /// signing back in is the one whose work is on screen. Nothing else can
    /// use the old token meanwhile: the cover covers everything that could
    /// sign out or switch accounts.
    ///
    /// ⚠ A hold is enough on its own only for a capture, whose Save is a
    /// disk write the sign-in afterwards simply wakes the queue for. A
    /// confirm form and Add a page write over the network, so holding them
    /// up without a way to finish would only turn a lost form into one that
    /// can never save. `renewHeldSession` is that way.
    func beginHold() {
        holdCount += 1
    }

    /// A holding screen has gone, every way out of it included. When it was
    /// the last, a rejection that waited lands now, on Home, where there is
    /// nothing left to lose.
    func endHold() {
        holdCount = max(0, holdCount - 1)
        guard holdCount == 0, rejectionIsHeld else { return }
        rejectionIsHeld = false
        sessionRenewalMessage = nil
        handleSessionRejected()
    }

    /// Completion handler for the sign-in button on a held screen.
    func renewHeldSession(_ result: Result<ASAuthorization, Error>) async {
        switch Self.outcome(of: result) {
        case .cancelled:
            return
        case .failed(let message):
            sessionRenewalMessage = message
        case .identity(let token, let displayName):
            await renewHeldSession(identityToken: token, displayName: displayName)
        }
    }

    /// Exchanges an Apple token for a new session without leaving the
    /// screen. Everything `signIn` does except touch `state`: `.signingIn`
    /// is what makes RootView replace Home, which is the very teardown the
    /// hold exists to prevent.
    ///
    /// Refused for anyone but the account the work belongs to (constraint
    /// 3). The screen on show is one person's receipt, and it stays up
    /// across this, so a different Apple ID must not end up signed in
    /// underneath it. The old token is still on file to compare against -
    /// which is why the hold keeps it. The refusal leaves the rejection
    /// held: leaving the screen lands it, and the ordinary sign-in is there.
    func renewHeldSession(identityToken: String, displayName: String?) async {
        guard rejectionIsHeld, !isRenewingSession else { return }
        isRenewingSession = true
        sessionRenewalMessage = nil
        defer { isRenewingSession = false }

        do {
            let response = try await api.signInWithApple(
                identityToken: identityToken,
                displayName: displayName
            )
            guard response.user.id == currentUserId() else {
                sessionRenewalMessage = "That Apple ID isn't the account this receipt belongs to."
                return
            }
            try tokenStore.save(response.token)
            rejectionIsHeld = false
            eventLogger.log(.signIn)
            settleUnconfirmedDeletion(signedInAs: response.user.id)
            onSignedIn?()
        } catch {
            sessionRenewalMessage = Self.signInFailureMessage(error)
        }
    }

    /// User-initiated sign-out from the Home menu. `sign_out` is logged
    /// only here, not from `handleSessionRejected()` or account deletion's
    /// own sign-out - an expired session and a destroyed account are not
    /// what the vocabulary means by a person choosing to sign out.
    ///
    /// ⚠ A real, accepted race: the event is queued before the token is
    /// cleared below so it has its best chance of posting with a still-
    /// valid session, but EventLogger's queue flushes on its own triggers
    /// (a size threshold, backgrounding, connectivity return) - not
    /// synchronously with this call - so it can still lose the race and
    /// go out (or attempt to) after the token is gone. Losing this one
    /// event to that race is the accepted outcome (spec: "losing
    /// telemetry is always the acceptable failure"), not a bug to chase.
    func signOut() {
        eventLogger.log(.signOut)
        transitionToSignedOut(message: nil)
    }

    // MARK: - Deleting the account

    /// Destroys the account and every receipt in it, after Home's
    /// confirmation dialog has said so in those words. App Store Guideline
    /// 5.1.1(v) requires this to exist inside the app; the sequence is:
    ///
    ///   1. Re-authorize with Apple, for a fresh single-use code the server
    ///      exchanges to revoke this person's Apple tokens. Dismissing that
    ///      sheet CANCELS the deletion - it is the last point at which the
    ///      person can still change their mind, and honouring it costs
    ///      nothing.
    ///   2. DELETE /api/me. The server destroys the rows and the images.
    ///   3. Sign out locally, and tell the outbox to discard this user's
    ///      queued receipts.
    ///
    /// A re-authorization that fails for any OTHER reason does not stop the
    /// deletion: the request goes without a code and the server records that
    /// the tokens were not revoked. Apple's own guidance is to fulfil the
    /// deletion regardless, and a person who cannot delete their account
    /// because Apple's sheet errored is exactly what the guideline forbids.
    func deleteAccount() async {
        guard state == .signedIn, accountDeletion != .inProgress else { return }
        accountDeletion = .inProgress

        // Read while the token is still there: after the sign-out below
        // there is nothing left to read the id from, and the outbox needs it
        // to know whose queued receipts to discard.
        let deletedUserId = currentUserId()

        let code: String?
        do {
            code = try await reauthorization.authorizationCode()
        } catch AppleReauthorizationError.cancelled {
            accountDeletion = .idle
            return
        } catch {
            // Not swallowed signal, and not dropped: the deletion goes ahead
            // without a code, and the SERVER records - at error level, on the
            // machine where it can be read - that the tokens were not
            // revoked. Stopping here instead would leave a person unable to
            // delete their account because Apple's sheet misbehaved.
            code = nil
        }

        do {
            try await api.deleteAccount(appleAuthorizationCode: code)
        } catch APIError.sessionRejected {
            // The client has already cleared the session and returned to
            // signed-out through handleSessionRejected; saying "deletion
            // failed" on top of "your session expired" would be two
            // contradictory sentences about one event.
            accountDeletion = .idle
            return
        } catch let error as APIError where error.outcomeIsUnknown {
            if let deletedUserId {
                defaults.set(deletedUserId.uuidString, forKey: Self.unconfirmedDeletionKey)
            }
            accountDeletion = .unconfirmed(
                "No clear answer came back, so it may or may not have gone through. Check your connection and try again. (\(error.localizedDescription))"
            )
            return
        } catch {
            accountDeletion = .failed(error.localizedDescription)
            return
        }

        accountDeletion = .idle
        defaults.removeObject(forKey: Self.unconfirmedDeletionKey)
        if let deletedUserId {
            onAccountDeleted?(deletedUserId)
        }
        transitionToSignedOut(message: "Your account and all its receipts have been deleted.")
    }

    /// Finds out what a lost DELETE /api/me actually did (2026-10-31).
    ///
    /// When the response never arrives the account may well be gone, and
    /// the discard that follows a success never ran - so the queued images
    /// stayed on the phone, labelled as receipts that "will upload when that
    /// account signs in", which no sign-in can ever do. Nothing on the way
    /// to the next sign-in can tell the two apart: the 401 a deleted account
    /// gets is the 401 an expired token gets.
    ///
    /// The sign-in can. Apple's identity maps to one user row, and that row
    /// is new only if the old one is gone, so a different id here means the
    /// deletion happened and its queue goes now. The same id means it never
    /// did and the receipts are safe. A second person signing in on this
    /// phone would also read as gone - and those receipts belong to someone
    /// who asked for them to be deleted.
    private func settleUnconfirmedDeletion(signedInAs userId: UUID) {
        guard let recorded = defaults.string(forKey: Self.unconfirmedDeletionKey) else { return }
        defaults.removeObject(forKey: Self.unconfirmedDeletionKey)
        if let deletedUserId = UUID(uuidString: recorded), deletedUserId != userId {
            onAccountDeleted?(deletedUserId)
        }
    }

    /// Dismisses the failure notice.
    func clearAccountDeletionFailure() {
        if accountDeletion.failureMessage != nil {
            accountDeletion = .idle
        }
    }

    /// Who the stored session says is signed in, or nil if there is no
    /// readable token. A keychain read that fails is not worth surfacing
    /// here: the request that follows will fail on its own and say so.
    private func currentUserId() -> UUID? {
        // `try?` flattens here: an unreadable keychain and an absent token
        // both arrive as nil, which is the same answer for this purpose.
        guard let token = try? tokenStore.load() else { return nil }
        return SessionTokenClaims.userId(inToken: token)
    }

    private func transitionToSignedOut(message: String?) {
        var failureNote: String?
        do {
            try tokenStore.clear()
        } catch {
            // Signing out in memory still happens, but a token that could
            // not be removed will resurrect the session on next launch -
            // say so instead of pretending it is gone.
            failureNote = "The saved session could not be removed. \(error.localizedDescription)"
        }
        state = .signedOut
        signInMessage = failureNote ?? message
        rejectionIsHeld = false
        sessionRenewalMessage = nil
        onSignedOut?()
    }
}
