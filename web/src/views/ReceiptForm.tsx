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
import {
  REVIEWED_FIELDS,
  type Receipt,
  type ReceiptOptions,
  type ReceiptPatch,
  type ReviewedField,
  type WithholdableAmountSuggestion,
} from "../types.js";

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
 * The one mapping between this form's draft keys and the server's field
 * names (`ReviewedField`, types.ts). Both directions are total - ten keys,
 * ten names - and they live here, next to the draft they translate, so no
 * screen has to spell `hstCents` for a box labelled HST. 2026-09-01, with
 * `reviewedFields`.
 */
const DRAFT_KEY_BY_REVIEWED_FIELD: Record<ReviewedField, keyof ReceiptDraft> = {
  purchasedAt: "purchasedAt",
  vendor: "vendor",
  subtotalCents: "subtotal",
  hstCents: "hst",
  tipCents: "tip",
  otherFeesCents: "otherFees",
  totalCents: "total",
  category: "category",
  paymentMethod: "paymentMethod",
  notes: "notes",
};

const REVIEWED_FIELD_BY_DRAFT_KEY: Record<keyof ReceiptDraft, ReviewedField> = {
  purchasedAt: "purchasedAt",
  vendor: "vendor",
  subtotal: "subtotalCents",
  hst: "hstCents",
  tip: "tipCents",
  otherFees: "otherFeesCents",
  total: "totalCents",
  category: "category",
  paymentMethod: "paymentMethod",
  notes: "notes",
};

/**
 * The §7.3 display rule for a pending receipt, as the iOS client renders
 * it (ReceiptDisplay, Aug 8): the served merge's suggestion over the row
 * copy, the row filling only fields no suggestion covers. Confirmed
 * receipts never come here - they render the row, the human's values.
 *
 * ⚠ 2026-09-01: a field in `receipt.reviewedFields` is the HUMAN's, and the
 * row wins outright for it - a "save for later" wrote those values, and
 * re-offering the parser's guess over a value someone typed last Tuesday
 * is exactly the defect the reviewed set exists to prevent. Belt and
 * braces: the server also stops serving `suggestions.<field>` for every
 * reviewed field, so this loop is normally re-stating an absence rather
 * than overriding a present suggestion. It is written anyway because the
 * two rules must agree even if one end changes - and because a client that
 * relies on the server having remembered is a client that shows the wrong
 * value the day it has not.
 *
 * ⚠ 2026-09-01, later the same day - three additions, and two of them run
 * the OPPOSITE way to the rule above:
 *
 * - A WITHHELD amount (`suggestions.totalCents.withheld`) lands blank, and
 *   the row is not consulted for it. Everywhere else an absent suggestion
 *   falls through to the row; here that would defeat the whole rule, since
 *   a pending row's amounts are the same capture-time heuristic snapshot
 *   the server just declined to serve - the $8.50 it withheld and the
 *   $8.50 sitting in the row are one number, reached two ways. The server
 *   deliberately does not send the raw value; this must not go and find it.
 * - `paymentMethod` and `otherFees` prefill from the merge only when the
 *   ROW HAS NONE, which is backwards from vendor and the amounts. Neither
 *   field has ever had a capture-time heuristic write behind it, so a value
 *   in the row is a human's, and the §7.1 reason the merge outranks a
 *   pending row's copy ("the row is the parser's snapshot") simply does not
 *   apply to these two. Precedence, stated once: row value, then served
 *   suggestion, then vendor default - and the third falls out for free,
 *   because `vendorDefaultFill` only ever fills a field that is empty.
 */
export function draftFromPending(receipt: Receipt): ReceiptDraft {
  const row = draftFromReceipt(receipt);
  const s = receipt.suggestions;
  const merged: ReceiptDraft = {
    ...row,
    purchasedAt: s?.purchasedAt.value ?? receipt.purchasedAt,
    vendor: s?.vendor.value ?? receipt.vendor ?? "",
    subtotal: withheldAmount(s?.subtotalCents)
      ? ""
      : formatCents(s?.subtotalCents.value ?? receipt.subtotalCents),
    hst: formatCents(s?.hstCents.value ?? receipt.hstCents),
    total: withheldAmount(s?.totalCents)
      ? ""
      : formatCents(s?.totalCents.value ?? receipt.totalCents),
    tip: formatCents(s?.tipCents.value ?? receipt.tipCents),
    otherFees: formatCents(receipt.otherFeesCents ?? s?.otherFeesCents?.value ?? null),
    paymentMethod: receipt.paymentMethod ?? s?.paymentMethod?.value ?? "",
  };
  for (const field of receipt.reviewedFields) {
    const key = DRAFT_KEY_BY_REVIEWED_FIELD[field];
    merged[key] = row[key];
  }
  return merged;
}

/**
 * Whether the server declined to serve this amount because the set it
 * belongs to is arithmetically impossible (2026-09-01,
 * `domain/suggestedAmounts.ts`). One predicate, so the blanking rule above
 * and the note below read the flag the same way - including the `=== true`,
 * which is what makes an older response that carries no such key read as
 * "not withheld" rather than as anything else.
 */
function withheldAmount(
  suggestion: WithholdableAmountSuggestion | undefined,
): boolean {
  return suggestion?.withheld === true;
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
 * ⚠ 2026-09-01: this is now also the rule for redrawing after a save, which
 * reverses what stood here since August. The old note read: "a save returns
 * the human's own values, and re-deriving the merge over them would visibly
 * overwrite what they just typed with the parser's guess; that path stays on
 * `draftFromReceipt` deliberately." That was true when a save wrote the
 * whole draft - the row then held everything, so the row WAS the full
 * picture, and the merge could only spoil it.
 *
 * Both halves of that changed on 2026-09-01, in opposite directions:
 *
 * - A save-for-later writes only the REVIEWED fields (`patchForSaveForLater`),
 *   so the row is no longer the full picture. Redrawing from it alone blanks
 *   every box the merge had prefilled and nobody touched - the person clicks
 *   Save and watches the suggested total vanish.
 * - A reviewed field's row value now wins outright over any suggestion
 *   (`draftFromPending`, and the server stops serving one for it at all), so
 *   the overwrite the old note feared cannot happen: what they just typed is
 *   exactly what is now protected.
 *
 * So the two rules that used to conflict now agree, and one function serves
 * both moments. A confirmed receipt is unaffected either way - this returns
 * `draftFromReceipt` for one.
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

/**
 * What a save reports as reviewed (2026-09-01): the receipt's existing
 * reviewed set unioned with every field this editing session touched.
 *
 * A union, never a replacement, even though the PATCH replaces the stored
 * set outright - the person who opened this receipt today did not un-review
 * what they looked at last week, and a client that sent only today's
 * touches would silently un-review the rest and hand the parser back a
 * field it had already lost. `touched` is the form's own set, the same one
 * §10A.1's amber rule reads: touching a field is what "I have looked at
 * this" means everywhere else in this form, so it is what it means here.
 *
 * Ordered by `REVIEWED_FIELDS` rather than by insertion, so the same set
 * always serializes the same way - a request body that varies with click
 * order is one no test can pin.
 */
export function reviewedFieldsForSave(
  receipt: Receipt,
  touched: ReadonlySet<keyof ReceiptDraft>,
): ReviewedField[] {
  const reviewed = new Set<ReviewedField>(receipt.reviewedFields);
  for (const key of touched) {
    reviewed.add(REVIEWED_FIELD_BY_DRAFT_KEY[key]);
  }
  return REVIEWED_FIELDS.filter((field) => reviewed.has(field));
}

/**
 * The "save for later" write (2026-09-01): the REVIEWED fields' values and
 * the reviewed set, and deliberately NO `status`. The receipt stays
 * pending, keeps its place in the queue and in the list's pending count,
 * and the fields just written stop being re-suggested. It is the write for
 * a receipt someone got halfway through - the vendor and total are on the
 * screen, the category needs a decision they cannot make now - and until
 * this existed the only two ways out of that form were "confirm a receipt
 * you are not sure about" and "lose what you typed".
 *
 * ⚠ **Only the reviewed fields' values**, which is what makes this a
 * halfway save rather than a quiet full one (fixed later on 2026-09-01;
 * it diffed the whole draft before). The form a person is looking at is
 * PREFILLED from the merge, so a whole-draft diff wrote the parser's
 * guesses into the row for every field they never touched - the suggested
 * total, the suggested vendor - and those values then stopped being
 * suggestions and started being the record. That is exactly what "no OCR
 * value saves without a human confirming it" (constraint 2) forbids, and a
 * save-for-later is by definition the moment nobody has confirmed them yet.
 * An untouched field's row value is left alone: the field is still blank or
 * still holds whatever it held, and the merge will offer the same
 * suggestion again next time the receipt opens.
 *
 * `patchForConfirm` below deliberately keeps sending everything - a confirm
 * IS the human accepting the whole form, which is the confirmation
 * constraint 2 asks for.
 *
 * ⚠ Not a confirmation and never a substitute for one. Constraint 2 and
 * the export rule are untouched: nothing with `status = 'pending'` may
 * appear in an export, and this write leaves it pending on purpose.
 */
export function patchForSaveForLater(
  receipt: Receipt,
  draft: ReceiptDraft,
  touched: ReadonlySet<keyof ReceiptDraft>,
): ReceiptPatch {
  const reviewedFields = reviewedFieldsForSave(receipt, touched);
  return {
    ...limitPatchToFields(patchFromDraft(receipt, draft), new Set(reviewedFields)),
    reviewedFields,
  };
}

/**
 * The whole-draft diff narrowed to the fields a human has looked at.
 *
 * Written as "build everything, then drop what is not reviewed" rather than
 * threading a filter through `patchFromDraft`'s nine assignments, for one
 * reason worth the extra pass: the money parser still runs over every box,
 * so a save-for-later with an unparseable amount in an UNREVIEWED field
 * still throws `DraftError` and names it, instead of silently shipping a
 * patch that omits the broken field. A form that quietly saves around
 * something it could not read is the error-masking this repo hunts for.
 *
 * Every `ReviewedField` name is also a `ReceiptPatch` key of the same type -
 * that is the whole point of the server naming them after its columns - so
 * deleting by that name is total and needs no mapping table.
 */
function limitPatchToFields(
  patch: ReceiptPatch,
  fields: ReadonlySet<ReviewedField>,
): ReceiptPatch {
  const limited: ReceiptPatch = { ...patch };
  for (const field of REVIEWED_FIELDS) {
    if (!fields.has(field)) {
      delete limited[field];
    }
  }
  return limited;
}

/**
 * The confirm write: the same patch plus `status: 'confirmed'`, and every
 * field's value rather than only the reviewed ones. A confirm is the person
 * accepting the whole form as it stands - that is what constraint 2's
 * "a human confirming it" means - so what is on screen is what gets stored,
 * suggested values included. The reviewed set rides along harmlessly (a
 * confirmed receipt is served no suggestions at all, so nothing consumes
 * it) and is sent anyway so the two writes differ in as little as possible.
 */
export function patchForConfirm(
  receipt: Receipt,
  draft: ReceiptDraft,
  touched: ReadonlySet<keyof ReceiptDraft>,
): ReceiptPatch {
  return {
    ...patchFromDraft(receipt, draft),
    reviewedFields: reviewedFieldsForSave(receipt, touched),
    status: "confirmed",
  };
}

/**
 * Whether a save-for-later patch would change nothing at all - no field
 * differs and the reviewed set is the one already stored. The detail
 * screen's "Nothing changed." notice reads this rather than
 * `Object.keys(patch).length === 0`, which stopped being the right test the
 * moment every save-for-later carries a `reviewedFields` key: marking a
 * field reviewed IS a change worth sending, and re-sending the identical
 * set is not.
 *
 * Since the save-for-later patch now carries values only for reviewed
 * fields, "no key but `reviewedFields`" means the narrower and more useful
 * thing it always should have: nothing a human looked at differs from the
 * row - not merely that the draft happened to match the row everywhere,
 * suggestions included.
 *
 * A patch with NO `reviewedFields` key at all is the confirmed-receipt edit
 * (`patchFromDraft` alone, ReceiptDetail.tsx): an empty one changes
 * nothing, and comparing an absent set against the receipt's stored one
 * would have called it a change and sent `PATCH {}` on every no-op save of
 * a receipt that had ever been half-filled.
 */
export function patchChangesNothing(
  receipt: Receipt,
  patch: ReceiptPatch,
): boolean {
  if (Object.keys(patch).some((key) => key !== "reviewedFields")) {
    return false;
  }
  const next = patch.reviewedFields;
  if (next === undefined) {
    return true;
  }
  return (
    next.length === receipt.reviewedFields.length &&
    next.every((field) => receipt.reviewedFields.includes(field))
  );
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

/**
 * Mirrors the server's `OMISSION_IS_ZERO_FIELDS` (2026-09-01 widening of
 * `deriveMissingAmount`, same file as the rest of this mirror). A blank tip
 * or other-fees box is not an unknown: `arithmeticMismatch` above has
 * always read it as "no such line on this receipt", contributing zero, and
 * the derivation reading it as anything else meant the two disagreed about
 * the same equation - the commonest receipt shape of all (a subtotal and a
 * total, no tip, no fees, HST missing) had three blanks and derived
 * nothing, so proposal #1's fill was almost unreachable in practice.
 *
 * Solving FOR a tip or other-fees amount still needs the other four
 * present. That asymmetry is the point: "the tip line is blank, so there
 * was no tip" is a reading anyone would make of the paper, while "the tip
 * is whatever makes these four numbers balance" invents a gratuity out of a
 * rounding difference - the same reasoning as the negative-tip refusal
 * above.
 */
const OMISSION_IS_ZERO_AMOUNT_FIELDS: ReadonlySet<DerivableAmountField> =
  new Set(["tip", "otherFees"]);

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
 * every case the server would: more than one genuinely unknown field, a
 * mid-keystroke unparseable box, a negative tip or other-fees result, or a
 * result outside the storable cents range.
 *
 * The "genuinely unknown" split below is the server's own, field for field
 * (2026-09-01) - see `OMISSION_IS_ZERO_AMOUNT_FIELDS` above.
 */
export function deriveMissingAmount(draft: ReceiptDraft): DerivedAmount | null {
  const parsed = parseAmounts(draft);
  if (parsed === null) {
    return null;
  }
  const missing = DERIVABLE_AMOUNT_FIELDS.filter((field) => parsed[field] === null);
  const unknown = missing.filter(
    (field) => !OMISSION_IS_ZERO_AMOUNT_FIELDS.has(field),
  );
  const field =
    unknown.length === 1
      ? unknown[0]
      : // No hard unknown left: the only solvable shape remaining is a
        // single blank tip or other-fees box with all four of its
        // neighbours filled, which is the pre-2026-09-01 rule unchanged
        // for those two fields.
        unknown.length === 0 && missing.length === 1
        ? missing[0]
        : undefined;
  if (field === undefined) {
    return null;
  }
  // Every field but the one being solved for either has a value or is a
  // blank tip/other-fees box reading as zero, so summing with `?? 0` adds
  // every KNOWN component and adds nothing for the field being solved for -
  // exactly the server function's own comment on this line.
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
 * Ontario's combined HST, in basis points - the only rate this client ever
 * suggests, and a DEFAULT rather than a fact: nothing in this system knows
 * which province a receipt was printed in (`checkHstRatePlausibility`'s own
 * comment makes the same point from the other direction). Overridable per
 * call so the number is never hard-coded inside the arithmetic.
 */
export const DEFAULT_HST_RATE_BPS = 1300;

/**
 * The live mirror of the server's `suggestDefaultRateHst`
 * (`domain/arithmetic.ts`, 2026-09-01): what HST and total a subtotal
 * WOULD carry at the default rate. For the receipt that prints a subtotal
 * and nothing else - a handwritten invoice, a PDF whose tax line the
 * parsers could not find - where `deriveMissingAmount` has nothing to
 * subtract from and stays silent.
 *
 * ⚠ A suggestion, exactly like every other function in this file, and a
 * weaker one than the derivations above: those solve an equation the
 * receipt's own numbers determine, while this one applies a rate the
 * receipt may not have been charged. It reaches the person only as a chip
 * that says "HST at 13%" in those words, never as a fill that happens
 * quietly - constraint 2 with an extra reason to mean it.
 *
 * Round HALF UP in integer arithmetic, never a float: `(subtotal * rate +
 * 5000) / 10000` floored is the same number a cash register computes, and
 * `Math.round(subtotal * rate / 10000)` is not - the intermediate divide
 * introduces exactly the binary-fraction error `money.ts` exists to keep
 * out of this client. Null for a subtotal of zero or less: there is no
 * rate to apply to nothing, and a refund's negative subtotal is not a
 * receipt anyone wants a suggested tax on.
 */
export function suggestDefaultRateHst(
  subtotalCents: number,
  rateBps: number = DEFAULT_HST_RATE_BPS,
): { hstCents: number; totalCents: number } | null {
  if (subtotalCents <= 0) {
    return null;
  }
  const hstCents = Math.floor((subtotalCents * rateBps + 5_000) / 10_000);
  return { hstCents, totalCents: subtotalCents + hstCents };
}

/**
 * The live mirror of the server's `checkAmountFloor` (2026-09-01): a total
 * that is LESS than the parts it is made of.
 *
 * Distinct from `arithmeticMismatch` above, which fires on any inequality
 * in either direction. A total that exceeds its components has an ordinary
 * explanation - a line this form has no box for, a fee nobody typed - and
 * says "there is something else on this paper". A total BELOW its
 * components has no such reading: subtotal, HST, tip and fees are all
 * charges, and no arrangement of them can add up to more than what was
 * paid. One of the numbers on screen is wrong, and that is a sharper thing
 * to say than "worth a look".
 *
 * Still never a block (nothing in this file ever is): plenty of receipts
 * are genuinely odd, and the person confirming is the authority.
 */
export type AmountFloorCheck =
  | "not-applicable"
  | "ok"
  | "total-below-components";

export function checkAmountFloor(input: {
  subtotalCents: number | null;
  hstCents: number | null;
  tipCents: number | null;
  otherFeesCents: number | null;
  totalCents: number | null;
}): AmountFloorCheck {
  // No subtotal or no total - there is nothing to compare, the same first
  // check `checkReceiptArithmetic` makes.
  if (input.subtotalCents === null || input.totalCents === null) {
    return "not-applicable";
  }
  const components =
    input.subtotalCents +
    (input.hstCents ?? 0) +
    (input.tipCents ?? 0) +
    (input.otherFeesCents ?? 0);
  return input.totalCents < components ? "total-below-components" : "ok";
}

/** The floor check over the live draft, with the same "an unparseable box
 * silences it rather than guessing" rule as every other check here. */
export function amountFloorNote(draft: ReceiptDraft): boolean {
  const parsed = parseAmounts(draft);
  if (parsed === null) {
    return false;
  }
  return (
    checkAmountFloor({
      subtotalCents: parsed.subtotal,
      hstCents: parsed.hst,
      tipCents: parsed.tip,
      otherFeesCents: parsed.otherFees,
      totalCents: parsed.total,
    }) === "total-below-components"
  );
}

/**
 * The four boxes that ADD UP to the total, as opposed to the total itself.
 * Named because the tracking rule below treats them as one group and the
 * total as the thing they move.
 */
export type ComponentAmountField = "subtotal" | "hst" | "tip" | "otherFees";

const COMPONENT_AMOUNT_FIELDS: ReadonlySet<keyof ReceiptDraft> = new Set([
  "subtotal",
  "hst",
  "tip",
  "otherFees",
]);

export function isComponentAmountField(
  key: keyof ReceiptDraft,
): key is ComponentAmountField {
  return COMPONENT_AMOUNT_FIELDS.has(key);
}

/**
 * `subtotal + HST + tip + other fees` over the draft, or null when there is
 * no honest sum to state: a blank subtotal (nothing to add to - the same
 * "nothing to reconcile against" rule `arithmeticMismatch` follows) or any
 * mid-keystroke unparseable box. A blank HST, tip or other-fees box
 * contributes zero, exactly as it does everywhere else in this file.
 */
function componentSum(draft: ReceiptDraft): number | null {
  const parsed = parseAmounts(draft);
  if (parsed === null || parsed.subtotal === null) {
    return null;
  }
  return (
    parsed.subtotal +
    (parsed.hst ?? 0) +
    (parsed.tip ?? 0) +
    (parsed.otherFees ?? 0)
  );
}

/**
 * **Total tracks its components while consistent** (2026-09-01), the live
 * rule that turns four boxes into one running bill.
 *
 * Editing subtotal, HST, tip or other fees recomputes the total - but ONLY
 * when the total is blank or still equals what the components said before
 * this edit. The moment the total says something the components do not, it
 * is the person's own number (or the parser's read of the printed total,
 * which is the one figure OCR gets right most often), and no keystroke
 * elsewhere may quietly overwrite it. Editing the total itself never
 * changes any other field, in either direction: the total is the anchor.
 *
 * The three flows this is built from, all of them from a real form:
 *
 * - **A.** OCR found the total ($14.35) and nothing else. Typing a subtotal
 *   of $12.70 leaves the total alone - it came off the paper - and the HST
 *   chip below then offers the $1.65 difference.
 * - **B.** A blank form (a photograph the parsers got nothing from). Typing
 *   subtotal $12.70 makes the total $12.70; typing HST $1.65 makes it
 *   $14.35. The total is never typed at all.
 * - **C.** $12.70 / $1.65 / $14.35, all consistent, and the HST is
 *   corrected to $1.60. The total follows to $14.30, because leaving
 *   $14.35 would create a mismatch the person did not ask for and would
 *   then have to fix by hand.
 *
 * Returns the whole next draft rather than just a total, so the caller
 * cannot apply half of it.
 */
export function applyComponentEdit(
  draft: ReceiptDraft,
  field: ComponentAmountField,
  value: string,
): ReceiptDraft {
  const edited = { ...draft, [field]: value };
  const newSum = componentSum(edited);
  if (newSum === null) {
    // Nothing to track to - a blank subtotal or a box mid-keystroke.
    return edited;
  }
  const total = tryParseMoney(draft.total);
  const oldSum = componentSum(draft);
  const tracks =
    total === null ||
    (total !== INVALID_MONEY && oldSum !== null && total === oldSum);
  if (!tracks) {
    return edited;
  }
  if (finalizeDerivedAmount("total", newSum) === null) {
    // Outside the storable range - the same refusal every other suggestion
    // in this file makes, rather than writing a number the server would
    // 400 on.
    return edited;
  }
  return { ...edited, total: formatCents(newSum) };
}

/**
 * A one-tap amount offer with its arithmetic stated (2026-09-01). Extends
 * `DerivedAmount` rather than duplicating it, so the same note component
 * renders both and an applied chip lands in exactly the same state an
 * applied fill does.
 */
export type AmountChipKind = "hst-from-total" | "hst-at-default-rate";

export interface AmountChip extends DerivedAmount {
  kind: AmountChipKind;
}

/**
 * The HST offer, when HST is blank and a subtotal is present - the shape
 * every receipt whose tax line the parsers missed arrives in.
 *
 * Two offers, never both, because they answer the same question from
 * different evidence and showing a pair would make the person adjudicate
 * between two numbers this form invented:
 *
 * - The receipt states a total: the difference is the tax, and that
 *   difference is a fact about the numbers on screen
 *   (`hst-from-total`). Offered only when it is POSITIVE - a zero or
 *   negative difference is evidence one of the other boxes is wrong, not an
 *   HST amount anyone could act on, the same refusal `finalizeDerivedAmount`
 *   makes for a negative tip.
 * - Otherwise, the default rate (`hst-at-default-rate`), which is a guess
 *   about the world rather than about the receipt and says so in its own
 *   label.
 *
 * Never auto-applied. Applying it also moves the total, through
 * `applyComponentEdit` above and only when that rule allows - which is why
 * the second offer is safe to make on a receipt whose total is already
 * consistent with its subtotal: it is what "add 13% to this" means.
 */
export function hstSuggestionChip(draft: ReceiptDraft): AmountChip | null {
  const parsed = parseAmounts(draft);
  if (parsed === null || parsed.hst !== null || parsed.subtotal === null) {
    return null;
  }
  if (parsed.total !== null) {
    const remainder =
      parsed.total - parsed.subtotal - (parsed.tip ?? 0) - (parsed.otherFees ?? 0);
    if (remainder > 0) {
      const offer = finalizeDerivedAmount("hst", remainder);
      return offer === null
        ? null
        : { ...offer, kind: "hst-from-total", formula: "HST = total − subtotal − tip − other fees" };
    }
  }
  const suggested = suggestDefaultRateHst(parsed.subtotal);
  if (suggested === null) {
    return null;
  }
  const offer = finalizeDerivedAmount("hst", suggested.hstCents);
  return offer === null
    ? null
    : {
        ...offer,
        kind: "hst-at-default-rate",
        formula: `HST at ${DEFAULT_HST_RATE_BPS / 100}% of subtotal`,
      };
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
 * that were not part of the server's OCR merge at all: `otherFees` can go
 * amber from a derived-amount fill, and `category`/`paymentMethod` from a
 * vendor default. Two of those three have since gained a served suggestion
 * as well (2026-09-01: `otherFeesCents` and `paymentMethod` joined the
 * merge), so they now have two independent amber sources; `category` still
 * has only the vendor default, and the server still has no key for it.
 * `suggestedFields` below reads the server-sourced half of this set;
 * `ReceiptFieldsForm`'s `amber()` helper is what unions it with the
 * client-sourced half (`clientApplied` state).
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

const SUGGESTIBLE_FIELDS: ReadonlySet<keyof ReceiptDraft> = new Set<
  SuggestibleField
>([
  "vendor",
  "purchasedAt",
  "subtotal",
  "hst",
  "total",
  "tip",
  "otherFees",
  "category",
  "paymentMethod",
]);

function isSuggestibleField(
  key: keyof ReceiptDraft,
): key is SuggestibleField {
  return SUGGESTIBLE_FIELDS.has(key);
}

/**
 * §10A.1's amber rule, ported from iOS's confirm screen to this form:
 * "exactly the suggested fields start amber" - a field only marks if the
 * served merge actually served a value for it, and only on a pending
 * receipt (a confirmed one "renders the row, the human's values" per
 * `draftFromReceipt`'s own comment, and constraint 2's amber marks
 * *unconfirmed* suggestions, never a value a human already confirmed).
 *
 * 2026-09-01: a reviewed field never marks either, for the same reason a
 * confirmed receipt's fields do not - a human looked at it and wrote what
 * it says. This is the display half of the same rule `draftFromPending`
 * enforces on the value half, and it is likewise belt-and-braces: the
 * server stops SERVING a suggestion for a reviewed field, so the loop below
 * usually has nothing to remove.
 *
 * A WITHHELD amount marks nothing: `value` is null there, so it fails the
 * same test an absent suggestion does. That is the right answer rather than
 * a coincidence - amber means "a suggestion is sitting in this box,
 * unreviewed", and a withheld amount left the box empty on purpose. The
 * note is what explains it (`withheldAmountsNote`), not a tint.
 *
 * `paymentMethod` and `otherFees` mark only when the merge's value is what
 * the box actually holds - that is, when the row had none. `draftFromPending`
 * gives the row precedence for exactly these two fields, so testing the
 * suggestion alone would tint a value that came from the row and promise an
 * unreviewed OCR read for something a human typed.
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
  if (s.otherFeesCents?.value != null && receipt.otherFeesCents === null) {
    fields.add("otherFees");
  }
  if (s.paymentMethod?.value != null && receipt.paymentMethod === null) {
    fields.add("paymentMethod");
  }
  for (const reviewed of receipt.reviewedFields) {
    const key = DRAFT_KEY_BY_REVIEWED_FIELD[reviewed];
    if (isSuggestibleField(key)) {
      fields.delete(key);
    }
  }
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
 * The withheld-amounts note (2026-09-01): one secondary line explaining why
 * an amount box that would normally arrive prefilled is empty.
 *
 * The server withholds a total (and sometimes the subtotal with it) when
 * the set of amounts its parsers read is impossible - a total below the sum
 * of its own parts, which is a misread label rather than a receipt anyone
 * printed. It sends `withheld: true` and NOT the offending value, so this
 * form has nothing to show and, without a sentence, no way to say why: an
 * empty total on a receipt that plainly prints one reads as the app having
 * lost it. Naming the reason is what turns that into an instruction.
 *
 * Returns the whole sentence rather than a flag, so the wording and the
 * choice between "total", "subtotal" and both live in one testable place
 * instead of being assembled in JSX.
 *
 * Deliberately NOT amber, unlike every other note on this form: amber means
 * "an unreviewed suggestion is sitting in this box" (§10A.1), and the whole
 * point here is that nothing was suggested. A tint would promise a value
 * that is not there.
 *
 * Gated like the disagreement notes - pending only, and cleared per field
 * by touching it (§10A.1: "touching a field clears the tint and the note
 * together"). Once the total is typed from the paper, "the total was left
 * blank" is no longer true, and a note that outlived its own subject is
 * how a form teaches people to stop reading its notes. With both amounts
 * withheld and one of them typed, the sentence narrows to the other.
 *
 * There is no `reviewedFields` check to match `suggestedFields`' one: a
 * reviewed field has its suggestion suppressed BEFORE the arithmetic rule
 * runs (server: `suppressReviewed`, then `withholdImpossibleAmounts`), so
 * the value the rule would judge is already absent and it withholds
 * nothing. Reviewed and withheld cannot both be true of one field.
 */
export function withheldAmountsNote(
  receipt: Receipt,
  touched: ReadonlySet<keyof ReceiptDraft>,
): string | null {
  const s = receipt.suggestions;
  if (receipt.status !== "pending" || s === null) {
    return null;
  }
  const total = withheldAmount(s.totalCents) && !touched.has("total");
  const subtotal = withheldAmount(s.subtotalCents) && !touched.has("subtotal");
  if (!total && !subtotal) {
    return null;
  }
  const [fields, were, them] =
    total && subtotal
      ? ["the total and subtotal", "were", "them"]
      : [total ? "the total" : "the subtotal", "was", "it"];
  return `The amounts read from this receipt didn't add up, so ${fields} ${were} left blank - enter ${them} from the paper.`;
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
  onFieldReviewed,
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
   * Fired the moment a field becomes REVIEWED - the person typed in it, or
   * chose one of the amount chips below (2026-09-01). The screen that owns
   * Save/Confirm accumulates these and hands the set to
   * `reviewedFieldsForSave`, which is what the PATCH's `reviewedFields`
   * carries.
   *
   * Separate from `onFieldEdited` above even though typing fires both, and
   * deliberately so: `onFieldEdited` is telemetry and counts every
   * keystroke, while this one answers "has a human looked at this field",
   * which a chip answers too without being an edit. Folding them together
   * would either inflate `field_edited` counts with taps that are not
   * edits, or leave a chipped field unreviewed.
   */
  onFieldReviewed?: (field: keyof ReceiptDraft) => void;
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

  const markTouched = (key: keyof ReceiptDraft) =>
    setTouched((t) => (t.has(key) ? t : new Set(t).add(key)));

  /**
   * One component-amount edit, with the total-tracking rule applied
   * (2026-09-01, `applyComponentEdit`). Shared by typing and by an amount
   * chip, so the two cannot drift.
   *
   * When the rule rewrites the total, the total is marked touched: the
   * number in that box is no longer the parser's suggestion, so leaving it
   * amber would claim an unreviewed OCR read for a value this form
   * computed. Marked touched but NOT reported through `onFieldReviewed` -
   * nobody has looked at the total, it just followed - so it stays out of
   * the reviewed set the save sends.
   */
  const editComponentAmount = (key: ComponentAmountField, value: string) => {
    if (applyComponentEdit(draft, key, value).total !== draft.total) {
      markTouched("total");
    }
    setDraft((d) => applyComponentEdit(d, key, value));
  };

  const text =
    (key: keyof ReceiptDraft) =>
    (event: { target: { value: string } }) => {
      const value = event.target.value;
      markTouched(key);
      onFieldEdited?.(key);
      onFieldReviewed?.(key);
      if (isComponentAmountField(key)) {
        editComponentAmount(key, value);
        return;
      }
      setDraft((d) => ({ ...d, [key]: value }));
    };

  const mismatch = arithmeticMismatch(draft);
  // 2026-09-01: the sharper half of the same inequality, rendered instead
  // of the generic note rather than beside it - "the total is less than
  // its parts" is strictly more specific than "these do not add up", and
  // two warnings about one arithmetic fact is how a form teaches people to
  // stop reading its warnings.
  const belowFloor = amountFloorNote(draft);
  // §10A.1's disagreement notes live here, not in the two screens that
  // embed this form, so they get the arithmetic warning's exact treatment
  // ("inside the field") wherever a pending receipt's fields render -
  // confirm queue and a pending receipt opened straight from the table.
  const dateDisagreement = dateDisagreementNote(receipt, touched);
  const hstDisagreement = hstDisagreementNote(receipt, touched);
  const hstRateHint = hstRateHintNote(receipt, draft, touched);
  // The one note on this form that is not amber - see its own comment.
  const withheldNote = withheldAmountsNote(receipt, touched);

  // Proposal #1: at most one of these is ever non-null for a given draft -
  // `deriveMissingAmount` requires exactly one field blank,
  // `reconciliationSuggestions` requires none blank - so there is no need
  // to reconcile the two ever both having something to say about the same
  // field.
  const derived = deriveMissingAmount(draft);
  const reconciliation = derived === null ? reconciliationSuggestions(draft) : null;
  // Proposal #1's HST fill and the 2026-09-01 chip answer the same
  // question - what goes in the blank HST box - and the chip is the
  // better-worded of the two (it names the default-rate case the fill
  // cannot reach at all). Where both apply, the chip wins and the fill is
  // suppressed for HST alone; every other field's fill is untouched.
  const hstChip = hstSuggestionChip(draft);

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

  /**
   * An amount chip (2026-09-01), which differs from the fill above in two
   * deliberate ways.
   *
   * It marks the field TOUCHED and reports it reviewed. A fill offers the
   * one value the other four boxes determine, and proposal #1's own risk
   * mitigation is that it lands amber and stays amber until a person looks
   * at it. A chip states a rule and its result - "HST at 13% of subtotal =
   * $1.65" - and the person picked it over typing anything else; that
   * choice is the looking. Leaving it amber would mean the tint no longer
   * distinguishes "nobody has read this" from "somebody chose this".
   *
   * It routes through `editComponentAmount`, so applying it moves the
   * total the same way typing the number would - the chip's own doc
   * comment above is the whole reason that is safe.
   *
   * It still reports through `onSuggestionApplied`, so the save-time
   * accepted/overridden summary scores it beside every other suggestion
   * source (2026-08-28's ruling, unchanged).
   */
  function applyAmountChip(chip: AmountChip) {
    const key = chip.field;
    if (!isComponentAmountField(key)) {
      // Only component amounts have chips today; the type keeps this
      // honest rather than assuming.
      return;
    }
    markTouched(key);
    onFieldReviewed?.(key);
    editComponentAmount(key, formatCents(chip.cents));
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
      {belowFloor ? (
        <p className="warning">
          Total is less than subtotal + HST + tip + fees - the paid amount
          cannot be smaller than the charges that make it up, so one of
          these numbers is wrong.
        </p>
      ) : (
        mismatch && (
          <p className="warning">
            Subtotal + HST + tip + other fees doesn't add up to total - worth a
            look, not a blocker.
          </p>
        )
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
      <AmountChipNote chip={hstChip} onApply={applyAmountChip} />
      <AmountDeriveNote
        offer={derived?.field === "hst" && hstChip === null ? derived : null}
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
      {/* Under the amounts block rather than beside the total: it can be
          about the total, the subtotal or both, and one line under the five
          boxes says that without a note appearing twice. `.muted`, not
          `.warning` - the one deliberately non-amber note on this form. */}
      {withheldNote !== null && <p className="muted withheld-note">{withheldNote}</p>}
      {/* Free text with the person's own past values offered: a suggestion
          list, never a closed set. Category's only amber source is
          proposal #2's vendor default - a client-applied suggestion the OCR
          merge still has no key for. Payment method below has both that and
          a served suggestion as of 2026-09-01, and `draftFromPending` is
          where the precedence between them is settled. */}
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
 * An amount chip (2026-09-01): the same amber family and the same
 * "state the arithmetic, never just a button" rule as `AmountDeriveNote`
 * above, with a verb on the control that says what taking it does. One
 * chip at a time by construction (`hstSuggestionChip` returns at most
 * one) - a row of competing numbers this form invented would make the
 * person adjudicate between them instead of reading the receipt.
 */
function AmountChipNote({
  chip,
  onApply,
}: {
  chip: AmountChip | null;
  onApply: (chip: AmountChip) => void;
}) {
  if (chip === null) {
    return null;
  }
  return (
    <p className="warning derive-note">
      {chip.formula} = {formatCents(chip.cents)}
      <button type="button" className="link" onClick={() => onApply(chip)}>
        Use this
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
