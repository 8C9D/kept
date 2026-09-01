import XCTest
@testable import Kept

/// Decode compatibility for the two suggestion shapes that gained fields on
/// 2026-09-01 - `otherFeesCents`, `paymentMethod` and the `withheld` flag.
///
/// Both directions matter and for different reasons. An outbox item written
/// by the build already on the owner's and the second user's phones has to keep uploading
/// after the update (a queued receipt is a receipt that is safe on the
/// phone and nowhere else - §7.4). And a receipt response from the server
/// as it is deployed today, before its own half of this change ships, has
/// to keep rendering.
final class SuggestionCompatibilityTests: XCTestCase {
    private func decode<T: Decodable>(_ json: String) throws -> T {
        let decoder = JSONDecoder()
        // The API's timestamps are ISO 8601 strings; APIClient installs its
        // own strategy for them, and this file decodes without APIClient.
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode(T.self, from: Data(json.utf8))
    }

    /// A `ParsedReceipt` as a pre-2026-09-01 build wrote it to disk.
    func testAQueuedParseFromAnOlderBuildStillDecodes() throws {
        let suggestions: ReceiptSuggestions = try decode("""
        {"totalCents": 11300, "hstCents": 1300, "subtotalCents": 10000, "purchasedAt": "2026-01-14", "vendor": "Maple"}
        """)
        XCTAssertEqual(suggestions.totalCents, 11300)
        XCTAssertNil(suggestions.otherFeesCents)
        XCTAssertNil(suggestions.paymentMethod)
    }

    /// And the other direction: a build that does not know these keys
    /// ignores them rather than failing, which is what makes a rollback
    /// safe. Asserted here by round-tripping through the decoder that DOES
    /// know them, since the old decoder is not in this binary - the
    /// property that matters is that both keys are Optional and additive.
    func testTheNewKeysRoundTrip() throws {
        let original = ReceiptSuggestions(
            totalCents: 6320,
            otherFeesCents: 659,
            paymentMethod: "MASTERCARD",
            vendor: "Maple"
        )
        let encoded = try JSONEncoder().encode(original)
        XCTAssertEqual(try JSONDecoder().decode(ReceiptSuggestions.self, from: encoded), original)
    }

    /// A receipt response from the server as deployed before its half of
    /// this change: no `otherFeesCents`, no `paymentMethod`, no `withheld`.
    func testAMergeWithoutTheNewEntriesStillDecodes() throws {
        let merged: MergedSuggestions = try decode("""
        {
          "vendor": {"value": "Maple", "source": "ocr"},
          "purchasedAt": {"value": "2026-01-14", "disagreement": false, "source": "ocr"},
          "totalCents": {"value": 11300, "source": "ocr"},
          "hstCents": {"value": 1300, "disagreement": false, "source": "ocr"},
          "subtotalCents": {"value": 10000, "source": "ocr"},
          "tipCents": {"value": null, "source": null}
        }
        """)
        XCTAssertEqual(merged.totalCents.value, 11300)
        XCTAssertFalse(merged.totalCents.withheld, "an undeclared flag means not withheld")
        XCTAssertNil(merged.otherFeesCents)
        XCTAssertNil(merged.paymentMethod)
    }

    func testAMergeCarryingTheNewEntriesDecodesThem() throws {
        let merged: MergedSuggestions = try decode("""
        {
          "vendor": {"value": "Maple"},
          "purchasedAt": {"value": "2026-01-14", "disagreement": false},
          "totalCents": {"value": null, "withheld": true},
          "hstCents": {"value": 1300, "disagreement": true},
          "subtotalCents": {"value": 10000, "withheld": false},
          "tipCents": {"value": 150},
          "otherFeesCents": {"value": 659},
          "paymentMethod": {"value": "MASTERCARD"}
        }
        """)
        XCTAssertTrue(merged.totalCents.withheld)
        XCTAssertNil(merged.totalCents.value)
        XCTAssertEqual(merged.otherFeesCents?.value, 659)
        XCTAssertEqual(merged.paymentMethod?.value, "MASTERCARD")
        XCTAssertTrue(merged.hstCents.disagreement)
    }

    /// A receipt response without `reviewedFields` or `ocrSource` - both
    /// added by the server's migration 0009, both decoded optionally here
    /// so a response from before it does not fail the whole decode.
    func testAReceiptWithoutTheNewColumnsStillDecodes() throws {
        let receipt: Receipt = try decode("""
        {
          "id": "0a1b2c3d-0000-4000-8000-000000000001",
          "purchasedAt": "2026-01-14",
          "capturedAt": "2026-01-14T15:32:00Z",
          "vendor": "Maple",
          "subtotalCents": null, "hstCents": null, "tipCents": null,
          "otherFeesCents": null, "totalCents": 11300,
          "currency": "CAD", "category": null, "paymentMethod": null, "notes": null,
          "status": "confirmed", "suggestions": null,
          "createdAt": "2026-01-14T15:32:00Z", "updatedAt": "2026-01-14T15:32:00Z"
        }
        """)
        XCTAssertEqual(receipt.totalCents, 11300)
        XCTAssertNil(receipt.reviewedFields)
        XCTAssertNil(receipt.ocrSource)
    }

    /// The parse route's own shape, and the conversion that lets the
    /// confirm screen render one suggestion type whichever parser answered.
    func testTheParseRouteResponseDecodesAndConverts() throws {
        let result: ServerParseResult = try decode("""
        {
          "suggestions": {
            "vendor": "JIMMY THE GREEK", "purchasedAt": "2026-08-29",
            "totalCents": 1750, "hstCents": 201, "subtotalCents": 1549,
            "tipCents": null, "otherFeesCents": null,
            "paymentMethod": "MASTERCARD", "vendorTaxNumber": "123933160RT0001"
          },
          "model": "claude-sonnet-5", "promptVersion": 3
        }
        """)
        XCTAssertEqual(result.model, "claude-sonnet-5")
        XCTAssertEqual(result.promptVersion, 3)

        let converted = result.suggestions.asReceiptSuggestions
        XCTAssertEqual(converted.vendor, "JIMMY THE GREEK")
        XCTAssertEqual(converted.totalCents, 1750)
        XCTAssertEqual(converted.paymentMethod, "MASTERCARD")
        XCTAssertEqual(converted.purchasedAt, "2026-08-29")
    }
}
