import Foundation

/// One captured receipt waiting to reach the server (spec §7.4). The item
/// is durable from the moment Save writes it: everything after - OCR,
/// upload, create - is the app's problem, never the person's.
///
/// `progress` is a persisted step machine, advanced and re-written after
/// every completed step, so the app being killed at any point resumes
/// exactly where it stopped instead of repeating side effects:
///
///   captured ──OCR+parse──▶ parsed ──presigned PUT──▶ uploaded ──create──▶ (removed)
///
/// A create retried after a kill-between-create-and-remove answers 409
/// `duplicate_image` (the image hash already belongs to this user), which
/// the drain counts as saved - the wave-4 decision, extended to the queue.
struct OutboxItem: Codable, Equatable, Identifiable, Sendable {
    enum Progress: Codable, Equatable, Sendable {
        /// Only the image bytes are on disk; nothing else has happened.
        case captured
        /// On-device OCR and parsing are done and their result is durable -
        /// a relaunch never re-reads the image.
        case parsed(ParsedReceipt)
        /// The image bytes are in object storage under `objectKey`; only
        /// the receipt create remains.
        case uploaded(ParsedReceipt, objectKey: String)
    }

    let id: UUID
    /// Who captured this receipt, read from the session token at enqueue.
    /// The drain uploads an item only while the same user is signed in -
    /// a queued receipt must never land in another account (constraint 4).
    let userId: UUID
    /// FIFO position: claimed synchronously at enqueue, strictly above
    /// every sequence on disk at the time, so two receipts captured
    /// offline upload in capture order. (Numbers can recur across app
    /// runs once the queue has fully emptied; order only ever matters
    /// among items that coexist.)
    let sequence: Int
    let capturedAt: Date
    /// Hex SHA-256 of the image bytes, computed at enqueue. Sent with the
    /// create; also what makes the duplicate-409 recovery path work.
    let sha256: String
    var progress: Progress
    /// How many times OCR has failed on this image, across relaunches.
    /// After OutboxController.maxOcrAttempts the item proceeds with empty
    /// suggestions - the receipt's safety outranks its prefill.
    var ocrAttempts: Int
    /// Non-nil when a permanent failure (an unretryable 4xx) stopped this
    /// item. It stays visible on Home with the reason and waits for a
    /// human: manual retry or discard - never an automatic loop, never a
    /// silent disappearance (wave-5 kickoff §3).
    var blockedMessage: String?
}

/// What OCR and the §7.3 heuristics produced for a queued receipt, made
/// durable so the expensive parse runs once per capture, not once per
/// upload attempt.
struct ParsedReceipt: Codable, Equatable, Sendable {
    let suggestions: ReceiptSuggestions
    let ocrRawText: String?
}
