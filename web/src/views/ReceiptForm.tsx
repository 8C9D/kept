import { useEffect, useState } from "react";
import { logEvent } from "../events.js";
import { formatCents, parseMoneyInput } from "../money.js";
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
 * The draft fields a served suggestion can mark amber - every key
 * `MergedSuggestions` carries. `otherFees` has no entry in
 * `MergedSuggestions` (see `draftFromPending` above) and so can never
 * appear here: the styling below reads this set rather than naming fields,
 * which is what keeps "other fees never starts marked" true by
 * construction instead of by a special case someone could forget to keep
 * in sync.
 */
type SuggestibleField = "vendor" | "purchasedAt" | "subtotal" | "hst" | "total" | "tip";

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
 * `suggestionOutcomes` reuses `suggestedFields` - the exact set already
 * driving the amber tint - and calls a field "accepted" when it was never
 * edited and "overridden" when it was, at least once. Not a value
 * comparison: re-typing the exact suggested value still counts as an
 * override, the same "touching clears it permanently" rule the amber tint
 * itself follows (§10A.1), rather than a second, looser definition of
 * "changed" that could disagree with what the person saw on screen.
 */
export function summarizeFieldEdits(
  receipt: Receipt,
  edits: readonly (keyof ReceiptDraft)[],
): {
  fieldEditCounts: { field: keyof ReceiptDraft; count: number }[];
  suggestionOutcomes: { field: SuggestibleField; accepted: boolean }[];
} {
  const counts = new Map<keyof ReceiptDraft, number>();
  for (const field of edits) {
    counts.set(field, (counts.get(field) ?? 0) + 1);
  }
  const edited = new Set(edits);
  return {
    fieldEditCounts: [...counts].map(([field, count]) => ({ field, count })),
    suggestionOutcomes: [...suggestedFields(receipt)].map((field) => ({
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
): void {
  const { fieldEditCounts, suggestionOutcomes } = summarizeFieldEdits(receipt, edits);
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

export function ReceiptFieldsForm({
  receipt,
  draft,
  setDraft,
  options,
  disabled,
  onFieldEdited,
}: {
  /** For its id (to reset "touched" on a new receipt), status and
   * suggestions - which fields start amber reads off this, not the draft. */
  receipt: Receipt;
  draft: ReceiptDraft;
  setDraft: (update: (draft: ReceiptDraft) => ReceiptDraft) => void;
  /** Past values offered under Vendor, Category and Payment method. */
  options: ReceiptOptions;
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
  useEffect(() => {
    setTouched(new Set());
  }, [receipt.id]);

  const suggested = suggestedFields(receipt);
  const amber = (field: SuggestibleField): string | undefined =>
    suggested.has(field) && !touched.has(field) ? "suggested" : undefined;

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
      {/* No suggestion exists for this field (see `draftFromPending`), so
          it never starts amber - nothing to opt it out of, it is just not
          in `suggested`. */}
      <label>
        Other fees
        <input
          className="money"
          value={draft.otherFees}
          onChange={text("otherFees")}
          disabled={disabled}
          placeholder="Not found"
        />
      </label>
      {/* Free text with the person's own past values offered: a suggestion
          list, never a closed set. */}
      <label>
        Category
        <input
          value={draft.category}
          onChange={text("category")}
          disabled={disabled}
          placeholder="free text"
          list={CATEGORY_LIST_ID}
        />
      </label>
      <label>
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
