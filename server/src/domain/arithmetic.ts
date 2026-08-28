import type { Cents } from "./money.js";

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
