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
    /// LLM fallthrough (§7.3, extended 2026-08-28).
    let tipCents: Int?
    /// Added 2026-09-01, when 130 real receipts showed the fee labels are
    /// consistent enough to read (`ReceiptSuggestions.otherFeesCents`) and
    /// that the card type is printed on four slips in five.
    let otherFeesCents: Int?
    let paymentMethod: String?
    /// Both parsers read a date off the same text and they differ (§7.3).
    /// Only the server merge can raise this.
    let dateDisagreement: Bool
    /// Both parsers produced an HST value and it differs (§7.3, added
    /// 2026-08-28). Only the server merge can raise this - the served
    /// `hstCents` value is unchanged, heuristic-only either way.
    let hstDisagreement: Bool
    /// Which amounts the arithmetic-sanity rule refused to prefill
    /// (2026-09-01, `ReceiptArithmetic.validateSuggestedAmounts`). The
    /// corresponding property above is already nil; this says WHY, so the
    /// form can tell "nothing was read" from "what was read did not add
    /// up" and say the second one out loud.
    let withheldAmounts: Set<WithheldAmountField>

    /// The served §7.3 merge. The server runs the same sanity rule on its
    /// own side and flags what it withheld; this re-runs it locally
    /// regardless - the check is cheap, the server may be an older build,
    /// and a suggestion that reaches the form is one this client is
    /// answerable for.
    init(merged: MergedSuggestions) {
        let served = Self.withhold(
            subtotalCents: merged.subtotalCents.value,
            hstCents: merged.hstCents.value,
            tipCents: merged.tipCents.value,
            otherFeesCents: merged.otherFeesCents?.value,
            totalCents: merged.totalCents.value
        )
        var withheld = served
        if merged.totalCents.withheld { withheld.insert(.totalCents) }
        if merged.subtotalCents.withheld { withheld.insert(.subtotalCents) }
        withheldAmounts = withheld

        vendor = merged.vendor.value
        purchasedAt = merged.purchasedAt.value
        totalCents = withheld.contains(.totalCents) ? nil : merged.totalCents.value
        hstCents = merged.hstCents.value
        subtotalCents = withheld.contains(.subtotalCents) ? nil : merged.subtotalCents.value
        tipCents = merged.tipCents.value
        otherFeesCents = merged.otherFeesCents?.value
        paymentMethod = merged.paymentMethod?.value
        dateDisagreement = merged.purchasedAt.disagreement
        hstDisagreement = merged.hstCents.disagreement
    }

    /// The on-device parse alone (a capture-time confirm), or - since
    /// 2026-09-01 - the server's own LLM answer arriving over the top of it
    /// (`ConfirmReceiptModel.applyServerSuggestions`). Both go through the
    /// same sanity rule for the same reason: a set of amounts that cannot
    /// be true is not made truer by which parser produced it.
    init(parse: ReceiptSuggestions) {
        let withheld = Self.withhold(
            subtotalCents: parse.subtotalCents,
            hstCents: parse.hstCents,
            tipCents: parse.tipCents,
            otherFeesCents: parse.otherFeesCents,
            totalCents: parse.totalCents
        )
        withheldAmounts = withheld

        vendor = parse.vendor
        purchasedAt = parse.purchasedAt
        totalCents = withheld.contains(.totalCents) ? nil : parse.totalCents
        hstCents = parse.hstCents
        subtotalCents = withheld.contains(.subtotalCents) ? nil : parse.subtotalCents
        tipCents = parse.tipCents
        otherFeesCents = parse.otherFeesCents
        paymentMethod = parse.paymentMethod
        dateDisagreement = false
        // The on-device parse alone has no LLM counterpart to disagree
        // with - only the server merge can raise this flag.
        hstDisagreement = false
    }

    private static func withhold(
        subtotalCents: Int?,
        hstCents: Int?,
        tipCents: Int?,
        otherFeesCents: Int?,
        totalCents: Int?
    ) -> Set<WithheldAmountField> {
        ReceiptArithmetic.validateSuggestedAmounts(
            subtotalCents: subtotalCents,
            hstCents: hstCents,
            tipCents: tipCents,
            otherFeesCents: otherFeesCents,
            totalCents: totalCents
        )
    }
}

/// The confirm screen's state and decisions (spec §7.2, §10A.1), with no
/// camera and no UIKit anywhere near it - the whole screen is testable on
/// the simulator, which is the §10.2 requirement for the one screen that
/// is the product.
///
/// The rules it owns:
/// - every prefilled (suggested) value starts unreviewed, and touching a
///   field clears that permanently - which is what the inline notes and
///   the save-time accept/override telemetry read (the row tint that also
///   read it was removed 2026-09-01);
/// - the arithmetic check warns, inside the total card, and never blocks;
/// - a date the two parsers disagreed on carries an inline note with the
///   arithmetic warning's treatment, cleared by touching the field;
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
    /// a machine suggestion and nothing starts unreviewed (2026-08-26 field
    /// reduction: confirmed receipts became editable).
    enum Purpose: Equatable {
        case confirm
        case edit
    }

    /// The fields that can carry an "unreviewed suggestion" marking.
    /// Originally exactly the fields an OCR/LLM suggestion could prefill;
    /// widened 2026-08-28 to `otherFees`, `category` and `paymentMethod`,
    /// which then carried the SAME marking from a different source - a
    /// proposal #1 derived-amount fill (`otherFees`) or a proposal #2
    /// vendor default (`category`, `paymentMethod`). §10A.1's rule was
    /// always general ("every prefilled field is visually marked as a
    /// suggestion until touched"), not OCR-specific; this enum just caught
    /// up to that.
    ///
    /// **2026-09-01:** `otherFees` and `paymentMethod` can now start
    /// unreviewed at construction after all, because the parser learned to
    /// read both off real paper (`ReceiptSuggestions`). `category` remains
    /// the one field no parser will ever suggest - it is the person's own
    /// vocabulary, and only a vendor default can prefill it.
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

        /// The server's `reviewedFields` name for this field
        /// (ReviewedField.swift, 2026-09-01) - the iOS half of the web
        /// form's `REVIEWED_FIELD_BY_DRAFT_KEY`, total in both directions
        /// so no screen has to spell `hstCents` for a box labelled HST.
        var reviewedField: ReviewedField {
            switch self {
            case .total: return .totalCents
            case .date: return .purchasedAt
            case .vendor: return .vendor
            case .hst: return .hstCents
            case .subtotal: return .subtotalCents
            case .tip: return .tipCents
            case .otherFees: return .otherFeesCents
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
        /// looking at it, which marks it reviewed permanently (§10A.1).
        /// `otherFees`, `category` and `paymentMethod` map to their own
        /// SuggestedField cases too (2026-08-28): none of the three ever
        /// starts unreviewed from a parser, but each can gain the marking
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

        /// The server's `reviewedFields` name for this field
        /// (2026-09-01). Every keyboard field has one, `notes` included -
        /// which is exactly why this exists alongside
        /// `SuggestedField.reviewedField`: `notes` carries no suggestion
        /// and so has no SuggestedField case, but a person who typed a
        /// note has unquestionably reviewed that field and a save-for-
        /// later that dropped it would throw the note away.
        var reviewedField: ReviewedField {
            switch self {
            case .total: return .totalCents
            case .vendor: return .vendor
            case .hst: return .hstCents
            case .subtotal: return .subtotalCents
            case .tip: return .tipCents
            case .otherFees: return .otherFeesCents
            case .category: return .category
            case .paymentMethod: return .paymentMethod
            case .notes: return .notes
            }
        }
    }

    /// The four boxes that ADD UP to the total, as opposed to the total
    /// itself - the verbatim mirror of the web form's
    /// `ComponentAmountField` (ReceiptForm.tsx, 2026-09-01). Named because
    /// the total-tracking rule treats them as one group and the total as
    /// the thing they move.
    enum ComponentAmountField: CaseIterable, Equatable {
        case subtotal, hst, tip, otherFees

        /// Which SuggestedField this box carries, so the tracking rule and
        /// the chip share the bookkeeping every other suggestion source
        /// on this screen already uses.
        var suggestedField: SuggestedField {
            switch self {
            case .subtotal: return .subtotal
            case .hst: return .hst
            case .tip: return .tip
            case .otherFees: return .otherFees
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
    /// True once a save has actually succeeded (2026-09-01). The screen is
    /// on its way out at that point, and a late arrival - the server's
    /// second-opinion parse landing after the person hit Save - must not
    /// write into a form whose values are already durable.
    @Published private(set) var hasSaved = false
    @Published private(set) var saveError: String?
    @Published private(set) var isDeleting = false
    /// Why a delete did not happen, when it did not - kept apart from
    /// `saveError`, which belongs to the button below it, exactly the way
    /// ReceiptDetailModel keeps its own delete failure out of its load
    /// phase.
    @Published private(set) var deleteError: String?

    /// True when no date was read off the paper and the prefill is the day
    /// of capture - the one suggestion that can be fabricated, so the view
    /// says so out loud instead of passing it off as parsed.
    let dateIsCaptureDayFallback: Bool

    /// What to say when the arithmetic-sanity rule suppressed an amount
    /// (2026-09-01) - nil when it suppressed nothing, which is the ordinary
    /// case. Constant for the form's life; `withheldAmountNote` below is
    /// what the view reads, and it goes quiet once the total is filled in,
    /// because by then the note is describing a blank that no longer
    /// exists.
    private let withheldNoteText: String?

    /// The note under the total card when a suggested amount was withheld.
    /// A stated absence with a reason: "nothing was read" and "what was
    /// read could not be true" are different facts about a blank field, and
    /// only the second one tells a person to go back to the paper.
    var withheldAmountNote: String? {
        guard let withheldNoteText, totalText.isEmpty else { return nil }
        return withheldNoteText
    }

    private static func withheldNote(for withheld: Set<WithheldAmountField>) -> String? {
        if withheld.contains(.subtotalCents) && withheld.contains(.totalCents) {
            return "The amounts read from this receipt didn't add up, so the total and subtotal were left blank - enter them from the paper."
        }
        if withheld.contains(.totalCents) {
            return "The amounts read from this receipt didn't add up, so the total was left blank - enter it from the paper."
        }
        return nil
    }

    // MARK: - The server's second opinion (2026-09-01)

    /// A money field where the server's parse disagrees with a value this
    /// form already has - offered as a one-tap chip rather than applied,
    /// because overwriting a number already on screen is exactly what a
    /// person would not expect a background request to do.
    struct ServerAmountAlternative: Equatable, Identifiable {
        let field: DerivableMoneyField
        let cents: Int

        var id: String { "\(field)" }
    }

    /// Non-empty only after `applyServerSuggestions(_:)` found a
    /// disagreement it refused to resolve on its own. Rendered as chips
    /// under the total card.
    @Published private(set) var serverAmountAlternatives: [ServerAmountAlternative] = []

    /// §7.3: the injected suggestion set says both parsers read a date and
    /// they differ. Constant for the form's life; what the screen shows
    /// follows the unreviewed flag (showsDateDisagreementNote).
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
    /// `var`, not `let`, since 2026-09-01: the server's second opinion can
    /// replace an untouched vendor prefill, and the accept/override report
    /// must score the person against the value they were shown LAST.
    private var initialSuggestedVendor: String?
    private var initialSuggestedHstCents: Int?
    private var initialSuggestedSubtotalCents: Int?
    private var initialSuggestedTipCents: Int?
    /// Set at construction when the suggestion set carries a fee
    /// (2026-09-01), and otherwise only by `applyDerivedFill()` at the
    /// moment it fills the field.
    private var initialSuggestedOtherFeesCents: Int?
    /// `var` for the same reason as `initialSuggestedVendor` above.
    private var initialSuggestedPurchasedAtIso: String
    /// Set only by `applyVendorDefaultIfAvailable(_:)` (proposal #2) -
    /// nil until a default is actually applied, since category never
    /// carries a suggestion at construction (and never will: it is the
    /// person's own vocabulary, not something printed on paper).
    private var initialSuggestedCategory: String?
    /// Payment method's baseline. Unlike category's, this CAN be set at
    /// construction since 2026-09-01 - the card type is printed on most
    /// slips and the parser reads it.
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
    /// looked", the same distinction §10A.1's touch rule already draws
    /// for suggestions, applied here to counting instead.
    private var focusSnapshots: [EditableField: String] = [:]

    /// Where the confirmed fields go on save. Injected by whoever built
    /// the model; the form's rules above are identical either way.
    private let saveAction: (ConfirmedReceiptFields) async throws -> Void

    /// Binning this receipt without confirming it (2026-09-01). Injected
    /// the same way `saveAction` and `duplicateCheckAction` are, so this
    /// model still holds no `KeptAPI` of its own and stays testable with
    /// no server (spec §10.2). Nil for a capture-time confirm: there is no
    /// server row to delete yet, and the way to bin an unwanted scan
    /// before it exists is to not save it.
    private let deleteAction: (() async throws -> Void)?

    /// Writing the half-filled form without confirming it (2026-09-01).
    /// Injected exactly the way `saveAction` and `deleteAction` are, so
    /// this model still holds no `KeptAPI` of its own and stays testable
    /// with no server (spec §10.2). Nil for a capture-time confirm: there
    /// is no server row to write half of, and that screen's "Later"
    /// already queues the scan pending with whatever was typed
    /// (`pendingReceiptFields()` below).
    private let saveForLaterAction: ((SaveForLaterRequest) async throws -> Void)?

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
            // What a human already looked at on an earlier sitting
            // (2026-09-01, server migration 0009). The server already
            // withholds a reviewed field's suggestion; carrying the set
            // here is what makes the prefill, the notes and the save agree
            // with it on this side too.
            reviewedFields: ReviewedField.set(fromWire: receipt.reviewedFields),
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
            },
            // "Save for later" (2026-09-01): the same PATCH route with no
            // `status`, carrying only what a human has looked at. Only a
            // server-backed form gets it - a capture-time confirm has no
            // row to write half of, and its own "Later" already queues the
            // scan pending.
            saveForLaterAction: { request in
                _ = try await api.saveReceiptForLater(id: id, request)
            },
            // The same route ReceiptDetailModel.delete(id:) calls, so
            // "delete" means one thing in this app: a soft delete, the row
            // and its image kept for retention (spec §10B). Only the
            // server-backed form gets it.
            deleteAction: { try await api.deleteReceipt(id: id) }
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
            // Nothing has been reviewed yet and there is no row to have
            // recorded it on - this receipt does not exist server-side.
            reviewedFields: [],
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
    /// something other than a parser, so it prefills as already reviewed.
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
    /// suggestion covers. Exactly the suggested fields start unreviewed;
    /// the date always does (always prefilled - parsed, or the capture-day
    /// fallback, which is additionally called out).
    ///
    /// ⚠ **2026-09-01, `reviewedFields`:** a field the receipt already
    /// records as REVIEWED is the human's, and the row wins outright for
    /// it - a "save for later" wrote those values, and re-offering the
    /// parser's guess over a value someone typed last Tuesday is exactly
    /// the defect the reviewed set exists to prevent. Belt and braces: the
    /// server also stops serving `suggestions.<field>` for every reviewed
    /// field, so this normally re-states an absence rather than overriding
    /// a present suggestion. It is written anyway because the two rules
    /// must agree even if one end changes - and because a client that
    /// relies on the server having remembered is a client that shows the
    /// wrong value the day it has not. Verbatim the web form's
    /// `draftFromPending` rule.
    private init(
        receiptId: UUID?,
        currency: String,
        purpose: Purpose,
        imageSource: ReceiptImageSource?,
        ocrFailureNote: String?,
        suggestions: ConfirmSuggestionSet?,
        reviewedFields: Set<ReviewedField>,
        existing: ExistingValues,
        saveAction: @escaping (ConfirmedReceiptFields) async throws -> Void,
        duplicateCheckAction: ((_ purchasedAt: String, _ totalCents: Int, _ vendor: String?) async -> [Receipt])?,
        saveForLaterAction: ((SaveForLaterRequest) async throws -> Void)? = nil,
        deleteAction: (() async throws -> Void)? = nil
    ) {
        self.receiptId = receiptId
        self.currency = currency
        self.purpose = purpose
        self.imageSource = imageSource
        self.ocrFailureNote = ocrFailureNote
        self.saveAction = saveAction
        self.duplicateCheckAction = duplicateCheckAction
        self.saveForLaterAction = saveForLaterAction
        self.deleteAction = deleteAction
        self.storedReviewedFields = reviewedFields

        /// A suggestion outranks the row's copy (§7.3) EXCEPT on a field
        /// the receipt records as reviewed, where the row is a human's own
        /// value and nothing may sit over it. A local function rather than
        /// eight copies of the same ternary; it captures the parameter,
        /// never `self`, which is not yet initialized here.
        func seed<Value>(_ field: ReviewedField, suggested: Value?, row: Value?) -> Value? {
            reviewedFields.contains(field) ? row : (suggested ?? row)
        }

        // Each "seed" is exactly what prefills the field - captured here,
        // once, so it can also seed the suggestion-outcome snapshot below
        // without recomputing the same expression twice and risking the
        // two drifting apart.
        let seedTotalCents = seed(.totalCents, suggested: suggestions?.totalCents, row: existing.totalCents)
        totalText = seedTotalCents.map(MoneyInput.text(fromCents:)) ?? ""
        // Parsed date, or the existing one (the row's, or the capture
        // day) - both through the same UTC-pinned round trip the picker
        // renders in.
        let seedPurchasedAtIso = seed(
            .purchasedAt, suggested: suggestions?.purchasedAt, row: existing.purchasedAt
        ) ?? existing.purchasedAt
        purchasedDate = ReceiptFormat.pickerDate(fromIso: seedPurchasedAtIso) ?? Date()
        let seedVendor = seed(.vendor, suggested: suggestions?.vendor, row: existing.vendor)
        vendorText = seedVendor ?? ""
        let seedHstCents = seed(.hstCents, suggested: suggestions?.hstCents, row: existing.hstCents)
        hstText = seedHstCents.map(MoneyInput.text(fromCents:)) ?? ""
        let seedSubtotalCents = seed(
            .subtotalCents, suggested: suggestions?.subtotalCents, row: existing.subtotalCents
        )
        subtotalText = seedSubtotalCents.map(MoneyInput.text(fromCents:)) ?? ""
        let seedTipCents = seed(.tipCents, suggested: suggestions?.tipCents, row: existing.tipCents)
        tipText = seedTipCents.map(MoneyInput.text(fromCents:)) ?? ""
        // Other fees and payment method gained suggestion sources
        // 2026-09-01 (ReceiptSuggestions' own comments carry the evidence
        // that reversed the "no suggestion, deliberately" ruling); like
        // every other field here, a suggestion outranks the row's copy.
        let seedOtherFeesCents = seed(
            .otherFeesCents, suggested: suggestions?.otherFeesCents, row: existing.otherFeesCents
        )
        otherFeesText = seedOtherFeesCents.map(MoneyInput.text(fromCents:)) ?? ""
        categoryText = existing.category ?? ""
        let seedPaymentMethod = seed(
            .paymentMethod, suggested: suggestions?.paymentMethod, row: existing.paymentMethod
        )
        paymentMethodText = seedPaymentMethod ?? ""
        notesText = existing.notes ?? ""

        initialSuggestedTotalCents = seedTotalCents
        initialSuggestedVendor = seedVendor
        initialSuggestedHstCents = seedHstCents
        initialSuggestedSubtotalCents = seedSubtotalCents
        initialSuggestedTipCents = seedTipCents
        initialSuggestedOtherFeesCents = suggestions?.otherFeesCents == nil ? nil : seedOtherFeesCents
        initialSuggestedPaymentMethod = suggestions?.paymentMethod == nil ? nil : seedPaymentMethod
        initialSuggestedPurchasedAtIso = seedPurchasedAtIso
        withheldNoteText = Self.withheldNote(for: suggestions?.withheldAmounts ?? [])

        switch purpose {
        case .edit:
            // Every value on screen is the human's own, already confirmed
            // once. Nothing here is a machine suggestion, so nothing is
            // unreviewed and nothing claims a fabricated date.
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
                if suggestions.otherFeesCents != nil { unreviewed.insert(.otherFees) }
                if suggestions.paymentMethod != nil { unreviewed.insert(.paymentMethod) }
                // A reviewed date came off the row, not off the paper, so
                // no fabrication claim is made about it either.
                dateIsCaptureDayFallback =
                    suggestions.purchasedAt == nil && !reviewedFields.contains(.purchasedAt)
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
            // A reviewed field is never an unreviewed suggestion: a human
            // looked at it and wrote what it says. The display half of the
            // same rule `seed` above enforces on the value half, and
            // likewise belt-and-braces - the server stops SERVING a
            // suggestion for a reviewed field, so this usually removes
            // nothing. Verbatim the web form's `suggestedFields` loop.
            for reviewed in reviewedFields {
                if let suggested = reviewed.suggestedField {
                    unreviewed.remove(suggested)
                }
            }
            unreviewedFields = unreviewed
            suggestedFields = unreviewed
        }
    }

    // MARK: - Reviewing

    /// Touching a field marks it reviewed, permanently (spec §10A.1); the
    /// views call this on focus and on edit. What that now drives is the
    /// inline notes (date and HST disagreement, the HST rate hint), which
    /// go quiet once a human has looked - the row tint it also used to
    /// drive was removed 2026-09-01.
    func markTouched(_ field: SuggestedField) {
        clearSuggestionMarking(field)
        touchedFields.insert(field)
        sessionReviewedFields.insert(field.reviewedField)
    }

    /// The same call for a field the keyboard can reach, whether or not it
    /// carries a suggestion (2026-09-01). `notes` is the only field with
    /// no SuggestedField at all, and it still has to reach
    /// `sessionReviewedFields` - a person who typed a note has reviewed
    /// that field, and a save-for-later that dropped it would throw the
    /// note away. The view calls this from its focus handler so there is
    /// one call site rather than a suggestion path and a notes path that
    /// could drift.
    func markTouched(editable field: EditableField) {
        if let suggestion = field.suggestion {
            markTouched(suggestion)
        } else {
            sessionReviewedFields.insert(field.reviewedField)
        }
    }

    /// A field stops being marked as an unreviewed suggestion WITHOUT
    /// anybody having looked at it - the one case being the total when
    /// the tracking rule below recomputes it. Mirrors the web form's
    /// `markTouched("total")` inside `editComponentAmount`, whose own
    /// comment states the distinction: the number in that box is no
    /// longer the parser's suggestion, so the notes let it go, but nobody
    /// LOOKED at it - it just followed - so it stays out of
    /// `touchedFields` and out of the reviewed set the save reports.
    private func clearSuggestionMarking(_ field: SuggestedField) {
        unreviewedFields.remove(field)
    }

    /// Which fields a human has actually put a finger on this session.
    /// Distinct from `unreviewedFields`, which only ever held fields that
    /// carried a SUGGESTION: a field nobody ever suggested anything for is
    /// "not unreviewed" and "not touched" at the same time, and
    /// `applyServerSuggestions(_:)` (2026-09-01) is the first caller that
    /// has to tell those two apart before it writes anything.
    private var touchedFields: Set<SuggestedField> = []

    /// Which fields this SESSION has put a finger on, in the server's own
    /// `reviewedFields` vocabulary (2026-09-01). Distinct from
    /// `touchedFields` in exactly two ways, both deliberate: it also holds
    /// `notes`, which carries no SuggestedField, and it is the half that
    /// gets SENT.
    private var sessionReviewedFields: Set<ReviewedField> = []

    /// What the receipt already recorded as reviewed before this form
    /// opened - the server's stored set, decoded from the response
    /// (`Receipt.reviewedFields`). Empty for a capture-time confirm, which
    /// has no server row yet, and for a response from before migration
    /// 0009.
    private let storedReviewedFields: Set<ReviewedField>

    /// What a save reports as reviewed: the receipt's stored set unioned
    /// with everything this session touched. The verbatim mirror of the
    /// web form's `reviewedFieldsForSave`, including its reasoning for
    /// being a UNION even though the PATCH replaces the stored set
    /// outright - the person who opened this receipt today did not
    /// un-review what they looked at last week, and a client that sent
    /// only today's touches would silently un-review the rest and hand the
    /// parser back a field it had already lost.
    var reviewedFieldsForSave: [ReviewedField] {
        ReviewedField.ordered(storedReviewedFields.union(sessionReviewedFields))
    }

    func isUnreviewed(_ field: SuggestedField) -> Bool {
        unreviewedFields.contains(field)
    }

    /// How many suggestions nobody has looked at yet. No longer on
    /// screen (see `screenTitle`); kept as the single readable summary of
    /// `unreviewedFields`, which the notes and the save-time telemetry
    /// still run on and which the unit suite asserts against directly.
    var unreviewedCount: Int {
        unreviewedFields.count
    }

    /// The navigation title: what the screen is, not a running count.
    ///
    /// It counted unreviewed suggestions until 2026-09-01 - "5 to check",
    /// then "All checked" - alongside the amber row tint that the same
    /// change removed. Both were the same idea, and the idea did not
    /// survive real use: nearly every field on a scanned receipt arrives
    /// prefilled, so the counter opened at five or six every single time
    /// and counted down to a congratulation nobody asked for. The title
    /// now says which of the two things this screen is doing, which is the
    /// only thing about it a person cannot already see.
    var screenTitle: String {
        switch purpose {
        case .edit: return "Edit receipt"
        case .confirm: return "Confirm receipt"
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

    /// Whether `field` still holds exactly the value a machine last put
    /// in it - "nobody has changed this", which since 2026-09-01 is what
    /// every inline note on this screen reads instead of "nobody has
    /// focused this".
    ///
    /// **Why the rule changed** (the owner's diagnosis, 2026-09-01): the
    /// notes cleared on `markTouched`, and the view calls that from the
    /// focus handler - so the HST rate hint disappeared the moment you
    /// tapped into HST to fix it, taking the number you were about to
    /// check against with it. A note that vanishes at the instant it
    /// becomes actionable is worse than no note. Focus is not a decision;
    /// changing the value is. `markTouched` keeps its own meaning
    /// untouched for telemetry and for `reviewedFields` - the two rules
    /// were only ever conflated because one flag happened to serve both.
    ///
    /// Reuses `isSuggestionAccepted`, which is already exactly this
    /// question - the save-time accept/override report asks "does the
    /// field still hold what it was last suggested to be", and so does
    /// this. One implementation, so a note and the telemetry beside it can
    /// never disagree about whether the person changed something.
    private func stillHoldsSuggestedValue(_ field: SuggestedField) -> Bool {
        isSuggestionAccepted(field)
    }

    /// The date-disagreement note (spec §7.2, §10A.1): shown while the
    /// date still says what the parsers put there, gone once the value
    /// changes. No separate dismissal, nothing persisted.
    var showsDateDisagreementNote: Bool {
        dateDisagreement && stillHoldsSuggestedValue(.date)
    }

    /// The HST-disagreement note (§7.3, 2026-08-28): same rule as the
    /// date's - shown while the HST box still holds the suggested amount,
    /// gone once the value changes, no separate dismissal.
    var showsHstDisagreementNote: Bool {
        hstDisagreement && stillHoldsSuggestedValue(.hst)
    }

    /// The HST rate-plausibility hint (proposal #7, 2026-08-28) - the live
    /// mirror of the server's `checkHstRatePlausibility`
    /// (ReceiptArithmetic.swift carries the full reasoning for the ±0.25pp
    /// band and why it must never widen). Tied to the SAME lifecycle
    /// `showsHstDisagreementNote` above uses, and changed with it on
    /// 2026-09-01: shown while the HST box still holds the amount a
    /// machine put there, gone once the value changes. This is the note
    /// the owner's diagnosis named - it is a hint about a number you are
    /// being asked to check, and clearing it on focus deleted it at the
    /// exact moment you tapped in to act on it. `centsOrNil` reads
    /// `.invalid` text as absent, the same suppression
    /// `showsArithmeticWarning` already applies to garbage input, so this
    /// never fires over unparseable text.
    var showsHstRateHint: Bool {
        stillHoldsSuggestedValue(.hst)
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
    /// - unreviewed until touched (`unreviewedFields`, exactly the
    /// construction-time rule) and enrolled in the save-time accept/override report
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
    /// `.onChange(of: focusedField)` (already wired for the
    /// touch-marks-it-reviewed rule) is where this is called from.
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

    /// The sharper half of the same inequality (2026-09-01): the total is
    /// LESS than the parts it is made of. The live mirror of the server's
    /// `checkAmountFloor` - ReceiptArithmetic.swift carries the reasoning
    /// for why this is a different fact from "these don't add up" and
    /// worth saying differently. Suppressed over unparseable text by the
    /// same rule everything else here is (`moneyFieldValues`).
    var showsAmountFloorNote: Bool {
        guard let fields = moneyFieldValues else { return false }
        return ReceiptArithmetic.checkAmountFloor(
            subtotalCents: fields.subtotal,
            hstCents: fields.hst,
            tipCents: fields.tip,
            otherFeesCents: fields.otherFees,
            totalCents: fields.total
        ) == .totalBelowComponents
    }

    /// The ONE note the total card shows about the amounts, or nil.
    ///
    /// The floor note is rendered INSTEAD of the generic one rather than
    /// beside it (2026-09-01, verbatim the web form's own precedence):
    /// "the total is less than its parts" is a strict subset of "these do
    /// not add up" and strictly more specific, and two warnings about one
    /// arithmetic fact is how a form teaches people to stop reading its
    /// warnings. The two underlying facts stay separately readable
    /// (`showsAmountFloorNote`, `showsArithmeticWarning`); this is only
    /// which of them gets the line.
    ///
    /// Both are prompts to look, never blocks - plenty of legitimate
    /// receipts do not reconcile (spec §7.2, §10A.1), and one of them is
    /// in production right now: a store-credit slip whose subtotal 104.93
    /// + HST 13.65 sit against a total of 28.21, correct and permanent.
    var amountsWarning: String? {
        if showsAmountFloorNote {
            return "Total is less than subtotal + HST + tip + fees. One of these numbers is wrong."
        }
        if showsArithmeticWarning {
            return "These amounts don't add up to the total. Worth a look."
        }
        return nil
    }

    // MARK: - Total tracks its components (2026-09-01)

    /// `subtotal + HST + tip + other fees` over the form as it stands, or
    /// nil when there is no honest sum to state: a blank subtotal (nothing
    /// to add to - the same "nothing to reconcile against" rule
    /// `showsArithmeticWarning` follows) or any mid-keystroke unparseable
    /// box, the total's included. Verbatim the web form's `componentSum`.
    private var componentSum: Int? {
        guard let fields = moneyFieldValues, let subtotal = fields.subtotal else { return nil }
        return subtotal + (fields.hst ?? 0) + (fields.tip ?? 0) + (fields.otherFees ?? 0)
    }

    /// **Total tracks its components while consistent**, the live rule
    /// that turns four boxes into one running bill (the owner, 2026-09-01:
    /// "total should update when I change subtotal/HST/tip/other fees, but
    /// I must still be able to edit total directly without it altering the
    /// other fields"). The line-for-line mirror of the web form's
    /// `applyComponentEdit` (ReceiptForm.tsx) - same oldSum/newSum
    /// comparison, same "a blank total tracks too", same storable-range
    /// refusal.
    ///
    /// Editing subtotal, HST, tip or other fees recomputes the total - but
    /// ONLY when the total is blank or still equals what the components
    /// said BEFORE this edit. The moment the total says something the
    /// components do not, it is the person's own number (or the parser's
    /// read of the printed total, which is the one figure OCR gets right
    /// most often), and no keystroke elsewhere may quietly overwrite it.
    /// Editing the total itself never changes any other field, in either
    /// direction: the total is the anchor, and it is bound straight to
    /// `totalText` with no rule attached.
    ///
    /// The four flows this is built from, all of them off a real form:
    ///
    /// - **A.** OCR found the total ($14.35) and nothing else. Typing a
    ///   subtotal of $12.70 leaves the total alone - it came off the paper
    ///   - and the HST chip below then offers the $1.65 difference.
    /// - **B.** A blank form (a photograph the parsers got nothing from).
    ///   Typing subtotal $12.70 makes the total $12.70; typing HST $1.65
    ///   makes it $14.35. The total is never typed at all.
    /// - **C.** $12.70 / $1.65 / $14.35, all consistent, and the HST is
    ///   corrected to $1.60. The total follows to $14.30, because leaving
    ///   $14.35 would create a mismatch the person did not ask for and
    ///   would then have to fix by hand.
    /// - **D.** The total is typed as $20.00 directly. Nothing else moves,
    ///   and a later subtotal edit does not overwrite it - $20.00 is not
    ///   what the components said, so the total is the person's.
    ///
    /// The view binds the four component boxes through this rather than to
    /// their text properties, so typing and an amount chip take the same
    /// path and cannot drift.
    func editComponentAmount(_ field: ComponentAmountField, to text: String) {
        let totalBeforeEdit = totalInput
        let oldSum = componentSum ?? lastTrackedComponentSum
        setComponentText(field, to: text)
        guard let newSum = componentSum else {
            // Nothing to track to - a blank subtotal, or a box
            // mid-keystroke.
            return
        }
        defer { lastTrackedComponentSum = newSum }
        let tracks: Bool
        switch totalBeforeEdit {
        case .empty: tracks = true
        case .invalid: tracks = false
        case .cents(let total): tracks = oldSum != nil && total == oldSum
        }
        guard tracks, ReceiptArithmetic.isStorable(cents: newSum) else {
            // Out of the storable range is the same refusal every other
            // suggestion here makes, rather than writing a number the
            // server would 400 on.
            return
        }
        let tracked = MoneyInput.text(fromCents: newSum)
        guard tracked != totalText else { return }
        totalText = tracked
        // The number in that box is no longer the parser's suggestion, so
        // the notes let it go - but nobody looked at it, it just followed,
        // so it stays out of the reviewed set the save reports.
        clearSuggestionMarking(.total)
    }

    /// The last sum the four component boxes actually produced.
    ///
    /// ⚠ **Why the rule needs a memory at all** (2026-09-01, found by
    /// running the form rather than by reading it - KeptUITests'
    /// `ConfirmAmountsUITests`). Typing an amount passes through a state
    /// no money parser accepts: "12.70" is typed as `1`, `12`, `12.`,
    /// `12.7`, `12.70`, and `12.` is not a number. On the keystroke after
    /// it, `componentSum` over the PRE-edit form is nil, and comparing the
    /// total against nil says "these have diverged" - so the rule stood
    /// down for the rest of the amount and a blank form typed with
    /// subtotal 12.70 ended up with a total of $12.00, the sum as it stood
    /// two keystrokes earlier. Visibly wrong, on the commonest action this
    /// screen has.
    ///
    /// So a box that is momentarily unparseable SUSPENDS the decision
    /// instead of cancelling it: the comparison falls back to the last sum
    /// the boxes really did make. It is consulted in exactly one window -
    /// the pre-edit form had an unreadable box and the post-edit form does
    /// not - because every other path either returns early (`newSum` nil)
    /// or has a real `oldSum` to use.
    ///
    /// The web form has the identical hole (`parseMoneyInput` rejects
    /// "12." the same way, so `applyComponentEdit` sees a null `oldSum`
    /// and stops tracking mid-amount). It is flagged in this batch's
    /// report rather than fixed here: `web/` is another session's to
    /// change.
    private var lastTrackedComponentSum: Int?

    private func setComponentText(_ field: ComponentAmountField, to text: String) {
        switch field {
        case .subtotal: subtotalText = text
        case .hst: hstText = text
        case .tip: tipText = text
        case .otherFees: otherFeesText = text
        }
    }

    /// The current text of one component box - what the view's binding
    /// reads, paired with `editComponentAmount` as its setter.
    func componentText(_ field: ComponentAmountField) -> String {
        switch field {
        case .subtotal: return subtotalText
        case .hst: return hstText
        case .tip: return tipText
        case .otherFees: return otherFeesText
        }
    }

    // MARK: - The HST chip (2026-09-01)

    /// The one currency Ontario's 13% can be a fact about, mirrored from
    /// the web form's `HST_RATE_CURRENCY`. `currency` is the server's
    /// three-letter code, validated `/^[A-Z]{3}$/` on every write and
    /// defaulted to CAD on the column itself, so this compares exactly
    /// rather than case-folding: there is no lowercase "cad" to miss.
    static let hstRateCurrency = "CAD"

    /// A one-tap HST offer with its arithmetic stated. Two kinds, never
    /// both at once - see `hstSuggestionChip`.
    struct AmountChip: Equatable {
        enum Kind: Equatable {
            /// The difference the receipt's own numbers determine.
            case fromTotal
            /// The default rate applied to the subtotal - a guess about
            /// the world rather than about this receipt.
            case atDefaultRate
        }

        let kind: Kind
        let cents: Int
    }

    /// The HST offer, when HST is blank and a subtotal is present - the
    /// shape every receipt whose tax line the parsers missed arrives in.
    /// Verbatim the web form's `hstSuggestionChip`.
    ///
    /// Two offers, never both, because they answer the same question from
    /// different evidence and showing a pair would make the person
    /// adjudicate between two numbers this form invented:
    ///
    /// - The receipt states a total: the difference is the tax, and that
    ///   difference is a fact about the numbers on screen (`.fromTotal` -
    ///   this is the widened `deriveMissingAmount` restated for one
    ///   field). Offered only when it is POSITIVE: a zero or negative
    ///   difference is evidence one of the other boxes is wrong, not an
    ///   HST amount anyone could act on.
    /// - Otherwise the default rate (`.atDefaultRate`), which says so in
    ///   its own label - and which is therefore the only one of the two a
    ///   `currency` can disqualify.
    ///
    /// ⚠ **Currency gates the default-rate offer only.** Ontario's 13% is
    /// a fact about a Canadian sale; on a US receipt it is not a weaker
    /// guess, it is about a different country's tax system, and a chip
    /// reading "HST at 13% of subtotal" beside a USD total is simply wrong
    /// - the one thing a suggestion on this form may never be. The
    /// `.fromTotal` branch stays currency-agnostic and deliberately: it
    /// applies no rate and assumes no jurisdiction, it subtracts the
    /// numbers already on screen from each other and says so in its
    /// formula.
    ///
    /// Never auto-applied.
    var hstSuggestionChip: AmountChip? {
        guard let fields = moneyFieldValues else { return nil }
        guard fields.hst == nil, let subtotal = fields.subtotal else { return nil }
        if let total = fields.total {
            let remainder = total - subtotal - (fields.tip ?? 0) - (fields.otherFees ?? 0)
            if remainder > 0, ReceiptArithmetic.isStorable(cents: remainder) {
                return AmountChip(kind: .fromTotal, cents: remainder)
            }
        }
        guard currency == Self.hstRateCurrency else {
            // A non-CAD receipt gets the arithmetic offer above if it
            // qualifies and nothing at all otherwise - never a rate from
            // another country's tax system. Checked here rather than
            // inside `suggestDefaultRateHst`, which mirrors a server
            // function that takes a rate in basis points and has no
            // business knowing about currencies.
            return nil
        }
        guard let suggested = ReceiptArithmetic.suggestDefaultRateHst(subtotalCents: subtotal) else {
            return nil
        }
        return AmountChip(kind: .atDefaultRate, cents: suggested.hstCents)
    }

    /// The chip's own words - named, not bare, the same rule
    /// `derivableFillLabel` follows and for the same stated reason: a
    /// person must be able to read what a tap will do before they make it.
    var hstSuggestionChipLabel: String? {
        guard let chip = hstSuggestionChip else { return nil }
        let amount = ReceiptFormat.money(cents: chip.cents, currency: currency)
        switch chip.kind {
        case .fromTotal:
            return "HST = Total − Subtotal − Tip − Other fees (\(amount))"
        case .atDefaultRate:
            let rate = ReceiptArithmetic.defaultHstRateBps / 100
            return "HST at \(rate)% of subtotal (\(amount))"
        }
    }

    /// Applies the chip, which differs from `applyDerivedFill()` above in
    /// two deliberate ways, both of them the web form's
    /// (`applyAmountChip`).
    ///
    /// It marks HST TOUCHED. A fill offers the one value the other four
    /// boxes determine, and proposal #1's own risk mitigation is that it
    /// lands unreviewed and stays unreviewed until a person looks at it. A
    /// chip states a rule and its result - "HST at 13% of subtotal =
    /// $1.65" - and the person picked it over typing anything else; that
    /// choice is the looking, and it belongs in the reviewed set the save
    /// reports.
    ///
    /// And it routes through `editComponentAmount`, so applying it moves
    /// the total exactly the way typing the number would - which is what
    /// "add 13% to this" means, and why the default-rate offer is safe to
    /// make on a receipt whose total is already consistent with its
    /// subtotal.
    @discardableResult
    func applyHstSuggestionChip() -> Bool {
        guard let chip = hstSuggestionChip else { return false }
        editComponentAmount(.hst, to: MoneyInput.text(fromCents: chip.cents))
        // The same save-time accept/override enrolment every other
        // machine-suggested amount gets, so tapping this is reported at
        // save exactly like accepting a prefill.
        initialSuggestedHstCents = chip.cents
        suggestedFields.insert(.hst)
        markTouched(.hst)
        return true
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
    ///
    /// Nil for HST while `hstSuggestionChip` has something to say
    /// (2026-09-01): the two answer the same question - what goes in the
    /// blank HST box - and the chip is the better-worded of the pair,
    /// because it names the default-rate case the fill cannot reach at
    /// all. Where both apply the chip wins and the fill is suppressed for
    /// HST alone; every other field's fill is untouched. Verbatim the web
    /// form's `derived?.field === "hst" && hstChip === null` render gate,
    /// and like the web this suppresses the OFFER, not the derivation -
    /// `derivableFill` still says what the arithmetic gives.
    var derivableFillLabel: String? {
        guard let derived = derivableFill else { return nil }
        if derived.field == .hst, hstSuggestionChip != nil { return nil }
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
    /// it unreviewed and machine-suggested, exactly like an OCR suggestion
    /// (spec: never applied automatically, never on save). Works
    /// identically on `.edit` (deliberately: editing after confirmation is
    /// a stated feature the proposal names by name, "not just the confirm
    /// screen") - `applyMachineSuggestedAmount` does not branch on
    /// `purpose`, so a fill on an edit form is reportable exactly the way
    /// one during confirm is.
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
    /// tapped - same suggestion bookkeeping, same save-time
    /// accept/override reporting as `applyDerivedFill()` above, and the
    /// identical `.edit`-works-too behaviour.
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
    /// and marks the field unreviewed - the one place "applying a
    /// suggested amount" is defined, so the two callers cannot drift on
    /// what it means.
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
    /// APIModels.swift) - editable, and NEVER over what the person
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

    // MARK: - The server's second opinion (2026-09-01)

    /// The server's LLM answer, arriving a few seconds after the form came
    /// up (`CaptureFlowModel.prepareSingleCapture`). Nothing about this
    /// screen waits for it, and nothing says anything when it never comes.
    ///
    /// **Why this exists.** 51 of the 54 confirmations in production
    /// happened on the capture-time confirm screen, which until now saw
    /// only the on-device heuristic - while the server's LLM was right on
    /// the vendor 63% of the time against the heuristic's 39%, and supplied
    /// the right amount 57 times out of the 73 where the heuristic had
    /// none. Median dwell on this screen is 47 seconds and the model
    /// answers in 5, so the answer is simply there before most people have
    /// finished reading the paper.
    ///
    /// **What it is allowed to touch**, and the rule is the same one
    /// §10A.1 has always stated - a machine may fill a field a human has
    /// not looked at, and may never change one they have:
    ///
    /// - **Text fields** (vendor, date, payment method): replaced when the
    ///   field is still unreviewed and the server disagrees. The new value
    ///   becomes the suggestion of record (`initialSuggested*`), so the
    ///   save-time accept/override telemetry scores the person against
    ///   what they were actually shown last.
    /// - **Money fields**: filled only when the field is BLANK. When the
    ///   form already shows an amount and the server disagrees, nothing is
    ///   overwritten - the disagreement is offered as a chip
    ///   (`serverAmountAlternatives`) the person can tap. A number changing
    ///   under someone's eyes while they read a receipt is the one
    ///   behaviour this screen must never have.
    ///
    /// A no-op once the receipt is saving or saved: the values are durable
    /// by then and this arrives too late to matter.
    func applyServerSuggestions(_ server: ConfirmSuggestionSet) {
        guard !isSaving, !hasSaved, purpose == .confirm else { return }

        if let vendor = server.vendor, !touchedFields.contains(.vendor), normalized(vendorText) != vendor {
            vendorText = vendor
            initialSuggestedVendor = vendor
            markAsMachineSuggested(.vendor)
        }
        if let purchasedAt = server.purchasedAt,
           !touchedFields.contains(.date),
           let picked = ReceiptFormat.pickerDate(fromIso: purchasedAt),
           purchasedAt != ReceiptFormat.isoDate(fromPicker: purchasedDate) {
            purchasedDate = picked
            initialSuggestedPurchasedAtIso = purchasedAt
            markAsMachineSuggested(.date)
        }
        if let paymentMethod = server.paymentMethod,
           !touchedFields.contains(.paymentMethod),
           normalized(paymentMethodText) != paymentMethod {
            paymentMethodText = paymentMethod
            initialSuggestedPaymentMethod = paymentMethod
            markAsMachineSuggested(.paymentMethod)
        }

        var alternatives: [ServerAmountAlternative] = []
        for entry in serverMoneyEntries(server) {
            guard let cents = entry.cents else { continue }
            guard !touchedFields.contains(entry.suggested) else { continue }
            switch entry.input {
            case .empty:
                applyMachineSuggestedAmount(entry.field, cents: cents)
            case .cents(let current) where current != cents:
                alternatives.append(ServerAmountAlternative(field: entry.field, cents: cents))
            case .cents, .invalid:
                break
            }
        }
        serverAmountAlternatives = alternatives
    }

    private func serverMoneyEntries(
        _ server: ConfirmSuggestionSet
    ) -> [(field: DerivableMoneyField, suggested: SuggestedField, cents: Int?, input: MoneyInput)] {
        [
            (.total, .total, server.totalCents, totalInput),
            (.subtotal, .subtotal, server.subtotalCents, subtotalInput),
            (.hst, .hst, server.hstCents, hstInput),
            (.tip, .tip, server.tipCents, tipInput),
            (.otherFees, .otherFees, server.otherFeesCents, otherFeesInput),
        ]
    }

    /// The chip's own words - named, not bare, exactly as proposal #1's
    /// derived-fill buttons are and for the same stated reason: a person
    /// must be able to read what a tap will do before they make it.
    func serverAlternativeLabel(_ alternative: ServerAmountAlternative) -> String {
        let amount = ReceiptFormat.money(cents: alternative.cents, currency: currency)
        let name: String
        switch alternative.field {
        case .total: name = "the total"
        case .subtotal: name = "the subtotal"
        case .hst: name = "HST"
        case .tip: name = "the tip"
        case .otherFees: name = "other fees"
        }
        return "Server read \(name) as \(amount) - use it"
    }

    /// Applies one chip and removes it. The same bookkeeping every other
    /// machine-suggested amount gets, so tapping this is reported at save
    /// exactly like accepting a prefill.
    @discardableResult
    func applyServerAlternative(_ alternative: ServerAmountAlternative) -> Bool {
        guard serverAmountAlternatives.contains(alternative) else { return false }
        applyMachineSuggestedAmount(alternative.field, cents: alternative.cents)
        serverAmountAlternatives.removeAll { $0 == alternative }
        return true
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

    // MARK: - Acknowledging a large mismatch (2026-09-01)

    /// A mismatch smaller than this is not worth stopping anyone over:
    /// a merchant's own rounding line, a coupon printed without an
    /// amount, a cent of independent rounding between the tax line and
    /// the total.
    private static let acknowledgementFloorCents = 100
    /// …and above a dollar, proportion is the better measure: a $2 gap on
    /// a $12 lunch is a different animal from a $2 gap on a $400 grocery
    /// run.
    private static let acknowledgementRateBps = 500

    /// How far the five boxes are from balancing right now, or nil when
    /// there is nothing to compare (no subtotal, no total, or a box
    /// mid-keystroke - the same suppression every other check here
    /// applies). Always non-negative: which direction the gap runs is
    /// `showsAmountFloorNote`'s question, not this one's.
    private var arithmeticGapCents: Int? {
        guard let fields = moneyFieldValues,
              let subtotal = fields.subtotal, let total = fields.total
        else { return nil }
        let components = subtotal + (fields.hst ?? 0) + (fields.tip ?? 0) + (fields.otherFees ?? 0)
        return abs(total - components)
    }

    /// Whether Save should stop and ask first (2026-09-01).
    ///
    /// **The evidence.** The advisory warning fired on all four real data
    /// errors in production and was ticked straight past every time - one
    /// of them a $218.94 Costco purchase confirmed at $8.50, its subtotal
    /// and HST both correct on the same slip. A note that is always
    /// dismissible and never in the way is a note that stops being read;
    /// the remedy is one extra tap on the receipts that are actually
    /// impossible, not a louder note on all of them.
    ///
    /// Fires on either of the two facts worth a tap: the total is below
    /// its own components (`checkAmountFloor` - no receipt does that), or
    /// the gap exceeds the larger of $1.00 and 5% of the total.
    ///
    /// ⚠ **`.confirm` only, and `.edit` is exempt deliberately.** An
    /// already-confirmed receipt can legitimately not reconcile and stay
    /// that way forever: production holds a store-credit slip whose
    /// subtotal 104.93 + HST 13.65 sit against a total of 28.21, which is
    /// what the paper says. Making someone acknowledge that every time
    /// they fix a typo in its category would train the acknowledgement out
    /// of meaning anything, which is the very failure this exists to
    /// correct.
    ///
    /// Never a block: the dialog's other button saves anyway. Constraint 2
    /// cuts both ways - a person who reads the paper and types what it
    /// says must always be able to save it.
    var saveNeedsAcknowledgement: Bool {
        guard purpose == .confirm else { return false }
        if showsAmountFloorNote { return true }
        guard let gap = arithmeticGapCents, let fields = moneyFieldValues, let total = fields.total else {
            return false
        }
        // Integer arithmetic, never a float: 5% of the total in basis
        // points, floored, against the flat dollar floor. A total large
        // enough to overflow the multiply is one no threshold could be
        // exceeded on, so the flat floor stands alone there.
        let (scaled, overflowed) = abs(total).multipliedReportingOverflow(by: Self.acknowledgementRateBps)
        let proportional = overflowed ? Int.max : scaled / 10_000
        return gap > max(Self.acknowledgementFloorCents, proportional)
    }

    /// What the acknowledgement dialog asks, with the gap named - the same
    /// "state the arithmetic, never just a button" rule every affordance
    /// on this screen follows.
    var saveAcknowledgementMessage: String? {
        guard saveNeedsAcknowledgement, let gap = arithmeticGapCents else { return nil }
        return "These amounts don't add up (off by \(ReceiptFormat.money(cents: gap, currency: currency))). Save anyway?"
    }

    /// Whether this form can offer to bin the receipt instead of
    /// confirming it (2026-09-01).
    ///
    /// The confirm queue used to be the one route to a pending receipt
    /// with no way out but "Later" or "Save": a scan of the wrong thing,
    /// or a page that photographed unreadably, kept coming back every
    /// time the badge was tapped, and the only remedy was to leave the
    /// queue, find the row on Home and delete it from the detail screen.
    /// The per-receipt route always had Delete; this is the queue catching
    /// up to it.
    ///
    /// `.edit` is excluded deliberately: that form is only ever reached
    /// from the detail screen, which is already showing a Delete button of
    /// its own two taps away, and a second one inside the sheet would be
    /// two ways to do one thing on one screen.
    var canDelete: Bool {
        deleteAction != nil && purpose == .confirm
    }

    /// Soft-deletes this receipt (spec §10B: tombstoned, the bytes kept
    /// for retention - not erased). Returns whether it succeeded, the same
    /// shape as `save()` above and as ReceiptDetailModel.delete(id:), so
    /// the view advances only on a real success rather than guessing from
    /// state.
    func delete() async -> Bool {
        guard let deleteAction, !isDeleting else { return false }
        isDeleting = true
        deleteError = nil
        defer { isDeleting = false }

        do {
            try await deleteAction()
            return true
        } catch {
            deleteError = error.localizedDescription
            return false
        }
    }

    func clearDeleteError() {
        deleteError = nil
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
                notes: normalized(notesText),
                // Rides along harmlessly on a confirmation (2026-09-01): a
                // confirmed receipt is served no suggestions at all, so
                // nothing consumes the set. Sent anyway so the two writes
                // this form can make differ in as little as possible -
                // the web's `patchForConfirm` makes the same call.
                reviewedFields: reviewedFieldsForSave
            ))
            hasSaved = true
            return true
        } catch {
            saveError = error.localizedDescription
            return false
        }
    }

    // MARK: - Save for later (2026-09-01)

    /// Whether this form can write what is on it without confirming it.
    /// Server-backed `.confirm` forms only: a capture-time confirm has no
    /// row to half-write (its "Later" queues the whole scan pending
    /// instead, carrying `pendingReceiptFields()`), and `.edit` opens on a
    /// receipt that is already confirmed, where "later" means nothing.
    var canSaveForLater: Bool {
        saveForLaterAction != nil && purpose == .confirm
    }

    /// Why a save-for-later cannot go through, or nil.
    ///
    /// Deliberately NOT `saveBlocker`: a blank total is the entire point
    /// of this action - "let me enter partial info incrementally without
    /// saving the receipt as confirmed" (the owner, 2026-09-01) - and the
    /// server leaves `totalCents` nullable exactly as long as the receipt
    /// stays pending. What it does share is the refusal to write text it
    /// could not read: a form that quietly saves around an amount it
    /// cannot parse is the error-masking this repo hunts for, and the web
    /// makes the identical call (`patchForSaveForLater` still runs the
    /// money parser over every box and throws with the field named).
    var saveForLaterBlocker: String? {
        if totalInput == .invalid { return "The total isn't a valid amount." }
        if hstInput == .invalid { return "HST isn't a valid amount." }
        if subtotalInput == .invalid { return "The subtotal isn't a valid amount." }
        if tipInput == .invalid { return "The tip isn't a valid amount." }
        if otherFeesInput == .invalid { return "Other fees aren't a valid amount." }
        return nil
    }

    /// The half-way write: the REVIEWED fields' values and the reviewed
    /// set, and deliberately no `status`. The receipt stays pending, keeps
    /// its place in the queue and in the Home badge's count, and the
    /// fields just written stop being re-suggested.
    ///
    /// It is the write for a receipt someone got halfway through - the
    /// vendor and total are on the screen, the category needs a decision
    /// they cannot make now - and until this existed the only two ways out
    /// of this form were "confirm a receipt you are not sure about" and
    /// "lose what you typed" (the toolbar's "Later", which discards).
    ///
    /// ⚠ **Only the reviewed fields' values**, which is what makes it a
    /// halfway save rather than a quiet full one. This form is PREFILLED
    /// from the merge, so writing every field would put the parser's
    /// guesses into the row for everything nobody touched - the suggested
    /// total, the suggested vendor - and those values would stop being
    /// suggestions and start being the record. That is exactly what "no
    /// OCR value saves without a human confirming it" (constraint 2)
    /// forbids, and a save-for-later is by definition the moment nobody
    /// has confirmed them yet.
    ///
    /// ⚠ Not a confirmation and never a substitute for one. Nothing with
    /// `status = 'pending'` may appear in an export, and this write leaves
    /// it pending on purpose.
    func saveForLater() async -> Bool {
        guard let saveForLaterAction, purpose == .confirm else { return false }
        if let blocker = saveForLaterBlocker {
            saveError = blocker
            return false
        }
        guard !isSaving else { return false }

        isSaving = true
        saveError = nil
        defer { isSaving = false }

        do {
            try await saveForLaterAction(SaveForLaterRequest(
                reviewedFields: reviewedFieldsForSave,
                purchasedAt: ReceiptFormat.isoDate(fromPicker: purchasedDate),
                vendor: normalized(vendorText),
                subtotalCents: centsOrNil(subtotalInput),
                hstCents: centsOrNil(hstInput),
                tipCents: centsOrNil(tipInput),
                otherFeesCents: centsOrNil(otherFeesInput),
                totalCents: centsOrNil(totalInput),
                category: normalized(categoryText),
                paymentMethod: normalized(paymentMethodText),
                notes: normalized(notesText)
            ))
            hasSaved = true
            return true
        } catch {
            saveError = error.localizedDescription
            return false
        }
    }

    /// The same half-filled form, for a receipt that does not exist
    /// server-side yet: the capture screen's "Later" (2026-09-01).
    ///
    /// Until now that exit discarded whatever had been typed - the scan
    /// was queued pending carrying the parser's snapshot alone, and the
    /// vendor someone had just corrected was gone. This hands those values
    /// to the outbox so the create writes them into the row and reports
    /// them reviewed, exactly as a save-for-later PATCH would on a receipt
    /// that had already uploaded.
    ///
    /// `nil` when nothing has been reviewed at all, which is the ordinary
    /// case (a person who scans and immediately taps Later): the create
    /// body is then byte-identical to what it was before this existed.
    func pendingReceiptFields() -> PendingReceiptFields? {
        let reviewed = reviewedFieldsForSave
        guard !reviewed.isEmpty else { return nil }
        return PendingReceiptFields(
            reviewedFields: reviewed,
            purchasedAt: ReceiptFormat.isoDate(fromPicker: purchasedDate),
            vendor: normalized(vendorText),
            subtotalCents: centsOrNil(subtotalInput),
            hstCents: centsOrNil(hstInput),
            tipCents: centsOrNil(tipInput),
            otherFeesCents: centsOrNil(otherFeesInput),
            totalCents: centsOrNil(totalInput),
            category: normalized(categoryText),
            paymentMethod: normalized(paymentMethodText),
            notes: normalized(notesText)
        )
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

/// Which SuggestedField carries this money field's suggestion - kept
/// here rather than on ReceiptArithmetic.swift's own enum, so that file
/// stays exactly what §10.2 asks of a pure computation module (no
/// knowledge of ConfirmReceiptModel or the view layer above it).
/// Which SuggestedField a server-side reviewed-field name refers to -
/// nil for `notes`, the one field on the form no suggestion has ever
/// covered. Kept here rather than on ReviewedField.swift for the same
/// reason as the extension below: that file mirrors a server vocabulary
/// and has no business knowing about this screen's own enums.
private extension ReviewedField {
    var suggestedField: ConfirmReceiptModel.SuggestedField? {
        switch self {
        case .purchasedAt: return .date
        case .vendor: return .vendor
        case .subtotalCents: return .subtotal
        case .hstCents: return .hst
        case .tipCents: return .tip
        case .otherFeesCents: return .otherFees
        case .totalCents: return .total
        case .category: return .category
        case .paymentMethod: return .paymentMethod
        case .notes: return nil
        }
    }
}

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
