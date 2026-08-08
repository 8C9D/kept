import {
  OCR_SUGGESTION_FIELDS,
  type OcrFieldSuggestions,
} from "./ocrSuggestions.js";

/**
 * Per-field parse accuracy (spec §7.3: "decide this with data, not taste").
 *
 * The ground truth is what a human confirmed on the confirm screen; the
 * measurement is the parser's suggestion compared against it, field by
 * field, over every confirmed receipt that carries a suggestion record.
 * Nobody maintains anything: confirming receipts is the recording.
 *
 * One honest limit, stated rather than hidden: a wrong suggestion the
 * human accepted without noticing counts as correct, because the confirmed
 * value is the only truth available.
 */

export type FieldVerdict =
  /** Parser suggested a value and the human kept it. */
  | "match"
  /** Parser suggested a value and the human changed or removed it. */
  | "mismatch"
  /** Parser found nothing but the field had a value to find. */
  | "missed"
  /** Parser found nothing and the human confirmed there was nothing. */
  | "correctlyAbsent";

/** The confirmed receipt fields the parser suggests, as the row stores them. */
export interface ConfirmedFields {
  vendor: string | null;
  purchasedAt: string | null;
  totalCents: number | null;
  hstCents: number | null;
  subtotalCents: number | null;
  vendorTaxNumber: string | null;
}

export interface MeasuredReceipt {
  id: string;
  suggestions: OcrFieldSuggestions;
  confirmed: ConfirmedFields;
}

export interface FieldTally {
  field: keyof OcrFieldSuggestions;
  match: number;
  mismatch: number;
  missed: number;
  correctlyAbsent: number;
}

export interface Mismatch {
  receiptId: string;
  field: keyof OcrFieldSuggestions;
  verdict: Exclude<FieldVerdict, "match" | "correctlyAbsent">;
  suggested: string | number | null;
  confirmed: string | number | null;
}

export interface AccuracyReport {
  receiptCount: number;
  tallies: FieldTally[];
  mismatches: Mismatch[];
}

/**
 * "Correct" means the suggestion needed no human correction - which
 * includes correctly finding nothing on a receipt that had nothing (a
 * no-HST receipt where the parser suggested no HST is a parse the human
 * did not have to fix).
 *
 * Null when there is nothing to measure: on an accuracy report, "no data"
 * rendered as 0% would be a quiet wrong answer.
 */
export function accuracyPercent(tally: FieldTally): number | null {
  const total = tally.match + tally.mismatch + tally.missed + tally.correctlyAbsent;
  if (total === 0) {
    return null;
  }
  return Math.round(((tally.match + tally.correctlyAbsent) / total) * 100);
}

export function classifyField(
  field: keyof OcrFieldSuggestions,
  suggested: string | number | null,
  confirmed: string | number | null,
): FieldVerdict {
  if (suggested === null && confirmed === null) {
    return "correctlyAbsent";
  }
  if (suggested === null) {
    return "missed";
  }
  if (confirmed === null) {
    return "mismatch";
  }
  return valuesAgree(field, suggested, confirmed) ? "match" : "mismatch";
}

export function measureAccuracy(receipts: MeasuredReceipt[]): AccuracyReport {
  const tallies = new Map<keyof OcrFieldSuggestions, FieldTally>(
    OCR_SUGGESTION_FIELDS.map((field) => [
      field,
      { field, match: 0, mismatch: 0, missed: 0, correctlyAbsent: 0 },
    ]),
  );
  const mismatches: Mismatch[] = [];

  for (const receipt of receipts) {
    for (const field of OCR_SUGGESTION_FIELDS) {
      const suggested = receipt.suggestions[field];
      const confirmed = receipt.confirmed[field];
      const verdict = classifyField(field, suggested, confirmed);
      const tally = tallies.get(field);
      if (tally === undefined) {
        throw new Error(`No tally initialized for field ${field}`);
      }
      tally[verdict] += 1;
      if (verdict === "mismatch" || verdict === "missed") {
        mismatches.push({
          receiptId: receipt.id,
          field,
          verdict,
          suggested,
          confirmed,
        });
      }
    }
  }

  return {
    receiptCount: receipts.length,
    tallies: [...tallies.values()],
    mismatches,
  };
}

/**
 * One receipt carrying both suggestion records, for scoring the two parse
 * paths against each other (heuristics on-device, LLM server-side over the
 * same stored text - ruled Aug 7, 2026).
 */
export interface TwoPathReceipt {
  id: string;
  heuristic: OcrFieldSuggestions;
  llm: OcrFieldSuggestions;
  confirmed: ConfirmedFields;
}

export interface PathDisagreement {
  receiptId: string;
  field: keyof OcrFieldSuggestions;
  heuristicSuggested: string | number | null;
  llmSuggested: string | number | null;
  confirmed: string | number | null;
  /**
   * Which path the human's confirmed value sided with. "both" cannot occur:
   * agreement is transitive, so two suggestions that both match the
   * confirmed value would not be a disagreement in the first place.
   */
  matchedConfirmed: "heuristic" | "llm" | "neither";
}

/**
 * Null-tolerant agreement: both-null is agreement (both paths say "not
 * printed"), null against a value is not, and two values compare under the
 * same normalization the accuracy tallies use.
 */
export function suggestionValuesAgree(
  field: keyof OcrFieldSuggestions,
  a: string | number | null,
  b: string | number | null,
): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return valuesAgree(field, a, b);
}

/**
 * Every field where the two paths suggested different things, and which of
 * them the human sided with. At a small n this listing is the evidence
 * that matters - a headline percentage over a handful of receipts cannot
 * distinguish a good model from a lucky one.
 */
export function compareSuggestionPaths(
  receipts: TwoPathReceipt[],
): PathDisagreement[] {
  const disagreements: PathDisagreement[] = [];
  for (const receipt of receipts) {
    for (const field of OCR_SUGGESTION_FIELDS) {
      const heuristicSuggested = receipt.heuristic[field];
      const llmSuggested = receipt.llm[field];
      if (suggestionValuesAgree(field, heuristicSuggested, llmSuggested)) {
        continue;
      }
      const confirmed = receipt.confirmed[field];
      const matchedConfirmed = suggestionValuesAgree(
        field,
        heuristicSuggested,
        confirmed,
      )
        ? "heuristic"
        : suggestionValuesAgree(field, llmSuggested, confirmed)
          ? "llm"
          : "neither";
      disagreements.push({
        receiptId: receipt.id,
        field,
        heuristicSuggested,
        llmSuggested,
        confirmed,
        matchedConfirmed,
      });
    }
  }
  return disagreements;
}

/**
 * Money and dates compare exactly. Text fields compare after normalizing
 * case and whitespace (and, for the tax number, its internal spaces):
 * "staples #123" versus "STAPLES #123" is the human adjusting styling,
 * not correcting the parser.
 */
function valuesAgree(
  field: keyof OcrFieldSuggestions,
  suggested: string | number,
  confirmed: string | number,
): boolean {
  if (field === "vendor") {
    return normalizeText(String(suggested)) === normalizeText(String(confirmed));
  }
  if (field === "vendorTaxNumber") {
    return (
      normalizeText(String(suggested)).replaceAll(" ", "") ===
      normalizeText(String(confirmed)).replaceAll(" ", "")
    );
  }
  return suggested === confirmed;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replaceAll(/\s+/g, " ").trim();
}
