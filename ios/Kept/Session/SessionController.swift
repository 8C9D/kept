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

        /// The reason, when there is one - the shape a SwiftUI alert binding
        /// needs, so the view does not pattern-match the enum inline.
        var failureMessage: String? {
            if case .failed(let message) = self { return message }
            return nil
        }
    }

    @Published private(set) var state: State
    /// Why the user is looking at the sign-in screen, when there is a
    /// reason worth stating: a failed sign-in, an expired session. Cleared
    /// when a new attempt starts.
    @Published private(set) var signInMessage: String?
    @Published private(set) var accountDeletion: AccountDeletion = .idle

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

    init(
        api: any KeptAPI,
        tokenStore: SessionTokenStore,
        reauthorization: any AppleReauthorizing
    ) {
        self.api = api
        self.tokenStore = tokenStore
        self.reauthorization = reauthorization
        // Cold launch: a stored token is a live session until the server
        // says otherwise - the first 401 will land in handleSessionRejected.
        do {
            state = try tokenStore.load() == nil ? .signedOut : .signedIn
            signInMessage = nil
        } catch {
            state = .signedOut
            signInMessage = "The saved session could not be read. \(error.localizedDescription)"
        }
    }

    // MARK: - Signing in

    /// Completion handler for SwiftUI's SignInWithAppleButton.
    func handleSignInWithApple(_ result: Result<ASAuthorization, Error>) async {
        switch result {
        case .failure(let error):
            // Tapping Cancel on Apple's sheet is a decision, not a failure;
            // showing an error for it would scold the user for choosing.
            if let authError = error as? ASAuthorizationError, authError.code == .canceled {
                return
            }
            signInMessage = "Sign in with Apple failed: \(error.localizedDescription)"
        case .success(let authorization):
            guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
                  let tokenData = credential.identityToken,
                  let identityToken = String(data: tokenData, encoding: .utf8) else {
                signInMessage = "Apple returned a credential this app cannot use."
                return
            }
            await signIn(
                identityToken: identityToken,
                displayName: Self.displayName(from: credential.fullName)
            )
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
            onSignedIn?()
        } catch {
            // A rejected identity token lands here as a plain request
            // failure and returns cleanly to signed-out - never a hang in
            // .signingIn.
            state = .signedOut
            signInMessage = error.localizedDescription
        }
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
    func handleSessionRejected() {
        transitionToSignedOut(message: "Your session has expired. Sign in again.")
    }

    /// User-initiated sign-out from the Home menu.
    func signOut() {
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
        } catch {
            accountDeletion = .failed(error.localizedDescription)
            return
        }

        accountDeletion = .idle
        if let deletedUserId {
            onAccountDeleted?(deletedUserId)
        }
        transitionToSignedOut(message: "Your account and all its receipts have been deleted.")
    }

    /// Dismisses the failure notice; the account is untouched either way.
    func clearAccountDeletionFailure() {
        if case .failed = accountDeletion {
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
        onSignedOut?()
    }
}
