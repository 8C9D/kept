import Foundation

/// The API's data shapes, mirrored one-to-one from the server's response
/// projections (server/src/routes). These are decode-only: the iOS app is a
/// capture-and-confirm client and no domain logic lives here (spec §4.1).
///
/// Money is always an integer number of cents, exactly as the API sends it.
/// It is formatted for display at the edge (ReceiptFormat) and never passes
/// through a floating-point type.

enum ReceiptStatus: String, Codable {
    /// Stored and visible, but no human has confirmed the numbers yet.
    /// Pending receipts never reach an export (spec §5.2a).
    case pending
    case confirmed
}

/// One receipt as the list and detail routes project it.
struct Receipt: Decodable, Equatable, Hashable, Identifiable {
    let id: UUID
    /// The date on the receipt, as a yyyy-mm-dd string. It stays a plain
    /// calendar date end to end - turning it into a Date would invent a
    /// time and a timezone the receipt never had.
    let purchasedAt: String
    let capturedAt: Date
    let vendor: String?
    let vendorTaxNumber: String?
    let subtotalCents: Int?
    let hstCents: Int?
    let otherTaxCents: Int?
    let totalCents: Int
    let currency: String
    let category: String?
    let paymentMethod: String?
    let isBusiness: Bool
    let notes: String?
    let status: ReceiptStatus
    let createdAt: Date
    let updatedAt: Date
}

/// One page of GET /api/receipts. `nextCursor` is opaque; handing it back
/// unchanged is the whole pagination contract. `pendingCount` is the
/// user's total pending receipts - independent of this page's filters and
/// paging - and feeds the §5.2a badge directly (wave-3 gate review; it
/// replaced a 200-row client-side probe).
struct ReceiptListPage: Decodable, Equatable {
    let receipts: [Receipt]
    let nextCursor: String?
    let pendingCount: Int
}

struct ReceiptImage: Decodable, Equatable {
    let page: Int
    /// A presigned, short-lived download URL. Fetch it promptly and never
    /// persist it.
    let downloadUrl: URL
}

/// GET /api/receipts/:id - every Receipt field plus what only the detail
/// route returns. Decoding delegates the shared fields to Receipt so the
/// two shapes cannot drift apart.
struct ReceiptDetail: Decodable, Equatable {
    let receipt: Receipt
    let ocrRawText: String?
    let images: [ReceiptImage]

    private enum CodingKeys: String, CodingKey {
        case ocrRawText
        case images
    }

    init(receipt: Receipt, ocrRawText: String?, images: [ReceiptImage]) {
        self.receipt = receipt
        self.ocrRawText = ocrRawText
        self.images = images
    }

    init(from decoder: Decoder) throws {
        receipt = try Receipt(from: decoder)
        let container = try decoder.container(keyedBy: CodingKeys.self)
        ocrRawText = try container.decodeIfPresent(String.self, forKey: .ocrRawText)
        images = try container.decode([ReceiptImage].self, forKey: .images)
    }
}

struct SessionUser: Decodable, Equatable {
    let id: UUID
    let displayName: String?
    let email: String?
}

/// POST /api/auth/apple - the session JWT plus who signed in.
struct SignInResponse: Decodable, Equatable {
    let token: String
    let user: SessionUser
}
