import { useState } from "react";
import { formatCents, parseMoneyInput } from "../money.js";
import type { Receipt, ReceiptPatch } from "../types.js";

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
  vendorTaxNumber: string;
  subtotal: string;
  hst: string;
  otherTax: string;
  total: string;
  category: string;
  paymentMethod: string;
  isBusiness: boolean | null;
  notes: string;
}

export function draftFromReceipt(receipt: Receipt): ReceiptDraft {
  return {
    purchasedAt: receipt.purchasedAt,
    vendor: receipt.vendor ?? "",
    vendorTaxNumber: receipt.vendorTaxNumber ?? "",
    subtotal: formatCents(receipt.subtotalCents),
    hst: formatCents(receipt.hstCents),
    otherTax: formatCents(receipt.otherTaxCents),
    total: formatCents(receipt.totalCents),
    category: receipt.category ?? "",
    paymentMethod: receipt.paymentMethod ?? "",
    isBusiness: receipt.isBusiness,
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
    vendorTaxNumber: s?.vendorTaxNumber.value ?? receipt.vendorTaxNumber ?? "",
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
  assignText(
    patch,
    "vendorTaxNumber",
    draft.vendorTaxNumber,
    receipt.vendorTaxNumber,
  );
  assignText(patch, "category", draft.category, receipt.category);
  assignText(patch, "paymentMethod", draft.paymentMethod, receipt.paymentMethod);
  assignText(patch, "notes", draft.notes, receipt.notes);
  assignMoney(patch, "subtotalCents", "subtotal", draft.subtotal, receipt.subtotalCents);
  assignMoney(patch, "hstCents", "HST", draft.hst, receipt.hstCents);
  assignMoney(patch, "otherTaxCents", "other tax", draft.otherTax, receipt.otherTaxCents);
  assignMoney(patch, "totalCents", "total", draft.total, receipt.totalCents);
  if (draft.isBusiness !== receipt.isBusiness && draft.isBusiness !== null) {
    patch.isBusiness = draft.isBusiness;
  }
  return patch;
}

function assignText(
  patch: ReceiptPatch,
  key: "vendor" | "vendorTaxNumber" | "category" | "paymentMethod" | "notes",
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
  key: "subtotalCents" | "hstCents" | "otherTaxCents" | "totalCents",
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
  disabled,
}: {
  draft: ReceiptDraft;
  setDraft: (update: (draft: ReceiptDraft) => ReceiptDraft) => void;
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
        GST/HST number
        <input
          value={draft.vendorTaxNumber}
          onChange={text("vendorTaxNumber")}
          disabled={disabled}
          placeholder="123456789RT0001"
        />
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
        Other tax
        <input
          className="money"
          value={draft.otherTax}
          onChange={text("otherTax")}
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
      <label>
        Category
        <input
          value={draft.category}
          onChange={text("category")}
          disabled={disabled}
          placeholder="free text"
        />
      </label>
      <label>
        Payment method
        <input
          value={draft.paymentMethod}
          onChange={text("paymentMethod")}
          disabled={disabled}
        />
      </label>
      <fieldset className="business-choice">
        <legend>Business or personal</legend>
        {/* No default (spec §5.2): both unchecked until a person chooses. */}
        <label>
          <input
            type="radio"
            name="isBusiness"
            checked={draft.isBusiness === true}
            onChange={() => setDraft((d) => ({ ...d, isBusiness: true }))}
            disabled={disabled}
          />
          Business
        </label>
        <label>
          <input
            type="radio"
            name="isBusiness"
            checked={draft.isBusiness === false}
            onChange={() => setDraft((d) => ({ ...d, isBusiness: false }))}
            disabled={disabled}
          />
          Personal
        </label>
      </fieldset>
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
