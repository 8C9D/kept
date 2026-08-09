import XCTest
@testable import Kept

/// The confirm screen's state logic without a camera or a view: amber
/// starts on every prefilled suggestion, clears permanently on touch, the
/// counter follows, arithmetic warns without blocking, and save is
/// disabled - with the reason stated - until the §5.2 choice is made.
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
    /// present, no business choice anywhere.
    private func scannedReceipt(
        totalCents: Int? = 11300,
        vendor: String? = "Maple Foods",
        hstCents: Int? = 1300,
        subtotalCents: Int? = 10000,
        suggestions: MergedSuggestions? = nil
    ) -> Receipt {
        Fixtures.receipt(
            vendor: vendor,
            subtotalCents: subtotalCents,
            hstCents: hstCents,
            totalCents: totalCents,
            isBusiness: nil,
            status: .pending,
            suggestions: suggestions
        )
    }

    /// The served merge matching scannedReceipt(): everything on the
    /// receipt is a parser's work, date included.
    private func matchingSuggestions(dateDisagreement: Bool = false) -> MergedSuggestions {
        Fixtures.merged(
            vendor: "Maple Foods",
            purchasedAt: "2026-03-20",
            dateDisagreement: dateDisagreement,
            totalCents: 11300,
            hstCents: 1300,
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
        XCTAssertFalse(model.isUnreviewed(.taxNumber)) // nothing suggested
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
        XCTAssertTrue(model.isUnreviewed(.date))
        XCTAssertEqual(model.totalText, "45.20")
        XCTAssertFalse(model.isUnreviewed(.vendor)) // nothing suggested

        model.chooseBusiness(true)
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
        XCTAssertEqual(model.taxNumberText, "")
        XCTAssertNil(model.businessChoice) // never pre-selected (spec §7.2)
    }

    // MARK: - Arithmetic

    func testArithmeticWarningWhenPartsDoNotReachTotal() {
        let model = model(receipt: scannedReceipt(totalCents: 11300, hstCents: 1300, subtotalCents: 10000))
        XCTAssertFalse(model.showsArithmeticWarning) // 100 + 13 = 113

        model.hstText = "14.00"
        XCTAssertTrue(model.showsArithmeticWarning)

        // Never blocking: the warning coexists with a saveable form.
        model.chooseBusiness(true)
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

    // MARK: - Save gating

    func testSaveBlockedUntilBusinessOrPersonalChosen() {
        let model = model(receipt: scannedReceipt())
        XCTAssertFalse(model.canSave)
        XCTAssertEqual(model.saveBlocker, "Choose business or personal to save.")

        model.chooseBusiness(false)
        XCTAssertTrue(model.canSave)
        XCTAssertNil(model.saveBlocker)
    }

    func testSaveBlockedWithoutATotal() {
        let model = model(receipt: scannedReceipt(totalCents: nil))
        model.chooseBusiness(true)
        XCTAssertEqual(model.saveBlocker, "Enter the total to save.")

        model.totalText = "45.20"
        XCTAssertNil(model.saveBlocker)
    }

    func testSaveBlockedByInvalidMoneyTextWithTheFieldNamed() {
        let model = model(receipt: scannedReceipt())
        model.chooseBusiness(true)
        model.hstText = "abc"
        XCTAssertEqual(model.saveBlocker, "HST isn't a valid amount.")
    }

    // MARK: - Keyboard fields (§10A.1's dismissal rule)

    func testTheDecimalPadFieldsAreExactlyTheFourMoneyFields() {
        let decimalPad = ConfirmReceiptModel.EditableField.allCases
            .filter(\.usesDecimalPad)
        XCTAssertEqual(
            Set(decimalPad),
            [.total, .hst, .subtotal, .otherTax]
        )
    }

    /// What the keyboard toolbar keys off - a different question from the
    /// keyboard type. Done is offered to every keyboard with no exit of
    /// its own: the four decimal pads, which have no return key, plus
    /// notes, whose return key inserts a newline. A field falling out of
    /// this set would ship a keyboard nothing inside it can close - the
    /// device defect this pins - and the view's `if` around the toolbar is
    /// not itself executed by any test (§10.2).
    func testDoneIsOfferedToEveryKeyboardWithNoExitOfItsOwn() {
        let needsDone = ConfirmReceiptModel.EditableField.allCases
            .filter(\.needsDoneButton)
        XCTAssertEqual(
            Set(needsDone),
            [.total, .hst, .subtotal, .otherTax, .notes]
        )
    }

    /// Other tax gained a focus value so its decimal pad can be closed;
    /// it must not have gained an amber tint with it - it carries no
    /// suggestion and never has (§7.2's field list).
    func testFocusMapsToTheSuggestionItClearsAndNoOther() {
        XCTAssertEqual(ConfirmReceiptModel.EditableField.total.suggestion, .total)
        XCTAssertEqual(ConfirmReceiptModel.EditableField.vendor.suggestion, .vendor)
        XCTAssertEqual(ConfirmReceiptModel.EditableField.hst.suggestion, .hst)
        XCTAssertEqual(ConfirmReceiptModel.EditableField.subtotal.suggestion, .subtotal)
        XCTAssertEqual(ConfirmReceiptModel.EditableField.taxNumber.suggestion, .taxNumber)
        XCTAssertNil(ConfirmReceiptModel.EditableField.otherTax.suggestion)
        XCTAssertNil(ConfirmReceiptModel.EditableField.category.suggestion)
        XCTAssertNil(ConfirmReceiptModel.EditableField.paymentMethod.suggestion)
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

    // MARK: - Saving

    func testSavePatchesEveryFieldAndConfirms() async {
        api.confirmReceiptHandler = { _, _ in Fixtures.receipt(status: .confirmed) }
        let model = model(receipt: scannedReceipt())
        model.chooseBusiness(true)
        model.vendorText = "  Maple Foods Market  "
        model.categoryText = "Groceries"
        model.notesText = ""

        let saved = await model.save()
        XCTAssertTrue(saved)

        let call = api.confirmReceiptCalls.first
        XCTAssertEqual(call?.id, model.receiptId)
        // The untouched date round-trips exactly: the picker's Date came
        // from this string and goes back to it through the same UTC pin.
        XCTAssertEqual(call?.request.purchasedAt, "2026-03-20")
        XCTAssertEqual(call?.request.totalCents, 11300)
        XCTAssertEqual(call?.request.isBusiness, true)
        XCTAssertEqual(call?.request.vendor, "Maple Foods Market") // trimmed
        XCTAssertEqual(call?.request.category, "Groceries")
        XCTAssertNil(call?.request.notes) // blank is an absence, not ""
        XCTAssertNil(call?.request.vendorTaxNumber)
    }

    func testPickedDateSavesAsTheDayShownRegardlessOfDeviceZone() async {
        // The picker mutates its Date through the UTC calendar the view
        // pins (ReceiptFormat.utcCalendar); a date built that way must
        // save as exactly that calendar day, whatever zone the device is
        // in. This is the model half of the wave's highest reviewer
        // finding; the picker's environment pin is asserted on device.
        api.confirmReceiptHandler = { _, _ in Fixtures.receipt(status: .confirmed) }
        let model = model(receipt: scannedReceipt())
        model.chooseBusiness(true)

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
        model.chooseBusiness(true)

        let saved = await model.save()
        XCTAssertFalse(saved)
        XCTAssertEqual(model.saveError, "server said no")
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
