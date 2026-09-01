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

    override func setUp() async throws {
        try await super.setUp()
        transport = StubTransport()
        tokenStore = InMemoryTokenStore(stored: "stored-session-token")
        sessionRejections = 0
    }

    private func makeClient() throws -> APIClient {
        let baseURL = try XCTUnwrap(URL(string: "http://kept.test"))
        let relay = SessionRejectionRelay()
        relay.onSessionRejected = { [weak self] in
            self?.sessionRejections += 1
        }
        // The client retains the relay; nothing else needs to.
        return APIClient(
            baseURL: { baseURL },
            transport: transport,
            tokenStore: tokenStore,
            rejectionRelay: relay
        )
    }

    // MARK: - Transport configuration

    func testProductionTransportNeverUsesAnHTTPCache() {
        // A production-environment behaviour no request-level test can
        // see (the same lesson as the space-free test path and the
        // fabricated Vision geometry - framework §9.3 candidate 5): with
        // the default policy, CFNetwork heuristically cached list
        // responses and answered an OFFLINE pull-to-refresh with a stale
        // 200, so the failure UI never fired. The configuration is the
        // behaviour, so the configuration is what this asserts.
        let configuration = URLSessionTransport().session.configuration
        XCTAssertNil(configuration.urlCache)
        XCTAssertEqual(configuration.requestCachePolicy, .reloadIgnoringLocalCacheData)
        // And a fast honest failure instead of a minute of spinner: the
        // 60-second default read as a hang on the device's offline pass.
        // The outbox drains through this same transport, so the fix
        // covers its first upload attempt too.
        XCTAssertEqual(configuration.timeoutIntervalForRequest, 10)
    }

    // MARK: - Token attachment

    func testAuthenticatedRequestCarriesBearerToken() async throws {
        let client = try makeClient()
        transport.enqueue(status: 200, jsonBody: emptyPageJSON)

        _ = try await client.receiptsPage(cursor: nil, query: .default, limit: nil)

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
            _ = try await client.receiptsPage(cursor: nil, query: .default, limit: nil) as ReceiptListPage
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
            _ = try await client.receiptsPage(cursor: nil, query: .default, limit: nil)
            XCTFail("Expected a thrown APIError")
        } catch let APIError.unexpectedResponse(status) {
            XCTAssertEqual(status, 502)
        }
    }

    func testNetworkFailureMapsToNetworkError() async throws {
        let client = try makeClient()
        transport.enqueueFailure(URLError(.notConnectedToInternet))

        do {
            _ = try await client.receiptsPage(cursor: nil, query: .default, limit: nil)
            XCTFail("Expected a thrown APIError")
        } catch let APIError.network(urlError) {
            XCTAssertEqual(urlError.code, .notConnectedToInternet)
        }
    }

    func testUndecodableSuccessBodyThrowsUndecodableResponse() async throws {
        let client = try makeClient()
        transport.enqueue(status: 200, jsonBody: #"{"unexpected":"shape"}"#)

        do {
            _ = try await client.receiptsPage(cursor: nil, query: .default, limit: nil)
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
            _ = try await client.receiptsPage(cursor: nil, query: .default, limit: nil) as ReceiptListPage
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

        let page = try await client.receiptsPage(cursor: nil, query: .default, limit: nil)

        XCTAssertEqual(page.receipts.count, 2)
        XCTAssertEqual(page.nextCursor, "opaque-cursor-value")
        XCTAssertEqual(page.pendingCount, 7)

        let first = try XCTUnwrap(page.receipts.first)
        XCTAssertEqual(first.id, UUID(uuidString: "0a1b2c3d-0000-4000-8000-000000000001"))
        XCTAssertEqual(first.purchasedAt, "2026-03-20")
        XCTAssertEqual(first.vendor, "Synthetic Vendor Three")
        XCTAssertEqual(first.hstCents, 325)
        XCTAssertEqual(first.tipCents, 400)
        XCTAssertEqual(first.otherFeesCents, 150)
        XCTAssertEqual(first.totalCents, 2925)
        XCTAssertEqual(first.status, .confirmed)
        XCTAssertEqual(
            first.capturedAt,
            ISO8601DateFormatter().date(from: "2026-03-20T12:00:00Z")
        )

        let second = try XCTUnwrap(page.receipts.last)
        XCTAssertNil(second.vendor)
        XCTAssertNil(second.subtotalCents)
        XCTAssertNil(second.tipCents)
        XCTAssertNil(second.otherFeesCents)
        XCTAssertEqual(second.status, .pending)

        // suggestions: null (neither parser ever saw the receipt) and an
        // absent key both decode as nil - the server always sends the
        // key, but this client must not depend on that.
        XCTAssertNil(first.suggestions)
        XCTAssertNil(second.suggestions)
    }

    func testDecodesReceiptDetail() async throws {
        let client = try makeClient()
        transport.enqueue(status: 200, jsonBody: detailJSON)

        let detail = try await client.receiptDetail(
            id: try XCTUnwrap(UUID(uuidString: "0a1b2c3d-0000-4000-8000-000000000001"))
        )

        XCTAssertEqual(detail.receipt.vendor, "Synthetic Vendor Three")
        XCTAssertEqual(detail.receipt.totalCents, 2925)
        XCTAssertEqual(detail.receipt.tipCents, 400)
        XCTAssertEqual(detail.receipt.otherFeesCents, 150)
        XCTAssertEqual(detail.ocrRawText, "SYNTHETIC OCR TEXT\nTOTAL 29.25")

        // The served §7.3 merge, decoded from the exact wire shape - the
        // `source` markers are present on the wire and deliberately not
        // decoded (provenance stays in the API for diagnostics).
        let suggestions = try XCTUnwrap(detail.receipt.suggestions)
        XCTAssertEqual(suggestions.vendor.value, "Synthetic Vendor Three")
        XCTAssertEqual(suggestions.purchasedAt.value, "2026-03-20")
        XCTAssertTrue(suggestions.purchasedAt.disagreement)
        XCTAssertEqual(suggestions.totalCents.value, 2925)
        XCTAssertEqual(suggestions.hstCents.value, 325)
        XCTAssertFalse(suggestions.hstCents.disagreement)
        XCTAssertEqual(suggestions.tipCents.value, 400)
        // The no-fallthrough absence, exactly as served: {value: null,
        // source: null} must land as nil, the stated-absence prefill.
        XCTAssertNil(suggestions.subtotalCents.value)
        // The fixture also carries the server's transitional
        // `suggestions.vendorTaxNumber` shim, kept for the shipped 1.0 (1)
        // build. Decoding got this far with it present, which is the whole
        // assertion: this build ignores it rather than breaking on it.
        XCTAssertEqual(detail.images.count, 1)
        XCTAssertEqual(detail.images.first?.page, 1)
        XCTAssertEqual(
            detail.images.first?.downloadUrl,
            URL(string: "https://storage.example/presigned/abc")
        )
    }

    /// HST's disagreement flag (§7.3, 2026-08-28) decodes true when the
    /// wire sends it, exactly like `purchasedAt`'s - and the served value
    /// is unaffected, still the heuristic's.
    func testDecodesHstDisagreementFlag() async throws {
        let client = try makeClient()
        let jsonWithHstDisagreement = detailJSON.replacingOccurrences(
            of: #""hstCents": {"value": 325, "source": "heuristic", "disagreement": false}"#,
            with: #""hstCents": {"value": 325, "source": "heuristic", "disagreement": true}"#
        )
        transport.enqueue(status: 200, jsonBody: jsonWithHstDisagreement)

        let detail = try await client.receiptDetail(
            id: try XCTUnwrap(UUID(uuidString: "0a1b2c3d-0000-4000-8000-000000000001"))
        )

        let suggestions = try XCTUnwrap(detail.receipt.suggestions)
        XCTAssertTrue(suggestions.hstCents.disagreement)
        // Disagreement is a side channel; the served value never changes.
        XCTAssertEqual(suggestions.hstCents.value, 325)
    }

    /// The detail route orders `images` by page (routes/receipts.ts's
    /// `.orderBy(receiptImages.page)`); this pins that a multi-page
    /// receipt decodes every page, in that order, rather than only the
    /// first - the gap proposal #6 exists to close on the receipt detail
    /// screen.
    func testDecodesMultiPageImagesInOrder() async throws {
        let client = try makeClient()
        let twoPageJSON = detailJSON.replacingOccurrences(
            of: #"{"page": 1, "downloadUrl": "https://storage.example/presigned/abc"}"#,
            with: #"{"page": 1, "downloadUrl": "https://storage.example/presigned/abc"}, {"page": 2, "downloadUrl": "https://storage.example/presigned/page2"}"#
        )
        transport.enqueue(status: 200, jsonBody: twoPageJSON)

        let detail = try await client.receiptDetail(
            id: try XCTUnwrap(UUID(uuidString: "0a1b2c3d-0000-4000-8000-000000000001"))
        )

        XCTAssertEqual(detail.images.map(\.page), [1, 2])
        XCTAssertEqual(
            detail.images.map(\.downloadUrl),
            [
                URL(string: "https://storage.example/presigned/abc"),
                URL(string: "https://storage.example/presigned/page2"),
            ]
        )
    }

    // MARK: - Add a page / replace a page's image (proposal #6, 2026-08-28)

    func testAddReceiptImagePostsExactlyObjectKeyAndSha256ToTheImagesRoute() async throws {
        let client = try makeClient()
        let receiptId = try XCTUnwrap(UUID(uuidString: "0a1b2c3d-0000-4000-8000-000000000001"))
        let sha = String(repeating: "a", count: 64)
        transport.enqueue(status: 201, jsonBody: """
        {
          "id": "1a1b2c3d-0000-4000-8000-000000000002",
          "page": 2,
          "downloadUrl": "https://storage.example/presigned/page2",
          "createdAt": "2026-03-20T12:00:00.000Z"
        }
        """)

        let image = try await client.addReceiptImage(
            receiptId: receiptId,
            objectKey: "userid/2026/03/added.jpg",
            sha256: sha
        )

        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/receipts/\(receiptId.uuidString.lowercased())/images")
        let body = try XCTUnwrap(request.httpBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(Set(json.keys), ["objectKey", "sha256"])
        XCTAssertEqual(json["objectKey"] as? String, "userid/2026/03/added.jpg")
        XCTAssertEqual(json["sha256"] as? String, sha)
        // The response decodes through the same ReceiptImage the detail
        // route uses (page + downloadUrl); the extra id/createdAt keys
        // the server also sends are simply not declared, and are ignored
        // rather than failing decode.
        XCTAssertEqual(image.page, 2)
        XCTAssertEqual(image.downloadUrl, URL(string: "https://storage.example/presigned/page2"))
    }

    func testReplaceReceiptImagePutsToTheGivenPageAndAcceptsExactlyObjectKeyAndSha256() async throws {
        let client = try makeClient()
        let receiptId = try XCTUnwrap(UUID(uuidString: "0a1b2c3d-0000-4000-8000-000000000001"))
        let sha = String(repeating: "b", count: 64)
        transport.enqueue(status: 200, jsonBody: """
        {
          "id": "1a1b2c3d-0000-4000-8000-000000000003",
          "page": 1,
          "downloadUrl": "https://storage.example/presigned/page1-new",
          "createdAt": "2026-03-20T12:00:00.000Z"
        }
        """)

        let image = try await client.replaceReceiptImage(
            receiptId: receiptId,
            page: 1,
            objectKey: "userid/2026/03/replaced.jpg",
            sha256: sha
        )

        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.httpMethod, "PUT")
        XCTAssertEqual(request.url?.path, "/api/receipts/\(receiptId.uuidString.lowercased())/images/1")
        let body = try XCTUnwrap(request.httpBody)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(Set(json.keys), ["objectKey", "sha256"])
        XCTAssertEqual(json["objectKey"] as? String, "userid/2026/03/replaced.jpg")
        XCTAssertEqual(json["sha256"] as? String, sha)
        XCTAssertEqual(image.page, 1)
        XCTAssertEqual(image.downloadUrl, URL(string: "https://storage.example/presigned/page1-new"))
    }

    /// The server's own duplicate-image wording (routes/receipts.ts's
    /// `duplicateImageError()`), surfaced verbatim through the same error
    /// mapping every other endpoint uses - no bespoke handling for these
    /// two routes.
    func testAddReceiptImageSurfacesTheServersDuplicateImage409() async throws {
        let client = try makeClient()
        transport.enqueue(
            status: 409,
            jsonBody: #"""
            {"error":{"code":"duplicate_image","message":"An identical image is already attached to one of your receipts"}}
            """#
        )

        do {
            _ = try await client.addReceiptImage(receiptId: UUID(), objectKey: "k", sha256: String(repeating: "a", count: 64))
            XCTFail("Expected a thrown APIError")
        } catch let APIError.requestFailed(code, message, status) {
            XCTAssertEqual(code, "duplicate_image")
            XCTAssertEqual(message, "An identical image is already attached to one of your receipts")
            XCTAssertEqual(status, 409)
        }
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

        let page = try await client.receiptsPage(cursor: nil, query: .default, limit: nil)

        XCTAssertEqual(
            page.receipts.first?.capturedAt,
            ISO8601DateFormatter().date(from: "2026-03-20T12:00:00Z")
        )
    }

    func testListQueryItemsAreBuiltFromParameters() async throws {
        let client = try makeClient()
        transport.enqueue(status: 200, jsonBody: emptyPageJSON)

        _ = try await client.receiptsPage(
            cursor: "cursor-1",
            query: ReceiptQuery(
                search: "  maple  ",
                status: .pending,
                category: "Office supplies",
                paymentMethod: "Visa ending 3735",
                from: "2026-01-01",
                to: "2026-03-31",
                sort: .total,
                order: .asc
            ),
            limit: 200
        )

        let url = try XCTUnwrap(transport.requests.first?.url)
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.path, "/api/receipts")
        let items = try XCTUnwrap(components.queryItems)
        XCTAssertEqual(items.first { $0.name == "cursor" }?.value, "cursor-1")
        XCTAssertEqual(items.first { $0.name == "q" }?.value, "maple") // trimmed
        XCTAssertEqual(items.first { $0.name == "status" }?.value, "pending")
        // Free text, sent exactly as stored - the server matches it
        // literally, and normalizing here would silently miss a category
        // the person actually typed.
        XCTAssertEqual(items.first { $0.name == "category" }?.value, "Office supplies")
        XCTAssertEqual(items.first { $0.name == "paymentMethod" }?.value, "Visa ending 3735")
        // Inclusive purchased_at bounds, in the API's own yyyy-mm-dd.
        XCTAssertEqual(items.first { $0.name == "from" }?.value, "2026-01-01")
        XCTAssertEqual(items.first { $0.name == "to" }?.value, "2026-03-31")
        XCTAssertEqual(items.first { $0.name == "sort" }?.value, "total")
        XCTAssertEqual(items.first { $0.name == "order" }?.value, "asc")
        XCTAssertEqual(items.first { $0.name == "limit" }?.value, "200")
    }

    /// One end of a range on its own is a legitimate question ("everything
    /// since April"), and the other end must then be absent rather than
    /// sent empty - the server's schema is strict.
    func testHalfOpenDateRangesSendOnlyTheBoundThatIsSet() async throws {
        let client = try makeClient()
        transport.enqueue(status: 200, jsonBody: emptyPageJSON)

        _ = try await client.receiptsPage(
            cursor: nil,
            query: ReceiptQuery(from: "2026-04-01"),
            limit: nil
        )

        let url = try XCTUnwrap(transport.requests.first?.url)
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        let items = try XCTUnwrap(components.queryItems)
        XCTAssertEqual(items.map(\.name).sorted(), ["from", "order", "sort"])
        XCTAssertEqual(items.first { $0.name == "from" }?.value, "2026-04-01")
    }

    func testTheDefaultListQuerySendsOnlyTheOrderingItPinsOn() async throws {
        // Blank search, no filters: `q` must be absent rather than empty
        // (the server's minimum length is 1 and would reject ""), while
        // sort and order are always sent - the cursor encodes what it was
        // minted under, so the client states its ordering rather than
        // trusting the server's default to keep matching.
        let client = try makeClient()
        transport.enqueue(status: 200, jsonBody: emptyPageJSON)

        _ = try await client.receiptsPage(cursor: nil, query: .default, limit: nil)

        let url = try XCTUnwrap(transport.requests.first?.url)
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        let items = try XCTUnwrap(components.queryItems)
        XCTAssertEqual(items.map(\.name).sorted(), ["order", "sort"])
        XCTAssertEqual(items.first { $0.name == "sort" }?.value, "purchasedAt")
        XCTAssertEqual(items.first { $0.name == "order" }?.value, "desc")
    }

    func testDecodesReceiptOptions() async throws {
        let client = try makeClient()
        transport.enqueue(status: 200, jsonBody: optionsJSON)

        let options = try await client.receiptOptions()

        XCTAssertEqual(transport.requests.first?.url?.path, "/api/receipts/options")
        // Most recently used first, and free text verbatim - the doubled
        // space in "Office  supplies" is the user's own data (2026-08-26
        // ruling) and must survive the round trip untouched.
        XCTAssertEqual(options.categories, ["Office  supplies", "meals"])
        XCTAssertEqual(options.paymentMethods, ["Visa"])
        // Vendors joined the other two 2026-08-28, same derivation and
        // ordering.
        XCTAssertEqual(options.vendors, ["Food Basics", "Maple Foods Market"])
    }

    func testAnAccountWithNothingUsedYetDecodesAsEmptyNotAFailure() async throws {
        let client = try makeClient()
        transport.enqueue(
            status: 200,
            jsonBody: #"{"categories": [], "paymentMethods": [], "vendors": []}"#
        )

        let options = try await client.receiptOptions()

        XCTAssertTrue(options.isEmpty)
    }

    // MARK: - Possible duplicates (proposal #8, 2026-08-28)

    func testPossibleDuplicatesQueryItemsIncludeVendorAndExcludeIdWhenGiven() async throws {
        let client = try makeClient()
        transport.enqueue(status: 200, jsonBody: #"{"receipts": []}"#)

        _ = try await client.possibleDuplicates(
            purchasedAt: "2026-04-01",
            totalCents: 550,
            vendor: "Tim Hortons",
            excludeId: try XCTUnwrap(UUID(uuidString: "0A1B2C3D-0000-4000-8000-000000000001"))
        )

        let url = try XCTUnwrap(transport.requests.first?.url)
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        XCTAssertEqual(components.path, "/api/receipts/possible-duplicates")
        let items = try XCTUnwrap(components.queryItems)
        XCTAssertEqual(items.first { $0.name == "purchasedAt" }?.value, "2026-04-01")
        XCTAssertEqual(items.first { $0.name == "totalCents" }?.value, "550")
        XCTAssertEqual(items.first { $0.name == "vendor" }?.value, "Tim Hortons")
        // Lowercased to match the server's canonical uuid form, the same
        // rule receiptDetail(id:) already follows.
        XCTAssertEqual(
            items.first { $0.name == "excludeId" }?.value,
            "0a1b2c3d-0000-4000-8000-000000000001"
        )
    }

    /// `vendor` and `excludeId` are both optional server-side (the null-
    /// vendor-matches-null-vendor rule, and a capture-time confirm with no
    /// receipt to exclude) - sent only when present, never as an empty
    /// string or a literal "null".
    func testPossibleDuplicatesOmitsVendorAndExcludeIdWhenNil() async throws {
        let client = try makeClient()
        transport.enqueue(status: 200, jsonBody: #"{"receipts": []}"#)

        _ = try await client.possibleDuplicates(
            purchasedAt: "2026-04-01",
            totalCents: 550,
            vendor: nil,
            excludeId: nil
        )

        let url = try XCTUnwrap(transport.requests.first?.url)
        let components = try XCTUnwrap(URLComponents(url: url, resolvingAgainstBaseURL: false))
        let items = try XCTUnwrap(components.queryItems)
        XCTAssertEqual(items.map(\.name).sorted(), ["purchasedAt", "totalCents"])
    }

    func testDecodesPossibleDuplicatesReceipts() async throws {
        let client = try makeClient()
        transport.enqueue(status: 200, jsonBody: possibleDuplicatesJSON)

        let matches = try await client.possibleDuplicates(
            purchasedAt: "2026-04-01",
            totalCents: 550,
            vendor: "Tim Hortons",
            excludeId: nil
        )

        XCTAssertEqual(matches.count, 1)
        // The same `receiptResponse` shape every other route serves - this
        // is a plain decode test, not a duplicate-matching test (the
        // server owns that logic; server/tests/integration/
        // possibleDuplicates.test.ts covers it).
        XCTAssertEqual(matches.first?.vendor, "Tim Hortons")
        XCTAssertEqual(matches.first?.purchasedAt, "2026-04-01")
        XCTAssertEqual(matches.first?.totalCents, 550)
    }

    // MARK: - Swipe actions (proposal #9, 2026-08-28)

    /// The two things that matter about this request (rewritten
    /// 2026-09-01): it carries the values the ROW was showing - the served
    /// merge, not the stored column, which is the bug this replaced - and
    /// it carries them as ABSENT keys where the row shows nothing, never
    /// explicit nulls, so a swipe cannot clear a field it never rendered.
    func testQuickConfirmReceiptPatchesTheDisplayedValuesWithTheStatus() async throws {
        let client = try makeClient()
        let id = try XCTUnwrap(UUID(uuidString: "0a1b2c3d-0000-4000-8000-000000000001"))
        transport.enqueue(status: 200, jsonBody: singleReceiptJSON)
        // A pending row whose served merge disagrees with its stored
        // column on the vendor and the total - the Jimmy the Greek shape.
        let row = Fixtures.receipt(
            id: id,
            purchasedAt: "2026-08-01",
            vendor: "In Store 392",
            totalCents: nil,
            status: .pending,
            suggestions: Fixtures.merged(
                vendor: "JIMMY THE GREEK",
                purchasedAt: "2026-08-29",
                totalCents: 1749,
                hstCents: 201
            )
        )

        let receipt = try await client.quickConfirmReceipt(id: id, QuickConfirmRequest(displaying: row))

        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.httpMethod, "PATCH")
        XCTAssertEqual(request.url?.path, "/api/receipts/\(id.uuidString.lowercased())")
        let body = try XCTUnwrap(request.httpBody)
        let decoded = try XCTUnwrap(
            JSONSerialization.jsonObject(with: body) as? [String: Any]
        )
        XCTAssertEqual(decoded["status"] as? String, "confirmed")
        XCTAssertEqual(decoded["vendor"] as? String, "JIMMY THE GREEK")
        XCTAssertEqual(decoded["purchasedAt"] as? String, "2026-08-29")
        XCTAssertEqual(decoded["totalCents"] as? Int, 1749)
        XCTAssertEqual(decoded["hstCents"] as? Int, 201)
        XCTAssertFalse(decoded.keys.contains("subtotalCents"), "an absent value is an absent key, never a null")
        XCTAssertFalse(decoded.keys.contains("tipCents"))
        XCTAssertEqual(receipt.id, id)
        XCTAssertEqual(receipt.status, .confirmed)
    }

    // MARK: - The capture-time second opinion (2026-09-01)

    /// POST /api/receipts/parse: the OCR text and the capture instant go
    /// up, the suggestion set comes back, and nothing is written.
    func testParseReceiptTextPostsTheTextAndTheCaptureInstant() async throws {
        let client = try makeClient()
        transport.enqueue(status: 200, jsonBody: """
        {
          "suggestions": {
            "vendor": "JIMMY THE GREEK", "purchasedAt": "2026-08-29",
            "totalCents": 1750, "hstCents": 201, "subtotalCents": 1549,
            "tipCents": null, "otherFeesCents": null,
            "paymentMethod": "MASTERCARD", "vendorTaxNumber": null
          },
          "model": "claude-sonnet-5", "promptVersion": 3
        }
        """)

        let result = try await client.parseReceiptText(
            ocrRawText: "TOTAL 17.50",
            capturedAt: Date(timeIntervalSince1970: 1_788_264_000)
        )

        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/receipts/parse")
        let body = try XCTUnwrap(request.httpBody)
        let decoded = try XCTUnwrap(JSONSerialization.jsonObject(with: body) as? [String: Any])
        XCTAssertEqual(decoded["ocrRawText"] as? String, "TOTAL 17.50")
        XCTAssertNotNil(decoded["capturedAt"] as? String, "the instant rides along, with its offset")
        XCTAssertEqual(result.suggestions.vendor, "JIMMY THE GREEK")
        XCTAssertEqual(result.model, "claude-sonnet-5")
    }

    /// The two "not now" answers become their own error type, so the
    /// capture screen can stay silent about them in its own vocabulary
    /// rather than matching on a string code.
    func testParseUnavailableAndParseFailedBecomeTypedErrors() async throws {
        let client = try makeClient()

        transport.enqueue(
            status: 503,
            jsonBody: #"{"error":{"code":"parse_unavailable","message":"no model key configured"}}"#
        )
        do {
            _ = try await client.parseReceiptText(ocrRawText: "x", capturedAt: Date())
            XCTFail("expected parse_unavailable to throw")
        } catch let error as ServerParseError {
            XCTAssertEqual(error, .unavailable)
        }

        transport.enqueue(
            status: 502,
            jsonBody: #"{"error":{"code":"parse_failed","message":"the model failed"}}"#
        )
        do {
            _ = try await client.parseReceiptText(ocrRawText: "x", capturedAt: Date())
            XCTFail("expected parse_failed to throw")
        } catch let error as ServerParseError {
            XCTAssertEqual(error, .failed)
        }
    }

    /// Anything else stays an APIError - a 401 must still tear the session
    /// down rather than being swallowed as "the parser is busy".
    func testAnUnrelatedParseFailureIsStillAnAPIError() async throws {
        let client = try makeClient()
        transport.enqueue(status: 401, jsonBody: #"{"error":{"code":"unauthorized","message":"nope"}}"#)

        do {
            _ = try await client.parseReceiptText(ocrRawText: "x", capturedAt: Date())
            XCTFail("expected a session rejection")
        } catch let error as APIError {
            guard case .sessionRejected = error else {
                return XCTFail("expected sessionRejected, got \(error)")
            }
        }
        XCTAssertEqual(sessionRejections, 1)
    }

    func testRestoreReceiptPostsWithNoBodyToTheRestoreRoute() async throws {
        let client = try makeClient()
        let id = try XCTUnwrap(UUID(uuidString: "0a1b2c3d-0000-4000-8000-000000000001"))
        transport.enqueue(status: 200, jsonBody: singleReceiptJSON)

        let receipt = try await client.restoreReceipt(id: id)

        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.httpMethod, "POST")
        XCTAssertEqual(request.url?.path, "/api/receipts/\(id.uuidString.lowercased())/restore")
        XCTAssertNil(request.httpBody, "the restore route reads nothing beyond the id and the session")
        XCTAssertEqual(receipt.id, id)
    }

    /// The server's own 409 `restore_conflict` wording (routes/receipts.ts
    /// `restoreConflictError()`), surfaced through the identical error
    /// mapping every other endpoint uses - never reworded by this client
    /// (spec: surface it verbatim).
    func testRestoreReceiptSurfacesTheRestoreConflict409Verbatim() async throws {
        let client = try makeClient()
        let message = "This receipt can't be restored: one of its images was re-captured " +
            "onto a different receipt after this one was deleted, so restoring " +
            "it would collide with that receipt's live image. Delete or replace " +
            "the other receipt's image first, or leave this receipt deleted."
        transport.enqueue(
            status: 409,
            jsonBody: #"{"error":{"code":"restore_conflict","message":"\#(message)"}}"#
        )

        do {
            _ = try await client.restoreReceipt(id: UUID())
            XCTFail("Expected the conflict to be thrown")
        } catch APIError.requestFailed(let code, let receivedMessage, let status) {
            XCTAssertEqual(code, "restore_conflict")
            XCTAssertEqual(receivedMessage, message)
            XCTAssertEqual(status, 409)
        }
    }

    // MARK: - Profile (proposal #10, 2026-08-28)

    func testFetchProfileDecodesTheFiscalYearEndFields() async throws {
        let client = try makeClient()
        transport.enqueue(status: 200, jsonBody: """
        {
          "id": "0a1b2c3d-0000-4000-8000-000000000009",
          "displayName": "the second user",
          "email": "second-user@example.com",
          "fiscalYearEndMonth": 6,
          "fiscalYearEndDay": 30
        }
        """)

        let profile = try await client.fetchProfile()

        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.url?.path, "/api/me")
        XCTAssertEqual(profile.displayName, "the second user")
        XCTAssertEqual(profile.fiscalYearEndMonth, 6)
        XCTAssertEqual(profile.fiscalYearEndDay, 30)
    }

    // MARK: - Managing the reusable values (2026-09-01)

    func testRenamingAnOptionPATCHesTheFieldPathWithBothValues() async throws {
        let client = try makeClient()
        transport.enqueue(status: 200, jsonBody: #"{"receiptsUpdated":12}"#)

        let updated = try await client.renameReceiptOption(
            field: .paymentMethod,
            from: "Visa ",
            to: "Visa"
        )

        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.httpMethod, "PATCH")
        // The `:field` segment is the server's own API name, not the
        // stored column ("paymentMethod", never "payment_method").
        XCTAssertEqual(request.url?.path, "/api/receipts/options/paymentMethod")
        // Decoded rather than string-compared: JSONEncoder does not
        // promise key order, and a test that depended on it would fail on
        // a run that happened to emit `to` first (it did).
        let body = try XCTUnwrap(request.httpBody)
        let fields = try JSONDecoder().decode([String: String].self, from: body)
        XCTAssertEqual(fields, ["from": "Visa ", "to": "Visa"])
        XCTAssertEqual(updated, 12)
    }

    func testDeletingAnOptionSendsTheValueAsAnEncodedQueryParameter() async throws {
        let client = try makeClient()
        transport.enqueue(status: 204, jsonBody: "")

        try await client.deleteReceiptOption(field: .vendor, value: "Bob & Sons #2")

        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.httpMethod, "DELETE")
        XCTAssertEqual(request.url?.path, "/api/receipts/options/vendor")
        // Percent-encoded by URLQueryItem, so a vendor with an ampersand
        // or a hash in it reaches the server as the stored string
        // verbatim - which is what the route matches on.
        let components = try XCTUnwrap(
            URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false)
        )
        XCTAssertEqual(
            components.queryItems,
            [URLQueryItem(name: "value", value: "Bob & Sons #2")]
        )
        XCTAssertNil(request.httpBody, "a DELETE in this API carries no body")
    }

    /// 404 when `from` is not one of the caller's own values - surfaced as
    /// the server's own message, which is what the screen shows.
    func testARenameOfAValueTheUserDoesNotHaveSurfacesTheServersMessage() async throws {
        let client = try makeClient()
        transport.enqueue(
            status: 404,
            jsonBody: #"{"error":{"code":"not_found","message":"Receipt not found"}}"#
        )

        do {
            _ = try await client.renameReceiptOption(field: .category, from: "nope", to: "x")
            XCTFail("Expected a thrown APIError")
        } catch APIError.requestFailed(let code, let message, let status) {
            XCTAssertEqual(code, "not_found")
            XCTAssertEqual(message, "Receipt not found")
            XCTAssertEqual(status, 404)
        }
    }

    // MARK: - Account deletion

    func testDeleteAccountSendsTheCodeAndAcceptsAnEmpty204() async throws {
        // 204 No Content is the server's success shape. A client that ran
        // the JSON decoder over it would turn the right answer into
        // .undecodableResponse, which is why `delete` bypasses decoding.
        let client = try makeClient()
        transport.enqueue(status: 204, jsonBody: "")

        try await client.deleteAccount(appleAuthorizationCode: "fresh-code")

        let request = try XCTUnwrap(transport.requests.first)
        XCTAssertEqual(request.httpMethod, "DELETE")
        XCTAssertEqual(request.url?.path, "/api/me")
        XCTAssertEqual(
            request.value(forHTTPHeaderField: "Authorization"),
            "Bearer stored-session-token"
        )
        let body = try XCTUnwrap(request.httpBody)
        XCTAssertEqual(
            String(decoding: body, as: UTF8.self),
            #"{"appleAuthorizationCode":"fresh-code"}"#
        )
    }

    func testDeleteAccountWithoutACodeOmitsTheKeyRatherThanSendingNull() async throws {
        // The server's schema is strict: it allows an ABSENT
        // appleAuthorizationCode and rejects an explicit null, so an
        // encoder that wrote `null` would 400 the one deletion that most
        // needs to succeed.
        let client = try makeClient()
        transport.enqueue(status: 204, jsonBody: "")

        try await client.deleteAccount(appleAuthorizationCode: nil)

        let request = try XCTUnwrap(transport.requests.first)
        let body = try XCTUnwrap(request.httpBody)
        XCTAssertEqual(String(decoding: body, as: UTF8.self), "{}")
    }

    func testDeleteAccountSurfacesTheServersRefusal() async throws {
        let client = try makeClient()
        transport.enqueue(
            status: 400,
            jsonBody: #"{"error":{"code":"invalid_request","message":"Unrecognized key"}}"#
        )

        do {
            try await client.deleteAccount(appleAuthorizationCode: nil)
            XCTFail("Expected the refusal to be thrown")
        } catch APIError.requestFailed(let code, let message, let status) {
            XCTAssertEqual(code, "invalid_request")
            XCTAssertEqual(message, "Unrecognized key")
            XCTAssertEqual(status, 400)
        }
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

    /// One bare `receiptResponse` - what `PATCH .../:id`,
    /// `POST .../:id/restore` and the other single-receipt routes answer
    /// with, outside a list envelope.
    private let singleReceiptJSON = """
    {
      "id": "0a1b2c3d-0000-4000-8000-000000000001",
      "purchasedAt": "2026-03-20",
      "capturedAt": "2026-03-20T12:00:00.000Z",
      "vendor": "Staples",
      "subtotalCents": 2500,
      "hstCents": 325,
      "tipCents": null,
      "otherFeesCents": null,
      "totalCents": 2925,
      "currency": "CAD",
      "category": "office",
      "paymentMethod": "Visa",
      "notes": null,
      "status": "confirmed",
      "suggestions": null,
      "createdAt": "2026-08-05T10:00:00.000Z",
      "updatedAt": "2026-08-05T10:00:00.000Z"
    }
    """

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
          "subtotalCents": 2500,
          "hstCents": 325,
          "tipCents": 400,
          "otherFeesCents": 150,
          "totalCents": 2925,
          "currency": "CAD",
          "category": "meals",
          "paymentMethod": null,
          "notes": "synthetic note",
          "status": "confirmed",
          "suggestions": null,
          "createdAt": "2026-08-05T10:00:00.000Z",
          "updatedAt": "2026-08-05T10:00:00.000Z"
        },
        {
          "id": "0a1b2c3d-0000-4000-8000-000000000002",
          "purchasedAt": "2026-02-02",
          "capturedAt": "2026-02-02T18:30:00.000Z",
          "vendor": null,
          "subtotalCents": null,
          "hstCents": null,
          "tipCents": null,
          "otherFeesCents": null,
          "totalCents": 4200,
          "currency": "CAD",
          "category": null,
          "paymentMethod": null,
          "notes": null,
          "status": "pending",
          "createdAt": "2026-08-05T10:00:01.000Z",
          "updatedAt": "2026-08-05T10:00:01.000Z"
        }
      ],
      "nextCursor": "opaque-cursor-value",
      "pendingCount": 7
    }
    """

    private let emptyPageJSON = #"{"receipts": [], "nextCursor": null, "pendingCount": 0}"#

    /// GET /api/receipts/possible-duplicates's wire shape (proposal #8,
    /// 2026-08-28) - the same `receiptResponse` projection every other
    /// route serves, just under a bare `{receipts: [...]}` with no cursor
    /// or pending count (an exact-match query has no pages to turn).
    private let possibleDuplicatesJSON = """
    {
      "receipts": [
        {
          "id": "0a1b2c3d-0000-4000-8000-000000000001",
          "purchasedAt": "2026-04-01",
          "capturedAt": "2026-04-01T12:00:00.000Z",
          "vendor": "Tim Hortons",
          "subtotalCents": 500,
          "hstCents": 50,
          "tipCents": null,
          "otherFeesCents": null,
          "totalCents": 550,
          "currency": "CAD",
          "category": null,
          "paymentMethod": null,
          "notes": null,
          "status": "pending",
          "suggestions": null,
          "createdAt": "2026-08-05T10:00:00.000Z",
          "updatedAt": "2026-08-05T10:00:00.000Z"
        }
      ]
    }
    """

    /// The detail response as the server serves it after the 2026-08-26
    /// field reduction - including `suggestions.vendorTaxNumber`, which the
    /// server keeps as a served absence so the shipped 1.0 (1) build, which
    /// decodes that key non-optionally, keeps working. This build declares
    /// no such property, and an undeclared key is simply not decoded: the
    /// fixture carries it to prove that tolerance, not to describe a field
    /// this client has.
    private let detailJSON = """
    {
      "id": "0a1b2c3d-0000-4000-8000-000000000001",
      "purchasedAt": "2026-03-20",
      "capturedAt": "2026-03-20T12:00:00.000Z",
      "vendor": "Synthetic Vendor Three",
      "subtotalCents": 2500,
      "hstCents": 325,
      "tipCents": 400,
      "otherFeesCents": 150,
      "totalCents": 2925,
      "currency": "CAD",
      "category": "meals",
      "paymentMethod": null,
      "notes": null,
      "status": "confirmed",
      "suggestions": {
        "vendor": {"value": "Synthetic Vendor Three", "source": "llm"},
        "purchasedAt": {"value": "2026-03-20", "source": "heuristic", "disagreement": true},
        "totalCents": {"value": 2925, "source": "heuristic"},
        "hstCents": {"value": 325, "source": "heuristic", "disagreement": false},
        "subtotalCents": {"value": null, "source": null},
        "tipCents": {"value": 400, "source": "heuristic"},
        "vendorTaxNumber": {"value": null}
      },
      "createdAt": "2026-08-05T10:00:00.000Z",
      "updatedAt": "2026-08-05T10:00:00.000Z",
      "ocrRawText": "SYNTHETIC OCR TEXT\\nTOTAL 29.25",
      "images": [
        {"page": 1, "downloadUrl": "https://storage.example/presigned/abc"}
      ]
    }
    """

    /// GET /api/receipts/options, most-recently-used first.
    private let optionsJSON = """
    {
      "categories": ["Office  supplies", "meals"],
      "paymentMethods": ["Visa"],
      "vendors": ["Food Basics", "Maple Foods Market"]
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
