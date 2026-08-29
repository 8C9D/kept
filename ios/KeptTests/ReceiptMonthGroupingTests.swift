import XCTest
@testable import Kept

/// `ReceiptMonthGrouping.sections(of:)` (proposal #9, 2026-08-28): a pure
/// rendering pass over what the server already ordered - these cases pin
/// the brief's own two requirements verbatim: "grouping must be a
/// rendering of what arrived, never a client-side re-sort," and "grouping
/// is stable across an appended page."
final class ReceiptMonthGroupingTests: XCTestCase {
    func testConsecutiveSameMonthReceiptsAreOneSection() {
        let receipts = [
            Fixtures.receipt(purchasedAt: "2026-08-28"),
            Fixtures.receipt(purchasedAt: "2026-08-14"),
            Fixtures.receipt(purchasedAt: "2026-08-01"),
        ]

        let sections = ReceiptMonthGrouping.sections(of: receipts, locale: Locale(identifier: "en_US"))

        XCTAssertEqual(sections.count, 1)
        XCTAssertEqual(sections.first?.heading, "August 2026")
        XCTAssertEqual(sections.first?.receipts, receipts)
    }

    func testAMonthBoundaryStartsANewSectionWithoutReorderingAnything() {
        let august = Fixtures.receipt(purchasedAt: "2026-08-01")
        let july = Fixtures.receipt(purchasedAt: "2026-07-31")

        let sections = ReceiptMonthGrouping.sections(of: [august, july], locale: Locale(identifier: "en_US"))

        XCTAssertEqual(sections.count, 2)
        XCTAssertEqual(sections[0].heading, "August 2026")
        XCTAssertEqual(sections[0].receipts, [august])
        XCTAssertEqual(sections[1].heading, "July 2026")
        XCTAssertEqual(sections[1].receipts, [july])
    }

    /// The brief's own named risk: grouping must never re-sort. A list
    /// sorted by something other than receipt date (vendor, total,
    /// capture date) can have the SAME month reappear non-adjacently -
    /// this must produce two separate sections, never one section that
    /// silently reordered rows to sit together.
    func testTheSameMonthReappearingNonAdjacentlyProducesTwoSeparateSectionsInTheOriginalOrder() {
        let firstAugust = Fixtures.receipt(purchasedAt: "2026-08-05")
        let september = Fixtures.receipt(purchasedAt: "2026-09-01")
        let secondAugust = Fixtures.receipt(purchasedAt: "2026-08-20")
        let receipts = [firstAugust, september, secondAugust]

        let sections = ReceiptMonthGrouping.sections(of: receipts, locale: Locale(identifier: "en_US"))

        XCTAssertEqual(sections.count, 3, "the second August run must not merge with the first")
        XCTAssertEqual(sections.map { $0.receipts }, [[firstAugust], [september], [secondAugust]])
        // The exact order the server sent, preserved end to end.
        XCTAssertEqual(sections.flatMap { $0.receipts }, receipts)
    }

    /// "Stable across an appended page": grouping is a pure function
    /// re-run on the whole array, so extending it with a next page must
    /// either extend the last section (when the new rows continue the
    /// same month) or add new sections after it - never touch the
    /// sections that were already there.
    func testGroupingIsStableAcrossAnAppendedPage() {
        let firstPage = [
            Fixtures.receipt(purchasedAt: "2026-08-28"),
            Fixtures.receipt(purchasedAt: "2026-08-01"),
        ]
        let before = ReceiptMonthGrouping.sections(of: firstPage, locale: Locale(identifier: "en_US"))
        XCTAssertEqual(before.count, 1)

        let appendedPage = firstPage + [
            Fixtures.receipt(purchasedAt: "2026-07-31"),
            Fixtures.receipt(purchasedAt: "2026-07-15"),
        ]
        let after = ReceiptMonthGrouping.sections(of: appendedPage, locale: Locale(identifier: "en_US"))

        XCTAssertEqual(after.count, 2)
        // The first section is untouched - same heading, same rows, same
        // order - the appended page only ever adds sections after it.
        XCTAssertEqual(after[0].heading, before[0].heading)
        XCTAssertEqual(after[0].receipts, before[0].receipts)
        XCTAssertEqual(after[1].heading, "July 2026")
        XCTAssertEqual(after[1].receipts.count, 2)
    }

    func testEmptyListProducesNoSections() {
        XCTAssertTrue(ReceiptMonthGrouping.sections(of: []).isEmpty)
    }

    /// A pending receipt's displayed date is the merge's suggestion, not
    /// the row's own `purchasedAt` (ReceiptDisplay.swift) - grouping must
    /// key off the exact same value the row renders, or a section header
    /// could name a different month than the receipt underneath it.
    func testGroupsByTheDisplayedDateNotTheRawRowForAPendingReceipt() {
        let pending = Fixtures.receipt(
            purchasedAt: "2026-01-01",
            status: .pending,
            suggestions: Fixtures.merged(purchasedAt: "2026-08-15")
        )

        let sections = ReceiptMonthGrouping.sections(of: [pending], locale: Locale(identifier: "en_US"))

        XCTAssertEqual(sections.first?.heading, "August 2026")
    }
}
