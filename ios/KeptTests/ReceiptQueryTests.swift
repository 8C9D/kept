import XCTest
@testable import Kept

/// The list query as a value: what reaches the wire, what counts as
/// narrowing the list, and how a date range reads back to the person.
///
/// These are the parts the SwiftUI filter menu cannot pin - the menu can
/// only be driven by hand - so the rules live here, where they are cheap
/// to assert and impossible to skip.
final class ReceiptQueryTests: XCTestCase {
    /// Pinned so the assertions do not move with the test machine's
    /// region settings.
    private let locale = Locale(identifier: "en_US")

    private func items(_ query: ReceiptQuery) -> [String: String] {
        Dictionary(
            uniqueKeysWithValues: query.queryItems.compactMap { item in
                item.value.map { (item.name, $0) }
            }
        )
    }

    // MARK: - What reaches the wire

    func testTheDefaultQuerySendsItsOrderingAndNothingElse() {
        // sort and order are always sent, including at their defaults: the
        // cursor encodes what it was minted under, so the client states
        // its ordering rather than trusting the server's to keep matching.
        XCTAssertEqual(items(.default), ["sort": "purchasedAt", "order": "desc"])
        XCTAssertFalse(ReceiptQuery.default.isFiltering)
    }

    /// Every sort key says what its two directions mean in its own terms,
    /// and opens on the direction a person means by picking it. Vendor is
    /// the alphabetical odd one out on both counts (2026-09-01).
    func testEverySortKeyNamesItsDirectionsAndOpensOnTheRightOne() {
        XCTAssertEqual(ReceiptQuery.Sort.vendor.orderLabel(.asc), "A → Z")
        XCTAssertEqual(ReceiptQuery.Sort.vendor.orderLabel(.desc), "Z → A")
        XCTAssertEqual(ReceiptQuery.Sort.vendor.naturalOrder, .asc)

        XCTAssertEqual(ReceiptQuery.Sort.purchasedAt.orderLabel(.desc), "Newest first")
        XCTAssertEqual(ReceiptQuery.Sort.total.orderLabel(.desc), "Largest first")
        for sort in [ReceiptQuery.Sort.purchasedAt, .capturedAt, .total] {
            XCTAssertEqual(sort.naturalOrder, .desc, "\(sort) opens on the wrong end")
        }
    }

    /// The menu offers exactly the four keys the server accepts - a fifth
    /// case added here without a server `sort` value behind it would 400
    /// the list rather than fail visibly.
    func testTheSortMenuOffersEverySortKey() {
        XCTAssertEqual(
            ReceiptQuery.Sort.allCases.map(\.rawValue),
            ["purchasedAt", "capturedAt", "total", "vendor"]
        )
        XCTAssertEqual(ReceiptQuery.Sort.vendor.label, "Vendor")
    }

    func testEveryFilterIsOmittedRatherThanSentEmpty() {
        // The server's list schema is strict: `q`, `category` and
        // `paymentMethod` all have a minimum length of 1, so an unset
        // filter must be an absent key, never "".
        var query = ReceiptQuery.default
        query.search = "   "
        query.category = nil
        query.paymentMethod = nil
        query.from = nil
        query.to = nil

        let sent = items(query)
        XCTAssertNil(sent["q"])
        XCTAssertNil(sent["category"])
        XCTAssertNil(sent["paymentMethod"])
        XCTAssertNil(sent["from"])
        XCTAssertNil(sent["to"])
    }

    func testEveryFilterReachesTheWireUnderTheServersOwnParameterName() {
        let query = ReceiptQuery(
            search: "  maple  ",
            status: .confirmed,
            category: "Office  supplies",
            paymentMethod: "Visa ending 3735",
            from: "2026-01-01",
            to: "2026-03-31",
            sort: .vendor,
            order: .asc
        )

        XCTAssertEqual(items(query), [
            "q": "maple", // trimmed
            "status": "confirmed",
            // Free text verbatim - the doubled space is the person's own
            // data, and the options endpoint offered it back exactly so.
            "category": "Office  supplies",
            "paymentMethod": "Visa ending 3735",
            "from": "2026-01-01",
            "to": "2026-03-31",
            "sort": "vendor",
            "order": "asc",
        ])
    }

    // MARK: - isFiltering (the toolbar badge)

    func testEveryNarrowingFilterRaisesTheBadgeAndOrderingDoesNot() {
        // The badge is how a person tells "I have no receipts in April"
        // from "I am hiding them". Anything that can remove a row has to
        // raise it; ordering, which removes none, must not.
        func filtering(_ mutate: (inout ReceiptQuery) -> Void) -> Bool {
            var query = ReceiptQuery.default
            mutate(&query)
            return query.isFiltering
        }
        XCTAssertTrue(filtering { $0.search = "maple" })
        XCTAssertTrue(filtering { $0.status = .pending })
        XCTAssertTrue(filtering { $0.category = "meals" })
        XCTAssertTrue(filtering { $0.paymentMethod = "Visa" })
        XCTAssertTrue(filtering { $0.from = "2026-01-01" })
        XCTAssertTrue(filtering { $0.to = "2026-03-31" })

        XCTAssertFalse(filtering { $0.search = "   " }) // blank is not a search
        XCTAssertFalse(filtering { $0.sort = .total })
        XCTAssertFalse(filtering { $0.order = .asc })
    }

    // MARK: - The range, read back

    func testTheRangeReadsBackOnTheControlThatOpensIt() {
        func label(from: String?, to: String?) -> String {
            var query = ReceiptQuery.default
            query.from = from
            query.to = to
            return query.dateRangeLabel(locale: locale)
        }
        XCTAssertEqual(label(from: nil, to: nil), "Any date")
        XCTAssertEqual(label(from: "2026-04-01", to: nil), "From Apr 1, 2026")
        XCTAssertEqual(label(from: nil, to: "2026-12-31"), "Until Dec 31, 2026")
        // Both years spelled out: a range is the filter most likely to be
        // wrong by a year, and this is where that would show.
        XCTAssertEqual(
            label(from: "2025-12-31", to: "2026-01-01"),
            "Dec 31, 2025 - Jan 1, 2026"
        )
    }

    /// A backwards range matches nothing, and the server answers it
    /// honestly with an empty page - which on screen is indistinguishable
    /// from "no receipts that month" unless something says otherwise.
    func testABackwardsRangeIsRecognisedRatherThanSilentlyEmpty() {
        var query = ReceiptQuery.default
        query.from = "2026-03-31"
        query.to = "2026-01-01"
        XCTAssertTrue(query.hasImpossibleDateRange)

        query.to = "2026-03-31" // a single day is a real range
        XCTAssertFalse(query.hasImpossibleDateRange)

        // One bound alone can never be backwards.
        XCTAssertFalse(ReceiptQuery(from: "2026-03-31").hasImpossibleDateRange)
        XCTAssertFalse(ReceiptQuery(to: "2026-01-01").hasImpossibleDateRange)
    }
}
