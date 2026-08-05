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

    @Published private(set) var state: State
    /// Why the user is looking at the sign-in screen, when there is a
    /// reason worth stating: a failed sign-in, an expired session. Cleared
    /// when a new attempt starts.
    @Published private(set) var signInMessage: String?

    private let api: any KeptAPI
    private let tokenStore: SessionTokenStore

    init(api: any KeptAPI, tokenStore: SessionTokenStore) {
        self.api = api
        self.tokenStore = tokenStore
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
    }
}
