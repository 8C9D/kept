import SwiftUI

/// The confirm screen (spec §7.2, §10A.1) - the heart of the app. The
/// scanned image up top for checking numbers against paper, the total as
/// the loudest thing on screen, every OCR suggestion amber until touched,
/// and a save that stays disabled - with the reason stated - until the
/// business-or-personal choice is made.
///
/// This view renders and reports touches; every decision lives in
/// ConfirmReceiptModel, where it is tested without a camera.
struct ConfirmReceiptView: View {
    @ObservedObject var model: ConfirmReceiptModel
    let onSaved: () async -> Void
    let onSetAside: () async -> Void

    @FocusState private var focusedField: ConfirmReceiptModel.SuggestedField?
    @State private var showZoomedImage = false

    var body: some View {
        Form {
            imageSection
            totalSection
            detailFieldsSection
            businessPersonalSection
            optionalFieldsSection
            saveSection
        }
        .navigationTitle(counterTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Later") {
                    Task { await onSetAside() }
                }
            }
        }
        .onChange(of: focusedField) { _, newFocus in
            // Focusing a field is looking at it: the amber clears whether
            // or not the person then edits (spec §10A.1).
            if let newFocus {
                model.markTouched(newFocus)
            }
        }
        .sheet(isPresented: $showZoomedImage) {
            if let imageURL = model.imageURL {
                ZoomableImageSheet(url: imageURL)
            }
        }
    }

    private var counterTitle: String {
        model.unreviewedCount == 0
            ? "All checked"
            : "\(model.unreviewedCount) to check"
    }

    // MARK: - Image

    @ViewBuilder
    private var imageSection: some View {
        Section {
            if let imageURL = model.imageURL {
                ReceiptImageView(url: imageURL)
                    .frame(maxWidth: .infinity, minHeight: 160, maxHeight: 260)
                    .contentShape(Rectangle())
                    .onTapGesture { showZoomedImage = true }
                    .accessibilityLabel("Receipt image. Tap to zoom.")
            } else {
                Text("No image stored for this receipt.")
                    .font(.footnote)
                    .italic()
                    .foregroundStyle(.secondary)
            }
        }
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets())
    }

    // MARK: - Total (the card, §10A.1)

    private var totalSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Text("Total")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(model.currency)
                        .font(.title3)
                        .foregroundStyle(.secondary)
                    TextField("Not found", text: $model.totalText)
                        .keyboardType(.decimalPad)
                        .font(.largeTitle.bold())
                        .monospacedDigit()
                        .focused($focusedField, equals: .total)
                }
                if model.showsArithmeticWarning {
                    // Amber, not red, and inside the card: a prompt to
                    // look, not an error - plenty of legitimate receipts
                    // do not reconcile (spec §7.2, §10A.1).
                    Label(
                        "Subtotal, HST, and other tax don't add up to this total. Worth a look.",
                        systemImage: "exclamationmark.triangle"
                    )
                    .font(.footnote)
                    .foregroundStyle(.orange)
                }
            }
            .padding(.vertical, 6)
            .listRowBackground(suggestionBackground(for: .total))
        }
    }

    // MARK: - Suggested fields, in the §7.2 order after the total

    private var detailFieldsSection: some View {
        Section {
            // Date: always prefilled (parsed or capture-day fallback), so
            // it participates in the amber marking. DatePicker taps don't
            // move focus, so the row clears its tint on any interaction.
            // The picker is pinned to the same UTC frame as the parse and
            // format around it - unpinned, it shows the previous day west
            // of Greenwich and saves the next day when "corrected".
            VStack(alignment: .leading, spacing: 4) {
                DatePicker("Date", selection: $model.purchasedDate, displayedComponents: .date)
                    .environment(\.calendar, ReceiptFormat.utcCalendar)
                    .environment(\.timeZone, ReceiptFormat.utcTimeZone)
                if model.dateIsCaptureDayFallback {
                    // The one suggestion that can be fabricated: no date
                    // parsed, so this is the capture day, said out loud
                    // rather than passed off as something read from paper.
                    Text("No date was found on the receipt - this is the day it was scanned.")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }
            }
            .listRowBackground(suggestionBackground(for: .date))
            .simultaneousGesture(TapGesture().onEnded {
                model.markTouched(.date)
            })
            .onChange(of: model.purchasedDate) { _, _ in
                model.markTouched(.date)
            }

            SuggestedFieldRow(
                label: "Vendor",
                text: $model.vendorText,
                field: .vendor,
                focus: $focusedField,
                isUnreviewed: model.isUnreviewed(.vendor)
            )
            SuggestedFieldRow(
                label: "HST",
                text: $model.hstText,
                field: .hst,
                focus: $focusedField,
                isUnreviewed: model.isUnreviewed(.hst),
                moneyInput: model.hstInput
            )
            SuggestedFieldRow(
                label: "Subtotal",
                text: $model.subtotalText,
                field: .subtotal,
                focus: $focusedField,
                isUnreviewed: model.isUnreviewed(.subtotal),
                moneyInput: model.subtotalInput
            )
            SuggestedFieldRow(
                label: "Other tax",
                text: $model.otherTaxText,
                field: nil,
                focus: $focusedField,
                isUnreviewed: false,
                moneyInput: model.otherTaxInput
            )
            SuggestedFieldRow(
                label: "Tax number",
                text: $model.taxNumberText,
                field: .taxNumber,
                focus: $focusedField,
                isUnreviewed: model.isUnreviewed(.taxNumber)
            )
        }
    }

    // MARK: - Business / personal (§10A.1: required, never pre-selected)

    private var businessPersonalSection: some View {
        Section {
            BusinessPersonalPicker(
                choice: model.businessChoice,
                choose: { model.chooseBusiness($0) }
            )
        } header: {
            Text("Business or personal?")
        }
    }

    // MARK: - Free-text fields

    private var optionalFieldsSection: some View {
        Section {
            LabeledContent("Category") {
                TextField("None", text: $model.categoryText)
                    .multilineTextAlignment(.trailing)
            }
            LabeledContent("Payment") {
                TextField("None", text: $model.paymentMethodText)
                    .multilineTextAlignment(.trailing)
            }
            TextField("Notes", text: $model.notesText, axis: .vertical)
                .lineLimit(2...5)
        }
    }

    // MARK: - Save

    private var saveSection: some View {
        Section {
            Button {
                Task {
                    if await model.save() {
                        await onSaved()
                    }
                }
            } label: {
                if model.isSaving {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                } else {
                    Text("Save")
                        .font(.headline)
                        .frame(maxWidth: .infinity)
                }
            }
            .buttonStyle(.borderedProminent)
            .disabled(!model.canSave || model.isSaving)

            if let reason = model.saveBlocker {
                // The §10A.1 rule: a disabled save states its reason below
                // the button rather than leaving it to be inferred.
                Text(reason)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
            }
            if let saveError = model.saveError {
                Text(saveError)
                    .font(.footnote)
                    .foregroundStyle(.red)
                    .frame(maxWidth: .infinity)
            }
        }
        .listRowBackground(Color.clear)
        .listRowSeparator(.hidden)
    }

    // MARK: - Amber

    private func suggestionBackground(for field: ConfirmReceiptModel.SuggestedField) -> Color? {
        model.isUnreviewed(field) ? Color.suggestionAmber : nil
    }
}

extension Color {
    /// The one amber used for every "unreviewed suggestion" marking - the
    /// same hue family as the pending badge, because both mean "a human
    /// has not looked yet".
    static let suggestionAmber = Color.orange.opacity(0.16)
}
