import Foundation

/// The in-memory queue behind EventLogger - bounded and non-durable by
/// design (EventLogger's own doc comment states the trade in full: this is
/// deliberately NOT the outbox's disk-backed guarantee, because losing a
/// receipt is unacceptable and losing a diagnostic signal is not).
///
/// `@MainActor` rather than an `actor`: every real caller (every
/// `@MainActor` model and view in this app) is already on the main actor,
/// so an `actor`'s cross-actor hops would buy nothing but nondeterministic
/// interleaving between `log()` calls that are supposed to happen in the
/// order the person did things - three total edits landing as three, in
/// order, is exactly what the field-edit count depends on.
@MainActor
final class EventQueue {
    private var events: [PendingEvent] = []
    private let capacity: Int
    private let batchLimit: Int

    /// `capacity`: "a few hundred" per the brief - generous enough to
    /// survive a genuinely long offline stretch (the outbox's own
    /// justification for wide-open `occurredAt` bounds applies here too),
    /// small enough that a queue nobody ever flushes cannot grow without
    /// bound. `batchLimit`: the server's own cap on one POST
    /// (`userEventSchema`, http/schemas.ts's `.max(50)`) - never exceeded
    /// in a single request.
    init(capacity: Int = 300, batchLimit: Int = 50) {
        self.capacity = capacity
        self.batchLimit = batchLimit
    }

    var count: Int { events.count }
    var isEmpty: Bool { events.isEmpty }

    /// Appends one event, dropping the OLDEST queued events first if this
    /// pushes the queue over capacity - the newest signal is the one worth
    /// keeping when something has to give. Returns the queue's size after
    /// the append, which is what EventLogger checks against the flush
    /// threshold without a second call back into this class.
    @discardableResult
    func enqueue(_ event: PendingEvent) -> Int {
        events.append(event)
        trimToCapacity()
        return events.count
    }

    /// Removes and returns the oldest up-to-`batchLimit` events for one
    /// POST - `[]` when the queue is empty, never a partial-then-empty
    /// pair that would make a caller special-case "nothing left".
    func dequeueBatch() -> [PendingEvent] {
        guard !events.isEmpty else { return [] }
        let take = min(batchLimit, events.count)
        let batch = Array(events.prefix(take))
        events.removeFirst(take)
        return batch
    }

    /// Puts a batch back at the FRONT of the queue, oldest-first order
    /// preserved - used only when a POST never reached the server at all
    /// (no connectivity, a timeout): the events are still true and still
    /// worth sending, so the next flush trigger tries them again before
    /// anything queued after them, rather than losing a whole offline
    /// stretch to one failed attempt. Still subject to the same
    /// drop-oldest capacity trim as `enqueue`, for the pathological case
    /// of a queue that was already near the cap when this batch was
    /// dequeued.
    func requeueFront(_ batch: [PendingEvent]) {
        events.insert(contentsOf: batch, at: 0)
        trimToCapacity()
    }

    private func trimToCapacity() {
        if events.count > capacity {
            events.removeFirst(events.count - capacity)
        }
    }
}
