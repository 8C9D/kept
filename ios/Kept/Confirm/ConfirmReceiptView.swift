import SwiftUI

/// The confirm screen (spec §7.2, §10A.1) - the heart of the app. The
/// scanned image up top for checking numbers against paper, the total as
/// the loudest thing on screen, and a save that stays disabled - with the
/// reason stated - until there is a valid total.
///
/// The same screen edits an already-confirmed receipt (`purpose == .edit`).
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
    /// Proposal #8 (2026-08-28)'s "open the matching receipt" affordance
    /// only - nothing else in this view talks to the network directly.
    /// `nil` for a capture-time confirm, which has no server row to
    /// compare against yet (ConfirmReceiptModel's `duplicateCheckAction`
    /// doc comment states why in full) - `model.possibleDuplicates` stays
    /// permanently empty in that case, so `duplicateWarningSection` never
    /// renders and this is never dereferenced.
    var api: (any KeptAPI)? = nil
    let onSaved: () async -> Void
    let onSetAside: () async -> Void
    /// Runs after the form is written WITHOUT being confirmed (2026-09-01,
    /// "Save for later") - the receipt is still pending, so this is where
    /// control goes next, not where the receipt goes. Nil means the caller
    /// offers no such action here: the capture-time confirm, whose own
    /// "Later" already queues the scan pending with whatever was typed,
    /// and the UI-test harness.
    var onSavedForLater: (() async -> Void)? = nil
    /// Runs after the receipt is deleted from this form (2026-09-01),
    /// before whatever presented it goes away. Nil means the caller offers
    /// no Delete here - the capture-time confirm, which has no server row
    /// to delete, and the UI-test harness. A server-backed caller that
    /// wants the affordance has to say where control goes afterwards,
    /// which is why this is a parameter rather than something the form
    /// decides on its own.
    var onDeleted: (() async -> Void)? = nil

    @FocusState private var focusedField: ConfirmReceiptModel.EditableField?
    @State private var showZoomedImage = false
    /// Non-nil while a proposal #8 match is open for comparison.
    @State private var openedDuplicateMatch: Receipt?
    @State private var confirmingDelete = false
    /// Up while Save is waiting for the person to acknowledge a mismatch
    /// too large to be rounding (2026-09-01, `saveNeedsAcknowledgement`).
    @State private var acknowledgingMismatch = false

    var body: some View {
        Form {
            imageSection
            totalSection
            duplicateWarningSection
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
            // Same control, same place, same words as the detail screen's
            // (ReceiptDetailView) - the queue reached a pending receipt
            // with no way to bin it, and the fix is the affordance the
            // other route already had, not a second design for it.
            if showsDelete {
                ToolbarItem(placement: .topBarTrailing) {
                    Button(role: .destructive) {
                        confirmingDelete = true
                    } label: {
                        Label("Delete receipt", systemImage: "trash")
                    }
                    .disabled(model.isDeleting)
                }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button(model.dismissLabel) {
                    logDeferralIfConfirming()
                    Task { await onSetAside() }
                }
            }
        }
        // Verbatim the detail screen's dialog, down to the message: one
        // delete, one set of words about what it does. It must keep saying
        // the record is kept for retention (spec §10B) - it is a
        // tombstone, not an erase.
        .confirmationDialog(
            "Delete this receipt?",
            isPresented: $confirmingDelete,
            titleVisibility: .visible
        ) {
            Button("Delete receipt", role: .destructive) {
                Task { await deleteReceipt() }
            }
            Button("Keep it", role: .cancel) {}
        } message: {
            Text("It disappears from your list and every future export. The record and its image stay stored for tax retention - they aren't erased - and this can't be undone from inside the app.")
        }
        // One tap between an impossible set of amounts and a stored tax
        // record (2026-09-01). The advisory note under the total fired on
        // all four real data errors in production and was ticked past
        // every time - a $218.94 Costco purchase went in at $8.50 - so the
        // sharpest cases now ask, once, in words that name the gap. It
        // still saves if that is what the paper says: "Save anyway"
        // proceeds unchanged, logs nothing extra, and `.edit` never
        // reaches here at all (ConfirmReceiptModel.saveNeedsAcknowledgement
        // carries the store-credit receipt that makes that exemption
        // necessary).
        .confirmationDialog(
            "Check these amounts",
            isPresented: $acknowledgingMismatch,
            titleVisibility: .visible
        ) {
            Button("Save anyway") {
                Task { await saveReceipt() }
            }
            // Deliberately NOT `role: .cancel` (2026-09-01, established by
            // screenshot). iOS 26 presents this dialog anchored to the
            // Save button, and that presentation renders no cancel button
            // at all - the shipped delete dialog above has the same shape
            // and shows "Delete receipt" alone, with "Keep it" nowhere on
            // screen. A dialog whose entire job is to make someone stop
            // and look must show them the way back in words, so this one
            // is an ordinary button. Tapping outside still dismisses it,
            // and either way nothing is saved.
            Button("Go back") {}
        } message: {
            Text(model.saveAcknowledgementMessage ?? "")
        }
        .alert(
            "Your receipt was not deleted",
            isPresented: Binding(
                get: { model.deleteError != nil },
                set: { if !$0 { model.clearDeleteError() } }
            )
        ) {
            Button("OK", role: .cancel) {
                model.clearDeleteError()
            }
        } message: {
            Text(model.deleteError ?? "")
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
        // Proposal #8 (2026-08-28): re-checks for a possible duplicate
        // whenever the date, vendor or total changes, debounced the same
        // way HomeView's search box is - `.task(id:)` cancels and restarts
        // on every keystroke, so only the last one outlives the sleep and
        // typing a total costs one request, not one per digit. The run at
        // appearance reaches checkForPossibleDuplicates() with whatever
        // the form opened prefilled with, which is exactly when a
        // re-scanned duplicate is worth catching.
        // model.checkForPossibleDuplicates() is itself fire-and-forget and
        // a no-op with no injected lookup (a capture-time confirm) - this
        // task only owns debouncing, never the network call or its result.
        .task(id: duplicateCheckTriggerKey) {
            do {
                try await Task.sleep(for: .milliseconds(400))
            } catch {
                return
            }
            model.checkForPossibleDuplicates()
        }
        .onChange(of: focusedField) { oldFocus, newFocus in
            // Focusing a field is looking at it, which is what puts it in
            // the reviewed set a save reports (§10A.1, and 2026-09-01's
            // `reviewedFields`). It no longer clears the inline notes -
            // those now go when the VALUE changes, because the rate hint
            // vanishing at the exact moment you tap in to act on it is
            // the defect the owner named (ConfirmReceiptModel's
            // `stillHoldsSuggestedValue`).
            if let newFocus {
                model.markTouched(editable: newFocus)
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
        // Proposal #8's "open the matching receipt" affordance: the exact
        // Receipt the lookup returned, straight into the same detail
        // screen every other row on the list opens - no second fetch, and
        // a real image to compare against paper rather than a second copy
        // of the three fields already shown inline below. `api` is nil
        // only for a capture-time confirm, where `possibleDuplicates` is
        // permanently empty and this sheet can never be asked to open
        // (this view's own `api` doc comment).
        .sheet(item: $openedDuplicateMatch) { match in
            if let api {
                NavigationStack {
                    ReceiptDetailView(
                        api: api,
                        options: options,
                        eventLogger: eventLogger,
                        receipt: match,
                        onDeleted: {}
                    )
                }
            }
        }
    }

    // MARK: - Possible duplicates (proposal #8, 2026-08-28)

    /// What `.task(id:)` above keys the debounce on: any change to any of
    /// the three fields the lookup compares is a reason to re-check.
    /// A plain `String` rather than a tuple - `.task(id:)` needs
    /// `Equatable`, which a tuple of `Equatable` elements does not
    /// automatically get in Swift.
    private var duplicateCheckTriggerKey: String {
        "\(ReceiptFormat.isoDate(fromPicker: model.purchasedDate))|\(model.totalText)|\(model.vendorText)"
    }

    @ViewBuilder
    private var duplicateWarningSection: some View {
        if !model.possibleDuplicates.isEmpty {
            Section {
                // Quiet, never red, and phrased as a prompt to look - the
                // same family as the arithmetic warning (proposal #8's own
                // words) - because a false positive here is normal and
                // cheap to dismiss (two identical coffees on one Tuesday),
                // and this must never block or refuse a save.
                Label(
                    model.possibleDuplicates.count == 1
                        ? "A receipt with this date, vendor and total already exists."
                        : "\(model.possibleDuplicates.count) receipts with this date, vendor and total already exist.",
                    systemImage: "exclamationmark.triangle"
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
                ForEach(model.possibleDuplicates) { match in
                    Button {
                        openedDuplicateMatch = match
                    } label: {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(match.vendor ?? "Not recorded")
                                .foregroundStyle(.primary)
                            Text(
                                "\(ReceiptFormat.purchaseDate(match.purchasedAt))"
                                    + (match.totalCents.map { " · " + ReceiptFormat.money(cents: $0, currency: match.currency) } ?? "")
                            )
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                    }
                    .accessibilityIdentifier("possibleDuplicate.\(match.id.uuidString)")
                }
            }
        }
    }

    // MARK: - Delete (2026-09-01)

    /// Both halves have to be true: the model has a server row to delete
    /// (`canDelete`), and whoever presented this form said where control
    /// goes once it is gone. A capture-time confirm fails both.
    private var showsDelete: Bool {
        model.canDelete && onDeleted != nil
    }

    // MARK: - Saving (2026-09-01)

    /// The one save path, so the button and the acknowledgement dialog's
    /// "Save anyway" cannot diverge on what a save does.
    private func saveReceipt() async {
        guard await model.save() else { return }
        logSave()
        await onSaved()
    }

    /// Both halves have to be true, the same shape `showsDelete` uses: the
    /// model has a server row to half-write (`canSaveForLater`), and
    /// whoever presented this form said where control goes once it is
    /// written. A capture-time confirm fails both.
    private var showsSaveForLater: Bool {
        model.canSaveForLater && onSavedForLater != nil
    }

    /// A save-for-later is a deferral - the receipt is still pending and
    /// still counted - so it reports the same `confirm_deferred` the
    /// toolbar's "Later" does. There is no new event: what changed is that
    /// the deferral now keeps the typing, not what the deferral IS.
    private func saveForLater() async {
        guard await model.saveForLater() else { return }
        logDeferralIfConfirming()
        await onSavedForLater?()
    }

    /// `receipt_deleted` is logged here rather than inside the model for
    /// the same reason every other event on this screen is: the model is
    /// deliberately network- and telemetry-free, and this view is the one
    /// that already holds the EventLogger. It fires only on a real
    /// success, so a failed delete never reports one.
    private func deleteReceipt() async {
        guard await model.delete() else { return }
        eventLogger.log(.receiptDeleted, receiptId: model.receiptId)
        await onDeleted?()
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
                if let withheldNote = model.withheldAmountNote {
                    // A stated absence with its reason (2026-09-01): the
                    // amounts read off this receipt could not all be true,
                    // so the total was not prefilled at all. Same quiet
                    // treatment as the arithmetic warning below - this is
                    // a prompt to look at the paper, not an error - but a
                    // different fact from it: that one is about numbers a
                    // person typed, this one about a number nobody did.
                    Label(withheldNote, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("note.withheldAmounts")
                }
                if let warning = model.amountsWarning {
                    // Quiet, not red, and inside the card: a prompt to
                    // look, not an error - plenty of legitimate receipts
                    // do not reconcile (spec §7.2, §10A.1). Four
                    // components feed the check (2026-08-28: tip and
                    // other fees rejoined subtotal and HST). ONE line,
                    // whichever of the two facts is the sharper one -
                    // `amountsWarning` owns that choice so the two notes
                    // can never both render about a single arithmetic
                    // fact (2026-09-01).
                    Label(warning, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .accessibilityIdentifier("note.amounts")
                }
                derivedAmountAffordances
            }
            .padding(.vertical, 6)
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
        // The HST chip (2026-09-01): the difference the receipt's own
        // numbers determine, or - only on a CAD receipt - 13% of the
        // subtotal, never both and never auto-applied. It sits first
        // because it is the offer for the commonest shape a receipt
        // arrives in, a tax line the parsers could not read; where it and
        // the derived fill would both answer for HST, the model suppresses
        // the fill (`derivableFillLabel`) so the person is never handed
        // two numbers this form invented and asked to choose.
        if let chipLabel = model.hstSuggestionChipLabel {
            derivedAmountButton(chipLabel, identifier: "hstChip.apply") {
                model.applyHstSuggestionChip()
            }
        }
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
        // The server's second opinion, where it disagrees with an amount
        // already on screen (2026-09-01). Offered, never applied: a number
        // changing under someone's eyes while they read a receipt is the
        // one behaviour this screen must not have. Same labelled-not-bare
        // button as proposal #1's fills, for the same stated reason.
        ForEach(model.serverAmountAlternatives) { alternative in
            derivedAmountButton(
                model.serverAlternativeLabel(alternative),
                identifier: "serverAlternative.\(alternative.id)"
            ) {
                model.applyServerAlternative(alternative)
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

    /// What the four component money rows bind to instead of their text
    /// properties (2026-09-01): every edit goes through
    /// `editComponentAmount`, so the total-tracking rule runs on a
    /// keystroke exactly as it does on an amount chip, and the rule itself
    /// lives in one tested place rather than in four `onChange` handlers.
    /// The total is deliberately NOT bound this way - it is the anchor,
    /// and editing it never moves anything else.
    private func componentBinding(_ field: ConfirmReceiptModel.ComponentAmountField) -> Binding<String> {
        Binding(
            get: { model.componentText(field) },
            set: { model.editComponentAmount(field, to: $0) }
        )
    }

    private var detailFieldsSection: some View {
        Section {
            // Date: always prefilled (parsed or capture-day fallback), so
            // it participates in the reviewed/unreviewed bookkeeping.
            // DatePicker taps don't move focus, so the row reports its own
            // interaction below. The picker is pinned to the same UTC
            // frame as the parse and format around it - unpinned, it shows
            // the previous day west of Greenwich and saves the next day
            // when "corrected".
            VStack(alignment: .leading, spacing: 4) {
                DatePicker("Date", selection: $model.purchasedDate, displayedComponents: .date)
                    .receiptDatePickerPin()
                if model.dateIsCaptureDayFallback {
                    // The one suggestion that can be fabricated: no date
                    // parsed, so this is the capture day, said out loud
                    // rather than passed off as something read from paper.
                    Text("No date was found on the receipt - this is the day it was scanned.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                if model.showsDateDisagreementNote {
                    // The two parsers read different dates off the same
                    // text (§7.3) - free signal on the field that decides
                    // the fiscal year. Same treatment as the arithmetic
                    // warning: quiet, inside the field, never red - a
                    // prompt to look, not a rule. Touching the date clears
                    // it: a human has had their look.
                    DisagreementNote(
                        message: "The date was read two different ways from this receipt. Worth a look."
                    )
                }
            }
            .simultaneousGesture(TapGesture().onEnded {
                model.markTouched(.date)
            })
            .onChange(of: model.purchasedDate) { _, _ in
                model.markTouched(.date)
                model.recordDateEdited()
            }

            // Vendor is both a suggestion row and a reusable-value row
            // (2026-08-28): the parser can prefill it AND the person's own
            // past vendors are offered on it, which is why it states an
            // absence as "Not found" where category and payment method say
            // "None".
            ReusableValueFieldRow(
                label: "Vendor",
                text: $model.vendorText,
                field: .vendor,
                focus: $focusedField,
                pastValues: options.options.vendors,
                placeholder: "Not found",
                onReuse: { eventLogger.log(.optionReused, field: .vendor, receiptId: model.receiptId) }
            )
            SuggestedFieldRow(
                label: "HST",
                text: componentBinding(.hst),
                field: .hst,
                focus: $focusedField,
                moneyInput: model.hstInput,
                // The two parsers produced different HST amounts off the
                // same text (§7.3, 2026-08-28) - free signal on the input
                // tax credit, the one amount with a direct tax
                // consequence. Exactly the date note's treatment, reused
                // rather than duplicated (DisagreementNote above).
                disagreementNote: model.showsHstDisagreementNote
                    ? "The HST was read two different ways from this receipt. Worth a look."
                    : nil,
                // Proposal #7 (2026-08-28): a prompt to look, not a
                // verdict - worded so it can be dismissed by checking the
                // paper, exactly like every other note this screen shows.
                // Never widened past what ReceiptArithmetic.swift's own
                // comment states this is narrowly about (half of a 13%
                // split), so it never names 5%, 15% or "not 13%".
                rateHintNote: model.showsHstRateHint
                    ? "This HST looks like half of a 13% split. Worth a look."
                    : nil
            )
            SuggestedFieldRow(
                label: "Subtotal",
                text: componentBinding(.subtotal),
                field: .subtotal,
                focus: $focusedField,
                moneyInput: model.subtotalInput
            )
            SuggestedFieldRow(
                label: "Tip",
                text: componentBinding(.tip),
                field: .tip,
                focus: $focusedField,
                moneyInput: model.tipInput
            )
            // Other fees is never suggested by a parser (§6: no heuristic
            // or LLM can match a residual with no consistent printed
            // label) - it is only ever filled by hand or by a proposal #1
            // derived fill.
            SuggestedFieldRow(
                label: "Other fees",
                text: componentBinding(.otherFees),
                field: .otherFees,
                focus: $focusedField,
                moneyInput: model.otherFeesInput
            )
        }
    }

    // MARK: - Free-text fields

    private var optionalFieldsSection: some View {
        Section {
            // Category and payment method carry no OCR suggestion, but
            // either can be prefilled from a proposal #2 vendor default
            // (2026-08-28) - identical rows, deliberately: whatever one of
            // them gains, the other gains in the same edit.
            ReusableValueFieldRow(
                label: "Category",
                text: $model.categoryText,
                field: .category,
                focus: $focusedField,
                pastValues: options.options.categories,
                onReuse: { eventLogger.log(.optionReused, field: .category, receiptId: model.receiptId) }
            )
            ReusableValueFieldRow(
                label: "Payment",
                text: $model.paymentMethodText,
                field: .paymentMethod,
                focus: $focusedField,
                pastValues: options.options.paymentMethods,
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
                // The acknowledgement is asked BEFORE the save, never
                // after: the dialog's "Save anyway" runs the same
                // `saveReceipt()` this branch would have.
                if model.saveNeedsAcknowledgement {
                    acknowledgingMismatch = true
                } else {
                    Task { await saveReceipt() }
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

            // "Let me enter partial info incrementally without saving the
            // receipt as confirmed" (the owner, 2026-09-01). Under the Save
            // button and quieter than it, because confirming is still what
            // this screen is for - and distinct from the toolbar's
            // "Later", which stays what it has always been: the exit that
            // keeps the receipt pending and DISCARDS what was typed.
            if showsSaveForLater {
                Button {
                    Task { await saveForLater() }
                } label: {
                    Text("Save for later")
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .disabled(model.isSaving)
                .accessibilityIdentifier("saveForLater")

                Text("Keeps this receipt pending and remembers what you have filled in.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
            }

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

}
