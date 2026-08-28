import Foundation

/// Request bodies for the wave-4 capture flow, mirrored from the server's
/// zod schemas (server/src/http/schemas.ts). Encode-only counterparts to
/// APIModels' decode-only types.

/// The three content types the server presigns (its upload-url schema is
/// this exact enum). Typed because the presigned signature covers the
/// type: declaring one and PUTting another is a 403, so the two call
/// sites must be unable to disagree by construction.
enum ImageUploadContentType: String, Encodable, Equatable {
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
    /// every other amount for the §7.3 accuracy measurement. No
    /// `otherFeesCents` key here: nothing heuristic ever suggests it, so
    /// there is nothing to record.
    let tipCents: Int?

    init(_ suggestions: ReceiptSuggestions) {
        vendor = suggestions.vendor
        purchasedAt = suggestions.purchasedAt
        totalCents = suggestions.totalCents
        hstCents = suggestions.hstCents
        subtotalCents = suggestions.subtotalCents
        tipCents = suggestions.tipCents
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
    }

    private enum CodingKeys: String, CodingKey {
        case vendor, purchasedAt, totalCents, hstCents, subtotalCents, tipCents
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
    let ocrSuggestions: OcrSuggestionsPayload
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
        ocrSuggestions: OcrSuggestionsPayload,
        image: Image
    ) {
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
        try container.encode(ocrSuggestions, forKey: .ocrSuggestions)
        try container.encode(image, forKey: .image)
    }

    private enum CodingKeys: String, CodingKey {
        case purchasedAt, capturedAt, vendor
        case subtotalCents, hstCents, totalCents, tipCents, otherFeesCents
        case category, paymentMethod, notes, status
        case ocrRawText, ocrSuggestions, image
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

    /// The PATCH body from what the confirm form produced - the same
    /// fields the capture-time path stores on a queued item, so the two
    /// save routes cannot drift apart.
    init(_ fields: ConfirmedReceiptFields) {
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
        try container.encode("confirmed", forKey: .status)
    }

    private enum CodingKeys: String, CodingKey {
        case purchasedAt, vendor
        case subtotalCents, hstCents, totalCents, tipCents, otherFeesCents
        case category, paymentMethod, notes, status
    }
}
