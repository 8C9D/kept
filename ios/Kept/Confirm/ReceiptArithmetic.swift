import Foundation

/// Which of the confirm screen's five money fields a derived value fills.
/// Mirrors `DerivableMoneyField` in server/src/domain/arithmetic.ts one for
/// one - the same five fields, same order they appear on the form.
enum DerivableMoneyField: CaseIterable, Equatable {
    case subtotal, hst, tip, otherFees, total
}

/// A suggested value for exactly one blank field - the field it is for,
/// never a bare number, so a caller can never confuse "which field is
/// this a suggestion for" with "did I remember the order the five fields
/// came in" (the server type's own doc comment, arithmetic.ts, makes the
/// identical point).
struct DerivedAmount: Equatable {
    let field: DerivableMoneyField
    let cents: Int
}

/// Proposal #1 (2026-08-28, `docs/proposals/2026-08-28-ux-enhancements.md`,
/// approved) - the confirm screen's LIVE mirror of the server's
/// `deriveMissingAmount` (server/src/domain/arithmetic.ts). Root
/// `CLAUDE.md`'s one standing exception to "no domain logic on the client"
/// is exactly the confirm screen's live arithmetic warning, which has to
/// run on every keystroke because a network round trip per digit typed
/// would defeat the point of an inline check; this is that same exception
/// extended to a second computation over the identical five fields, not a
/// new domain rule invented for the client. `showsArithmeticWarning`
/// (ConfirmReceiptModel) already makes this move for the reconciliation
/// question - this is the "what value would fix it" half.
///
/// ⚠ Kept in exact correspondence with `deriveMissingAmount` on purpose:
/// same five fields, same knownComponentSum, same never-negative refusal
/// for tip and otherFees, same "more than one missing solves nothing"
/// rule, same storable-cents bound. A server-side change to that function
/// that is not mirrored here is a live bug - the confirm screen would
/// offer a fill the server's own function would refuse to write. There is
/// deliberately no path from this type to a save: it computes a
/// suggestion, ConfirmReceiptModel.applyDerivedFill() is the only thing
/// that writes it into a field, and only on an explicit tap - the person
/// still has to look at it and touch the field before it counts as
/// confirmed (constraint 2).
enum ReceiptArithmetic {
    /// Tip and other fees are charges layered on top of a subtotal - a
    /// gratuity, a delivery fee, a deposit - never something that runs
    /// negative on any receipt this app has ever seen. Mirrors
    /// arithmetic.ts's `NEVER_NEGATIVE_FIELDS` verbatim; that file's own
    /// doc comment states the reasoning in full: refusing to derive is the
    /// honest response, not inventing a number that looks like an answer.
    private static let neverNegativeFields: Set<DerivableMoneyField> = [.tip, .otherFees]

    /// The three fields a blank tip or other-fees line does not block
    /// (2026-09-01) - mirrors arithmetic.ts's `OMISSION_IS_ZERO_FIELDS`
    /// verbatim. A receipt that prints neither is the ordinary case, not
    /// an under-determined equation: `showsArithmeticWarning` has always
    /// read a blank tip or fee as "no such line on this receipt",
    /// contributing zero, and this function reading it as anything else
    /// meant the two disagreed about the same equation - the commonest
    /// receipt shape of all (a subtotal and a total, no tip, no fees, HST
    /// missing) had three blanks and derived nothing.
    private static let omissionIsZeroFields: Set<DerivableMoneyField> = [.tip, .otherFees]

    /// The storable range every money column is held to (money.ts's int4
    /// bound `MAX_STORABLE_CENTS`/`MIN_STORABLE_CENTS`) - mirrored so a
    /// value this function would otherwise offer, and the server would
    /// refuse to store, is refused here first instead of round-tripping
    /// through a failed save.
    private static let maxStorableCents = 2_147_483_647
    private static let minStorableCents = -2_147_483_648

    /// Whether a value is one the server could store - the same int4 gate
    /// `deriveMissingAmount` applies to anything it would otherwise offer,
    /// exposed (2026-09-01) so the confirm form's total-tracking rule
    /// refuses the identical values instead of keeping a second copy of
    /// the bound. Mirrors the web form's use of `finalizeDerivedAmount`
    /// for exactly the same purpose (ReceiptForm.tsx `applyComponentEdit`).
    static func isStorable(cents: Int) -> Bool {
        cents >= minStorableCents && cents <= maxStorableCents
    }

    /// `nil` for any of the five arguments means "this field is blank" -
    /// exactly `deriveMissingAmount`'s contract (never "invalid text";
    /// ConfirmReceiptModel is responsible for refusing to call this at all
    /// while any field holds unparseable text, the same suppression
    /// `showsArithmeticWarning` already applies).
    ///
    /// Returns `nil` in the same four cases the server function does:
    /// zero fields missing (nothing to fill in), two or more genuinely
    /// unknown (the equation has more than one unknown), the balancing
    /// value is a negative tip or negative other-fees, or the value falls
    /// outside the storable cents range.
    ///
    /// **What counts as "genuinely unknown", widened 2026-09-01** in step
    /// with the server's own widening (read `deriveMissingAmount`'s doc
    /// comment in arithmetic.ts for the full reasoning). When the field
    /// being solved for is HST, subtotal or total, a blank tip or
    /// other-fees line counts as 0 rather than as an unknown - so
    /// `{subtotal 1270, total 1435}` derives HST 165 and `{subtotal 1270,
    /// hst 165}` derives total 1435, which is the shape most receipts
    /// actually arrive in. Solving FOR a tip or other-fees amount still
    /// requires the other four present, and that asymmetry is the point:
    /// "the tip line is blank, so there was no tip" is a reading of the
    /// paper anyone would make, while "the tip is whatever makes these
    /// four numbers balance" is inventing a gratuity out of a rounding
    /// difference.
    static func deriveMissingAmount(
        subtotalCents: Int?,
        hstCents: Int?,
        tipCents: Int?,
        otherFeesCents: Int?,
        totalCents: Int?
    ) -> DerivedAmount? {
        let entries: [(DerivableMoneyField, Int?)] = [
            (.subtotal, subtotalCents),
            (.hst, hstCents),
            (.tip, tipCents),
            (.otherFees, otherFeesCents),
            (.total, totalCents),
        ]
        let missing = entries.filter { $0.1 == nil }.map(\.0)
        // Split the blanks into the ones that are genuinely unknown and
        // the ones that read as "no such line" - the server's identical
        // two-step, mirrored verbatim. Exactly one real unknown is
        // solvable; with none, the only solvable shape left is a single
        // blank tip or other-fees line with all four of its neighbours
        // filled in, which is the pre-2026-09-01 rule unchanged for those
        // two fields.
        let unknown = missing.filter { !omissionIsZeroFields.contains($0) }
        let solvable: DerivableMoneyField?
        if unknown.count == 1 {
            solvable = unknown.first
        } else if unknown.isEmpty, missing.count == 1 {
            solvable = missing.first
        } else {
            solvable = nil
        }
        guard let field = solvable else { return nil }

        // Every field but the one being solved for either has a value or
        // is a blank tip/other-fees line reading as zero, so summing with
        // `?? 0` adds every KNOWN component and adds nothing for the field
        // this call is solving for - whichever of the five it turns out to
        // be.
        let knownComponentSum =
            (subtotalCents ?? 0) + (hstCents ?? 0) + (tipCents ?? 0) + (otherFeesCents ?? 0)
        let value = field == .total ? knownComponentSum : (totalCents ?? 0) - knownComponentSum

        if neverNegativeFields.contains(field), value < 0 {
            return nil
        }
        guard isStorable(cents: value) else {
            return nil
        }
        return DerivedAmount(field: field, cents: value)
    }

    /// The second affordance proposal #1 names: when every one of the five
    /// fields is already filled in and they do not reconcile, what would
    /// need to move into tip - or into other fees - to make them?  There
    /// is no server counterpart to mirror here: `deriveMissingAmount` only
    /// ever solves for a MISSING field, and this question only makes sense
    /// when nothing is missing. Returns the raw difference
    /// (`total - (subtotal + hst + tip + otherFees)`), which can be
    /// negative if the fields already sum past the total; the caller
    /// (ConfirmReceiptModel.reconciliationResult(for:)) is what refuses a
    /// negative resulting tip or other-fees, the same rule this file
    /// applies to `deriveMissingAmount` above.
    ///
    /// `nil` when the books already balance - there is nothing to offer.
    static func reconciliationDifference(
        subtotalCents: Int,
        hstCents: Int,
        tipCents: Int,
        otherFeesCents: Int,
        totalCents: Int
    ) -> Int? {
        let difference = totalCents - (subtotalCents + hstCents + tipCents + otherFeesCents)
        return difference == 0 ? nil : difference
    }

    // MARK: - HST rate plausibility (proposal #7, 2026-08-28)

    /// The provincial half of a 13%-split HST (8% + 5% federal = 13%), in
    /// basis points - `HALF_SPLIT_RATE_BPS`, mirrored verbatim from the
    /// server's arithmetic.ts.
    private static let halfSplitRateBps = 800
    /// ±0.25 percentage points - `HALF_SPLIT_TOLERANCE_BPS`, mirrored
    /// verbatim. Tight deliberately: these two numbers come straight off
    /// the receipt with no summation or rounding across line items the way
    /// a multi-item subtotal would have, so there is no legitimate reason
    /// for a genuine half-split reading to drift far from exactly 8%. A
    /// looser tolerance would only buy more false positives on real 13%
    /// and 5% receipts, never a real detection it would otherwise miss.
    private static let halfSplitToleranceBps = 25

    /// Faithful mirror of the server's `checkHstRatePlausibility`
    /// (arithmetic.ts) - read that function's own extensive doc comment
    /// before touching this one; only the checking logic is restated here,
    /// not the reasoning behind it.
    ///
    /// ⚠ **This flags ONLY an effective rate within ±0.25 percentage points
    /// of 8%** - the PROVINCIAL half of a 13% Ontario split standing alone,
    /// which has no legitimate reading as a standalone Canadian tax figure
    /// the way 5% does. It does NOT flag "isn't 13%": 5% is a real
    /// standalone rate (GST-only provinces, and this system does not know
    /// the province) and a basket mixing taxable and zero-rated items - a
    /// grocery bill, which is most receipts - legitimately reconciles well
    /// under 13%. Widening this past the narrow 8% band is exactly the
    /// mistake the server's own comment warns against, and the residual
    /// false positive it states honestly still applies here: a genuinely
    /// correct 13% receipt whose basket is roughly 38% zero-rated also
    /// lands near 8% and will be flagged. That is exactly why this is an
    /// advisory prompt-to-look (§10A.1) - never a block, never an
    /// auto-correction - the same treatment `showsHstDisagreementNote` and
    /// `showsArithmeticWarning` already give their own signals.
    ///
    /// `nil` for either argument reads as "this field is blank", exactly
    /// `deriveMissingAmount`'s contract above - ConfirmReceiptModel is
    /// responsible for refusing to call this while either field holds
    /// unparseable text (`showsHstRateHint` applies the identical
    /// suppression `showsArithmeticWarning` already does).
    static func checkHstRatePlausibility(subtotalCents: Int?, hstCents: Int?) -> HstRatePlausibility {
        // No subtotal, no HST, or a subtotal that cannot anchor a rate
        // (zero, or a refund's negative) - there is no ratio to evaluate.
        // Mirrors the server's identical three-way guard verbatim.
        guard let subtotalCents, let hstCents, subtotalCents > 0 else {
            return .notApplicable
        }

        // Integer cross-multiplication rather than floating-point
        // division, mirroring the server's own technique verbatim so the
        // boundary is exact rather than subject to rounding error:
        //   hst/subtotal within [target-tol, target+tol]/10000
        //   <=> hst*10000 within [target-tol, target+tol] * subtotal
        let scaledHst = hstCents * 10_000
        let lowerBound = (halfSplitRateBps - halfSplitToleranceBps) * subtotalCents
        let upperBound = (halfSplitRateBps + halfSplitToleranceBps) * subtotalCents

        return scaledHst >= lowerBound && scaledHst <= upperBound
            ? .looksLikeHalfSplit
            : .plausible
    }

    // MARK: - The default rate (2026-09-01)

    /// Ontario's combined HST, in basis points - `DEFAULT_HST_RATE_BPS`,
    /// mirrored from both the server's arithmetic.ts and the web form.
    /// A DEFAULT rather than a fact: nothing in this system knows which
    /// province a receipt was printed in (`checkHstRatePlausibility`'s own
    /// comment makes the same point from the other direction), which is
    /// why the rate is a parameter here rather than a constant inside the
    /// arithmetic.
    static let defaultHstRateBps = 1300

    /// What HST and total a subtotal WOULD carry at a given rate - the
    /// live mirror of the server's `suggestDefaultRateHst`
    /// (server/src/domain/arithmetic.ts) and of the web form's own mirror
    /// of it (`suggestDefaultRateHst`, ReceiptForm.tsx). For the receipt
    /// that prints a subtotal and nothing else - a handwritten invoice, a
    /// slip whose tax line the parsers could not find - where
    /// `deriveMissingAmount` has nothing to subtract from and stays
    /// silent.
    ///
    /// ⚠ A suggestion, exactly like everything else in this file, and a
    /// weaker one than the derivations above: those solve an equation the
    /// receipt's own numbers determine, while this one applies a rate the
    /// receipt may not have been charged. It reaches the person only as a
    /// chip that says "HST at 13% of subtotal" in those words, never as a
    /// fill that happens quietly - constraint 2 with an extra reason to
    /// mean it. Deciding whether a receipt's CURRENCY makes the Ontario
    /// rate meaningful at all is the caller's (ConfirmReceiptModel's
    /// `hstRateCurrency`); this function mirrors a server function that
    /// takes a rate in basis points and has no business knowing about
    /// currencies.
    ///
    /// Round HALF UP in integer arithmetic, never a float: `(subtotal *
    /// rate + 5000) / 10000` floored is the same number a cash register
    /// computes, and dividing first introduces exactly the binary-fraction
    /// error the integer-cents rule exists to keep out.
    ///
    /// `nil` when there is nothing honest to suggest: a subtotal of zero
    /// or less (there is no rate to apply to nothing, and a refund's
    /// negative subtotal is not a receipt anyone wants a suggested tax on
    /// - the same guard `checkHstRatePlausibility` uses), or a total that
    /// would fall outside the storable cents range.
    static func suggestDefaultRateHst(
        subtotalCents: Int,
        rateBasisPoints: Int = defaultHstRateBps
    ) -> DefaultRateHst? {
        // A rate that is not a non-negative number of basis points is a
        // programming error rather than a receipt - the server throws
        // there; a precondition is this language's version of the same
        // refusal to quietly compute something.
        precondition(rateBasisPoints >= 0, "A tax rate must be a non-negative number of basis points")
        guard subtotalCents > 0 else { return nil }

        let (scaled, scaleOverflowed) = subtotalCents.multipliedReportingOverflow(by: rateBasisPoints)
        guard !scaleOverflowed else { return nil }
        let (rounded, roundOverflowed) = scaled.addingReportingOverflow(5_000)
        guard !roundOverflowed else { return nil }
        let hst = rounded / 10_000
        let (total, totalOverflowed) = subtotalCents.addingReportingOverflow(hst)
        guard !totalOverflowed, isStorable(cents: hst), isStorable(cents: total) else {
            // A subtotal near the int4 ceiling has a total that is not
            // storable. No suggestion is the honest answer; the mismatch
            // is not this function's to paper over.
            return nil
        }
        return DefaultRateHst(hstCents: hst, totalCents: total)
    }

    // MARK: - The amount floor (2026-09-01)

    /// Does the total at least cover the parts? The live mirror of the
    /// server's `checkAmountFloor` (arithmetic.ts) and of the web form's
    /// (`checkAmountFloor`, ReceiptForm.tsx) - a third advisory note
    /// beside `checkReceiptArithmetic` and `checkHstRatePlausibility`, for
    /// the one direction of mismatch that is never a legitimate receipt.
    ///
    /// Distinct from the general reconciliation check, which fires on any
    /// inequality in either direction. A total that EXCEEDS its components
    /// has an ordinary explanation - a line this form has no box for, a
    /// fee nobody typed - and says "there is something else on this
    /// paper". A total BELOW its components has no such reading: subtotal,
    /// HST, tip and fees are all charges, and no arrangement of them can
    /// add up to more than what was paid. One of the numbers on screen is
    /// wrong, and that is a sharper thing to say than "worth a look".
    ///
    /// A missing HST, tip or other-fees line contributes zero, the same
    /// reading every other function here gives an absent line.
    /// `notApplicable` when either anchor is missing: with no subtotal
    /// there are no components to fall below, and with no total there is
    /// nothing to compare.
    ///
    /// ⚠ Never a block - nothing in this file ever is. Plenty of receipts
    /// are genuinely odd, and the person confirming is the authority.
    static func checkAmountFloor(
        subtotalCents: Int?,
        hstCents: Int?,
        tipCents: Int?,
        otherFeesCents: Int?,
        totalCents: Int?
    ) -> AmountFloorCheck {
        guard let subtotalCents, let totalCents else { return .notApplicable }
        let components = subtotalCents + (hstCents ?? 0) + (tipCents ?? 0) + (otherFeesCents ?? 0)
        return totalCents < components ? .totalBelowComponents : .ok
    }

    // MARK: - Suggested-amount sanity (2026-09-01)

    /// Independent rounding between a merchant's tax line and its total is
    /// worth a cent, and two receipts in the 2026-09-01 diagnosis were off
    /// by one in opposite directions, so two cents is where "off by
    /// rounding" stops and "read the wrong line" starts. Mirrors
    /// `SUGGESTED_AMOUNT_TOLERANCE_CENTS` (suggestedAmounts.ts) verbatim.
    private static let suggestedAmountToleranceCents = 2
    /// The widest HST-to-subtotal ratio any Canadian receipt can print, in
    /// basis points - `MAX_PLAUSIBLE_HST_RATE_BPS`, mirrored verbatim.
    private static let maxPlausibleHstRateBps = 1600

    /// Faithful mirror of the server's `validateSuggestedAmounts`
    /// (server/src/domain/suggestedAmounts.ts) - read that function's own
    /// doc comment for the full reasoning; only the checking logic is
    /// restated here.
    ///
    /// the owner's rule: the total must be at least the subtotal plus HST plus
    /// tip plus other fees. A total below the sum of its own parts is not a
    /// receipt anyone printed, it is a misread label - the $218.94 Costco
    /// purchase stored as $8.50 off a `TOTAL DISCOUNT(S)` line, with the
    /// subtotal and HST from the same slip both correct.
    ///
    /// ⚠ This withholds a SUGGESTION and never blocks a save. A person who
    /// reads the paper and types what it says must always be able to save
    /// it (constraint 2 cuts both ways); what this governs is what the
    /// confirm screen PREFILLS, where being wrong costs one blank field
    /// instead of a wrong tax record. `showsArithmeticWarning` is the
    /// separate, softer signal on values a human has actually typed.
    static func validateSuggestedAmounts(
        subtotalCents: Int?,
        hstCents: Int?,
        tipCents: Int?,
        otherFeesCents: Int?,
        totalCents: Int?
    ) -> Set<WithheldAmountField> {
        guard let subtotalCents, let totalCents else { return [] }

        let components = subtotalCents + (hstCents ?? 0) + (tipCents ?? 0) + (otherFeesCents ?? 0)
        if totalCents >= components - suggestedAmountToleranceCents {
            return []
        }

        // Which number is the liar? If the HST is a plausible fraction of
        // the subtotal the two corroborate each other and the total is the
        // outlier alone; if there is no HST there is nothing to corroborate
        // with, but no reason to doubt the subtotal either. Only when the
        // HST is present AND is not a plausible rate on that subtotal are
        // two of the three already inconsistent, and both go.
        return hstCorroboratesSubtotal(subtotalCents: subtotalCents, hstCents: hstCents)
            ? [.totalCents]
            : [.totalCents, .subtotalCents]
    }

    private static func hstCorroboratesSubtotal(subtotalCents: Int, hstCents: Int?) -> Bool {
        guard let hstCents else { return true }
        guard subtotalCents > 0 else { return false }
        // Integer cross-multiplication, never division - the same technique
        // `checkHstRatePlausibility` uses, for the same exactness reason.
        let scaledHst = hstCents * 10_000
        return scaledHst >= 0 && scaledHst <= maxPlausibleHstRateBps * subtotalCents
    }
}

/// Which suggested amounts a `validateSuggestedAmounts` verdict withholds -
/// mirrors `WithheldAmountField` (suggestedAmounts.ts). Only these two are
/// ever withheld: HST, tip and other fees are never the number this rule
/// can prove wrong.
enum WithheldAmountField: Hashable, CaseIterable {
    case totalCents, subtotalCents
}

/// Mirrors `HstRatePlausibility` (arithmetic.ts) one for one - see
/// `ReceiptArithmetic.checkHstRatePlausibility` for the full reasoning.
enum HstRatePlausibility: Equatable {
    case notApplicable, plausible, looksLikeHalfSplit
}

/// The HST a rate would produce on a subtotal, and the total that follows
/// from it - mirrors `DefaultRateHst` (arithmetic.ts). Both halves
/// together, never a bare tax figure, because applying the suggestion
/// moves both boxes and a caller that had to add them back up itself
/// could round differently than the function that computed them.
struct DefaultRateHst: Equatable {
    let hstCents: Int
    let totalCents: Int
}

/// Mirrors `AmountFloorCheck` (arithmetic.ts) one for one - see
/// `ReceiptArithmetic.checkAmountFloor` for the full reasoning.
enum AmountFloorCheck: Equatable {
    case notApplicable, ok, totalBelowComponents
}
