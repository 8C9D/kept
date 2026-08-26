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
        suggestions: MergedSuggestions? = nil
    ) -> Receipt {
        Fixtures.receipt(
            vendor: vendor,
            subtotalCents: subtotalCents,
            hstCents: hstCents,
            totalCents: totalCents,
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

    func testTheDecimalPadFieldsAreExactlyTheThreeMoneyFields() {
        let decimalPad = ConfirmReceiptModel.EditableField.allCases
            .filter(\.usesDecimalPad)
        XCTAssertEqual(
            Set(decimalPad),
            [.total, .hst, .subtotal]
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
    /// the keyboard each one raises: the three decimal pads plus notes, and
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
            [.total, .hst, .subtotal, .notes]
        )
    }

    /// Focus clears exactly one field's amber, and the fields carrying no
    /// suggestion - the three free-text ones - clear nothing.
    func testFocusMapsToTheSuggestionItClearsAndNoOther() {
        XCTAssertEqual(ConfirmReceiptModel.EditableField.total.suggestion, .total)
        XCTAssertEqual(ConfirmReceiptModel.EditableField.vendor.suggestion, .vendor)
        XCTAssertEqual(ConfirmReceiptModel.EditableField.hst.suggestion, .hst)
        XCTAssertEqual(ConfirmReceiptModel.EditableField.subtotal.suggestion, .subtotal)
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
        XCTAssertEqual(call?.request.vendor, "Maple Foods Market") // trimmed
        XCTAssertEqual(call?.request.category, "Groceries")
        XCTAssertEqual(call?.request.paymentMethod, "Visa")
        XCTAssertNil(call?.request.notes) // blank is an absence, not ""
    }

    /// The wire shape, not just the struct: the three retired keys must be
    /// absent from the PATCH body. Sending them would be tolerated by the
    /// transitional server shim and silently discarded, which is exactly
    /// the kind of "it works" that hides a client that never got updated.
    func testThePatchBodyCarriesNoneOfTheRetiredKeys() async throws {
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
                totalCents: 99999
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
        XCTAssertFalse(model.dateIsCaptureDayFallback)
        XCTAssertFalse(model.showsDateDisagreementNote)
        XCTAssertEqual(model.vendorText, "Maple Foods")
        XCTAssertEqual(model.totalText, "113.00")
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
