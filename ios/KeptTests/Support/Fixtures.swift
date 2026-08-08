import Foundation
@testable import Kept

/// Builders for model values. Defaults mirror the server's synthetic seed
/// data; tests override only what they assert on.
enum Fixtures {
    static func receipt(
        id: UUID = UUID(),
        purchasedAt: String = "2026-03-20",
        vendor: String? = "Synthetic Vendor",
        vendorTaxNumber: String? = nil,
        subtotalCents: Int? = nil,
        hstCents: Int? = nil,
        totalCents: Int? = 2925,
        currency: String = "CAD",
        isBusiness: Bool? = true,
        status: ReceiptStatus = .confirmed,
        suggestions: MergedSuggestions? = nil
    ) -> Receipt {
        Receipt(
            id: id,
            purchasedAt: purchasedAt,
            capturedAt: Date(timeIntervalSince1970: 1_774_000_000),
            vendor: vendor,
            vendorTaxNumber: vendorTaxNumber,
            subtotalCents: subtotalCents,
            hstCents: hstCents,
            otherTaxCents: nil,
            totalCents: totalCents,
            currency: currency,
            category: nil,
            paymentMethod: nil,
            isBusiness: isBusiness,
            notes: nil,
            status: status,
            suggestions: suggestions,
            createdAt: Date(timeIntervalSince1970: 1_774_000_000),
            updatedAt: Date(timeIntervalSince1970: 1_774_000_000)
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
        subtotalCents: Int? = nil,
        vendorTaxNumber: String? = nil
    ) -> MergedSuggestions {
        MergedSuggestions(
            vendor: MergedSuggestion(value: vendor),
            purchasedAt: MergedDateSuggestion(value: purchasedAt, disagreement: dateDisagreement),
            totalCents: MergedSuggestion(value: totalCents),
            hstCents: MergedSuggestion(value: hstCents),
            subtotalCents: MergedSuggestion(value: subtotalCents),
            vendorTaxNumber: MergedSuggestion(value: vendorTaxNumber)
        )
    }

    static func page(
        _ receipts: [Receipt],
        nextCursor: String? = nil,
        pendingCount: Int = 0
    ) -> ReceiptListPage {
        ReceiptListPage(receipts: receipts, nextCursor: nextCursor, pendingCount: pendingCount)
    }

    static func signInResponse(token: String = "session-jwt") -> SignInResponse {
        SignInResponse(
            token: token,
            user: SessionUser(id: UUID(), displayName: "Synthetic User A", email: nil)
        )
    }
}
