import Foundation

/// One recorded action, held in the in-memory queue (EventQueue) until the
/// next flush turns it into wire bytes (PostEventsRequest below). This is
/// the ONE shape an event can take, end to end - there is deliberately no
/// payload/meta/properties slot anywhere near it, matching the server's
/// own `user_events` schema (domain/userEvents.ts): a bag that COULD carry
/// a receipt field value eventually WOULD, and a struct that cannot
/// express one cannot leak one (spec: "no field values, ever").
struct PendingEvent: Equatable {
    let action: EventAction
    let occurredAt: Date
    let appVersion: String?
    let field: EventField?
    let receiptId: UUID?
    let durationMs: Int?
    let count: Int?
}

/// POST /api/events body (server/src/http/schemas.ts `postEventsSchema`):
/// 1-50 events, `client` fixed to `.ios`. Every optional field is encoded
/// with `encodeIfPresent`, the same discipline `ReceiptRequests.swift`
/// already follows - the server's schemas are strict and take an ABSENT
/// key for an unset optional, not an explicit null, so a bare `encode`
/// here would 400 every batch that omits so much as `field`.
struct PostEventsRequest: Encodable, Equatable {
    struct Event: Encodable, Equatable {
        let action: EventAction
        /// ISO 8601 with an offset (Z counts) - the server's
        /// `eventOccurredAt` schema requires it, and ReceiptFormat.timestamp
        /// already produces exactly that shape for `capturedAt` elsewhere
        /// in this client.
        let occurredAt: String
        let client: EventClient
        let appVersion: String?
        let field: EventField?
        let receiptId: UUID?
        let durationMs: Int?
        let count: Int?

        init(_ pending: PendingEvent) {
            action = pending.action
            occurredAt = ReceiptFormat.timestamp(of: pending.occurredAt)
            client = .ios
            appVersion = pending.appVersion
            field = pending.field
            receiptId = pending.receiptId
            durationMs = pending.durationMs
            count = pending.count
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(action, forKey: .action)
            try container.encode(occurredAt, forKey: .occurredAt)
            try container.encode(client, forKey: .client)
            try container.encodeIfPresent(appVersion, forKey: .appVersion)
            try container.encodeIfPresent(field, forKey: .field)
            try container.encodeIfPresent(receiptId, forKey: .receiptId)
            try container.encodeIfPresent(durationMs, forKey: .durationMs)
            try container.encodeIfPresent(count, forKey: .count)
        }

        private enum CodingKeys: String, CodingKey {
            case action, occurredAt, client, appVersion, field, receiptId, durationMs, count
        }
    }

    let events: [Event]

    /// `min(1)` on the server side too, but this client never calls with
    /// an empty batch - EventQueue.dequeueBatch() returns `[]` rather than
    /// an empty request, and EventLogger.flush() stops there instead of
    /// posting nothing.
    init(_ pending: [PendingEvent]) {
        events = pending.map(Event.init)
    }
}
