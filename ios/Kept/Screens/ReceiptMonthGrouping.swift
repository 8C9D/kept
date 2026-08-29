import Foundation

/// Sticky month section headers for the Home list (proposal #9,
/// docs/proposals/2026-08-28-ux-enhancements.md #9, approved 2026-08-28).
/// A pure rendering pass over rows the server already ordered and paged -
/// NEVER a re-sort. Spec §4.1 (no domain logic client-side) applies here in
/// its rendering form: `ReceiptListModel`'s keyset cursor encodes the
/// server's own ordering, and a client-side re-sort would silently
/// disagree with it the moment a second page arrives, or would mint a
/// section grouping the next page's cursor cannot honour. This module only
/// chunks CONSECUTIVE rows that already share a purchase month into their
/// own section; it never regroups rows that are not already adjacent in
/// the server's answer, and it is a pure function of `[Receipt]` with no
/// stored state of its own - called fresh on every render, which is what
/// makes it correct across an appended page for free: the same run of
/// consecutive same-month rows produces the same section boundary whether
/// it is the first 20 rows or the first 200.
///
/// Keyed on `displayPurchasedAt` (ReceiptDisplay.swift) - the exact string
/// `ReceiptRow` already renders as its date - so a section header can
/// never name a month that disagrees with the dates inside it.
///
/// When the list is NOT sorted by receipt date (`ReceiptQuery.Sort
/// .capturedAt`, `.total`, `.vendor`), the same month can legitimately
/// reappear as a later, separate section further down the list - that is
/// what "a rendering of what arrived" means for an order this module does
/// not control, not a bug to paper over by grouping non-adjacent rows
/// together (which would itself be the re-sort this module must not do).
enum ReceiptMonthGrouping {
    /// One contiguous run of receipts sharing a purchase month.
    struct Section: Identifiable, Equatable {
        /// Unique per RUN, not per month - two runs of the same month (a
        /// non-chronological sort, or the same month recurring across
        /// years) must not collide as SwiftUI List identities. Positional,
        /// not content-derived, on purpose: it only has to be stable
        /// within one render pass, which a fresh index always is.
        let id: String
        /// "yyyy-mm" - used only to detect where one run ends and the next
        /// begins; the view renders `heading`, never this.
        let monthKey: String
        let heading: String
        var receipts: [Receipt]
    }

    static func sections(of receipts: [Receipt], locale: Locale = .autoupdatingCurrent) -> [Section] {
        var sections: [Section] = []
        for receipt in receipts {
            let key = monthKey(for: receipt)
            if sections.last?.monthKey == key {
                sections[sections.count - 1].receipts.append(receipt)
            } else {
                let heading = ReceiptFormat.monthHeading(receipt.displayPurchasedAt, locale: locale)
                sections.append(Section(id: "\(key)#\(sections.count)", monthKey: key, heading: heading, receipts: [receipt]))
            }
        }
        return sections
    }

    /// "yyyy-mm" sliced straight off the ISO date string - no `Date` or
    /// `Calendar` involved, matching `FiscalPresets.swift`'s identical
    /// choice for the identical reason: this is a zoneless calendar date,
    /// and a string prefix cannot disagree with itself the way a
    /// timezone-sensitive parse could.
    private static func monthKey(for receipt: Receipt) -> String {
        String(receipt.displayPurchasedAt.prefix(7))
    }
}
