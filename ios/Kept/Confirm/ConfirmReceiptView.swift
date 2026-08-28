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
    /// The person's own past categories, payment methods and vendors,
    /// offered back on those rows. Empty until the fetch lands - or
    /// forever, if it fails or nothing has been used yet - and the form
    /// is complete either way (never blocks on the network).
    @ObservedObject var options: ReceiptOptionsStore
    /// Behavioural telemetry (2026-08-28) - fire-and-forget by contract
    /// (EventLogger's own doc comment), so every call site below is a
    /// plain, unawaited `log()`: nothing here may block or fail visibly.
    let eventLogger: EventLogger
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
                    logDeferralIfConfirming()
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
        .onAppear {
            // `confirm_opened` (2026-08-28): only for an actual confirm -
            // `.edit` reopens the same form over a person's own already-
            // confirmed values, which is a different action
            // (`receipt_edited` fires on its save instead, below).
            if model.purpose == .confirm {
                eventLogger.log(.confirmOpened, receiptId: model.receiptId)
            }
            // Proposal #2's vendor-default prefill (2026-08-28): whatever
            // ReceiptOptionsStore already holds at this moment - the last
            // fetch, possibly stale, possibly from disk - is harmless to
            // try immediately, the same "these are suggestions into a
            // free-text field" reasoning ReceiptOptionsStore's own doc
            // comment states for the reuse menus. The two onChange hooks
            // below cover the cases this single call cannot: a vendor
            // typed or picked after the screen opens, and an options fetch
            // that lands after it.
            applyVendorDefaultsIfAvailable()
        }
        .onChange(of: model.vendorText) { _, _ in
            applyVendorDefaultsIfAvailable()
        }
        .onChange(of: options.options) { _, _ in
            applyVendorDefaultsIfAvailable()
        }
        .onChange(of: focusedField) { oldFocus, newFocus in
            // Focusing a field is looking at it: the amber clears whether
            // or not the person then edits (spec §10A.1).
            if let suggestion = newFocus?.suggestion {
                model.markTouched(suggestion)
            }
            // field_edited's per-focus-cycle counting (2026-08-28): the
            // field being left is checked for an actual change, then the
            // field being entered gets its own snapshot to be checked
            // against next time it is left.
            if let oldFocus {
                model.fieldDidLoseFocus(oldFocus)
            }
            if let newFocus {
                model.fieldDidGainFocus(newFocus)
            }
        }
        .sheet(isPresented: $showZoomedImage) {
            if let imageSource = model.imageSource {
                ZoomableImageSheet(source: imageSource) {
                    eventLogger.log(.imageZoomed, receiptId: model.receiptId)
                }
            }
        }
    }

    // MARK: - Vendor defaults (proposal #2, 2026-08-28)

    /// The one call site for ConfirmReceiptModel.applyVendorDefaultIfAvailable(_:) -
    /// wired to three triggers above (onAppear, the vendor text changing,
    /// the options fetch landing) because any of the three can be the
    /// thing that makes a match newly possible, and the model itself is
    /// deliberately not the one polling ReceiptOptionsStore (its own doc
    /// comment: staying network-free is what keeps it simulator-testable,
    /// spec §10.2).
    private func applyVendorDefaultsIfAvailable() {
        model.applyVendorDefaultIfAvailable(options.options.vendorDefaults)
    }

    // MARK: - Telemetry (2026-08-28)

    /// `confirm_deferred` fires only for an actual pending-receipt "Later"
    /// - `.edit`'s "Cancel" leaves nothing pending behind (the receipt was
    /// already confirmed before this form opened), so it is not a
    /// deferral of anything and gets no event.
    private func logDeferralIfConfirming() {
        guard model.purpose == .confirm else { return }
        eventLogger.log(.confirmDeferred, receiptId: model.receiptId)
    }

    /// Everything this screen reports at a successful save: which action
    /// (`confirm_saved` for a first confirmation, `receipt_edited` for a
    /// re-edit of an already-confirmed receipt), one `field_edited` per
    /// field actually edited this session with its count, and one
    /// `suggestion_accepted`/`suggestion_overridden` per field that
    /// carried a suggestion - all derived from state ConfirmReceiptModel
    /// already keeps (fieldEditCounts, suggestionOutcomes()), never from a
    /// receipt field's value (spec: "no field values, ever").
    private func logSave() {
        let receiptId = model.receiptId
        eventLogger.log(
            model.purpose == .edit ? .receiptEdited : .confirmSaved,
            receiptId: receiptId
        )
        for (field, count) in model.fieldEditCounts {
            eventLogger.log(.fieldEdited, field: field, receiptId: receiptId, count: count)
        }
        for outcome in model.suggestionOutcomes() {
            eventLogger.log(
                outcome.accepted ? .suggestionAccepted : .suggestionOverridden,
                field: outcome.field,
                receiptId: receiptId
            )
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
                    .onTapGesture {
                        showZoomedImage = true
                        eventLogger.log(.imageOpened, receiptId: model.receiptId)
                    }
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
                    // do not reconcile (spec §7.2, §10A.1). Four
                    // components now feed the check (2026-08-28: tip and
                    // other fees rejoined subtotal and HST), so the
                    // wording names the total rather than enumerating them.
                    Label(
                        "These amounts don't add up to the total. Worth a look.",
                        systemImage: "exclamationmark.triangle"
                    )
                    .font(.footnote)
                    .foregroundStyle(.orange)
                }
                derivedAmountAffordances
            }
            .padding(.vertical, 6)
            .listRowBackground(suggestionBackground(for: .total))
        }
    }

    /// Proposal #1 (2026-08-28): the one-tap fill when exactly one money
    /// field is derivable, or the reconciliation split when all five are
    /// present but do not reconcile. Named buttons, not bare ones - the
    /// proposal's own risk, verbatim: "a person tapping without reading
    /// and storing an amount the paper does not print" - so every button
    /// here carries the model's own label stating what it does and the
    /// exact amount before anyone taps it. Mutually exclusive by
    /// construction (ConfirmReceiptModel.derivableFill's own comment), so
    /// at most one row of buttons ever shows.
    @ViewBuilder
    private var derivedAmountAffordances: some View {
        if let label = model.derivableFillLabel {
            derivedAmountButton(label, identifier: "derivedFill.apply") {
                model.applyDerivedFill()
            }
        }
        if let tipLabel = model.reconciliationLabel(for: .tip) {
            derivedAmountButton(tipLabel, identifier: "reconciliation.tip") {
                model.applyReconciliationDifference(into: .tip)
            }
        }
        if let otherFeesLabel = model.reconciliationLabel(for: .otherFees) {
            derivedAmountButton(otherFeesLabel, identifier: "reconciliation.otherFees") {
                model.applyReconciliationDifference(into: .otherFees)
            }
        }
    }

    /// One button shape for both proposal #1 affordances, so the labelled-
    /// not-bare treatment - the proposal's own risk mitigation - cannot
    /// drift between the fill button and the two reconciliation buttons
    /// the way `SuggestedFieldRow`'s own history warns a near-duplicate
    /// view would.
    private func derivedAmountButton(_ label: String, identifier: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(label, systemImage: "wand.and.stars")
                .font(.footnote)
        }
        .buttonStyle(.borderless)
        .accessibilityIdentifier(identifier)
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
                    .receiptDatePickerPin()
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
                    DisagreementNote(
                        message: "The date was read two different ways from this receipt. Worth a look."
                    )
                }
            }
            .listRowBackground(suggestionBackground(for: .date))
            .simultaneousGesture(TapGesture().onEnded {
                model.markTouched(.date)
            })
            .onChange(of: model.purchasedDate) { _, _ in
                model.markTouched(.date)
                model.recordDateEdited()
            }

            // Vendor is both a suggestion row and a reusable-value row
            // (2026-08-28): it carried the amber treatment before it ever
            // had a menu, and the composed ReusableValueFieldRow keeps
            // both rather than choosing one at the other's expense.
            ReusableValueFieldRow(
                label: "Vendor",
                text: $model.vendorText,
                field: .vendor,
                focus: $focusedField,
                pastValues: options.options.vendors,
                placeholder: "Not found",
                isUnreviewed: model.isUnreviewed(.vendor),
                onReuse: { eventLogger.log(.optionReused, field: .vendor, receiptId: model.receiptId) }
            )
            SuggestedFieldRow(
                label: "HST",
                text: $model.hstText,
                field: .hst,
                focus: $focusedField,
                isUnreviewed: model.isUnreviewed(.hst),
                moneyInput: model.hstInput,
                // The two parsers produced different HST amounts off the
                // same text (§7.3, 2026-08-28) - free signal on the input
                // tax credit, the one amount with a direct tax
                // consequence. Exactly the date note's treatment, reused
                // rather than duplicated (DisagreementNote above).
                disagreementNote: model.showsHstDisagreementNote
                    ? "The HST was read two different ways from this receipt. Worth a look."
                    : nil
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
                label: "Tip",
                text: $model.tipText,
                field: .tip,
                focus: $focusedField,
                isUnreviewed: model.isUnreviewed(.tip),
                moneyInput: model.tipInput
            )
            // Other fees never starts amber from a parser (§6: no
            // heuristic or LLM can match a residual with no consistent
            // printed label) - but it CAN go amber from a proposal #1
            // derived fill or reconciliation split (2026-08-28), so this
            // reads the model exactly like every field above it rather
            // than hard-coding false the way it used to when no source of
            // amber existed for this field at all.
            SuggestedFieldRow(
                label: "Other fees",
                text: $model.otherFeesText,
                field: .otherFees,
                focus: $focusedField,
                isUnreviewed: model.isUnreviewed(.otherFees),
                moneyInput: model.otherFeesInput
            )
        }
    }

    // MARK: - Free-text fields

    private var optionalFieldsSection: some View {
        Section {
            // Category and payment method carry no OCR suggestion, but
            // either can go amber from a proposal #2 vendor default
            // (2026-08-28) - same isUnreviewed wiring as every other
            // suggestible field now, in place of the permanent false these
            // two carried before a source of amber existed for them.
            ReusableValueFieldRow(
                label: "Category",
                text: $model.categoryText,
                field: .category,
                focus: $focusedField,
                pastValues: options.options.categories,
                isUnreviewed: model.isUnreviewed(.category),
                onReuse: { eventLogger.log(.optionReused, field: .category, receiptId: model.receiptId) }
            )
            ReusableValueFieldRow(
                label: "Payment",
                text: $model.paymentMethodText,
                field: .paymentMethod,
                focus: $focusedField,
                pastValues: options.options.paymentMethods,
                isUnreviewed: model.isUnreviewed(.paymentMethod),
                onReuse: { eventLogger.log(.optionReused, field: .paymentMethod, receiptId: model.receiptId) }
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
                        logSave()
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
