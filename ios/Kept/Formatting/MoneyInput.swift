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

    /// Accepts what a person types for an amount: optional minus (refunds
    /// are receipts too), optional dollar sign, thousands commas, up to
    /// two decimals ("45", "45.2", "$1,234.56", "-45.20" - which is also
    /// what text(fromCents:) produces for a negative, so a refund prefill
    /// round-trips instead of blocking its own confirmation).
    private static let pattern = #/^(-)?\$?\s*(\d{1,3}(?:,\d{3})*|\d+)(?:\.(\d{1,2}))?$/#

    static func parse(_ text: String) -> MoneyInput {
        let trimmed = text.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty {
            return .empty
        }
        guard let match = trimmed.wholeMatch(of: pattern) else {
            return .invalid
        }
        guard let dollars = Int(String(match.2).replacingOccurrences(of: ",", with: "")) else {
            // Digits too large for Int; refuse rather than overflow.
            return .invalid
        }
        // "45.2" means 45.20: pad the fraction, never multiply a float.
        let fraction = (match.3.map(String.init) ?? "").padding(toLength: 2, withPad: "0", startingAt: 0)
        guard let centsPart = Int(fraction) else {
            return .invalid
        }
        // Checked arithmetic: nineteen typed digits fit in Int but
        // overflow the scale-up, and a trap here crashes the confirm
        // screen (wave-4 reviewer pass).
        let (scaled, multiplyOverflowed) = dollars.multipliedReportingOverflow(by: 100)
        guard !multiplyOverflowed else { return .invalid }
        let (magnitude, addOverflowed) = scaled.addingReportingOverflow(centsPart)
        guard !addOverflowed else { return .invalid }
        return .cents(match.1 == nil ? magnitude : -magnitude)
    }

    /// Cents back to editable text: plain "45.20", no symbol or grouping,
    /// because this fills a text field, not a label.
    static func text(fromCents cents: Int) -> String {
        let sign = cents < 0 ? "-" : ""
        let magnitude = abs(cents)
        return "\(sign)\(magnitude / 100).\(String(format: "%02d", magnitude % 100))"
    }
}
