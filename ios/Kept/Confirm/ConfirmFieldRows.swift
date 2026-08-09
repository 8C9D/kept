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
    /// Every row is focusable, including ones carrying no suggestion
    /// (other tax): focus is what the keyboard toolbar and the tint both
    /// read, and a money field with no focus value is a decimal pad the
    /// Done button cannot close. Whether the tint moves is decided by the
    /// field's `suggestion`, not by whether it can take focus.
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

/// The §7.2 required choice: two buttons, prominent, never pre-selected.
/// The chosen one fills in; until then both sit outlined and save stays
/// disabled with its reason (wired in ConfirmReceiptView).
struct BusinessPersonalPicker: View {
    let choice: Bool?
    let choose: (Bool) -> Void

    var body: some View {
        HStack(spacing: 12) {
            choiceButton(title: "Business", value: true)
            choiceButton(title: "Personal", value: false)
        }
        .listRowBackground(Color.clear)
        // Default row insets, deliberately: with zero insets the buttons
        // ran to the row's clip bounds and the outer rounded strokes were
        // cut flat at both edges (wave-4 device run, the owner's finding 4).
        // Inside the insets, nothing is clipped.
    }

    @ViewBuilder
    private func choiceButton(title: String, value: Bool) -> some View {
        let isChosen = choice == value
        Button {
            choose(value)
        } label: {
            Text(title)
                .font(.headline)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
        }
        .buttonStyle(ChoiceButtonStyle(isChosen: isChosen))
        .accessibilityAddTraits(isChosen ? .isSelected : [])
    }

    private struct ChoiceButtonStyle: ButtonStyle {
        let isChosen: Bool

        func makeBody(configuration: Configuration) -> some View {
            configuration.label
                .foregroundStyle(isChosen ? Color.white : Color.accentColor)
                .background(
                    RoundedRectangle(cornerRadius: 10)
                        .fill(isChosen ? Color.accentColor : Color.clear)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 10)
                        .strokeBorder(Color.accentColor, lineWidth: 1.5)
                )
                .opacity(configuration.isPressed ? 0.7 : 1)
        }
    }
}
