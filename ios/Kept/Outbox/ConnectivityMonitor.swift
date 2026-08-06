import Foundation
import Network

/// Tells the outbox when the network path becomes usable so a queue built
/// up in a dead spot starts draining the moment signal returns, instead of
/// waiting for the next backoff tick or app foregrounding.
protocol ConnectivityMonitor: Sendable {
    /// Fires the handler on the main actor whenever the path transitions
    /// to satisfied. The handler must be cheap and idempotent - it is a
    /// nudge ("worth trying now"), not a guarantee a request will succeed.
    func start(onConnectivityRestored: @escaping @MainActor @Sendable () -> Void)
}

/// NWPathMonitor, reduced to the one bit the outbox cares about.
final class NetworkPathConnectivityMonitor: ConnectivityMonitor, @unchecked Sendable {
    // @unchecked: the monitor and flag are confined to `queue` - NWPathMonitor
    // delivers updates there, and nothing else touches them after start.
    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "kept.connectivity-monitor")
    private var wasSatisfied = false

    func start(onConnectivityRestored: @escaping @MainActor @Sendable () -> Void) {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            let isSatisfied = path.status == .satisfied
            // Only the unusable→usable edge fires the handler. The initial
            // update on an online device counts as such an edge, which
            // just nudges an already-scheduled drain at launch - harmless.
            let restored = isSatisfied && !self.wasSatisfied
            self.wasSatisfied = isSatisfied
            if restored {
                Task { @MainActor in
                    onConnectivityRestored()
                }
            }
        }
        monitor.start(queue: queue)
    }
}
