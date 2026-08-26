import SwiftUI

/// The confirm screen (spec §7.2, §10A.1) - the heart of the app. The
/// scanned image up top for checking numbers against paper, the total as
/// the loudest thing on screen, every OCR suggestion amber until touched,
/// and a save that stays disabled - with the reason stated - until there
/// is a valid total.
///
/// The same screen edits an already-confirmed receipt (`purpose == .edit`)
/// with nothing amber on it: the values are the person's own.
///
/// This view renders and reports touches; every decision lives in
/// ConfirmReceiptModel, where it is tested without a camera.
struct ConfirmReceiptView: View {
    @ObservedObject var model: ConfirmReceiptModel
    /// The person's own past categories and payment methods, offered back
    /// on those two rows. Empty until the fetch lands - or forever, if it
    /// fails or nothing has been used yet - and the form is complete
    /// either way (never blocks on the network).
    @ObservedObject var options: ReceiptOptionsStore
    let onSaved: () async -> Void
    let onSetAside: () async -> Void

    @FocusState private var focusedField: ConfirmReceiptModel.EditableField?
    @State private var showZoomedImage = false

    var body: some View {
        Form {
            imageSection
            totalSection
            detailFieldsSection
            optionalFieldsSection
            saveSection
        }
        // Any scroll puts the keyboard away (§10A.1's dismissal rule), so
        // the Save button is never left under it: reaching Save is a
        // scroll, and the scroll itself is what uncovers it. `.immediately`
        // rather than `.interactively` because the interactive variant only
        // pays out if the drag starts over the keyboard - another gesture
        // to know about, which is the defect being fixed.
        .scrollDismissesKeyboard(.immediately)
        // Both the Done button and tap-to-dismiss. The Done button was a
        // `ToolbarItemGroup(placement: .keyboard)` here until the device
        // proved it installs nothing through this screen's presentation.
        .background(ProvidesKeyboardExits())
        .navigationTitle(model.screenTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(model.dismissLabel) {
                    Task { await onSetAside() }
                }
            }
        }
        .task {
            // Only for a server-backed form. A capture-time confirm is
            // deliberately an offline screen - OCR ran on the device and
            // Save is a disk write - so it offers whatever the last fetch
            // cached and asks for nothing.
            guard model.receiptId != nil else { return }
            await options.refresh()
        }
        .onChange(of: focusedField) { _, newFocus in
            // Focusing a field is looking at it: the amber clears whether
            // or not the person then edits (spec §10A.1).
            if let suggestion = newFocus?.suggestion {
                model.markTouched(suggestion)
            }
        }
        .sheet(isPresented: $showZoomedImage) {
            if let imageSource = model.imageSource {
                ZoomableImageSheet(source: imageSource)
            }
        }
    }

    // MARK: - Image

    @ViewBuilder
    private var imageSection: some View {
        Section {
            if let imageSource = model.imageSource {
                ReceiptImageView(source: imageSource)
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
            if let note = model.ocrFailureNote {
                // Recognition failed at capture: without this line, an
                // empty form would read as "the receipt is blank" - the
                // remedy (type what the paper says) is already on screen.
                Text(note)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
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
                        .accessibilityIdentifier("field.Total")
                }
                if model.showsArithmeticWarning {
                    // Amber, not red, and inside the card: a prompt to
                    // look, not an error - plenty of legitimate receipts
                    // do not reconcile (spec §7.2, §10A.1).
                    Label(
                        "Subtotal and HST don't add up to this total. Worth a look.",
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
                if model.showsDateDisagreementNote {
                    // The two parsers read different dates off the same
                    // text (§7.3) - free signal on the field that decides
                    // the fiscal year. Same treatment as the arithmetic
                    // warning: amber, inside the field, never red - a
                    // prompt to look, not a rule. Touching the date clears
                    // this with the tint.
                    Label(
                        "The date was read two different ways from this receipt. Worth a look.",
                        systemImage: "exclamationmark.triangle"
                    )
                    .font(.footnote)
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
        }
    }

    // MARK: - Free-text fields

    private var optionalFieldsSection: some View {
        Section {
            // These three carry no suggestion and so no amber, but they
            // still take a focus value: the toolbar decides what to offer
            // from the focused field, and a field outside that enum would
            // read as "nothing is focused" while its keyboard was up.
            ReusableValueFieldRow(
                label: "Category",
                text: $model.categoryText,
                field: .category,
                focus: $focusedField,
                pastValues: options.options.categories
            )
            ReusableValueFieldRow(
                label: "Payment",
                text: $model.paymentMethodText,
                field: .paymentMethod,
                focus: $focusedField,
                pastValues: options.options.paymentMethods
            )
            TextField("Notes", text: $model.notesText, axis: .vertical)
                .lineLimit(2...5)
                .focused($focusedField, equals: .notes)
                .accessibilityIdentifier("field.Notes")
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
