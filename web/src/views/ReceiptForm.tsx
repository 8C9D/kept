import { formatCents, parseMoneyInput } from "../money.js";
import {
  CATEGORY_LIST_ID,
  PAYMENT_LIST_ID,
  ReceiptOptionsDatalists,
} from "../options.js";
import type { Receipt, ReceiptOptions, ReceiptPatch } from "../types.js";

/**
 * The one field grid both the detail view and the confirm queue render.
 *
 * Draft values are strings - what is in the boxes - and become a patch
 * only on submit, with money parsed by the integer-only parser. The patch
 * carries exactly the fields that differ from the receipt row, because
 * PATCH means "change these", and a no-op submit sends nothing.
 */
export interface ReceiptDraft {
  purchasedAt: string;
  vendor: string;
  subtotal: string;
  hst: string;
  total: string;
  category: string;
  paymentMethod: string;
  notes: string;
}

export function draftFromReceipt(receipt: Receipt): ReceiptDraft {
  return {
    purchasedAt: receipt.purchasedAt,
    vendor: receipt.vendor ?? "",
    subtotal: formatCents(receipt.subtotalCents),
    hst: formatCents(receipt.hstCents),
    total: formatCents(receipt.totalCents),
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
  };
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
  key: "subtotalCents" | "hstCents" | "totalCents",
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

export function ReceiptFieldsForm({
  draft,
  setDraft,
  options,
  disabled,
}: {
  draft: ReceiptDraft;
  setDraft: (update: (draft: ReceiptDraft) => ReceiptDraft) => void;
  /** Past values offered under Category and Payment method. */
  options: ReceiptOptions;
  disabled?: boolean;
}) {
  const text =
    (key: keyof ReceiptDraft) =>
    (event: { target: { value: string } }) =>
      setDraft((d) => ({ ...d, [key]: event.target.value }));

  return (
    <div className="field-grid">
      <label>
        Purchase date
        <input
          type="date"
          value={draft.purchasedAt}
          onChange={text("purchasedAt")}
          disabled={disabled}
        />
      </label>
      <label>
        Vendor
        <input value={draft.vendor} onChange={text("vendor")} disabled={disabled} />
      </label>
      <label>
        Subtotal
        <input
          className="money"
          value={draft.subtotal}
          onChange={text("subtotal")}
          disabled={disabled}
          placeholder="0.00"
        />
      </label>
      <label>
        HST
        <input
          className="money"
          value={draft.hst}
          onChange={text("hst")}
          disabled={disabled}
          placeholder="0.00"
        />
      </label>
      <label>
        Total
        <input
          className="money"
          value={draft.total}
          onChange={text("total")}
          disabled={disabled}
          placeholder="0.00"
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
