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
///
/// ⚠ **A withheld amount shows nothing, and the row is not consulted for it
/// (2026-10-31).** `value ?? row` is the right rule everywhere else and the
/// exact wrong one here: a pending row's amounts ARE the capture-time
/// heuristic snapshot the server just refused to serve, so "the suggestion
/// is absent, fall back to the row" put the impossible number straight back
/// on screen. Home read $8.50 and the swipe confirmed it - which is how a
/// $218.94 Costco receipt came to be stored at $8.50. The web's
/// `draftFromPending` carries the same rule.
extension Receipt {
    /// The served merge, only while it outranks the row.
    private var displayedSuggestions: MergedSuggestions? {
        status == .pending ? suggestions : nil
    }

    /// The amounts this row must not state. A field a person has reviewed
    /// is theirs, and the row holds what they wrote - the same order
    /// `ConfirmReceiptModel`'s `seed` applies the two rules.
    private var withheldAmounts: Set<ReviewedField> {
        guard let displayedSuggestions else { return [] }
        return Set(displayedSuggestions.withheldAmounts.map(ReviewedField.init))
            .subtracting(ReviewedField.set(fromWire: reviewedFields))
    }

    var displayVendor: String? {
        displayedSuggestions?.vendor.value ?? vendor
    }

    var displayPurchasedAt: String {
        displayedSuggestions?.purchasedAt.value ?? purchasedAt
    }

    var displayTotalCents: Int? {
        guard !withheldAmounts.contains(.totalCents) else { return nil }
        return displayedSuggestions?.totalCents.value ?? totalCents
    }

    var displayHstCents: Int? {
        displayedSuggestions?.hstCents.value ?? hstCents
    }

    var displaySubtotalCents: Int? {
        guard !withheldAmounts.contains(.subtotalCents) else { return nil }
        return displayedSuggestions?.subtotalCents.value ?? subtotalCents
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
    ///
    /// Never over a withheld amount (2026-10-31), the subtotal included
    /// even though the row does not render one: `QuickConfirmRequest`
    /// leaves out what it does not carry, so a swipe would keep the
    /// impossible number in the column and confirm it with nobody having
    /// seen it. Those receipts go through the form, which states why the
    /// box is blank - and the server refuses this confirm with 409
    /// `amounts_need_review` regardless.
    var canQuickConfirm: Bool {
        status == .pending && displayTotalCents != nil && withheldAmounts.isEmpty
    }
}
