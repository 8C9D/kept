import type { OcrFieldSuggestions } from "./ocrSuggestions.js";

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

/**
 * The suggestion fields this scores. Not every key of a stored suggestion
 * record: `vendorTaxNumber` lives on in those records - they are immutable,
 * and old clients still report one - but the 2026-08-26 field reduction took
 * away the confirmed column it was scored against, and a measurement with no
 * ground truth is not a measurement.
 *
 * `tipCents` (2026-08-28) is scored alongside the other amounts: it has a
 * heuristic suggestion field and a confirmed column to measure it against,
 * on the same terms as total/hst/subtotal.
 *
 * `otherFeesCents` and `paymentMethod` join the list on 2026-09-01, when
 * prompt v5 started asking the model for them. Both now have what scoring
 * requires - a suggestion field and a confirmed column - so leaving them out
 * would mean the two fields this pass added are the two nobody measures.
 *
 * ⚠ Read their first months of tallies with the prompt version in hand.
 * Every record written before v5 (and every heuristic record, ever) is
 * silent on both fields, and silence scores as `missed` wherever the human
 * confirmed a value. That is the same shape `tipCents` had in August after
 * v4 asked for it, and it is not a defect in the measurement - it is the
 * measurement correctly saying the old prompt found nothing, because the old
 * prompt never asked.
 */
export const SCORED_SUGGESTION_FIELDS = [
  "vendor",
  "purchasedAt",
  "totalCents",
  "hstCents",
  "subtotalCents",
  "tipCents",
  "otherFeesCents",
  "paymentMethod",
] as const satisfies readonly (keyof OcrFieldSuggestions)[];

export type ScoredField = (typeof SCORED_SUGGESTION_FIELDS)[number];

/**
 * The confirmed receipt fields the parser suggests, as the row stores them.
 * Derived from the suggestion shape so the two cannot drift: a field with no
 * confirmed counterpart cannot be scored.
 */
export type ConfirmedFields = Pick<OcrFieldSuggestions, ScoredField>;

export interface MeasuredReceipt {
  id: string;
  suggestions: OcrFieldSuggestions;
  confirmed: ConfirmedFields;
}

export interface FieldTally {
  field: ScoredField;
  match: number;
  mismatch: number;
  missed: number;
  correctlyAbsent: number;
}

export interface Mismatch {
  receiptId: string;
  field: ScoredField;
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
  field: ScoredField,
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
  const tallies = new Map<ScoredField, FieldTally>(
    SCORED_SUGGESTION_FIELDS.map((field) => [
      field,
      { field, match: 0, mismatch: 0, missed: 0, correctlyAbsent: 0 },
    ]),
  );
  const mismatches: Mismatch[] = [];

  for (const receipt of receipts) {
    for (const field of SCORED_SUGGESTION_FIELDS) {
      const suggested = storedValue(receipt.suggestions, field);
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
  field: ScoredField;
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
  field: ScoredField,
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
    for (const field of SCORED_SUGGESTION_FIELDS) {
      const heuristicSuggested = storedValue(receipt.heuristic, field);
      const llmSuggested = storedValue(receipt.llm, field);
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
 * One field off a STORED suggestion record, read defensively.
 *
 * ⚠ The type says every key is present; the database disagrees. These
 * records are immutable (spec §7.3) and every one of them was written by
 * whichever parser and prompt existed on the day - so a record from before
 * a field existed simply has no such key, and `record[field]` is
 * `undefined`, not `null`. Left unhandled, `undefined` sails past the
 * `suggested === null` branch in `classifyField` and scores as a WRONG
 * suggestion rather than an absent one: every pre-v5 receipt would report a
 * `paymentMethod` mismatch it never made, and `npm run parse-accuracy`
 * would be quietly wrong rather than loudly broken.
 *
 * "Absent key" and "parser found nothing" really are the same fact here
 * (the normalizers on both write paths say so in as many words), so
 * collapsing them to null is the honest read and not a papered-over gap.
 */
function storedValue(
  record: OcrFieldSuggestions,
  field: ScoredField,
): string | number | null {
  return record[field] ?? null;
}

/**
 * Money and dates compare exactly. The vendor compares after normalizing
 * case and whitespace: "staples #123" versus "STAPLES #123" is the human
 * adjusting styling, not correcting the parser. `paymentMethod`
 * (2026-09-01) compares the same way and for the same reason: a slip prints
 * "MASTERCARD" and a person picks "Mastercard" off their own remembered
 * values, which is styling, not the parser having been wrong.
 */
function valuesAgree(
  field: ScoredField,
  suggested: string | number,
  confirmed: string | number,
): boolean {
  if (field === "vendor" || field === "paymentMethod") {
    return normalizeText(String(suggested)) === normalizeText(String(confirmed));
  }
  return suggested === confirmed;
}

function normalizeText(value: string): string {
  return value.toLowerCase().replaceAll(/\s+/g, " ").trim();
}
