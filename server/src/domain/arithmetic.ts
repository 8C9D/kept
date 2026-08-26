import type { Cents } from "./money.js";

/**
 * The confirm-screen arithmetic check (spec §7.2): does subtotal + hst
 * equal total? (Since 2026-08-26 those are the only two components a
 * receipt records; the other-tax line went with the field reduction.)
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
  totalCents: Cents;
}): ArithmeticCheck {
  // Without a subtotal there is nothing to reconcile against: a tax amount
  // alone is not expected to sum to the total.
  if (input.subtotalCents === null) {
    return "not-applicable";
  }
  // A missing HST field means "no such line on the receipt", so it
  // contributes nothing to the sum.
  const sum = input.subtotalCents + (input.hstCents ?? 0);
  return sum === input.totalCents ? "reconciles" : "mismatch";
}
