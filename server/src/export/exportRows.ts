import type { Cents } from "../domain/money.js";

/**
 * One row of the export files. The spec fixes the columns and their order
 * (§8); all three writers below must emit exactly this, so the order lives
 * here once, beside the row shape.
 */
export interface ExportRow {
  receiptId: string;
  date: string; // ISO yyyy-mm-dd
  vendor: string | null;
  subtotalCents: Cents | null;
  hstCents: Cents | null;
  // Gratuity and every other non-HST, non-subtotal charge (2026-08-28); see
  // the receipts table for what each carries. Nullable like every other
  // money field here.
  tipCents: Cents | null;
  otherFeesCents: Cents | null;
  totalCents: Cents;
  currency: string;
  category: string | null;
  paymentMethod: string | null;
  whose: string | null;
  imageFilename: string; // path inside the zip, e.g. images/2026/01/x.jpg
  notes: string | null;
}

/**
 * Spec §8, verbatim and in order. `tip` and `other_fees` sit between `hst`
 * and `total` so the row reads left to right in the order the arithmetic
 * check sums them (subtotal + hst + tip + other_fees = total).
 */
export const EXPORT_COLUMN_HEADERS = [
  "receipt_id",
  "date",
  "vendor",
  "subtotal",
  "hst",
  "tip",
  "other_fees",
  "total",
  "currency",
  "category",
  "payment_method",
  "whose",
  "image_filename",
  "notes",
] as const;
