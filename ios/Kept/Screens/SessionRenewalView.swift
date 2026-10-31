import AuthenticationServices
import SwiftUI

/// Signing in again without leaving the screen (2026-10-31): the half of a
/// session hold that a network write needs (`SessionController.renewHeldSession`).
///
/// A capture finishes behind a dead session because its Save is a disk
/// write. The confirm form and Add a page cannot, so holding the screen up
/// on its own would only trade a lost form for one that can never save.
/// Renders nothing unless a rejection is being held.
struct SessionRenewalView: View {
    @EnvironmentObject private var session: SessionController
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        if session.rejectionIsHeld {
            VStack(spacing: 8) {
                Text("Your session has expired. Sign in to finish this - nothing here has been lost.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .accessibilityIdentifier("session.renewalNote")
                // No name or email: this is the same person signing back
                // in, and Apple only ever sends those the first time.
                SignInWithAppleButton(.signIn) { request in
                    request.requestedScopes = []
                } onCompletion: { result in
                    Task { await session.renewHeldSession(result) }
                }
                .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
                .frame(height: 44)
                .disabled(session.isRenewingSession)
                .accessibilityIdentifier("session.renew")
                if let message = session.sessionRenewalMessage {
                    Text(message)
                        .font(.footnote)
                        .foregroundStyle(.red)
                        .multilineTextAlignment(.center)
                }
            }
        }
    }
}
