import SwiftUI

/// One editable row for every confirmable field, so amber behaviour can
/// never diverge between fields: tinted while unreviewed, cleared by
/// focus (wired in ConfirmReceiptView), absent values stated as "Not
/// found" placeholder text rather than a bare blank (spec §10A.1).
///
/// Money fields are the same row with a numeric keyboard and an inline
/// "not a valid amount" nudge - previously a second, nearly identical
/// struct, merged on the wave-4 reviewer's duplication finding.
struct SuggestedFieldRow: View {
    let label: String
    @Binding var text: String
    /// Every row is focusable, including ones carrying no suggestion:
    /// focus is what the keyboard toolbar and the tint both read, and a
    /// money field with no focus value is a decimal pad the Done button
    /// cannot close. Whether the tint moves is decided by the field's
    /// `suggestion`, not by whether it can take focus.
    let field: ConfirmReceiptModel.EditableField
    var focus: FocusState<ConfirmReceiptModel.EditableField?>.Binding
    let isUnreviewed: Bool
    /// Set for money fields; drives the keyboard, the digit styling, and
    /// the inline invalid-amount nudge.
    var moneyInput: MoneyInput?

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
            }
        }
        .listRowBackground(isUnreviewed ? Color.suggestionAmber : nil)
    }
}

/// Category and Payment: free text, plus a menu of the values this person
/// has already used (GET /api/receipts/options, 2026-08-26 field
/// reduction). Picking one fills the field, which stays editable - these
/// are suggestions from the user's own data, never a vocabulary to choose
/// from, and `category` is still free text with no enum behind it.
///
/// With no past values - a new account, or an options fetch that has not
/// landed or failed - the menu is absent and the row is the plain
/// free-text field it has always been. Nothing here waits on the network.
struct ReusableValueFieldRow: View {
    let label: String
    @Binding var text: String
    let field: ConfirmReceiptModel.EditableField
    var focus: FocusState<ConfirmReceiptModel.EditableField?>.Binding
    /// Distinct, most-recently-used first, as the options route serves it.
    let pastValues: [String]

    var body: some View {
        LabeledContent(label) {
            HStack(spacing: 8) {
                TextField("None", text: $text)
                    .multilineTextAlignment(.trailing)
                    .focused(focus, equals: field)
                    .accessibilityIdentifier("field.\(label)")
                if !pastValues.isEmpty {
                    Menu {
                        ForEach(pastValues, id: \.self) { value in
                            Button(value) { text = value }
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
