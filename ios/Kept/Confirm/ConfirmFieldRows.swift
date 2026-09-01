import SwiftUI

/// The §7.2/§10A.1 disagreement note: two independent parsers read the
/// same text differently, on a field where that is free signal (date:
/// decides the fiscal year; HST: the input tax credit, added 2026-08-28).
/// One implementation so the treatment - inside the field, never red, a
/// prompt to look rather than a rule - cannot drift between the fields
/// that raise it. Originally written inline for the date row only;
/// factored out here when HST gained the same flag rather than duplicating
/// the Label.
///
/// Secondary, not orange (2026-09-01): the whole screen used to shout in
/// amber, and a note that shouts alongside a row that no longer does is
/// the loudest thing left rather than the quiet aside it is meant to be.
/// The triangle still carries the "look at this" job; the colour was only
/// ever repeating what the icon already says.
struct DisagreementNote: View {
    let message: String

    var body: some View {
        Label(message, systemImage: "exclamationmark.triangle")
            .font(.footnote)
            .foregroundStyle(.secondary)
    }
}

/// One editable row for every confirmable field, so the treatment can
/// never diverge between fields: absent values stated as "Not found"
/// placeholder text rather than a bare blank (spec §10A.1).
///
/// Money fields are the same row with a numeric keyboard and an inline
/// "not a valid amount" nudge - previously a second, nearly identical
/// struct, merged on the wave-4 reviewer's duplication finding.
///
/// The amber row tint this used to carry is gone (2026-09-01, the owner's
/// own use): on a form where nearly every row is prefilled, "unreviewed"
/// was most of the screen, and a page that is mostly highlighted
/// highlights nothing. §10A.1's rule that a suggestion is never saved
/// without a human confirming it is unchanged and still enforced where it
/// actually lives - the Save button, which is the confirmation. The
/// model's `unreviewedFields` bookkeeping is untouched: the date and HST
/// notes, the rate hint and the save-time accept/override telemetry all
/// still key off it.
struct SuggestedFieldRow: View {
    let label: String
    @Binding var text: String
    /// Every row is focusable, including ones carrying no suggestion:
    /// focus is what the keyboard bar reads, and a money field with no
    /// focus value is a decimal pad the Done button cannot close.
    let field: ConfirmReceiptModel.EditableField
    var focus: FocusState<ConfirmReceiptModel.EditableField?>.Binding
    /// Set for money fields; drives the keyboard, the digit styling, and
    /// the inline invalid-amount nudge.
    var moneyInput: MoneyInput?
    /// The disagreement note's text, or nil to show none (§7.3). Only HST
    /// passes this today; every other SuggestedFieldRow caller leaves it
    /// nil and gets no note, same as before this field existed.
    var disagreementNote: String?
    /// The HST rate-plausibility hint's text (proposal #7, 2026-08-28), or
    /// nil to show none. A separate slot from `disagreementNote` rather
    /// than folded into it: the two signals are independent (two parsers
    /// disagreeing vs. one value's own ratio looking like a split) and can
    /// both be true of the same receipt at once, so both must be able to
    /// render together rather than one silently winning. Only HST passes
    /// this; every other caller leaves it nil.
    var rateHintNote: String?

    var body: some View {
        LabeledContent(label) {
            VStack(alignment: .trailing, spacing: 2) {
                TextField("Not found", text: $text)
                    .multilineTextAlignment(.trailing)
                    .autocorrectionDisabled()
                    .keyboardType(field.usesDecimalPad ? .decimalPad : .default)
                    .monospacedDigit()
                    .focused(focus, equals: field)
                    .accessibilityIdentifier("field.\(label)")
                if moneyInput == .invalid {
                    Text("Not a valid amount")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }
                if let disagreementNote {
                    DisagreementNote(message: disagreementNote)
                }
                if let rateHintNote {
                    DisagreementNote(message: rateHintNote)
                }
            }
        }
    }
}

/// Category, payment method and vendor: free text, plus a menu of the
/// values this person has already used (GET /api/receipts/options,
/// 2026-08-26 field reduction; vendor joined 2026-08-28). Picking one
/// fills the field, which stays editable - these are suggestions from the
/// user's own data, never a vocabulary to choose from, and `category` is
/// still free text with no enum behind it.
///
/// With no past values - a new account, or an options fetch that has not
/// landed or failed - the menu is absent and the row is the plain
/// free-text field it has always been. Nothing here waits on the network.
///
/// Vendor is the one caller that also passes a "Not found" placeholder:
/// unlike category and payment method, vendor carries an OCR/LLM
/// suggestion (§7.3), so an empty vendor field is a parser that found
/// nothing rather than a field nobody has filled in yet.
struct ReusableValueFieldRow: View {
    let label: String
    @Binding var text: String
    let field: ConfirmReceiptModel.EditableField
    var focus: FocusState<ConfirmReceiptModel.EditableField?>.Binding
    /// Distinct, most-recently-used first, as the options route serves it.
    let pastValues: [String]
    /// "Not found" states an absence for a field that also carries a
    /// suggestion (vendor); "None" is the right wording for category and
    /// payment method, which are never suggested and so have nothing to
    /// be "found" in the first place.
    var placeholder: String = "None"
    /// Called when a past value is picked from the menu - `option_reused`
    /// (behavioural telemetry, 2026-08-28). Nil by default so a caller
    /// that has no EventLogger in hand (there is none today, but the row
    /// itself should not require one) simply logs nothing.
    var onReuse: (() -> Void)? = nil

    var body: some View {
        LabeledContent(label) {
            HStack(spacing: 8) {
                // Leading, not trailing (2026-09-01). A trailing-aligned
                // SwiftUI TextField does not render a space that is
                // currently the last character: typing "Food Basics"
                // showed "Food" until the "B" arrived, so the space read
                // as a keystroke the app had dropped. The character was
                // always in the string - `value` read back "Food " and two
                // screenshots taken either side of the space were
                // byte-identical - which is what makes it a layout bug and
                // not an input one. The money rows keep their trailing
                // alignment: digits line up on the decimal point there,
                // and no amount ends in a space.
                TextField(placeholder, text: $text)
                    .multilineTextAlignment(.leading)
                    .focused(focus, equals: field)
                    .accessibilityIdentifier("field.\(label)")
                if !pastValues.isEmpty {
                    Menu {
                        ForEach(pastValues, id: \.self) { value in
                            Button(value) {
                                text = value
                                onReuse?()
                            }
                        }
                    } label: {
                        Image(systemName: "chevron.down.circle")
                            .imageScale(.large)
                    }
                    .accessibilityLabel("\(label) you have used before")
                    .accessibilityIdentifier("options.\(label)")
                }
            }
        }
    }
}
