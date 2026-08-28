import type { OcrFieldSuggestions } from "./ocrSuggestions.js";

/**
 * The field-level merge of the two parse paths (spec §7.3, ruled Aug 8,
 * 2026), computed here in the domain layer so both clients render the same
 * answer and neither implements the rule (spec §4.1: domain logic lives in
 * the backend or it gets written twice).
 *
 * - Amounts (total, HST, subtotal, tip) come from the heuristic, and only
 *   the heuristic - no fallthrough (amended Aug 8, 2026, after a live parse
 *   served "SUBTOTAL 43.49" as 3449 cents with llm provenance). A
 *   heuristic-absent amount is served absent, never filled from the LLM: an
 *   absent amount is visible and costs one keystroke, while a wrong amount
 *   that passes unflagged reaches an accountant. This governs what is
 *   served, not what is recorded - the LLM's amounts stay in
 *   llm_suggestions for parse-accuracy to score. Tip (2026-08-28) is an
 *   amount like the other three, so it gets no exception: `other_fees` has
 *   no suggestion field at all (ocrSuggestions.ts) and so nothing to merge.
 * - Vendor comes from the LLM.
 * - Date trusts neither source alone: when the two disagree, the value is
 *   flagged and the confirm screen keeps the field amber and marked as
 *   needing attention.
 * - HST carries the same disagreement flag as date (2026-08-28): when both
 *   parsers produced an amount and they differ, `disagreement` is set. The
 *   served value does not change - still heuristic-only, still no
 *   fallthrough - only the flag is new. Why HST and not date's full
 *   fallthrough-or-flag treatment: HST is the input tax credit, the one
 *   amount with a direct tax consequence, and it is exactly the field the
 *   split-HST failure corrupts - a heuristic that reads one component of a
 *   printed 5%+8% split produces a wrong-but-entirely-plausible number that
 *   no arithmetic check catches when the subtotal is also missing (the
 *   check needs all three of subtotal, HST and total present, spec §7.3).
 *   Disagreement between two independent parsers over the same text is free
 *   signal, same reasoning as the date flag. Deliberately not extended to
 *   total or subtotal in this pass: every extra inline note on the confirm
 *   screen costs attention, and a note that fires on every receipt is
 *   wallpaper rather than signal. Revisit once real usage shows how often
 *   the HST flag actually fires - if it turns out to be most receipts, the
 *   same argument that justifies it here argues against widening it further.
 *
 * For vendor and date, when the ruled source has nothing and the other
 * does, the other side's value is served with its provenance stated: a
 * suggestion the human can reject beats an empty field, and constraint 2
 * (nothing saves unconfirmed) is what makes that safe. Provenance is per
 * field, never implied, so a client can render "where this came from"
 * without re-deriving the rule.
 *
 * The tax-number merge was deleted with the column it fed (2026-08-26).
 * Stored suggestion records still carry whatever the parsers said - they are
 * immutable - and nothing reads it any more. The response layer still serves
 * the key as a stated absence for the shipped iOS build; that shim lives at
 * the HTTP boundary (routes/receipts.ts), not here.
 */

export type SuggestionSource = "heuristic" | "llm" | "both";

export interface MergedSuggestion<T> {
  value: T | null;
  /** Which parser the value came from; null exactly when value is null. */
  source: SuggestionSource | null;
}

export interface MergedDateSuggestion extends MergedSuggestion<string> {
  /**
   * Both parsers read a date and they differ. Disagreement between two
   * independent parsers over the same text is free signal, and this is the
   * field that decides the fiscal year.
   */
  disagreement: boolean;
}

/**
 * An amount suggestion that also carries the disagreement flag, without the
 * date's fallthrough-when-one-side-empty behaviour: the served `value` and
 * `source` still follow the plain money rule (heuristic or absent, never
 * LLM), and `disagreement` is a read-only side channel computed from both
 * sides. Introduced for HST (2026-08-28) rather than special-casing that one
 * field's type inline, so a future amount that earns the same flag (see the
 * revisit note above) reuses this instead of another one-off shape.
 */
export interface MergedAmountSuggestion extends MergedSuggestion<number> {
  /** Both parsers produced a value for this amount and they differ. */
  disagreement: boolean;
}

export interface MergedSuggestions {
  vendor: MergedSuggestion<string>;
  purchasedAt: MergedDateSuggestion;
  totalCents: MergedSuggestion<number>;
  hstCents: MergedAmountSuggestion;
  subtotalCents: MergedSuggestion<number>;
  tipCents: MergedSuggestion<number>;
}

/**
 * Null in, null out: a receipt neither parser ever saw has no suggestion
 * set at all, which is a different fact from "both parsers ran and found
 * nothing" (a full set of null-valued fields).
 */
export function mergeSuggestions(
  ocr: OcrFieldSuggestions | null,
  llm: OcrFieldSuggestions | null,
): MergedSuggestions | null {
  if (ocr === null && llm === null) {
    return null;
  }
  return {
    vendor: prefer("llm", llm?.vendor ?? null, "heuristic", ocr?.vendor ?? null),
    purchasedAt: mergeDate(ocr?.purchasedAt ?? null, llm?.purchasedAt ?? null),
    totalCents: heuristicOnly(ocr?.totalCents ?? null),
    hstCents: heuristicWithDisagreement(
      ocr?.hstCents ?? null,
      llm?.hstCents ?? null,
    ),
    subtotalCents: heuristicOnly(ocr?.subtotalCents ?? null),
    tipCents: heuristicOnly(ocr?.tipCents ?? null),
  };
}

/**
 * The money fields' merge: the heuristic or nothing. The one-sided prefer()
 * shape is deliberate - routing money through prefer() with a null other
 * side would invite a future "fill it in" edit, and this function's name is
 * the rule.
 */
function heuristicOnly<T>(value: T | null): MergedSuggestion<T> {
  return value !== null
    ? { value, source: "heuristic" }
    : { value: null, source: null };
}

/**
 * HST's merge (2026-08-28): the served value and source are exactly
 * `heuristicOnly` - no fallthrough, same as every other amount - with one
 * addition layered on top, never substituted in: `disagreement` is true
 * only when both parsers produced a value and it differs from the
 * heuristic's. A heuristic-only or LLM-only read is not a disagreement,
 * it is an absence on one side, and carries the flag as false - exactly
 * `mergeDate`'s reasoning for the analogous case, applied to an amount that
 * still never takes the LLM's value.
 */
function heuristicWithDisagreement(
  heuristic: number | null,
  llm: number | null,
): MergedAmountSuggestion {
  return {
    ...heuristicOnly(heuristic),
    disagreement: heuristic !== null && llm !== null && heuristic !== llm,
  };
}

function prefer<T>(
  ruledSource: SuggestionSource,
  ruledValue: T | null,
  otherSource: SuggestionSource,
  otherValue: T | null,
): MergedSuggestion<T> {
  if (ruledValue !== null) {
    return { value: ruledValue, source: ruledSource };
  }
  if (otherValue !== null) {
    return { value: otherValue, source: otherSource };
  }
  return { value: null, source: null };
}

/**
 * On disagreement the heuristic's value is the one served, not because it
 * is trusted more - neither is trusted, that is the ruling - but because it
 * is deterministic: the same text re-parses to the same date, while the
 * LLM's read varies run to run. The flag, not the choice of prefill, is
 * what carries the signal to the screen.
 */
function mergeDate(
  heuristic: string | null,
  llm: string | null,
): MergedDateSuggestion {
  if (heuristic !== null && llm !== null) {
    return heuristic === llm
      ? { value: heuristic, source: "both", disagreement: false }
      : { value: heuristic, source: "heuristic", disagreement: true };
  }
  return {
    ...prefer("heuristic", heuristic, "llm", llm),
    disagreement: false,
  };
}
