import SwiftUI

/// The one switch between the signed-out and signed-in worlds. When
/// SessionController's state changes - a sign-in, a sign-out, a rejected
/// session mid-request - this is where the whole UI follows.
struct RootView: View {
    @EnvironmentObject private var session: SessionController
    let api: APIClient

    var body: some View {
        switch session.state {
        case .signedOut, .signingIn:
            SignInView()
        case .signedIn:
            HomeView(api: api)
        }
    }
}
