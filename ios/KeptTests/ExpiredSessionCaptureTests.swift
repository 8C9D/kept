import XCTest
@testable import Kept

/// Work in progress on a session the server has stopped honouring, end to
/// end: the real `APIClient`, `SessionController`, `CaptureFlowModel`,
/// `ConfirmReceiptModel` and `OutboxController` wired the way
/// `AppEnvironment` wires them, with only the transport scripted
/// (2026-10-31).
///
/// The 30-day token has no refresh, so this is a certainty rather than an
/// edge case. Each unit below it is tested on its own; what those cannot
/// show is the handoff: a 401 inside the second opinion, a 401 from the
/// drain behind the cover, a Save with the session already dead, a sign-in,
/// and the receipt arriving.
@MainActor
final class ExpiredSessionCaptureTests: XCTestCase {
    private nonisolated static let user = UUID(uuidString: "aaaaaaaa-1111-2222-3333-444444444444")!
    private nonisolated static let captureInstant = Date(timeIntervalSince1970: 1_775_000_000)

    /// A transport that answers by route, because the drain and the second
    /// opinion interleave and a scripted order would pin an accident.
    private final class RoutingTransport: HTTPTransport, @unchecked Sendable {
        var signedIn = false
        /// Who the Apple sign-in route says this person is.
        var appleUserId = ExpiredSessionCaptureTests.user
        private(set) var paths: [String] = []
        private let lock = NSLock()

        func send(_ request: URLRequest) async throws -> (data: Data, response: HTTPURLResponse) {
            let url = try XCTUnwrap(request.url)
            lock.withLock { paths.append(url.path()) }
            let (status, body) = route(url.path(), bearer: request.value(forHTTPHeaderField: "Authorization"))
            let response = try XCTUnwrap(HTTPURLResponse(
                url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: nil
            ))
            return (Data(body.utf8), response)
        }

        private func route(_ path: String, bearer: String?) -> (Int, String) {
            if path == "/api/auth/apple" {
                return (200, #"{"token":"\#(ExpiredSessionCaptureTests.freshToken)","user":{"id":"\#(appleUserId.uuidString.lowercased())","displayName":null,"email":null}}"#)
            }
            if path.hasPrefix("/put/") { return (200, "") }
            guard bearer == "Bearer \(ExpiredSessionCaptureTests.freshToken)" else {
                return (401, #"{"error":{"code":"unauthorized","message":"A valid session token is required"}}"#)
            }
            switch path {
            case "/api/receipts/upload-url":
                return (200, #"{"objectKey":"k","uploadUrl":"https://storage.example/put/k"}"#)
            case "/api/receipts":
                return (201, ExpiredSessionCaptureTests.createdReceiptJSON)
            case let path where path.hasPrefix("/api/receipts/"):
                return (200, ExpiredSessionCaptureTests.createdReceiptJSON)
            default:
                return (404, #"{"error":{"code":"not_found","message":"no"}}"#)
            }
        }
    }

    private nonisolated static let expiredToken = TestTokens.sessionToken(
        sub: user.uuidString.lowercased(),
        filler: "expired"
    )
    private nonisolated static let freshToken = TestTokens.sessionToken(
        sub: user.uuidString.lowercased(),
        filler: "fresh"
    )

    private nonisolated static let createdReceiptJSON = #"""
    {"id":"0a1b2c3d-0000-4000-8000-000000000001","purchasedAt":"2026-01-14",
     "capturedAt":"2026-01-14T10:00:00.000Z","vendor":null,"subtotalCents":null,"hstCents":null,
     "tipCents":null,"otherFeesCents":null,"totalCents":11300,"currency":"CAD","category":null,
     "paymentMethod":null,"notes":null,"status":"confirmed","suggestions":null,
     "createdAt":"2026-01-14T10:00:00.000Z","updatedAt":"2026-01-14T10:00:00.000Z"}
    """#

    private nonisolated static let parsedText = RecognizedText(lines: [
        RecognizedLine(text: "MAPLE FOODS MARKET", verticalCenter: 0.05, height: 0.04),
        RecognizedLine(text: "TOTAL 113.00", verticalCenter: 0.80, height: 0.02),
    ])

    private var transport: RoutingTransport!
    private var tokenStore: InMemoryTokenStore!
    private var store: InMemoryOutboxStore!
    private var session: SessionController!
    private var outbox: OutboxController!
    private var api: APIClient!
    private var defaultsSuite = ""

    override func setUp() async throws {
        try await super.setUp()
        transport = RoutingTransport()
        tokenStore = InMemoryTokenStore(stored: Self.expiredToken)
        store = InMemoryOutboxStore()
        let relay = SessionRejectionRelay()
        api = APIClient(
            baseURL: { URL(string: "http://kept.test")! },
            transport: transport,
            tokenStore: tokenStore,
            rejectionRelay: relay
        )
        defaultsSuite = "ExpiredSessionCaptureTests-\(UUID().uuidString)"
        let eventLogger = EventLogger(api: api)
        session = SessionController(
            api: api,
            tokenStore: tokenStore,
            reauthorization: StubAppleReauthorization(),
            eventLogger: eventLogger,
            defaults: UserDefaults(suiteName: defaultsSuite) ?? .standard
        )
        outbox = OutboxController(
            store: store,
            api: api,
            recognizer: StubTextRecognizer(repeating: Self.parsedText, count: 3),
            tokenStore: tokenStore,
            connectivity: StubConnectivityMonitor(),
            backgroundContinuation: StubBackgroundContinuation(),
            knownVendors: { [] },
            now: { Self.captureInstant }
        )
        // The same three wires AppEnvironment makes.
        relay.onSessionRejected = { [weak session] in session?.handleSessionRejected() }
        session.onSignedIn = { [weak outbox] in outbox?.externalTrigger() }
        session.onSignedOut = { [weak outbox] in outbox?.sessionDidEnd() }
    }

    override func tearDown() async throws {
        UserDefaults.standard.removePersistentDomain(forName: defaultsSuite)
        try await super.tearDown()
    }

    private func settleDrain() async {
        while outbox.isDraining {
            await Task.yield()
        }
    }

    private func waitUntil(_ condition: () -> Bool, _ message: String) async {
        let deadline = Date().addingTimeInterval(2)
        while !condition(), Date() < deadline {
            await Task.yield()
            try? await Task.sleep(nanoseconds: 2_000_000)
        }
        XCTAssertTrue(condition(), message)
    }

    private func capture() -> CaptureFlowModel {
        let api: APIClient = self.api
        return CaptureFlowModel(
            outbox: outbox,
            recognizer: StubTextRecognizer(repeating: Self.parsedText, count: 3),
            remoteParse: { rawText, capturedAt in
                try await api.parseReceiptText(ocrRawText: rawText, capturedAt: capturedAt)
                    .suggestions.asReceiptSuggestions
            },
            now: { Self.captureInstant }
        )
    }

    func testAConfirmedCaptureOnADeadSessionLandsInTheOutboxAndUploadsAfterSignIn() async throws {
        session.beginHold()
        let flow = capture()

        // The second opinion fires as the form opens and answers 401.
        await flow.savePages([Data("the only copy of this scan".utf8)])
        await waitUntil(
            { self.transport.paths.contains("/api/receipts/parse") },
            "the second opinion never went out"
        )
        guard case .confirming(let form) = flow.phase else {
            return XCTFail("Expected confirming, got \(flow.phase)")
        }
        XCTAssertEqual(session.state, .signedIn, "the screen holding the scan is still up")

        // A person finishes and saves. The disk write is the save, whatever
        // the session is doing.
        form.totalText = "113.00"
        let saved = await form.save()
        XCTAssertTrue(saved, "the save never waits on the network")
        XCTAssertEqual(store.items.count, 1, "on the phone, not on the floor")
        await settleDrain()
        XCTAssertEqual(store.items.values.first?.blockedMessage, nil)

        // The drain got its own 401; held until the cover has gone.
        XCTAssertEqual(session.state, .signedIn)
        flow.finishSingleCapture()
        session.endHold()

        XCTAssertEqual(session.state, .signedOut)
        XCTAssertEqual(session.signInMessage, "Your session has expired. Sign in again.")
        XCTAssertEqual(store.items.count, 1, "and a sign-out does not touch the queue")

        // Sign-in is the trigger, and the receipt arrives under the new token.
        await session.signIn(identityToken: "apple-identity-token", displayName: nil)
        await waitUntil({ self.store.items.isEmpty }, "the queue never uploaded after sign-in")

        XCTAssertEqual(session.state, .signedIn)
        XCTAssertEqual(tokenStore.stored, Self.freshToken)
        XCTAssertEqual(outbox.serverConfirmedCount, 1)
    }

    /// The confirm queue's form, where a Save is a PATCH and cannot wait
    /// on a disk: the rejection is held, the typing stays, the person signs
    /// back in on the same screen, and the same form saves.
    func testAQueueFormOnADeadSessionKeepsItsTypingAndSavesAfterRenewal() async throws {
        let id = try XCTUnwrap(UUID(uuidString: "0a1b2c3d-0000-4000-8000-000000000001"))
        let receipt = Fixtures.receipt(id: id, vendor: "Maple Foods", totalCents: 1250, status: .pending)
        let form = ConfirmReceiptModel(api: api, detail: Fixtures.detail(receipt: receipt))
        session.beginHold()
        form.vendorText = "Typed by a person"
        form.totalText = "99.00"

        let refused = await form.save()

        XCTAssertFalse(refused)
        XCTAssertEqual(session.state, .signedIn, "the form is still on screen")
        XCTAssertTrue(session.rejectionIsHeld, "and it knows why it cannot save")
        XCTAssertEqual(tokenStore.stored, Self.expiredToken, "the token that proves whose form this is")
        XCTAssertEqual(form.vendorText, "Typed by a person")

        await session.renewHeldSession(identityToken: "apple-identity-token", displayName: nil)

        XCTAssertEqual(session.state, .signedIn)
        XCTAssertFalse(session.rejectionIsHeld)
        XCTAssertEqual(tokenStore.stored, Self.freshToken)

        let saved = await form.save()

        XCTAssertTrue(saved, "the same form, the same typing, the new token")
        session.endHold()
        XCTAssertEqual(session.state, .signedIn, "and nothing is left to land when the cover goes")
    }

    /// Someone else's Apple ID gets nowhere near a form showing this
    /// person's receipt (constraint 3).
    func testARenewalAsSomeoneElseLeavesTheFormUnsaved() async throws {
        let id = try XCTUnwrap(UUID(uuidString: "0a1b2c3d-0000-4000-8000-000000000001"))
        let receipt = Fixtures.receipt(id: id, totalCents: 1250, status: .pending)
        let form = ConfirmReceiptModel(api: api, detail: Fixtures.detail(receipt: receipt))
        session.beginHold()
        _ = await form.save()
        transport.appleUserId = UUID()

        await session.renewHeldSession(identityToken: "apple-identity-token", displayName: nil)

        XCTAssertEqual(tokenStore.stored, Self.expiredToken)
        XCTAssertTrue(session.rejectionIsHeld)
        let saved = await form.save()
        XCTAssertFalse(saved)
    }

    /// "Later" is the other way off the same screen.
    func testLaterOnADeadSessionKeepsTheScanToo() async throws {
        session.beginHold()
        let flow = capture()

        await flow.savePages([Data("the only copy of this scan".utf8)])
        await flow.setAsideSingleCapture()
        await settleDrain()

        XCTAssertEqual(store.items.count, 1)
        XCTAssertNil(store.items.values.first?.confirmation)
        guard case .saved = flow.phase else {
            return XCTFail("Expected saved, got \(flow.phase)")
        }
    }
}
