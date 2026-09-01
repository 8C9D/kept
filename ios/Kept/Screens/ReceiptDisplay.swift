import Foundation

/// What a read-only screen shows for the merge-covered fields (§7.1,
/// §7.3): on a pending receipt the served suggestion outranks the row's
/// copy - the row's values are the capture-time heuristic snapshot, and
/// the confirm screen already prefills by that rule - with the row
/// filling only fields no suggestion covers. Rendering the row instead
/// would show one receipt two different ways depending on the screen,
/// with the merge's corrections invisible outside the confirm form.
///
/// A confirmed receipt renders its row, which holds the human's values.
/// The merge never overrides a confirmed value: confirmed receipts are
/// swept and served suggestions too, but only the accuracy measurement
/// consumes those.
extension Receipt {
    /// The served merge, only while it outranks the row.
    private var displayedSuggestions: MergedSuggestions? {
        status == .pending ? suggestions : nil
    }

    var displayVendor: String? {
        displayedSuggestions?.vendor.value ?? vendor
    }

    var displayPurchasedAt: String {
        displayedSuggestions?.purchasedAt.value ?? purchasedAt
    }

    var displayTotalCents: Int? {
        displayedSuggestions?.totalCents.value ?? totalCents
    }

    var displayHstCents: Int? {
        displayedSuggestions?.hstCents.value ?? hstCents
    }

    var displaySubtotalCents: Int? {
        displayedSuggestions?.subtotalCents.value ?? subtotalCents
    }

    var displayTipCents: Int? {
        displayedSuggestions?.tipCents.value ?? tipCents
    }

    // No displayOtherFeesCents: no read-only screen renders other fees, so
    // there is nothing for a merge to outrank there. (The merge gained an
    // `otherFeesCents` entry 2026-09-01 - the confirm FORM reads it, via
    // ConfirmSuggestionSet, which is a different question from what a row
    // displays.)

    /// Whether this row can be confirmed by the Home list's swipe without
    /// failing (proposal #9, widened 2026-09-01).
    ///
    /// It gated on the RAW `totalCents` until 2026-09-01, because the
    /// server's confirm check reads the stored column and the swipe used to
    /// send `status` alone - so a row showing a total the merge had found,
    /// over a still-empty column, offered a swipe that then 400'd. The
    /// swipe now sends the DISPLAYED total in the same PATCH
    /// (`QuickConfirmRequest`), which satisfies that check by writing the
    /// value it checks for, so the gate is what the person can see. Strictly
    /// wider than the old one: a present raw total is always a present
    /// displayed total.
    var canQuickConfirm: Bool {
        status == .pending && displayTotalCents != nil
    }
}
