import Foundation

/// Durable storage for queued receipts. FileOutboxStore is the production
/// implementation; tests substitute an in-memory one to script failures
/// (disk full, most importantly) that a real filesystem rarely produces on
/// demand (spec §10.2's seam pattern, applied to disk instead of network).
protocol OutboxStore: Sendable {
    func loadAll() async throws -> OutboxLoadResult
    /// Makes the item durable: after this returns, a killed app still has
    /// the receipt. Throws when the write fails - a full disk, mainly -
    /// and the capture flow must surface that as a failed save, because
    /// the person still has the paper in hand and needs to know.
    func add(_ item: OutboxItem, imageData: Data) async throws
    func update(_ item: OutboxItem) async throws
    func imageData(itemId: UUID) async throws -> Data
    /// Removing an already-absent item is a success: remove-after-create
    /// must be idempotent across a kill between the two.
    func remove(itemId: UUID) async throws
}

struct OutboxLoadResult: Sendable {
    var items: [OutboxItem]
    /// Records on disk that could not be read back into the queue: an
    /// item.json that fails to decode, or an image directory whose commit
    /// record never got written because the process died mid-save. Both
    /// are counted and stated on Home rather than silently skipped or
    /// deleted - a saved receipt must never vanish without a human
    /// hearing about it (wave-5 kickoff §3), and deletion belongs to the
    /// confirmed discard path alone. The files stay on disk.
    var unreadableCount: Int
}

/// A stored receipt whose image bytes cannot be read back. Not a decode
/// miss or a transient condition: the queue is corrupt at exactly the
/// point whose durability it promises. The drain treats it as permanent -
/// no retry can conjure the bytes back - and surfaces it for a human
/// (kickoff §3: never retry forever, never vanish silently).
struct OutboxMissingImageError: LocalizedError {
    let itemId: UUID
    var errorDescription: String? {
        "The saved image for this receipt could not be read back from this phone."
    }
}

/// One directory per item under Application Support:
///
///   Outbox/<item id>/image.jpg     - written first
///   Outbox/<item id>/item.json     - written last, atomically: the commit
///
/// item.json's presence is what makes an item exist. A directory without
/// it is an enqueue that failed partway (the save call threw and the
/// person saw the failure), so loadAll sweeps it. Application Support is
/// included in device backups, which is what a queue of tax records wants.
actor FileOutboxStore: OutboxStore {
    private let directory: URL
    private let fileManager = FileManager.default

    init(directory: URL? = nil) {
        if let directory {
            self.directory = directory
        } else {
            // .applicationSupportDirectory always resolves inside the app
            // sandbox on iOS; the directory itself may not exist until
            // ensureDirectory creates it.
            self.directory = URL.applicationSupportDirectory.appending(path: "Outbox")
        }
    }

    func loadAll() async throws -> OutboxLoadResult {
        try ensureDirectory()
        let entries = try fileManager.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: nil
        )
        var result = OutboxLoadResult(items: [], unreadableCount: 0)
        for entry in entries where entry.hasDirectoryPath {
            let itemFile = entry.appending(path: Self.itemFileName)
            guard fileManager.fileExists(atPath: itemFile.path()) else {
                // No commit file. add() cleans up after its own failures,
                // so the only way this state survives is the process dying
                // between the image write and the record write - a save
                // the person was never told failed. Counted and kept,
                // never deleted (reviewer finding: an earlier draft swept
                // these silently, a second deletion path).
                result.unreadableCount += 1
                continue
            }
            do {
                let data = try Data(contentsOf: itemFile)
                result.items.append(try Self.decoder.decode(OutboxItem.self, from: data))
            } catch {
                result.unreadableCount += 1
            }
        }
        result.items.sort { $0.sequence < $1.sequence }
        return result
    }

    func add(_ item: OutboxItem, imageData: Data) async throws {
        try ensureDirectory()
        let itemDirectory = self.itemDirectory(item.id)
        do {
            try fileManager.createDirectory(at: itemDirectory, withIntermediateDirectories: true)
            try imageData.write(to: itemDirectory.appending(path: Self.imageFileName), options: .atomic)
            try Self.encoder.encode(item).write(
                to: itemDirectory.appending(path: Self.itemFileName),
                options: .atomic
            )
        } catch {
            // A half-written item must not linger; without its commit file
            // it would be swept eventually anyway, but cleaning up now
            // keeps a failed save free of side effects. The original error
            // is what the caller needs to hear, so the cleanup's own
            // outcome is deliberately not allowed to replace it.
            try? fileManager.removeItem(at: itemDirectory)
            throw error
        }
    }

    func update(_ item: OutboxItem) async throws {
        try Self.encoder.encode(item).write(
            to: itemDirectory(item.id).appending(path: Self.itemFileName),
            options: .atomic
        )
    }

    func imageData(itemId: UUID) async throws -> Data {
        do {
            return try Data(contentsOf: itemDirectory(itemId).appending(path: Self.imageFileName))
        } catch {
            throw OutboxMissingImageError(itemId: itemId)
        }
    }

    func remove(itemId: UUID) async throws {
        let itemDirectory = self.itemDirectory(itemId)
        guard fileManager.fileExists(atPath: itemDirectory.path()) else {
            return
        }
        try fileManager.removeItem(at: itemDirectory)
    }

    // MARK: - Layout

    private static let itemFileName = "item.json"
    private static let imageFileName = "image.jpg"

    private func itemDirectory(_ id: UUID) -> URL {
        directory.appending(path: id.uuidString.lowercased())
    }

    private func ensureDirectory() throws {
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    // MARK: - Coding

    /// ISO 8601 dates so item.json stays human-readable when a queue needs
    /// diagnosing by hand.
    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()
}
