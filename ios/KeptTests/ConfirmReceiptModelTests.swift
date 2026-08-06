import XCTest
@testable import Kept

/// The confirm screen's state logic without a camera or a view: amber
/// starts on every prefilled suggestion, clears permanently on touch, the
/// counter follows, arithmetic warns without blocking, and save is
/// disabled - with the reason stated - until the §5.2 choice is made.
@MainActor
final class ConfirmReceiptModelTests: XCTestCase {
    private var api: StubKeptAPI!

    override func setUp() {
        super.setUp()
        api = StubKeptAPI()
    }

    private func model(receipt: Receipt, suggestions: OcrSuggestionsRecord? = nil) -> ConfirmReceiptModel {
        ConfirmReceiptModel(
            api: api,
            detail: Fixtures.detail(receipt: receipt, ocrSuggestions: suggestions)
        )
    }

    /// A batch-scanned pending receipt as wave 4 creates it: parser values
    /// present, no business choice anywhere.
    private func scannedReceipt(
        totalCents: Int? = 11300,
        vendor: String? = "Maple Foods",
        hstCents: Int? = 1300,
        subtotalCents: Int? = 10000
    ) -> Receipt {
        Fixtures.receipt(
            vendor: vendor,
            subtotalCents: subtotalCents,
            hstCents: hstCents,
            totalCents: totalCents,
            isBusiness: nil,
            status: .pending
        )
    }

    /// The suggestion record matching scannedReceipt(): everything on the
    /// receipt is the parser's work, date included.
    private func matchingSuggestions() -> OcrSuggestionsRecord {
        Fixtures.suggestions(
            vendor: "Maple Foods",
            purchasedAt: "2026-03-20",
            totalCents: 11300,
            hstCents: 1300,
            subtotalCents: 10000
        )
    }

    // MARK: - Amber

    func testEverySuggestedFieldStartsUnreviewed() {
        let model = model(receipt: scannedReceipt(), suggestions: matchingSuggestions())
        XCTAssertTrue(model.isUnreviewed(.total))
        XCTAssertTrue(model.isUnreviewed(.date)) // always prefilled
        XCTAssertTrue(model.isUnreviewed(.vendor))
        XCTAssertTrue(model.isUnreviewed(.hst))
        XCTAssertTrue(model.isUnreviewed(.subtotal))
        XCTAssertFalse(model.isUnreviewed(.taxNumber)) // nothing suggested
        XCTAssertEqual(model.unreviewedCount, 5)
        XCTAssertFalse(model.dateIsCaptureDayFallback) // a date was parsed
    }

    func testHumanEnteredValueIsNotMarkedAsAMachineSuggestion() {
        // The parser suggested only the total; the vendor on the row was
        // written by something else (a partial PATCH, another client) and
        // must not carry the machine-suggestion amber.
        let model = model(
            receipt: scannedReceipt(),
            suggestions: Fixtures.suggestions(purchasedAt: "2026-03-20", totalCents: 11300)
        )
        XCTAssertTrue(model.isUnreviewed(.total))
        XCTAssertFalse(model.isUnreviewed(.vendor))
        XCTAssertFalse(model.isUnreviewed(.hst))
        XCTAssertEqual(model.unreviewedCount, 2) // total + date
    }

    func testFallbackDateIsCalledOut() {
        // Suggestions exist but carry no date: the prefill is the capture
        // day, and the screen must say so rather than pass it off as read.
        let model = model(
            receipt: scannedReceipt(),
            suggestions: Fixtures.suggestions(totalCents: 11300)
        )
        XCTAssertTrue(model.dateIsCaptureDayFallback)
        XCTAssertTrue(model.isUnreviewed(.date))
    }

    func testWithoutASuggestionRecordPresenceIsTheProxy() {
        // Pre-wave-4 rows have no record; value-presence is the only
        // signal left, and no fabrication claim is made about the date.
        let model = model(receipt: scannedReceipt())
        XCTAssertTrue(model.isUnreviewed(.total))
        XCTAssertTrue(model.isUnreviewed(.vendor))
        XCTAssertFalse(model.dateIsCaptureDayFallback)
        XCTAssertEqual(model.unreviewedCount, 5)
    }

    func testAbsentValuesAreNotSuggestions() {
        let model = model(receipt: scannedReceipt(
            totalCents: nil, vendor: nil, hstCents: nil, subtotalCents: nil
        ), suggestions: Fixtures.suggestions())
        // Only the date (capture-day fallback) is prefilled.
        XCTAssertEqual(model.unreviewedCount, 1)
        XCTAssertTrue(model.isUnreviewed(.date))
        XCTAssertTrue(model.dateIsCaptureDayFallback)
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
