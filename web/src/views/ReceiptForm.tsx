import { useEffect, useState } from "react";
import type { KeptApi } from "../api.js";
import { duplicateLookupParams, lookupPossibleDuplicates } from "../duplicates.js";
import { logEvent } from "../events.js";
import {
  MAX_STORABLE_CENTS,
  MIN_STORABLE_CENTS,
  formatCents,
  parseMoneyInput,
} from "../money.js";
import {
  CATEGORY_LIST_ID,
  PAYMENT_LIST_ID,
  ReceiptOptionsDatalists,
  VENDOR_LIST_ID,
} from "../options.js";
import type { Receipt, ReceiptOptions, ReceiptPatch } from "../types.js";

/**
 * The one field grid both the detail view and the confirm queue render.
 *
 * Draft values are strings - what is in the boxes - and become a patch
 * only on submit, with money parsed by the integer-only parser. The patch
 * carries exactly the fields that differ from the receipt row, because
 * PATCH means "change these", and a no-op submit sends nothing.
 *
 * Field order (2026-08-28, matching the iOS confirm screen): total, date,
 * vendor, HST, subtotal, tip, other fees, category, payment method, notes -
 * total first because it is what a person checks first, tip and other fees
 * last among the amounts because they are what gets added when the
 * arithmetic below does not reconcile.
 */
export interface ReceiptDraft {
  total: string;
  purchasedAt: string;
  vendor: string;
  hst: string;
  subtotal: string;
  tip: string;
  otherFees: string;
  category: string;
  paymentMethod: string;
  notes: string;
}

export function draftFromReceipt(receipt: Receipt): ReceiptDraft {
  return {
    total: formatCents(receipt.totalCents),
    purchasedAt: receipt.purchasedAt,
    vendor: receipt.vendor ?? "",
    hst: formatCents(receipt.hstCents),
    subtotal: formatCents(receipt.subtotalCents),
    tip: formatCents(receipt.tipCents),
    otherFees: formatCents(receipt.otherFeesCents),
    category: receipt.category ?? "",
    paymentMethod: receipt.paymentMethod ?? "",
    notes: receipt.notes ?? "",
  };
}

/**
 * The §7.3 display rule for a pending receipt, as the iOS client renders
 * it (ReceiptDisplay, Aug 8): the served merge's suggestion over the row
 * copy, the row filling only fields no suggestion covers. Confirmed
 * receipts never come here - they render the row, the human's values.
 *
 * `otherFees` is deliberately absent below: there is no `otherFeesCents`
 * key in `MergedSuggestions` (§7.3 - "other fees" is a residual with no
 * consistent printed label, so no heuristic can match it), so the spread
 * from `draftFromReceipt` stands untouched and the field is always the
 * row's own value. That is what lets `suggestedFields` below tell "no
 * suggestion" apart from "field name" without special-casing.
 */
export function draftFromPending(receipt: Receipt): ReceiptDraft {
  const s = receipt.suggestions;
  return {
    ...draftFromReceipt(receipt),
    purchasedAt: s?.purchasedAt.value ?? receipt.purchasedAt,
    vendor: s?.vendor.value ?? receipt.vendor ?? "",
    subtotal: formatCents(s?.subtotalCents.value ?? receipt.subtotalCents),
    hst: formatCents(s?.hstCents.value ?? receipt.hstCents),
    total: formatCents(s?.totalCents.value ?? receipt.totalCents),
    tip: formatCents(s?.tipCents.value ?? receipt.tipCents),
  };
}

/**
 * Which prefill rule a receipt gets, in one place so no screen can pick the
 * wrong one. §7.1: "every read-only rendering of a pending receipt shows the
 * same merge" - a pending row's stored values are the capture-time heuristic
 * snapshot, so rendering them would show one receipt two different ways
 * depending on which screen opened it. A confirmed receipt renders its row,
 * the human's own values.
 *
 * Added 2026-08-28 after exactly that defect: the detail screen called
 * `draftFromReceipt` unconditionally, so a pending receipt opened from the
 * table showed its suggested fields marked amber and *empty* - the amber
 * promised a suggestion the form had thrown away - while the same receipt
 * reached through the confirm queue prefilled correctly.
 *
 * ⚠ This is the rule for *opening* a receipt, not for redrawing one after a
 * save. A save returns the human's own values, and re-deriving the merge
 * over them would visibly overwrite what they just typed with the parser's
 * guess; that path stays on `draftFromReceipt` deliberately.
 */
export function draftForDisplay(receipt: Receipt): ReceiptDraft {
  return receipt.status === "pending"
    ? draftFromPending(receipt)
    : draftFromReceipt(receipt);
}

export class DraftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DraftError";
  }
}

/**
 * Draft -> the fields a PATCH would need to make the row match it.
 * Throws DraftError with the field named for unparseable money.
 */
export function patchFromDraft(
  receipt: Receipt,
  draft: ReceiptDraft,
): ReceiptPatch {
  const patch: ReceiptPatch = {};
  if (draft.purchasedAt !== receipt.purchasedAt && draft.purchasedAt !== "") {
    patch.purchasedAt = draft.purchasedAt;
  }
  assignText(patch, "vendor", draft.vendor, receipt.vendor);
  assignText(patch, "category", draft.category, receipt.category);
  assignText(patch, "paymentMethod", draft.paymentMethod, receipt.paymentMethod);
  assignText(patch, "notes", draft.notes, receipt.notes);
  assignMoney(patch, "subtotalCents", "subtotal", draft.subtotal, receipt.subtotalCents);
  assignMoney(patch, "hstCents", "HST", draft.hst, receipt.hstCents);
  assignMoney(patch, "tipCents", "tip", draft.tip, receipt.tipCents);
  assignMoney(
    patch,
    "otherFeesCents",
    "other fees",
    draft.otherFees,
    receipt.otherFeesCents,
  );
  assignMoney(patch, "totalCents", "total", draft.total, receipt.totalCents);
  return patch;
}

function assignText(
  patch: ReceiptPatch,
  key: "vendor" | "category" | "paymentMethod" | "notes",
  draft: string,
  current: string | null,
): void {
  const next = draft.trim() === "" ? null : draft.trim();
  if (next !== current) {
    patch[key] = next;
  }
}

function assignMoney(
  patch: ReceiptPatch,
  key: "subtotalCents" | "hstCents" | "totalCents" | "tipCents" | "otherFeesCents",
  label: string,
  draft: string,
  current: number | null,
): void {
  let next: number | null;
  try {
    next = parseMoneyInput(draft);
  } catch (caught) {
    throw new DraftError(
      `${label}: ${caught instanceof Error ? caught.message : String(caught)}`,
    );
  }
  if (next !== current) {
    patch[key] = next;
  }
}

/** A sentinel distinct from every value `parseMoneyInput` can return. */
const INVALID_MONEY = Symbol("invalid-money-input");

function tryParseMoney(input: string): number | null | typeof INVALID_MONEY {
  try {
    return parseMoneyInput(input);
  } catch {
    return INVALID_MONEY;
  }
}

/**
 * The live `subtotal + HST + tip + other fees = total` reconciliation
 * check (2026-08-28) - the one deliberate exception to "domain logic lives
 * in the backend" (CLAUDE.md), because it has to run per keystroke against
 * boxes the person is actively editing. Never blocking, never
 * auto-correcting: it only decides whether the amber prompt-to-look below
 * renders.
 *
 * Nulls contribute zero, exactly as `hstCents` already did before this
 * change; a null subtotal or total still means "nothing to reconcile
 * against" rather than "reconciles by default", so the check is silent on
 * a receipt that has not been amount-filled yet. An unparseable box (mid-
 * keystroke, such as a trailing decimal point, or genuinely invalid text)
 * also silences the check rather than guessing at a value that is not
 * there - `patchFromDraft`, not this function, is what surfaces a real
 * parse failure to the person.
 *
 * This restores the reconciliation the 2026-08-26 field reduction knowingly
 * gave up when it folded tip and non-HST fees into a single `other_tax_cents`
 * and then removed that field outright, narrowing the check to
 * `subtotal + hst = total` and accepting that a tipped receipt would show
 * the advisory warning (docs/DECISIONS.md, "First-use product feedback").
 * the owner's first-use experience made that cost concrete - tips genuinely
 * were not captured - so the two components come back as named fields
 * instead of one lumped one, and a tipped restaurant receipt
 * (subtotal + HST + tip = total) reconciles again instead of warning.
 */
export function arithmeticMismatch(draft: ReceiptDraft): boolean {
  const subtotal = tryParseMoney(draft.subtotal);
  const total = tryParseMoney(draft.total);
  if (subtotal === INVALID_MONEY || total === INVALID_MONEY) {
    return false;
  }
  if (subtotal === null || total === null) {
    return false;
  }
  const hst = tryParseMoney(draft.hst);
  const tip = tryParseMoney(draft.tip);
  const otherFees = tryParseMoney(draft.otherFees);
  if (hst === INVALID_MONEY || tip === INVALID_MONEY || otherFees === INVALID_MONEY) {
    return false;
  }
  return subtotal + (hst ?? 0) + (tip ?? 0) + (otherFees ?? 0) !== total;
}

/**
 * Proposal #1 (docs/proposals/2026-08-28-ux-enhancements.md #1, approved):
 * derive the one missing amount, live, mirroring the server's own
 * `deriveMissingAmount` (server/src/domain/arithmetic.ts) field for field -
 * same missing-count check, same sum, same refusals. Read that function's
 * doc comment for the full reasoning; this restates only enough of it to
 * keep the two in step. Exactly like `arithmeticMismatch` above, this is a
 * suggestion generator and nothing more - there is deliberately no path
 * from here to a PATCH. The affordance that renders it (`AmountDeriveNote`
 * below) is what proposal #1 names as the risk mitigation: it has to say
 * what it computed, not just offer a bare button, because a person tapping
 * a fill without reading it stores an amount the receipt does not print.
 */
export type DerivableAmountField = "subtotal" | "hst" | "tip" | "otherFees" | "total";

export interface DerivedAmount {
  field: DerivableAmountField;
  cents: number;
  /** What the fill is doing, in words - e.g. "Tip = total − subtotal − HST
   * − other fees" - rendered next to the computed amount so the affordance
   * states the arithmetic instead of appearing as an unexplained button. */
  formula: string;
}

const DERIVABLE_AMOUNT_FIELDS: readonly DerivableAmountField[] = [
  "subtotal",
  "hst",
  "tip",
  "otherFees",
  "total",
];

/** Mirrors the server's `NEVER_NEGATIVE_FIELDS` exactly, for the exact same
 * reason (arithmetic.ts's own comment): tip and other fees are charges
 * layered on a subtotal, never amounts that run negative on any receipt
 * this app has seen, so a bill that does not reconcile does not
 * retroactively invent a negative one. Offering "tip: -$3.00" as a one-tap
 * fill would be evidence the OTHER four fields are wrong, not a suggestion
 * anyone could act on - refusing to derive is the honest response. */
const NEVER_NEGATIVE_AMOUNT_FIELDS: ReadonlySet<DerivableAmountField> = new Set([
  "tip",
  "otherFees",
]);

function formulaFor(field: DerivableAmountField): string {
  switch (field) {
    case "subtotal":
      return "Subtotal = total − HST − tip − other fees";
    case "hst":
      return "HST = total − subtotal − tip − other fees";
    case "tip":
      return "Tip = total − subtotal − HST − other fees";
    case "otherFees":
      return "Other fees = total − subtotal − HST − tip";
    case "total":
      return "Total = subtotal + HST + tip + other fees";
  }
}

/**
 * The refusal tail both derivation functions below share - the server's
 * `cents()` range check plus `NEVER_NEGATIVE_FIELDS`, in one place so the
 * two offers this form can ever make (a single missing field, or a
 * reconciliation fix) are refused by the identical rule rather than two
 * copies of it that could quietly drift apart.
 */
function finalizeDerivedAmount(
  field: DerivableAmountField,
  value: number,
): DerivedAmount | null {
  if (NEVER_NEGATIVE_AMOUNT_FIELDS.has(field) && value < 0) {
    return null;
  }
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_STORABLE_CENTS ||
    value > MAX_STORABLE_CENTS
  ) {
    // Out of the storable cents range - the mismatch is real, but there is
    // no honest suggestion to offer for it (server's own comment).
    return null;
  }
  return { field, cents: value, formula: formulaFor(field) };
}

interface ParsedAmounts {
  subtotal: number | null;
  hst: number | null;
  tip: number | null;
  otherFees: number | null;
  total: number | null;
}

/** Parses all five money fields at once, or null the instant any one of
 * them is mid-keystroke invalid - the same "an unparseable box silences the
 * check" rule `arithmeticMismatch` follows above, shared here so both
 * derivation functions read it from one place. */
function parseAmounts(draft: ReceiptDraft): ParsedAmounts | null {
  const subtotal = tryParseMoney(draft.subtotal);
  const hst = tryParseMoney(draft.hst);
  const tip = tryParseMoney(draft.tip);
  const otherFees = tryParseMoney(draft.otherFees);
  const total = tryParseMoney(draft.total);
  if (
    subtotal === INVALID_MONEY ||
    hst === INVALID_MONEY ||
    tip === INVALID_MONEY ||
    otherFees === INVALID_MONEY ||
    total === INVALID_MONEY
  ) {
    return null;
  }
  return { subtotal, hst, tip, otherFees, total };
}

/**
 * The live mirror of the server's `deriveMissingAmount`. Returns null in
 * every case the server would: not exactly one of the five fields blank, a
 * mid-keystroke unparseable box, a negative tip or other-fees result, or a
 * result outside the storable cents range.
 */
export function deriveMissingAmount(draft: ReceiptDraft): DerivedAmount | null {
  const parsed = parseAmounts(draft);
  if (parsed === null) {
    return null;
  }
  const missing = DERIVABLE_AMOUNT_FIELDS.filter((field) => parsed[field] === null);
  if (missing.length !== 1) {
    return null;
  }
  const field = missing[0];
  if (field === undefined) {
    // Guaranteed by the length check above; narrows the type for TS.
    return null;
  }
  // Every field but the missing one is non-null here, so summing with
  // `?? 0` adds every KNOWN component and adds nothing for the field being
  // solved for - exactly the server function's own comment on this line.
  const knownComponentSum =
    (parsed.subtotal ?? 0) + (parsed.hst ?? 0) + (parsed.tip ?? 0) + (parsed.otherFees ?? 0);
  const value =
    field === "total" ? knownComponentSum : (parsed.total ?? 0) - knownComponentSum;
  return finalizeDerivedAmount(field, value);
}

/**
 * Proposal #1's second offer: "when all five are present but do not
 * reconcile, offer to put the difference into tip ... or into other fees."
 * There is no server function for this half - `deriveMissingAmount` only
 * ever fires on the opposite precondition, exactly one field blank - but it
 * solves the identical equation the server's function does, holding every
 * field but the one target at its current draft value. Putting the
 * shortfall into tip (`tip_old + (total - sum)`) and solving
 * `tip = total - subtotal - hst - otherFees` from scratch are the same
 * number by construction, so this reuses `finalizeDerivedAmount`'s
 * refusals rather than inventing a second, looser version of them - a
 * "reconciliation fix" that produced a negative tip would be exactly the
 * dishonest suggestion the server's own comment refuses to offer.
 */
export interface ReconciliationSuggestions {
  tip: DerivedAmount | null;
  otherFees: DerivedAmount | null;
}

export function reconciliationSuggestions(
  draft: ReceiptDraft,
): ReconciliationSuggestions | null {
  const parsed = parseAmounts(draft);
  if (parsed === null) {
    return null;
  }
  if (
    parsed.subtotal === null ||
    parsed.hst === null ||
    parsed.tip === null ||
    parsed.otherFees === null ||
    parsed.total === null
  ) {
    // One field is blank - deriveMissingAmount above is the offer for that
    // case, not this one.
    return null;
  }
  if (parsed.subtotal + parsed.hst + parsed.tip + parsed.otherFees === parsed.total) {
    // Already reconciles - nothing to offer.
    return null;
  }
  const tip = finalizeDerivedAmount(
    "tip",
    parsed.total - parsed.subtotal - parsed.hst - parsed.otherFees,
  );
  const otherFees = finalizeDerivedAmount(
    "otherFees",
    parsed.total - parsed.subtotal - parsed.hst - parsed.tip,
  );
  if (tip === null && otherFees === null) {
    return null;
  }
  return { tip, otherFees };
}

/**
 * Proposal #2 (approved): what a vendor default would fill on this draft
 * right now - pure, so the effect that applies it (`ReceiptFieldsForm`
 * below) and its test read the "empty and untouched only" rule from one
 * place. Exact match only: `vendorDefaults` is keyed by the server's
 * verbatim vendor string, and the 2026-08-26 ruling on a doubled-space
 * category applies here exactly as it does to every other free-text field -
 * nothing here trims or case-folds the lookup.
 *
 * Category and payment method are defensible to prefill this way where an
 * amount never would be (see `DerivedAmount`'s doc comment, and the
 * server's own `vendorDefaultCandidates` comment): category is free text
 * with no tax consequence - a wrong default costs a mislabelled row an
 * accountant re-reads, never a wrong claim, unlike HST, which is an input
 * tax credit.
 */
export interface VendorDefaultFill {
  category: string | null;
  paymentMethod: string | null;
}

export function vendorDefaultFill(
  draft: ReceiptDraft,
  touched: ReadonlySet<keyof ReceiptDraft>,
  vendorDefaults: ReceiptOptions["vendorDefaults"],
): VendorDefaultFill {
  const defaults = vendorDefaults[draft.vendor];
  if (defaults === undefined) {
    return { category: null, paymentMethod: null };
  }
  return {
    // Never overwrites a value the person already typed, or a confirmed
    // receipt's existing value - both read the same way here: the field is
    // non-empty. Never re-applies once touched, even if touching emptied it
    // back out - touching a field is a permanent opt-out, same as §10A.1's
    // rule for every other suggestion source.
    category:
      defaults.category !== null && draft.category === "" && !touched.has("category")
        ? defaults.category
        : null,
    paymentMethod:
      defaults.paymentMethod !== null &&
      draft.paymentMethod === "" &&
      !touched.has("paymentMethod")
        ? defaults.paymentMethod
        : null,
  };
}

/**
 * The draft fields that can ever carry an amber "unreviewed suggestion"
 * tint. Originally exactly the keys `MergedSuggestions` carries; widened
 * 2026-08-28 for proposals #1 and #2, which introduced two amber sources
 * that are NOT part of the server's OCR merge at all: `otherFees` can go
 * amber from a derived-amount fill even though no heuristic has ever
 * suggested it (the merge has no `otherFeesCents` key, per
 * `draftFromPending`'s own comment - that is still true, this is a
 * different source), and `category`/`paymentMethod` can go amber from a
 * vendor default. `suggestedFields` below still reads only the
 * server-sourced half of this set; `ReceiptFieldsForm`'s `amber()` helper
 * is what unions it with the client-sourced half (`clientApplied` state).
 *
 * Exported so a caller (ReceiptDetail.tsx, ConfirmQueue.tsx) can type the
 * accumulator it hands `summarizeFieldEdits`/`logFieldEditTelemetry` below
 * for the client-sourced half - see `onSuggestionApplied` on
 * `ReceiptFieldsForm`.
 */
export type SuggestibleField =
  | "vendor"
  | "purchasedAt"
  | "subtotal"
  | "hst"
  | "total"
  | "tip"
  | "otherFees"
  | "category"
  | "paymentMethod";

/**
 * §10A.1's amber rule, ported from iOS's confirm screen to this form:
 * "exactly the suggested fields start amber" - a field only marks if the
 * served merge actually served a value for it, and only on a pending
 * receipt (a confirmed one "renders the row, the human's values" per
 * `draftFromReceipt`'s own comment, and constraint 2's amber marks
 * *unconfirmed* suggestions, never a value a human already confirmed).
 */
function suggestedFields(receipt: Receipt): ReadonlySet<SuggestibleField> {
  const fields = new Set<SuggestibleField>();
  if (receipt.status !== "pending" || receipt.suggestions === null) {
    return fields;
  }
  const s = receipt.suggestions;
  if (s.vendor.value !== null) fields.add("vendor");
  if (s.purchasedAt.value !== null) fields.add("purchasedAt");
  if (s.subtotalCents.value !== null) fields.add("subtotal");
  if (s.hstCents.value !== null) fields.add("hst");
  if (s.totalCents.value !== null) fields.add("total");
  if (s.tipCents.value !== null) fields.add("tip");
  return fields;
}

/**
 * §10A.1's disagreement notes ("two independent parsers read this
 * differently - look at the paper"), one predicate per field so each is
 * independently testable without a DOM, matching `arithmeticMismatch`
 * above. Both share the same gate through this one function, which is what
 * keeps "exactly the same treatment" true by construction rather than by
 * two call sites someone could let drift apart: pending only (a confirmed
 * receipt renders the row, not the merge - `draftFromReceipt`'s own
 * comment), the served flag itself, and untouched - "touching a field
 * clears the tint and the note together" (§10A.1), so a note that outlived
 * a touch would contradict the amber tint sitting right next to it.
 */
function suggestionDisagreement(
  receipt: Receipt,
  touched: ReadonlySet<keyof ReceiptDraft>,
  field: "purchasedAt" | "hst",
  disagreement: boolean | undefined,
): boolean {
  return (
    receipt.status === "pending" && !touched.has(field) && disagreement === true
  );
}

/** The purchase-date note: both parsers read a date and it differs. */
export function dateDisagreementNote(
  receipt: Receipt,
  touched: ReadonlySet<keyof ReceiptDraft>,
): boolean {
  return suggestionDisagreement(
    receipt,
    touched,
    "purchasedAt",
    receipt.suggestions?.purchasedAt.disagreement,
  );
}

/**
 * The HST note (2026-08-28, domain/mergedSuggestions.ts): both parsers
 * produced an HST amount and they differ. The served value never changes -
 * still heuristic-only, no fallthrough - this only decides whether the note
 * renders. HST carries this and not total or subtotal: it is the input tax
 * credit, the one amount with a direct tax consequence, and exactly the
 * field a split-HST receipt corrupts - a heuristic that reads one component
 * of a printed 5%+8% split produces a wrong-but-plausible number the
 * arithmetic check cannot catch when the subtotal is also missing.
 */
export function hstDisagreementNote(
  receipt: Receipt,
  touched: ReadonlySet<keyof ReceiptDraft>,
): boolean {
  return suggestionDisagreement(
    receipt,
    touched,
    "hst",
    receipt.suggestions?.hstCents.disagreement,
  );
}

/**
 * Proposal #7 (docs/proposals/2026-08-28-ux-enhancements.md #7, approved):
 * a live mirror of the server's `checkHstRatePlausibility`
 * (server/src/domain/arithmetic.ts) - read that function's doc comment
 * first for the full false-positive reasoning behind the narrow scope;
 * this restates only enough to keep the two functions in step rather than
 * re-deriving the reasoning here.
 *
 * Flags ONLY an effective rate within ±0.25 percentage points of 8% - the
 * Ontario PROVINCIAL half of a 13% split standing alone, which has no
 * legitimate reading as a Canadian federal-program tax figure the way 5%
 * does. Deliberately does NOT widen to "anything that isn't 13%": 5% is a
 * real standalone rate (GST-only provinces, and nothing in this system
 * knows the province), and a grocery basket mixing taxable and zero-rated
 * items legitimately runs well under 13% - groceries being most receipts,
 * flagging broadly would make this noise on exactly what people capture
 * most. The residual false positive is stated, not hidden, by the server's
 * own comment: a genuinely correct 13% receipt whose basket is ~38%
 * zero-rated reconciles near 8% too - which is exactly why this is an
 * advisory amber prompt-to-look, never a block or an auto-correction.
 *
 * Integer cross-multiplication, exactly like the server - never a float
 * division - so the band edge does not move with rounding. That is not
 * just a principle here: at the server's own $100.00/$7.75 boundary
 * (exactly 7.75%, the lower edge, which SHOULD flag), a naive
 * `Math.abs(hst/subtotal - 0.08) <= 0.0025` computes a difference of
 * 0.0025000000000000022 - a hair over the tolerance - and wrongly excludes
 * it. The test suite pins this exact case.
 */
export type HstRatePlausibility =
  | "not-applicable"
  | "plausible"
  | "looks-like-half-split";

/** The provincial half of a 13%-split HST (8% + 5% federal = 13%), in basis points. */
const HALF_SPLIT_RATE_BPS = 800;
/** ±0.25 percentage points - mirrors the server's own tolerance exactly. */
const HALF_SPLIT_TOLERANCE_BPS = 25;

export function checkHstRatePlausibility(input: {
  subtotalCents: number | null;
  hstCents: number | null;
}): HstRatePlausibility {
  // No subtotal, no HST, or a subtotal that cannot anchor a rate (zero or
  // a refund's negative) - there is no ratio to evaluate, the server
  // function's own first check.
  if (
    input.subtotalCents === null ||
    input.hstCents === null ||
    input.subtotalCents <= 0
  ) {
    return "not-applicable";
  }
  // hst/subtotal within [target-tol, target+tol]/10000
  // <=> hst*10000 within [target-tol, target+tol] * subtotal
  const scaledHst = input.hstCents * 10_000;
  const lowerBound =
    (HALF_SPLIT_RATE_BPS - HALF_SPLIT_TOLERANCE_BPS) * input.subtotalCents;
  const upperBound =
    (HALF_SPLIT_RATE_BPS + HALF_SPLIT_TOLERANCE_BPS) * input.subtotalCents;
  return scaledHst >= lowerBound && scaledHst <= upperBound
    ? "looks-like-half-split"
    : "plausible";
}

/**
 * The note's own gate: `suggestionDisagreement`'s exact rule - pending
 * only, untouched, §10A.1's "touching a field clears the tint and the note
 * together" - fed a live-computed plausibility flag instead of a
 * server-suggestion disagreement flag. This is the shared helper both
 * `dateDisagreementNote` and `hstDisagreementNote` above already use,
 * reused here rather than a third copy of the same gating logic. "hst" is
 * the field this note is about, the same choice `hstDisagreementNote`
 * makes for the same reason (HST is the input tax credit a half-split
 * corrupts) - and pending-only matches the proposal's own framing of this
 * as "free signal in the same family as the date-disagreement flag": a
 * sanity check on an unconfirmed OCR read, not a running critique of a
 * value a human has already confirmed.
 *
 * A mid-keystroke unparseable subtotal or HST box silences the check
 * rather than guessing, the same rule `arithmeticMismatch` follows above.
 */
export function hstRateHintNote(
  receipt: Receipt,
  draft: ReceiptDraft,
  touched: ReadonlySet<keyof ReceiptDraft>,
): boolean {
  const subtotal = tryParseMoney(draft.subtotal);
  const hst = tryParseMoney(draft.hst);
  const plausibility =
    subtotal === INVALID_MONEY || hst === INVALID_MONEY
      ? "not-applicable"
      : checkHstRatePlausibility({ subtotalCents: subtotal, hstCents: hst });
  return suggestionDisagreement(
    receipt,
    touched,
    "hst",
    plausibility === "looks-like-half-split",
  );
}

/**
 * The two save-time telemetry summaries POST /api/events wants (2026-08-28,
 * events.ts) - "a user editing the total amount repeatedly signals the
 * total-extraction path is unreliable," the owner's own framing for why this
 * exists. `edits` is every field name a save's editing session touched,
 * once per edit (`ReceiptFieldsForm`'s `onFieldEdited` callback, called
 * once per keystroke from `text()` below - the caller collects these into
 * an array and hands the whole array to this function once, at save,
 * rather than this module tracking a "session" itself).
 *
 * Pure and receipt/edits-in, summaries-out on purpose: this is the one part
 * of the telemetry feature genuinely worth a test that needs no DOM and no
 * React render, matching `arithmeticMismatch`'s own reasoning above.
 *
 * `suggestionOutcomes` unions `suggestedFields` - the server's OCR merge,
 * the exact set already driving the amber tint's server-sourced half - with
 * `clientAppliedFields`, the client-sourced half (a derived-amount fill,
 * proposal #1, or a vendor default, proposal #2 - `ReceiptFieldsForm`'s
 * `onSuggestionApplied` callback, accumulated by the caller exactly like
 * `edits` is). This is the fix for the asymmetry the owner ruled on
 * 2026-08-28: those two sources used to fire `suggestion_accepted` the
 * instant the fill was applied, which could never emit `overridden` for a
 * fill someone then corrected - structurally always-accepted on this
 * client while iOS's save-time snapshot scored the same fields honestly.
 * Folding them into this one save-time mechanism, the one iOS has always
 * used, is the whole fix: both clients now decide accepted/overridden the
 * same way, for every suggestion source, so `npm run action-report`'s
 * override rate means the same thing on both.
 *
 * A field "accepted" when it was never edited after carrying a suggestion
 * and "overridden" when it was, at least once. Not a value comparison:
 * re-typing the exact suggested (or filled) value still counts as an
 * override, the same "touching clears it permanently" rule the amber tint
 * itself follows (§10A.1), rather than a second, looser definition of
 * "changed" that could disagree with what the person saw on screen.
 */
export function summarizeFieldEdits(
  receipt: Receipt,
  edits: readonly (keyof ReceiptDraft)[],
  clientAppliedFields: ReadonlySet<SuggestibleField> = new Set(),
): {
  fieldEditCounts: { field: keyof ReceiptDraft; count: number }[];
  suggestionOutcomes: { field: SuggestibleField; accepted: boolean }[];
} {
  const counts = new Map<keyof ReceiptDraft, number>();
  for (const field of edits) {
    counts.set(field, (counts.get(field) ?? 0) + 1);
  }
  const edited = new Set(edits);
  const suggested = new Set([...suggestedFields(receipt), ...clientAppliedFields]);
  return {
    fieldEditCounts: [...counts].map(([field, count]) => ({ field, count })),
    suggestionOutcomes: [...suggested].map((field) => ({
      field,
      accepted: !edited.has(field),
    })),
  };
}

/**
 * Turns one save's collected edits into the field_edited / suggestion_*
 * events and fires them (events.ts's `logEvent` - fire-and-forget, so this
 * function itself never throws or returns anything for a caller to await).
 * `summarizeFieldEdits` above stays pure and is what the test pins; this is
 * just wiring its result to the log, kept in one place rather than
 * duplicated in ConfirmQueue.tsx and ReceiptDetail.tsx - the two screens
 * that both call it right after a successful confirm/save.
 */
export function logFieldEditTelemetry(
  receipt: Receipt,
  edits: readonly (keyof ReceiptDraft)[],
  clientAppliedFields?: ReadonlySet<SuggestibleField>,
): void {
  const { fieldEditCounts, suggestionOutcomes } = summarizeFieldEdits(
    receipt,
    edits,
    clientAppliedFields,
  );
  for (const { field, count } of fieldEditCounts) {
    logEvent({ action: "field_edited", field, count, receiptId: receipt.id });
  }
  for (const { field, accepted } of suggestionOutcomes) {
    logEvent({
      action: accepted ? "suggestion_accepted" : "suggestion_overridden",
      field,
      receiptId: receipt.id,
    });
  }
}

/**
 * Proposal #8's debounce: comfortably longer than a keystroke gap, short
 * enough that the warning still feels like it belongs to what was just
 * typed rather than an unrelated later event. Applies to date, vendor and
 * total together - one timer, not three - so typing a vendor right after
 * a date does not fire two overlapping lookups.
 */
const DUPLICATE_LOOKUP_DEBOUNCE_MS = 500;

export function ReceiptFieldsForm({
  receipt,
  draft,
  setDraft,
  options,
  api,
  onOpenReceipt,
  disabled,
  onFieldEdited,
  onSuggestionApplied,
}: {
  /** For its id (to reset "touched" on a new receipt), status and
   * suggestions - which fields start amber reads off this, not the draft. */
  receipt: Receipt;
  draft: ReceiptDraft;
  setDraft: (update: (draft: ReceiptDraft) => ReceiptDraft) => void;
  /** Past values offered under Vendor, Category and Payment method. */
  options: ReceiptOptions;
  /** Proposal #8's near-duplicate lookup - GET /api/receipts/possible-duplicates. */
  api: KeptApi;
  /**
   * Opens another receipt for comparison (proposal #8's "offer a way to
   * open the matching receipt"). Both call sites (ConfirmQueue.tsx,
   * ReceiptDetail.tsx) already have a way to switch the app's view to a
   * receipt's detail screen - this is that, handed down rather than this
   * component owning navigation it has no other reason to know about.
   */
  onOpenReceipt: (id: string) => void;
  disabled?: boolean;
  /**
   * Fired once per keystroke, before `setDraft` - the raw signal
   * `summarizeFieldEdits` above turns into save-time telemetry. Optional
   * and un-debounced on purpose: this form has no opinion on what a
   * "session" of edits is or when it ends (that is Save/Confirm, which
   * this component does not render), so it just reports every edit and
   * lets the screen that owns Save decide what to do with the sequence.
   */
  onFieldEdited?: (field: keyof ReceiptDraft) => void;
  /**
   * Fired once, the moment a field first receives a CLIENT-applied
   * suggestion - a derived-amount fill (proposal #1) or a vendor default
   * (proposal #2) - never on every render, and never on a re-fill of a
   * field this already fired for (mirrors `clientApplied` state's own
   * "once added, stays added" rule below). The caller (ReceiptDetail.tsx,
   * ConfirmQueue.tsx) accumulates these into the same kind of ref
   * `onFieldEdited` feeds, and hands the set to `logFieldEditTelemetry` at
   * save - this is the whole fix for the accepted/overridden asymmetry
   * the owner ruled on: applying a fill is no longer itself an "accepted"
   * event, only save-time evidence of what carried a suggestion.
   */
  onSuggestionApplied?: (field: SuggestibleField) => void;
}) {
  // §10A.1: "touching a field clears its tint permanently." Tracked here,
  // not derived from draft-vs-suggestion equality, because a permanent
  // clear must survive the person typing their way back to the suggested
  // value. Reset when a different receipt loads - the parent (detail view,
  // confirm queue) swaps `receipt`/`draft` in place on navigation rather
  // than unmounting this component, so nothing else resets it.
  const [touched, setTouched] = useState<ReadonlySet<keyof ReceiptDraft>>(
    () => new Set(),
  );
  // Which fields currently hold a CLIENT-applied suggestion - a derived
  // amount fill (proposal #1) or a vendor default (proposal #2) - as
  // opposed to `suggested` below, which is the server's OCR merge. Once a
  // field is added here it stays, even after it is touched: `amber()`
  // already re-gates on `touched`, and this set is what would let a future
  // save-time accept/override summary (like `summarizeFieldEdits`'s
  // server-suggestion one) tell "this field once held ours" from "it never
  // did" - not needed for the reset rule below either way, so it resets
  // alongside `touched` on every new receipt.
  const [clientApplied, setClientApplied] = useState<ReadonlySet<SuggestibleField>>(
    () => new Set(),
  );
  // Proposal #8's matches, if any - reset alongside touched/clientApplied
  // whenever a different receipt loads, same reasoning as those two: a
  // stale match from the PREVIOUS receipt must not flash on screen while
  // the new receipt's own (debounced) lookup is still in flight.
  const [duplicates, setDuplicates] = useState<readonly Receipt[]>([]);
  useEffect(() => {
    setTouched(new Set());
    setClientApplied(new Set());
    setDuplicates([]);
  }, [receipt.id]);

  // Proposal #8 (2026-08-28, approved): warn when a live receipt already
  // exists with this date, vendor and total - a re-photographed piece of
  // paper shares no pixels with its first scan, so the (user_id, sha256)
  // constraint can never catch it (§5, §11's deferral, now built).
  // Debounced so it does not fire on every keystroke; `duplicateLookupParams`
  // (duplicates.ts) is what decides there is enough to look up at all, and
  // always carries `excludeId: receipt.id` - both screens that render this
  // form only ever open a receipt that already exists server-side, so
  // omitting it would always match the receipt against itself, the
  // obvious bug named in the brief this was built from. `cancelled` guards
  // against a stale response landing after a later keystroke has already
  // started a newer lookup. `lookupPossibleDuplicates` itself never
  // throws - a failed lookup is silent, an assist rather than a gate - so
  // there is nothing to catch here.
  useEffect(() => {
    const params = duplicateLookupParams(
      { purchasedAt: draft.purchasedAt, total: draft.total, vendor: draft.vendor },
      receipt.id,
    );
    if (params === null) {
      setDuplicates([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void lookupPossibleDuplicates(api, params).then((found) => {
        if (!cancelled) {
          setDuplicates(found);
        }
      });
    }, DUPLICATE_LOOKUP_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, receipt.id, draft.purchasedAt, draft.total, draft.vendor]);

  const suggested = suggestedFields(receipt);
  const amber = (field: SuggestibleField): string | undefined =>
    (suggested.has(field) || clientApplied.has(field)) && !touched.has(field)
      ? "suggested"
      : undefined;

  const text =
    (key: keyof ReceiptDraft) =>
    (event: { target: { value: string } }) => {
      setTouched((t) => (t.has(key) ? t : new Set(t).add(key)));
      onFieldEdited?.(key);
      setDraft((d) => ({ ...d, [key]: event.target.value }));
    };

  const mismatch = arithmeticMismatch(draft);
  // §10A.1's disagreement notes live here, not in the two screens that
  // embed this form, so they get the arithmetic warning's exact treatment
  // ("inside the field") wherever a pending receipt's fields render -
  // confirm queue and a pending receipt opened straight from the table.
  const dateDisagreement = dateDisagreementNote(receipt, touched);
  const hstDisagreement = hstDisagreementNote(receipt, touched);
  const hstRateHint = hstRateHintNote(receipt, draft, touched);

  // Proposal #1: at most one of these is ever non-null for a given draft -
  // `deriveMissingAmount` requires exactly one field blank,
  // `reconciliationSuggestions` requires none blank - so there is no need
  // to reconcile the two ever both having something to say about the same
  // field.
  const derived = deriveMissingAmount(draft);
  const reconciliation = derived === null ? reconciliationSuggestions(draft) : null;

  /** Applies a derived-amount fill (the "Fill" button in `AmountDeriveNote`
   * below) - never wired to `text()`/`onFieldEdited`/`touched`, because
   * applying the suggestion is not the person editing it: the whole point
   * (proposal #1's own risk mitigation) is that the filled value lands
   * amber and STAYS amber until a person actually looks at and touches it,
   * never silently on save.
   *
   * Does NOT log `suggestion_accepted` here (2026-08-28, the owner's ruling -
   * see `summarizeFieldEdits`'s doc comment above): applying a fill is an
   * offer taken, not a save-time outcome - the person can still go on to
   * edit the field before saving, which must score as `overridden`, and
   * firing `accepted` at apply-time would make that impossible. Reports
   * through `onSuggestionApplied` instead, so the caller can fold this
   * field into the same save-time accepted/overridden mechanism the
   * server's own suggestions already use. */
  function applyDerivedAmount(offer: DerivedAmount) {
    const key = offer.field;
    setDraft((d) => ({ ...d, [key]: formatCents(offer.cents) }));
    setClientApplied((current) => (current.has(key) ? current : new Set(current).add(key)));
    onSuggestionApplied?.(key);
  }

  // Proposal #2: live, not just on load - a vendor typed or corrected mid-
  // session that comes to match a known vendor gets the same treatment as
  // one that arrived already matching from a suggestion. `vendorDefaultFill`
  // is what actually enforces "empty and untouched only"; this effect is
  // just wiring its result to `setDraft` and to the amber/telemetry state.
  //
  // Does NOT log `suggestion_accepted` here (2026-08-28, same ruling as
  // `applyDerivedAmount` above) - `onSuggestionApplied` reports the field
  // instead, so the caller scores it at save time alongside every other
  // suggestion source rather than the instant the default lands.
  useEffect(() => {
    const fill = vendorDefaultFill(draft, touched, options.vendorDefaults);
    if (fill.category === null && fill.paymentMethod === null) {
      return;
    }
    setDraft((d) => ({
      ...d,
      ...(fill.category !== null && { category: fill.category }),
      ...(fill.paymentMethod !== null && { paymentMethod: fill.paymentMethod }),
    }));
    setClientApplied((current) => {
      const next = new Set(current);
      if (fill.category !== null) next.add("category");
      if (fill.paymentMethod !== null) next.add("paymentMethod");
      return next;
    });
    if (fill.category !== null) {
      onSuggestionApplied?.("category");
    }
    if (fill.paymentMethod !== null) {
      onSuggestionApplied?.("paymentMethod");
    }
  }, [draft, touched, options.vendorDefaults, receipt.id, setDraft, onSuggestionApplied]);

  return (
    <div className="field-grid">
      <label className={["total-field", amber("total")].filter(Boolean).join(" ")}>
        Total
        <input
          className="money"
          value={draft.total}
          onChange={text("total")}
          disabled={disabled}
          placeholder="Not found"
        />
      </label>
      {mismatch && (
        <p className="warning">
          Subtotal + HST + tip + other fees doesn't add up to total - worth a
          look, not a blocker.
        </p>
      )}
      {/* Only reachable when `mismatch` above is not: total is blank exactly
          when arithmeticMismatch has nothing to reconcile against, so the
          two never render together (see `derived`'s own comment). */}
      <AmountDeriveNote
        offer={derived?.field === "total" ? derived : null}
        onApply={applyDerivedAmount}
      />
      {/* Proposal #8: date + total (and vendor once typed) are what the
          lookup keys on, so this sits beside Total rather than any one of
          the three fields - "worth a look, not a blocker," the same
          register as the arithmetic warning above it. */}
      <PossibleDuplicatesNote duplicates={duplicates} onOpenReceipt={onOpenReceipt} />
      <label className={amber("purchasedAt")}>
        Purchase date
        <input
          type="date"
          value={draft.purchasedAt}
          onChange={text("purchasedAt")}
          disabled={disabled}
        />
      </label>
      {dateDisagreement && (
        <p className="warning">
          The two parsers read different dates from this receipt - check the
          paper before confirming.
        </p>
      )}
      {/* Both a suggestion field (amber until touched, like the other
          served fields) and a reusable-value field (the datalist below) -
          the only field on this form that is both. */}
      <label className={amber("vendor")}>
        Vendor
        <input
          value={draft.vendor}
          onChange={text("vendor")}
          disabled={disabled}
          list={VENDOR_LIST_ID}
        />
      </label>
      <label className={amber("hst")}>
        HST
        <input
          className="money"
          value={draft.hst}
          onChange={text("hst")}
          disabled={disabled}
          placeholder="Not found"
        />
      </label>
      {hstDisagreement && (
        <p className="warning">
          The two parsers read different HST amounts from this receipt -
          check the paper before confirming.
        </p>
      )}
      {hstRateHint && (
        <p className="warning">
          HST is close to 8% of subtotal - the size of Ontario&apos;s
          PROVINCIAL half alone. If the receipt shows a 5%+8% split, check
          for a combined 13% before confirming.
        </p>
      )}
      <AmountDeriveNote
        offer={derived?.field === "hst" ? derived : null}
        onApply={applyDerivedAmount}
      />
      <label className={amber("subtotal")}>
        Subtotal
        <input
          className="money"
          value={draft.subtotal}
          onChange={text("subtotal")}
          disabled={disabled}
          placeholder="Not found"
        />
      </label>
      <AmountDeriveNote
        offer={derived?.field === "subtotal" ? derived : null}
        onApply={applyDerivedAmount}
      />
      <label className={amber("tip")}>
        Tip
        <input
          className="money"
          value={draft.tip}
          onChange={text("tip")}
          disabled={disabled}
          placeholder="Not found"
        />
      </label>
      {/* Either offer, never both (`derived`/`reconciliation` above are
          mutually exclusive by construction): the single-missing-field fill
          when tip is the one blank amount, the reconciliation fix when all
          five are present but do not add up. */}
      <AmountDeriveNote
        offer={derived?.field === "tip" ? derived : (reconciliation?.tip ?? null)}
        onApply={applyDerivedAmount}
      />
      {/* Proposal #1 widened this field's amber source beyond the OCR merge
          (see `SuggestibleField`'s comment): no heuristic has ever
          suggested other fees, but a derived fill or a reconciliation fix
          can now land here, so it gets the same amber treatment as every
          other amount field instead of being permanently exempt. */}
      <label className={amber("otherFees")}>
        Other fees
        <input
          className="money"
          value={draft.otherFees}
          onChange={text("otherFees")}
          disabled={disabled}
          placeholder="Not found"
        />
      </label>
      <AmountDeriveNote
        offer={derived?.field === "otherFees" ? derived : (reconciliation?.otherFees ?? null)}
        onApply={applyDerivedAmount}
      />
      {/* Free text with the person's own past values offered: a suggestion
          list, never a closed set. Proposal #2's vendor default is the same
          amber source as `otherFees` above - a client-applied suggestion
          the OCR merge has no key for at all. */}
      <label className={amber("category")}>
        Category
        <input
          value={draft.category}
          onChange={text("category")}
          disabled={disabled}
          placeholder="free text"
          list={CATEGORY_LIST_ID}
        />
      </label>
      <label className={amber("paymentMethod")}>
        Payment method
        <input
          value={draft.paymentMethod}
          onChange={text("paymentMethod")}
          disabled={disabled}
          list={PAYMENT_LIST_ID}
        />
      </label>
      <ReceiptOptionsDatalists values={options} />
      <label className="notes">
        Notes
        <textarea
          value={draft.notes}
          onChange={text("notes")}
          disabled={disabled}
          rows={3}
        />
      </label>
    </div>
  );
}

/**
 * Proposal #1's affordance, rendered next to whichever field it is about:
 * the formula and the computed amount together (the risk mitigation named
 * in the proposal - "the affordance says what it is doing... rather than
 * just appearing"), and filling is a deliberate click via `onApply`, never
 * automatic and never wired to Save. Reused for both of this form's
 * offers - `deriveMissingAmount`'s single missing field and
 * `reconciliationSuggestions`' fix - since both produce the identical
 * `DerivedAmount` shape and both land amber the same way once applied.
 * `.warning` for its background (this is the same amber family as every
 * other unreviewed-suggestion note on this form, §10A.1 - never a separate,
 * softer treatment) with its own class for the "Fill" button's styling.
 */
function AmountDeriveNote({
  offer,
  onApply,
}: {
  offer: DerivedAmount | null;
  onApply: (offer: DerivedAmount) => void;
}) {
  if (offer === null) {
    return null;
  }
  return (
    <p className="warning derive-note">
      {offer.formula} = {formatCents(offer.cents)}
      <button type="button" className="link" onClick={() => onApply(offer)}>
        Fill
      </button>
    </p>
  );
}

/**
 * Proposal #8's warning: states exactly what matched - date, vendor,
 * total, nothing the person did not already put in the box - with a way
 * to open each match and compare, and deliberately no way to dismiss or
 * refuse the save from here. There is no ignore/dismiss control: editing
 * any of the three fields the lookup keys on re-runs it and naturally
 * clears a match that no longer applies (the same "live, not a permanent
 * flag" register as `arithmeticMismatch`'s own warning above), and adding
 * a separate dismiss would be a second way to make this go away that says
 * nothing about whether the person actually looked.
 */
function PossibleDuplicatesNote({
  duplicates,
  onOpenReceipt,
}: {
  duplicates: readonly Receipt[];
  onOpenReceipt: (id: string) => void;
}) {
  if (duplicates.length === 0) {
    return null;
  }
  return (
    <div className="warning duplicate-warning">
      <p>
        {duplicates.length === 1
          ? "A receipt with this date, vendor and total already exists - is this the same one?"
          : `${duplicates.length} receipts with this date, vendor and total already exist - is this the same one?`}
      </p>
      <ul>
        {duplicates.map((match) => (
          <li key={match.id}>
            <span>
              {match.purchasedAt} · {match.vendor ?? "no vendor"} ·{" "}
              {formatCents(match.totalCents)}
            </span>
            <button
              type="button"
              className="link"
              onClick={() => onOpenReceipt(match.id)}
            >
              Open
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
