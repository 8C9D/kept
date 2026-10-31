import {
  REVIEWED_FIELDS,
  type MergedSuggestions,
  type ReviewedField,
  type WithholdableAmountSuggestion,
} from "./types.js";

/**
 * Whether the server declined to serve this amount because the set it
 * belongs to is arithmetically impossible (2026-09-01,
 * `domain/suggestedAmounts.ts`). One predicate, so the form's blanking rule,
 * its note and the bulk confirm all read the flag the same way - including
 * the `=== true`, which is what makes an older response that carries no such
 * key read as "not withheld" rather than as anything else.
 */
export function withheldAmount(
  suggestion: WithholdableAmountSuggestion | undefined,
): boolean {
  return suggestion?.withheld === true;
}

/**
 * The total a table row shows. On a pending row whose total the server
 * withheld, nothing: the column holds the very number it refused, and iOS Home
 * shows no total for the same reason. Display only; the cell still saves
 * whatever a person types.
 */
export function displayedTotalCents(row: {
  status: string;
  totalCents: number | null;
  suggestions: MergedSuggestions | null;
}): number | null {
  const withheld =
    row.status === "pending" && withheldAmount(row.suggestions?.totalCents);
  return withheld ? null : row.totalCents;
}

const AMOUNT_FIELDS = [
  "subtotalCents",
  "hstCents",
  "tipCents",
  "otherFeesCents",
  "totalCents",
] as const satisfies readonly ReviewedField[];

export type AmountField = (typeof AMOUNT_FIELDS)[number];

/**
 * Which amounts these served suggestions have withheld. Reads all five even
 * though the server's rule can only ever name total and subtotal today
 * (`WithheldAmountField`): the 2026-10 contract is stated over "an amount",
 * and a gate that only looked at two fields would quietly stop being one the
 * day a third joined them.
 */
export function withheldAmountFields(
  suggestions: MergedSuggestions | null,
): AmountField[] {
  if (suggestions === null) {
    return [];
  }
  return AMOUNT_FIELDS.filter((field) => withheldAmount(suggestions[field]));
}

/**
 * The reviewed set a write sends: everything already reviewed plus what this
 * write reviewed. A union because the PATCH REPLACES the stored set outright
 * (2026-09-01 contract) - a client that sent only its own additions would
 * silently un-review the rest and hand the parser back fields it had already
 * lost. Ordered by `REVIEWED_FIELDS` rather than by insertion, so the same
 * set always serializes the same way.
 */
export function unionReviewedFields(
  existing: readonly ReviewedField[],
  added: Iterable<ReviewedField>,
): ReviewedField[] {
  const reviewed = new Set<ReviewedField>([...existing, ...added]);
  return REVIEWED_FIELDS.filter((field) => reviewed.has(field));
}
