import Foundation
@testable import Kept

/// Builders for model values. Defaults mirror the server's synthetic seed
/// data; tests override only what they assert on.
enum Fixtures {
    static func receipt(
        id: UUID = UUID(),
        purchasedAt: String = "2026-03-20",
        vendor: String? = "Synthetic Vendor",
        totalCents: Int = 2925,
        currency: String = "CAD",
        status: ReceiptStatus = .confirmed
    ) -> Receipt {
        Receipt(
            id: id,
            purchasedAt: purchasedAt,
            capturedAt: Date(timeIntervalSince1970: 1_774_000_000),
            vendor: vendor,
            vendorTaxNumber: nil,
            subtotalCents: nil,
            hstCents: nil,
            otherTaxCents: nil,
            totalCents: totalCents,
            currency: currency,
            category: nil,
            paymentMethod: nil,
            isBusiness: true,
            notes: nil,
            status: status,
            createdAt: Date(timeIntervalSince1970: 1_774_000_000),
            updatedAt: Date(timeIntervalSince1970: 1_774_000_000)
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
