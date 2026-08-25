import AuthenticationServices
import UIKit

/// A fresh Sign in with Apple authorization, run at account-deletion time
/// for one reason: Apple's revocation endpoint needs something revocable,
/// and this app stores nothing of the kind. Sign-in verifies an identity
/// token and throws it away - deliberately, because a stored refresh token
/// is a credential to protect for the life of the account - so the code the
/// server needs has to be minted at the moment it is used. Apple bounds it
/// to five minutes and one use, which is exactly the lifetime it gets here.
///
/// A protocol so SessionController can be tested without Apple's sheet;
/// @MainActor rather than Sendable because ASAuthorizationController is a
/// UI presentation and belongs on the main actor, as does its only caller.
@MainActor
protocol AppleReauthorizing {
    /// The `authorizationCode` from a fresh authorization, as an ASCII
    /// string. Throws `.cancelled` when the person dismissed Apple's sheet -
    /// which is a decision, not a failure, and the caller treats it as one.
    func authorizationCode() async throws -> String
}

enum AppleReauthorizationError: Error, Equatable {
    /// The person dismissed Apple's sheet. Account deletion stops here.
    case cancelled
    /// Apple authorized but handed back no code, or one that is not text.
    case noAuthorizationCode
    /// Another authorization is already on screen.
    case alreadyRunning
}

/// The real implementation, over ASAuthorizationController.
@MainActor
final class AppleIDReauthorization: NSObject, AppleReauthorizing {
    /// Held for the duration of one authorization. Its presence is also how
    /// a second concurrent request is refused: a continuation overwritten by
    /// the next caller is one that never resumes, which hangs the deletion
    /// forever rather than failing it.
    private var pending: CheckedContinuation<String, Error>?
    /// The controller must outlive `performRequests`; ASAuthorizationController
    /// does not retain itself, and one that is deallocated calls back nothing.
    private var controller: ASAuthorizationController?

    func authorizationCode() async throws -> String {
        guard pending == nil else {
            throw AppleReauthorizationError.alreadyRunning
        }
        return try await withCheckedThrowingContinuation { continuation in
            pending = continuation
            let request = ASAuthorizationAppleIDProvider().createRequest()
            // No requested scopes, deliberately. This is not a sign-in: the
            // account already exists and is about to stop existing, and
            // asking for a name or an email here would request data the very
            // next request deletes. Apple returns those on first
            // authorization only in any case.
            request.requestedScopes = []
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.controller = controller
            controller.performRequests()
        }
    }

    private func finish(_ result: Result<String, Error>) {
        // Cleared before resuming: the continuation must be gone by the time
        // anyone can call back in, or the guard above reads a stale one.
        let continuation = pending
        pending = nil
        controller = nil
        continuation?.resume(with: result)
    }
}

extension AppleIDReauthorization: ASAuthorizationControllerDelegate {
    func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization
    ) {
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let codeData = credential.authorizationCode,
              let code = String(data: codeData, encoding: .utf8),
              !code.isEmpty else {
            finish(.failure(AppleReauthorizationError.noAuthorizationCode))
            return
        }
        finish(.success(code))
    }

    func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithError error: Error
    ) {
        // Cancel is a decision, not a failure - the same reading sign-in
        // gives it (SessionController.handleSignInWithApple).
        if let authError = error as? ASAuthorizationError, authError.code == .canceled {
            finish(.failure(AppleReauthorizationError.cancelled))
            return
        }
        finish(.failure(error))
    }
}

extension AppleIDReauthorization: ASAuthorizationControllerPresentationContextProviding {
    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        // The app has exactly one window. A fresh anchor rather than a crash
        // if that is somehow not true: Apple presents over the key window
        // when it can, and an authorization that fails to present reports
        // itself through the delegate above rather than taking the app down.
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .flatMap(\.windows)
            .first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }
}
