import XCTest
@testable import Kept

/// The confirm form's 2026-09-01 behaviour batch, kept beside
/// ConfirmReceiptModelTests rather than inside it because these are four
/// distinct rules with their own reasoning and that file is already the
/// screen's general suite.
///
/// Every rule here is a mirror of one the web form already carries
/// (`web/src/views/ReceiptForm.tsx` - `applyComponentEdit`,
/// `hstSuggestionChip`, `patchForSaveForLater`, `reviewedFieldsForSave`)
/// or of one the server owns (`suggestDefaultRateHst`, `checkAmountFloor`,
/// the widened `deriveMissingAmount`). A case that passes here and would
/// fail against the web is a bug in one of the two, not a difference of
/// opinion between clients - which is exactly what these assertions exist
/// to catch.
@MainActor
final class ConfirmFormTotalTrackingTests: XCTestCase {
    private var api: StubKeptAPI!

    override func setUp() async throws {
        try await super.setUp()
        api = StubKeptAPI()
    }

    /// A pending receipt carrying only what the arguments say - the merge
    /// is always present, so an absent argument is a parser that found
    /// nothing rather than a receipt no parser ever saw.
    private func form(
        totalCents: Int? = nil,
        hstCents: Int? = nil,
        subtotalCents: Int? = nil,
        tipCents: Int? = nil,
        otherFeesCents: Int? = nil,
        currency: String = "CAD",
        purpose: ConfirmReceiptModel.Purpose = .confirm,
        status: ReceiptStatus = .pending,
        reviewedFields: [String]? = nil
    ) -> ConfirmReceiptModel {
        let receipt = Fixtures.receipt(
            vendor: nil,
            subtotalCents: subtotalCents,
            hstCents: hstCents,
            tipCents: tipCents,
            otherFeesCents: otherFeesCents,
            totalCents: totalCents,
            currency: currency,
            status: status,
            suggestions: Fixtures.merged(
                purchasedAt: "2026-03-20",
                totalCents: totalCents,
                hstCents: hstCents,
                subtotalCents: subtotalCents,
                tipCents: tipCents,
                otherFeesCents: otherFeesCents
            ),
            reviewedFields: reviewedFields
        )
        return ConfirmReceiptModel(api: api, detail: Fixtures.detail(receipt: receipt), purpose: purpose)
    }

    // MARK: - Flow A: a total off the paper is never overwritten

    /// "If total is 14.35 and I enter subtotal 12.70, suggest 1.65 for
    /// HST" (the owner, 2026-09-01). The total came off the paper - the one
    /// figure OCR gets right most often - so typing a subtotal must not
    /// move it, and what the form offers instead is the difference.
    func testAnOcrTotalSurvivesASubtotalEditAndTheChipOffersTheDifference() {
        let model = form(totalCents: 1435)
        model.editComponentAmount(.subtotal, to: "12.70")

        XCTAssertEqual(model.totalText, "14.35")
        XCTAssertEqual(model.hstSuggestionChip, ConfirmReceiptModel.AmountChip(kind: .fromTotal, cents: 165))
        XCTAssertEqual(
            model.hstSuggestionChipLabel,
            "HST = Total − Subtotal − Tip − Other fees ($1.65)"
        )
    }

    // MARK: - Flow B: a blank form builds its own total

    /// A photograph the parsers got nothing from. Typing the subtotal
    /// makes the total; typing the HST moves it again. The total is never
    /// typed at all, which is the point - four boxes become one running
    /// bill.
    func testABlankFormBuildsTheTotalFromItsComponents() {
        let model = form()
        XCTAssertEqual(model.totalText, "")

        model.editComponentAmount(.subtotal, to: "12.70")
        XCTAssertEqual(model.totalText, "12.70")

        model.editComponentAmount(.hst, to: "1.65")
        XCTAssertEqual(model.totalText, "14.35")

        // And it keeps following while it stays consistent.
        model.editComponentAmount(.tip, to: "2.00")
        XCTAssertEqual(model.totalText, "16.35")
    }

    // MARK: - Flow C: a consistent total follows a correction

    /// Leaving $14.35 after the HST is corrected to $1.60 would create a
    /// mismatch the person did not ask for and would then have to fix by
    /// hand.
    func testAConsistentTotalFollowsACorrectedComponent() {
        let model = form(totalCents: 1435, hstCents: 165, subtotalCents: 1270)
        model.editComponentAmount(.hst, to: "1.60")
        XCTAssertEqual(model.totalText, "14.30")
    }

    /// Clearing a component is an edit like any other: the sum drops and
    /// the total follows it down.
    func testClearingAComponentTracksToo() {
        let model = form(totalCents: 1435, hstCents: 165, subtotalCents: 1270)
        model.editComponentAmount(.hst, to: "")
        XCTAssertEqual(model.totalText, "12.70")
    }

    // MARK: - Flow D: a typed total is the anchor

    /// "I must still be able to edit total directly without it altering
    /// the other fields" (the owner). The total is bound straight to its text
    /// with no rule attached, and once it says something the components do
    /// not, no later keystroke may quietly overwrite it.
    func testATypedTotalMovesNothingAndIsNeverOverwritten() {
        let model = form(hstCents: 165, subtotalCents: 1270)
        // The form opened consistent: 12.70 + 1.65 = 14.35.
        XCTAssertEqual(model.totalText, "")

        model.totalText = "20.00"
        XCTAssertEqual(model.subtotalText, "12.70")
        XCTAssertEqual(model.hstText, "1.65")
        XCTAssertEqual(model.tipText, "")
        XCTAssertEqual(model.otherFeesText, "")

        // 20.00 is not what the components said, so the total is now the
        // person's own number and a subtotal edit leaves it alone.
        model.editComponentAmount(.subtotal, to: "13.00")
        XCTAssertEqual(model.totalText, "20.00")
    }

    /// A blank subtotal is not a sum: there is nothing to track to, so
    /// typing an HST into an otherwise empty form leaves the total blank
    /// rather than claiming the tax IS the bill.
    func testWithNoSubtotalThereIsNothingToTrackTo() {
        let model = form()
        model.editComponentAmount(.hst, to: "1.65")
        XCTAssertEqual(model.totalText, "")
    }

    /// An unparseable box suspends the rule rather than guessing at what
    /// the person meant - the same suppression `showsArithmeticWarning`
    /// and every derived offer already apply.
    func testAnUnparseableBoxSuspendsTheTracking() {
        let model = form(totalCents: 1270, subtotalCents: 1270)
        XCTAssertEqual(model.totalText, "12.70")

        model.editComponentAmount(.subtotal, to: "not a number")
        XCTAssertEqual(model.totalText, "12.70")
    }

    /// ⚠ Amounts are TYPED, and typing one passes through a state no money
    /// parser accepts: "12.70" arrives as `1`, `12`, `12.`, `12.7`,
    /// `12.70`. Before 2026-09-01's `lastTrackedComponentSum`, the
    /// keystroke after the decimal point saw a nil pre-edit sum, read it
    /// as "the total has diverged", and stood the rule down for the rest
    /// of the amount - so this exact sequence left the total at $12.00.
    /// Found by running the form (KeptUITests' ConfirmAmountsUITests), not
    /// by reading it, which is why it is pinned here keystroke by
    /// keystroke rather than as one whole-value edit.
    func testAnAmountTypedOneKeystrokeAtATimeStillTracks() {
        let model = form()
        for keystroke in ["1", "12", "12.", "12.7", "12.70"] {
            model.editComponentAmount(.subtotal, to: keystroke)
        }
        XCTAssertEqual(model.subtotalText, "12.70")
        XCTAssertEqual(model.totalText, "12.70")

        for keystroke in ["1", "1.", "1.6", "1.65"] {
            model.editComponentAmount(.hst, to: keystroke)
        }
        XCTAssertEqual(model.totalText, "14.35")
    }

    /// The memory is only ever consulted to bridge a keystroke, never to
    /// resurrect a rule the person has already ended: a total typed by
    /// hand still stops the tracking dead, decimal points and all.
    func testTheKeystrokeMemoryDoesNotOverrideATypedTotal() {
        let model = form()
        for keystroke in ["1", "12", "12.", "12.7", "12.70"] {
            model.editComponentAmount(.subtotal, to: keystroke)
        }
        model.totalText = "20.00"

        for keystroke in ["1", "1.", "1.6", "1.65"] {
            model.editComponentAmount(.hst, to: keystroke)
        }
        XCTAssertEqual(model.totalText, "20.00")
    }

    /// The rule marks the total as no longer a suggestion, because the
    /// number in that box is the form's arithmetic now - but it does NOT
    /// report it reviewed, because nobody looked at it. A save-for-later
    /// that wrote a total nobody read would be doing exactly what the
    /// reviewed set exists to prevent.
    func testATrackedTotalIsNotReportedAsReviewed() {
        let model = form()
        model.markTouched(.subtotal)
        model.editComponentAmount(.subtotal, to: "12.70")

        XCTAssertEqual(model.totalText, "12.70")
        XCTAssertEqual(model.reviewedFieldsForSave, [.subtotalCents])
        XCTAssertFalse(model.isUnreviewed(.total))
    }
}

// MARK: - The HST chip (2026-09-01)

@MainActor
final class ConfirmFormHstChipTests: XCTestCase {
    private var api: StubKeptAPI!

    override func setUp() async throws {
        try await super.setUp()
        api = StubKeptAPI()
    }

    private func form(
        totalCents: Int? = nil,
        hstCents: Int? = nil,
        subtotalCents: Int? = nil,
        tipCents: Int? = nil,
        otherFeesCents: Int? = nil,
        currency: String = "CAD"
    ) -> ConfirmReceiptModel {
        let receipt = Fixtures.receipt(
            vendor: nil,
            subtotalCents: subtotalCents,
            hstCents: hstCents,
            tipCents: tipCents,
            otherFeesCents: otherFeesCents,
            totalCents: totalCents,
            currency: currency,
            status: .pending,
            suggestions: Fixtures.merged(
                purchasedAt: "2026-03-20",
                totalCents: totalCents,
                hstCents: hstCents,
                subtotalCents: subtotalCents,
                tipCents: tipCents,
                otherFeesCents: otherFeesCents
            )
        )
        return ConfirmReceiptModel(api: api, detail: Fixtures.detail(receipt: receipt))
    }

    /// The receipt states a total: the difference is the tax, and that is
    /// a fact about the numbers on screen rather than a guess about the
    /// world. Tip and fees come out of it too.
    func testTheDifferenceChipWhenATotalIsPresent() {
        let model = form(totalCents: 1635, subtotalCents: 1270, tipCents: 200)
        XCTAssertEqual(model.hstSuggestionChip, ConfirmReceiptModel.AmountChip(kind: .fromTotal, cents: 165))
    }

    /// A handwritten invoice, or a slip whose total the parser could not
    /// read: there is nothing to subtract from, so the default rate is
    /// what is left to offer - and the label says "at 13%" in those words
    /// so nobody mistakes it for arithmetic off the paper.
    func testTheDefaultRateChipWhenOnlyASubtotalIsKnown() {
        // No total was read, so there is nothing to subtract from.
        let model = form(subtotalCents: 1270)
        XCTAssertEqual(model.totalText, "")
        XCTAssertEqual(model.hstSuggestionChip, ConfirmReceiptModel.AmountChip(kind: .atDefaultRate, cents: 165))
        XCTAssertEqual(model.hstSuggestionChipLabel, "HST at 13% of subtotal ($1.65)")
    }

    /// A total that exactly equals the subtotal leaves a zero difference,
    /// which is evidence about the other boxes rather than an HST amount
    /// anyone could act on - so the offer falls through to the rate, which
    /// is what "add 13% to this" means.
    func testAZeroDifferenceFallsThroughToTheRate() {
        let model = form(totalCents: 1270, subtotalCents: 1270)
        XCTAssertEqual(model.hstSuggestionChip?.kind, .atDefaultRate)
    }

    /// ⚠ The rate chip is CAD-only. On a US receipt Ontario's 13% is not a
    /// weaker guess, it is an answer to a different country's question,
    /// and a chip reading "HST at 13% of subtotal" beside a USD total is
    /// simply wrong - the one thing a suggestion here may never be.
    func testTheRateChipIsNotOfferedOnANonCadReceipt() {
        let model = form(subtotalCents: 1270, currency: "USD")
        XCTAssertNil(model.hstSuggestionChip)
    }

    /// The difference chip stays currency-agnostic and deliberately: it
    /// applies no rate and assumes no jurisdiction, it subtracts the
    /// numbers already on screen from each other.
    func testTheDifferenceChipIsOfferedInAnyCurrency() {
        let model = form(totalCents: 1435, subtotalCents: 1270, currency: "USD")
        XCTAssertEqual(model.hstSuggestionChip, ConfirmReceiptModel.AmountChip(kind: .fromTotal, cents: 165))
    }

    func testNoChipWhenHstIsAlreadyFilledOrTheSubtotalIsBlank() {
        XCTAssertNil(form(totalCents: 1435, hstCents: 165, subtotalCents: 1270).hstSuggestionChip)
        XCTAssertNil(form(totalCents: 1435).hstSuggestionChip)
    }

    /// Applying it sets HST, lets the tracking rule move the total, and
    /// counts as the person having LOOKED at the field: a chip states a
    /// rule and its result, and picking it over typing anything else is
    /// the looking.
    func testApplyingTheChipFillsHstMovesTheTotalAndMarksItReviewed() {
        let model = form(subtotalCents: 1270)
        XCTAssertTrue(model.applyHstSuggestionChip())

        XCTAssertEqual(model.hstText, "1.65")
        XCTAssertEqual(model.totalText, "14.35")
        XCTAssertFalse(model.isUnreviewed(.hst))
        XCTAssertTrue(model.reviewedFieldsForSave.contains(.hstCents))
        // And the offer is gone, because HST is no longer blank.
        XCTAssertNil(model.hstSuggestionChip)
    }

    /// Applying the difference chip leaves a total that came off the paper
    /// exactly where it was - the tracking rule refuses to move a total
    /// the components never agreed with.
    func testApplyingTheDifferenceChipLeavesAnOcrTotalAlone() {
        let model = form(totalCents: 1435, subtotalCents: 1270)
        XCTAssertTrue(model.applyHstSuggestionChip())
        XCTAssertEqual(model.hstText, "1.65")
        XCTAssertEqual(model.totalText, "14.35")
    }

    /// The chip and proposal #1's derived fill answer the same question -
    /// what goes in the blank HST box - and the chip is the better-worded
    /// of the pair. Where both apply the fill is suppressed for HST alone.
    func testTheChipSuppressesTheHstDerivedFillAndNothingElse() {
        let hstBlank = form(totalCents: 1435, subtotalCents: 1270)
        XCTAssertEqual(hstBlank.derivableFill?.field, .hst)
        XCTAssertNil(hstBlank.derivableFillLabel)
        XCTAssertNotNil(hstBlank.hstSuggestionChipLabel)

        // Another field's fill is untouched: all four of tip's neighbours
        // are present, so the tip fill is offered as it always was.
        let tipBlank = form(totalCents: 13300, hstCents: 1300, subtotalCents: 10000, otherFeesCents: 500)
        XCTAssertNil(tipBlank.hstSuggestionChipLabel)
        XCTAssertEqual(tipBlank.derivableFillLabel, "Tip = Total − Subtotal − HST − Other fees ($15.00)")
    }
}

// MARK: - The amount floor and the acknowledgement (2026-09-01)

@MainActor
final class ConfirmFormAmountWarningTests: XCTestCase {
    private var api: StubKeptAPI!

    override func setUp() async throws {
        try await super.setUp()
        api = StubKeptAPI()
    }

    private func form(
        totalCents: Int?,
        hstCents: Int? = nil,
        subtotalCents: Int? = nil,
        purpose: ConfirmReceiptModel.Purpose = .confirm
    ) -> ConfirmReceiptModel {
        let receipt = Fixtures.receipt(
            vendor: nil,
            subtotalCents: subtotalCents,
            hstCents: hstCents,
            totalCents: totalCents,
            status: purpose == .edit ? .confirmed : .pending
        )
        return ConfirmReceiptModel(api: api, detail: Fixtures.detail(receipt: receipt), purpose: purpose)
    }

    /// One warning per fact: "the total is less than its parts" is a
    /// strict subset of "these do not add up" and strictly more specific,
    /// so it is rendered INSTEAD of the generic line, never beside it.
    func testTheFloorNoteReplacesTheGenericOne() {
        let model = form(totalCents: 850, hstCents: 2116, subtotalCents: 21894)
        XCTAssertTrue(model.showsAmountFloorNote)
        XCTAssertTrue(model.showsArithmeticWarning)
        XCTAssertEqual(
            model.amountsWarning,
            "Total is less than subtotal + HST + tip + fees. One of these numbers is wrong."
        )
    }

    /// A total ABOVE its components has an ordinary explanation - a line
    /// this form has no box for - so it keeps the softer wording.
    func testTheGenericNoteStandsWhenTheTotalExceedsItsParts() {
        let model = form(totalCents: 12000, hstCents: 1300, subtotalCents: 10000)
        XCTAssertFalse(model.showsAmountFloorNote)
        XCTAssertEqual(model.amountsWarning, "These amounts don't add up to the total. Worth a look.")
    }

    func testNoNoteWhenTheAmountsReconcile() {
        XCTAssertNil(form(totalCents: 11300, hstCents: 1300, subtotalCents: 10000).amountsWarning)
    }

    /// The Costco receipt: $218.94 of groceries confirmed at $8.50, with
    /// the subtotal and HST both correct on the same slip. The advisory
    /// note fired and was ticked past; this is the tap that asks.
    func testAnImpossibleTotalAsksBeforeSaving() {
        let model = form(totalCents: 850, hstCents: 2116, subtotalCents: 21894)
        XCTAssertTrue(model.saveNeedsAcknowledgement)
        XCTAssertEqual(
            model.saveAcknowledgementMessage,
            "These amounts don't add up (off by $231.60). Save anyway?"
        )
    }

    /// Above a dollar, proportion is the better measure: $10 adrift on a
    /// $110 receipt is 9% and worth a tap.
    func testAGapAboveFivePercentAsks() {
        let model = form(totalCents: 11000, subtotalCents: 10000)
        XCTAssertTrue(model.saveNeedsAcknowledgement)
        XCTAssertEqual(
            model.saveAcknowledgementMessage,
            "These amounts don't add up (off by $10.00). Save anyway?"
        )
    }

    /// …and below it, nothing is asked. A merchant's own rounding line or
    /// a coupon printed without an amount is not a data error, and asking
    /// about one is how an acknowledgement stops meaning anything.
    func testASmallProportionalGapSavesWithoutAsking() {
        let model = form(totalCents: 11350, hstCents: 1300, subtotalCents: 10000)
        XCTAssertTrue(model.showsArithmeticWarning)
        XCTAssertFalse(model.saveNeedsAcknowledgement)
        XCTAssertNil(model.saveAcknowledgementMessage)
    }

    /// The flat dollar floor is what keeps a small receipt from asking
    /// about a gap that is proportionally large and absolutely trivial: 50
    /// cents on a $5.00 coffee is 10%, and still not worth a dialog.
    func testAGapUnderADollarNeverAsks() {
        let model = form(totalCents: 500, subtotalCents: 450)
        XCTAssertFalse(model.saveNeedsAcknowledgement)
    }

    /// ⚠ `.edit` is exempt. Production holds a store-credit receipt whose
    /// subtotal 104.93 + HST 13.65 sit against a total of 28.21 - correct,
    /// permanent, and what the paper says. Asking about it every time
    /// someone fixes a typo in its category would train the
    /// acknowledgement out of meaning anything.
    func testEditingAConfirmedReceiptNeverAsks() {
        let model = form(totalCents: 2821, hstCents: 1365, subtotalCents: 10493, purpose: .edit)
        XCTAssertTrue(model.showsAmountFloorNote)
        XCTAssertFalse(model.saveNeedsAcknowledgement)
        XCTAssertNil(model.saveAcknowledgementMessage)
    }

    /// Nothing to compare, nothing to ask about - the same suppression
    /// every other check on this screen applies over an unparseable or
    /// absent box.
    func testNothingIsAskedWithoutBothAnchors() {
        XCTAssertFalse(form(totalCents: 11300).saveNeedsAcknowledgement)
        let invalid = form(totalCents: 850, hstCents: 2116, subtotalCents: 21894)
        invalid.editComponentAmount(.subtotal, to: "nonsense")
        XCTAssertFalse(invalid.saveNeedsAcknowledgement)
    }
}

// MARK: - Reviewed fields and "Save for later" (2026-09-01)

@MainActor
final class ConfirmFormSaveForLaterTests: XCTestCase {
    private var api: StubKeptAPI!

    override func setUp() async throws {
        try await super.setUp()
        api = StubKeptAPI()
        api.saveReceiptForLaterHandler = { _, _ in Fixtures.receipt(status: .pending) }
        api.confirmReceiptHandler = { _, _ in Fixtures.receipt() }
    }

    /// A receipt someone got halfway through on an earlier sitting: the
    /// row holds what they typed, the merge still carries the parser's
    /// guesses, and the server records which is which.
    private func halfFilled(
        reviewedFields: [String]?,
        rowVendor: String? = "Food Basics",
        rowTotalCents: Int? = 1435
    ) -> ConfirmReceiptModel {
        let receipt = Fixtures.receipt(
            vendor: rowVendor,
            subtotalCents: nil,
            hstCents: nil,
            totalCents: rowTotalCents,
            status: .pending,
            suggestions: Fixtures.merged(
                vendor: "In Store 392",
                purchasedAt: "2026-03-20",
                totalCents: 99900,
                hstCents: 1300,
                subtotalCents: 10000
            ),
            reviewedFields: reviewedFields
        )
        return ConfirmReceiptModel(api: api, detail: Fixtures.detail(receipt: receipt))
    }

    /// Belt and braces (the server already withholds a reviewed field's
    /// suggestion): a reviewed field prefills from the ROW, and never
    /// carries the machine-suggestion marking. Re-offering the parser's
    /// guess over a value someone typed last Tuesday is the exact defect
    /// the reviewed set exists to prevent.
    func testAReviewedFieldPrefillsFromTheRowAndIsNotASuggestion() {
        let model = halfFilled(reviewedFields: ["vendor", "totalCents"])
        XCTAssertEqual(model.vendorText, "Food Basics")
        XCTAssertEqual(model.totalText, "14.35")
        XCTAssertFalse(model.isUnreviewed(.vendor))
        XCTAssertFalse(model.isUnreviewed(.total))

        // Everything else is unchanged: the merge still outranks the row
        // where nobody has looked.
        XCTAssertEqual(model.hstText, "13.00")
        XCTAssertTrue(model.isUnreviewed(.hst))
    }

    /// Without the reviewed set the same receipt shows the parser's
    /// guesses over the human's values - which is the bug, stated as a
    /// test so the fix cannot silently regress.
    func testWithoutTheReviewedSetTheSuggestionWinsAsBefore() {
        let model = halfFilled(reviewedFields: nil)
        XCTAssertEqual(model.vendorText, "In Store 392")
        XCTAssertTrue(model.isUnreviewed(.vendor))
    }

    /// A reviewed date came off the row, not off the paper - so the screen
    /// must not announce it as the capture-day fallback, which is a claim
    /// about a parser that found nothing.
    func testAReviewedDateIsNotCalledACaptureDayFallback() {
        let receipt = Fixtures.receipt(
            purchasedAt: "2026-02-11",
            totalCents: 1435,
            status: .pending,
            suggestions: Fixtures.merged(totalCents: 1435),
            reviewedFields: ["purchasedAt"]
        )
        let model = ConfirmReceiptModel(api: api, detail: Fixtures.detail(receipt: receipt))
        XCTAssertFalse(model.dateIsCaptureDayFallback)
        XCTAssertEqual(ReceiptFormat.isoDate(fromPicker: model.purchasedDate), "2026-02-11")
        XCTAssertFalse(model.isUnreviewed(.date))
    }

    /// A name this build does not know is dropped rather than echoed back:
    /// every write replaces the stored set outright and the server's
    /// strict schema 400s an unlisted name, so echoing one is not
    /// something this client can do.
    func testAnUnrecognizedReviewedFieldNameIsDropped() {
        let model = halfFilled(reviewedFields: ["vendor", "somethingNewer"])
        XCTAssertEqual(model.reviewedFieldsForSave, [.vendor])
    }

    /// The union, in the vocabulary's own order - never a replacement.
    /// The person who opened this receipt today did not un-review what
    /// they looked at last week.
    func testTheReportedSetIsTheStoredSetUnionedWithThisSession() {
        let model = halfFilled(reviewedFields: ["vendor"])
        model.markTouched(.hst)
        model.markTouched(editable: .notes)
        XCTAssertEqual(model.reviewedFieldsForSave, [.vendor, .hstCents, .notes])
    }

    /// ⚠ The write that makes this a halfway save rather than a quiet full
    /// one: only the reviewed fields' VALUES go, and no `status` at all.
    /// The form is prefilled from the merge, so writing every field would
    /// put the parser's guesses into the row and stop them being
    /// suggestions - constraint 2's exact prohibition.
    func testSaveForLaterWritesOnlyTheReviewedFieldsAndNoStatus() async throws {
        let model = halfFilled(reviewedFields: nil)
        model.markTouched(.vendor)
        model.vendorText = "Food Basics"
        model.markTouched(.subtotal)
        model.editComponentAmount(.subtotal, to: "12.70")

        let savedForLater = await model.saveForLater()
        XCTAssertTrue(savedForLater)

        let body = try Self.encodedBody(XCTUnwrap(api.saveReceiptForLaterCalls.last).request)
        XCTAssertEqual(body["vendor"] as? String, "Food Basics")
        XCTAssertEqual(body["subtotalCents"] as? Int, 1270)
        XCTAssertEqual(body["reviewedFields"] as? [String], ["vendor", "subtotalCents"])
        XCTAssertNil(body["status"], "a save-for-later must leave the receipt pending")
        // The merge's HST and total were on screen and nobody looked at
        // either - so neither key is in the body at all, and the row keeps
        // whatever it held.
        XCTAssertFalse(body.keys.contains("hstCents"))
        XCTAssertFalse(body.keys.contains("totalCents"))
        XCTAssertFalse(body.keys.contains("purchasedAt"))
    }

    /// "Reviewed and deliberately blank" and "not reviewed" are different
    /// facts about the same nil, and only an explicit null can express the
    /// first. Collapsing them would make a cleared field un-clearable and
    /// the row would keep re-offering the value the person just deleted.
    func testAReviewedFieldClearedByHandSendsAnExplicitNull() async throws {
        let model = halfFilled(reviewedFields: nil)
        model.markTouched(.vendor)
        model.vendorText = ""

        let savedForLater = await model.saveForLater()
        XCTAssertTrue(savedForLater)

        let request = try XCTUnwrap(api.saveReceiptForLaterCalls.last).request
        let json = try String(decoding: JSONEncoder().encode(request), as: UTF8.self)
        XCTAssertTrue(json.contains("\"vendor\":null"), json)
    }

    /// A form that quietly saves around an amount it could not read is the
    /// error-masking this repo hunts for - so an unparseable box refuses
    /// the write and names the field, exactly as the web's does.
    func testAnUnparseableAmountRefusesTheWriteAndNamesTheField() async {
        let model = halfFilled(reviewedFields: nil)
        model.markTouched(.subtotal)
        model.editComponentAmount(.subtotal, to: "12.345")

        XCTAssertEqual(model.saveForLaterBlocker, "The subtotal isn't a valid amount.")
        let saved = await model.saveForLater()
        XCTAssertFalse(saved)
        XCTAssertTrue(api.saveReceiptForLaterCalls.isEmpty)
    }

    /// A blank total is the entire point of this action, so - unlike Save
    /// - it is not blocked by one.
    func testABlankTotalDoesNotBlockASaveForLater() async {
        // Neither the row nor the merge has a total: the parsers found
        // none and nobody has typed one, which is precisely the receipt
        // this action exists for.
        let receipt = Fixtures.receipt(
            totalCents: nil,
            status: .pending,
            suggestions: Fixtures.merged(vendor: "In Store 392", purchasedAt: "2026-03-20")
        )
        let model = ConfirmReceiptModel(api: api, detail: Fixtures.detail(receipt: receipt))
        XCTAssertEqual(model.totalText, "")
        model.markTouched(.vendor)
        XCTAssertNotNil(model.saveBlocker)
        XCTAssertNil(model.saveForLaterBlocker)
        let savedForLater = await model.saveForLater()
        XCTAssertTrue(savedForLater)
    }

    /// Only a server-backed `.confirm` form: a capture-time confirm has no
    /// row to half-write, and an edit opens on a receipt that is already
    /// confirmed, where "later" means nothing.
    func testSaveForLaterIsOfferedOnlyWhereItMeansSomething() async {
        XCTAssertTrue(halfFilled(reviewedFields: nil).canSaveForLater)


        let receipt = Fixtures.receipt(totalCents: 1435, status: .confirmed)
        let edit = ConfirmReceiptModel(api: api, detail: Fixtures.detail(receipt: receipt), purpose: .edit)
        XCTAssertFalse(edit.canSaveForLater)
        let refused = await edit.saveForLater()
        XCTAssertFalse(refused)

        let capture = ConfirmReceiptModel(
            draft: CapturedReceiptDraft(
                imageData: Data("page".utf8),
                suggestions: ReceiptSuggestions(),
                ocrRawText: nil,
                capturedAt: Date(timeIntervalSince1970: 1_775_000_000),
                ocrFailureNote: nil
            ),
            saveAction: { _ in }
        )
        XCTAssertFalse(capture.canSaveForLater)
    }

    /// A confirmation carries the set too. Inert on a confirmed receipt -
    /// nothing is served suggestions for one - and sent so the two writes
    /// this form can make differ in as little as possible.
    func testConfirmingAlsoReportsTheReviewedFields() async throws {
        let model = halfFilled(reviewedFields: ["vendor"])
        model.markTouched(.total)

        let saved = await model.save()
        XCTAssertTrue(saved)

        let request = try XCTUnwrap(api.confirmReceiptCalls.last).request
        XCTAssertEqual(request.reviewedFields, [.vendor, .totalCents])
        let body = try Self.encodedBody(request)
        XCTAssertEqual(body["status"] as? String, "confirmed")
        XCTAssertEqual(body["reviewedFields"] as? [String], ["vendor", "totalCents"])
    }

    /// The half-filled form as the capture screen's "Later" carries it -
    /// values plus the set that says which of them are a human's.
    func testPendingReceiptFieldsAreNilUntilSomethingIsReviewed() {
        let model = halfFilled(reviewedFields: nil)
        XCTAssertNil(model.pendingReceiptFields())

        model.markTouched(.vendor)
        model.vendorText = "Food Basics"
        let fields = model.pendingReceiptFields()
        XCTAssertEqual(fields?.reviewedFields, [.vendor])
        XCTAssertEqual(fields?.vendor, "Food Basics")
    }

    private static func encodedBody(_ request: some Encodable) throws -> [String: Any] {
        let data = try JSONEncoder().encode(request)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}
