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

    func testTwoFieldsMissingSolvesNothing() {
        let result = ReceiptArithmetic.deriveMissingAmount(
            subtotalCents: 10000, hstCents: nil, tipCents: nil, otherFeesCents: 0, totalCents: 11300
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
