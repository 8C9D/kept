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
/// parsed by an earlier build still uploads after the update.
struct ReceiptSuggestions: Codable, Equatable {
    /// Integer cents, like every money value in the system. Never a float.
    var totalCents: Int?
    var hstCents: Int?
    var subtotalCents: Int?

    /// The purchase date as yyyy-mm-dd - a calendar date, same as the API.
    var purchasedAt: String?

    var vendor: String?

    /// True when no heuristic found anything - the confirm screen for this
    /// receipt starts from a blank form rather than suggestions.
    var isEmpty: Bool {
        totalCents == nil && hstCents == nil && subtotalCents == nil
            && purchasedAt == nil && vendor == nil
    }
}
