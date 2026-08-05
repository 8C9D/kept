import XCTest
@testable import Kept

/// The networking layer against a stubbed transport: token attachment,
/// error mapping, session rejection, and decoding of the server's real
/// response shapes. No test here touches the network.
@MainActor
final class APIClientTests: XCTestCase {
    private var transport = StubTransport()
    private var tokenStore = InMemoryTokenStore()
    private var sessionRejections = 0

    override func setUp() {
        super.setUp()
        transport = StubTransport()
        tokenStore = InMemoryTokenStore(stored: "stored-session-token")
        sessionRejections = 0
    }

    private func makeClient() throws -> APIClient {
        let baseURL = try XCTUnwrap(URL(string: "http://kept.test"))
        let client = APIClient(baseURL: { baseURL }, transport: transport, tokenStore: tokenStore)
        client.onSessionRejected = { [weak self] in
            self?.sessionRejections += 1
        }
        return client
    }

    // MARK: - Token attachment

    func testAuthenticatedRequestCarriesBearerToken() async throws {
        let client = try makeClient()
        transport.enqueue(status: 200, jsonBody: emptyPageJSON)

        _ = try await client.receiptsPage(cursor: nil, status: nil, limit: nil)

        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(
            request.value(forHTTPHeaderField: "Authorization"),
            "Bearer stored-session-token"
        )
    }

    func testSignInCarriesNoAuthorizationHeader() async throws {
        let client = try makeClient()
        transport.enqueue(status: 200, jsonBody: signInJSON)

        _ = try await client.signInWithApple(identityToken: "apple-token", displayName: "Test User")

        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
    }

    func testSignInOmitsNilDisplayNameFromBody() async throws {
        let client = try makeClient()
        transport.enqueue(status: 200, jsonBody: signInJSON)

        _ = try await client.signInWithApple(identityToken: "apple-token", displayName: nil)

        let body = try XCTUnwrap(transport.requests.first?.httpBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        // The server's strict schema rejects an explicit null here; the key
        // must be absent, not present-and-null.
        XCTAssertEqual(Array(json.keys), ["identityToken"])
    }

    func testMissingTokenRejectsSessionWithoutANetworkCall() async throws {
        tokenStore.stored = nil
        let client = try makeClient()

        await assertThrowsSessionRejected {
            _ = try await client.receiptsPage(cursor: nil, status: nil, limit: nil) as ReceiptListPage
        }
        XCTAssertEqual(sessionRejections, 1)
        XCTAssertTrue(transport.requests.isEmpty)
    }

    // MARK: - Error mapping

    func testErrorEnvelopeMapsToRequestFailed() async throws {
        let client = try makeClient()
        transport.enqueue(
            status: 404,
            jsonBody: #"{"error":{"code":"not_found","message":"Not found"}}"#
        )

        do {
            _ = try await client.receiptDetail(id: UUID())
            XCTFail("Expected a thrown APIError")
        } catch let APIError.requestFailed(code, message, status) {
            XCTAssertEqual(code, "not_found")
            XCTAssertEqual(message, "Not found")
            XCTAssertEqual(status, 404)
        }
    }

    func testNonEnvelopeErrorBodyMapsToUnexpectedResponse() async throws {
        let client = try makeClient()
        transport.enqueue(status: 502, jsonBody: "<html>Bad Gateway</html>")

        do {
            _ = try await client.receiptsPage(cursor: nil, status: nil, limit: nil)
            XCTFail("Expected a thrown APIError")
        } catch let APIError.unexpectedResponse(status) {
            XCTAssertEqual(status, 502)
        }
    }

    func testNetworkFailureMapsToNetworkError() async throws {
        let client = try makeClient()
        transport.enqueueFailure(URLError(.notConnectedToInternet))

        do {
            _ = try await client.receiptsPage(cursor: nil, status: nil, limit: nil)
            XCTFail("Expected a thrown APIError")
        } catch let APIError.network(urlError) {
            XCTAssertEqual(urlError.code, .notConnectedToInternet)
        }
    }

    func testUndecodableSuccessBodyThrowsUndecodableResponse() async throws {
        let client = try makeClient()
        transport.enqueue(status: 200, jsonBody: #"{"unexpected":"shape"}"#)

        do {
            _ = try await client.receiptsPage(cursor: nil, status: nil, limit: nil)
            XCTFail("Expected a thrown APIError")
        } catch APIError.undecodableResponse {
            // Expected.
        }
    }

    // MARK: - Session rejection

    func testUnauthorizedOnAuthenticatedCallRejectsSession() async throws {
        let client = try makeClient()
        transport.enqueue(
            status: 401,
            jsonBody: #"{"error":{"code":"unauthorized","message":"A valid session token is required"}}"#
        )

        await assertThrowsSessionRejected {
            _ = try await client.receiptsPage(cursor: nil, status: nil, limit: nil) as ReceiptListPage
        }
        XCTAssertEqual(sessionRejections, 1)
    }

    func testUnauthorizedAtSignInIsNotASessionDeath() async throws {
        let client = try makeClient()
        transport.enqueue(
            status: 401,
            jsonBody: #"{"error":{"code":"invalid_identity_token","message":"Apple identity token failed verification"}}"#
        )

        do {
            _ = try await client.signInWithApple(identityToken: "rejected", displayName: nil)
            XCTFail("Expected a thrown APIError")
        } catch let APIError.requestFailed(code, _, _) {
            XCTAssertEqual(code, "invalid_identity_token")
        }
        XCTAssertEqual(sessionRejections, 0)
    }

    // MARK: - Decoding the server's shapes

    func testDecodesReceiptListPage() async throws {
        let client = try makeClient()
        transport.enqueue(status: 200, jsonBody: listPageJSON)

        let page = try await client.receiptsPage(cursor: nil, status: nil, limit: nil)

        XCTAssertEqual(page.receipts.count, 2)
        XCTAssertEqual(page.nextCursor, "opaque-cursor-value")

        let first = try XCTUnwrap(page.receipts.first)
        XCTAssertEqual(first.id, UUID(uuidString: "0a1b2c3d-0000-4000-8000-000000000001"))
        XCTAssertEqual(first.purchasedAt, "2026-03-20")
        XCTAssertEqual(first.vendor, "Synthetic Vendor Three")
        XCTAssertEqual(first.hstCents, 325)
        XCTAssertEqual(first.totalCents, 2925)
        XCTAssertEqual(first.status, .confirmed)
        XCTAssertEqual(
            first.capturedAt,
            ISO8601DateFormatter().date(from: "2026-03-20T12:00:00Z")
        )

        let second = try XCTUnwrap(page.receipts.last)
        XCTAssertNil(second.vendor)
        XCTAssertNil(second.subtotalCents)
        XCTAssertEqual(second.status, .pending)
    }

    func testDecodesReceiptDetail() async throws {
        let client = try makeClient()
        transport.enqueue(status: 200, jsonBody: detailJSON)

        let detail = try await client.receiptDetail(
            id: try XCTUnwrap(UUID(uuidString: "0a1b2c3d-0000-4000-8000-000000000001"))
        )

        XCTAssertEqual(detail.receipt.vendor, "Synthetic Vendor Three")
        XCTAssertEqual(detail.receipt.totalCents, 2925)
        XCTAssertEqual(detail.ocrRawText, "SYNTHETIC OCR TEXT\nTOTAL 29.25")
        XCTAssertEqual(detail.images.count, 1)
        XCTAssertEqual(detail.images.first?.page, 1)
        XCTAssertEqual(
            detail.images.first?.downloadUrl,
            URL(string: "https://storage.example/presigned/abc")
        )
    }

    func testDecodesTimestampsWithoutFractionalSeconds() async throws {
        // The decoder's plain ISO 8601 fallback exists to survive a server
        // serialization change; without this test that branch could regress
        // silently, since every real server timestamp carries millis.
        let client = try makeClient()
        transport.enqueue(
            status: 200,
            jsonBody: listPageJSON.replacingOccurrences(of: ".000Z", with: "Z")
        )

        let page = try await client.receiptsPage(cursor: nil, status: nil, limit: nil)

        XCTAssertEqual(
            page.receipts.first?.capturedAt,
            ISO8601DateFormatter().date(from: "2026-03-20T12:00:00Z")
        )
    }

    func testListQueryItemsAreBuiltFromParameters() async throws {
        let client = try makeClient()
        transport.enqueue(status: 200, jsonBody: emptyPageJSON)

        _ = try await client.receiptsPage(cursor: "cursor-1", status: .pending, limit: 200)

        let url = try XCTUnwrap(transport.requests.first?.url)
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.path, "/api/receipts")
        let items = try XCTUnwrap(components.queryItems)
        XCTAssertEqual(items.first { $0.name == "cursor" }?.value, "cursor-1")
        XCTAssertEqual(items.first { $0.name == "status" }?.value, "pending")
        XCTAssertEqual(items.first { $0.name == "limit" }?.value, "200")
    }

    // MARK: - Helpers

    private func assertThrowsSessionRejected(
        _ body: () async throws -> Void,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        do {
            try await body()
            XCTFail("Expected APIError.sessionRejected", file: file, line: line)
        } catch APIError.sessionRejected {
            // Expected.
        } catch {
            XCTFail("Expected APIError.sessionRejected, got \(error)", file: file, line: line)
        }
    }

    // MARK: - Server-shaped JSON

    /// Mirrors server/src/routes/receipts.ts `receiptResponse` exactly,
    /// including JavaScript's toISOString timestamps and null for absent
    /// nullable fields.
    private let listPageJSON = """
    {
      "receipts": [
        {
          "id": "0a1b2c3d-0000-4000-8000-000000000001",
          "purchasedAt": "2026-03-20",
          "capturedAt": "2026-03-20T12:00:00.000Z",
          "vendor": "Synthetic Vendor Three",
          "vendorTaxNumber": "000000000RT0001",
          "subtotalCents": 2500,
          "hstCents": 325,
          "otherTaxCents": 100,
          "totalCents": 2925,
          "currency": "CAD",
          "category": "meals",
          "paymentMethod": null,
          "isBusiness": true,
          "notes": "synthetic note",
          "status": "confirmed",
          "createdAt": "2026-08-05T10:00:00.000Z",
          "updatedAt": "2026-08-05T10:00:00.000Z"
        },
        {
          "id": "0a1b2c3d-0000-4000-8000-000000000002",
          "purchasedAt": "2026-02-02",
          "capturedAt": "2026-02-02T18:30:00.000Z",
          "vendor": null,
          "vendorTaxNumber": null,
          "subtotalCents": null,
          "hstCents": null,
          "otherTaxCents": null,
          "totalCents": 4200,
          "currency": "CAD",
          "category": null,
          "paymentMethod": null,
          "isBusiness": false,
          "notes": null,
          "status": "pending",
          "createdAt": "2026-08-05T10:00:01.000Z",
          "updatedAt": "2026-08-05T10:00:01.000Z"
        }
      ],
      "nextCursor": "opaque-cursor-value"
    }
    """

    private let emptyPageJSON = #"{"receipts": [], "nextCursor": null}"#

    private let detailJSON = """
    {
      "id": "0a1b2c3d-0000-4000-8000-000000000001",
      "purchasedAt": "2026-03-20",
      "capturedAt": "2026-03-20T12:00:00.000Z",
      "vendor": "Synthetic Vendor Three",
      "vendorTaxNumber": null,
      "subtotalCents": 2500,
      "hstCents": 325,
      "otherTaxCents": 100,
      "totalCents": 2925,
      "currency": "CAD",
      "category": "meals",
      "paymentMethod": null,
      "isBusiness": true,
      "notes": null,
      "status": "confirmed",
      "createdAt": "2026-08-05T10:00:00.000Z",
      "updatedAt": "2026-08-05T10:00:00.000Z",
      "ocrRawText": "SYNTHETIC OCR TEXT\\nTOTAL 29.25",
      "images": [
        {"page": 1, "downloadUrl": "https://storage.example/presigned/abc"}
      ]
    }
    """

    private let signInJSON = """
    {
      "token": "issued-session-jwt",
      "user": {
        "id": "0a1b2c3d-0000-4000-8000-0000000000aa",
        "displayName": "Synthetic User A",
        "email": null
      }
    }
    """
}
