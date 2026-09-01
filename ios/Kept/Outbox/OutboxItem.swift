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
    /// Present when a human confirmed the fields on the capture-time
    /// confirm screen (the single-capture flow, wave-5 gate ratification):
    /// the create sends these with status `confirmed`, so the receipt
    /// lands already done and never joins the pending queue. Optional so
    /// items persisted before this field existed decode as unconfirmed.
    let confirmation: ConfirmedReceiptFields?
    /// What a human had typed into the capture-time confirm form when they
    /// left it with "Later" (2026-09-01) - the values for the fields they
    /// actually looked at, and which fields those were. The create writes
    /// those into the row and reports them reviewed; every other column
    /// keeps carrying the parser's snapshot, exactly as before.
    ///
    /// Optional, and never written by any earlier build: an item queued
    /// before this field existed carries no such key, and the synthesized
    /// decoder reads a missing key on an Optional property as nil - so a
    /// receipt captured before the update still drains afterwards instead
    /// of being stranded on the phone. `confirmation` and this are
    /// mutually exclusive in practice (one is the Save exit, the other the
    /// Later exit) but nothing here enforces that: the drain reads
    /// `confirmation` first and a confirmed create needs nothing from
    /// here.
    let partial: PendingReceiptFields?
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

/// What a human confirmed on the §7.2 form, field for field. The total is
/// non-optional because the form cannot save without it - the same
/// completeness the server's CHECK constraint demands of a confirmed row.
/// Carried by a queued item when confirmation happened at capture;
/// consumed by the drain's create.
///
/// Decoding is forward-compatible by construction: an item queued by an
/// earlier build carries the retired `vendorTaxNumber`, `otherTaxCents`
/// and `isBusiness` keys, and JSONDecoder ignores keys no property
/// declares - so a receipt captured before this build still uploads after
/// the update instead of being stranded on the phone.
///
/// The reverse also holds for `tipCents` and `otherFeesCents` (2026-08-28):
/// both are Optional, and the synthesized decoder treats a missing key on
/// an Optional property as nil - so an item a pre-tip build already wrote
/// to disk decodes cleanly with both fields absent, not corrupted or
/// dropped, and drains through the outbox exactly as it would have before
/// this field existed.
struct ConfirmedReceiptFields: Codable, Equatable, Sendable {
    let purchasedAt: String
    let vendor: String?
    let subtotalCents: Int?
    let hstCents: Int?
    let totalCents: Int
    let tipCents: Int?
    let otherFeesCents: Int?
    let category: String?
    let paymentMethod: String?
    let notes: String?
    /// Which fields the person actually looked at on the way to confirming
    /// (2026-09-01, `ReviewedField`). Inert on a confirmed receipt - the
    /// server serves no suggestions for one, so nothing consumes the set -
    /// and carried anyway so a confirm and a save-for-later differ in as
    /// little as possible. Optional for the same forward-compatibility
    /// reason `tipCents` is: an item a pre-2026-09-01 build wrote to disk
    /// decodes with the key absent and uploads unchanged.
    var reviewedFields: [ReviewedField]?

    init(
        purchasedAt: String,
        vendor: String?,
        subtotalCents: Int?,
        hstCents: Int?,
        totalCents: Int,
        tipCents: Int?,
        otherFeesCents: Int?,
        category: String?,
        paymentMethod: String?,
        notes: String?,
        reviewedFields: [ReviewedField]? = nil
    ) {
        self.purchasedAt = purchasedAt
        self.vendor = vendor
        self.subtotalCents = subtotalCents
        self.hstCents = hstCents
        self.totalCents = totalCents
        self.tipCents = tipCents
        self.otherFeesCents = otherFeesCents
        self.category = category
        self.paymentMethod = paymentMethod
        self.notes = notes
        self.reviewedFields = reviewedFields
    }
}

/// What a human had typed into a capture-time confirm form before leaving
/// it with "Later" (2026-09-01) - the values, plus which fields they had
/// actually reviewed.
///
/// The pending twin of `ConfirmedReceiptFields`: same ten fields, every
/// one of them optional (a half-filled form has no required anything, and
/// the server leaves `totalCents` nullable exactly as long as the receipt
/// stays pending), plus the reviewed set that says which of the values are
/// a human's and which are simply blank.
///
/// ⚠ `reviewedFields` is what the create reads, never the values' own
/// nil-ness. "Reviewed and deliberately blank" and "not reviewed" are
/// different facts about the same nil: the first must leave the column
/// empty, the second must let the parser's snapshot fill it, and a create
/// that inferred one from the other would quietly overwrite a cleared
/// field with the guess the person had just deleted.
struct PendingReceiptFields: Codable, Equatable, Sendable {
    let reviewedFields: [ReviewedField]
    let purchasedAt: String
    let vendor: String?
    let subtotalCents: Int?
    let hstCents: Int?
    let tipCents: Int?
    let otherFeesCents: Int?
    let totalCents: Int?
    let category: String?
    let paymentMethod: String?
    let notes: String?

    /// Whether the person reviewed this field - the one question the
    /// create asks of this type per column.
    func reviewed(_ field: ReviewedField) -> Bool {
        reviewedFields.contains(field)
    }
}
