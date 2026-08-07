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

/// The queue is on disk and intact, but this phone is locked, so complete
/// file protection is refusing the read.
///
/// ⚠ This exists only because the files are written with
/// `.completeFileProtection`. Without it, a locked read raises the same
/// kind of failure a *destroyed* file does, and the drain treats destroyed
/// as permanent - so a healthy receipt on a locked phone would be blocked
/// and reported to the person as lost. Transient and permanent failures of
/// the same call have to be told apart at the point where the difference is
/// still visible, which is here.
struct OutboxLockedError: LocalizedError {
    var errorDescription: String? {
        "This phone is locked, so the saved receipts cannot be read yet."
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
            // percentEncoded: false, here and in remove below: URL.path()
            // percent-encodes by default, and the production directory has
            // a space ("Application Support"), so the encoded string names
            // a path that does not exist. fileExists then answered false
            // for every real file - which made this guard misfile every
            // healthy item as unreadable at launch, while remove's guard
            // returned success without removing (wave-5 device run; the
            // test directory had no space, so the suite was blind to it).
            guard fileManager.fileExists(atPath: itemFile.path(percentEncoded: false)) else {
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
            } catch let error as CocoaError where error.code == .fileReadNoPermission {
                // Not this item's problem - the phone is locked, and every
                // remaining item would answer the same way. Failing the
                // whole load is what keeps `hasLoadedOnce` false so the
                // next foreground retries; counting these as unreadable
                // would tell the person their queue was corrupt when it is
                // merely encrypted, which is what it is supposed to be.
                throw OutboxLockedError()
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
            try fileManager.createDirectory(
                at: itemDirectory,
                withIntermediateDirectories: true,
                attributes: Self.protectedDirectoryAttributes
            )
            try imageData.write(
                to: itemDirectory.appending(path: Self.imageFileName),
                options: Self.writeOptions
            )
            try Self.encoder.encode(item).write(
                to: itemDirectory.appending(path: Self.itemFileName),
                options: Self.writeOptions
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
            options: Self.writeOptions
        )
    }

    func imageData(itemId: UUID) async throws -> Data {
        do {
            return try Data(contentsOf: itemDirectory(itemId).appending(path: Self.imageFileName))
        } catch let error as CocoaError where error.code == .fileReadNoPermission {
            // Locked, not gone. The distinction decides whether the drain
            // waits for the next unlock or tells the person their receipt
            // is unrecoverable - see OutboxLockedError.
            throw OutboxLockedError()
        } catch {
            throw OutboxMissingImageError(itemId: itemId)
        }
    }

    func remove(itemId: UUID) async throws {
        let itemDirectory = self.itemDirectory(itemId)
        guard fileManager.fileExists(atPath: itemDirectory.path(percentEncoded: false)) else {
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
        try fileManager.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: Self.protectedDirectoryAttributes
        )
    }

    /// ⚠ These two are the reason the outbox is not a plaintext copy of the
    /// user's tax records sitting on the disk.
    ///
    /// `item.json` carries the vendor, the tax number, every amount, the
    /// payment method, the notes and the full OCR text; `image.jpg` is the
    /// receipt itself. Without an explicit class they inherit iOS's default,
    /// `completeUntilFirstUserAuthentication`, which stops protecting the
    /// moment the phone is unlocked once after a boot - that is, essentially
    /// always. `.complete` keeps them encrypted whenever the phone is
    /// locked, which is the posture the session token already has in the
    /// keychain (`kSecAttrAccessibleWhenUnlocked`).
    ///
    /// The directory attribute matters as well as the per-file option: files
    /// created inside it inherit the class, so a future write site that
    /// forgets `writeOptions` still lands protected.
    ///
    /// ⚠ Unverifiable from a test. The simulator does not enforce data
    /// protection, so no test here can observe a locked read failing; what
    /// the tests assert is the *configuration* that selects the behaviour
    /// (framework §9.3 rule 5).
    /// Internal rather than private so the configuration assertion in
    /// FileOutboxStoreTests can read them; there is nothing else to assert.
    static let writeOptions: Data.WritingOptions = [
        .atomic, .completeFileProtection,
    ]

    static var protectedDirectoryAttributes: [FileAttributeKey: Any] {
        [.protectionKey: FileProtectionType.complete]
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
