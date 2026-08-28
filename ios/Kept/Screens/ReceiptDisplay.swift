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

    // No displayOtherFeesCents: other fees carries no suggestion (§6), so
    // there is nothing for a merge to outrank - every read-only rendering
    // reads `otherFeesCents` directly, the same as category or notes.
}
