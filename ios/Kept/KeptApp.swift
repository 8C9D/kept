import SwiftUI

/// The composition root: every dependency constructed once, wired here,
/// and handed down as a value - the same shape as the backend's createApp
/// (server/src/app.ts), where nothing inside reads global state.
///
/// It is a single @StateObject-held object rather than loose lets in
/// KeptApp.init because SwiftUI may re-run an App's initializer while
/// keeping the first @StateObject instance: dependencies built as plain
/// stored properties would then be rebuilt and wired to a controller no
/// view observes. One root object means the whole graph lives and dies
/// together. (Wave-3 reviewer finding.)
@MainActor
final class AppEnvironment: ObservableObject {
    let serverConfig: ServerConfig
    let api: APIClient
    let session: SessionController
    let outbox: OutboxController

    init() {
        let serverConfig = ServerConfig(defaults: .standard)
        let tokenStore = KeychainSessionTokenStore()
        let rejectionRelay = SessionRejectionRelay()
        let api = APIClient(
            // A static UserDefaults read, not a capture of serverConfig:
            // the client is Sendable and runs on any task, while the
            // config object belongs to the UI (see ServerConfig).
            baseURL: { ServerConfig.currentBaseURL(defaults: .standard) },
            transport: URLSessionTransport(),
            tokenStore: tokenStore,
            rejectionRelay: rejectionRelay
        )
        let session = SessionController(api: api, tokenStore: tokenStore)
        let outbox = OutboxController(
            store: FileOutboxStore(),
            api: api,
            recognizer: VisionReceiptTextRecognizer(),
            tokenStore: tokenStore,
            connectivity: NetworkPathConnectivityMonitor(),
            backgroundContinuation: AppBackgroundContinuation()
        )

        // Wired after construction because the pieces reference each other:
        // the client reports rejected sessions to the controller it was
        // built before, and a fresh sign-in wakes the queue that may have
        // been waiting out an expired session (kickoff §3). Weak captures
        // keep the graph cycle-free.
        rejectionRelay.onSessionRejected = { [weak session] in
            session?.handleSessionRejected()
        }
        session.onSignedIn = { [weak outbox] in
            outbox?.externalTrigger()
        }
        session.onSignedOut = { [weak outbox] in
            outbox?.sessionDidEnd()
        }

        self.serverConfig = serverConfig
        self.api = api
        self.session = session
        self.outbox = outbox

        Task { await outbox.start() }
    }
}

@main
struct KeptApp: App {
    @StateObject private var environment = AppEnvironment()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            RootView(api: environment.api)
                .environmentObject(environment.session)
                .environmentObject(environment.serverConfig)
                .environmentObject(environment.outbox)
                // Foregrounding is the outbox's main drain trigger (wave-5
                // decision: uploads run while the app is up, and the
                // keychain stays WhenUnlocked).
                .onChange(of: scenePhase) { _, phase in
                    if phase == .active {
                        environment.outbox.externalTrigger()
                    }
                }
        }
    }
}
