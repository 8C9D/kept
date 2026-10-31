import Foundation

/// Money as the confirm screen's text fields hold it: a plain editable
/// string, parsed to integer cents with string arithmetic - the same
/// no-floats rule as everywhere else money moves.
enum MoneyInput: Equatable {
    /// The field is blank: the value is absent, which is a legal state for
    /// every money field except the total at save time.
    case empty
    case cents(Int)
    /// Text that is not money ("12.345", "abc"); saving is blocked with
    /// the field named rather than guessing.
    case invalid
    /// Reads as money, but as more than the server can store (2026-10-31):
    /// past `ReceiptArithmetic.isStorable`, the int4 bound every money
    /// column and `centsSchema` share. Its own case rather than `.invalid`
    /// for two reasons. "99999999.00" IS a well-formed amount, so "isn't a
    /// valid amount" would be a false statement about it. And it must
    /// never reach arithmetic as a value: two 17-digit boxes overflow the
    /// form's own sums, which traps and takes the confirm screen down.
    case outOfRange

    /// Text that cannot be saved as it stands, whichever way it fails -
    /// the one question every rule that suppresses itself over an unusable
    /// box asks, so none of them can forget the newer of the two cases.
    var isUnusable: Bool {
        self == .invalid || self == .outOfRange
    }

    /// Accepts what a person types for an amount: optional minus (refunds
    /// are receipts too), optional dollar sign, thousands commas, up to
    /// two decimals ("45", "45.2", "$1,234.56", "-45.20" - which is also
    /// what text(fromCents:) produces for a negative, so a refund prefill
    /// round-trips instead of blocking its own confirmation).
    /// nonisolated(unsafe): Regex is not (yet) Sendable, but the pattern is
    /// immutable and matching does not mutate it.
    private nonisolated(unsafe) static let pattern = #/^(-)?\$?\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/#

    /// A comma as the decimal separator (2026-10-31): "12,50", which is how
    /// French Canadian writes money, and which can reach this box from a
    /// paste, a hardware keyboard, or a pad that offers a comma. (Whether
    /// `.decimalPad` itself does is unconfirmed: on the iOS 26.3 simulator
    /// it showed a point under a fr-CA region and a French keyboard alike,
    /// so check a device before relying on this being the only way in.)
    ///
    /// Consulted only after `pattern` has failed, which is what keeps it
    /// unambiguous: a comma followed by exactly three digits has already
    /// been read as thousands ("1,234" is $1,234.00, "$1,234.56" is what
    /// it always was), so this can only ever see the one or two digits a
    /// comma cannot mean thousands in front of. Exactly one comma and no
    /// point: "1.234,50" and "1,234,56" name two different separators or
    /// none, and they stay `.invalid` rather than being guessed at.
    private nonisolated(unsafe) static let decimalCommaPattern = #/^(-)?\$?\s*(\d+),(\d{1,2})$/#

    static func parse(_ text: String) -> MoneyInput {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty {
            return .empty
        }
        if let match = trimmed.wholeMatch(of: pattern) {
            return amount(
                negative: match.1 != nil,
                dollars: String(match.2),
                fraction: match.3.map(String.init)
            )
        }
        if let match = trimmed.wholeMatch(of: decimalCommaPattern) {
            return amount(
                negative: match.1 != nil,
                dollars: String(match.2),
                fraction: String(match.3)
            )
        }
        return .invalid
    }

    /// Digits to cents, by string and integer arithmetic alone. Every way
    /// the number can be too big lands on one answer, `.outOfRange`, so
    /// the form states one reason whether it was typed with nine digits or
    /// with nineteen.
    private static func amount(negative: Bool, dollars: String, fraction: String?) -> MoneyInput {
        guard let whole = Int(dollars.replacingOccurrences(of: ",", with: "")) else {
            // Digits too large for Int; refuse rather than overflow.
            return .outOfRange
        }
        // "45.2" means 45.20: pad the fraction, never multiply a float.
        let padded = (fraction ?? "").padding(toLength: 2, withPad: "0", startingAt: 0)
        guard let centsPart = Int(padded) else {
            return .invalid
        }
        // Checked arithmetic: nineteen typed digits fit in Int but
        // overflow the scale-up, and a trap here crashes the confirm
        // screen (wave-4 reviewer pass).
        let (scaled, multiplyOverflowed) = whole.multipliedReportingOverflow(by: 100)
        guard !multiplyOverflowed else { return .outOfRange }
        let (magnitude, addOverflowed) = scaled.addingReportingOverflow(centsPart)
        guard !addOverflowed else { return .outOfRange }
        let value = negative ? -magnitude : magnitude
        return ReceiptArithmetic.isStorable(cents: value) ? .cents(value) : .outOfRange
    }

    /// The keyboard bar's sign toggle (2026-10-31): `.decimalPad` has no
    /// minus key, so without this a refund's "-45.20" - which the parser
    /// above has always accepted - could only ever be prefilled, never
    /// typed. Works on text rather than on cents because the box may be
    /// blank or mid-keystroke: a person who knows it is a refund taps this
    /// first and types the digits after it, and "-" alone is no number.
    static func togglingSign(of text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        return trimmed.hasPrefix("-") ? String(trimmed.dropFirst()) : "-" + trimmed
    }

    /// Cents back to editable text: plain "45.20", no symbol or grouping,
    /// because this fills a text field, not a label.
    static func text(fromCents cents: Int) -> String {
        let sign = cents < 0 ? "-" : ""
        let magnitude = abs(cents)
        return "\(sign)\(magnitude / 100).\(String(format: "%02d", magnitude % 100))"
    }
}
