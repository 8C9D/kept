import XCTest
@testable import Kept

/// ReceiptArithmetic.swift's own suite: the confirm screen's live mirror
/// of the server's `deriveMissingAmount` (server/src/domain/arithmetic.ts),
/// exercised here with no ConfirmReceiptModel, no view, no camera - a pure
/// computation over five optional Ints, exactly the §10.2 shape a
/// simulator-only module should have.
///
/// Every case below is chosen to correspond to a documented behaviour of
/// the server function it mirrors, so a future edit to one side that
/// forgets the other shows up as a failing assertion here rather than as
/// a live disagreement between what this screen offers and what the
/// server would have refused to write.
final class ReceiptArithmeticTests: XCTestCase {
    // MARK: - Each field derivable

    func testDerivesTheMissingSubtotal() {
        // 84.00 + 10.92 = 94.92, minus tip 15.00 and other fees 0 = 79.92? -
        // simpler: total 113.00, hst 13.00, tip 0, otherFees 0, subtotal ?
        let result = ReceiptArithmetic.deriveMissingAmount(
            subtotalCents: nil, hstCents: 1300, tipCents: 0, otherFeesCents: 0, totalCents: 11300
        )
        XCTAssertEqual(result, DerivedAmount(field: .subtotal, cents: 10000))
    }

    func testDerivesTheMissingHst() {
        let result = ReceiptArithmetic.deriveMissingAmount(
            subtotalCents: 10000, hstCents: nil, tipCents: 0, otherFeesCents: 0, totalCents: 11300
        )
        XCTAssertEqual(result, DerivedAmount(field: .hst, cents: 1300))
    }

    func testDerivesTheMissingTip() {
        let result = ReceiptArithmetic.deriveMissingAmount(
            subtotalCents: 10000, hstCents: 1300, tipCents: nil, otherFeesCents: 0, totalCents: 12800
        )
        XCTAssertEqual(result, DerivedAmount(field: .tip, cents: 1500))
    }

    func testDerivesTheMissingOtherFees() {
        let result = ReceiptArithmetic.deriveMissingAmount(
            subtotalCents: 10000, hstCents: 1300, tipCents: 0, otherFeesCents: nil, totalCents: 11800
        )
        XCTAssertEqual(result, DerivedAmount(field: .otherFees, cents: 500))
    }

    func testDerivesTheMissingTotalAsTheSumOfTheOtherFour() {
        let result = ReceiptArithmetic.deriveMissingAmount(
            subtotalCents: 10000, hstCents: 1300, tipCents: 1500, otherFeesCents: 500, totalCents: nil
        )
        XCTAssertEqual(result, DerivedAmount(field: .total, cents: 13300))
    }

    /// The restaurant case the proposal itself names: subtotal + HST + tip
    /// = total, tip missing.
    func testTheRestaurantCaseFromTheProposal() {
        // Pasta+wine 84.00, HST 10.92, tip missing, total 109.92.
        let result = ReceiptArithmetic.deriveMissingAmount(
            subtotalCents: 8400, hstCents: 1092, tipCents: nil, otherFeesCents: 0, totalCents: 10992
        )
        XCTAssertEqual(result, DerivedAmount(field: .tip, cents: 1500))
    }

    // MARK: - Refusals mirrored from the server

    func testNothingMissingSolvesNothing() {
        let result = ReceiptArithmetic.deriveMissingAmount(
            subtotalCents: 10000, hstCents: 1300, tipCents: 0, otherFeesCents: 0, totalCents: 11300
        )
        XCTAssertNil(result)
    }

    /// Two GENUINE unknowns solve nothing: subtotal and total are both
    /// blank, and no arrangement of the rest determines either.
    func testTwoUnknownFieldsSolveNothing() {
        let result = ReceiptArithmetic.deriveMissingAmount(
            subtotalCents: nil, hstCents: 1300, tipCents: 0, otherFeesCents: 0, totalCents: nil
        )
        XCTAssertNil(result)
    }

    // MARK: - A blank tip or fee line is not an unknown (widened 2026-09-01)

    /// The commonest receipt shape there is - a subtotal and a total, no
    /// tip line, no fee line, HST unread. Before the widening this had
    /// three nulls and derived nothing, which made the whole affordance
    /// almost unreachable; `checkReceiptArithmetic` had always read those
    /// two blanks as "no such line", and the two functions disagreeing
    /// about the same equation was the bug.
    func testABlankTipAndFeeLineDoNotBlockDerivingTheHst() {
        let result = ReceiptArithmetic.deriveMissingAmount(
            subtotalCents: 1270, hstCents: nil, tipCents: nil, otherFeesCents: nil, totalCents: 1435
        )
        XCTAssertEqual(result, DerivedAmount(field: .hst, cents: 165))
    }

    /// The same widening solving for the total instead: subtotal and HST
    /// are on the paper, neither of the other two lines is.
    func testABlankTipAndFeeLineDoNotBlockDerivingTheTotal() {
        let result = ReceiptArithmetic.deriveMissingAmount(
            subtotalCents: 1270, hstCents: 165, tipCents: nil, otherFeesCents: nil, totalCents: nil
        )
        XCTAssertEqual(result, DerivedAmount(field: .total, cents: 1435))
    }

    /// And solving for the subtotal, the third field the widening covers.
    func testABlankTipAndFeeLineDoNotBlockDerivingTheSubtotal() {
        let result = ReceiptArithmetic.deriveMissingAmount(
            subtotalCents: nil, hstCents: 165, tipCents: nil, otherFeesCents: nil, totalCents: 1435
        )
        XCTAssertEqual(result, DerivedAmount(field: .subtotal, cents: 1270))
    }

    /// The asymmetry that is the point of the widening: "the tip line is
    /// blank, so there was no tip" is a reading anyone would make of the
    /// paper, while "the tip is whatever makes these four numbers balance"
    /// invents a gratuity out of a rounding difference. Solving FOR a tip
    /// still needs all four of its neighbours, so a blank fee line beside
    /// a blank tip line derives nothing.
    func testSolvingForATipStillNeedsTheOtherFourPresent() {
        let result = ReceiptArithmetic.deriveMissingAmount(
            subtotalCents: 10000, hstCents: 1300, tipCents: nil, otherFeesCents: nil, totalCents: 12800
        )
        XCTAssertNil(result)
    }

    func testEveryFieldMissingSolvesNothing() {
        let result = ReceiptArithmetic.deriveMissingAmount(
            subtotalCents: nil, hstCents: nil, tipCents: nil, otherFeesCents: nil, totalCents: nil
        )
        XCTAssertNil(result)
    }

    /// The server's own named refusal: a derived negative tip is refused,
    /// even though the arithmetic would "balance" - there is no such
    /// thing as a negative tip on any receipt this app has ever seen.
    func testNegativeDerivedTipIsRefused() {
        // Total is LESS than subtotal + HST: a derived tip would be
        // negative.
        let result = ReceiptArithmetic.deriveMissingAmount(
            subtotalCents: 10000, hstCents: 1300, tipCents: nil, otherFeesCents: 0, totalCents: 11000
        )
        XCTAssertNil(result)
    }

    /// Same refusal, the other never-negative field.
    func testNegativeDerivedOtherFeesIsRefused() {
        let result = ReceiptArithmetic.deriveMissingAmount(
            subtotalCents: 10000, hstCents: 1300, tipCents: 0, otherFeesCents: nil, totalCents: 11000
        )
        XCTAssertNil(result)
    }

    /// A derived NEGATIVE subtotal, HST or total is NOT refused - a refund
    /// receipt is a real receipt this system already stores (money.ts's
    /// own reasoning, mirrored here), and the refusal is scoped to tip and
    /// other fees only.
    func testNegativeSubtotalHstOrTotalIsAllowed() {
        let derivedSubtotal = ReceiptArithmetic.deriveMissingAmount(
            subtotalCents: nil, hstCents: -100, tipCents: 0, otherFeesCents: 0, totalCents: -1100
        )
        XCTAssertEqual(derivedSubtotal, DerivedAmount(field: .subtotal, cents: -1000))

        let derivedTotal = ReceiptArithmetic.deriveMissingAmount(
            subtotalCents: -1000, hstCents: -100, tipCents: 0, otherFeesCents: 0, totalCents: nil
        )
        XCTAssertEqual(derivedTotal, DerivedAmount(field: .total, cents: -1100))
    }

    /// The storable-cents bound (money.ts's int4 range), mirrored: a value
    /// that would overflow it is refused rather than offered as a
    /// suggestion the server could never store.
    func testAValueOutsideTheStorableRangeIsRefused() {
        let result = ReceiptArithmetic.deriveMissingAmount(
            subtotalCents: 2_147_483_647, hstCents: 1, tipCents: 0, otherFeesCents: 0, totalCents: nil
        )
        XCTAssertNil(result)
    }

    // MARK: - Reconciliation difference (the second affordance)

    func testReconciliationDifferenceIsTheAmountNeededToBalance() {
        // 100 + 13 = 113, total is 128.00: 15.00 short.
        let difference = ReceiptArithmetic.reconciliationDifference(
            subtotalCents: 10000, hstCents: 1300, tipCents: 0, otherFeesCents: 0, totalCents: 12800
        )
        XCTAssertEqual(difference, 1500)
    }

    func testReconciliationDifferenceIsNilWhenAlreadyBalanced() {
        let difference = ReceiptArithmetic.reconciliationDifference(
            subtotalCents: 10000, hstCents: 1300, tipCents: 1500, otherFeesCents: 0, totalCents: 12800
        )
        XCTAssertNil(difference)
    }

    /// The fields already summing PAST the total is a real, representable
    /// case - the difference is negative, and it is
    /// ConfirmReceiptModel.reconciliationResult(for:) that refuses to
    /// offer a fill that would push tip or other fees negative, not this
    /// function (it has no server counterpart to mirror that refusal
    /// from - see its own doc comment).
    func testReconciliationDifferenceCanBeNegative() {
        let difference = ReceiptArithmetic.reconciliationDifference(
            subtotalCents: 10000, hstCents: 1300, tipCents: 2000, otherFeesCents: 0, totalCents: 12800
        )
        XCTAssertEqual(difference, -500)
    }

    // MARK: - HST rate plausibility (proposal #7, 2026-08-28)
    //
    // Mirrors server/tests/unit/arithmetic.test.ts's `checkHstRatePlausibility`
    // suite case for case - the same reasoning as this file's own header
    // comment: a future edit to one side that forgets the other should show
    // up as a failing assertion here.

    func testRateHintNotApplicableWithoutASubtotal() {
        XCTAssertEqual(
            ReceiptArithmetic.checkHstRatePlausibility(subtotalCents: nil, hstCents: 800),
            .notApplicable
        )
    }

    func testRateHintNotApplicableWithoutAnHstAmount() {
        XCTAssertEqual(
            ReceiptArithmetic.checkHstRatePlausibility(subtotalCents: 10000, hstCents: nil),
            .notApplicable
        )
    }

    func testRateHintNotApplicableWithAZeroSubtotal() {
        // No rate to anchor on - zero subtotal, zero HST included.
        XCTAssertEqual(
            ReceiptArithmetic.checkHstRatePlausibility(subtotalCents: 0, hstCents: 0),
            .notApplicable
        )
    }

    func testRateHintNotApplicableWithANegativeSubtotal() {
        XCTAssertEqual(
            ReceiptArithmetic.checkHstRatePlausibility(subtotalCents: -10000, hstCents: -800),
            .notApplicable
        )
    }

    /// A lone GST row is a real, legitimate tax - flagging near-5% would
    /// fire on every GST-only-province receipt, and this system does not
    /// know the province.
    func testRateHintDoesNotFlagALegitimate5PercentGstOnlyReceipt() {
        XCTAssertEqual(
            ReceiptArithmetic.checkHstRatePlausibility(subtotalCents: 10000, hstCents: 500),
            .plausible
        )
    }

    func testRateHintDoesNotFlagALegitimate13PercentOntarioReceipt() {
        XCTAssertEqual(
            ReceiptArithmetic.checkHstRatePlausibility(subtotalCents: 10000, hstCents: 1300),
            .plausible
        )
    }

    func testRateHintDoesNotFlagALegitimate15PercentAtlanticReceipt() {
        XCTAssertEqual(
            ReceiptArithmetic.checkHstRatePlausibility(subtotalCents: 10000, hstCents: 1500),
            .plausible
        )
    }

    func testRateHintDoesNotFlagAGenuinelyExempt0PercentReceipt() {
        XCTAssertEqual(
            ReceiptArithmetic.checkHstRatePlausibility(subtotalCents: 10000, hstCents: 0),
            .plausible
        )
    }

    func testRateHintFlagsAn8PercentReceiptAsLookingLikeHalfASplit() {
        XCTAssertEqual(
            ReceiptArithmetic.checkHstRatePlausibility(subtotalCents: 10000, hstCents: 800),
            .looksLikeHalfSplit
        )
    }

    func testRateHintFlagsTheExactLowerBoundaryOfTheTolerance() {
        // 7.75%
        XCTAssertEqual(
            ReceiptArithmetic.checkHstRatePlausibility(subtotalCents: 10000, hstCents: 775),
            .looksLikeHalfSplit
        )
    }

    func testRateHintDoesNotFlagJustBelowTheLowerBoundary() {
        // 7.74%
        XCTAssertEqual(
            ReceiptArithmetic.checkHstRatePlausibility(subtotalCents: 10000, hstCents: 774),
            .plausible
        )
    }

    func testRateHintFlagsTheExactUpperBoundaryOfTheTolerance() {
        // 8.25%
        XCTAssertEqual(
            ReceiptArithmetic.checkHstRatePlausibility(subtotalCents: 10000, hstCents: 825),
            .looksLikeHalfSplit
        )
    }

    func testRateHintDoesNotFlagJustAboveTheUpperBoundary() {
        // 8.26%
        XCTAssertEqual(
            ReceiptArithmetic.checkHstRatePlausibility(subtotalCents: 10000, hstCents: 826),
            .plausible
        )
    }

    /// The boundary is a RATE, not a fixed cents offset - and the integer
    /// cross-multiplication this mirrors verbatim (`scaledHst`/`lowerBound`/
    /// `upperBound`) is exactly what keeps that boundary exact at a scale
    /// where `Double(hstCents) / Double(subtotalCents)` compared against
    /// the literal `0.0775` would risk a wrong answer: 0.0775 (775/10000 =
    /// 31/400) has no exact binary floating-point representation, so both
    /// the literal and the computed ratio carry their own rounding error,
    /// and nothing guarantees those two errors land on the same side of
    /// the boundary. The integer form has no such risk - `scaledHst` and
    /// the two bounds are exact integers at any scale.
    func testRateHintHoldsTheSameBoundaryAtADifferentSubtotalScale() {
        XCTAssertEqual(
            ReceiptArithmetic.checkHstRatePlausibility(subtotalCents: 100000, hstCents: 7750),
            .looksLikeHalfSplit
        )
        XCTAssertEqual(
            ReceiptArithmetic.checkHstRatePlausibility(subtotalCents: 100000, hstCents: 7749),
            .plausible
        )
    }
}

// MARK: - Suggested-amount sanity (2026-09-01)

/// `validateSuggestedAmounts`, the client mirror of the server's rule in
/// server/src/domain/suggestedAmounts.ts. The owner's rule: the total must be
/// at least the subtotal plus HST plus tip plus fees, and a set that is not
/// is a misread label rather than a receipt anyone printed.
final class SuggestedAmountValidationTests: XCTestCase {
    private func withheld(
        subtotal: Int? = nil,
        hst: Int? = nil,
        tip: Int? = nil,
        otherFees: Int? = nil,
        total: Int? = nil
    ) -> Set<WithheldAmountField> {
        ReceiptArithmetic.validateSuggestedAmounts(
            subtotalCents: subtotal,
            hstCents: hst,
            tipCents: tip,
            otherFeesCents: otherFees,
            totalCents: total
        )
    }

    /// The Costco receipt this rule exists for: a $218.94 purchase whose
    /// total was read off `TOTAL DISCOUNT(S) $ 8.50`, with the subtotal and
    /// HST from the same slip both correct. 734 on 21160 is 3.5% - a
    /// plausible tax fraction on a basket of mostly zero-rated groceries -
    /// so those two corroborate each other and only the total goes.
    func testCostcoShapeWithholdsTheTotal() {
        XCTAssertEqual(withheld(subtotal: 21160, hst: 734, total: 850), [.totalCents])
    }

    /// The same verdict with no HST at all: nothing corroborates the
    /// subtotal, but nothing impugns it either.
    func testNoHstStillWithholdsOnlyTheTotal() {
        XCTAssertEqual(withheld(subtotal: 986, total: 325), [.totalCents])
    }

    /// An HST that is not a possible fraction of the subtotal means two of
    /// the three numbers already disagree with each other; there is nothing
    /// left to trust and the person types both from the paper.
    func testImpossibleTaxRateWithholdsTheSubtotalToo() {
        XCTAssertEqual(withheld(subtotal: 1000, hst: 900, total: 500), [.totalCents, .subtotalCents])
    }

    /// A subtotal that cannot anchor a rate at all.
    func testZeroSubtotalWithANonNilHstWithholdsBoth() {
        XCTAssertEqual(withheld(subtotal: 0, hst: 100, total: -50), [.totalCents, .subtotalCents])
    }

    /// The three legitimate receipts printing `13.50 / 1.76 / 15.25`, whose
    /// parts sum to 15.26: a merchant rounded the tax and the total
    /// independently. Two cents is where "off by rounding" stops.
    func testAOneCentRoundingGapIsNotAnError() {
        XCTAssertTrue(withheld(subtotal: 1350, hst: 176, total: 1525).isEmpty)
        XCTAssertTrue(withheld(subtotal: 1350, hst: 176, total: 1524).isEmpty)
        XCTAssertEqual(withheld(subtotal: 1350, hst: 176, total: 1400), [.totalCents])
    }

    /// Tip and other fees count toward the components, so a restaurant bill
    /// that reconciles is untouched and one whose total is below its own
    /// parts is not.
    func testTipAndFeesCountTowardTheComponents() {
        XCTAssertTrue(withheld(subtotal: 8400, hst: 1092, tip: 1500, total: 10992).isEmpty)
        XCTAssertEqual(withheld(subtotal: 8400, hst: 1092, tip: 1500, otherFees: 500, total: 9000), [.totalCents])
    }

    /// With either end missing there is no sum to compare against
    /// anything, and an absent amount is already served as an absence.
    func testAMissingSubtotalOrTotalWithholdsNothing() {
        XCTAssertTrue(withheld(hst: 734, total: 850).isEmpty)
        XCTAssertTrue(withheld(subtotal: 21160, hst: 734).isEmpty)
        XCTAssertTrue(withheld().isEmpty)
    }
}

/// The two server mirrors added 2026-09-01 - `suggestDefaultRateHst` and
/// `checkAmountFloor` - exercised the same way the rest of this file
/// exercises `deriveMissingAmount`: as pure computations over optional
/// Ints, with each case chosen to correspond to a documented behaviour of
/// the server function it mirrors (server/src/domain/arithmetic.ts) and of
/// the web form's own mirror of it.
final class DefaultRateHstTests: XCTestCase {
    /// The receipt from the owner's own instruction: "if only a subtotal is
    /// known, suggest HST at 13% and the total." 12.70 at 13% is 1.651,
    /// which rounds to 1.65, and the total that follows is 14.35.
    func testThirteenPercentOfASubtotalAndTheTotalThatFollows() {
        XCTAssertEqual(
            ReceiptArithmetic.suggestDefaultRateHst(subtotalCents: 1270),
            DefaultRateHst(hstCents: 165, totalCents: 1435)
        )
    }

    /// Round HALF UP in integer arithmetic, never a float and never
    /// truncation: 13% of $0.50 is exactly 6.5 cents, and a cash register
    /// charges 7. `(subtotal * rate + 5000) / 10000` floored is that
    /// number; `subtotal * rate / 10000` floored is 6.
    func testExactHalvesRoundUp() {
        XCTAssertEqual(
            ReceiptArithmetic.suggestDefaultRateHst(subtotalCents: 50),
            DefaultRateHst(hstCents: 7, totalCents: 57)
        )
    }

    /// A rate below the halfway point still rounds down - proof the +5000
    /// is a rounding term and not a thumb on the scale.
    func testBelowTheHalfwayPointRoundsDown() {
        // 13% of $0.30 is 3.9 cents.
        XCTAssertEqual(
            ReceiptArithmetic.suggestDefaultRateHst(subtotalCents: 30),
            DefaultRateHst(hstCents: 4, totalCents: 34)
        )
        // 13% of $0.10 is 1.3 cents.
        XCTAssertEqual(
            ReceiptArithmetic.suggestDefaultRateHst(subtotalCents: 10),
            DefaultRateHst(hstCents: 1, totalCents: 11)
        )
    }

    /// The rate is a parameter in basis points, never a constant baked
    /// into the arithmetic - the server's own reasoning, mirrored: nothing
    /// here knows which province a receipt was printed in, so a client
    /// that learns otherwise can pass 5% without this function growing a
    /// table of provinces.
    func testTheRateIsAParameter() {
        XCTAssertEqual(
            ReceiptArithmetic.suggestDefaultRateHst(subtotalCents: 1000, rateBasisPoints: 500),
            DefaultRateHst(hstCents: 50, totalCents: 1050)
        )
        XCTAssertEqual(ReceiptArithmetic.defaultHstRateBps, 1300)
    }

    /// There is no rate to apply to nothing, and a refund's negative
    /// subtotal is not a receipt anyone wants a suggested tax on - the
    /// same guard `checkHstRatePlausibility` uses.
    func testAZeroOrNegativeSubtotalSuggestsNothing() {
        XCTAssertNil(ReceiptArithmetic.suggestDefaultRateHst(subtotalCents: 0))
        XCTAssertNil(ReceiptArithmetic.suggestDefaultRateHst(subtotalCents: -1270))
    }

    /// A subtotal near the int4 ceiling has a total that is not storable.
    /// No suggestion is the honest answer rather than one the server would
    /// refuse to write.
    func testASubtotalWhoseTotalWouldNotBeStorableSuggestsNothing() {
        XCTAssertNil(ReceiptArithmetic.suggestDefaultRateHst(subtotalCents: 2_147_483_647))
    }
}

final class AmountFloorTests: XCTestCase {
    private func floor(
        subtotal: Int? = nil,
        hst: Int? = nil,
        tip: Int? = nil,
        otherFees: Int? = nil,
        total: Int? = nil
    ) -> AmountFloorCheck {
        ReceiptArithmetic.checkAmountFloor(
            subtotalCents: subtotal, hstCents: hst, tipCents: tip,
            otherFeesCents: otherFees, totalCents: total
        )
    }

    /// The Costco receipt from production, in the shape that made this
    /// check necessary: subtotal 218.94 and HST 21.16 both read correctly
    /// off the slip, with the total stored as 8.50 from a
    /// `TOTAL DISCOUNT(S)` line. No receipt charges less than the lines it
    /// itself lists.
    func testATotalBelowItsOwnComponentsIsFlagged() {
        XCTAssertEqual(floor(subtotal: 21894, hst: 2116, total: 850), .totalBelowComponents)
    }

    /// A total ABOVE its components is not this check's business: there is
    /// an ordinary explanation - a line this form has no box for - and
    /// the general reconciliation warning already says "worth a look".
    func testATotalAboveItsComponentsIsFine() {
        XCTAssertEqual(floor(subtotal: 10000, hst: 1300, total: 12000), .ok)
    }

    func testATotalThatExactlyCoversItsComponentsIsFine() {
        XCTAssertEqual(floor(subtotal: 10000, hst: 1300, total: 11300), .ok)
    }

    /// One cent below is still below - the floor has no tolerance, which
    /// is what distinguishes it from `validateSuggestedAmounts`' two-cent
    /// rounding allowance on values a parser produced. These are numbers a
    /// human typed.
    func testOneCentBelowIsBelow() {
        XCTAssertEqual(floor(subtotal: 10000, hst: 1300, total: 11299), .totalBelowComponents)
    }

    /// A missing HST, tip or other-fees line contributes zero, the same
    /// reading every other function in this file gives an absent line.
    func testAbsentLinesContributeZero() {
        XCTAssertEqual(floor(subtotal: 10000, total: 10000), .ok)
        XCTAssertEqual(floor(subtotal: 8400, hst: 1092, tip: 1500, otherFees: 500, total: 10000), .totalBelowComponents)
    }

    /// With no subtotal there are no components to fall below; with no
    /// total there is nothing to compare.
    func testEitherAnchorMissingIsNotApplicable() {
        XCTAssertEqual(floor(hst: 1300, total: 11300), .notApplicable)
        XCTAssertEqual(floor(subtotal: 10000, hst: 1300), .notApplicable)
        XCTAssertEqual(floor(), .notApplicable)
    }
}
