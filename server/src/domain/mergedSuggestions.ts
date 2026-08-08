import type { OcrFieldSuggestions } from "./ocrSuggestions.js";

/**
 * The field-level merge of the two parse paths (spec §7.3, ruled Aug 8,
 * 2026), computed here in the domain layer so both clients render the same
 * answer and neither implements the rule (spec §4.1: domain logic lives in
 * the backend or it gets written twice).
 *
 * - Amounts (total, HST, subtotal) come from the heuristic.
 * - Vendor and tax number come from the LLM.
 * - Date trusts neither source alone: when the two disagree, the value is
 *   flagged and the confirm screen keeps the field amber and marked as
 *   needing attention.
 *
 * When the ruled source has nothing and the other does, the other side's
 * value is served with its provenance stated: a suggestion the human can
 * reject beats an empty field, and constraint 2 (nothing saves unconfirmed)
 * is what makes that safe. Provenance is per field, never implied, so a
 * client can render "where this came from" without re-deriving the rule.
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

export interface MergedSuggestions {
  vendor: MergedSuggestion<string>;
  purchasedAt: MergedDateSuggestion;
  totalCents: MergedSuggestion<number>;
  hstCents: MergedSuggestion<number>;
  subtotalCents: MergedSuggestion<number>;
  vendorTaxNumber: MergedSuggestion<string>;
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
    totalCents: prefer(
      "heuristic",
      ocr?.totalCents ?? null,
      "llm",
      llm?.totalCents ?? null,
    ),
    hstCents: prefer(
      "heuristic",
      ocr?.hstCents ?? null,
      "llm",
      llm?.hstCents ?? null,
    ),
    subtotalCents: prefer(
      "heuristic",
      ocr?.subtotalCents ?? null,
      "llm",
      llm?.subtotalCents ?? null,
    ),
    vendorTaxNumber: prefer(
      "llm",
      llm?.vendorTaxNumber ?? null,
      "heuristic",
      ocr?.vendorTaxNumber ?? null,
    ),
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
