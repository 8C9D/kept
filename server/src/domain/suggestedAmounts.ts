/**
 * Arithmetic sanity over a receipt's SUGGESTED amounts (2026-09-01).
 *
 * the owner's rule, stated plainly: the total must be at least the subtotal
 * plus the HST plus the tip plus the other fees. A total below the sum of
 * its own parts is not a receipt anyone printed - it is a misread label.
 * The diagnosis over 136 production receipts found the failure exactly
 * there: a $218.94 Costco purchase was stored as $8.50 because the parser
 * took "TOTAL DISCOUNT(S) $ 8.50" for the total, while the subtotal
 * (21160) and the HST (734) it read off the same slip were both right.
 *
 * ⚠ **Why this withholds a SUGGESTION and never rejects a saved value.**
 * The obvious version of this rule - refuse a confirmed receipt whose
 * amounts do not balance - would refuse real receipts, and the diagnosis
 * found them:
 *
 *   - Three legitimate receipts print `13.50 / 1.76 / 15.25`. The parts sum
 *     to 15.26. Nothing is wrong: the merchant rounded the tax and the
 *     total independently, and they disagree by a cent. Hence the two-cent
 *     tolerance below, not zero.
 *   - Post-subtotal discounts exist and are not always printed as such.
 *     Longos prints `Items Subtotal 52.55`, `Multi-Save -0.45`, then
 *     `Subtotal 52.10`; a parser that reads the first as the subtotal
 *     produces a set that fails this check on a receipt where every printed
 *     number is correct.
 *
 * So a person who reads the paper and types what it says must always be
 * able to save it - constraint 2 cuts both ways, and a server that refuses
 * a confirmed value is second-guessing the human it exists to serve. What
 * this governs is what the confirm screen PREFILLS, where the cost of being
 * wrong is one blank field instead of a wrong tax record.
 *
 * A pure function over five numbers, in the domain layer, so the rule is
 * written once and both clients inherit it (spec §4.1).
 */

/** The five amounts a receipt's suggestions can carry, any of them absent. */
export interface SuggestedAmounts {
  subtotalCents: number | null;
  hstCents: number | null;
  tipCents: number | null;
  otherFeesCents: number | null;
  totalCents: number | null;
}

/** The only two fields this rule ever withholds. */
export type WithheldAmountField = "totalCents" | "subtotalCents";

export interface SuggestedAmountsVerdict {
  /**
   * Which suggestions must not be served. Empty when the amounts are
   * consistent, which is the overwhelmingly common case.
   */
  withhold: WithheldAmountField[];
  /** Null exactly when `withhold` is empty. */
  reason: "total-below-components" | null;
}

/**
 * Independent rounding between a merchant's tax line and its total is worth
 * a cent, and two receipts in the diagnosis were off by one in opposite
 * directions, so two cents is the band where "off by rounding" stops and
 * "read the wrong line" starts. Deliberately tiny: the failure this catches
 * is off by dollars ($218.94 read as $8.50), never by three cents.
 */
export const SUGGESTED_AMOUNT_TOLERANCE_CENTS = 2;

/**
 * The widest HST-to-subtotal ratio any Canadian receipt can print, in basis
 * points. Ontario's combined rate is 13%; the highest provincial HST is
 * 15%, and a receipt whose tax line covers only part of its items reads
 * lower. 16% is that ceiling with room for a rounding cent on a tiny
 * subtotal - a ratio above it is not a tax rate, it is a misread number.
 */
const MAX_PLAUSIBLE_HST_RATE_BPS = 1600;

/**
 * Which of the five amounts, if any, must be withheld from the confirm
 * screen because the set they form is impossible.
 *
 * The check needs both a subtotal and a total: with either missing there is
 * no sum to compare against anything, and an absent amount is already
 * served as an absence. HST, tip and other fees each count as zero when
 * absent - "no tip line on this receipt" and "a tip of nothing" are the
 * same contribution to the total.
 *
 * When the set IS impossible, the question is which number is the liar, and
 * the tax rate answers it. If the HST is a plausible fraction of the
 * subtotal, those two corroborate each other and the total is the outlier
 * on its own - withhold the total and leave the pair. If the HST is absent
 * there is nothing to corroborate with, but there is also no reason to
 * doubt the subtotal, so again only the total goes. If the HST is present
 * and is NOT a plausible rate on that subtotal, then two of the three
 * numbers are already inconsistent with each other and there is nothing
 * left to trust: the total and the subtotal both go, and the person types
 * what the paper says.
 *
 * The rate test is integer cross-multiplication rather than division, the
 * same way `checkHstRatePlausibility` does it in arithmetic.ts: the
 * boundary is then exact instead of subject to floating-point error, and
 * money never touches a float in this codebase.
 */
export function validateSuggestedAmounts(
  amounts: SuggestedAmounts,
): SuggestedAmountsVerdict {
  const { subtotalCents, hstCents, tipCents, otherFeesCents, totalCents } =
    amounts;
  if (subtotalCents === null || totalCents === null) {
    return { withhold: [], reason: null };
  }

  const components =
    subtotalCents + (hstCents ?? 0) + (tipCents ?? 0) + (otherFeesCents ?? 0);
  if (totalCents >= components - SUGGESTED_AMOUNT_TOLERANCE_CENTS) {
    return { withhold: [], reason: null };
  }

  return {
    withhold: hstCorroboratesSubtotal(subtotalCents, hstCents)
      ? ["totalCents"]
      : ["totalCents", "subtotalCents"],
    reason: "total-below-components",
  };
}

/**
 * Do the subtotal and the HST agree well enough to stand while the total
 * falls? True when there is no HST to disagree with, and otherwise when the
 * ratio between them lands in [0%, 16%].
 *
 * A subtotal of zero or less anchors no rate at all (the same guard
 * `checkHstRatePlausibility` uses), so a receipt with one and a non-null
 * HST corroborates nothing and both amounts are withheld.
 */
function hstCorroboratesSubtotal(
  subtotalCents: number,
  hstCents: number | null,
): boolean {
  if (hstCents === null) {
    return true;
  }
  if (subtotalCents <= 0) {
    return false;
  }
  const scaledHst = hstCents * 10_000;
  return (
    scaledHst >= 0 && scaledHst <= MAX_PLAUSIBLE_HST_RATE_BPS * subtotalCents
  );
}
