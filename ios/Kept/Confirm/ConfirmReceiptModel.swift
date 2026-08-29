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
    /// Heuristic-only tip guess, same rule as every other amount here: no
    /// LLM fallthrough (§7.3, extended 2026-08-28). Deliberately no
    /// `otherFeesCents` counterpart - nothing ever suggests it (§6).
    let tipCents: Int?
    /// Both parsers read a date off the same text and they differ (§7.3).
    /// Only the server merge can raise this.
    let dateDisagreement: Bool
    /// Both parsers produced an HST value and it differs (§7.3, added
    /// 2026-08-28). Only the server merge can raise this - the served
    /// `hstCents` value is unchanged, heuristic-only either way.
    let hstDisagreement: Bool

    init(merged: MergedSuggestions) {
        vendor = merged.vendor.value
        purchasedAt = merged.purchasedAt.value
        totalCents = merged.totalCents.value
        hstCents = merged.hstCents.value
        subtotalCents = merged.subtotalCents.value
        tipCents = merged.tipCents.value
        dateDisagreement = merged.purchasedAt.disagreement
        hstDisagreement = merged.hstCents.disagreement
    }

    init(parse: ReceiptSuggestions) {
        vendor = parse.vendor
        purchasedAt = parse.purchasedAt
        totalCents = parse.totalCents
        hstCents = parse.hstCents
        subtotalCents = parse.subtotalCents
        tipCents = parse.tipCents
        dateDisagreement = false
        // The on-device parse alone has no LLM counterpart to disagree
        // with - only the server merge can raise this flag.
        hstDisagreement = false
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
/// - save is disabled until there is a valid total, with the reason
///   stated;
/// - a valid save hands the confirmed fields to whichever save path built
///   this model: a PATCH with status=confirmed for a server-side pending
///   receipt (the queue and the detail screen), or a durable outbox write
///   for a capture confirmed on the spot (wave-5 gate ratification) - the
///   form neither knows nor cares, which is what keeps the two paths one
///   screen.
@MainActor
final class ConfirmReceiptModel: ObservableObject, Identifiable {
    /// Why this form is open. The one difference between the two: an edit
    /// shows a person their own confirmed values back, so nothing on it is
    /// a machine suggestion and nothing starts amber (2026-08-26 field
    /// reduction: confirmed receipts became editable).
    enum Purpose: Equatable {
        case confirm
        case edit
    }

    /// The fields that can carry an amber "unreviewed suggestion" marking.
    /// Originally exactly the fields an OCR/LLM suggestion could prefill;
    /// widened 2026-08-28 to `otherFees`, `category` and `paymentMethod`,
    /// which now carry the SAME marking from a different source - a
    /// proposal #1 derived-amount fill (`otherFees`) or a proposal #2
    /// vendor default (`category`, `paymentMethod`) - never from a parser.
    /// §10A.1's rule was always general ("every prefilled field is
    /// visually marked as a suggestion until touched"), not OCR-specific;
    /// this enum just catches up to that. None of the three ever starts
    /// amber at construction (unlike the original six, `otherFees`
    /// included: §6, no heuristic or LLM can match a residual with no
    /// consistent printed label) - they can only ever be inserted into
    /// `unreviewedFields` later, by `applyDerivedFill()`,
    /// `applyReconciliationDifference(into:)` or
    /// `applyVendorDefaultIfAvailable(_:)`.
    enum SuggestedField: CaseIterable {
        case total, date, vendor, hst, subtotal, tip
        case otherFees, category, paymentMethod

        /// The server's field name for this suggestion (EventField,
        /// EventVocabulary.swift) - used only by the telemetry layer
        /// (suggestionOutcomes()); the form itself has no other reason to
        /// know the wire vocabulary.
        var eventField: EventField {
            switch self {
            case .total: return .total
            case .date: return .purchasedAt
            case .vendor: return .vendor
            case .hst: return .hst
            case .subtotal: return .subtotal
            case .tip: return .tip
            case .otherFees: return .otherFees
            case .category: return .category
            case .paymentMethod: return .paymentMethod
            }
        }
    }

    /// Every field on the form that raises a keyboard, which the view's
    /// focus runs on instead of SuggestedField. The keyboard toolbar has
    /// to know which keyboard is up before it can offer a way out of it,
    /// so fields carrying no suggestion still need a focus value. The date
    /// is deliberately absent: a DatePicker raises no keyboard.
    enum EditableField: Hashable, CaseIterable {
        case total, vendor, hst, subtotal, tip, otherFees
        case category, paymentMethod, notes

        /// The money fields, which take a decimal pad.
        var usesDecimalPad: Bool {
            switch self {
            case .total, .hst, .subtotal, .tip, .otherFees:
                return true
            case .vendor, .category, .paymentMethod, .notes:
                return false
            }
        }

        /// The suggestion this field carries, if any. Focusing a field is
        /// looking at it, which clears that amber permanently (§10A.1).
        /// `otherFees`, `category` and `paymentMethod` map to their own
        /// SuggestedField cases too (2026-08-28): none of the three ever
        /// starts amber from a parser, but each can gain the marking
        /// later - `otherFees` from a proposal #1 derived fill, the other
        /// two from a proposal #2 vendor default - and this is the same
        /// focus-clears-it wiring every other suggested field already
        /// gets, not a new mechanism. `notes` remains the one field with
        /// no suggestion of any kind.
        var suggestion: SuggestedField? {
            switch self {
            case .total: return .total
            case .vendor: return .vendor
            case .hst: return .hst
            case .subtotal: return .subtotal
            case .tip: return .tip
            case .otherFees: return .otherFees
            case .category: return .category
            case .paymentMethod: return .paymentMethod
            case .notes: return nil
            }
        }

        /// The server's field name for this text field (EventField,
        /// EventVocabulary.swift) - used only by field-edit counting
        /// below.
        var eventField: EventField {
            switch self {
            case .total: return .total
            case .vendor: return .vendor
            case .hst: return .hst
            case .subtotal: return .subtotal
            case .tip: return .tip
            case .otherFees: return .otherFees
            case .category: return .category
            case .paymentMethod: return .paymentMethod
            case .notes: return .notes
            }
        }
    }

    /// The server-side receipt this form edits, when there is one; nil for
    /// a capture being confirmed before it has uploaded.
    let receiptId: UUID?
    let currency: String
    let purpose: Purpose
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
    @Published var tipText: String
    @Published var otherFeesText: String
    @Published var categoryText: String
    @Published var paymentMethodText: String
    @Published var notesText: String

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
    /// §7.3: the injected suggestion set says both parsers produced an HST
    /// value and it differs (added 2026-08-28). Same shape as
    /// dateDisagreement - constant for the form's life, read through
    /// showsHstDisagreementNote.
    private let hstDisagreement: Bool

    // MARK: - Suggestion-outcome snapshot (behavioural telemetry, 2026-08-28)
    //
    // What each field was (most recently) suggested to be, captured at
    // open and, for the three fields added 2026-08-28
    // (otherFees/category/paymentMethod), also updated whenever a LIVE
    // suggestion source fills them - suggestionOutcomes() compares the
    // final, saved value against whichever of these it last recorded to
    // say accepted vs overridden. `suggestedFields` is `unreviewedFields`'s
    // starting value at open, but unlike `unreviewedFields` it is not a
    // pure snapshot: `markAsMachineSuggested(_:)` below adds to it after
    // construction too, so a field that only ever became a suggestion
    // later (a derived fill, a reconciliation split, a vendor default)
    // still gets its accepted/overridden outcome reported at save through
    // this identical mechanism - one save-time telemetry path for every
    // kind of suggestion this screen can offer, rather than the newer
    // three each inventing their own "was it accepted" question.
    private var suggestedFields: Set<SuggestedField>
    private var initialSuggestedTotalCents: Int?
    private let initialSuggestedVendor: String?
    private var initialSuggestedHstCents: Int?
    private var initialSuggestedSubtotalCents: Int?
    private var initialSuggestedTipCents: Int?
    /// No construction-time value: `otherFees` never carries a suggestion
    /// at open (§6) - only `applyDerivedFill()` ever sets this, at the
    /// moment it fills the field.
    private var initialSuggestedOtherFeesCents: Int?
    private let initialSuggestedPurchasedAtIso: String
    /// Set only by `applyVendorDefaultIfAvailable(_:)` (proposal #2) -
    /// nil until a default is actually applied, since category never
    /// carries a suggestion at construction.
    private var initialSuggestedCategory: String?
    /// Same shape as `initialSuggestedCategory`, for payment method.
    private var initialSuggestedPaymentMethod: String?

    // MARK: - Field-edit counting (behavioural telemetry, 2026-08-28)

    /// Per-field edit counts this confirm session, reported at save as
    /// `field_edited` events with `count` - The owner's ask: "a user editing
    /// the total amount repeatedly signals the total-extraction path is
    /// unreliable." An "edit" is counted once per focus-in/focus-out cycle
    /// whose value actually changed (fieldDidGainFocus/fieldDidLoseFocus
    /// below) - never once per keystroke, which would turn typing
    /// "113.00" into three edits of its own. The date field raises no
    /// keyboard and so has no focus cycle; recordDateEdited() counts each
    /// DatePicker change directly instead, which is already as coarse as
    /// a text field's focus cycle.
    private(set) var fieldEditCounts: [EventField: Int] = [:]

    /// What a text field held the moment it last gained focus - lets
    /// losing focus tell "the value changed" from "the person only
    /// looked", the same distinction §10A.1's amber-clearing already
    /// draws for suggestions, applied here to counting instead.
    private var focusSnapshots: [EditableField: String] = [:]

    /// Where the confirmed fields go on save. Injected by whoever built
    /// the model; the form's rules above are identical either way.
    private let saveAction: (ConfirmedReceiptFields) async throws -> Void

    // MARK: - Possible duplicates (proposal #8, 2026-08-28)

    /// GET /api/receipts/possible-duplicates's matches for whatever the
    /// form's date/vendor/total last held, from the most recent completed
    /// lookup - never awaited by Save (`checkForPossibleDuplicates()`'s own
    /// comment states the fire-and-forget contract in full).
    @Published private(set) var possibleDuplicates: [Receipt] = []
    /// The lookup itself, injected the same way `saveAction` is so this
    /// model still holds no stored `KeptAPI` reference of its own - only a
    /// server-backed form (the `api:` convenience init below) wires this;
    /// a capture-time confirm has no server row to compare against yet and
    /// leaves it nil, which makes `checkForPossibleDuplicates()` a no-op.
    /// Swallows its own failure into an empty array (see that init) so
    /// this model never has to distinguish "nothing matched" from "the
    /// request failed" - both read the same way, silently, per the
    /// proposal's own rule.
    private let duplicateCheckAction: ((_ purchasedAt: String, _ totalCents: Int, _ vendor: String?) async -> [Receipt])?
    /// Guards a slow response against landing after a newer one already
    /// superseded it - GuardedReceiptLoader's generation-counter shape,
    /// done inline here because this is the only network call this model
    /// ever makes on its own.
    private var duplicateCheckGeneration = 0

    // MARK: - Construction

    /// A server-side receipt: the confirm queue and the detail screen's
    /// "Confirm this receipt" open it with `.confirm`, where the
    /// suggestion set is the §7.3 merge the API serves on every receipt -
    /// both parsers, merged by the domain layer; this client renders,
    /// never decides (spec §4.1). The detail screen's "Edit receipt" on an
    /// already-confirmed row opens it with `.edit`, where the row's values
    /// are the human's own and no suggestion set applies at all. Either
    /// way save PATCHes the receipt confirmed.
    convenience init(api: any KeptAPI, detail: ReceiptDetail, purpose: Purpose = .confirm) {
        let receipt = detail.receipt
        let id = receipt.id
        self.init(
            receiptId: id,
            currency: receipt.currency,
            purpose: purpose,
            imageSource: detail.images.first.map { .remote($0.downloadUrl) },
            ocrFailureNote: nil,
            // An edit prefills from the row alone: the merge is still
            // served on confirmed receipts (the accuracy set needs it) and
            // would otherwise overwrite what the person confirmed.
            suggestions: purpose == .edit
                ? nil
                : receipt.suggestions.map(ConfirmSuggestionSet.init(merged:)),
            existing: ExistingValues(
                purchasedAt: receipt.purchasedAt,
                vendor: receipt.vendor,
                totalCents: receipt.totalCents,
                hstCents: receipt.hstCents,
                subtotalCents: receipt.subtotalCents,
                tipCents: receipt.tipCents,
                otherFeesCents: receipt.otherFeesCents,
                category: receipt.category,
                paymentMethod: receipt.paymentMethod,
                notes: receipt.notes
            ),
            saveAction: { fields in
                _ = try await api.confirmReceipt(id: id, ConfirmReceiptRequest(fields))
            },
            // Proposal #8: `excludeId: id` is what keeps this receipt from
            // matching itself - the obvious bug the proposal calls out by
            // name. `try?` is the whole failure story: a thrown error
            // becomes an empty result, exactly as silent as "nothing
            // matched" (this model's own doc comment above states why that
            // conflation is intentional, not a shortcut).
            duplicateCheckAction: { purchasedAt, totalCents, vendor in
                (try? await api.possibleDuplicates(
                    purchasedAt: purchasedAt,
                    totalCents: totalCents,
                    vendor: vendor,
                    excludeId: id
                )) ?? []
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
            purpose: .confirm,
            imageSource: .local(draft.imageData),
            ocrFailureNote: draft.ocrFailureNote,
            suggestions: ConfirmSuggestionSet(parse: draft.suggestions),
            existing: ExistingValues(
                purchasedAt: ReceiptFormat.calendarDate(of: draft.capturedAt)
            ),
            saveAction: saveAction,
            // No server row exists yet to compare against (this receipt
            // has not uploaded), and the single-capture flow is
            // deliberately offline by design (CaptureFlowModel's own doc
            // comment: "nothing here ever waits on the network") - the
            // proposal's own "why" names the backlog pass, worked down
            // through the confirm QUEUE, as where this actually bites, not
            // the in-the-moment single scan. nil makes
            // checkForPossibleDuplicates() a no-op.
            duplicateCheckAction: nil
        )
    }

    /// The values already on the record before any suggestion applies:
    /// the server row's fields for a stored receipt, or - capture-time -
    /// nothing but the capture day. A value only here was written by
    /// something other than a parser, so it prefills without amber.
    private struct ExistingValues {
        var purchasedAt: String
        var vendor: String?
        var totalCents: Int?
        var hstCents: Int?
        var subtotalCents: Int?
        var tipCents: Int?
        /// No suggestion ever covers this field (§6), so it has no
        /// counterpart in ConfirmSuggestionSet - the row's own value,
        /// here, is the only source the form ever prefills it from.
        var otherFeesCents: Int?
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
        purpose: Purpose,
        imageSource: ReceiptImageSource?,
        ocrFailureNote: String?,
        suggestions: ConfirmSuggestionSet?,
        existing: ExistingValues,
        saveAction: @escaping (ConfirmedReceiptFields) async throws -> Void,
        duplicateCheckAction: ((_ purchasedAt: String, _ totalCents: Int, _ vendor: String?) async -> [Receipt])?
    ) {
        self.receiptId = receiptId
        self.currency = currency
        self.purpose = purpose
        self.imageSource = imageSource
        self.ocrFailureNote = ocrFailureNote
        self.saveAction = saveAction
        self.duplicateCheckAction = duplicateCheckAction

        // Each "seed" is exactly what prefills the field (suggestion over
        // the row's own copy) - captured here, once, so it can also seed
        // the suggestion-outcome snapshot below without recomputing the
        // same expression twice and risking the two drifting apart.
        let seedTotalCents = suggestions?.totalCents ?? existing.totalCents
        totalText = seedTotalCents.map(MoneyInput.text(fromCents:)) ?? ""
        // Parsed date, or the existing one (the row's, or the capture
        // day) - both through the same UTC-pinned round trip the picker
        // renders in.
        let seedPurchasedAtIso = suggestions?.purchasedAt ?? existing.purchasedAt
        purchasedDate = ReceiptFormat.pickerDate(fromIso: seedPurchasedAtIso) ?? Date()
        let seedVendor = suggestions?.vendor ?? existing.vendor
        vendorText = seedVendor ?? ""
        let seedHstCents = suggestions?.hstCents ?? existing.hstCents
        hstText = seedHstCents.map(MoneyInput.text(fromCents:)) ?? ""
        let seedSubtotalCents = suggestions?.subtotalCents ?? existing.subtotalCents
        subtotalText = seedSubtotalCents.map(MoneyInput.text(fromCents:)) ?? ""
        let seedTipCents = suggestions?.tipCents ?? existing.tipCents
        tipText = seedTipCents.map(MoneyInput.text(fromCents:)) ?? ""
        // No suggestion source exists for other fees (§6) - the row's own
        // value is the only thing that can ever prefill it.
        otherFeesText = existing.otherFeesCents
            .map(MoneyInput.text(fromCents:)) ?? ""
        categoryText = existing.category ?? ""
        paymentMethodText = existing.paymentMethod ?? ""
        notesText = existing.notes ?? ""

        initialSuggestedTotalCents = seedTotalCents
        initialSuggestedVendor = seedVendor
        initialSuggestedHstCents = seedHstCents
        initialSuggestedSubtotalCents = seedSubtotalCents
        initialSuggestedTipCents = seedTipCents
        initialSuggestedPurchasedAtIso = seedPurchasedAtIso

        switch purpose {
        case .edit:
            // Every value on screen is the human's own, already confirmed
            // once. Nothing here is a machine suggestion, so nothing is
            // amber and nothing claims a fabricated date.
            unreviewedFields = []
            suggestedFields = []
            dateIsCaptureDayFallback = false
            dateDisagreement = false
            hstDisagreement = false
        case .confirm:
            var unreviewed: Set<SuggestedField> = [.date]
            if let suggestions {
                if suggestions.totalCents != nil { unreviewed.insert(.total) }
                if suggestions.vendor != nil { unreviewed.insert(.vendor) }
                if suggestions.hstCents != nil { unreviewed.insert(.hst) }
                if suggestions.subtotalCents != nil { unreviewed.insert(.subtotal) }
                if suggestions.tipCents != nil { unreviewed.insert(.tip) }
                dateIsCaptureDayFallback = suggestions.purchasedAt == nil
                dateDisagreement = suggestions.dateDisagreement
                hstDisagreement = suggestions.hstDisagreement
            } else {
                // No suggestion set at all - a receipt neither parser ever
                // saw (pre-wave-4 rows): value-presence is the only proxy
                // left, and no fabrication claim is made about the date.
                if existing.totalCents != nil { unreviewed.insert(.total) }
                if existing.vendor != nil { unreviewed.insert(.vendor) }
                if existing.hstCents != nil { unreviewed.insert(.hst) }
                if existing.subtotalCents != nil { unreviewed.insert(.subtotal) }
                if existing.tipCents != nil { unreviewed.insert(.tip) }
                dateIsCaptureDayFallback = false
                dateDisagreement = false
                hstDisagreement = false
            }
            unreviewedFields = unreviewed
            suggestedFields = unreviewed
        }
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

    /// The navigation title: the unreviewed counter while confirming -
    /// the whole point of the screen - and a plain name while editing,
    /// where there is nothing machine-suggested left to count.
    var screenTitle: String {
        switch purpose {
        case .edit:
            return "Edit receipt"
        case .confirm:
            return unreviewedCount == 0 ? "All checked" : "\(unreviewedCount) to check"
        }
    }

    /// The way out without saving. "Later" while confirming means the
    /// receipt stays pending and the badge keeps nagging (§5.2a); on an
    /// already-confirmed receipt nothing is left over, so it is a cancel.
    var dismissLabel: String {
        switch purpose {
        case .edit: return "Cancel"
        case .confirm: return "Later"
        }
    }

    /// The date-disagreement note (spec §7.2, §10A.1): shown while the
    /// date is still unreviewed, gone the moment it is touched - the
    /// amber and the note clear together, because touched means a human
    /// looked and decided. No separate dismissal, nothing persisted.
    var showsDateDisagreementNote: Bool {
        dateDisagreement && isUnreviewed(.date)
    }

    /// The HST-disagreement note (§7.3, 2026-08-28): same rule as the
    /// date's - shown while HST is still unreviewed, gone the moment it is
    /// touched, no separate dismissal.
    var showsHstDisagreementNote: Bool {
        hstDisagreement && isUnreviewed(.hst)
    }

    /// The HST rate-plausibility hint (proposal #7, 2026-08-28) - the live
    /// mirror of the server's `checkHstRatePlausibility`
    /// (ReceiptArithmetic.swift carries the full reasoning for the ±0.25pp
    /// band and why it must never widen). Tied to the SAME amber/touched
    /// lifecycle `showsHstDisagreementNote` above already uses: shown
    /// while HST is still unreviewed, gone the moment it is touched
    /// (§10A.1's "cleared with the amber") - a person who has just looked
    /// at the field has had their look. `centsOrNil` reads `.invalid` text
    /// as absent, the same suppression `showsArithmeticWarning` already
    /// applies to garbage input, so this never fires over unparseable
    /// text.
    var showsHstRateHint: Bool {
        isUnreviewed(.hst)
            && ReceiptArithmetic.checkHstRatePlausibility(
                subtotalCents: centsOrNil(subtotalInput),
                hstCents: centsOrNil(hstInput)
            ) == .looksLikeHalfSplit
    }

    // MARK: - Suggestion outcomes (behavioural telemetry, 2026-08-28)

    /// `suggestion_accepted` vs `suggestion_overridden`, one entry per
    /// field that carried a suggestion this session - derived from state
    /// the form already keeps, not tracked separately. "Accepted" means
    /// the field's final value matches what it was (most recently)
    /// suggested to be; "overridden" means it does not - regardless of
    /// whether the person ever focused the field, because leaving a
    /// correct suggestion alone untouched is exactly what "accepted"
    /// means. Covers every source of a suggestion this screen can offer,
    /// not only the OCR/LLM merge at open: `otherFees` reports here the
    /// moment a proposal #1 derived fill or reconciliation split has
    /// touched it, and `category`/`paymentMethod` report here once a
    /// proposal #2 vendor default has (`suggestedFields`,
    /// `markAsMachineSuggested(_:)`). `.edit` can report a nonempty list
    /// too, unlike before 2026-08-28 - nothing on that form is a parser
    /// suggestion, but a derived fill or a vendor default can still apply
    /// to it (both are explicitly extended to the edit form - see each
    /// method's own doc comment), and whichever field that touches
    /// becomes exactly as reportable as it would be while confirming.
    func suggestionOutcomes() -> [(field: EventField, accepted: Bool)] {
        SuggestedField.allCases.compactMap { field in
            guard suggestedFields.contains(field) else { return nil }
            return (field.eventField, isSuggestionAccepted(field))
        }
    }

    private func isSuggestionAccepted(_ field: SuggestedField) -> Bool {
        switch field {
        case .total: return matchesInitial(initialSuggestedTotalCents, totalInput)
        case .vendor: return normalized(vendorText) == initialSuggestedVendor
        case .hst: return matchesInitial(initialSuggestedHstCents, hstInput)
        case .subtotal: return matchesInitial(initialSuggestedSubtotalCents, subtotalInput)
        case .tip: return matchesInitial(initialSuggestedTipCents, tipInput)
        case .otherFees: return matchesInitial(initialSuggestedOtherFeesCents, otherFeesInput)
        case .date: return ReceiptFormat.isoDate(fromPicker: purchasedDate) == initialSuggestedPurchasedAtIso
        case .category: return normalized(categoryText) == initialSuggestedCategory
        case .paymentMethod: return normalized(paymentMethodText) == initialSuggestedPaymentMethod
        }
    }

    /// The bookkeeping every LIVE suggestion source added 2026-08-28 shares
    /// - amber until touched (`unreviewedFields`, exactly the construction-
    /// time rule) and enrolled in the save-time accept/override report
    /// above (`suggestedFields`). Callers set the matching
    /// `initialSuggested*` storage themselves, immediately before calling
    /// this, since the type differs per field (Int? for the money fields,
    /// String? for category and payment method) and a generic setter here
    /// would need to know which one anyway.
    private func markAsMachineSuggested(_ field: SuggestedField) {
        suggestedFields.insert(field)
        unreviewedFields.insert(field)
    }

    /// A suggested amount is "accepted" when the field still parses to
    /// exactly the cents it was prefilled with - nil-safe both ways, so a
    /// suggestion of "nothing found" that stays blank still counts as
    /// accepted, and one the person cleared out (now `.empty`) counts as
    /// overridden.
    private func matchesInitial(_ initialCents: Int?, _ current: MoneyInput) -> Bool {
        switch current {
        case .cents(let value): return value == initialCents
        case .empty: return initialCents == nil
        case .invalid: return false
        }
    }

    // MARK: - Field-edit counting (behavioural telemetry, 2026-08-28)

    /// Call when a text field gains keyboard focus - the view's
    /// `.onChange(of: focusedField)` (already wired for the amber rule)
    /// is where this is called from.
    func fieldDidGainFocus(_ field: EditableField) {
        focusSnapshots[field] = currentText(for: field)
    }

    /// Call when a text field loses keyboard focus. Counts one edit only
    /// when the text actually changed since the matching gain-focus call;
    /// a field with no snapshot (it never gained focus through this pair)
    /// counts nothing, which is the conservative, correct default.
    func fieldDidLoseFocus(_ field: EditableField) {
        defer { focusSnapshots[field] = nil }
        guard let snapshot = focusSnapshots[field], snapshot != currentText(for: field) else { return }
        fieldEditCounts[field.eventField, default: 0] += 1
    }

    /// The date field's own edit counter - a DatePicker raises no keyboard
    /// and so has no focus-in/focus-out pair; each committed change is
    /// already as coarse as a text field's focus cycle (one pick, not one
    /// keystroke), so every call counts directly.
    func recordDateEdited() {
        fieldEditCounts[.purchasedAt, default: 0] += 1
    }

    private func currentText(for field: EditableField) -> String {
        switch field {
        case .total: return totalText
        case .vendor: return vendorText
        case .hst: return hstText
        case .subtotal: return subtotalText
        case .tip: return tipText
        case .otherFees: return otherFeesText
        case .category: return categoryText
        case .paymentMethod: return paymentMethodText
        case .notes: return notesText
        }
    }

    // MARK: - Money

    var totalInput: MoneyInput { MoneyInput.parse(totalText) }
    var hstInput: MoneyInput { MoneyInput.parse(hstText) }
    var subtotalInput: MoneyInput { MoneyInput.parse(subtotalText) }
    var tipInput: MoneyInput { MoneyInput.parse(tipText) }
    var otherFeesInput: MoneyInput { MoneyInput.parse(otherFeesText) }

    /// The §7.2 inline check, restored to four components (2026-08-28):
    /// does subtotal + HST + tip + other fees reach the total? The
    /// 2026-08-26 field reduction dropped `other_tax` and knowingly gave
    /// up exactly this reconciliation for a tipped or foreign receipt -
    /// "the warning is a prompt to look, not a rule, and that is it
    /// working" - on the stated trade that no field existed to hold those
    /// amounts. Splitting tip and other fees back out as their own fields
    /// restores the check rather than reinventing it: a nil field still
    /// contributes zero exactly as hstCents already did, so a restaurant
    /// receipt with subtotal + HST + tip = total now reconciles instead
    /// of warning. Only when there is a subtotal and a total to compare -
    /// receipts with neither have nothing to reconcile - and never
    /// blocking, because plenty of legitimate receipts still won't.
    var showsArithmeticWarning: Bool {
        guard
            case .cents(let total) = totalInput,
            case .cents(let subtotal) = subtotalInput,
            let hst = centsOrZero(hstInput),
            let tip = centsOrZero(tipInput),
            let otherFees = centsOrZero(otherFeesInput)
        else {
            // An invalid amount is its own stated problem; warning about
            // arithmetic over garbage would just be noise.
            return false
        }
        return subtotal + hst + tip + otherFees != total
    }

    /// nil for invalid text, 0 for blank - blank means "no such charge".
    private func centsOrZero(_ input: MoneyInput) -> Int? {
        switch input {
        case .empty: return 0
        case .cents(let value): return value
        case .invalid: return nil
        }
    }

    // MARK: - Derived amounts (proposal #1, 2026-08-28)
    //
    // The confirm screen's own mirror of the server's `deriveMissingAmount`
    // (ReceiptArithmetic.swift carries the full reasoning for why this is
    // the root CLAUDE.md's one standing live-arithmetic exception, not a
    // new domain rule). Nothing here writes to a field on its own -
    // `derivableFill`/`reconciliationResult(for:)` only compute what
    // COULD be offered; `applyDerivedFill()` and
    // `applyReconciliationDifference(into:)` are the only things that
    // apply one, and only on an explicit tap the view wires to a button
    // (spec: "never applied automatically, never on save").

    /// Every one of the five money fields as `ReceiptArithmetic` expects
    /// them: nil for blank, the parsed cents for anything else. `nil` as
    /// the WHOLE tuple - not per field - whenever any one of the five is
    /// `.invalid` text: an invalid amount is its own stated problem
    /// (`showsArithmeticWarning` already suppresses itself the identical
    /// way), and offering a derived fill "over" unparseable text would be
    /// guessing at what the person meant to type rather than reading what
    /// is actually there.
    private var moneyFieldValues: (subtotal: Int?, hst: Int?, tip: Int?, otherFees: Int?, total: Int?)? {
        if subtotalInput == .invalid || hstInput == .invalid || tipInput == .invalid
            || otherFeesInput == .invalid || totalInput == .invalid {
            return nil
        }
        func cents(_ input: MoneyInput) -> Int? {
            if case .cents(let value) = input { return value }
            return nil
        }
        return (cents(subtotalInput), cents(hstInput), cents(tipInput), cents(otherFeesInput), cents(totalInput))
    }

    /// The one-tap-fill affordance: non-nil exactly when one of the five
    /// money fields is blank and the other four are valid amounts.
    /// `nil` field-invalid text aside, this is mutually exclusive with
    /// `reconciliationDifference` below by construction - one is "exactly
    /// one field missing", the other is "zero fields missing" - so the
    /// view never has both a fill button and a reconciliation button for
    /// the same state.
    var derivableFill: DerivedAmount? {
        guard let fields = moneyFieldValues else { return nil }
        return ReceiptArithmetic.deriveMissingAmount(
            subtotalCents: fields.subtotal,
            hstCents: fields.hst,
            tipCents: fields.tip,
            otherFeesCents: fields.otherFees,
            totalCents: fields.total
        )
    }

    /// The proposal's own labelling requirement: "Tip = total − subtotal −
    /// HST − fees", not a bare button - the risk it names by name is
    /// someone tapping without reading and storing an amount the paper
    /// does not print. Generated from which field `derivableFill` is
    /// solving for, so the five labels cannot drift from
    /// `ReceiptArithmetic`'s own five fields the way a hand-maintained
    /// switch elsewhere in this screen already warns against (SuggestedField's
    /// own history).
    var derivableFillLabel: String? {
        guard let derived = derivableFill else { return nil }
        let amount = ReceiptFormat.money(cents: derived.cents, currency: currency)
        switch derived.field {
        case .subtotal: return "Subtotal = Total − HST − Tip − Other fees (\(amount))"
        case .hst: return "HST = Total − Subtotal − Tip − Other fees (\(amount))"
        case .tip: return "Tip = Total − Subtotal − HST − Other fees (\(amount))"
        case .otherFees: return "Other fees = Total − Subtotal − HST − Tip (\(amount))"
        case .total: return "Total = Subtotal + HST + Tip + Other fees (\(amount))"
        }
    }

    /// Applies the one-tap fill: sets the derived field's text and marks
    /// it amber, exactly like an OCR suggestion (spec: "the filled value
    /// goes amber and stays amber... never applied automatically, never on
    /// save"). Works identically on `.edit` (deliberately: editing after
    /// confirmation is a stated feature the proposal names by name, "not
    /// just the confirm screen") - `applyMachineSuggestedAmount` does not
    /// branch on `purpose`, so a fill on an edit form is amber and
    /// reportable exactly the way one during confirm is.
    @discardableResult
    func applyDerivedFill() -> Bool {
        guard let derived = derivableFill else { return false }
        applyMachineSuggestedAmount(derived.field, cents: derived.cents)
        return true
    }

    /// The second affordance: which of tip or other fees the reconciliation
    /// difference could go into. Non-nil only when all five fields are
    /// filled in (see `moneyFieldValues`) and they do not reconcile - the
    /// restaurant case, where the likely explanation is a tip or a fee
    /// nobody entered yet.
    private var reconciliationDifference: Int? {
        guard let fields = moneyFieldValues,
              let subtotal = fields.subtotal, let hst = fields.hst,
              let tip = fields.tip, let otherFees = fields.otherFees,
              let total = fields.total
        else { return nil }
        return ReceiptArithmetic.reconciliationDifference(
            subtotalCents: subtotal, hstCents: hst, tipCents: tip,
            otherFeesCents: otherFees, totalCents: total
        )
    }

    /// Which of tip or other fees the reconciliation difference can go
    /// into, named by the destination the button offers - `total` is
    /// deliberately not a case here: the proposal names only tip and other
    /// fees ("the usual cause on a restaurant bill"), and total is never
    /// the field a mismatch should be blamed on.
    enum ReconciliationTarget {
        case tip, otherFees

        /// The corresponding DerivableMoneyField, so
        /// `applyReconciliationDifference(into:)` can share
        /// `applyMachineSuggestedAmount(_:cents:)` with `applyDerivedFill()`
        /// rather than repeating its bookkeeping.
        var derivableField: DerivableMoneyField {
            switch self {
            case .tip: return .tip
            case .otherFees: return .otherFees
            }
        }
    }

    /// The resulting value at `target` if the reconciliation difference
    /// were added to whatever it already holds - or nil, refusing the
    /// offer, when that would leave the field negative. Mirrors
    /// `deriveMissingAmount`'s own never-negative refusal for tip and
    /// other fees (ReceiptArithmetic.swift's doc comment states the
    /// reasoning in full): there is no such thing as a negative tip or a
    /// rebate filed as an "other fee" on any receipt this app has ever
    /// seen, so a fill that would produce one is refused rather than
    /// offered, even though this affordance - unlike `deriveMissingAmount`
    /// - has no server function to mirror that refusal FROM.
    func reconciliationResult(for target: ReconciliationTarget) -> Int? {
        guard let difference = reconciliationDifference else { return nil }
        let current: Int
        switch target {
        case .tip: current = centsOrNil(tipInput) ?? 0
        case .otherFees: current = centsOrNil(otherFeesInput) ?? 0
        }
        let result = current + difference
        return result >= 0 ? result : nil
    }

    /// The reconciliation buttons' own label, same reasoning as
    /// `derivableFillLabel`: named, not bare, so the risk the proposal
    /// names - tapping without reading - has something concrete to read.
    func reconciliationLabel(for target: ReconciliationTarget) -> String? {
        guard let result = reconciliationResult(for: target) else { return nil }
        let amount = ReceiptFormat.money(cents: result, currency: currency)
        switch target {
        case .tip: return "Put the difference in Tip (\(amount))"
        case .otherFees: return "Put the difference in Other fees (\(amount))"
        }
    }

    /// Applies the reconciliation difference to whichever target was
    /// tapped - same amber treatment, same save-time accept/override
    /// reporting as `applyDerivedFill()` above, and the identical
    /// `.edit`-works-too behaviour.
    @discardableResult
    func applyReconciliationDifference(into target: ReconciliationTarget) -> Bool {
        guard let result = reconciliationResult(for: target) else { return false }
        applyMachineSuggestedAmount(target.derivableField, cents: result)
        return true
    }

    /// Shared by `applyDerivedFill()` and
    /// `applyReconciliationDifference(into:)`: writes `cents` into
    /// `field`'s text, records it as this session's suggestion baseline
    /// for the save-time accept/override report (`suggestionOutcomes()`),
    /// and marks the field amber - the one place "applying a suggested
    /// amount" is defined, so the two callers cannot drift on what it
    /// means.
    private func applyMachineSuggestedAmount(_ field: DerivableMoneyField, cents: Int) {
        let text = MoneyInput.text(fromCents: cents)
        switch field {
        case .subtotal:
            subtotalText = text
            initialSuggestedSubtotalCents = cents
        case .hst:
            hstText = text
            initialSuggestedHstCents = cents
        case .tip:
            tipText = text
            initialSuggestedTipCents = cents
        case .otherFees:
            otherFeesText = text
            initialSuggestedOtherFeesCents = cents
        case .total:
            totalText = text
            initialSuggestedTotalCents = cents
        }
        markAsMachineSuggested(field.suggestedField)
    }

    // MARK: - Vendor defaults (proposal #2, 2026-08-28)

    /// Prefills category and payment method from the vendor's own
    /// remembered defaults (GET /api/receipts/options's `vendorDefaults`,
    /// APIModels.swift) - amber, editable, and NEVER over what the person
    /// already typed (checked per field, independently: a vendor whose
    /// remembered category the person already typed over still offers its
    /// payment method). Exact, unnormalized match against `vendorText` -
    /// the 2026-08-26 ruling that these are the person's own free-text
    /// values, never rewritten, extends to the lookup key too.
    ///
    /// Deliberately does NOT take a `ReceiptOptionsStore` - this model
    /// stays network-free and simulator-testable (spec §10.2), so the
    /// view hands in only the small lookup this needs, whenever the
    /// vendor text or the options fetch changes (ConfirmReceiptView's
    /// `onAppear`/`onChange` wiring). Idempotent and safe to call
    /// repeatedly: every write here is guarded by the target field still
    /// being blank, so calling this again after it already filled
    /// something changes nothing.
    ///
    /// Works on `.edit` too, on the same reasoning `applyDerivedFill()`
    /// states: a confirmed receipt whose category was genuinely left blank
    /// is not "a confirmed receipt's existing value" being overwritten -
    /// there is no existing value - and the blank-field guard is exactly
    /// what "never overwrite a confirmed receipt's existing values" means
    /// in code.
    ///
    /// Why category is defensible to prefill here where an amount would
    /// not be: category is free text with no tax consequence (root
    /// CLAUDE.md's own category rule), so a wrong default costs a
    /// mislabelled row an accountant re-reads. HST is an input tax credit -
    /// getting it wrong costs a wrong claim - which is exactly why
    /// `deriveMissingAmount` (arithmetic.ts) is choosy about what it will
    /// derive and this function is not. Payment method rides the identical
    /// reasoning: a chosen label, not a tax figure.
    func applyVendorDefaultIfAvailable(_ vendorDefaults: [String: VendorDefault]) {
        guard !vendorText.isEmpty, let match = vendorDefaults[vendorText] else { return }
        if isBlank(categoryText), let category = match.category, !category.isEmpty {
            categoryText = category
            initialSuggestedCategory = category
            markAsMachineSuggested(.category)
        }
        if isBlank(paymentMethodText), let paymentMethod = match.paymentMethod, !paymentMethod.isEmpty {
            paymentMethodText = paymentMethod
            initialSuggestedPaymentMethod = paymentMethod
            markAsMachineSuggested(.paymentMethod)
        }
    }

    private func isBlank(_ text: String) -> Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // MARK: - Possible duplicates (proposal #8, 2026-08-28)

    /// Fires the GET /api/receipts/possible-duplicates lookup for whatever
    /// the date/vendor/total fields hold right now. Fire-and-forget by
    /// contract - the same shape `EventLogger.log()` uses for its own
    /// "never block, never surface a failure" rule (its own doc comment
    /// states the reasoning this mirrors): this method is not `async` and
    /// never throws, so nothing calling it can be made to wait on the
    /// network or handle a failure that isn't already swallowed into an
    /// empty result (`duplicateCheckAction`'s own doc comment). The view
    /// debounces repeated calls (ConfirmReceiptView's `.task(id:)`
    /// wiring); this method itself has no debounce of its own and is safe
    /// to call as often as needed.
    ///
    /// A no-op when `duplicateCheckAction` is nil (no server row exists
    /// yet to compare against) or when the total does not currently parse
    /// - in the latter case any previously-found matches are cleared too,
    /// so a match found against a since-edited-to-invalid total cannot
    /// linger on screen.
    func checkForPossibleDuplicates() {
        guard let duplicateCheckAction else { return }
        guard case .cents(let totalCents) = totalInput else {
            possibleDuplicates = []
            return
        }
        let purchasedAtIso = ReceiptFormat.isoDate(fromPicker: purchasedDate)
        let vendor = normalized(vendorText)

        duplicateCheckGeneration += 1
        let generation = duplicateCheckGeneration
        Task { [weak self] in
            let matches = await duplicateCheckAction(purchasedAtIso, totalCents, vendor)
            // A newer call already superseded this one, or the model (and
            // so the screen it backed) is gone - either way this response
            // must not write anywhere.
            guard let self, self.duplicateCheckGeneration == generation else { return }
            self.possibleDuplicates = matches
        }
    }

    // MARK: - Saving

    /// The reason save is disabled, stated below the button rather than
    /// left to be inferred (spec §10A.1) - or nil, meaning save away.
    var saveBlocker: String? {
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
        if tipInput == .invalid {
            return "The tip isn't a valid amount."
        }
        if otherFeesInput == .invalid {
            return "Other fees aren't a valid amount."
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
        guard case .cents(let totalCents) = totalInput else {
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
                subtotalCents: centsOrNil(subtotalInput),
                hstCents: centsOrNil(hstInput),
                totalCents: totalCents,
                tipCents: centsOrNil(tipInput),
                otherFeesCents: centsOrNil(otherFeesInput),
                category: normalized(categoryText),
                paymentMethod: normalized(paymentMethodText),
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

/// Which SuggestedField carries this money field's amber marking - kept
/// here rather than on ReceiptArithmetic.swift's own enum, so that file
/// stays exactly what §10.2 asks of a pure computation module (no
/// knowledge of ConfirmReceiptModel or the view layer above it).
private extension DerivableMoneyField {
    var suggestedField: ConfirmReceiptModel.SuggestedField {
        switch self {
        case .subtotal: return .subtotal
        case .hst: return .hst
        case .tip: return .tip
        case .otherFees: return .otherFees
        case .total: return .total
        }
    }
}
