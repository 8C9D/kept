import UIKit

/// Lets an in-flight drain keep running for the ~30 seconds iOS grants
/// after the app leaves the foreground - enough to finish uploading a
/// just-captured receipt while the phone goes into a pocket. This is the
/// whole extent of the app's background execution: no BGTaskScheduler, no
/// background URLSession, and therefore no need to read the keychain while
/// the device is locked (DECISIONS.md, wave 5 - the keychain stays
/// WhenUnlocked).
@MainActor
protocol BackgroundContinuation {
    /// Marks the start of work worth finishing after backgrounding.
    /// Returns the closure that ends it; calling it more than once is
    /// safe, and the system expiring the grant ends it automatically.
    func begin() -> @MainActor () -> Void
}

@MainActor
final class AppBackgroundContinuation: BackgroundContinuation {
    func begin() -> @MainActor () -> Void {
        let grant = Grant()
        grant.id = UIApplication.shared.beginBackgroundTask {
            // Documented to be called on the main thread; assumeIsolated
            // states that fact where the compiler can hold us to it.
            MainActor.assumeIsolated {
                grant.end()
            }
        }
        return { grant.end() }
    }

    /// Boxes the task identifier so the expiration handler and the normal
    /// end path agree on ending it exactly once.
    @MainActor
    private final class Grant {
        var id: UIBackgroundTaskIdentifier = .invalid

        func end() {
            guard id != .invalid else { return }
            UIApplication.shared.endBackgroundTask(id)
            id = .invalid
        }
    }
}
