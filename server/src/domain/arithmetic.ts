import { cents, InvalidMoneyError, type Cents } from "./money.js";

/**
 * The confirm-screen arithmetic check (spec §7.2): does
 * subtotal + hst + tip + other_fees equal total?
 *
 * This restores the reconciliation the 2026-08-26 field reduction knowingly
 * gave up when it dropped the lumped `other_tax_cents` column: that removal
 * left the check as `subtotal + hst = total` and accepted, in writing, that
 * a tipped or foreign receipt would show the advisory amber warning forever
 * after. The 2026-08-28 product feedback reverses that in part - tips and
 * other fees come back as two separate fields rather than one lumped one -
 * and a tipped restaurant receipt (subtotal + HST + tip = total) reconciles
 * again instead of warning.
 *
 * The result is a prompt to look at the paper, never a rule: plenty of
 * legitimate receipts do not reconcile, so a "mismatch" warns and nothing
 * ever blocks on it. No server route consumes this yet - the consumers are
 * the confirm screens (iOS wave 4, web wave 7); it lives in the domain
 * layer now because the rule is the backend's to define (spec §4.1).
 */
export type ArithmeticCheck = "not-applicable" | "reconciles" | "mismatch";

export function checkReceiptArithmetic(input: {
  subtotalCents: Cents | null;
  hstCents: Cents | null;
  tipCents: Cents | null;
  otherFeesCents: Cents | null;
  totalCents: Cents;
}): ArithmeticCheck {
  // Without a subtotal there is nothing to reconcile against: a tax amount
  // alone is not expected to sum to the total.
  if (input.subtotalCents === null) {
    return "not-applicable";
  }
  // A missing line - HST, tip, or other fees - means "no such line on the
  // receipt", so it contributes nothing to the sum, exactly as HST already
  // did before this field existed.
  const sum =
    input.subtotalCents +
    (input.hstCents ?? 0) +
    (input.tipCents ?? 0) +
    (input.otherFeesCents ?? 0);
  return sum === input.totalCents ? "reconciles" : "mismatch";
}

/**
 * Proposal #1 (2026-08-28, `docs/proposals/2026-08-28-ux-enhancements.md`,
 * approved): when exactly one of the five money fields is blank and the
 * other four are filled, what value would make
 * `subtotal + hst + tip + otherFees = total` hold?
 *
 * ⚠ **This is a suggestion generator, nothing more.** Constraint 2 (spec
 * §3) governs it exactly the way it governs `checkReceiptArithmetic`
 * above: no server route may call this to fill in a receipt on create or
 * update. It exists so a client can offer a one-tap fill that lands amber
 * and unconfirmed, exactly like an OCR value - the person still has to
 * look at it and touch the field before it counts as confirmed. Wiring
 * this into the create or update path "to helpfully complete a receipt" is
 * the exact mistake constraint 2 exists to prevent; there is deliberately
 * no code path from here to a write.
 *
 * The field named in the result is which one was missing; `cents` is the
 * value that balances the equation for it - never a bare number, so a
 * caller can never confuse "which field is this a suggestion for" with
 * "did the caller remember the order the five fields came in".
 *
 * Returns null - "nothing to derive" - in four cases: zero fields are
 * missing (nothing to fill in), two or more are missing (the equation has
 * more than one unknown and cannot be solved), the balancing value falls
 * outside the storable cents range (`money.ts`'s int4 bound), or the
 * balancing value is a negative tip or a negative other-fees amount.
 *
 * **Why negative is refused for tip and otherFees but not for the other
 * three.** `money.ts` allows negative money generally, because a refund
 * receipt is real and already exercised by the export tests - a negative
 * subtotal, HST, or total is a receipt this system already stores. Tip and
 * other fees are different in kind: they are charges layered on top of a
 * subtotal (a gratuity, a delivery fee, a deposit), not amounts that can
 * themselves run negative on any receipt this app has ever seen - there is
 * no such thing as a negative tip or a rebate filed as an "other fee"
 * here, and a bill that does not reconcile does not retroactively invent
 * one. Offering "tip: -$3.00" as a one-tap fill would not be a suggestion
 * anyone could act on; it would be evidence the OTHER four fields are
 * wrong, which this function has no way to say and should not paper over
 * by inventing a number that looks like an answer. Refusing to derive is
 * the honest response - the person still sees the mismatch warning and
 * looks at the paper themselves.
 */
export type DerivableMoneyField =
  | "subtotalCents"
  | "hstCents"
  | "tipCents"
  | "otherFeesCents"
  | "totalCents";

export interface DerivedAmount {
  field: DerivableMoneyField;
  cents: Cents;
}

const DERIVABLE_FIELDS: readonly DerivableMoneyField[] = [
  "subtotalCents",
  "hstCents",
  "tipCents",
  "otherFeesCents",
  "totalCents",
];

/** Tip and other fees are charges, never a refund line - see the doc comment above. */
const NEVER_NEGATIVE_FIELDS: ReadonlySet<DerivableMoneyField> = new Set([
  "tipCents",
  "otherFeesCents",
]);

export function deriveMissingAmount(input: {
  subtotalCents: Cents | null;
  hstCents: Cents | null;
  tipCents: Cents | null;
  otherFeesCents: Cents | null;
  totalCents: Cents | null;
}): DerivedAmount | null {
  const missing = DERIVABLE_FIELDS.filter((field) => input[field] === null);
  if (missing.length !== 1) {
    return null;
  }
  const field = missing[0];
  if (field === undefined) {
    // Guaranteed by the length check above; narrows the type for TS.
    return null;
  }

  // Every field but the missing one is non-null here (the length-1 check
  // above), so summing with `?? 0` adds every KNOWN component and adds
  // nothing for the one field this call is solving for - whichever of the
  // five it turns out to be.
  const knownComponentSum =
    (input.subtotalCents ?? 0) +
    (input.hstCents ?? 0) +
    (input.tipCents ?? 0) +
    (input.otherFeesCents ?? 0);
  const value =
    field === "totalCents"
      ? knownComponentSum
      : (input.totalCents ?? 0) - knownComponentSum;

  if (NEVER_NEGATIVE_FIELDS.has(field) && value < 0) {
    return null;
  }

  try {
    return { field, cents: cents(value) };
  } catch (error) {
    if (error instanceof InvalidMoneyError) {
      // Out of the storable cents range - the mismatch is real, but there
      // is no honest suggestion to offer for it.
      return null;
    }
    throw error;
  }
}

/**
 * Proposal #7 (2026-08-28, `docs/proposals/2026-08-28-ux-enhancements.md`,
 * approved): a second advisory note beside `checkReceiptArithmetic` above,
 * for the failure that check cannot see - a heuristic reading one HALF of a
 * split-printed HST as though it were the whole tax. In Ontario that split
 * is 5% federal + 8% provincial = 13% combined (spec §7.3's split-HST
 * summing rule handles the case where BOTH lines are captured; this handles
 * the case where only one was). A parser that reads only the 8% provincial
 * line produces a number that is wrong, printed on the receipt, and
 * internally consistent - `hst / subtotal` looks exactly like a real
 * Canadian tax rate, so no arithmetic check catches it.
 *
 * ⚠ **Scoped narrowly, on purpose - read this before widening it.** The
 * proposal itself flags this as the riskiest of the four for false
 * positives, and the scoping below is the decision that makes it worth
 * shipping rather than deleting:
 *
 * - **This does NOT flag "any rate that isn't 13%".** 5% is a legitimate
 *   STANDALONE rate - GST-only provinces are real, and §7.3's own ranking
 *   already treats "a lone GST row" as a real tax, not a fragment. Flagging
 *   near-5% would fire on every legitimate GST-only receipt AND on every
 *   Ontario receipt where only the FEDERAL half was captured - and nothing
 *   in this system knows the province, so those two cases are
 *   indistinguishable from here. A grocery basket mixing taxable and
 *   zero-rated items also legitimately shows an effective rate well below
 *   13%, and groceries are most receipts - flagging broadly would make this
 *   noise on the receipts people capture most.
 * - **This flags only an effective rate close to 8%** - the PROVINCIAL half
 *   alone, which has no legitimate standalone reading as a Canadian
 *   federal-program tax figure the way 5% does. The tolerance is tight
 *   (±0.25 percentage points) specifically so it does not creep toward
 *   catching the 5%-or-mixed-basket cases above.
 *
 * ⚠ **The residual false positive, stated rather than hidden.** A genuinely
 * correct 13% Ontario receipt whose basket is roughly 38% zero-rated items
 * reconciles to an effective rate near 8% too - `hst / subtotal` cannot tell
 * "half a split" from "a real 13% receipt with a lot of zero-rated items" by
 * the ratio alone. That is exactly why this is an advisory amber
 * prompt-to-look, the same treatment §7.2 gives the arithmetic warning and
 * §10A.1 fixes as amber - never a block, never an auto-correction. The
 * person still has to look at the paper; this only says where to look.
 *
 * No route calls this - like `checkReceiptArithmetic` and
 * `deriveMissingAmount` above, it is a pure suggestion generator the
 * confirm screens mirror live (§7.2), not something that ever reaches a
 * write.
 */
export type HstRatePlausibility =
  | "not-applicable"
  | "plausible"
  | "looks-like-half-split";

/** The provincial half of a 13%-split HST (8% + 5% federal = 13%), in basis points. */
const HALF_SPLIT_RATE_BPS = 800;
/**
 * ±0.25 percentage points. Tight deliberately: these two numbers come
 * straight off the receipt with no summation or rounding across line items
 * the way, say, a multi-item subtotal would have, so there is no legitimate
 * reason for a genuine half-split reading to drift far from exactly 8%. A
 * looser tolerance would only buy more false positives on real 13% and 5%
 * receipts, never a real detection it would otherwise miss.
 */
const HALF_SPLIT_TOLERANCE_BPS = 25;

export function checkHstRatePlausibility(input: {
  subtotalCents: Cents | null;
  hstCents: Cents | null;
}): HstRatePlausibility {
  // No subtotal, no HST, or a subtotal that cannot anchor a rate (zero or a
  // refund's negative) - there is no ratio to evaluate.
  if (
    input.subtotalCents === null ||
    input.hstCents === null ||
    input.subtotalCents <= 0
  ) {
    return "not-applicable";
  }

  // Integer cross-multiplication rather than floating-point division, so
  // the boundary is exact rather than subject to rounding error:
  //   hst/subtotal within [target-tol, target+tol]/10000
  //   <=> hst*10000 within [target-tol, target+tol] * subtotal
  const scaledHst = input.hstCents * 10_000;
  const lowerBound =
    (HALF_SPLIT_RATE_BPS - HALF_SPLIT_TOLERANCE_BPS) * input.subtotalCents;
  const upperBound =
    (HALF_SPLIT_RATE_BPS + HALF_SPLIT_TOLERANCE_BPS) * input.subtotalCents;

  return scaledHst >= lowerBound && scaledHst <= upperBound
    ? "looks-like-half-split"
    : "plausible";
}
