import XCTest
@testable import Kept

/// What an `item.json` an INSTALLED build already wrote must still decode
/// to (2026-09-01, the PDF import and multi-page receipts).
///
/// This is the whole safety argument for adding three fields to a
/// persisted type. Build 1.0 (4) is on two phones; a queue on either of
/// them can hold a receipt captured before an update and drained after it,
/// and an item that fails to decode does not fail loudly - it is counted
/// `unreadable` and sits on disk forever with a receipt inside it. So the
/// old shape is written out here as literal JSON, exactly as that build
/// produced it, and asserted to come back as the single-page JPEG that
/// Vision read - which is the only thing it can be.
final class OutboxItemCompatibilityTests: XCTestCase {
    private static let decoder: JSONDecoder = {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }()

    private static let encoder: JSONEncoder = {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        return encoder
    }()

    /// An item.json as build 1.0 (4) wrote one: no `contentType`, no
    /// `ocrSource`, no `additionalPageCount`.
    private static let legacyItemJSON = """
    {
      "id": "11111111-2222-3333-4444-555555555555",
      "userId": "aaaaaaaa-1111-2222-3333-444444444444",
      "sequence": 7,
      "capturedAt": "2026-08-30T12:00:00Z",
      "sha256": "feed0000",
      "progress": { "captured": {} },
      "ocrAttempts": 0
    }
    """

    func testAnItemWrittenBeforeTheseFieldsDecodesAsASinglePageJPEG() throws {
        let item = try Self.decoder.decode(OutboxItem.self, from: Data(Self.legacyItemJSON.utf8))

        XCTAssertNil(item.contentType)
        XCTAssertNil(item.ocrSource)
        XCTAssertNil(item.additionalPageCount)
        // What the drain actually reads - the resolved answers, which are
        // the only thing an item from that build can have meant.
        XCTAssertEqual(item.uploadContentType, .jpeg)
        XCTAssertEqual(item.uploadOcrSource, .vision)
        XCTAssertEqual(item.extraPageCount, 0)
        XCTAssertEqual(item.sequence, 7)
        XCTAssertEqual(item.progress, .captured)
    }

    func testAnImportedPDFRoundTripsThroughDisk() throws {
        let item = OutboxItem(
            id: UUID(),
            userId: UUID(),
            sequence: 1,
            capturedAt: Date(timeIntervalSince1970: 1_775_000_000),
            sha256: "feed0000",
            progress: .parsed(ParsedReceipt(suggestions: ReceiptSuggestions(), ocrRawText: "TOTAL 113.00")),
            ocrAttempts: 0,
            confirmation: nil,
            partial: nil,
            contentType: .pdf,
            ocrSource: .pdfText
        )
        let decoded = try Self.decoder.decode(
            OutboxItem.self,
            from: Self.encoder.encode(item)
        )
        XCTAssertEqual(decoded, item)
        XCTAssertEqual(decoded.uploadContentType, .pdf)
        XCTAssertEqual(decoded.uploadOcrSource, .pdfText)
        XCTAssertEqual(decoded.extraPageCount, 0)
    }

    func testAMultiPageReceiptRoundTripsIncludingItsCreatedProgress() throws {
        let receiptId = UUID()
        let parsed = ParsedReceipt(suggestions: ReceiptSuggestions(totalCents: 11300), ocrRawText: nil)
        let item = OutboxItem(
            id: UUID(),
            userId: UUID(),
            sequence: 2,
            capturedAt: Date(timeIntervalSince1970: 1_775_000_000),
            sha256: "feed0001",
            progress: .created(parsed, receiptId: receiptId, pagesAdded: 1),
            ocrAttempts: 0,
            confirmation: nil,
            partial: nil,
            additionalPageCount: 2
        )
        let decoded = try Self.decoder.decode(
            OutboxItem.self,
            from: Self.encoder.encode(item)
        )
        XCTAssertEqual(decoded, item)
        XCTAssertEqual(decoded.progress, .created(parsed, receiptId: receiptId, pagesAdded: 1))
        XCTAssertEqual(decoded.extraPageCount, 2)
        // Still a JPEG scan: a multi-page receipt comes from the camera.
        XCTAssertEqual(decoded.uploadContentType, .jpeg)
    }

    /// A one-page receipt writes NO `additionalPageCount` key at all, so a
    /// queue read by hand looks exactly as it did before multi-page
    /// receipts existed - and an older build reading it (a downgrade, or
    /// a second phone) sees nothing new.
    func testASinglePageItemWritesNoNewKeysItDoesNotNeed() throws {
        let item = OutboxItem(
            id: UUID(),
            userId: UUID(),
            sequence: 1,
            capturedAt: Date(timeIntervalSince1970: 1_775_000_000),
            sha256: "feed0000",
            progress: .captured,
            ocrAttempts: 0,
            confirmation: nil,
            partial: nil
        )
        let json = try XCTUnwrap(String(data: Self.encoder.encode(item), encoding: .utf8))
        XCTAssertFalse(json.contains("additionalPageCount"), json)
        XCTAssertFalse(json.contains("contentType"), json)
        XCTAssertFalse(json.contains("ocrSource"), json)
    }
}
