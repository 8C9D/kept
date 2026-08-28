import XCTest
@testable import Kept

/// The behavioural-telemetry queue (EventQueue, EventLogger - The owner's
/// 2026-08-28 ask). What this suite pins:
///
/// - the size-threshold flush and the server's own 50-event batch cap
///   (userEventSchema, http/schemas.ts) are both obeyed;
/// - the bounded cap drops the OLDEST events, never the newest;
/// - a failing transport never throws to the caller, and a genuine
///   network failure (never reached the server) is retried on the next
///   trigger while any other failure is dropped, per the fire-and-forget
///   contract (EventLogger's own doc comment);
/// - backgrounding and connectivity-return both drain the queue;
/// - the wire body - the actual encoded JSON, not a comment promising it -
///   never carries a receipt field value.
@MainActor
final class EventLoggerTests: XCTestCase {
    private var api: StubKeptAPI!

    override func setUp() async throws {
        try await super.setUp()
        api = StubKeptAPI()
    }

    private func makeLogger(
        flushThreshold: Int = 20,
        connectivity: (any ConnectivityMonitor)? = nil,
        backgroundContinuation: (any BackgroundContinuation)? = nil
    ) -> EventLogger {
        EventLogger(
            api: api,
            appVersion: "1.0 (2)",
            flushThreshold: flushThreshold,
            connectivity: connectivity,
            backgroundContinuation: backgroundContinuation
        )
    }

    /// Lets a fire-and-forget `Task { await flush() }` kicked by `log()`
    /// actually run before the test asserts on its effect - the same
    /// settle-and-check pattern ExportViewModelTests already uses for its
    /// own fire-and-forget download task.
    private func settle() async {
        try? await Task.sleep(for: .milliseconds(30))
    }

    // MARK: - Threshold flush

    func testQueuedEventsFlushOnceTheThresholdIsReached() async {
        let logger = makeLogger(flushThreshold: 3)
        logger.log(.captureStarted)
        logger.log(.captureStarted)
        XCTAssertTrue(api.postEventsCalls.isEmpty, "must not flush before the threshold")

        logger.log(.captureStarted)
        await settle()

        XCTAssertEqual(api.postEventsCalls.count, 1)
        XCTAssertEqual(api.postEventsCalls.first?.events.count, 3)
    }

    // MARK: - The server's batch cap

    /// 120 queued events, threshold high enough that `log()` never
    /// auto-flushes mid-loop - one explicit `flush()` call must still
    /// split them into batches of at most 50 (http/schemas.ts'
    /// `postEventsSchema` `.max(50)`), never one request with all 120.
    func testFlushNeverExceedsTheServersBatchLimitInOneRequest() async {
        let logger = makeLogger(flushThreshold: 1000)
        for _ in 0..<120 {
            logger.log(.imageOpened)
        }
        XCTAssertTrue(api.postEventsCalls.isEmpty)

        await logger.flush()

        XCTAssertEqual(api.postEventsCalls.map(\.events.count), [50, 50, 20])
        for call in api.postEventsCalls {
            XCTAssertLessThanOrEqual(call.events.count, 50)
        }
    }

    // MARK: - Bounded cap, drop-oldest

    /// EventQueue directly, not through EventLogger: `count` on each
    /// event is the identity tag that proves WHICH events survived, not
    /// just how many.
    func testQueueDropsTheOldestEventsAtCapacity() {
        let queue = EventQueue(capacity: 5, batchLimit: 50)
        for i in 0..<8 {
            queue.enqueue(pendingEvent(count: i))
        }
        XCTAssertEqual(queue.count, 5)

        let survivors = queue.dequeueBatch().compactMap(\.count)
        // The oldest three (0, 1, 2) were dropped; the newest five (3-7)
        // remain, oldest-of-the-survivors first.
        XCTAssertEqual(survivors, [3, 4, 5, 6, 7])
    }

    func testEnqueueReturnsTheQueueSizeAfterTheAppend() {
        let queue = EventQueue(capacity: 10, batchLimit: 50)
        XCTAssertEqual(queue.enqueue(pendingEvent(count: 1)), 1)
        XCTAssertEqual(queue.enqueue(pendingEvent(count: 2)), 2)
    }

    // MARK: - A failing transport never throws to the caller

    func testAFailingTransportNeverThrowsFromFlush() async {
        struct Boom: Error {}
        api.postEventsHandler = { _ in throw Boom() }
        let logger = makeLogger(flushThreshold: 1000)
        logger.log(.captureStarted)

        // Compiles and runs to completion with no `try`/`catch` at the
        // call site at all - `flush()` has no `throws` in its signature,
        // so a transport failure structurally cannot propagate here.
        await logger.flush()

        XCTAssertEqual(api.postEventsCalls.count, 1, "flush() must still have attempted the send")
    }

    /// A strict 400 (or any other non-network failure) means the server
    /// saw the batch and rejecting it again would not help - the batch is
    /// dropped, not retried, so the queue is empty afterwards and a
    /// second flush trigger sends nothing stale.
    func testANonNetworkFailureDropsTheBatchRatherThanRetryingIt() async {
        api.postEventsHandler = { _ in
            throw APIError.requestFailed(code: "bad_request", message: "nope", status: 400)
        }
        let logger = makeLogger(flushThreshold: 1000)
        logger.log(.captureStarted)
        await logger.flush()
        XCTAssertEqual(api.postEventsCalls.count, 1)

        // A second flush trigger has nothing left to send - the failed
        // batch was dropped, not requeued.
        api.postEventsHandler = { _ in }
        await logger.flush()
        XCTAssertEqual(api.postEventsCalls.count, 1, "a dropped batch must not be sent again")
    }

    /// A network failure (the request never reached the server at all) is
    /// the one case worth trying again: the events are still true and the
    /// server never got a chance to answer. `flush()` puts the batch back
    /// so the next trigger retries it, rather than losing a whole offline
    /// stretch to one failed attempt.
    func testANetworkFailureRequeuesTheBatchForTheNextTrigger() async {
        api.postEventsHandler = { _ in throw APIError.network(URLError(.notConnectedToInternet)) }
        let logger = makeLogger(flushThreshold: 1000)
        logger.log(.captureStarted)
        await logger.flush()
        XCTAssertEqual(api.postEventsCalls.count, 1, "flush() still attempts the send once")

        // Connectivity "returns": the same batch reaches the server this
        // time.
        api.postEventsHandler = { _ in }
        await logger.flush()
        XCTAssertEqual(api.postEventsCalls.count, 2)
        XCTAssertEqual(api.postEventsCalls.last?.events.count, 1)
    }

    // MARK: - Backgrounding drains the queue

    func testFlushForBackgroundingDrainsTheQueueInsideItsGrant() async {
        let background = StubBackgroundContinuation()
        let logger = makeLogger(flushThreshold: 1000, backgroundContinuation: background)
        logger.log(.captureStarted)
        logger.log(.captureStarted)

        logger.flushForBackgrounding()
        await settle()

        XCTAssertEqual(api.postEventsCalls.count, 1)
        XCTAssertEqual(api.postEventsCalls.first?.events.count, 2)
        XCTAssertEqual(background.beginCount, 1)
        XCTAssertEqual(background.endCount, 1, "the grant must be balanced, not leaked")
    }

    // MARK: - Connectivity return drains the queue

    func testConnectivityReturningDrainsTheQueue() async {
        let connectivity = StubConnectivityMonitor()
        let logger = makeLogger(flushThreshold: 1000, connectivity: connectivity)
        logger.log(.captureStarted)
        XCTAssertTrue(api.postEventsCalls.isEmpty)

        connectivity.simulateRestored()
        await settle()

        XCTAssertEqual(api.postEventsCalls.count, 1)
    }

    // MARK: - The privacy rule, pinned in the wire body

    /// The structural half: PendingEvent, the queue's internal
    /// representation, has exactly these stored properties - nothing else
    /// exists for a value to hide in.
    func testPendingEventHasNoSlotForAReceiptFieldValue() {
        let event = pendingEvent(count: 1, field: .vendor, receiptId: UUID())
        let propertyNames = Set(Mirror(reflecting: event).children.compactMap(\.label))
        XCTAssertEqual(
            propertyNames,
            ["action", "occurredAt", "appVersion", "field", "receiptId", "durationMs", "count"]
        )
    }

    /// The wire half: encode a real batch - one event with every optional
    /// populated, one with none - and inspect the actual JSON, not a
    /// comment promising its shape.
    func testEncodedEventBodyCarriesNoReceiptFieldValues() throws {
        let events = [
            pendingEvent(
                count: 3,
                field: .total,
                receiptId: UUID(),
                durationMs: 1_200
            ),
            PendingEvent(
                action: .confirmSaved,
                occurredAt: Date(timeIntervalSince1970: 1_775_000_100),
                appVersion: nil,
                field: nil,
                receiptId: nil,
                durationMs: nil,
                count: nil
            ),
        ]

        let data = try JSONEncoder().encode(PostEventsRequest(events))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let encodedEvents = try XCTUnwrap(json["events"] as? [[String: Any]])
        XCTAssertEqual(encodedEvents.count, 2)

        // The only keys the wire body may ever carry - the server's own
        // strict schema (userEventSchema) enforces the same set from its
        // side; this pins that this client never even attempts to send
        // more.
        let allowedKeys: Set<String> = [
            "action", "occurredAt", "client", "appVersion", "field", "receiptId", "durationMs", "count",
        ]
        for event in encodedEvents {
            let keys = Set(event.keys)
            XCTAssertTrue(
                keys.isSubset(of: allowedKeys),
                "Unexpected key in encoded event: \(keys.subtracting(allowedKeys))"
            )
        }

        // The first event's `field` value is the closed vocabulary's name
        // for the field ("total"), never an amount or any other content -
        // the value that field held is nowhere in this payload.
        XCTAssertEqual(encodedEvents.first?["field"] as? String, "total")
        XCTAssertEqual(encodedEvents.first?["count"] as? Int, 3)
        XCTAssertNil(encodedEvents.last?["field"], "the absent-optional event must omit the key, not null it")
    }

    // MARK: - Fixtures

    private func pendingEvent(
        count: Int,
        field: EventField? = nil,
        receiptId: UUID? = nil,
        durationMs: Int? = nil
    ) -> PendingEvent {
        PendingEvent(
            action: .fieldEdited,
            occurredAt: Date(timeIntervalSince1970: 1_775_000_000 + Double(count)),
            appVersion: "1.0 (2)",
            field: field,
            receiptId: receiptId,
            durationMs: durationMs,
            count: count
        )
    }
}
