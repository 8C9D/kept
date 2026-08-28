import Foundation

/// The fire-and-forget behavioural-telemetry client (the owner's 2026-08-28
/// ask; server/src/routes/events.ts and domain/userEvents.ts carry the
/// full server-side contract this client builds to).
///
/// Three rules this whole type exists to keep - stated because they are
/// the point, not incidental:
///
/// 1. **Fire and forget.** `log()` never awaits the network and never
///    throws - the caller cannot tell, and must not be able to tell,
///    whether an event ever reaches the server. A telemetry post that
///    makes a save feel slow, or that surfaces a failure to someone
///    confirming a receipt, is worse than no telemetry (spec §1's success
///    test - "a receipt is captured in under a minute and never thought
///    about again" - this feature must be invisible to it).
/// 2. **A strict 400 is an acceptable outcome.** If this client ever sends
///    an action name a deployed server does not know (an old server, a
///    client ahead of it), the right thing to lose is that one batch's
///    telemetry, never the capture - `flush()` drops such a batch and
///    keeps going, the same rule the event route's own doc comment states
///    from the server side.
/// 3. **No field values, ever.** EventField names a field; nothing in this
///    type, PendingEvent, or PostEventsRequest has a slot a typed-in value
///    could occupy (EventVocabulary.swift, EventRequests.swift) - the
///    rule is structural, not a convention someone has to remember to
///    keep, pinned by EventRequestsTests' encoded-body test.
///
/// **The queue trade, stated rather than left implicit:** this is an
/// in-memory queue with a bounded cap (EventQueue), not the durable
/// outbox (`ios/Kept/Outbox/`) a captured receipt gets. Events queued
/// while the app is killed before a flush are lost, and that loss is
/// accepted, not overlooked - a second durable store for diagnostics is
/// not worth the code the real outbox already had to earn for the thing
/// that actually matters. Events queued merely while *offline* are not
/// lost this way: they keep their real `occurredAt` and flush once
/// connectivity returns or the next trigger fires, which is exactly why
/// the server records `occurred_at` and `received_at` separately
/// (domain/userEvents.ts) - the gap between the two is legible instead of
/// looking like a burst of simultaneous activity.
@MainActor
final class EventLogger {
    private let queue: EventQueue
    private let api: any KeptAPI
    private let appVersion: String?
    private let flushThreshold: Int
    private let now: @Sendable () -> Date
    /// Retained only to keep it alive - its `start()` closure is what
    /// actually matters, and nothing here reads the monitor again.
    private let connectivity: (any ConnectivityMonitor)?
    private let backgroundContinuation: (any BackgroundContinuation)?

    init(
        api: any KeptAPI,
        appVersion: String? = AppVersion.current,
        queue: EventQueue = EventQueue(),
        flushThreshold: Int = 20,
        connectivity: (any ConnectivityMonitor)? = nil,
        backgroundContinuation: (any BackgroundContinuation)? = nil,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.api = api
        self.appVersion = appVersion
        self.queue = queue
        self.flushThreshold = flushThreshold
        self.connectivity = connectivity
        self.backgroundContinuation = backgroundContinuation
        self.now = now

        // The third flush trigger the brief asks for, alongside the size
        // threshold below and backgrounding (flushForBackgrounding()): a
        // queue built up in a dead spot starts draining the moment signal
        // returns, the same reasoning OutboxController already applies to
        // uploads.
        connectivity?.start { [weak self] in
            Task { await self?.flush() }
        }
    }

    /// Queues one event and returns immediately. `field`/`receiptId`/
    /// `durationMs`/`count` are the same optional shape the wire body
    /// carries (PostEventsRequest) - absent unless the specific action
    /// calls for it, per EVENT_FIELDS' shared-across-actions note
    /// (domain/userEvents.ts).
    ///
    /// `occurredAt` defaults to now; callers pass an explicit one only to
    /// preserve the moment something actually happened when the logging
    /// call itself lands later (there is no such call site in this app
    /// today, but the parameter exists so one never has to fake a
    /// timestamp to get it).
    func log(
        _ action: EventAction,
        field: EventField? = nil,
        receiptId: UUID? = nil,
        durationMs: Int? = nil,
        count: Int? = nil,
        occurredAt: Date? = nil
    ) {
        let event = PendingEvent(
            action: action,
            occurredAt: occurredAt ?? now(),
            appVersion: appVersion,
            field: field,
            receiptId: receiptId,
            durationMs: durationMs,
            count: count
        )
        // The enqueue itself is synchronous (EventQueue is a plain
        // @MainActor class, not an actor - see its own doc comment for
        // why): the caller's `log()` call returns having already updated
        // the queue, in the exact order it was called. Only the possible
        // flush below runs on its own task, off the caller's stack.
        let size = queue.enqueue(event)
        if size >= flushThreshold {
            Task { await flush() }
        }
    }

    /// Drains the queue in server-sized batches. Safe to call from
    /// anywhere, any number of times, including concurrently with
    /// itself - each call only ever dequeues what is still there when it
    /// runs, so two overlapping flushes divide the queue rather than
    /// double-sending any of it.
    func flush() async {
        while true {
            let batch = queue.dequeueBatch()
            if batch.isEmpty { return }
            do {
                try await api.postEvents(PostEventsRequest(batch))
            } catch APIError.network {
                // The request never reached the server - connectivity, a
                // timeout. These events are still true and still worth
                // sending; put them back for the next trigger rather than
                // losing a whole offline stretch to one failed attempt.
                // This is the one immediate retry a single flush makes,
                // not a loop (rule 1: never retry aggressively) - the next
                // *trigger* (threshold, backgrounding, connectivity
                // return) is what tries again.
                queue.requeueFront(batch)
                return
            } catch {
                // Every other failure - a strict 400 (rule 2), a rejected
                // session, an undecodable response - means the server saw
                // this batch and it will not become sendable by resending
                // it unchanged. Drop it and keep draining whatever is
                // behind it; telemetry loss is the accepted, invisible
                // outcome here, never surfaced, never retried.
            }
        }
    }

    /// The backgrounding flush trigger (alongside the threshold above and
    /// connectivity return in `init`). Runs inside the same ~30-second
    /// grant the outbox uses to finish an in-flight upload
    /// (BackgroundContinuation) - a queue that just crossed the threshold
    /// moments before the app was pocketed still gets its shot at
    /// reaching the server, rather than waiting for the app to be
    /// reopened. `backgroundContinuation` is nil only in a context with no
    /// UIApplication to ask (tests without one injected); flushing
    /// without a grant there is still correct, just not time-boxed by iOS.
    func flushForBackgrounding() {
        guard let backgroundContinuation else {
            Task { await flush() }
            return
        }
        Task {
            let end = backgroundContinuation.begin()
            await flush()
            end()
        }
    }
}
