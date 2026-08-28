import SwiftUI

/// The one switch between the signed-out and signed-in worlds. When
/// SessionController's state changes - a sign-in, a sign-out, a rejected
/// session mid-request - this is where the whole UI follows.
struct RootView: View {
    @EnvironmentObject private var session: SessionController
    let api: APIClient
    let options: ReceiptOptionsStore
    let eventLogger: EventLogger

    var body: some View {
        #if DEBUG
        if KeyboardExitUITestHarness.isRequested {
            KeyboardExitUITestHarness(options: options, eventLogger: eventLogger)
        } else {
            signedInOrOut
        }
        #else
        signedInOrOut
        #endif
    }

    @ViewBuilder
    private var signedInOrOut: some View {
        switch session.state {
        case .signedOut, .signingIn:
            SignInView()
        case .signedIn:
            HomeView(api: api, options: options, eventLogger: eventLogger)
        }
    }
}
