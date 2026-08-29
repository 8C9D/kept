import type { KeptApi, PossibleDuplicateParams } from "./api.js";
import { parseMoneyInput } from "./money.js";
import type { Receipt } from "./types.js";

/**
 * Proposal #8 (docs/proposals/2026-08-28-ux-enhancements.md #8, approved):
 * §11 deferred a duplicate check since wave 1 with the reasoning §5 states
 * - the `(user_id, sha256)` partial unique index catches a re-uploaded
 * IDENTICAL file and can never catch a re-photographed piece of paper,
 * since two photographs of one receipt share no pixels. Date + vendor +
 * total is the answer; `GET /api/receipts/possible-duplicates`
 * (server/src/routes/receipts.ts) is the query.
 *
 * Split the same way receiptImages.ts splits its own writers: what to
 * send (pure, tested without a component) versus the debounce/effect
 * wiring that calls it (ReceiptForm.tsx's `ReceiptFieldsForm`).
 */

/**
 * What the route needs to be worth calling: a real date and a parseable,
 * present total - "look it up when the form has a date and a total," the
 * proposal's own words. Returns null the instant either is missing or the
 * total box is mid-keystroke unparseable - the same silent-on-invalid rule
 * `arithmeticMismatch` follows (ReceiptForm.tsx): never a guess at a value
 * that is not there yet, and never a lookup fired on every keystroke of an
 * incomplete amount.
 *
 * `excludeId` is always the CURRENT receipt's own id, required here rather
 * than optional. Both screens that render this form (ConfirmQueue,
 * ReceiptDetail) only ever open a receipt that already exists server-side
 * - a receipt row is created by the upload path, before OCR ever runs,
 * long before either screen sees it - so there is no "new, unsaved
 * receipt" case where excludeId would not apply. Omitting it is exactly
 * the bug proposal #8 names by name: a receipt matching itself.
 *
 * Vendor is trimmed before being sent and omitted (not sent as `""`) when
 * blank, matching `assignText`'s own rule that whitespace-only is "no
 * vendor" - the server's own `vendorText` schema refuses an empty string
 * outright, and omitting the parameter is what lets the server's "no
 * vendor matches no vendor" rule apply instead of "ignore vendor
 * entirely" (that route's own doc comment).
 */
export function duplicateLookupParams(
  fields: { purchasedAt: string; total: string; vendor: string },
  excludeId: string,
): PossibleDuplicateParams | null {
  if (fields.purchasedAt === "") {
    return null;
  }
  let totalCents: number | null;
  try {
    totalCents = parseMoneyInput(fields.total);
  } catch {
    return null;
  }
  if (totalCents === null) {
    return null;
  }
  const vendor = fields.vendor.trim();
  return {
    purchasedAt: fields.purchasedAt,
    totalCents,
    ...(vendor !== "" && { vendor }),
    excludeId,
  };
}

/**
 * The lookup itself, isolated from React so it is testable without a
 * component. Never throws: a failed lookup (a network error, an expired
 * token, anything at all) resolves to no matches, the same "silent,
 * degrade to nothing" rule `useReceiptOptions`'s own `load` follows
 * (options.tsx) - this is an assist over a save that must keep working
 * when the assist cannot, never a gate on it.
 */
export async function lookupPossibleDuplicates(
  api: KeptApi,
  params: PossibleDuplicateParams,
): Promise<Receipt[]> {
  try {
    const result = await api.possibleDuplicates(params);
    return result.receipts;
  } catch {
    return [];
  }
}
