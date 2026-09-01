import Foundation

/// What the parser believes it read off a receipt. Every field is optional
/// because every heuristic can honestly come up empty - a nil here becomes
/// a stated absence on the confirm screen, never a fabricated value.
///
/// This is deliberately a plain struct (spec §7.3): a future server-side
/// parser can produce the same shape to augment or override these
/// suggestions, including re-parsing old receipts from their stored raw
/// text, without the confirm screen changing at all.
/// Codable because the wave-5 outbox persists the parse result with each
/// queued receipt. Removing a field is decode-safe for items already on
/// disk: JSONDecoder ignores keys no property declares, so a receipt
/// parsed by an earlier build still uploads after the update. Adding one
/// (`tipCents`, 2026-08-28) is decode-safe the other direction: every
/// property here is Optional, and the synthesized decoder treats an
/// Optional property's missing key as nil, so an item a pre-tip build
/// already wrote to disk decodes with tipCents absent rather than failing.
struct ReceiptSuggestions: Codable, Equatable {
    /// Integer cents, like every money value in the system. Never a float.
    var totalCents: Int?
    var hstCents: Int?
    var subtotalCents: Int?
    /// Gratuity, from a TIP- or GRATUITY-labelled row (2026-08-28 product
    /// feedback).
    var tipCents: Int?

    /// Delivery, service charges, surcharges, rounding, eco fees and
    /// deposits, summed (2026-09-01).
    ///
    /// The spec said this field deliberately had no suggestion - "other
    /// fees is a residual with no consistent printed label for a heuristic
    /// to match" - and that was written before the second user's receipts were read.
    /// Across the 130 live receipts in the 2026-09-01 restore the labels
    /// are consistent and few: `12% Service charge`, `Credit card 2.4%
    /// surcharge`, `Rounding`, `Delivery`, `Eco fee`, a bottle deposit. A
    /// residual with no label was the right description of the FIELD, not
    /// of what real paper prints into it. Still exactly as replaceable as
    /// every other value here: a suggestion a human reads before anything
    /// saves (constraint 2).
    var otherFeesCents: Int?

    /// The card or cash label the slip prints (2026-09-01) - `MASTERCARD`,
    /// `VISA`, `INTERAC`, `DEBIT`, `AMEX`, `CASH`, `APPLE PAY`. Printed on
    /// roughly four receipts in five and stored on none of the 130 live
    /// ones, because nothing ever offered it. Free text, like `category`:
    /// this suggests the person's own vocabulary back, it does not impose
    /// one (engineering rule: no enum, no taxonomy).
    var paymentMethod: String?

    /// The purchase date as yyyy-mm-dd - a calendar date, same as the API.
    var purchasedAt: String?

    var vendor: String?

    /// True when no heuristic found anything - the confirm screen for this
    /// receipt starts from a blank form rather than suggestions.
    var isEmpty: Bool {
        totalCents == nil && hstCents == nil && subtotalCents == nil && tipCents == nil
            && otherFeesCents == nil && paymentMethod == nil
            && purchasedAt == nil && vendor == nil
    }
}
