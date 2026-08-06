import XCTest
@testable import Kept

/// The real store against a real (temporary) filesystem: round-trips,
/// the item.json commit point, and the honest handling of whatever a
/// previous run left behind - the §3 "app killed" guarantee lives or
/// dies in this layout.
final class FileOutboxStoreTests: XCTestCase {
    private var directory: URL!
    private var store: FileOutboxStore!

    override func setUpWithError() throws {
        try super.setUpWithError()
        directory = FileManager.default.temporaryDirectory
            .appending(path: "outbox-tests-\(UUID().uuidString)")
        store = FileOutboxStore(directory: directory)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
        try super.tearDownWithError()
    }

    private func makeItem(
        sequence: Int = 1,
        progress: OutboxItem.Progress = .captured
    ) -> OutboxItem {
        OutboxItem(
            id: UUID(),
            userId: UUID(),
            sequence: sequence,
            capturedAt: Date(timeIntervalSince1970: 1_775_000_000),
            sha256: "abc123",
            progress: progress,
            ocrAttempts: 0,
            blockedMessage: nil
        )
    }

    func testAddThenLoadRoundTripsItemsAndImages() async throws {
        let parsed = ParsedReceipt(
            suggestions: ReceiptSuggestions(totalCents: 11300, purchasedAt: "2026-01-14", vendor: "MAPLE"),
            ocrRawText: "MAPLE\nTOTAL 113.00"
        )
        let captured = makeItem(sequence: 1)
        let uploaded = OutboxItem(
            id: UUID(),
            userId: captured.userId,
            sequence: 2,
            capturedAt: captured.capturedAt,
            sha256: "def456",
            progress: .uploaded(parsed, objectKey: "user/2026/08/x.jpg"),
            ocrAttempts: 2,
            blockedMessage: "a reason"
        )
        try await store.add(captured, imageData: Data("first image".utf8))
        try await store.add(uploaded, imageData: Data("second image".utf8))

        let loaded = try await store.loadAll()
        XCTAssertEqual(loaded.items, [captured, uploaded])
        XCTAssertEqual(loaded.unreadableCount, 0)
        let image = try await store.imageData(itemId: captured.id)
        XCTAssertEqual(image, Data("first image".utf8))
    }

    func testLoadAllOrdersBySequenceNotDirectoryOrder() async throws {
        for sequence in [3, 1, 2] {
            try await store.add(makeItem(sequence: sequence), imageData: Data([UInt8(sequence)]))
        }
        let loaded = try await store.loadAll()
        XCTAssertEqual(loaded.items.map(\.sequence), [1, 2, 3])
    }

    func testUpdatePersistsProgress() async throws {
        var item = makeItem()
        try await store.add(item, imageData: Data("image".utf8))

        item.progress = .parsed(ParsedReceipt(suggestions: ReceiptSuggestions(), ocrRawText: nil))
        item.ocrAttempts = 1
        try await store.update(item)

        let loaded = try await store.loadAll()
        XCTAssertEqual(loaded.items, [item])
    }

    func testDirectoryWithoutCommitFileIsCountedAndKept() async throws {
        try await store.add(makeItem(), imageData: Data("kept".utf8))
        // The process died between the image write and the record write -
        // a save the person was never told failed. The bytes must be
        // counted and kept, never silently deleted: discard-with-
        // confirmation is the queue's only deletion path.
        let interrupted = directory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: interrupted, withIntermediateDirectories: true)
        try Data("orphan image".utf8).write(to: interrupted.appending(path: "image.jpg"))

        let loaded = try await store.loadAll()
        XCTAssertEqual(loaded.items.count, 1)
        XCTAssertEqual(loaded.unreadableCount, 1)
        XCTAssertTrue(FileManager.default.fileExists(atPath: interrupted.path()))
    }

    func testCorruptItemFileIsCountedNotDroppedOrFatal() async throws {
        try await store.add(makeItem(), imageData: Data("kept".utf8))
        let corrupt = directory.appending(path: UUID().uuidString)
        try FileManager.default.createDirectory(at: corrupt, withIntermediateDirectories: true)
        try Data("not json".utf8).write(to: corrupt.appending(path: "item.json"))

        let loaded = try await store.loadAll()
        XCTAssertEqual(loaded.items.count, 1, "the healthy item still loads")
        XCTAssertEqual(loaded.unreadableCount, 1, "the corrupt one is stated, not vanished")
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: corrupt.path()),
            "the files stay on disk for diagnosis"
        )
    }

    func testRemoveIsIdempotent() async throws {
        let item = makeItem()
        try await store.add(item, imageData: Data("image".utf8))
        try await store.remove(itemId: item.id)
        // The second remove is the kill-between-create-and-remove replay.
        try await store.remove(itemId: item.id)
        let loaded = try await store.loadAll()
        XCTAssertTrue(loaded.items.isEmpty)
    }

    func testMissingImageThrowsItsNamedError() async throws {
        let item = makeItem()
        try await store.add(item, imageData: Data("image".utf8))
        try FileManager.default.removeItem(
            at: directory
                .appending(path: item.id.uuidString.lowercased())
                .appending(path: "image.jpg")
        )
        do {
            _ = try await store.imageData(itemId: item.id)
            XCTFail("Expected OutboxMissingImageError")
        } catch is OutboxMissingImageError {
            // The named, permanent failure the drain blocks on.
        }
    }

    func testFailedAddCleansUpItsOwnDirectory() async throws {
        // Force the image write itself to fail: image.jpg's path is
        // occupied by a directory, which Data.write cannot replace.
        let item = makeItem()
        let itemDirectory = directory.appending(path: item.id.uuidString.lowercased())
        try FileManager.default.createDirectory(
            at: itemDirectory.appending(path: "image.jpg"),
            withIntermediateDirectories: true
        )

        do {
            try await store.add(item, imageData: Data("image".utf8))
            XCTFail("Expected the add to throw")
        } catch {
            // Expected: the original write failure, not a cleanup error.
        }
        // The directory itself must be gone - anything less would leave a
        // commit-less directory that loadAll then reports as an
        // unreadable receipt the person never had.
        XCTAssertFalse(FileManager.default.fileExists(atPath: itemDirectory.path()))
        let loaded = try await store.loadAll()
        XCTAssertTrue(loaded.items.isEmpty)
        XCTAssertEqual(loaded.unreadableCount, 0)
    }
}
