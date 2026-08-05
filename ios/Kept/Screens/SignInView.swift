import AuthenticationServices
import SwiftUI

/// One Sign in with Apple button, per spec §7.1. The completion goes
/// straight to SessionController; nothing is decided here.
struct SignInView: View {
    @EnvironmentObject private var session: SessionController
    @Environment(\.colorScheme) private var colorScheme
    @State private var showServerSettings = false

    var body: some View {
        VStack(spacing: 16) {
            Spacer()

            Image(systemName: "doc.text.viewfinder")
                .font(.system(size: 56))
                .foregroundStyle(.tint)
            Text("Kept")
                .font(.largeTitle.bold())
            Text("Capture a receipt once. Never think about it again.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)

            Spacer()

            if let message = session.signInMessage {
                Text(message)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.center)
            }

            SignInWithAppleButton(.signIn) { request in
                // Name and email arrive only on the very first
                // authorization; the name is passed to the backend, which
                // stores it nullable for the same reason (spec §5).
                request.requestedScopes = [.fullName, .email]
            } onCompletion: { result in
                Task { await session.handleSignInWithApple(result) }
            }
            .signInWithAppleButtonStyle(colorScheme == .dark ? .white : .black)
            .frame(height: 50)
            .disabled(session.state == .signingIn)
            .overlay {
                if session.state == .signingIn {
                    ProgressView()
                }
            }

            Button("Server settings") {
                showServerSettings = true
            }
            .font(.footnote)
        }
        .padding(24)
        .sheet(isPresented: $showServerSettings) {
            ServerSettingsView()
        }
    }
}
