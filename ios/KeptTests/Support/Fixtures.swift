import Foundation
@testable import Kept

/// Builders for model values. Defaults mirror the server's synthetic seed
/// data; tests override only what they assert on.
enum Fixtures {
    static func receipt(
        id: UUID = UUID(),
        purchasedAt: String = "2026-03-20",
        vendor: String? = "Synthetic Vendor",
        subtotalCents: Int? = nil,
        hstCents: Int? = nil,
        tipCents: Int? = nil,
        otherFeesCents: Int? = nil,
        totalCents: Int? = 2925,
        currency: String = "CAD",
        category: String? = nil,
        paymentMethod: String? = nil,
        notes: String? = nil,
        status: ReceiptStatus = .confirmed,
        suggestions: MergedSuggestions? = nil,
        /// The server's `reviewedFields` (2026-09-01, migration 0009) as
        /// the wire carries it - strings, so a fixture can also state what
        /// a pre-migration response looked like (nil) or what an unknown
        /// name would do.
        reviewedFields: [String]? = nil
    ) -> Receipt {
        Receipt(
            id: id,
            purchasedAt: purchasedAt,
            capturedAt: Date(timeIntervalSince1970: 1_774_000_000),
            vendor: vendor,
            subtotalCents: subtotalCents,
            hstCents: hstCents,
            tipCents: tipCents,
            otherFeesCents: otherFeesCents,
            totalCents: totalCents,
            currency: currency,
            category: category,
            paymentMethod: paymentMethod,
            notes: notes,
            status: status,
            suggestions: suggestions,
            createdAt: Date(timeIntervalSince1970: 1_774_000_000),
            updatedAt: Date(timeIntervalSince1970: 1_774_000_000),
            reviewedFields: reviewedFields
        )
    }

    static func detail(
        receipt: Receipt,
        ocrRawText: String? = nil,
        images: [ReceiptImage] = []
    ) -> ReceiptDetail {
        ReceiptDetail(
            receipt: receipt,
            ocrRawText: ocrRawText,
            images: images
        )
    }

    /// The server's §7.3 merge as a receipt response carries it.
    static func merged(
        vendor: String? = nil,
        purchasedAt: String? = nil,
        dateDisagreement: Bool = false,
        totalCents: Int? = nil,
        hstCents: Int? = nil,
        hstDisagreement: Bool = false,
        subtotalCents: Int? = nil,
        tipCents: Int? = nil,
        otherFeesCents: Int? = nil,
        suggestedPaymentMethod: String? = nil,
        totalWithheld: Bool = false,
        subtotalWithheld: Bool = false
    ) -> MergedSuggestions {
        MergedSuggestions(
            vendor: MergedSuggestion(value: vendor),
            purchasedAt: MergedDateSuggestion(value: purchasedAt, disagreement: dateDisagreement),
            totalCents: MergedSuggestion(value: totalCents, withheld: totalWithheld),
            hstCents: MergedAmountSuggestion(value: hstCents, disagreement: hstDisagreement),
            subtotalCents: MergedSuggestion(value: subtotalCents, withheld: subtotalWithheld),
            tipCents: MergedSuggestion(value: tipCents),
            otherFeesCents: MergedSuggestion(value: otherFeesCents),
            paymentMethod: MergedSuggestion(value: suggestedPaymentMethod)
        )
    }

    static func page(
        _ receipts: [Receipt],
        nextCursor: String? = nil,
        pendingCount: Int = 0
    ) -> ReceiptListPage {
        ReceiptListPage(receipts: receipts, nextCursor: nextCursor, pendingCount: pendingCount)
    }

    /// GET /api/receipts/summary's shape (proposal #3).
    static func summary(
        count: Int = 0,
        subtotalCents: Int = 0,
        hstCents: Int = 0,
        tipCents: Int = 0,
        otherFeesCents: Int = 0,
        totalCents: Int = 0,
        pendingCount: Int = 0
    ) -> ReceiptSummary {
        ReceiptSummary(
            confirmed: ReceiptSummary.Confirmed(
                count: count,
                subtotalCents: subtotalCents,
                hstCents: hstCents,
                tipCents: tipCents,
                otherFeesCents: otherFeesCents,
                totalCents: totalCents
            ),
            pendingCount: pendingCount
        )
    }

    static func exportJob(
        id: UUID = UUID(),
        status: ExportJobStatus = .queued,
        periodStart: String = "2026-01-01",
        periodEnd: String = "2026-12-31",
        error: String? = nil,
        downloadUrl: URL? = nil
    ) -> ExportJob {
        ExportJob(
            id: id,
            status: status,
            periodStart: periodStart,
            periodEnd: periodEnd,
            error: error,
            createdAt: Date(timeIntervalSince1970: 1_774_000_000),
            completedAt: status == .complete ? Date(timeIntervalSince1970: 1_774_000_100) : nil,
            downloadUrl: downloadUrl
        )
    }

    /// GET /api/me's shape (proposal #10). Defaults to the server's own
    /// default year end (§5.1: 31 December) so a test only overrides what
    /// it is actually pinning a non-December year end to assert on.
    static func profile(
        id: UUID = UUID(),
        displayName: String? = "Synthetic User A",
        email: String? = nil,
        fiscalYearEndMonth: Int = 12,
        fiscalYearEndDay: Int = 31
    ) -> Profile {
        Profile(
            id: id,
            displayName: displayName,
            email: email,
            fiscalYearEndMonth: fiscalYearEndMonth,
            fiscalYearEndDay: fiscalYearEndDay
        )
    }

    static func signInResponse(token: String = "session-jwt") -> SignInResponse {
        SignInResponse(
            token: token,
            user: SessionUser(id: UUID(), displayName: "Synthetic User A", email: nil)
        )
    }
}
