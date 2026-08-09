import Foundation

/// The machine suggestions the confirm form renders - one shape for every
/// route that opens the screen. Whoever builds the model injects the set
/// that exists for it: the server's §7.3 merge for a stored receipt (the
/// queue and the detail screen), or the on-device parse alone for a
/// capture-time confirm, where no server row - and so no merge and no
/// disagreement flag - exists yet. The form renders whichever set it was
/// handed and never knows which route built it.
struct ConfirmSuggestionSet {
    let vendor: String?
    let purchasedAt: String?
    let totalCents: Int?
    let hstCents: Int?
    let subtotalCents: Int?
    let vendorTaxNumber: String?
    /// Both parsers read a date off the same text and they differ (§7.3).
    /// Only the server merge can raise this.
    let dateDisagreement: Bool

    init(merged: MergedSuggestions) {
        vendor = merged.vendor.value
        purchasedAt = merged.purchasedAt.value
        totalCents = merged.totalCents.value
        hstCents = merged.hstCents.value
        subtotalCents = merged.subtotalCents.value
        vendorTaxNumber = merged.vendorTaxNumber.value
        dateDisagreement = merged.purchasedAt.disagreement
    }

    init(parse: ReceiptSuggestions) {
        vendor = parse.vendor
        purchasedAt = parse.purchasedAt
        totalCents = parse.totalCents
        hstCents = parse.hstCents
        subtotalCents = parse.subtotalCents
        vendorTaxNumber = parse.vendorTaxNumber
        dateDisagreement = false
    }
}

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
/// - a date the two parsers disagreed on carries an inline note with the
///   arithmetic warning's treatment, cleared with the amber by touch;
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

    /// Every field on the form that raises a keyboard, which the view's
    /// focus runs on instead of SuggestedField. Two things needed the
    /// wider set: "other tax" carries no suggestion and so had no focus
    /// value at all - leaving one decimal pad nothing could close - and
    /// the keyboard toolbar has to know which keyboard is up before it can
    /// offer a way out of it. The date is deliberately absent: a
    /// DatePicker raises no keyboard.
    enum EditableField: Hashable, CaseIterable {
        case total, vendor, hst, subtotal, otherTax, taxNumber
        case category, paymentMethod, notes

        /// The money fields, which take a decimal pad.
        var usesDecimalPad: Bool {
            switch self {
            case .total, .hst, .subtotal, .otherTax:
                return true
            case .vendor, .taxNumber, .category, .paymentMethod, .notes:
                return false
            }
        }

        /// The keyboards with no exit of their own, which the toolbar's
        /// Done button is there to give one: a decimal pad has no return
        /// key at all, and notes is a vertical-axis field whose return key
        /// inserts a newline. A separate question from the keyboard type -
        /// the single-line text fields' return key dismisses, so an
        /// accessory bar there would only cost form height.
        var needsDoneButton: Bool {
            switch self {
            case .total, .hst, .subtotal, .otherTax, .notes:
                return true
            case .vendor, .taxNumber, .category, .paymentMethod:
                return false
            }
        }

        /// The suggestion this field carries, if any. Focusing a field is
        /// looking at it, which clears that amber permanently (§10A.1);
        /// fields returning nil were never prefilled by a parser.
        var suggestion: SuggestedField? {
            switch self {
            case .total: return .total
            case .vendor: return .vendor
            case .hst: return .hst
            case .subtotal: return .subtotal
            case .taxNumber: return .taxNumber
            case .otherTax, .category, .paymentMethod, .notes: return nil
            }
        }
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

    /// §7.3: the injected suggestion set says both parsers read a date and
    /// they differ. Constant for the form's life; what the screen shows
    /// follows the amber (showsDateDisagreementNote).
    private let dateDisagreement: Bool

    /// Where the confirmed fields go on save. Injected by whoever built
    /// the model; the form's rules above are identical either way.
    private let saveAction: (ConfirmedReceiptFields) async throws -> Void

    // MARK: - Construction

    /// A server-side pending receipt (the confirm queue, or the detail
    /// screen's "Confirm this receipt"): the suggestion set is the §7.3
    /// merge the API serves on every receipt - both parsers, merged by
    /// the domain layer; this client renders, never decides (spec §4.1) -
    /// and save PATCHes the receipt to confirmed.
    convenience init(api: any KeptAPI, detail: ReceiptDetail) {
        let receipt = detail.receipt
        let id = receipt.id
        self.init(
            receiptId: id,
            currency: receipt.currency,
            imageSource: detail.images.first.map { .remote($0.downloadUrl) },
            ocrFailureNote: nil,
            suggestions: receipt.suggestions.map(ConfirmSuggestionSet.init(merged:)),
            existing: ExistingValues(
                purchasedAt: receipt.purchasedAt,
                vendor: receipt.vendor,
                vendorTaxNumber: receipt.vendorTaxNumber,
                totalCents: receipt.totalCents,
                hstCents: receipt.hstCents,
                subtotalCents: receipt.subtotalCents,
                otherTaxCents: receipt.otherTaxCents,
                category: receipt.category,
                paymentMethod: receipt.paymentMethod,
                notes: receipt.notes
            ),
            saveAction: { fields in
                _ = try await api.confirmReceipt(id: id, ConfirmReceiptRequest(fields))
            }
        )
    }

    /// A capture being confirmed on the spot, before anything has
    /// uploaded (wave-5 gate ratification): the suggestion set is the
    /// on-device parse alone - no server row yet, so no merge and no
    /// disagreement flag is possible - the image is the scanned bytes
    /// still in memory, and save hands the confirmed fields to the
    /// injected action - a durable outbox write, in production.
    convenience init(
        draft: CapturedReceiptDraft,
        saveAction: @escaping (ConfirmedReceiptFields) async throws -> Void
    ) {
        self.init(
            receiptId: nil,
            // Not editable on this form (spec, wave-4 report §6.3); the
            // create omits it and the server's column default applies.
            currency: "CAD",
            imageSource: .local(draft.imageData),
            ocrFailureNote: draft.ocrFailureNote,
            suggestions: ConfirmSuggestionSet(parse: draft.suggestions),
            existing: ExistingValues(
                purchasedAt: ReceiptFormat.calendarDate(of: draft.capturedAt)
            ),
            saveAction: saveAction
        )
    }

    /// The values already on the record before any suggestion applies:
    /// the server row's fields for a stored receipt, or - capture-time -
    /// nothing but the capture day. A value only here was written by
    /// something other than a parser, so it prefills without amber.
    private struct ExistingValues {
        var purchasedAt: String
        var vendor: String?
        var vendorTaxNumber: String?
        var totalCents: Int?
        var hstCents: Int?
        var subtotalCents: Int?
        var otherTaxCents: Int?
        var category: String?
        var paymentMethod: String?
        var notes: String?
    }

    /// The one form, whatever built it. A suggested value wins the
    /// prefill over the row's copy - the row's field values on a pending
    /// receipt are the capture-time heuristic snapshot, and the served
    /// merge supersedes them (§7.3) - with the row filling only fields no
    /// suggestion covers. Exactly the suggested fields start amber; the
    /// date is always amber (always prefilled - parsed, or the capture-day
    /// fallback, which is additionally called out).
    private init(
        receiptId: UUID?,
        currency: String,
        imageSource: ReceiptImageSource?,
        ocrFailureNote: String?,
        suggestions: ConfirmSuggestionSet?,
        existing: ExistingValues,
        saveAction: @escaping (ConfirmedReceiptFields) async throws -> Void
    ) {
        self.receiptId = receiptId
        self.currency = currency
        self.imageSource = imageSource
        self.ocrFailureNote = ocrFailureNote
        self.saveAction = saveAction

        totalText = (suggestions?.totalCents ?? existing.totalCents)
            .map(MoneyInput.text(fromCents:)) ?? ""
        // Parsed date, or the existing one (the row's, or the capture
        // day) - both through the same UTC-pinned round trip the picker
        // renders in.
        purchasedDate = ReceiptFormat.pickerDate(
            fromIso: suggestions?.purchasedAt ?? existing.purchasedAt
        ) ?? Date()
        vendorText = suggestions?.vendor ?? existing.vendor ?? ""
        hstText = (suggestions?.hstCents ?? existing.hstCents)
            .map(MoneyInput.text(fromCents:)) ?? ""
        subtotalText = (suggestions?.subtotalCents ?? existing.subtotalCents)
            .map(MoneyInput.text(fromCents:)) ?? ""
        otherTaxText = existing.otherTaxCents.map(MoneyInput.text(fromCents:)) ?? ""
        taxNumberText = suggestions?.vendorTaxNumber ?? existing.vendorTaxNumber ?? ""
        categoryText = existing.category ?? ""
        paymentMethodText = existing.paymentMethod ?? ""
        notesText = existing.notes ?? ""
        businessChoice = nil

        var unreviewed: Set<SuggestedField> = [.date]
        if let suggestions {
            if suggestions.totalCents != nil { unreviewed.insert(.total) }
            if suggestions.vendor != nil { unreviewed.insert(.vendor) }
            if suggestions.hstCents != nil { unreviewed.insert(.hst) }
            if suggestions.subtotalCents != nil { unreviewed.insert(.subtotal) }
            if suggestions.vendorTaxNumber != nil { unreviewed.insert(.taxNumber) }
            dateIsCaptureDayFallback = suggestions.purchasedAt == nil
            dateDisagreement = suggestions.dateDisagreement
        } else {
            // No suggestion set at all - a receipt neither parser ever
            // saw (pre-wave-4 rows): value-presence is the only proxy
            // left, and no fabrication claim is made about the date.
            if existing.totalCents != nil { unreviewed.insert(.total) }
            if existing.vendor != nil { unreviewed.insert(.vendor) }
            if existing.hstCents != nil { unreviewed.insert(.hst) }
            if existing.subtotalCents != nil { unreviewed.insert(.subtotal) }
            if existing.vendorTaxNumber != nil { unreviewed.insert(.taxNumber) }
            dateIsCaptureDayFallback = false
            dateDisagreement = false
        }
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

    /// The date-disagreement note (spec §7.2, §10A.1): shown while the
    /// date is still unreviewed, gone the moment it is touched - the
    /// amber and the note clear together, because touched means a human
    /// looked and decided. No separate dismissal, nothing persisted.
    var showsDateDisagreementNote: Bool {
        dateDisagreement && isUnreviewed(.date)
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
