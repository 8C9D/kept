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
    let vendorTaxNumber: String?

    init(_ suggestions: ReceiptSuggestions) {
        vendor = suggestions.vendor
        purchasedAt = suggestions.purchasedAt
        totalCents = suggestions.totalCents
        hstCents = suggestions.hstCents
        subtotalCents = suggestions.subtotalCents
        vendorTaxNumber = suggestions.vendorTaxNumber
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
        try container.encodeIfPresent(vendorTaxNumber, forKey: .vendorTaxNumber)
    }

    private enum CodingKeys: String, CodingKey {
        case vendor, purchasedAt, totalCents, hstCents, subtotalCents, vendorTaxNumber
    }
}

/// POST /api/receipts - a freshly scanned receipt, created `pending` with
/// whatever the parser found (spec §6A: each scan in a batch becomes its
/// own pending receipt; a human confirms it in the queue).
struct CreateReceiptRequest: Encodable, Equatable {
    let purchasedAt: String
    let capturedAt: String
    let vendor: String?
    let vendorTaxNumber: String?
    let subtotalCents: Int?
    let hstCents: Int?
    let totalCents: Int?
    let ocrRawText: String?
    let ocrSuggestions: OcrSuggestionsPayload
    let image: Image

    struct Image: Encodable, Equatable {
        let objectKey: String
        let sha256: String
    }

    // Absent keys, not explicit nulls, for the strict schema; `isBusiness`
    // is never sent at create - it has no default anywhere (spec §5.2) and
    // only the confirm screen's explicit choice ever supplies it.
    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(purchasedAt, forKey: .purchasedAt)
        try container.encode(capturedAt, forKey: .capturedAt)
        try container.encodeIfPresent(vendor, forKey: .vendor)
        try container.encodeIfPresent(vendorTaxNumber, forKey: .vendorTaxNumber)
        try container.encodeIfPresent(subtotalCents, forKey: .subtotalCents)
        try container.encodeIfPresent(hstCents, forKey: .hstCents)
        try container.encodeIfPresent(totalCents, forKey: .totalCents)
        try container.encodeIfPresent(ocrRawText, forKey: .ocrRawText)
        try container.encode(ocrSuggestions, forKey: .ocrSuggestions)
        try container.encode(image, forKey: .image)
    }

    private enum CodingKeys: String, CodingKey {
        case purchasedAt, capturedAt, vendor, vendorTaxNumber
        case subtotalCents, hstCents, totalCents
        case ocrRawText, ocrSuggestions, image
    }
}

/// PATCH /api/receipts/:id from the confirm screen: every confirmable
/// field plus the status transition, in one save. Explicit nulls here mean
/// "clear the field" - the server's update schema distinguishes absent
/// (leave unchanged) from null (clear), and the confirm screen always
/// sends the whole form, so every field is present.
struct ConfirmReceiptRequest: Encodable, Equatable {
    let purchasedAt: String
    let vendor: String?
    let vendorTaxNumber: String?
    let subtotalCents: Int?
    let hstCents: Int?
    let otherTaxCents: Int?
    let totalCents: Int
    let category: String?
    let paymentMethod: String?
    let isBusiness: Bool
    let notes: String?

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(purchasedAt, forKey: .purchasedAt)
        try container.encode(vendor, forKey: .vendor)
        try container.encode(vendorTaxNumber, forKey: .vendorTaxNumber)
        try container.encode(subtotalCents, forKey: .subtotalCents)
        try container.encode(hstCents, forKey: .hstCents)
        try container.encode(otherTaxCents, forKey: .otherTaxCents)
        try container.encode(totalCents, forKey: .totalCents)
        try container.encode(category, forKey: .category)
        try container.encode(paymentMethod, forKey: .paymentMethod)
        try container.encode(isBusiness, forKey: .isBusiness)
        try container.encode(notes, forKey: .notes)
        try container.encode("confirmed", forKey: .status)
    }

    private enum CodingKeys: String, CodingKey {
        case purchasedAt, vendor, vendorTaxNumber
        case subtotalCents, hstCents, otherTaxCents, totalCents
        case category, paymentMethod, isBusiness, notes, status
    }
}
