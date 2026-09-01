import Foundation

/// Request bodies for the wave-4 capture flow, mirrored from the server's
/// zod schemas (server/src/http/schemas.ts). Encode-only counterparts to
/// APIModels' decode-only types.

/// The three content types the server presigns (its upload-url schema is
/// this exact enum). Typed because the presigned signature covers the
/// type: declaring one and PUTting another is a 403, so the two call
/// sites must be unable to disagree by construction.
///
/// `Decodable` as well since 2026-09-01: a queued outbox item records the
/// type of the document it is holding (a PDF import queues
/// `application/pdf` bytes), so this now round-trips through `item.json`
/// as well as onto the wire.
enum ImageUploadContentType: String, Codable, Equatable, Sendable {
    case jpeg = "image/jpeg"
    case png = "image/png"
    case pdf = "application/pdf"
}

/// POST /api/receipts/upload-url response: where to PUT the image bytes
/// and the object key to hand back when creating the receipt.
struct UploadTarget: Decodable, Equatable {
    let objectKey: String
    let uploadUrl: URL
}

/// The parser's suggestions as the create route records them (verbatim,
/// immutable server-side) for the §7.3 accuracy measurement. Nil fields
/// are omitted; the server stores them as "parser found nothing".
struct OcrSuggestionsPayload: Encodable, Equatable {
    let vendor: String?
    let purchasedAt: String?
    let totalCents: Int?
    let hstCents: Int?
    let subtotalCents: Int?
    /// The tip heuristic's guess (2026-08-28), recorded verbatim like
    /// every other amount for the §7.3 accuracy measurement.
    let tipCents: Int?
    /// Added 2026-09-01, when the heuristics learned to read them - see
    /// `ReceiptSuggestions.otherFeesCents` for why the "no suggestion,
    /// deliberately" ruling was reversed. Recorded verbatim like every
    /// other value here: this payload is the immutable record of what the
    /// parser said, never what the person then confirmed.
    let otherFeesCents: Int?
    let paymentMethod: String?

    init(_ suggestions: ReceiptSuggestions) {
        vendor = suggestions.vendor
        purchasedAt = suggestions.purchasedAt
        totalCents = suggestions.totalCents
        hstCents = suggestions.hstCents
        subtotalCents = suggestions.subtotalCents
        tipCents = suggestions.tipCents
        otherFeesCents = suggestions.otherFeesCents
        paymentMethod = suggestions.paymentMethod
    }

    // The server's strict schema takes absent keys, not explicit nulls, so
    // every field encodes with encodeIfPresent.
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encodeIfPresent(vendor, forKey: .vendor)
        try container.encodeIfPresent(purchasedAt, forKey: .purchasedAt)
        try container.encodeIfPresent(totalCents, forKey: .totalCents)
        try container.encodeIfPresent(hstCents, forKey: .hstCents)
        try container.encodeIfPresent(subtotalCents, forKey: .subtotalCents)
        try container.encodeIfPresent(tipCents, forKey: .tipCents)
        try container.encodeIfPresent(otherFeesCents, forKey: .otherFeesCents)
        try container.encodeIfPresent(paymentMethod, forKey: .paymentMethod)
    }

    private enum CodingKeys: String, CodingKey {
        case vendor, purchasedAt, totalCents, hstCents, subtotalCents, tipCents
        case otherFeesCents, paymentMethod
    }
}

/// POST /api/receipts - a freshly scanned receipt. Batch scans create
/// `pending` rows carrying only what the parser found (spec §6A: a human
/// confirms them in the queue); a single capture confirmed on the spot
/// creates a `confirmed` row directly, carrying the human's fields
/// alongside the parser's record (wave-5 gate ratification).
struct CreateReceiptRequest: Encodable, Equatable {
    let purchasedAt: String
    let capturedAt: String
    let vendor: String?
    let subtotalCents: Int?
    let hstCents: Int?
    let totalCents: Int?
    /// Gratuity and every other non-HST charge (2026-08-28). Absent means
    /// "no such line on this receipt" - the same rule as every other
    /// money field here.
    let tipCents: Int?
    let otherFeesCents: Int?
    let category: String?
    let paymentMethod: String?
    let notes: String?
    let status: ReceiptStatus?
    let ocrRawText: String?
    /// How the text was read (2026-09-01): `"vision"` for every capture
    /// from this app - the camera is the only source it has. Optional, and
    /// encoded only when set, so an outbox item queued by an earlier build
    /// (which stores the image and the parse, not this request) still
    /// produces a body the server's strict schema accepts.
    let ocrSource: String?
    let ocrSuggestions: OcrSuggestionsPayload
    /// Which fields a human had already looked at when this receipt was
    /// queued (2026-09-01) - the capture-time confirm form's "Later" exit
    /// carries them, and a confirmed capture reports them for symmetry.
    /// Absent (never an empty array) when nobody reviewed anything, which
    /// is the ordinary batch-scan case.
    let reviewedFields: [ReviewedField]?
    let image: Image

    struct Image: Encodable, Equatable {
        let objectKey: String
        let sha256: String
    }

    /// Defaults keep the pending-create call sites at the wave-4 shape;
    /// only the confirmed-at-capture path supplies the rest.
    init(
        purchasedAt: String,
        capturedAt: String,
        vendor: String?,
        subtotalCents: Int?,
        hstCents: Int?,
        totalCents: Int?,
        tipCents: Int? = nil,
        otherFeesCents: Int? = nil,
        category: String? = nil,
        paymentMethod: String? = nil,
        notes: String? = nil,
        status: ReceiptStatus? = nil,
        ocrRawText: String?,
        ocrSource: String? = nil,
        ocrSuggestions: OcrSuggestionsPayload,
        reviewedFields: [ReviewedField]? = nil,
        image: Image
    ) {
        self.ocrSource = ocrSource
        self.reviewedFields = reviewedFields
        self.purchasedAt = purchasedAt
        self.capturedAt = capturedAt
        self.vendor = vendor
        self.subtotalCents = subtotalCents
        self.hstCents = hstCents
        self.totalCents = totalCents
        self.tipCents = tipCents
        self.otherFeesCents = otherFeesCents
        self.category = category
        self.paymentMethod = paymentMethod
        self.notes = notes
        self.status = status
        self.ocrRawText = ocrRawText
        self.ocrSuggestions = ocrSuggestions
        self.image = image
    }

    // Absent keys, not explicit nulls, for the strict schema. `status`
    // rides only on the confirmed-at-capture path - a pending create never
    // sends it, because only a human's confirmation may set it.
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(purchasedAt, forKey: .purchasedAt)
        try container.encode(capturedAt, forKey: .capturedAt)
        try container.encodeIfPresent(vendor, forKey: .vendor)
        try container.encodeIfPresent(subtotalCents, forKey: .subtotalCents)
        try container.encodeIfPresent(hstCents, forKey: .hstCents)
        try container.encodeIfPresent(totalCents, forKey: .totalCents)
        try container.encodeIfPresent(tipCents, forKey: .tipCents)
        try container.encodeIfPresent(otherFeesCents, forKey: .otherFeesCents)
        try container.encodeIfPresent(category, forKey: .category)
        try container.encodeIfPresent(paymentMethod, forKey: .paymentMethod)
        try container.encodeIfPresent(notes, forKey: .notes)
        try container.encodeIfPresent(status, forKey: .status)
        try container.encodeIfPresent(ocrRawText, forKey: .ocrRawText)
        try container.encodeIfPresent(ocrSource, forKey: .ocrSource)
        try container.encode(ocrSuggestions, forKey: .ocrSuggestions)
        try container.encodeIfPresent(reviewedFields, forKey: .reviewedFields)
        try container.encode(image, forKey: .image)
    }

    private enum CodingKeys: String, CodingKey {
        case purchasedAt, capturedAt, vendor
        case subtotalCents, hstCents, totalCents, tipCents, otherFeesCents
        case category, paymentMethod, notes, status
        case ocrRawText, ocrSource, ocrSuggestions, reviewedFields, image
    }
}

/// PATCH /api/receipts/:id for proposal #9's swipe-to-confirm on the Home
/// list, rebuilt 2026-09-01.
///
/// It used to send `{status: "confirmed"}` alone, mirroring the web
/// client's bulk-confirm - and that was a bug on this screen, because the
/// Home row does not render the raw stored values: it renders the served
/// §7.3 merge (`ReceiptDisplay`). The row said `JIMMY THE GREEK` while the
/// swipe saved `In Store 392`, the capture-time heuristic's guess still
/// sitting in the column. A one-gesture confirmation must save exactly what
/// the person was looking at when they made it (constraint 2 - and the
/// gesture IS the human confirmation).
///
/// ⚠ Absent keys, never explicit nulls - the opposite of
/// `ConfirmReceiptRequest`, and deliberately. That request is the whole
/// reviewed form, where a blank field means "clear it"; this one carries
/// only the fields the ROW rendered, so anything it does not carry must be
/// left exactly as it is rather than wiped.
struct QuickConfirmRequest: Encodable, Equatable {
    let purchasedAt: String
    let vendor: String?
    let subtotalCents: Int?
    let hstCents: Int?
    let totalCents: Int?
    let tipCents: Int?

    /// Built from what `ReceiptDisplay` renders for this row, so the two
    /// cannot drift: a field added to the row's rendering is a field this
    /// request has to carry, and the one place to notice that is here.
    init(displaying receipt: Receipt) {
        purchasedAt = receipt.displayPurchasedAt
        vendor = receipt.displayVendor
        subtotalCents = receipt.displaySubtotalCents
        hstCents = receipt.displayHstCents
        totalCents = receipt.displayTotalCents
        tipCents = receipt.displayTipCents
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(purchasedAt, forKey: .purchasedAt)
        try container.encodeIfPresent(vendor, forKey: .vendor)
        try container.encodeIfPresent(subtotalCents, forKey: .subtotalCents)
        try container.encodeIfPresent(hstCents, forKey: .hstCents)
        try container.encodeIfPresent(totalCents, forKey: .totalCents)
        try container.encodeIfPresent(tipCents, forKey: .tipCents)
        try container.encode("confirmed", forKey: .status)
    }

    private enum CodingKeys: String, CodingKey {
        case purchasedAt, vendor, subtotalCents, hstCents, totalCents, tipCents, status
    }
}

/// PATCH /api/receipts/:id from the confirm screen: every confirmable
/// field plus the status transition, in one save. Explicit nulls here mean
/// "clear the field" - the server's update schema distinguishes absent
/// (leave unchanged) from null (clear), and the confirm screen always
/// sends the whole form, so every field is present.
///
/// The same body serves a first confirmation and a later edit of an
/// already-confirmed receipt: `status: "confirmed"` is idempotent, and
/// the route permits editing confirmed rows.
struct ConfirmReceiptRequest: Encodable, Equatable {
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
    /// Which fields a human looked at on the way here (2026-09-01).
    /// Harmless on a confirmation - a confirmed receipt is served no
    /// suggestions, so nothing consumes the set - and sent anyway so this
    /// request and `SaveForLaterRequest` below differ in as little as
    /// possible. Absent for an item queued before the field existed.
    let reviewedFields: [ReviewedField]?

    /// The PATCH body from what the confirm form produced - the same
    /// fields the capture-time path stores on a queued item, so the two
    /// save routes cannot drift apart.
    init(_ fields: ConfirmedReceiptFields) {
        reviewedFields = fields.reviewedFields
        purchasedAt = fields.purchasedAt
        vendor = fields.vendor
        subtotalCents = fields.subtotalCents
        hstCents = fields.hstCents
        totalCents = fields.totalCents
        tipCents = fields.tipCents
        otherFeesCents = fields.otherFeesCents
        category = fields.category
        paymentMethod = fields.paymentMethod
        notes = fields.notes
    }

    // Every field explicit-encoded, null included - the confirm form
    // always sends the whole form, so an explicit null here means "clear
    // the field" (the server's update schema distinguishes absent from
    // null), never "leave unchanged".
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(purchasedAt, forKey: .purchasedAt)
        try container.encode(vendor, forKey: .vendor)
        try container.encode(subtotalCents, forKey: .subtotalCents)
        try container.encode(hstCents, forKey: .hstCents)
        try container.encode(totalCents, forKey: .totalCents)
        try container.encode(tipCents, forKey: .tipCents)
        try container.encode(otherFeesCents, forKey: .otherFeesCents)
        try container.encode(category, forKey: .category)
        try container.encode(paymentMethod, forKey: .paymentMethod)
        try container.encode(notes, forKey: .notes)
        // The one key here that is absent rather than explicitly null when
        // it has no value: an item queued before this field existed has
        // nothing to say about what was reviewed, which is not the same
        // claim as "nothing was".
        try container.encodeIfPresent(reviewedFields, forKey: .reviewedFields)
        try container.encode("confirmed", forKey: .status)
    }

    private enum CodingKeys: String, CodingKey {
        case purchasedAt, vendor
        case subtotalCents, hstCents, totalCents, tipCents, otherFeesCents
        case category, paymentMethod, notes, reviewedFields, status
    }
}

/// PATCH /api/receipts/:id from the confirm screen's **Save for later**
/// (2026-09-01): the values of the fields a human has actually looked at,
/// the reviewed set itself, and deliberately **no `status`** - a PATCH
/// without one leaves the receipt pending, which is the whole point.
///
/// the owner's ask, verbatim: "let me enter partial info incrementally
/// without saving the receipt as confirmed."
///
/// ⚠ **Absent keys, never explicit nulls, for everything unreviewed** -
/// the opposite of `ConfirmReceiptRequest` above, and deliberately, the
/// same distinction `QuickConfirmRequest` draws. That request is the whole
/// reviewed form, where a blank field means "clear it"; this one carries
/// only the fields a person has looked at, so anything it does not carry
/// must be left exactly as it is rather than wiped. Writing an untouched
/// suggested value into the row is precisely what constraint 2 forbids: it
/// would stop being a suggestion and start being the record, with nobody
/// having confirmed it.
///
/// A reviewed field that is BLANK still sends an explicit null, which is
/// why the money and text fields are double optionals here: absent means
/// "not reviewed, leave it alone", present-and-null means "a person looked
/// at this and there is nothing on the paper - clear it". Collapsing the
/// two would make a cleared field un-clearable, and the row would keep
/// re-offering the value the person had just deleted.
///
/// ⚠ Not a confirmation and never a substitute for one. Nothing with
/// `status = 'pending'` may appear in an export, and this leaves it
/// pending on purpose.
struct SaveForLaterRequest: Encodable, Equatable {
    /// Replaces the stored set outright (the server's update schema says
    /// so in its own comment); the client sends the full set it knows
    /// about, which `ConfirmReceiptModel.reviewedFieldsForSave` builds as
    /// the union of what was already stored and what this sitting touched.
    let reviewedFields: [ReviewedField]
    /// Present only when reviewed - and never null: the server's
    /// `purchasedAt` is not a nullable column, and the picker always holds
    /// a date.
    private let purchasedAt: String?
    private let vendor: String??
    private let subtotalCents: Int??
    private let hstCents: Int??
    private let tipCents: Int??
    private let otherFeesCents: Int??
    private let totalCents: Int??
    private let category: String??
    private let paymentMethod: String??
    private let notes: String??

    /// Takes every field's CURRENT value and keeps only the reviewed ones
    /// - the filtering lives here rather than at the call site so a
    /// caller cannot accidentally hand over a narrower set of values than
    /// the reviewed set claims, or a wider one than constraint 2 allows.
    init(
        reviewedFields: [ReviewedField],
        purchasedAt: String,
        vendor: String?,
        subtotalCents: Int?,
        hstCents: Int?,
        tipCents: Int?,
        otherFeesCents: Int?,
        totalCents: Int?,
        category: String?,
        paymentMethod: String?,
        notes: String?
    ) {
        let reviewed = Set(reviewedFields)
        func kept<Value>(_ field: ReviewedField, _ value: Value?) -> Value?? {
            reviewed.contains(field) ? .some(value) : .none
        }
        self.reviewedFields = reviewedFields
        self.purchasedAt = reviewed.contains(.purchasedAt) ? purchasedAt : nil
        self.vendor = kept(.vendor, vendor)
        self.subtotalCents = kept(.subtotalCents, subtotalCents)
        self.hstCents = kept(.hstCents, hstCents)
        self.tipCents = kept(.tipCents, tipCents)
        self.otherFeesCents = kept(.otherFeesCents, otherFeesCents)
        self.totalCents = kept(.totalCents, totalCents)
        self.category = kept(.category, category)
        self.paymentMethod = kept(.paymentMethod, paymentMethod)
        self.notes = kept(.notes, notes)
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(reviewedFields, forKey: .reviewedFields)
        try container.encodeIfPresent(purchasedAt, forKey: .purchasedAt)
        try encode(vendor, forKey: .vendor, into: &container)
        try encode(subtotalCents, forKey: .subtotalCents, into: &container)
        try encode(hstCents, forKey: .hstCents, into: &container)
        try encode(tipCents, forKey: .tipCents, into: &container)
        try encode(otherFeesCents, forKey: .otherFeesCents, into: &container)
        try encode(totalCents, forKey: .totalCents, into: &container)
        try encode(category, forKey: .category, into: &container)
        try encode(paymentMethod, forKey: .paymentMethod, into: &container)
        try encode(notes, forKey: .notes, into: &container)
    }

    /// The three-way write the double optional exists for: absent, an
    /// explicit null, or the value. One function so all nine fields
    /// cannot drift on which of the three they mean.
    private func encode<Value: Encodable>(
        _ value: Value??,
        forKey key: CodingKeys,
        into container: inout KeyedEncodingContainer<CodingKeys>
    ) throws {
        guard let value else { return }
        if let value {
            try container.encode(value, forKey: key)
        } else {
            try container.encodeNil(forKey: key)
        }
    }

    private enum CodingKeys: String, CodingKey {
        case reviewedFields, purchasedAt, vendor
        case subtotalCents, hstCents, tipCents, otherFeesCents, totalCents
        case category, paymentMethod, notes
    }
}
