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

/// One field of the §7.3 merge the server computes over both parse paths
/// and serves on every receipt response. The API also states per-field
/// provenance (`source`) and this client deliberately does not decode it:
/// amber already means "a human has not looked", and a source badge would
/// ask the user to adjudicate parser internals. Provenance stays in the
/// API for diagnostics.
struct MergedSuggestion<Value: Decodable & Hashable>: Decodable, Hashable {
    /// Nil is "neither ruled parser produced a value" - for the money
    /// fields, "the heuristic found nothing" (no LLM fallthrough, §7.3) -
    /// and renders as a stated absence, never a fabricated value.
    let value: Value?
}

/// The date's merge entry carries the one per-field flag: both parsers
/// read a date off the same text and they differ - free signal on the
/// field that decides the fiscal year (§7.3).
struct MergedDateSuggestion: Decodable, Hashable {
    let value: String?
    let disagreement: Bool
}

/// HST's merge entry (2026-08-28): the same amount rule as every other
/// money field - the heuristic's value, or a stated absence, never the
/// LLM's (§7.3, no fallthrough) - with the date entry's disagreement flag
/// layered on top. HST is the input tax credit, the one amount with a
/// direct tax consequence, and it is exactly the field a split-HST receipt
/// corrupts: a heuristic that reads one half of a printed 5%+8% split
/// produces a wrong-but-entirely-plausible number that the arithmetic
/// check cannot catch when the subtotal is also missing. `disagreement` is
/// free signal from two independent parsers reading the same text, same
/// reasoning as the date flag; it never changes which value is served.
struct MergedAmountSuggestion: Decodable, Hashable {
    let value: Int?
    let disagreement: Bool
}

/// The two parse records merged under §7.3's field-level rule, computed by
/// the server's domain layer. This client renders it and decides nothing
/// (spec §4.1) - which fields prefill, which start amber, and the date
/// note all read straight off this shape.
///
/// The wire still carries a `vendorTaxNumber` entry: the server keeps it
/// as a served absence so the shipped 1.0 (1) build, which decodes that
/// key non-optionally, keeps working. It is deliberately not declared
/// here - an undeclared key is simply not decoded - and nothing in this
/// build reads a tax number.
struct MergedSuggestions: Decodable, Hashable {
    let vendor: MergedSuggestion<String>
    let purchasedAt: MergedDateSuggestion
    let totalCents: MergedSuggestion<Int>
    /// Heuristic-only value, plus the disagreement flag (2026-08-28) - see
    /// MergedAmountSuggestion.
    let hstCents: MergedAmountSuggestion
    let subtotalCents: MergedSuggestion<Int>
    /// Heuristic-only, same as the other amounts: no LLM fallthrough
    /// (§7.3's amended rule extends to this field, 2026-08-28).
    let tipCents: MergedSuggestion<Int>

    /// Deliberately no `otherFeesCents` here (2026-08-28 product
    /// feedback): "other fees" is a residual with no consistent printed
    /// label - delivery, service charges, deposits, a foreign receipt's
    /// non-HST tax - so no heuristic can match it and no accuracy
    /// measurement could score a guess against it. It is a human-entered
    /// field with no suggestion to be amber about.
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
    let subtotalCents: Int?
    let hstCents: Int?
    /// Gratuity (2026-08-28 product feedback: tips are common enough on
    /// real receipts that folding them into "arithmetic doesn't
    /// reconcile" was the wrong call - they get their own field).
    let tipCents: Int?
    /// Every non-HST charge that is neither subtotal nor tip: delivery,
    /// service charges, deposits, environmental levies, a foreign
    /// receipt's non-HST tax. Human-entered only - no heuristic or LLM
    /// suggests it (see MergedSuggestions).
    let otherFeesCents: Int?
    /// Nullable since wave 4: a batch-scanned pending receipt whose total
    /// the parser could not read stores the absence. A confirmed receipt
    /// always has one (server check constraint).
    let totalCents: Int?
    let currency: String
    let category: String?
    let paymentMethod: String?
    let notes: String?
    let status: ReceiptStatus
    /// The server-merged suggestion set (§7.3), on every receipt response.
    /// Nil when neither parser ever saw the receipt - a different fact
    /// from "both ran and found nothing" (a full set of null values).
    let suggestions: MergedSuggestions?
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

/// GET /api/receipts/summary (proposal #3, 2026-08-28) - the running
/// totals for whatever filter the caller sent, the same
/// `receiptFilterQuerySchema` GET / accepts, minus its paging and sorting
/// (ReceiptQuery.filterQueryItems is what builds that request).
///
/// `confirmed` is every count and sum over CONFIRMED rows only;
/// `pendingCount` is the same filter's pending rows, counted and nothing
/// else - never blended into `confirmed`. This mirrors the server's own
/// warning verbatim (routes/receipts.ts's `/summary` handler): nothing
/// with status = 'pending' may ever reach an export (spec §5.2a), so a
/// summary that folded pending rows into its totals would disagree with
/// the export sitting next to it. Rendering this must keep the two
/// separate the same way the response does - HomeView's summary block is
/// the one place that renders it, and its own comment explains how it
/// reconciles with the unrelated, whole-account pending badge already on
/// that screen.
struct ReceiptSummary: Decodable, Equatable {
    struct Confirmed: Decodable, Equatable {
        let count: Int
        let subtotalCents: Int
        let hstCents: Int
        let tipCents: Int
        let otherFeesCents: Int
        let totalCents: Int
    }

    let confirmed: Confirmed
    let pendingCount: Int
}

/// One vendor's remembered category and payment method (proposal #2,
/// 2026-08-28), from that vendor's most recent CONFIRMED receipt - the
/// server's `vendorDefaultCandidates` picks confirmed-only deliberately
/// (its own doc comment, receipts.ts): a default PREFILLS a different
/// receipt without anyone having looked at THIS one yet, so sourcing it
/// from a still-unreviewed guess would risk compounding one unconfirmed
/// value into a second one. Either field can be nil independently - a
/// vendor whose confirmed receipts carried a category but never a payment
/// method still offers the one it has.
struct VendorDefault: Codable, Equatable {
    let category: String?
    let paymentMethod: String?
}

/// GET /api/receipts/options - the free-text values this user has already
/// used, most recently used first, so the confirm form can offer them
/// back. All three list fields stay free text (engineering rule: no enum,
/// no taxonomy); these are suggestions drawn from the person's own data,
/// not a vocabulary they must pick from. `vendors` joined the other two
/// 2026-08-28, on the same product feedback that added tip and other
/// fees - vendor names repeat for a small business the same way categories
/// and payment methods do.
///
/// Codable, not just Decodable: the last fetch is cached on disk so an
/// offline capture-time confirm still has something to offer.
struct ReceiptOptions: Codable, Equatable {
    let categories: [String]
    let paymentMethods: [String]
    let vendors: [String]
    /// Proposal #2 (2026-08-28): per vendor, the category and payment
    /// method to prefill when that vendor is typed on the confirm form -
    /// keyed by the EXACT vendor string served in `vendors` above (exact,
    /// unnormalized match: the 2026-08-26 ruling is that these are the
    /// person's own values, and an options list that quietly rewrote them
    /// would offer a string the exact-match filter then fails to find).
    let vendorDefaults: [String: VendorDefault]

    static let none = ReceiptOptions(categories: [], paymentMethods: [], vendors: [], vendorDefaults: [:])

    var isEmpty: Bool {
        categories.isEmpty && paymentMethods.isEmpty && vendors.isEmpty
    }

    init(
        categories: [String],
        paymentMethods: [String],
        vendors: [String],
        vendorDefaults: [String: VendorDefault] = [:]
    ) {
        self.categories = categories
        self.paymentMethods = paymentMethods
        self.vendors = vendors
        self.vendorDefaults = vendorDefaults
    }

    /// Custom decoding, deliberately: `vendorDefaults` is a key neither a
    /// pre-2026-08-28 server response nor a disk cache written by an
    /// earlier build ever carried. `ReceiptOptionsStore.cached(in:)`
    /// already has a contract for a cache this build cannot make sense of
    /// at all ("an unreadable cache is replaced on next refresh" - it
    /// decodes with `try?` and treats a thrown error as no cache), and
    /// that contract alone would already keep a pre-existing cache from
    /// crashing anything, missing key included. This goes one step
    /// gentler than that floor: `decodeIfPresent` means a response or a
    /// cache missing only this one key still decodes successfully, with
    /// an empty dictionary meaning exactly what an old server or an old
    /// cache actually means - "no defaults known" - rather than discarding
    /// a perfectly good cached `categories`/`paymentMethods`/`vendors` for
    /// the sake of one additive key.
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        categories = try container.decode([String].self, forKey: .categories)
        paymentMethods = try container.decode([String].self, forKey: .paymentMethods)
        vendors = try container.decode([String].self, forKey: .vendors)
        vendorDefaults = try container.decodeIfPresent([String: VendorDefault].self, forKey: .vendorDefaults) ?? [:]
    }

    private enum CodingKeys: String, CodingKey {
        case categories, paymentMethods, vendors, vendorDefaults
    }
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
///
/// The route also serves the raw `ocrSuggestions` record for the shipped
/// client; this client stopped reading it when the server-merged
/// `suggestions` landed (§7.3) - the merge is the suggestion set now.
struct ReceiptDetail: Decodable, Equatable {
    let receipt: Receipt
    let ocrRawText: String?
    let images: [ReceiptImage]

    private enum CodingKeys: String, CodingKey {
        case ocrRawText
        case images
    }

    init(
        receipt: Receipt,
        ocrRawText: String?,
        images: [ReceiptImage]
    ) {
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

/// GET /api/me (server/src/routes/me.ts's `profileOf`) - this user's own
/// profile. Read here only for `fiscalYearEndMonth`/`fiscalYearEndDay`
/// (proposal #10, 2026-08-28, Export/ExportView.swift's period presets) -
/// spec §5.1 calls the pair "config, not an assumption": it defaults to 31
/// December, but a preset that assumed that default rather than reading it
/// would be silently wrong the moment someone sets a different one, and
/// wrong in a way that produces a plausible-looking export. This client
/// never writes these fields - PATCH /api/me exists server-side, but
/// nothing here calls it.
struct Profile: Decodable, Equatable {
    let id: UUID
    let displayName: String?
    let email: String?
    let fiscalYearEndMonth: Int
    let fiscalYearEndDay: Int
}
