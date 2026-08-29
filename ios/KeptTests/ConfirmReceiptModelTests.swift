import UIKit
import XCTest
@testable import Kept

/// The confirm screen's state logic without a camera or a view: amber
/// starts on every prefilled suggestion, clears permanently on touch, the
/// counter follows, arithmetic warns without blocking, and save is
/// disabled - with the reason stated - until there is a valid total.
/// The same form opened to edit an already-confirmed receipt carries no
/// amber at all.
@MainActor
final class ConfirmReceiptModelTests: XCTestCase {
    private var api: StubKeptAPI!

    override func setUp() async throws {
        try await super.setUp()
        api = StubKeptAPI()
    }

    private func model(receipt: Receipt) -> ConfirmReceiptModel {
        ConfirmReceiptModel(api: api, detail: Fixtures.detail(receipt: receipt))
    }

    /// A batch-scanned pending receipt as wave 4 creates it: parser values
    /// present, nothing a human has confirmed.
    private func scannedReceipt(
        totalCents: Int? = 11300,
        vendor: String? = "Maple Foods",
        hstCents: Int? = 1300,
        subtotalCents: Int? = 10000,
        tipCents: Int? = nil,
        otherFeesCents: Int? = nil,
        suggestions: MergedSuggestions? = nil
    ) -> Receipt {
        Fixtures.receipt(
            vendor: vendor,
            subtotalCents: subtotalCents,
            hstCents: hstCents,
            tipCents: tipCents,
            otherFeesCents: otherFeesCents,
            totalCents: totalCents,
            status: .pending,
            suggestions: suggestions
        )
    }

    /// The served merge matching scannedReceipt(): everything on the
    /// receipt is a parser's work, date included.
    private func matchingSuggestions(
        dateDisagreement: Bool = false,
        hstDisagreement: Bool = false
    ) -> MergedSuggestions {
        Fixtures.merged(
            vendor: "Maple Foods",
            purchasedAt: "2026-03-20",
            dateDisagreement: dateDisagreement,
            totalCents: 11300,
            hstCents: 1300,
            hstDisagreement: hstDisagreement,
            subtotalCents: 10000
        )
    }

    // MARK: - Amber

    func testEverySuggestedFieldStartsUnreviewed() {
        let model = model(receipt: scannedReceipt(suggestions: matchingSuggestions()))
        XCTAssertTrue(model.isUnreviewed(.total))
        XCTAssertTrue(model.isUnreviewed(.date)) // always prefilled
        XCTAssertTrue(model.isUnreviewed(.vendor))
        XCTAssertTrue(model.isUnreviewed(.hst))
        XCTAssertTrue(model.isUnreviewed(.subtotal))
        XCTAssertEqual(model.unreviewedCount, 5)
        XCTAssertFalse(model.dateIsCaptureDayFallback) // a date was parsed
    }

    func testRowOnlyValueIsNotMarkedAsAMachineSuggestion() {
        // The merge served only date and total; the vendor on the row was
        // written by something other than a parser (a partial PATCH,
        // another client) and must not carry the machine-suggestion amber
        // - and it still prefills, because the row is the fallback where
        // no suggestion covers a field.
        let model = model(receipt: scannedReceipt(
            suggestions: Fixtures.merged(purchasedAt: "2026-03-20", totalCents: 11300)
        ))
        XCTAssertTrue(model.isUnreviewed(.total))
        XCTAssertFalse(model.isUnreviewed(.vendor))
        XCTAssertFalse(model.isUnreviewed(.hst))
        XCTAssertEqual(model.vendorText, "Maple Foods")
        XCTAssertEqual(model.unreviewedCount, 2) // total + date
    }

    func testServedSuggestionWinsThePrefillOverTheRowCopy() {
        // The row's vendor is the capture-time heuristic snapshot
        // ("Basics"); the served merge carries the better read. Rendering
        // the row copy would un-take the §7.3 merge decision client-side.
        let model = model(receipt: scannedReceipt(
            vendor: "Basics",
            suggestions: Fixtures.merged(vendor: "Food Basics", purchasedAt: "2026-03-22")
        ))
        XCTAssertEqual(model.vendorText, "Food Basics")
        XCTAssertTrue(model.isUnreviewed(.vendor))
        // The date too: the merge's read outranks the row's copy.
        XCTAssertEqual(ReceiptFormat.isoDate(fromPicker: model.purchasedDate), "2026-03-22")
    }

    func testFallbackDateIsCalledOut() {
        // The merge exists but carries no date: the prefill is the capture
        // day, and the screen must say so rather than pass it off as read.
        let model = model(receipt: scannedReceipt(
            suggestions: Fixtures.merged(totalCents: 11300)
        ))
        XCTAssertTrue(model.dateIsCaptureDayFallback)
        XCTAssertTrue(model.isUnreviewed(.date))
    }

    func testWithoutASuggestionSetPresenceIsTheProxy() {
        // A receipt neither parser ever saw serves suggestions: null;
        // value-presence is the only signal left, and no fabrication
        // claim is made about the date.
        let model = model(receipt: scannedReceipt())
        XCTAssertTrue(model.isUnreviewed(.total))
        XCTAssertTrue(model.isUnreviewed(.vendor))
        XCTAssertFalse(model.dateIsCaptureDayFallback)
        XCTAssertEqual(model.unreviewedCount, 5)
    }

    func testAbsentValuesAreNotSuggestions() {
        let model = model(receipt: scannedReceipt(
            totalCents: nil, vendor: nil, hstCents: nil, subtotalCents: nil,
            suggestions: Fixtures.merged()
        ))
        // Only the date (capture-day fallback) is prefilled.
        XCTAssertEqual(model.unreviewedCount, 1)
        XCTAssertTrue(model.isUnreviewed(.date))
        XCTAssertTrue(model.dateIsCaptureDayFallback)
    }

    func testMergeAbsentMoneyPrefillsEmptyForTheStatedAbsencePlaceholder() {
        // §7.3's no-fallthrough rule: a heuristic-absent amount is served
        // {value: null} and must reach the screen as a stated absence -
        // the field's text stays empty, which is exactly when the view's
        // "Not found" placeholder shows - never as a fabricated value.
        let model = model(receipt: scannedReceipt(
            totalCents: nil, hstCents: nil, subtotalCents: nil,
            suggestions: Fixtures.merged(vendor: "Maple Foods", purchasedAt: "2026-03-20")
        ))
        XCTAssertEqual(model.totalText, "")
        XCTAssertEqual(model.hstText, "")
        XCTAssertEqual(model.subtotalText, "")
        XCTAssertFalse(model.isUnreviewed(.total))
        XCTAssertFalse(model.isUnreviewed(.hst))
        XCTAssertFalse(model.isUnreviewed(.subtotal))
    }

    // MARK: - Tip and other fees (2026-08-28)

    func testTipStartsAmberLikeEveryOtherSuggestedField() {
        // Tip gets the full suggestion treatment: amber until touched,
        // exactly like HST and subtotal.
        let model = model(receipt: scannedReceipt(
            suggestions: Fixtures.merged(purchasedAt: "2026-03-20", totalCents: 11300, tipCents: 1500)
        ))
        XCTAssertEqual(model.tipText, "15.00")
        XCTAssertTrue(model.isUnreviewed(.tip))

        model.markTouched(.tip)
        XCTAssertFalse(model.isUnreviewed(.tip))
    }

    func testNoTipSuggestionPrefillsEmptyForTheStatedAbsencePlaceholder() {
        let model = model(receipt: scannedReceipt(
            suggestions: Fixtures.merged(purchasedAt: "2026-03-20", totalCents: 11300)
        ))
        XCTAssertEqual(model.tipText, "")
        XCTAssertFalse(model.isUnreviewed(.tip))
    }

    /// Other fees never carries a suggestion (§6: no heuristic or LLM can
    /// match a residual amount with no consistent printed label), so it
    /// must never start amber - even when the row itself already carries
    /// a value, unlike every other money field, whose amber is driven by
    /// suggestion presence rather than by the field being non-empty. The
    /// header counter is the observable proof: a row value that could
    /// have inflated it (the way a row-only vendor does NOT, per
    /// testRowOnlyValueIsNotMarkedAsAMachineSuggestion) leaves the count
    /// exactly where it was without it.
    func testOtherFeesNeverStartsAmberEvenWithARowValuePresent() {
        let withoutOtherFees = model(receipt: scannedReceipt(
            suggestions: matchingSuggestions()
        ))
        let withOtherFees = model(receipt: scannedReceipt(
            otherFeesCents: 500,
            suggestions: matchingSuggestions()
        ))
        XCTAssertEqual(withOtherFees.otherFeesText, "5.00")
        XCTAssertEqual(withOtherFees.unreviewedCount, withoutOtherFees.unreviewedCount)
    }

    // MARK: - Date disagreement (§7.3)

    func testDateDisagreementNoteShowsAndClearsWithTheTint() {
        let model = model(receipt: scannedReceipt(
            suggestions: matchingSuggestions(dateDisagreement: true)
        ))
        XCTAssertTrue(model.showsDateDisagreementNote)
        XCTAssertTrue(model.isUnreviewed(.date))

        // Touching another field is not looking at the date.
        model.markTouched(.vendor)
        XCTAssertTrue(model.showsDateDisagreementNote)

        // Touching the date clears the amber and the note together -
        // touched means a human looked and decided. Nothing brings either
        // back.
        model.markTouched(.date)
        XCTAssertFalse(model.showsDateDisagreementNote)
        XCTAssertFalse(model.isUnreviewed(.date))
    }

    func testNoDisagreementMeansNoNote() {
        let model = model(receipt: scannedReceipt(suggestions: matchingSuggestions()))
        XCTAssertTrue(model.isUnreviewed(.date)) // amber as always
        XCTAssertFalse(model.showsDateDisagreementNote)
    }

    // MARK: - HST disagreement (§7.3, 2026-08-28)

    func testHstDisagreementNoteShowsAndClearsWithTheTint() {
        let model = model(receipt: scannedReceipt(
            suggestions: matchingSuggestions(hstDisagreement: true)
        ))
        XCTAssertTrue(model.showsHstDisagreementNote)
        XCTAssertTrue(model.isUnreviewed(.hst))

        // Touching another field is not looking at HST.
        model.markTouched(.vendor)
        XCTAssertTrue(model.showsHstDisagreementNote)

        // Touching HST clears the amber and the note together, exactly
        // the date note's rule.
        model.markTouched(.hst)
        XCTAssertFalse(model.showsHstDisagreementNote)
        XCTAssertFalse(model.isUnreviewed(.hst))
    }

    func testNoHstDisagreementMeansNoNote() {
        let model = model(receipt: scannedReceipt(suggestions: matchingSuggestions()))
        XCTAssertTrue(model.isUnreviewed(.hst)) // amber, a suggestion exists
        XCTAssertFalse(model.showsHstDisagreementNote)
    }

    /// The disagreement flag never changes the served value - only the
    /// note. The heuristic's 1300 is what prefills either way (§7.3's
    /// no-fallthrough rule for amounts is unaffected by the new flag).
    func testHstDisagreementDoesNotChangeThePrefilledValue() {
        let model = model(receipt: scannedReceipt(
            suggestions: matchingSuggestions(hstDisagreement: true)
        ))
        XCTAssertEqual(model.hstText, "13.00")
    }

    func testCaptureTimeConfirmHasNoServerSuggestionsAndNoDisagreement() async {
        // The capture-time confirm is local-backed: no server row, so the
        // injected suggestion set is the on-device parse alone and a
        // disagreement is structurally impossible. The form still works
        // end to end against its injected save action.
        var suggestions = ReceiptSuggestions()
        suggestions.totalCents = 4520
        suggestions.purchasedAt = "2026-03-20"
        let draft = CapturedReceiptDraft(
            imageData: Data("scan".utf8),
            suggestions: suggestions,
            ocrRawText: "TOTAL 45.20",
            capturedAt: Date(timeIntervalSince1970: 1_774_000_000),
            ocrFailureNote: nil
        )
        var savedFields: ConfirmedReceiptFields?
        let model = ConfirmReceiptModel(draft: draft) { savedFields = $0 }

        XCTAssertNil(model.receiptId)
        XCTAssertFalse(model.showsDateDisagreementNote)
        XCTAssertFalse(model.showsHstDisagreementNote)
        XCTAssertTrue(model.isUnreviewed(.date))
        XCTAssertEqual(model.totalText, "45.20")
        XCTAssertFalse(model.isUnreviewed(.vendor)) // nothing suggested

        let saved = await model.save()
        XCTAssertTrue(saved)
        XCTAssertEqual(savedFields?.totalCents, 4520)
        XCTAssertEqual(savedFields?.purchasedAt, "2026-03-20")
    }

    func testTouchingAFieldClearsItsAmberPermanently() {
        let model = model(receipt: scannedReceipt())
        model.markTouched(.total)
        XCTAssertFalse(model.isUnreviewed(.total))
        XCTAssertEqual(model.unreviewedCount, 4)
        // Touching again changes nothing; there is no way back to amber.
        model.markTouched(.total)
        XCTAssertEqual(model.unreviewedCount, 4)
    }

    // MARK: - Prefill

    func testFormPrefillsFromTheReceipt() {
        let model = model(receipt: scannedReceipt())
        XCTAssertEqual(model.totalText, "113.00")
        XCTAssertEqual(model.vendorText, "Maple Foods")
        XCTAssertEqual(model.hstText, "13.00")
        XCTAssertEqual(model.subtotalText, "100.00")
        // No suggestion and no row value for either: both start blank,
        // same as every other field with nothing behind it.
        XCTAssertEqual(model.tipText, "")
        XCTAssertEqual(model.otherFeesText, "")
        // The free-text fields the row never carried stay blank; nothing
        // on this form is pre-selected on the person's behalf.
        XCTAssertEqual(model.categoryText, "")
        XCTAssertEqual(model.paymentMethodText, "")
        XCTAssertEqual(model.notesText, "")
    }

    // MARK: - Arithmetic

    func testArithmeticWarningWhenPartsDoNotReachTotal() {
        let model = model(receipt: scannedReceipt(totalCents: 11300, hstCents: 1300, subtotalCents: 10000))
        XCTAssertFalse(model.showsArithmeticWarning) // 100 + 13 = 113

        model.hstText = "14.00"
        XCTAssertTrue(model.showsArithmeticWarning)

        // Never blocking: the warning coexists with a saveable form.
        XCTAssertTrue(model.canSave)
    }

    func testNoArithmeticWarningWithoutASubtotalToCompare() {
        let model = model(receipt: scannedReceipt(subtotalCents: nil))
        XCTAssertFalse(model.showsArithmeticWarning)
    }

    func testBlankHstCountsAsZeroInTheCheck() {
        let model = model(receipt: scannedReceipt(totalCents: 10000, hstCents: nil, subtotalCents: 10000))
        XCTAssertFalse(model.showsArithmeticWarning) // 100 + nothing = 100
    }

    /// The restaurant case that motivated this work (2026-08-28): a
    /// tipped receipt whose subtotal + HST alone never reached the total
    /// under the 2026-08-26 field reduction, which knowingly accepted the
    /// warning as the cost of having nowhere to put a tip. With tip back
    /// as its own field, the same receipt now reconciles.
    func testRestaurantReceiptWithTipReconciles() {
        // Pasta+wine 84.00, HST 10.92, tip 15.00 = 109.92 total.
        let model = model(receipt: scannedReceipt(
            totalCents: 10992, hstCents: 1092, subtotalCents: 8400, tipCents: 1500
        ))
        XCTAssertFalse(model.showsArithmeticWarning)

        // Blank the tip and the same receipt is back to warning - proof
        // the check is actually summing it, not just always passing.
        model.tipText = ""
        XCTAssertTrue(model.showsArithmeticWarning)
    }

    func testArithmeticCheckOverAllFourComponents() {
        // 100 subtotal + 13 HST + 15 tip + 5 other fees = 133 total.
        let model = model(receipt: scannedReceipt(
            totalCents: 13300, hstCents: 1300, subtotalCents: 10000,
            tipCents: 1500, otherFeesCents: 500
        ))
        XCTAssertFalse(model.showsArithmeticWarning)

        model.otherFeesText = "6.00"
        XCTAssertTrue(model.showsArithmeticWarning)
    }

    func testBlankTipAndOtherFeesBothCountAsZeroInTheCheck() {
        let model = model(receipt: scannedReceipt(totalCents: 11300, hstCents: 1300, subtotalCents: 10000))
        XCTAssertFalse(model.showsArithmeticWarning) // 100 + 13 + nothing + nothing = 113
    }

    func testInvalidTipOrOtherFeesSuppressesTheWarningRatherThanGuessing() {
        // An invalid amount is its own stated problem (saveBlocker); the
        // arithmetic check does not also warn about garbage it cannot sum.
        let model = model(receipt: scannedReceipt(totalCents: 11300, hstCents: 1300, subtotalCents: 10000))
        model.tipText = "abc"
        XCTAssertFalse(model.showsArithmeticWarning)
    }

    // MARK: - Derived amounts (proposal #1, 2026-08-28)

    /// Exactly one field blank (tip), the other four filled: the fill
    /// offers 15.00, and the label names the field before anyone taps
    /// anything - the proposal's own risk mitigation.
    func testDerivedFillOffersTheMissingTip() {
        // subtotal 100 + hst 13 + otherFees 5 = 118; total 133 -> tip 15.
        let model = model(receipt: scannedReceipt(
            totalCents: 13300, hstCents: 1300, subtotalCents: 10000,
            tipCents: nil, otherFeesCents: 500
        ))
        XCTAssertEqual(model.derivableFill, DerivedAmount(field: .tip, cents: 1500))
        XCTAssertTrue(
            model.derivableFillLabel?.hasPrefix("Tip = Total − Subtotal − HST − Other fees") ?? false
        )
    }

    /// Computing the suggestion is not applying it - the field and its
    /// amber state are untouched until the explicit tap.
    func testDerivedFillIsNotAppliedWithoutTheExplicitTap() {
        let model = model(receipt: scannedReceipt(
            totalCents: 13300, hstCents: 1300, subtotalCents: 10000,
            tipCents: nil, otherFeesCents: 500
        ))
        XCTAssertNotNil(model.derivableFill) // a suggestion exists...
        XCTAssertEqual(model.tipText, "") // ...but nothing has filled it in
        XCTAssertFalse(model.isUnreviewed(.tip))
    }

    /// The tap itself: fills the text, marks it amber exactly like an OCR
    /// suggestion, and - because the receipt now reconciles - the
    /// affordance itself disappears.
    func testApplyingTheDerivedFillFillsTheFieldAndMarksItAmber() {
        let model = model(receipt: scannedReceipt(
            totalCents: 13300, hstCents: 1300, subtotalCents: 10000,
            tipCents: nil, otherFeesCents: 500
        ))
        XCTAssertTrue(model.applyDerivedFill())
        XCTAssertEqual(model.tipText, "15.00")
        XCTAssertTrue(model.isUnreviewed(.tip))
        XCTAssertFalse(model.showsArithmeticWarning)
        XCTAssertNil(model.derivableFill, "nothing left to derive once it reconciles")
    }

    /// Two fields missing at once: nothing to offer, nothing to apply.
    func testApplyDerivedFillDoesNothingWhenNoSuggestionExists() {
        let model = model(receipt: scannedReceipt(
            totalCents: 13300, hstCents: 1300, subtotalCents: 10000,
            tipCents: nil, otherFeesCents: nil
        ))
        XCTAssertNil(model.derivableFill)
        XCTAssertFalse(model.applyDerivedFill())
        XCTAssertEqual(model.tipText, "")
        XCTAssertEqual(model.otherFeesText, "")
    }

    /// The derived fill's own never-negative refusal, mirrored end to end
    /// through the live path: a receipt whose four known fields already
    /// sum past the total would derive a negative tip, and offers nothing.
    func testDerivedFillRefusesANegativeTip() {
        let model = model(receipt: scannedReceipt(
            totalCents: 11000, hstCents: 1300, subtotalCents: 10000,
            tipCents: nil, otherFeesCents: 0
        ))
        XCTAssertNil(model.derivableFill)
        XCTAssertNil(model.derivableFillLabel)
    }

    /// Applies just as well to the receipt-detail edit form (spec: "this
    /// belongs on the receipt detail edit form too, not just the confirm
    /// screen") - even though nothing else on an edit form is amber, a
    /// derived fill still marks its field amber and stays reportable.
    func testDerivedFillWorksOnTheEditForm() {
        let receipt = Fixtures.receipt(
            subtotalCents: 10000, hstCents: 1300, tipCents: 0,
            otherFeesCents: nil, totalCents: 11300, status: .confirmed
        )
        let model = ConfirmReceiptModel(api: api, detail: Fixtures.detail(receipt: receipt), purpose: .edit)
        XCTAssertEqual(model.unreviewedCount, 0) // nothing amber on open

        XCTAssertEqual(model.derivableFill, DerivedAmount(field: .otherFees, cents: 0))
        XCTAssertTrue(model.applyDerivedFill())
        XCTAssertEqual(model.otherFeesText, "0.00")
        XCTAssertTrue(model.isUnreviewed(.otherFees))
        XCTAssertEqual(model.unreviewedCount, 1)
    }

    // MARK: - Reconciliation split (proposal #1, second affordance)

    /// All five present but mismatched: both destinations are offered,
    /// each naming the resulting total it would produce.
    func testReconciliationOffersBothDestinationsWhenAllFiveAreFilled() {
        // 100 + 13 + 10 + 0 = 123; total is 133 - 10.00 short.
        let model = model(receipt: scannedReceipt(
            totalCents: 13300, hstCents: 1300, subtotalCents: 10000,
            tipCents: 1000, otherFeesCents: 0
        ))
        XCTAssertNil(model.derivableFill, "nothing is blank, so this is not the derive-fill case")
        XCTAssertEqual(model.reconciliationResult(for: .tip), 2000) // 10.00 existing + 10.00
        XCTAssertEqual(model.reconciliationResult(for: .otherFees), 1000) // 0 existing + 10.00
        XCTAssertNotNil(model.reconciliationLabel(for: .tip))
        XCTAssertNotNil(model.reconciliationLabel(for: .otherFees))
    }

    func testApplyingTheReconciliationDifferenceAddsToTheExistingValue() {
        let model = model(receipt: scannedReceipt(
            totalCents: 13300, hstCents: 1300, subtotalCents: 10000,
            tipCents: 1000, otherFeesCents: 0
        ))
        XCTAssertTrue(model.applyReconciliationDifference(into: .tip))
        XCTAssertEqual(model.tipText, "20.00")
        XCTAssertTrue(model.isUnreviewed(.tip))
        XCTAssertFalse(model.showsArithmeticWarning)
        // Now balanced - nothing left to offer for other fees either.
        XCTAssertNil(model.reconciliationResult(for: .otherFees))
    }

    func testNoReconciliationOfferedWhenTheBooksAlreadyBalance() {
        let model = model(receipt: scannedReceipt(
            totalCents: 11300, hstCents: 1300, subtotalCents: 10000,
            tipCents: 0, otherFeesCents: 0
        ))
        XCTAssertNil(model.reconciliationResult(for: .tip))
        XCTAssertNil(model.reconciliationResult(for: .otherFees))
        XCTAssertFalse(model.applyReconciliationDifference(into: .tip))
    }

    /// The same never-negative floor `deriveMissingAmount` enforces,
    /// applied here even though there is no server function to mirror it
    /// from: fields that already sum PAST the total would need to
    /// subtract from tip and other fees, which would leave both negative,
    /// so neither destination is offered.
    func testReconciliationRefusesADestinationThatWouldGoNegative() {
        // 100 + 13 + 5 + 0 = 118; total is only 100.00 - 18.00 over.
        let model = model(receipt: scannedReceipt(
            totalCents: 10000, hstCents: 1300, subtotalCents: 10000,
            tipCents: 500, otherFeesCents: 0
        ))
        XCTAssertNil(model.reconciliationResult(for: .tip))
        XCTAssertNil(model.reconciliationResult(for: .otherFees))
        XCTAssertNil(model.reconciliationLabel(for: .tip))
        XCTAssertFalse(model.applyReconciliationDifference(into: .tip))
    }

    // MARK: - Vendor defaults (proposal #2, 2026-08-28)

    func testVendorDefaultPrefillsBothEmptyFields() {
        let model = model(receipt: scannedReceipt()) // vendor "Maple Foods"
        XCTAssertEqual(model.categoryText, "")
        XCTAssertEqual(model.paymentMethodText, "")

        model.applyVendorDefaultIfAvailable([
            "Maple Foods": VendorDefault(category: "Groceries", paymentMethod: "Visa"),
        ])

        XCTAssertEqual(model.categoryText, "Groceries")
        XCTAssertEqual(model.paymentMethodText, "Visa")
        XCTAssertTrue(model.isUnreviewed(.category))
        XCTAssertTrue(model.isUnreviewed(.paymentMethod))
    }

    /// Independently per field: a vendor default with only one of the two
    /// fields still offers that one.
    func testVendorDefaultAppliesFieldsIndependently() {
        let model = model(receipt: scannedReceipt())
        model.applyVendorDefaultIfAvailable([
            "Maple Foods": VendorDefault(category: "Groceries", paymentMethod: nil),
        ])
        XCTAssertEqual(model.categoryText, "Groceries")
        XCTAssertEqual(model.paymentMethodText, "")
        XCTAssertFalse(model.isUnreviewed(.paymentMethod))
    }

    /// The named risk this whole affordance exists beside: never overwrite
    /// what the person already typed.
    func testVendorDefaultNeverOverwritesAnAlreadyTypedValue() {
        let model = model(receipt: scannedReceipt())
        model.categoryText = "Already typed"

        model.applyVendorDefaultIfAvailable([
            "Maple Foods": VendorDefault(category: "Groceries", paymentMethod: "Visa"),
        ])

        XCTAssertEqual(model.categoryText, "Already typed")
        XCTAssertFalse(model.isUnreviewed(.category))
        // The untyped field beside it still gets its default.
        XCTAssertEqual(model.paymentMethodText, "Visa")
    }

    /// Exact, unnormalized match only - a case or whitespace difference is
    /// a different string and matches nothing (2026-08-26 ruling).
    func testVendorDefaultRequiresAnExactMatch() {
        let model = model(receipt: scannedReceipt()) // vendor "Maple Foods"
        model.applyVendorDefaultIfAvailable([
            "maple foods": VendorDefault(category: "Groceries", paymentMethod: "Visa"),
        ])
        XCTAssertEqual(model.categoryText, "")

        model.applyVendorDefaultIfAvailable([
            "Maple Foods ": VendorDefault(category: "Groceries", paymentMethod: "Visa"),
        ])
        XCTAssertEqual(model.categoryText, "")
    }

    /// Never overwrites a confirmed receipt's existing values - the edit
    /// form's category is the person's own, already-saved choice.
    func testVendorDefaultNeverOverwritesAConfirmedReceiptsExistingCategory() {
        let receipt = Fixtures.receipt(
            vendor: "Maple Foods", totalCents: 11300, category: "Existing category", status: .confirmed
        )
        let model = ConfirmReceiptModel(api: api, detail: Fixtures.detail(receipt: receipt), purpose: .edit)

        model.applyVendorDefaultIfAvailable([
            "Maple Foods": VendorDefault(category: "Groceries", paymentMethod: "Visa"),
        ])

        XCTAssertEqual(model.categoryText, "Existing category")
        XCTAssertFalse(model.isUnreviewed(.category))
        // Payment method genuinely never carried a value on this confirmed
        // receipt - that is not "overwriting an existing value", so it
        // still gets prefilled and marked amber.
        XCTAssertEqual(model.paymentMethodText, "Visa")
        XCTAssertTrue(model.isUnreviewed(.paymentMethod))
    }

    /// Applied and left alone, a vendor default reports `suggestion_accepted`
    /// at save through the same accept/override mechanism every other
    /// suggestion on this screen uses.
    func testVendorDefaultLeftAloneReportsAcceptedAtSave() {
        let model = model(receipt: scannedReceipt())
        model.applyVendorDefaultIfAvailable([
            "Maple Foods": VendorDefault(category: "Groceries", paymentMethod: "Visa"),
        ])

        let outcomes = Dictionary(
            uniqueKeysWithValues: model.suggestionOutcomes().map { ($0.field, $0.accepted) }
        )
        XCTAssertEqual(outcomes[.category], true)
        XCTAssertEqual(outcomes[.paymentMethod], true)
    }

    /// Typed over after being applied, it reports `suggestion_overridden`
    /// instead - the same rule an OCR suggestion is held to.
    func testVendorDefaultOverriddenAfterApplyingReportsOverriddenAtSave() {
        let model = model(receipt: scannedReceipt())
        model.applyVendorDefaultIfAvailable([
            "Maple Foods": VendorDefault(category: "Groceries", paymentMethod: "Visa"),
        ])
        model.categoryText = "Something else"

        let outcomes = Dictionary(
            uniqueKeysWithValues: model.suggestionOutcomes().map { ($0.field, $0.accepted) }
        )
        XCTAssertEqual(outcomes[.category], false)
        XCTAssertEqual(outcomes[.paymentMethod], true)
    }

    /// Idempotent: calling it again after it already filled something -
    /// exactly what the view's onAppear/onChange wiring does - changes
    /// nothing further.
    func testVendorDefaultIsIdempotent() {
        let model = model(receipt: scannedReceipt())
        let defaults = ["Maple Foods": VendorDefault(category: "Groceries", paymentMethod: "Visa")]
        model.applyVendorDefaultIfAvailable(defaults)
        model.markTouched(.category) // the person looked at it
        model.applyVendorDefaultIfAvailable(defaults) // called again, e.g. on a re-fetch

        XCTAssertEqual(model.categoryText, "Groceries")
        XCTAssertFalse(model.isUnreviewed(.category), "a second call must not re-amber a field already touched")
    }

    /// No matching vendor, or a blank vendor field: nothing happens, and
    /// nothing crashes on an empty dictionary.
    func testVendorDefaultDoesNothingWithoutAMatch() {
        let model = model(receipt: scannedReceipt())
        model.applyVendorDefaultIfAvailable([:])
        model.applyVendorDefaultIfAvailable(["Some Other Vendor": VendorDefault(category: "X", paymentMethod: nil)])
        XCTAssertEqual(model.categoryText, "")
        XCTAssertEqual(model.paymentMethodText, "")
    }

    // MARK: - Save gating

    /// The gate is a valid total and nothing else (2026-08-26: the
    /// business-or-personal choice was retired with the field). A receipt
    /// whose parser found a total is saveable the moment the form opens -
    /// which is the point of the whole screen.
    func testAReceiptWithATotalIsSaveableAsItOpens() {
        let model = model(receipt: scannedReceipt())
        XCTAssertTrue(model.canSave)
        XCTAssertNil(model.saveBlocker)
    }

    func testSaveBlockedWithoutATotal() {
        let model = model(receipt: scannedReceipt(totalCents: nil))
        XCTAssertEqual(model.saveBlocker, "Enter the total to save.")

        model.totalText = "45.20"
        XCTAssertNil(model.saveBlocker)
    }

    func testSaveBlockedByInvalidMoneyTextWithTheFieldNamed() {
        let model = model(receipt: scannedReceipt())
        model.hstText = "abc"
        XCTAssertEqual(model.saveBlocker, "HST isn't a valid amount.")
    }

    // MARK: - Keyboard fields (§10A.1's dismissal rule)

    func testTheDecimalPadFieldsAreExactlyTheFiveMoneyFields() {
        let decimalPad = ConfirmReceiptModel.EditableField.allCases
            .filter(\.usesDecimalPad)
        XCTAssertEqual(
            Set(decimalPad),
            [.total, .hst, .subtotal, .tip, .otherFees]
        )
    }

    /// What the Done bar keys off, now read from the keyboard the field
    /// actually raises rather than from a hand-synced enum: a numeric pad
    /// has no return key, and a text view's return key inserts a newline.
    func testAKeyboardWithNoReturnKeyOfItsOwnIsRecognisedFromTheFieldItself() {
        let decimalPad = UITextField()
        decimalPad.keyboardType = .decimalPad
        XCTAssertTrue(decimalPad.keyboardHasNoExitOfItsOwn)

        let singleLineText = UITextField()
        singleLineText.keyboardType = .default
        XCTAssertFalse(singleLineText.keyboardHasNoExitOfItsOwn)

        XCTAssertTrue(UITextView().keyboardHasNoExitOfItsOwn)
    }

    /// The same question asked of the confirm screen's own fields, through
    /// the keyboard each one raises: the five decimal pads plus notes, and
    /// nothing else. A field falling out of this set would ship a keyboard
    /// nothing inside it can close - the device defect this pins.
    ///
    /// This builds the keyboard the way `SuggestedFieldRow` does rather
    /// than reading a property off the enum, because the property is the
    /// thing that drifted: other tax shipped with a decimal pad nothing
    /// could close (54286b6). Still a wiring test - it does not execute
    /// the bar, which lives in UIKit and is covered by `KeptUITests` and
    /// the device pass (§10.2).
    func testDoneIsOfferedToEveryKeyboardWithNoExitOfItsOwn() {
        func keyboardRaised(by field: ConfirmReceiptModel.EditableField) -> UIView {
            guard field != .notes else { return UITextView() }
            let textField = UITextField()
            textField.keyboardType = field.usesDecimalPad ? .decimalPad : .default
            return textField
        }
        let needsDone = ConfirmReceiptModel.EditableField.allCases
            .filter { keyboardRaised(by: $0).keyboardHasNoExitOfItsOwn }
        XCTAssertEqual(
            Set(needsDone),
            [.total, .hst, .subtotal, .tip, .otherFees, .notes]
        )
    }

    /// Focus clears exactly one field's amber, and the one field carrying
    /// no suggestion of any kind - notes - clears nothing.
    func testFocusMapsToTheSuggestionItClearsAndNoOther() {
        XCTAssertEqual(ConfirmReceiptModel.EditableField.total.suggestion, .total)
        XCTAssertEqual(ConfirmReceiptModel.EditableField.vendor.suggestion, .vendor)
        XCTAssertEqual(ConfirmReceiptModel.EditableField.hst.suggestion, .hst)
        XCTAssertEqual(ConfirmReceiptModel.EditableField.subtotal.suggestion, .subtotal)
        XCTAssertEqual(ConfirmReceiptModel.EditableField.tip.suggestion, .tip)
        // Other fees, category and payment method are money/free-text
        // fields that carry no OCR suggestion (§6) - but each maps to its
        // own SuggestedField now (2026-08-28), because each can still gain
        // the amber marking from a LIVE source (a proposal #1 derived
        // fill for other fees, a proposal #2 vendor default for the other
        // two) and focusing the field must clear it the same way focusing
        // any other suggested field does.
        XCTAssertEqual(ConfirmReceiptModel.EditableField.otherFees.suggestion, .otherFees)
        XCTAssertEqual(ConfirmReceiptModel.EditableField.category.suggestion, .category)
        XCTAssertEqual(ConfirmReceiptModel.EditableField.paymentMethod.suggestion, .paymentMethod)
        // Notes remains the one field with no suggestion of any kind.
        XCTAssertNil(ConfirmReceiptModel.EditableField.notes.suggestion)
    }

    /// Every amber-carrying field is still reachable by focus - except the
    /// date, which is a DatePicker and clears its tint on tap instead. A
    /// suggestion left unreachable would sit amber forever and hold the
    /// header counter above zero on a fully checked receipt.
    func testEverySuggestionExceptTheDateIsReachableByFocus() {
        let reachable = Set(
            ConfirmReceiptModel.EditableField.allCases.compactMap(\.suggestion)
        )
        XCTAssertEqual(
            reachable,
            Set(ConfirmReceiptModel.SuggestedField.allCases).subtracting([.date])
        )
    }

    // MARK: - Field-edit counting (behavioural telemetry, 2026-08-28)

    /// the owner's ask, verbatim: "a user editing the total amount repeatedly
    /// signals the total-extraction path is unreliable." Three separate
    /// focus-in/change/focus-out cycles on the total count as three edits;
    /// a single cycle on vendor counts as one - never one event per
    /// keystroke, which is what counting on `totalText`'s every mutation
    /// would produce instead.
    func testFieldEditCountingCountsPerFocusCycleNotPerKeystroke() {
        let model = model(receipt: scannedReceipt(suggestions: matchingSuggestions()))

        model.fieldDidGainFocus(.total)
        model.totalText = "120.00"
        model.fieldDidLoseFocus(.total)

        model.fieldDidGainFocus(.total)
        model.totalText = "125.00"
        model.fieldDidLoseFocus(.total)

        model.fieldDidGainFocus(.total)
        model.totalText = "130.00"
        model.fieldDidLoseFocus(.total)

        model.fieldDidGainFocus(.vendor)
        model.vendorText = "New Vendor"
        model.fieldDidLoseFocus(.vendor)

        XCTAssertEqual(model.fieldEditCounts[.total], 3)
        XCTAssertEqual(model.fieldEditCounts[.vendor], 1)
    }

    /// Focusing a field without changing it is looking, not editing -
    /// §10A.1's own distinction, reused here. A focus cycle with no
    /// change must not inflate the count.
    func testFocusingAFieldWithoutChangingItCountsNoEdit() {
        let model = model(receipt: scannedReceipt(suggestions: matchingSuggestions()))

        model.fieldDidGainFocus(.subtotal)
        model.fieldDidLoseFocus(.subtotal)

        XCTAssertNil(model.fieldEditCounts[.subtotal])
    }

    /// A field never explicitly given up focus (say, Save tapped while it
    /// is still the first responder) counts nothing for that dangling
    /// cycle - there is no matching `fieldDidLoseFocus` to compare
    /// against, and the conservative default is silence rather than a
    /// guess.
    func testAFieldThatNeverLosesFocusCountsNothingForThatCycle() {
        let model = model(receipt: scannedReceipt(suggestions: matchingSuggestions()))

        model.fieldDidGainFocus(.total)
        model.totalText = "999.00"

        XCTAssertNil(model.fieldEditCounts[.total])
    }

    /// The date field raises no keyboard and so has no focus cycle;
    /// `recordDateEdited()` counts each committed DatePicker change
    /// directly - already as coarse as a text field's focus cycle.
    func testDateEditCountingCountsEachChangeDirectly() {
        let model = model(receipt: scannedReceipt(suggestions: matchingSuggestions()))

        model.recordDateEdited()
        model.recordDateEdited()

        XCTAssertEqual(model.fieldEditCounts[.purchasedAt], 2)
    }

    // MARK: - Suggestion outcomes (behavioural telemetry, 2026-08-28)

    /// A field left exactly as suggested is accepted; one typed over is
    /// overridden - derived from the form's own prefill-vs-final-value
    /// state, not from whether the person happened to focus the field.
    func testSuggestionOutcomesDistinguishAcceptedFromOverridden() {
        let model = model(receipt: scannedReceipt(suggestions: matchingSuggestions()))

        // Vendor left exactly as suggested ("Maple Foods").
        // HST typed over.
        model.hstText = "14.00"

        let outcomes = Dictionary(
            uniqueKeysWithValues: model.suggestionOutcomes().map { ($0.field, $0.accepted) }
        )
        XCTAssertEqual(outcomes[.vendor], true)
        XCTAssertEqual(outcomes[.hst], false)
        // Every other suggested field (total, subtotal, the date) was
        // also left alone.
        XCTAssertEqual(outcomes[.total], true)
        XCTAssertEqual(outcomes[.subtotal], true)
        XCTAssertEqual(outcomes[.purchasedAt], true)
        // otherFees and tip carried no suggestion this session
        // (matchingSuggestions() leaves tip nil), so they report nothing.
        XCTAssertNil(outcomes[.otherFees])
        XCTAssertNil(outcomes[.tip])
    }

    /// Clearing a suggested field out entirely - not retyping it, just
    /// deleting it - is still an override: the final value (absent)
    /// differs from what was suggested.
    func testClearingASuggestedFieldCountsAsOverridden() {
        let model = model(receipt: scannedReceipt(suggestions: matchingSuggestions()))
        model.subtotalText = ""

        let outcomes = Dictionary(
            uniqueKeysWithValues: model.suggestionOutcomes().map { ($0.field, $0.accepted) }
        )
        XCTAssertEqual(outcomes[.subtotal], false)
    }

    /// `.edit` reopens a person's own already-confirmed values - nothing
    /// on that form was ever a suggestion, so there is nothing to accept
    /// or override.
    func testEditFormReportsNoSuggestionOutcomes() {
        let receipt = scannedReceipt(suggestions: matchingSuggestions())
        let model = ConfirmReceiptModel(
            api: api,
            detail: Fixtures.detail(receipt: receipt),
            purpose: .edit
        )
        XCTAssertTrue(model.suggestionOutcomes().isEmpty)
    }

    // MARK: - Saving

    func testSavePatchesEveryFieldAndConfirms() async {
        api.confirmReceiptHandler = { _, _ in Fixtures.receipt(status: .confirmed) }
        let model = model(receipt: scannedReceipt(tipCents: 1500, otherFeesCents: 250))
        model.vendorText = "  Maple Foods Market  "
        model.categoryText = "Groceries"
        model.paymentMethodText = "Visa"
        model.notesText = ""

        let saved = await model.save()
        XCTAssertTrue(saved)

        let call = api.confirmReceiptCalls.first
        XCTAssertEqual(call?.id, model.receiptId)
        // The untouched date round-trips exactly: the picker's Date came
        // from this string and goes back to it through the same UTC pin.
        XCTAssertEqual(call?.request.purchasedAt, "2026-03-20")
        XCTAssertEqual(call?.request.totalCents, 11300)
        XCTAssertEqual(call?.request.hstCents, 1300)
        XCTAssertEqual(call?.request.subtotalCents, 10000)
        XCTAssertEqual(call?.request.tipCents, 1500)
        XCTAssertEqual(call?.request.otherFeesCents, 250)
        XCTAssertEqual(call?.request.vendor, "Maple Foods Market") // trimmed
        XCTAssertEqual(call?.request.category, "Groceries")
        XCTAssertEqual(call?.request.paymentMethod, "Visa")
        XCTAssertNil(call?.request.notes) // blank is an absence, not ""
    }

    /// The wire shape, not just the struct: the three retired keys must be
    /// absent from the PATCH body. Sending them would be tolerated by the
    /// transitional server shim and silently discarded, which is exactly
    /// the kind of "it works" that hides a client that never got updated.
    /// tipCents and otherFeesCents are the opposite case - present and
    /// explicit-null-capable, never retired keys - asserted here too so a
    /// regression can't quietly turn "new field" into "another dropped one".
    func testThePatchBodyCarriesNoneOfTheRetiredKeysButBothNewOnes() async throws {
        api.confirmReceiptHandler = { _, _ in Fixtures.receipt(status: .confirmed) }
        let model = model(receipt: scannedReceipt())
        _ = await model.save()

        let request = try XCTUnwrap(api.confirmReceiptCalls.first?.request)
        let body = try XCTUnwrap(
            JSONSerialization.jsonObject(with: APIClient.encoder.encode(request)) as? [String: Any]
        )
        XCTAssertEqual(body["status"] as? String, "confirmed")
        XCTAssertNil(body["vendorTaxNumber"])
        XCTAssertNil(body["otherTaxCents"])
        XCTAssertNil(body["isBusiness"])
        // Present and explicit null (blank fields, this fixture), not
        // absent: the confirm form always sends the whole form, so a
        // blank tip or other-fees field means "clear it", not "leave it".
        XCTAssertTrue(body.keys.contains("tipCents"))
        XCTAssertTrue(body["tipCents"] is NSNull)
        XCTAssertTrue(body.keys.contains("otherFeesCents"))
        XCTAssertTrue(body["otherFeesCents"] is NSNull)
    }

    // MARK: - Editing a confirmed receipt (2026-08-26)

    func testEditingAConfirmedReceiptPrefillsFromTheRowWithNoAmber() {
        // The person's own confirmed values, shown back to them. Nothing
        // here is a machine suggestion, so nothing is amber - including
        // the date, which is amber on every confirm path.
        let receipt = Fixtures.receipt(
            purchasedAt: "2026-03-20",
            vendor: "Maple Foods",
            subtotalCents: 10000,
            hstCents: 1300,
            tipCents: 1500,
            otherFeesCents: 250,
            totalCents: 11300,
            category: "Groceries",
            paymentMethod: "Visa",
            notes: "weekly shop",
            status: .confirmed,
            // Confirmed rows are swept and served suggestions too; an edit
            // must not let a stale parse overwrite what a human confirmed.
            suggestions: Fixtures.merged(
                vendor: "Maple Foods Market",
                purchasedAt: "2026-03-22",
                totalCents: 99999,
                tipCents: 999
            )
        )
        let model = ConfirmReceiptModel(
            api: api,
            detail: Fixtures.detail(receipt: receipt),
            purpose: .edit
        )

        XCTAssertEqual(model.unreviewedCount, 0)
        XCTAssertFalse(model.isUnreviewed(.date))
        XCTAssertFalse(model.isUnreviewed(.vendor))
        XCTAssertFalse(model.isUnreviewed(.tip))
        XCTAssertFalse(model.dateIsCaptureDayFallback)
        XCTAssertFalse(model.showsDateDisagreementNote)
        XCTAssertFalse(model.showsHstDisagreementNote)
        XCTAssertEqual(model.vendorText, "Maple Foods")
        XCTAssertEqual(model.totalText, "113.00")
        // The person's own confirmed tip and other fees, not the stale
        // suggestion (999) still served alongside them.
        XCTAssertEqual(model.tipText, "15.00")
        XCTAssertEqual(model.otherFeesText, "2.50")
        XCTAssertEqual(ReceiptFormat.isoDate(fromPicker: model.purchasedDate), "2026-03-20")
        XCTAssertEqual(model.categoryText, "Groceries")
        XCTAssertEqual(model.paymentMethodText, "Visa")
        XCTAssertEqual(model.notesText, "weekly shop")
        // The screen says what it is instead of counting suggestions that
        // are not there, and leaving is a cancel, not a "later".
        XCTAssertEqual(model.screenTitle, "Edit receipt")
        XCTAssertEqual(model.dismissLabel, "Cancel")
        XCTAssertTrue(model.canSave)
    }

    func testAnEditSavesThroughTheSamePatchAndStaysConfirmed() async {
        api.confirmReceiptHandler = { _, _ in Fixtures.receipt(status: .confirmed) }
        let receipt = Fixtures.receipt(
            totalCents: 11300,
            category: "Groceries",
            status: .confirmed
        )
        let model = ConfirmReceiptModel(
            api: api,
            detail: Fixtures.detail(receipt: receipt),
            purpose: .edit
        )
        model.totalText = "119.00"
        model.categoryText = "Supplies"

        let saved = await model.save()
        XCTAssertTrue(saved)
        let call = api.confirmReceiptCalls.first
        XCTAssertEqual(call?.id, receipt.id)
        XCTAssertEqual(call?.request.totalCents, 11900)
        XCTAssertEqual(call?.request.category, "Supplies")
    }

    /// Confirming keeps its counter title and its "Later"; the edit case
    /// must not have leaked into it.
    func testConfirmingKeepsTheCounterTitleAndTheLaterExit() {
        let model = model(receipt: scannedReceipt(suggestions: matchingSuggestions()))
        XCTAssertEqual(model.screenTitle, "5 to check")
        XCTAssertEqual(model.dismissLabel, "Later")
        for field in ConfirmReceiptModel.SuggestedField.allCases {
            model.markTouched(field)
        }
        XCTAssertEqual(model.screenTitle, "All checked")
    }

    func testPickedDateSavesAsTheDayShownRegardlessOfDeviceZone() async {
        // The picker mutates its Date through the UTC calendar the view
        // pins (ReceiptFormat.utcCalendar); a date built that way must
        // save as exactly that calendar day, whatever zone the device is
        // in. This is the model half of the wave's highest reviewer
        // finding; the picker's environment pin is asserted on device.
        api.confirmReceiptHandler = { _, _ in Fixtures.receipt(status: .confirmed) }
        let model = model(receipt: scannedReceipt())

        var pickedDay = DateComponents()
        pickedDay.year = 2026
        pickedDay.month = 3
        pickedDay.day = 21
        guard let picked = ReceiptFormat.utcCalendar.date(from: pickedDay) else {
            return XCTFail("Could not build the picked date")
        }
        model.purchasedDate = picked

        _ = await model.save()
        XCTAssertEqual(api.confirmReceiptCalls.first?.request.purchasedAt, "2026-03-21")
    }

    func testFailedSaveSurfacesTheErrorAndStaysUnconfirmed() async {
        struct Boom: LocalizedError {
            var errorDescription: String? { "server said no" }
        }
        api.confirmReceiptHandler = { _, _ in throw Boom() }
        let model = model(receipt: scannedReceipt())

        let saved = await model.save()
        XCTAssertFalse(saved)
        XCTAssertEqual(model.saveError, "server said no")
    }

    // MARK: - HST rate plausibility hint (proposal #7, 2026-08-28)

    /// 8% of the subtotal - looks like half of a 13% split
    /// (ReceiptArithmeticTests.swift owns the boundary math itself; this
    /// pins the model's amber/touched wiring around it).
    private func halfSplitSuggestions() -> MergedSuggestions {
        Fixtures.merged(
            vendor: "Maple Foods",
            purchasedAt: "2026-03-20",
            totalCents: 10800,
            hstCents: 800,
            subtotalCents: 10000
        )
    }

    func testHstRateHintShowsAndClearsWithTheTint() {
        let model = model(receipt: scannedReceipt(
            hstCents: 800, subtotalCents: 10000, suggestions: halfSplitSuggestions()
        ))
        XCTAssertTrue(model.showsHstRateHint)
        XCTAssertTrue(model.isUnreviewed(.hst))

        // Touching another field is not looking at HST.
        model.markTouched(.vendor)
        XCTAssertTrue(model.showsHstRateHint)

        // Touching HST clears the amber and the hint together - the same
        // rule showsHstDisagreementNote already follows.
        model.markTouched(.hst)
        XCTAssertFalse(model.showsHstRateHint)
        XCTAssertFalse(model.isUnreviewed(.hst))
    }

    /// The default fixture is a legitimate 13% receipt (1300/10000) -
    /// deliberately not flagged, the narrow-scoping rule stated in full on
    /// ReceiptArithmetic.swift and its own doc comment.
    func testHstRateHintDoesNotFireOnALegitimate13PercentReceipt() {
        let model = model(receipt: scannedReceipt(suggestions: matchingSuggestions()))
        XCTAssertFalse(model.showsHstRateHint)
    }

    /// Suppressed the same way `showsArithmeticWarning` already suppresses
    /// itself over garbage text - evaluating a ratio against unparseable
    /// input would just be noise.
    func testHstRateHintSuppressedOverInvalidSubtotalText() {
        let model = model(receipt: scannedReceipt(
            hstCents: 800, subtotalCents: 10000, suggestions: halfSplitSuggestions()
        ))
        model.subtotalText = "not a number"
        XCTAssertFalse(model.showsHstRateHint)
    }

    /// Two independent signals - a parser disagreement and one value's own
    /// ratio looking like a split - can both be true of the same receipt,
    /// and ConfirmFieldRows.swift's separate `rateHintNote`/
    /// `disagreementNote` slots exist so neither has to win over the
    /// other.
    func testHstRateHintAndDisagreementNoteCanBothShow() {
        let model = model(receipt: scannedReceipt(
            hstCents: 800,
            subtotalCents: 10000,
            suggestions: Fixtures.merged(
                vendor: "Maple Foods",
                purchasedAt: "2026-03-20",
                totalCents: 10800,
                hstCents: 800,
                hstDisagreement: true,
                subtotalCents: 10000
            )
        ))
        XCTAssertTrue(model.showsHstRateHint)
        XCTAssertTrue(model.showsHstDisagreementNote)
    }

    // MARK: - Possible duplicates (proposal #8, 2026-08-28)

    func testPossibleDuplicateWarnsWhenTheLookupReturnsAMatch() async {
        let receipt = scannedReceipt(suggestions: matchingSuggestions())
        let match = Fixtures.receipt(purchasedAt: "2026-03-20", vendor: "Maple Foods", totalCents: 11300)
        api.possibleDuplicatesHandler = { _, _, _, _ in [match] }
        let model = model(receipt: receipt)
        XCTAssertTrue(model.possibleDuplicates.isEmpty) // nothing until a lookup completes

        model.checkForPossibleDuplicates()
        try? await Task.sleep(for: .milliseconds(50))

        XCTAssertEqual(model.possibleDuplicates.map(\.id), [match.id])
    }

    /// The obvious bug the proposal calls out by name: without `excludeId`
    /// a receipt being confirmed would match itself. This pins the CLIENT
    /// half - that this receipt's own id is what gets sent - the server
    /// half (that passing it actually excludes the row) is
    /// server/tests/integration/possibleDuplicates.test.ts's job.
    func testPossibleDuplicateLookupExcludesItsOwnReceiptId() async {
        let receipt = scannedReceipt(suggestions: matchingSuggestions())
        api.possibleDuplicatesHandler = { _, _, _, _ in [] }
        let model = model(receipt: receipt)

        model.checkForPossibleDuplicates()
        try? await Task.sleep(for: .milliseconds(50))

        XCTAssertEqual(api.possibleDuplicatesCalls.last?.excludeId, receipt.id)
        XCTAssertEqual(api.possibleDuplicatesCalls.last?.purchasedAt, "2026-03-20")
        XCTAssertEqual(api.possibleDuplicatesCalls.last?.totalCents, 11300)
        XCTAssertEqual(api.possibleDuplicatesCalls.last?.vendor, "Maple Foods")
    }

    /// A failed lookup reads exactly like "nothing matched" - never
    /// surfaced, never retried from here - and leaves saving untouched.
    func testFailedPossibleDuplicatesLookupIsSilentAndDoesNotBlockSaving() async {
        struct Offline: Error {}
        let receipt = scannedReceipt(suggestions: matchingSuggestions())
        api.possibleDuplicatesHandler = { _, _, _, _ in throw Offline() }
        api.confirmReceiptHandler = { _, _ in Fixtures.receipt(status: .confirmed) }
        let model = model(receipt: receipt)

        model.checkForPossibleDuplicates()
        try? await Task.sleep(for: .milliseconds(50))

        XCTAssertTrue(model.possibleDuplicates.isEmpty)
        XCTAssertNil(model.saveBlocker)
        let saved = await model.save()
        XCTAssertTrue(saved)
    }

    /// The proposal's central rule, stated as a test: finding a match
    /// changes nothing about whether Save is enabled or what it does.
    func testPossibleDuplicateWarningNeverGatesSave() async {
        let receipt = scannedReceipt(suggestions: matchingSuggestions())
        let match = Fixtures.receipt(purchasedAt: "2026-03-20", vendor: "Maple Foods", totalCents: 11300)
        api.possibleDuplicatesHandler = { _, _, _, _ in [match] }
        api.confirmReceiptHandler = { _, _ in Fixtures.receipt(status: .confirmed) }
        let model = model(receipt: receipt)

        model.checkForPossibleDuplicates()
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertFalse(model.possibleDuplicates.isEmpty)

        XCTAssertTrue(model.canSave)
        XCTAssertNil(model.saveBlocker)
        let saved = await model.save()
        XCTAssertTrue(saved)
    }

    /// A total that stops parsing has nothing left to compare against -
    /// and a match found a moment ago, against a now-abandoned total, must
    /// not linger as if it still applied.
    func testPossibleDuplicatesClearWhenTheTotalBecomesInvalid() async {
        let receipt = scannedReceipt(suggestions: matchingSuggestions())
        let match = Fixtures.receipt(purchasedAt: "2026-03-20", vendor: "Maple Foods", totalCents: 11300)
        api.possibleDuplicatesHandler = { _, _, _, _ in [match] }
        let model = model(receipt: receipt)

        model.checkForPossibleDuplicates()
        try? await Task.sleep(for: .milliseconds(50))
        XCTAssertFalse(model.possibleDuplicates.isEmpty)

        model.totalText = "not a number"
        model.checkForPossibleDuplicates()
        XCTAssertTrue(model.possibleDuplicates.isEmpty) // cleared synchronously - no network round trip needed to know this
    }

    /// A capture-time confirm has no server row to compare against yet
    /// (no `api:` was ever injected) - calling this must be a harmless
    /// no-op, not a crash or an unstubbed-call failure.
    func testCaptureTimeConfirmHasNoDuplicateCheck() async {
        var suggestions = ReceiptSuggestions()
        suggestions.totalCents = 4520
        suggestions.purchasedAt = "2026-03-20"
        let draft = CapturedReceiptDraft(
            imageData: Data("scan".utf8),
            suggestions: suggestions,
            ocrRawText: nil,
            capturedAt: Date(timeIntervalSince1970: 1_774_000_000),
            ocrFailureNote: nil
        )
        let model = ConfirmReceiptModel(draft: draft) { _ in }

        model.checkForPossibleDuplicates()
        try? await Task.sleep(for: .milliseconds(50))

        XCTAssertTrue(model.possibleDuplicates.isEmpty)
    }
}

final class MoneyInputTests: XCTestCase {
    func testParsesPlainAndDecoratedAmounts() {
        XCTAssertEqual(MoneyInput.parse("45.20"), .cents(4520))
        XCTAssertEqual(MoneyInput.parse("45"), .cents(4500))
        XCTAssertEqual(MoneyInput.parse("45.2"), .cents(4520))
        XCTAssertEqual(MoneyInput.parse("$1,234.56"), .cents(123456))
        XCTAssertEqual(MoneyInput.parse(" 0.05 "), .cents(5))
    }

    func testBlankIsAbsentAndGarbageIsInvalid() {
        XCTAssertEqual(MoneyInput.parse(""), .empty)
        XCTAssertEqual(MoneyInput.parse("   "), .empty)
        XCTAssertEqual(MoneyInput.parse("abc"), .invalid)
        XCTAssertEqual(MoneyInput.parse("12.345"), .invalid)
        XCTAssertEqual(MoneyInput.parse("12."), .invalid)
    }

    func testNegativeAmountsParseBecauseRefundsAreReceipts() {
        XCTAssertEqual(MoneyInput.parse("-5.00"), .cents(-500))
        XCTAssertEqual(MoneyInput.parse("-$45.20"), .cents(-4520))
    }

    func testAmountsTooLargeForCentsAreInvalidNotACrash() {
        // Int.max dollars fits Int but overflows the cents scale-up; a
        // trap here would crash the confirm screen mid-queue.
        XCTAssertEqual(MoneyInput.parse("9223372036854775807.00"), .invalid)
        XCTAssertEqual(MoneyInput.parse("999999999999999999999"), .invalid)
    }

    func testRoundTripsWithFieldText() {
        XCTAssertEqual(MoneyInput.text(fromCents: 4520), "45.20")
        XCTAssertEqual(MoneyInput.text(fromCents: 5), "0.05")
        XCTAssertEqual(MoneyInput.parse(MoneyInput.text(fromCents: 123456)), .cents(123456))
        // A refund prefill must not block its own confirmation.
        XCTAssertEqual(MoneyInput.parse(MoneyInput.text(fromCents: -4520)), .cents(-4520))
    }
}
