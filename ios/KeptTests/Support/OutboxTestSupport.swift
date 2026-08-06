import Foundation
@testable import Kept

/// An OutboxStore that is just dictionaries, plus injectable failures for
/// the paths a real filesystem rarely produces on demand - disk full,
/// above all, which is a §3 failure mode the gate requires a test for.
/// @MainActor for the protocol's Sendable bound; the async requirements
/// hop here implicitly.
@MainActor
final class InMemoryOutboxStore: OutboxStore {
    private(set) var items: [UUID: OutboxItem] = [:]
    private(set) var images: [UUID: Data] = [:]
    /// Every update() in order, so tests can assert what was persisted
    /// when - the step machine's durability is the §3 "killed mid-upload"
    /// guarantee.
    private(set) var updates: [OutboxItem] = []

    var addError: Error?
    var updateError: Error?
    var removeError: Error?
    /// Scripted loadAll result; when nil, loadAll derives from `items`.
    var loadAllResult: OutboxLoadResult?

    /// Puts an item on "disk" as if a previous run enqueued it - the
    /// seeding path for relaunch-and-resume tests.
    func seed(_ item: OutboxItem, imageData: Data) {
        items[item.id] = item
        images[item.id] = imageData
    }

    /// Simulates image bytes lost from disk while the item record remains.
    func removeImage(_ id: UUID) {
        images[id] = nil
    }

    func loadAll() async throws -> OutboxLoadResult {
        if let loadAllResult {
            return loadAllResult
        }
        return OutboxLoadResult(
            items: items.values.sorted { $0.sequence < $1.sequence },
            unreadableCount: 0
        )
    }

    func add(_ item: OutboxItem, imageData: Data) async throws {
        if let addError {
            throw addError
        }
        items[item.id] = item
        images[item.id] = imageData
    }

    /// Thrown when updating an item that is not stored - the production
    /// store fails there too (no directory to write into), and a test
    /// double more permissive than production would hide exactly the
    /// stale-write bugs these tests exist to catch.
    struct MissingItem: Error {}

    func update(_ item: OutboxItem) async throws {
        if let updateError {
            throw updateError
        }
        guard items[item.id] != nil else {
            throw MissingItem()
        }
        items[item.id] = item
        updates.append(item)
    }

    func imageData(itemId: UUID) async throws -> Data {
        guard let data = images[itemId] else {
            throw OutboxMissingImageError(itemId: itemId)
        }
        return data
    }

    func remove(itemId: UUID) async throws {
        if let removeError {
            throw removeError
        }
        items[itemId] = nil
        images[itemId] = nil
    }
}

/// Records the handler and lets tests fire "connectivity is back" on cue.
final class StubConnectivityMonitor: ConnectivityMonitor, @unchecked Sendable {
    // @unchecked: start() is called once from the main actor (controller
    // start) and simulateRestored runs on the main actor too; tests never
    // race these.
    private(set) var handler: (@MainActor @Sendable () -> Void)?

    func start(onConnectivityRestored: @escaping @MainActor @Sendable () -> Void) {
        handler = onConnectivityRestored
    }

    @MainActor
    func simulateRestored() {
        handler?()
    }
}

/// Counts grants so tests can assert every drain pass balances its
/// begin with an end - a leaked background grant is invisible in normal
/// use and gets the app killed in the field.
@MainActor
final class StubBackgroundContinuation: BackgroundContinuation {
    private(set) var beginCount = 0
    private(set) var endCount = 0

    func begin() -> @MainActor () -> Void {
        beginCount += 1
        var ended = false
        return {
            guard !ended else { return }
            ended = true
            self.endCount += 1
        }
    }
}

/// Builds unsigned session-JWT lookalikes: three base64url segments with a
/// real `sub` claim. SessionTokenClaims reads only the payload, so the
/// signature is a stand-in - exactly like the client's position, which
/// never verifies its own token.
enum TestTokens {
    /// `filler` pads an unrelated claim so tests can vary the payload's
    /// byte length - and therefore its base64 padding - while `sub` stays
    /// a valid uuid.
    static func sessionToken(sub: String, filler: String = "") -> String {
        [
            base64URL(#"{"alg":"HS256"}"#),
            base64URL(#"{"sub":"\#(sub)","tv":0,"iat":1754000000,"exp":1756600000,"x":"\#(filler)"}"#),
            "test-signature",
        ].joined(separator: ".")
    }

    private static func base64URL(_ json: String) -> String {
        Data(json.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
