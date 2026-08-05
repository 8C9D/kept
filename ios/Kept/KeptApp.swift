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

    init() {
        let serverConfig = ServerConfig(defaults: .standard)
        let tokenStore = KeychainSessionTokenStore()
        let api = APIClient(
            baseURL: { serverConfig.baseURL },
            transport: URLSessionTransport(),
            tokenStore: tokenStore
        )
        let session = SessionController(api: api, tokenStore: tokenStore)
        // Wired after construction: the client reports rejected sessions to
        // the controller, and the controller makes its calls through the
        // client. The weak capture keeps the pair from retaining a cycle.
        api.onSessionRejected = { [weak session] in
            session?.handleSessionRejected()
        }

        self.serverConfig = serverConfig
        self.api = api
        self.session = session
    }
}

@main
struct KeptApp: App {
    @StateObject private var environment = AppEnvironment()

    var body: some Scene {
        WindowGroup {
            RootView(api: environment.api)
                .environmentObject(environment.session)
                .environmentObject(environment.serverConfig)
        }
    }
}
