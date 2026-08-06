import Foundation

/// The confirm screen's state and decisions (spec §7.2, §10A.1), with no
/// camera and no UIKit anywhere near it - the whole screen is testable on
/// the simulator, which is the §10.2 requirement for the one screen that
/// is the product.
///
/// The rules it owns:
/// - every prefilled (suggested) value starts unreviewed - amber in the
///   UI - and touching a field clears that permanently;
/// - the header counter is how many suggestions remain unreviewed;
/// - the arithmetic check warns, inside the total card, and never blocks;
/// - save is disabled until business-or-personal is chosen (the §5.2
///   no-default rule made visible), with the reason stated;
/// - a valid save hands the confirmed fields to whichever save path built
///   this model: a PATCH with status=confirmed for a server-side pending
///   receipt (the queue and the detail screen), or a durable outbox write
///   for a capture confirmed on the spot (wave-5 gate ratification) - the
///   form neither knows nor cares, which is what keeps the two paths one
///   screen.
@MainActor
final class ConfirmReceiptModel: ObservableObject, Identifiable {
    /// The fields that can carry an OCR suggestion and therefore an amber
    /// marking. Business/personal is deliberately not here: it is never
    /// prefilled (spec §7.2), so it has nothing to mark.
    enum SuggestedField: CaseIterable {
        case total, date, vendor, hst, subtotal, taxNumber
    }

    /// The server-side receipt this form edits, when there is one; nil for
    /// a capture being confirmed before it has uploaded.
    let receiptId: UUID?
    let currency: String
    /// A presigned URL (short-lived; displayed promptly, never persisted)
    /// for stored receipts, or the scanned bytes still in hand for a
    /// capture-time confirm.
    let imageSource: ReceiptImageSource?
    /// Stated when on-device OCR failed outright at capture, so an empty
    /// form reads as "recognition failed", not "the receipt is blank".
    let ocrFailureNote: String?

    // MARK: - Form state

    // Text fields hold text; parsing to cents happens on read. The views
    // bind these directly and report touches via markTouched - keeping
    // "what did the user do" and "what does it mean" both in this model.
    @Published var totalText: String
    @Published var purchasedDate: Date
    @Published var vendorText: String
    @Published var hstText: String
    @Published var subtotalText: String
    @Published var otherTaxText: String
    @Published var taxNumberText: String
    @Published var categoryText: String
    @Published var paymentMethodText: String
    @Published var notesText: String

    /// Nil until the person chooses - there is no default (spec §5.2), and
    /// the save button stays disabled saying why.
    @Published private(set) var businessChoice: Bool?

    @Published private(set) var unreviewedFields: Set<SuggestedField>
    @Published private(set) var isSaving = false
    @Published private(set) var saveError: String?

    /// True when no date was read off the paper and the prefill is the day
    /// of capture - the one suggestion that can be fabricated, so the view
    /// says so out loud instead of passing it off as parsed.
    let dateIsCaptureDayFallback: Bool

    /// Where the confirmed fields go on save. Injected by whoever built
    /// the model; the form's rules above are identical either way.
    private let saveAction: (ConfirmedReceiptFields) async throws -> Void

    // MARK: - Construction

    /// A server-side pending receipt (the confirm queue, or the detail
    /// screen's "Confirm this receipt"): save PATCHes it to confirmed.
    init(api: any KeptAPI, detail: ReceiptDetail) {
        let receipt = detail.receipt
        let id = receipt.id
        saveAction = { fields in
            _ = try await api.confirmReceipt(id: id, ConfirmReceiptRequest(fields))
        }
        receiptId = id
        currency = receipt.currency
        imageSource = detail.images.first.map { .remote($0.downloadUrl) }
        ocrFailureNote = nil

        totalText = receipt.totalCents.map(MoneyInput.text(fromCents:)) ?? ""
        purchasedDate = ReceiptFormat.pickerDate(fromIso: receipt.purchasedAt) ?? Date()
        vendorText = receipt.vendor ?? ""
        hstText = receipt.hstCents.map(MoneyInput.text(fromCents:)) ?? ""
        subtotalText = receipt.subtotalCents.map(MoneyInput.text(fromCents:)) ?? ""
        otherTaxText = receipt.otherTaxCents.map(MoneyInput.text(fromCents:)) ?? ""
        taxNumberText = receipt.vendorTaxNumber ?? ""
        categoryText = receipt.category ?? ""
        paymentMethodText = receipt.paymentMethod ?? ""
        notesText = receipt.notes ?? ""
        businessChoice = nil

        // What starts amber. With the parser's own record (wave-4 reviewer
        // pass), exactly the fields it suggested - a value some other
        // writer put on a pending receipt is not a machine suggestion. The
        // date is always amber: it is always prefilled, either parsed or
        // the capture-day fallback, and the fallback is additionally
        // called out by dateIsCaptureDayFallback. Without a record (older
        // rows, other clients), value-presence is the only proxy left.
        var unreviewed: Set<SuggestedField> = [.date]
        if let suggestions = detail.ocrSuggestions {
            if suggestions.totalCents != nil { unreviewed.insert(.total) }
            if suggestions.vendor != nil { unreviewed.insert(.vendor) }
            if suggestions.hstCents != nil { unreviewed.insert(.hst) }
            if suggestions.subtotalCents != nil { unreviewed.insert(.subtotal) }
            if suggestions.vendorTaxNumber != nil { unreviewed.insert(.taxNumber) }
            dateIsCaptureDayFallback = suggestions.purchasedAt == nil
        } else {
            if receipt.totalCents != nil { unreviewed.insert(.total) }
            if receipt.vendor != nil { unreviewed.insert(.vendor) }
            if receipt.hstCents != nil { unreviewed.insert(.hst) }
            if receipt.subtotalCents != nil { unreviewed.insert(.subtotal) }
            if receipt.vendorTaxNumber != nil { unreviewed.insert(.taxNumber) }
            // No record means no way to tell a parsed date from a
            // fallback; claiming fabrication would be its own lie.
            dateIsCaptureDayFallback = false
        }
        unreviewedFields = unreviewed
    }

    /// A capture being confirmed on the spot, before anything has
    /// uploaded (wave-5 gate ratification): the form is prefilled from
    /// the on-device parse, the image is the scanned bytes still in
    /// memory, and save hands the confirmed fields to the injected
    /// action - a durable outbox write, in production.
    init(
        draft: CapturedReceiptDraft,
        saveAction: @escaping (ConfirmedReceiptFields) async throws -> Void
    ) {
        self.saveAction = saveAction
        receiptId = nil
        // Not editable on this form (spec, wave-4 report §6.3); the create
        // omits it and the server's column default applies.
        currency = "CAD"
        imageSource = .local(draft.imageData)
        ocrFailureNote = draft.ocrFailureNote

        let suggestions = draft.suggestions
        totalText = suggestions.totalCents.map(MoneyInput.text(fromCents:)) ?? ""
        // Parsed date, or the capture day - both through the same
        // UTC-pinned round trip the picker renders in.
        let dateString = suggestions.purchasedAt ?? ReceiptFormat.calendarDate(of: draft.capturedAt)
        purchasedDate = ReceiptFormat.pickerDate(fromIso: dateString) ?? Date()
        vendorText = suggestions.vendor ?? ""
        hstText = suggestions.hstCents.map(MoneyInput.text(fromCents:)) ?? ""
        subtotalText = suggestions.subtotalCents.map(MoneyInput.text(fromCents:)) ?? ""
        otherTaxText = ""
        taxNumberText = suggestions.vendorTaxNumber ?? ""
        categoryText = ""
        paymentMethodText = ""
        notesText = ""
        businessChoice = nil

        // Same amber rule as the server-backed path, read straight from
        // the parse: exactly the suggested fields start unreviewed, and
        // the date always does (parsed or fabricated-from-capture-day,
        // the latter additionally called out).
        var unreviewed: Set<SuggestedField> = [.date]
        if suggestions.totalCents != nil { unreviewed.insert(.total) }
        if suggestions.vendor != nil { unreviewed.insert(.vendor) }
        if suggestions.hstCents != nil { unreviewed.insert(.hst) }
        if suggestions.subtotalCents != nil { unreviewed.insert(.subtotal) }
        if suggestions.vendorTaxNumber != nil { unreviewed.insert(.taxNumber) }
        dateIsCaptureDayFallback = suggestions.purchasedAt == nil
        unreviewedFields = unreviewed
    }

    // MARK: - Reviewing

    /// Touching a field clears its amber permanently (spec §10A.1); the
    /// views call this on focus and on edit.
    func markTouched(_ field: SuggestedField) {
        unreviewedFields.remove(field)
    }

    func isUnreviewed(_ field: SuggestedField) -> Bool {
        unreviewedFields.contains(field)
    }

    /// The header counter: how many suggestions nobody has looked at yet.
    var unreviewedCount: Int {
        unreviewedFields.count
    }

    func chooseBusiness(_ isBusiness: Bool) {
        businessChoice = isBusiness
    }

    // MARK: - Money

    var totalInput: MoneyInput { MoneyInput.parse(totalText) }
    var hstInput: MoneyInput { MoneyInput.parse(hstText) }
    var subtotalInput: MoneyInput { MoneyInput.parse(subtotalText) }
    var otherTaxInput: MoneyInput { MoneyInput.parse(otherTaxText) }

    /// The §7.2 inline check: does subtotal + hst + other tax reach the
    /// total? Only when there is a subtotal and a total to compare -
    /// receipts with neither have nothing to reconcile - and never
    /// blocking, because plenty of legitimate receipts do not reconcile.
    var showsArithmeticWarning: Bool {
        guard
            case .cents(let total) = totalInput,
            case .cents(let subtotal) = subtotalInput
        else {
            return false
        }
        let hst = centsOrZero(hstInput)
        let otherTax = centsOrZero(otherTaxInput)
        guard let hst, let otherTax else {
            // An invalid amount in either field is its own stated problem;
            // warning about arithmetic over garbage would just be noise.
            return false
        }
        return subtotal + hst + otherTax != total
    }

    /// nil for invalid text, 0 for blank - blank means "no such charge".
    private func centsOrZero(_ input: MoneyInput) -> Int? {
        switch input {
        case .empty: return 0
        case .cents(let value): return value
        case .invalid: return nil
        }
    }

    // MARK: - Saving

    /// The reason save is disabled, stated below the button rather than
    /// left to be inferred (spec §10A.1) - or nil, meaning save away.
    var saveBlocker: String? {
        if businessChoice == nil {
            return "Choose business or personal to save."
        }
        switch totalInput {
        case .empty:
            return "Enter the total to save."
        case .invalid:
            return "The total isn't a valid amount."
        case .cents:
            break
        }
        if hstInput == .invalid {
            return "HST isn't a valid amount."
        }
        if subtotalInput == .invalid {
            return "The subtotal isn't a valid amount."
        }
        if otherTaxInput == .invalid {
            return "Other tax isn't a valid amount."
        }
        return nil
    }

    var canSave: Bool {
        saveBlocker == nil
    }

    /// One tap, one durable save - a PATCH or an outbox write, whichever
    /// built this model - straight back to wherever the person came from,
    /// no success modal (spec §10A.1). Returns whether the receipt is now
    /// confirmed.
    func save() async -> Bool {
        guard let isBusiness = businessChoice, case .cents(let totalCents) = totalInput else {
            // The UI disables save while saveBlocker is non-nil; reaching
            // here anyway is a wiring bug, surfaced as the stated reason.
            saveError = saveBlocker
            return false
        }
        guard !isSaving else { return false }

        isSaving = true
        saveError = nil
        defer { isSaving = false }

        do {
            try await saveAction(ConfirmedReceiptFields(
                purchasedAt: ReceiptFormat.isoDate(fromPicker: purchasedDate),
                vendor: normalized(vendorText),
                vendorTaxNumber: normalized(taxNumberText),
                subtotalCents: centsOrNil(subtotalInput),
                hstCents: centsOrNil(hstInput),
                otherTaxCents: centsOrNil(otherTaxInput),
                totalCents: totalCents,
                category: normalized(categoryText),
                paymentMethod: normalized(paymentMethodText),
                isBusiness: isBusiness,
                notes: normalized(notesText)
            ))
            return true
        } catch {
            saveError = error.localizedDescription
            return false
        }
    }

    private func centsOrNil(_ input: MoneyInput) -> Int? {
        if case .cents(let value) = input {
            return value
        }
        return nil
    }

    /// Whitespace-trimmed, empty-to-nil: a blank field is an absent value,
    /// and the server stores absences as null, not "".
    private func normalized(_ text: String) -> String? {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
