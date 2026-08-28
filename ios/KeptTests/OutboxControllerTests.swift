import XCTest
@testable import Kept

/// The drain's decisions, one test per §3 failure mode of the wave-5
/// kickoff plus the happy paths. Every network call is scripted through
/// StubKeptAPI, every disk write through InMemoryOutboxStore, so each
/// scenario - kill-and-relaunch included - runs deterministically on the
/// simulator.
@MainActor
final class OutboxControllerTests: XCTestCase {
    private var store: InMemoryOutboxStore!
    private var api: StubKeptAPI!
    private var tokenStore: InMemoryTokenStore!
    private var connectivity: StubConnectivityMonitor!
    private var background: StubBackgroundContinuation!

    private nonisolated static let userA = UUID(uuidString: "aaaaaaaa-1111-2222-3333-444444444444")!
    private nonisolated static let userB = UUID(uuidString: "bbbbbbbb-1111-2222-3333-444444444444")!
    private nonisolated static let captureInstant = Date(timeIntervalSince1970: 1_775_000_000)

    /// The same shape CaptureFlowModel's old fixture used: a vendor line,
    /// a date, a labelled total.
    private nonisolated static let parsedText = RecognizedText(lines: [
        RecognizedLine(text: "MAPLE FOODS MARKET", verticalCenter: 0.05, height: 0.04),
        RecognizedLine(text: "2026/01/14", verticalCenter: 0.14, height: 0.015),
        RecognizedLine(text: "TOTAL 113.00", verticalCenter: 0.80, height: 0.02),
    ])

    override func setUp() async throws {
        try await super.setUp()
        store = InMemoryOutboxStore()
        api = StubKeptAPI()
        tokenStore = InMemoryTokenStore(stored: TestTokens.sessionToken(sub: Self.userA.uuidString.lowercased()))
        connectivity = StubConnectivityMonitor()
        background = StubBackgroundContinuation()

        var uploadCounter = 0
        api.uploadTargetHandler = { _ in
            uploadCounter += 1
            return UploadTarget(
                objectKey: "\(Self.userA.uuidString.lowercased())/2026/08/upload-\(uploadCounter).jpg",
                uploadUrl: URL(string: "https://storage.example/put-\(uploadCounter)")!
            )
        }
        api.uploadImageHandler = { _, _, _ in }
        api.createReceiptHandler = { _ in Fixtures.receipt(status: .pending) }
    }

    private func makeController(
        recognizer: StubTextRecognizer? = nil,
        started: Bool = true
    ) async -> OutboxController {
        let controller = OutboxController(
            store: store,
            api: api,
            recognizer: recognizer ?? StubTextRecognizer(repeating: Self.parsedText, count: 10),
            tokenStore: tokenStore,
            connectivity: connectivity,
            backgroundContinuation: background,
            now: { Self.captureInstant }
        )
        if started {
            await controller.start()
            await settle(controller)
        }
        return controller
    }

    /// Waits for the fire-and-forget drain to finish its current pass.
    private func settle(_ controller: OutboxController) async {
        while controller.isDraining {
            await Task.yield()
        }
    }

    private func seededItem(
        userId: UUID = OutboxControllerTests.userA,
        sequence: Int = 1,
        sha256: String = "feed0000",
        progress: OutboxItem.Progress,
        ocrAttempts: Int = 0,
        confirmation: ConfirmedReceiptFields? = nil,
        blockedMessage: String? = nil
    ) -> OutboxItem {
        OutboxItem(
            id: UUID(),
            userId: userId,
            sequence: sequence,
            capturedAt: Self.captureInstant,
            sha256: sha256,
            progress: progress,
            ocrAttempts: ocrAttempts,
            confirmation: confirmation,
            blockedMessage: blockedMessage
        )
    }

    private nonisolated static let parsedFixture = ParsedReceipt(
        suggestions: ReceiptSuggestions(
            totalCents: 11300,
            purchasedAt: "2026-01-14",
            vendor: "MAPLE FOODS MARKET"
        ),
        ocrRawText: "MAPLE FOODS MARKET\n2026/01/14\nTOTAL 113.00"
    )

    // MARK: - The happy path, and ordering (§3: two offline receipts both arrive)

    func testTwoQueuedReceiptsBothArriveInCaptureOrderWithTheirOwnImages() async throws {
        let pageOne = Data("page one bytes".utf8)
        let pageTwo = Data("page two bytes".utf8)
        let controller = await makeController()

        try await controller.enqueue(imageData: pageOne)
        try await controller.enqueue(imageData: pageTwo)
        await settle(controller)

        XCTAssertEqual(api.createReceiptCalls.count, 2)
        // Each record carries its own image's digest - digests computed
        // independently with shasum, not with the code under test.
        XCTAssertEqual(
            api.createReceiptCalls[0].image.sha256,
            "fbda1f53596b1786de973e326e1319679d578134edd8cea901b71251f0101085"
        )
        XCTAssertEqual(
            api.createReceiptCalls[1].image.sha256,
            "44a7cebba40f42018f6d6b6033b6054c1a862bc7910e105cf30f7d041fefa59c"
        )
        // Distinct object keys: neither receipt can overwrite the other.
        XCTAssertEqual(
            Set(api.createReceiptCalls.map(\.image.objectKey)).count, 2
        )
        XCTAssertTrue(store.items.isEmpty, "finished items leave the queue")
        XCTAssertEqual(controller.serverConfirmedCount, 2)
        XCTAssertTrue(controller.entries.isEmpty)
    }

    func testConfirmedAtCaptureItemCreatesAConfirmedRowWithTheSuggestionRecord() async throws {
        // The single-capture flow: a human confirmed on the spot, so the
        // create lands the receipt already confirmed - it never joins the
        // pending queue - while the parser's suggestions still ride along
        // verbatim, because comparing them with the confirmed fields IS
        // the §7.3 accuracy measurement.
        let confirmed = ConfirmedReceiptFields(
            purchasedAt: "2026-01-15", // the human corrected the parsed date
            vendor: "Maple Foods",
            subtotalCents: 10000,
            hstCents: 1300,
            totalCents: 11300,
            tipCents: 1500,
            otherFeesCents: 250,
            category: "groceries",
            paymentMethod: "visa",
            notes: nil
        )
        let controller = await makeController()
        try await controller.enqueue(
            imageData: Data("page one bytes".utf8),
            parsed: Self.parsedFixture,
            confirmation: confirmed
        )
        await settle(controller)

        let request = try XCTUnwrap(api.createReceiptCalls.first)
        XCTAssertEqual(request.status, .confirmed)
        XCTAssertEqual(request.purchasedAt, "2026-01-15")
        XCTAssertEqual(request.category, "groceries")
        XCTAssertEqual(request.paymentMethod, "visa")
        XCTAssertEqual(request.totalCents, 11300)
        XCTAssertEqual(request.tipCents, 1500)
        XCTAssertEqual(request.otherFeesCents, 250)
        XCTAssertEqual(request.ocrSuggestions.purchasedAt, "2026-01-14") // the parser's, untouched
        XCTAssertEqual(request.ocrRawText, Self.parsedFixture.ocrRawText)
        XCTAssertTrue(store.items.isEmpty)

        // On the wire: status present for this create, none of the three
        // retired keys anywhere. The server tolerates and discards them
        // for the shipped 1.0 (1) build, so sending them would look like
        // success while meaning this client was never updated.
        let body = try XCTUnwrap(
            JSONSerialization.jsonObject(with: APIClient.encoder.encode(request)) as? [String: Any]
        )
        XCTAssertEqual(body["status"] as? String, "confirmed")
        XCTAssertNil(body["vendorTaxNumber"])
        XCTAssertNil(body["otherTaxCents"])
        XCTAssertNil(body["isBusiness"])
        let suggestions = try XCTUnwrap(body["ocrSuggestions"] as? [String: Any])
        XCTAssertNil(suggestions["vendorTaxNumber"])
    }

    func testPendingCreateStillOmitsStatusOnTheWire() async throws {
        // A pending create must not carry the key only a human's
        // confirmation may supply.
        let controller = await makeController()
        try await controller.enqueue(imageData: Data("page one bytes".utf8))
        await settle(controller)

        let request = try XCTUnwrap(api.createReceiptCalls.first)
        let body = try XCTUnwrap(
            JSONSerialization.jsonObject(with: APIClient.encoder.encode(request)) as? [String: Any]
        )
        XCTAssertNil(body["status"])
        XCTAssertNil(body["vendorTaxNumber"])
        XCTAssertNil(body["otherTaxCents"])
        XCTAssertNil(body["isBusiness"])
    }

    func testCreateCarriesParsedSuggestionsRawTextAndCaptureTimes() async throws {
        let controller = await makeController()
        try await controller.enqueue(imageData: Data("page one bytes".utf8))
        await settle(controller)

        let request = try XCTUnwrap(api.createReceiptCalls.first)
        XCTAssertEqual(request.purchasedAt, "2026-01-14") // parsed, not capture day
        XCTAssertEqual(request.totalCents, 11300)
        XCTAssertEqual(request.vendor, "MAPLE FOODS MARKET")
        XCTAssertEqual(request.ocrRawText, "MAPLE FOODS MARKET\n2026/01/14\nTOTAL 113.00")
        XCTAssertEqual(request.ocrSuggestions.totalCents, 11300)
        XCTAssertEqual(request.capturedAt, ReceiptFormat.timestamp(of: Self.captureInstant))
    }

    /// The pending path's tip guess end to end: real OCR lines through the
    /// real ReceiptParser, riding into the create request the same way
    /// subtotal, HST and total already do (2026-08-28) - not a stubbed
    /// ReceiptSuggestions value, so this catches a wiring regression the
    /// other tests, which script the parse result directly, cannot.
    func testPendingCreateCarriesTheParsedTipGuess() async throws {
        let textWithTip = RecognizedText(lines: [
            RecognizedLine(text: "MAPLE FOODS MARKET", verticalCenter: 0.05, height: 0.04),
            RecognizedLine(text: "2026/01/14", verticalCenter: 0.14, height: 0.015),
            RecognizedLine(text: "Tip 15.00", verticalCenter: 0.70, height: 0.015),
            RecognizedLine(text: "TOTAL 128.00", verticalCenter: 0.80, height: 0.02),
        ])
        let controller = await makeController(
            recognizer: StubTextRecognizer(repeating: textWithTip, count: 10)
        )
        try await controller.enqueue(imageData: Data("page one bytes".utf8))
        await settle(controller)

        let request = try XCTUnwrap(api.createReceiptCalls.first)
        XCTAssertEqual(request.tipCents, 1500)
        XCTAssertEqual(request.ocrSuggestions.tipCents, 1500)
        // No heuristic produces other fees; the pending path never sends one.
        XCTAssertNil(request.otherFeesCents)
    }

    func testEnqueueDuringDrainIsPickedUpByTheSamePass() async throws {
        let gate = Gate()
        api.createReceiptHandler = { _ in
            await gate.wait()
            return Fixtures.receipt(status: .pending)
        }
        let controller = await makeController()

        try await controller.enqueue(imageData: Data("page one bytes".utf8))
        while api.createReceiptCalls.isEmpty {
            await Task.yield()
        }
        // The drain is parked on the first create; a second capture lands.
        try await controller.enqueue(imageData: Data("page two bytes".utf8))
        await gate.open()
        await settle(controller)

        XCTAssertEqual(api.createReceiptCalls.count, 2)
        XCTAssertTrue(store.items.isEmpty)
    }

    func testDrainBalancesItsBackgroundContinuationGrant() async throws {
        let controller = await makeController()
        try await controller.enqueue(imageData: Data("page one bytes".utf8))
        await settle(controller)

        XCTAssertGreaterThan(background.beginCount, 0)
        XCTAssertEqual(background.beginCount, background.endCount)
    }

    // MARK: - §3: app killed mid-upload

    func testRelaunchAfterKillBetweenUploadAndCreateResumesWithoutReUploading() async {
        let item = seededItem(progress: .uploaded(
            Self.parsedFixture,
            objectKey: "\(Self.userA.uuidString.lowercased())/2026/08/stored.jpg"
        ))
        store.seed(item, imageData: Data("page one bytes".utf8))
        api.uploadTargetHandler = { _ in
            XCTFail("An already-uploaded image must not be presigned again")
            throw StubKeptAPI.UnstubbedCall(endpoint: "uploadTarget")
        }

        let controller = await makeController()

        XCTAssertEqual(api.createReceiptCalls.count, 1)
        XCTAssertEqual(
            api.createReceiptCalls.first?.image.objectKey,
            "\(Self.userA.uuidString.lowercased())/2026/08/stored.jpg"
        )
        XCTAssertTrue(store.items.isEmpty)
        XCTAssertEqual(controller.serverConfirmedCount, 1)
    }

    func testRelaunchAfterKillBetweenCreateAndCleanupLandsOn409AndCountsSaved() async {
        // The create succeeded on the last run; only the local cleanup was
        // lost. The retried create answers 409 duplicate_image, which is
        // the receipt already existing - saved, not an error, and no
        // phantom second receipt (§3).
        let item = seededItem(progress: .uploaded(Self.parsedFixture, objectKey: "\(Self.userA.uuidString.lowercased())/2026/08/stored.jpg"))
        store.seed(item, imageData: Data("page one bytes".utf8))
        api.createReceiptHandler = { _ in
            throw APIError.requestFailed(code: "duplicate_image", message: "already attached", status: 409)
        }

        let controller = await makeController()

        XCTAssertTrue(store.items.isEmpty)
        XCTAssertEqual(controller.serverConfirmedCount, 1)
        XCTAssertTrue(controller.entries.isEmpty)
    }

    func testEachCompletedStepIsPersistedBeforeTheNext() async throws {
        let controller = await makeController()
        try await controller.enqueue(imageData: Data("page one bytes".utf8))
        await settle(controller)

        // The step machine wrote parsed, then uploaded - so a kill at any
        // point resumes rather than repeats.
        let progressions = store.updates.map { update -> String in
            switch update.progress {
            case .captured: return "captured"
            case .parsed: return "parsed"
            case .uploaded: return "uploaded"
            }
        }
        XCTAssertEqual(progressions, ["parsed", "uploaded"])
    }

    // MARK: - §3: token expired while items are queued

    func testExpiredSessionPausesTheQueueAndSignInResumesIt() async throws {
        api.createReceiptHandler = { _ in
            throw APIError.sessionRejected
        }
        let controller = await makeController()
        try await controller.enqueue(imageData: Data("page one bytes".utf8))
        await settle(controller)

        // The item waits - never fails, never vanishes.
        XCTAssertEqual(store.items.count, 1)
        XCTAssertEqual(controller.entries.count, 1)
        XCTAssertEqual(controller.entries.first?.status, .waiting)

        // Sign-in success is wired to externalTrigger; the queue resumes.
        api.createReceiptHandler = { _ in Fixtures.receipt(status: .pending) }
        controller.externalTrigger()
        await settle(controller)

        XCTAssertTrue(store.items.isEmpty)
        XCTAssertEqual(controller.serverConfirmedCount, 1)
    }

    // MARK: - §3: an item that can never succeed

    func testPermanent400BlocksTheItemButNotTheQueueBehindIt() async throws {
        var createCalls = 0
        api.createReceiptHandler = { _ in
            createCalls += 1
            if createCalls == 1 {
                throw APIError.requestFailed(code: "invalid_request", message: "purchasedAt is not a date", status: 400)
            }
            return Fixtures.receipt(status: .pending)
        }
        let controller = await makeController()
        try await controller.enqueue(imageData: Data("page one bytes".utf8))
        try await controller.enqueue(imageData: Data("page two bytes".utf8))
        await settle(controller)

        // First blocked with the server's reason; second sailed past it.
        XCTAssertEqual(controller.serverConfirmedCount, 1)
        XCTAssertEqual(controller.entries.count, 1)
        guard case .needsAttention(let message) = controller.entries.first?.status else {
            return XCTFail("Expected needsAttention, got \(String(describing: controller.entries.first?.status))")
        }
        XCTAssertEqual(message, "purchasedAt is not a date")

        // No automatic retry, ever: further triggers leave it untouched.
        let callsBefore = api.createReceiptCalls.count
        controller.externalTrigger()
        await settle(controller)
        XCTAssertEqual(api.createReceiptCalls.count, callsBefore)

        // The block survives a relaunch - it was persisted.
        let persisted = store.items.values.first
        XCTAssertEqual(persisted?.blockedMessage, "purchasedAt is not a date")
    }

    func testManualRetryClearsABlockedItemAndUploadsIt() async throws {
        let item = seededItem(
            progress: .uploaded(Self.parsedFixture, objectKey: "\(Self.userA.uuidString.lowercased())/2026/08/stored.jpg"),
            blockedMessage: "purchasedAt is not a date"
        )
        store.seed(item, imageData: Data("page one bytes".utf8))
        let controller = await makeController()
        XCTAssertEqual(api.createReceiptCalls.count, 0, "blocked items are skipped")

        await controller.retryBlockedItem(id: item.id)
        await settle(controller)

        XCTAssertEqual(api.createReceiptCalls.count, 1)
        XCTAssertTrue(store.items.isEmpty)
        XCTAssertEqual(controller.serverConfirmedCount, 1)
    }

    func testDiscardRemovesABlockedItemImageAndAll() async {
        let item = seededItem(
            progress: .captured,
            blockedMessage: "The saved image for this receipt could not be read back from this phone."
        )
        store.seed(item, imageData: Data("page one bytes".utf8))
        let controller = await makeController()

        await controller.discardBlockedItem(id: item.id)

        XCTAssertTrue(store.items.isEmpty)
        XCTAssertTrue(store.images.isEmpty)
        XCTAssertTrue(controller.entries.isEmpty)
    }

    func testAccountDeletionDiscardsThatUsersQueueAndNobodyElses() async {
        // The local half of "delete my account and all my receipts". These
        // items could never drain anyway - signing in again with the same
        // Apple ID creates a NEW user row with a new id - so leaving them
        // would park the images on the phone forever, labelled as another
        // account's.
        let mine = seededItem(userId: Self.userA, sequence: 1, progress: .captured)
        let alsoMine = seededItem(
            userId: Self.userA,
            sequence: 2,
            sha256: "feed0001",
            progress: .captured,
            blockedMessage: "The saved image for this receipt could not be read back from this phone."
        )
        let theirs = seededItem(
            userId: Self.userB,
            sequence: 3,
            sha256: "feed0002",
            progress: .captured
        )
        store.seed(mine, imageData: Data("mine".utf8))
        store.seed(alsoMine, imageData: Data("also mine".utf8))
        store.seed(theirs, imageData: Data("theirs".utf8))
        let controller = await makeController(started: false)

        await controller.discardAll(ownedBy: Self.userA)

        XCTAssertEqual(Array(store.items.keys), [theirs.id])
        XCTAssertEqual(store.images.count, 1, "the other account's image is untouched")
        XCTAssertTrue(controller.entries.isEmpty, "the signed-in user's queue is empty")
    }

    func testDiscardRefusesItemsThatAreNotBlocked() async throws {
        api.createReceiptHandler = { _ in throw APIError.network(URLError(.notConnectedToInternet)) }
        let controller = await makeController()
        try await controller.enqueue(imageData: Data("page one bytes".utf8))
        await settle(controller)
        let entry = try XCTUnwrap(controller.entries.first)

        // A merely-waiting item is not discardable: only a human-visible
        // permanent failure earns that button.
        await controller.discardBlockedItem(id: entry.id)
        XCTAssertEqual(store.items.count, 1)
    }

    func testMissingImageBlocksInsteadOfRetryingForever() async throws {
        // The item exists but its image bytes are gone - a corrupt queue.
        // No retry can fix it; it must block for a human, not loop.
        let item = seededItem(progress: .parsed(Self.parsedFixture))
        store.seed(item, imageData: Data("page one bytes".utf8))
        store.removeImage(item.id)

        let controller = await makeController()

        XCTAssertEqual(controller.entries.count, 1)
        guard case .needsAttention = controller.entries.first?.status else {
            return XCTFail("Expected needsAttention, got \(String(describing: controller.entries.first?.status))")
        }
    }

    func testLockedPhoneRetriesInsteadOfBlocking() async throws {
        // The same call failing, with the opposite meaning. Complete file
        // protection refuses the read while the phone is locked, and the
        // bytes are perfectly intact - so this must land on the retry path
        // the test above deliberately avoids. Telling someone a receipt is
        // unrecoverable because their phone was in their pocket is the
        // worst answer this queue can give, and it is the failure mode the
        // protection class introduced.
        let item = seededItem(progress: .parsed(Self.parsedFixture))
        store.seed(item, imageData: Data("page one bytes".utf8))
        store.imageDataError = OutboxLockedError()

        let controller = await makeController()

        XCTAssertEqual(controller.entries.count, 1)
        guard case .waitingToRetry = controller.entries.first?.status else {
            return XCTFail("Expected waitingToRetry, got \(String(describing: controller.entries.first?.status))")
        }
    }

    // MARK: - §3: device storage full

    func testFullDiskFailsTheEnqueueLoudly() async {
        store.addError = CocoaError(.fileWriteOutOfSpace)
        let controller = await makeController()

        do {
            try await controller.enqueue(imageData: Data("page one bytes".utf8))
            XCTFail("Expected the enqueue to throw")
        } catch {
            // The capture flow presents this as a failed save; the person
            // still has the paper.
        }
        XCTAssertTrue(store.items.isEmpty)
        XCTAssertTrue(controller.entries.isEmpty, "a failed save must not fake a queued receipt")
    }

    // MARK: - Retryable failures and backoff

    func testConnectivityFailureMarksTheItemAndConnectivityReturnResumesIt() async throws {
        api.uploadTargetHandler = { _ in
            throw APIError.network(URLError(.notConnectedToInternet))
        }
        let controller = await makeController()
        try await controller.enqueue(imageData: Data("page one bytes".utf8))
        await settle(controller)

        guard case .waitingToRetry = controller.entries.first?.status else {
            return XCTFail("Expected waitingToRetry, got \(String(describing: controller.entries.first?.status))")
        }

        // Signal returns; the connectivity monitor's nudge drains the
        // queue without waiting out the backoff timer.
        var uploadCounter = 0
        api.uploadTargetHandler = { _ in
            uploadCounter += 1
            return UploadTarget(
                objectKey: "\(Self.userA.uuidString.lowercased())/2026/08/retry-\(uploadCounter).jpg",
                uploadUrl: URL(string: "https://storage.example/retry")!
            )
        }
        connectivity.simulateRestored()
        await settle(controller)

        XCTAssertTrue(store.items.isEmpty)
        XCTAssertEqual(controller.serverConfirmedCount, 1)
    }

    // MARK: - OCR failures

    func testOcrGivesUpAfterMaxAttemptsAndUploadsWithEmptySuggestions() async throws {
        // A recognizer with no scripted pages throws on every call - the
        // stand-in for Vision failing on this image, every time.
        let controller = await makeController(recognizer: StubTextRecognizer(results: []))
        try await controller.enqueue(imageData: Data("page one bytes".utf8))
        await settle(controller)

        for _ in 1..<OutboxController.maxOcrAttempts {
            controller.externalTrigger()
            await settle(controller)
        }

        // Attempt cap reached: the receipt uploads anyway, honestly empty.
        let request = try XCTUnwrap(api.createReceiptCalls.first)
        XCTAssertNil(request.vendor)
        XCTAssertNil(request.totalCents)
        XCTAssertNil(request.ocrRawText)
        XCTAssertNil(request.ocrSuggestions.totalCents)
        // The fallback date is the capture day, not the upload day.
        XCTAssertEqual(request.purchasedAt, ReceiptFormat.calendarDate(of: Self.captureInstant))
        XCTAssertTrue(store.items.isEmpty)

        // The attempt count was persisted along the way, so relaunches
        // could not have reset the meter.
        XCTAssertEqual(store.updates.map(\.ocrAttempts).prefix(2), [1, 2])
    }

    // MARK: - Constraint 4: another account's captures

    func testAnotherAccountsItemsAreHeldNotUploaded() async {
        let foreign = seededItem(userId: Self.userB, progress: .uploaded(Self.parsedFixture, objectKey: "\(Self.userB.uuidString.lowercased())/2026/08/b.jpg"))
        store.seed(foreign, imageData: Data("page one bytes".utf8))

        let controller = await makeController()

        XCTAssertEqual(api.createReceiptCalls.count, 0)
        XCTAssertEqual(controller.otherAccountCount, 1)
        XCTAssertTrue(controller.entries.isEmpty)
        XCTAssertEqual(store.items.count, 1, "held, not dropped")
    }

    func testAccountSwitchMidUploadStopsBeforeAnythingSticks() async throws {
        // THE constraint-4 interleave (reviewer finding, high): user A's
        // drain is suspended inside a network call when A signs out and B
        // signs in. Nothing of A's may proceed under B's session - no
        // presigned key persisted, no create sent.
        let gate = Gate()
        var uploadedImages = 0
        api.uploadTargetHandler = { _ in
            await gate.wait()
            return UploadTarget(
                objectKey: "\(Self.userA.uuidString.lowercased())/2026/08/switched.jpg",
                uploadUrl: URL(string: "https://storage.example/switched")!
            )
        }
        api.uploadImageHandler = { _, _, _ in uploadedImages += 1 }
        let controller = await makeController()

        try await controller.enqueue(imageData: Data("page one bytes".utf8))
        while await !gate.hasWaiters {
            await Task.yield()
        }
        // Parked inside uploadTarget: A signs out, B signs in.
        tokenStore.stored = TestTokens.sessionToken(sub: Self.userB.uuidString.lowercased())
        await gate.open()
        await settle(controller)

        XCTAssertEqual(uploadedImages, 0, "no byte of A's may upload under B's presign")
        XCTAssertTrue(api.createReceiptCalls.isEmpty)
        // The item survives, parsed but NOT uploaded - B's presigned key
        // must not stick to A's receipt - and displays as another
        // account's while B is signed in.
        let persisted = try XCTUnwrap(store.items.values.first)
        guard case .parsed = persisted.progress else {
            return XCTFail("Expected .parsed, got \(persisted.progress)")
        }
        XCTAssertEqual(controller.otherAccountCount, 1)
        XCTAssertTrue(controller.entries.isEmpty)
    }

    func testKeychainFailureMidDrainIsStatedAndHealsOnRetry() async {
        // The device locking mid-drain makes the keychain read throw. The
        // first draft folded that into "signed out" and ended the pass in
        // silence (reviewer finding); it must be stated and retried.
        let item = seededItem(progress: .uploaded(Self.parsedFixture, objectKey: "\(Self.userA.uuidString.lowercased())/2026/08/stored.jpg"))
        store.seed(item, imageData: Data("page one bytes".utf8))
        tokenStore.loadError = KeychainError(operation: "read", status: -25308)

        let controller = await makeController()

        XCTAssertNotNil(controller.drainFailureNote)
        XCTAssertEqual(store.items.count, 1, "the item waits; nothing is lost")
        XCTAssertTrue(api.createReceiptCalls.isEmpty)

        // Unlocked again: the next trigger clears the condition and drains.
        tokenStore.loadError = nil
        controller.externalTrigger()
        await settle(controller)
        XCTAssertNil(controller.drainFailureNote)
        XCTAssertEqual(controller.serverConfirmedCount, 1)
    }

    func testSignOutClearsTheDisplayWithoutTouchingTheQueue() async throws {
        api.createReceiptHandler = { _ in throw APIError.sessionRejected }
        let controller = await makeController()
        try await controller.enqueue(imageData: Data("page one bytes".utf8))
        await settle(controller)
        XCTAssertEqual(controller.entries.count, 1)

        // Sign-out reaches the outbox (reviewer finding: it previously
        // did not): the departed user's rows leave the screen - above
        // all, they must not re-render as "another account's" - and the
        // queue itself is untouched on disk.
        tokenStore.stored = nil
        controller.sessionDidEnd()

        XCTAssertTrue(controller.entries.isEmpty)
        XCTAssertEqual(controller.otherAccountCount, 0)
        XCTAssertEqual(store.items.count, 1)
    }

    func testOneImagesOcrTroubleDoesNotStallTheQueueBehindIt() async throws {
        // Reviewer finding: OCR failure was classified queue-wide, so one
        // unreadable page paused a whole backlog behind it. It must defer
        // only its own item; the rest of the pass keeps moving.
        let recognizer = StubTextRecognizer(
            results: [Self.parsedText, Self.parsedText],
            failOnCalls: [0]
        )
        let controller = await makeController(recognizer: recognizer)
        try await controller.enqueue(imageData: Data("page one bytes".utf8))
        try await controller.enqueue(imageData: Data("page two bytes".utf8))
        await settle(controller)

        // The second receipt sailed past the first's OCR trouble...
        XCTAssertEqual(controller.serverConfirmedCount, 1)
        XCTAssertEqual(
            api.createReceiptCalls.first?.image.sha256,
            "44a7cebba40f42018f6d6b6033b6054c1a862bc7910e105cf30f7d041fefa59c"
        )
        // ...while the first waits with its reason, attempt recorded.
        XCTAssertEqual(store.items.count, 1)
        guard case .waitingToRetry = controller.entries.first?.status else {
            return XCTFail("Expected waitingToRetry, got \(String(describing: controller.entries.first?.status))")
        }
    }

    // MARK: - Queue integrity

    func testUnreadableItemsAreCountedNotSilentlyDropped() async {
        store.loadAllResult = OutboxLoadResult(items: [], unreadableCount: 2)
        let controller = await makeController()
        XCTAssertEqual(controller.unreadableCount, 2)
    }
}
