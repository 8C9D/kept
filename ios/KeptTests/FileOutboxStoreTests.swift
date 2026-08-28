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
        // The space is load-bearing: production lives under "Application
        // Support", and URL.path()'s default percent-encoding turned that
        // space into %20 - so fileExists denied every real file, remove
        // never removed, and loadAll misfiled every healthy item as
        // unreadable, while this suite, testing a space-free tmp path,
        // stayed green (wave-5 device run). Every store test now walks a
        // production-shaped path so that class of divergence cannot pass
        // silently again.
        directory = FileManager.default.temporaryDirectory
            .appending(path: "outbox tests \(UUID().uuidString)")
        store = FileOutboxStore(directory: directory)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: directory)
        try super.tearDownWithError()
    }

    // MARK: - File protection configuration

    func testQueuedReceiptsAreWrittenWithCompleteFileProtection() {
        // item.json holds the vendor, every amount, the payment method and
        // the notes; image.jpg is the receipt itself.
        // Without an explicit class they inherit
        // completeUntilFirstUserAuthentication, which stops protecting
        // after the first unlock following a boot - so in practice, never.
        //
        // The simulator does not enforce data protection, so no test here
        // can watch a locked read fail. The configuration is the
        // behaviour, so the configuration is what this asserts - the same
        // shape as the transport-cache assertion (framework §9.3 rule 5,
        // now at six instances on this project).
        XCTAssertTrue(FileOutboxStore.writeOptions.contains(.completeFileProtection))
        XCTAssertTrue(FileOutboxStore.writeOptions.contains(.atomic))
        XCTAssertEqual(
            FileOutboxStore.protectedDirectoryAttributes[.protectionKey] as? FileProtectionType,
            .complete
        )
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
            confirmation: nil,
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
            confirmation: ConfirmedReceiptFields(
                purchasedAt: "2026-01-14",
                vendor: "MAPLE",
                subtotalCents: 10000,
                hstCents: 1300,
                totalCents: 11300,
                tipCents: 1500,
                otherFeesCents: nil,
                category: "supplies",
                paymentMethod: nil,
                notes: nil
            ),
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

    /// The upgrade path, on the one piece of state that survives an app
    /// update: a receipt captured on the shipped 1.0 (1) build and still
    /// waiting to upload when the person installs the build that dropped
    /// the tax number, other tax and business-or-personal (2026-08-26).
    ///
    /// Its item.json carries all three retired keys. JSONDecoder ignores
    /// keys no property declares, so the item loads and uploads instead of
    /// being counted unreadable and stranded on the phone - which for a
    /// queue whose whole promise is "captured means safe" would be the
    /// worst possible way to lose a receipt. Written as raw JSON, not
    /// built from the current types, because the point is the old shape.
    func testAnItemQueuedByTheOldBuildStillLoads() async throws {
        let id = UUID()
        let itemDirectory = directory.appending(path: id.uuidString.lowercased())
        try FileManager.default.createDirectory(
            at: itemDirectory,
            withIntermediateDirectories: true
        )
        let oldShape = """
        {
          "id": "\(id.uuidString)",
          "userId": "\(UUID().uuidString)",
          "sequence": 7,
          "capturedAt": "2026-08-20T14:03:00Z",
          "sha256": "abc123",
          "ocrAttempts": 0,
          "progress": {
            "uploaded": {
              "_0": {
                "suggestions": {
                  "totalCents": 11300,
                  "hstCents": 1300,
                  "subtotalCents": 10000,
                  "vendorTaxNumber": "123456789RT0001",
                  "purchasedAt": "2026-08-20",
                  "vendor": "MAPLE"
                },
                "ocrRawText": "MAPLE\\nTOTAL 113.00"
              },
              "objectKey": "user/2026/08/x.jpg"
            }
          },
          "confirmation": {
            "purchasedAt": "2026-08-20",
            "vendor": "MAPLE",
            "vendorTaxNumber": "123456789RT0001",
            "subtotalCents": 10000,
            "hstCents": 1300,
            "otherTaxCents": 250,
            "totalCents": 11300,
            "category": "supplies",
            "isBusiness": true
          }
        }
        """
        try Data(oldShape.utf8).write(to: itemDirectory.appending(path: "item.json"))
        try Data("old image".utf8).write(to: itemDirectory.appending(path: "image.jpg"))

        let loaded = try await store.loadAll()

        XCTAssertEqual(loaded.unreadableCount, 0, "an old-shape item must not be misfiled as corrupt")
        let item = try XCTUnwrap(loaded.items.first)
        XCTAssertEqual(item.id, id)
        XCTAssertEqual(item.sequence, 7)
        // The fields that remain survive intact; the retired keys are
        // simply not there to read.
        let confirmation = try XCTUnwrap(item.confirmation)
        XCTAssertEqual(confirmation.totalCents, 11300)
        XCTAssertEqual(confirmation.hstCents, 1300)
        XCTAssertEqual(confirmation.subtotalCents, 10000)
        XCTAssertEqual(confirmation.category, "supplies")
        XCTAssertNil(confirmation.paymentMethod)
        XCTAssertNil(confirmation.notes)
        // The other direction (2026-08-28): tipCents and otherFeesCents
        // did not exist when this item was written, so neither key is in
        // the JSON above. Both are Optional, and the synthesized decoder
        // treats an Optional property's missing key as nil - the same
        // guarantee that let the retired keys' removal stay decode-safe,
        // now proven for an added field too.
        XCTAssertNil(confirmation.tipCents)
        XCTAssertNil(confirmation.otherFeesCents)
        guard case .uploaded(let parsed, let objectKey) = item.progress else {
            return XCTFail("Expected .uploaded, got \(item.progress)")
        }
        XCTAssertEqual(objectKey, "user/2026/08/x.jpg")
        XCTAssertEqual(parsed.suggestions.totalCents, 11300)
        XCTAssertEqual(parsed.suggestions.vendor, "MAPLE")
        XCTAssertNil(parsed.suggestions.tipCents)
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
        XCTAssertTrue(FileManager.default.fileExists(atPath: interrupted.path(percentEncoded: false)))
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
            FileManager.default.fileExists(atPath: corrupt.path(percentEncoded: false)),
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
        XCTAssertFalse(FileManager.default.fileExists(atPath: itemDirectory.path(percentEncoded: false)))
        let loaded = try await store.loadAll()
        XCTAssertTrue(loaded.items.isEmpty)
        XCTAssertEqual(loaded.unreadableCount, 0)
    }
}
