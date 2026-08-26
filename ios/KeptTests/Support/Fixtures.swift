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
        totalCents: Int? = 2925,
        currency: String = "CAD",
        category: String? = nil,
        paymentMethod: String? = nil,
        notes: String? = nil,
        status: ReceiptStatus = .confirmed,
        suggestions: MergedSuggestions? = nil
    ) -> Receipt {
        Receipt(
            id: id,
            purchasedAt: purchasedAt,
            capturedAt: Date(timeIntervalSince1970: 1_774_000_000),
            vendor: vendor,
            subtotalCents: subtotalCents,
            hstCents: hstCents,
            totalCents: totalCents,
            currency: currency,
            category: category,
            paymentMethod: paymentMethod,
            notes: notes,
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
        subtotalCents: Int? = nil
    ) -> MergedSuggestions {
        MergedSuggestions(
            vendor: MergedSuggestion(value: vendor),
            purchasedAt: MergedDateSuggestion(value: purchasedAt, disagreement: dateDisagreement),
            totalCents: MergedSuggestion(value: totalCents),
            hstCents: MergedSuggestion(value: hstCents),
            subtotalCents: MergedSuggestion(value: subtotalCents)
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
