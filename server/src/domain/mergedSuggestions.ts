import type { OcrFieldSuggestions, OcrSource } from "./ocrSuggestions.js";
import type { ReviewedField } from "./reviewedFields.js";
import { validateSuggestedAmounts } from "./suggestedAmounts.js";

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
 *
 * ---
 *
 * **Two additions, 2026-09-01, both driven by the receipt's own context
 * rather than by the two parse records alone** - which is why the merge now
 * takes a third argument.
 *
 * **1. A reviewed field on a pending receipt is served ABSENT.** Once a
 * human has entered or explicitly accepted a field, that field has no
 * suggestion left to make: the row's value IS the answer. Both clients
 * prefill an empty field from its suggestion, so continuing to serve one
 * would re-offer a parser's guess over a person's own work every time the
 * draft is reopened - constraint 2 read backwards. Serving `{value: null,
 * source: null}` says the honest thing ("nothing to suggest here") in the
 * shape every already-absent field uses, so no client needs a new branch.
 *
 * Scoped to PENDING receipts on purpose. A confirmed receipt's suggestions
 * are still served in full: nothing prefills from them any more, and they
 * are what the §7.3 parse-accuracy comparison reads - suppressing them
 * would delete the measurement's own input. Which is also why suppression
 * lives HERE, at what is served, and never touches `ocr_suggestions` or
 * `llm_suggestions`, which stay immutable records of what each parser said.
 *
 * Eight of the ten reviewable field names have a suggestion to withhold
 * (`domain/reviewedFields.ts` lists all ten; `paymentMethod` and
 * `otherFeesCents` joined the suggested set with prompt v5, 2026-09-01);
 * the other two - `category` and `notes` - name fields no parser suggests,
 * so they pass through this rule without effect rather than being refused
 * by it.
 *
 * **2. `pdf-text` money falls through to the LLM; `vision` money still does
 * not.** A deliberate, scoped exception to the no-fallthrough rule above,
 * and the reasoning is that the rule's own justification does not reach
 * this case:
 *
 * - The failure the rule was written for is a digit read wrongly off a
 *   photograph - "SUBTOTAL 43.49" served as 3449 cents. A PDF's text layer
 *   is not recognised, it is EXTRACTED: the characters are the ones the
 *   document says they are, and the transposition the rule guards against
 *   cannot occur.
 * - Nothing else would fill the field. The on-device heuristic runs over
 *   OCR output of a photo; no heuristic runs over PDF text at all. So
 *   "heuristic or nothing" on a PDF means nothing, every time - every
 *   amount blank on every PDF receipt forever, which is not the trade the
 *   rule was making.
 *
 * Vision-sourced receipts (and the null `ocr_source` of every receipt
 * captured before this column existed) keep the original rule untouched.
 * `disagreement` is computed the same way in both cases - both parsers
 * produced a value and they differ - and it stays false when the served
 * value IS the LLM's, because there is nothing on the other side to
 * disagree with.
 *
 * ---
 *
 * **Two more fields and one more rule, later on 2026-09-01**, all three
 * from the diagnosis over 136 real production receipts:
 *
 * - `paymentMethod` merges like `vendor`: LLM-preferred, heuristic
 *   fallthrough. Not because payment method resembles a vendor name, but
 *   because the on-device parser has no rule for it at all and never will -
 *   it is printed on ~80% of slips and was stored on 0 of 130 receipts, and
 *   reading "MASTERCARD" off a slip is a reading task, not a pattern match.
 * - `otherFeesCents` merges like every other amount: heuristic-only on a
 *   photo (so absent, always, today), LLM fallthrough on `pdf-text`. It gets
 *   no exception for being new, exactly as tip got none in August.
 * - An impossible set of amounts has its outlier WITHHELD rather than
 *   served (`domain/suggestedAmounts.ts` carries the rule and the reasoning
 *   for why it withholds a suggestion rather than rejecting a saved value).
 *   Applied last, to the values this merge has already decided to serve, so
 *   it judges what a person would actually have seen prefilled - not what
 *   the two parsers said before the pdf-text and reviewed-field rules ran.
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
 * An amount suggestion that also carries the disagreement flag: the served
 * `value` and `source` still follow whichever money rule the receipt's
 * `ocr_source` selects (heuristic-or-absent for a photo; the 2026-09-01
 * PDF-text fallthrough for an extracted text layer), and `disagreement` is a
 * read-only side channel computed from both sides regardless. Introduced for
 * HST (2026-08-28) rather than special-casing that one field's type inline,
 * so a future amount that earns the same flag (see the revisit note above)
 * reuses this instead of another one-off shape.
 */
export interface MergedAmountSuggestion extends MergedSuggestion<number> {
  /** Both parsers produced a value for this amount and they differ. */
  disagreement: boolean;
  /**
   * The amount was suppressed because the set it belongs to is arithmetically
   * impossible (2026-09-01; `domain/suggestedAmounts.ts`). Distinct from a
   * plain absence, and deliberately so: `{value: null, source: null}` means
   * neither parser found anything, while this means one of them found
   * something the server declines to offer. A client can say "we could not
   * read this reliably" rather than nothing at all, and either way the field
   * lands empty for a person to fill from the paper.
   */
  withheld: boolean;
}

export interface MergedSuggestions {
  vendor: MergedSuggestion<string>;
  purchasedAt: MergedDateSuggestion;
  /**
   * Total and subtotal carry the amount shape as of 2026-09-01 - not
   * because they gained a disagreement flag (they did not; the August note
   * above on why that stayed HST-only still stands, and both report
   * `disagreement: false` always) but because they are the two fields the
   * arithmetic rule can withhold, and `withheld` lives on that shape.
   */
  totalCents: MergedAmountSuggestion;
  hstCents: MergedAmountSuggestion;
  subtotalCents: MergedAmountSuggestion;
  tipCents: MergedSuggestion<number>;
  otherFeesCents: MergedSuggestion<number>;
  paymentMethod: MergedSuggestion<string>;
}

/**
 * The receipt's own state, which the two parse records cannot supply
 * (2026-09-01). Both fields change what is SERVED, never what is stored -
 * see the two additions in this module's header comment.
 */
export interface SuggestionContext {
  /**
   * Suppression applies to a pending draft only; a confirmed receipt's
   * suggestions are still served in full for the §7.3 accuracy comparison.
   *
   * Spelled as a literal union rather than imported from `db/schema.ts`:
   * the schema imports its column types from this layer, and the domain
   * importing back would close the circle.
   */
  status: "pending" | "confirmed";
  /** Which fields a human has already entered or accepted on this draft. */
  reviewedFields: readonly ReviewedField[];
  /** Null on every receipt captured before the column existed: vision-era. */
  ocrSource: OcrSource | null;
}

/**
 * Null in, null out: a receipt neither parser ever saw has no suggestion
 * set at all, which is a different fact from "both parsers ran and found
 * nothing" (a full set of null-valued fields).
 *
 * ⚠ `context` is required, not optional with a permissive default. A caller
 * that forgot to pass it would silently get the pre-2026-09-01 behaviour -
 * a parser guess re-served over a field a human already filled in - and
 * nothing would fail. Making it a required argument is what turns that into
 * a compile error.
 */
export function mergeSuggestions(
  ocr: OcrFieldSuggestions | null,
  llm: OcrFieldSuggestions | null,
  context: SuggestionContext,
): MergedSuggestions | null {
  if (ocr === null && llm === null) {
    return null;
  }
  const mergeMoney =
    context.ocrSource === "pdf-text" ? extractedTextMoney : heuristicOnlyMoney;
  const merged: MergedSuggestions = {
    vendor: prefer("llm", llm?.vendor ?? null, "heuristic", ocr?.vendor ?? null),
    purchasedAt: mergeDate(ocr?.purchasedAt ?? null, llm?.purchasedAt ?? null),
    totalCents: withoutDisagreement(
      mergeMoney(ocr?.totalCents ?? null, llm?.totalCents ?? null),
    ),
    hstCents: withDisagreement(
      mergeMoney(ocr?.hstCents ?? null, llm?.hstCents ?? null),
      ocr?.hstCents ?? null,
      llm?.hstCents ?? null,
    ),
    subtotalCents: withoutDisagreement(
      mergeMoney(ocr?.subtotalCents ?? null, llm?.subtotalCents ?? null),
    ),
    tipCents: mergeMoney(ocr?.tipCents ?? null, llm?.tipCents ?? null),
    otherFeesCents: mergeMoney(
      ocr?.otherFeesCents ?? null,
      llm?.otherFeesCents ?? null,
    ),
    paymentMethod: prefer(
      "llm",
      llm?.paymentMethod ?? null,
      "heuristic",
      ocr?.paymentMethod ?? null,
    ),
  };
  // Order is the rule, not an implementation detail: the reviewed-field
  // suppression runs first so the arithmetic check judges the values a
  // person would actually have been offered, and a field a human has
  // already been through is never withheld a second time for failing a sum
  // it is no longer part of.
  return withholdImpossibleAmounts(withholdReviewed(merged, context));
}

/**
 * How one money field is merged. Both variants take both sides so the
 * choice between them is the only thing that differs - a signature that
 * hid the LLM value from the vision variant would make the two look like
 * different kinds of function rather than one rule with a scoped exception.
 */
type MoneyMerge = (
  heuristic: number | null,
  llm: number | null,
) => MergedSuggestion<number>;

/**
 * The money fields' merge for a photographed receipt: the heuristic or
 * nothing. The LLM's value is deliberately unused here rather than
 * unavailable - the rule is a choice this function makes, and the argument
 * it declines to read is what says so.
 */
const heuristicOnlyMoney: MoneyMerge = (heuristic) =>
  heuristic !== null
    ? { value: heuristic, source: "heuristic" }
    : { value: null, source: null };

/**
 * The money merge for a PDF's text layer (2026-09-01): the heuristic when
 * there is one - there never is today, since no on-device heuristic reads
 * PDF text - and otherwise the LLM's value with its provenance stated, so a
 * client renders "where this came from" without re-deriving anything. The
 * header comment carries why this exception is safe here and nowhere else.
 */
const extractedTextMoney: MoneyMerge = (heuristic, llm) =>
  prefer("heuristic", heuristic, "llm", llm);

/**
 * HST's flag (2026-08-28): layered on top of whichever money merge ran,
 * never substituted for it. `disagreement` is true only when both parsers
 * produced a value and they differ. One-sided reads are absences, not
 * disagreements, and carry the flag as false - exactly `mergeDate`'s
 * reasoning for the analogous case.
 */
function withDisagreement(
  merged: MergedSuggestion<number>,
  heuristic: number | null,
  llm: number | null,
): MergedAmountSuggestion {
  return {
    ...merged,
    disagreement: heuristic !== null && llm !== null && heuristic !== llm,
    withheld: false,
  };
}

/**
 * Total and subtotal on the amount shape (2026-09-01), with the flag they
 * do NOT compute stated as false rather than left off. The August ruling
 * that only HST carries a disagreement note is unchanged and still has its
 * reasoning in this module's header; what these two need the shape for is
 * `withheld`, which `withholdImpossibleAmounts` sets below.
 */
function withoutDisagreement(
  merged: MergedSuggestion<number>,
): MergedAmountSuggestion {
  return { ...merged, disagreement: false, withheld: false };
}

/**
 * Serves a reviewed field as absent on a pending receipt (2026-09-01) - the
 * first of the two additions in this module's header comment.
 *
 * Applied AFTER the merge rather than woven into it: what is withheld has
 * nothing to do with how the two parsers are reconciled, and a merge
 * function that also decided visibility would be two rules in one place.
 *
 * Eight of the ten reviewable names now have a suggestion to withhold -
 * `otherFeesCents` and `paymentMethod` joined the list on 2026-09-01 when
 * the model started being asked for them. `category` and `notes` are the
 * two that still match nothing here; no parser has ever suggested either.
 */
function withholdReviewed(
  merged: MergedSuggestions,
  context: SuggestionContext,
): MergedSuggestions {
  if (context.status !== "pending" || context.reviewedFields.length === 0) {
    return merged;
  }
  const reviewed = new Set<ReviewedField>(context.reviewedFields);
  return {
    vendor: reviewed.has("vendor") ? absent() : merged.vendor,
    purchasedAt: reviewed.has("purchasedAt")
      ? { ...absent<string>(), disagreement: false }
      : merged.purchasedAt,
    totalCents: reviewed.has("totalCents")
      ? absentAmount()
      : merged.totalCents,
    hstCents: reviewed.has("hstCents") ? absentAmount() : merged.hstCents,
    subtotalCents: reviewed.has("subtotalCents")
      ? absentAmount()
      : merged.subtotalCents,
    tipCents: reviewed.has("tipCents") ? absent() : merged.tipCents,
    otherFeesCents: reviewed.has("otherFeesCents")
      ? absent()
      : merged.otherFeesCents,
    paymentMethod: reviewed.has("paymentMethod")
      ? absent()
      : merged.paymentMethod,
  };
}

/**
 * The arithmetic rule applied to what this merge decided to serve
 * (2026-09-01) - the second of the two withholding rules, and the one that
 * fires on the parsers rather than on the person.
 *
 * `withheld: true` rather than a plain absence: a client that wants to say
 * "the amounts on this receipt did not add up, so check this one" can, and
 * one that does not simply renders an empty field. Which fields go, and why
 * the answer is sometimes the total alone and sometimes both, is
 * `validateSuggestedAmounts`'s to decide - not restated here.
 */
function withholdImpossibleAmounts(
  merged: MergedSuggestions,
): MergedSuggestions {
  const verdict = validateSuggestedAmounts({
    subtotalCents: merged.subtotalCents.value,
    hstCents: merged.hstCents.value,
    tipCents: merged.tipCents.value,
    otherFeesCents: merged.otherFeesCents.value,
    totalCents: merged.totalCents.value,
  });
  if (verdict.withhold.length === 0) {
    return merged;
  }
  const withheld = new Set(verdict.withhold);
  return {
    ...merged,
    ...(withheld.has("totalCents") && { totalCents: withheldAmount() }),
    ...(withheld.has("subtotalCents") && { subtotalCents: withheldAmount() }),
  };
}

/** The stated-absence shape every merge-empty field already uses. */
function absent<T>(): MergedSuggestion<T> {
  return { value: null, source: null };
}

/** The same, on the amount shape: absent, and absent for no stated reason. */
function absentAmount(): MergedAmountSuggestion {
  return { value: null, source: null, disagreement: false, withheld: false };
}

/** Absent because the server declined to serve what a parser produced. */
function withheldAmount(): MergedAmountSuggestion {
  return { value: null, source: null, disagreement: false, withheld: true };
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
