/**
 * The three receipt fields whose past values are offered back for reuse
 * (`GET /api/receipts/options`), and the vocabulary the
 * `receipt_field_options` table's `field` column is checked against.
 *
 * These are the STORED names - snake_case, matching the receipt columns they
 * came from - deliberately, because that is what the check constraint in the
 * database reads and what a person looking at a row in psql sees beside the
 * column it mirrors. The API spells the same three in the camelCase the rest
 * of the wire uses (`vendor | category | paymentMethod`); the routing layer
 * owns that translation (`routes/receipts.ts`), so the two vocabularies stay
 * one lookup apart rather than two independent lists that can drift.
 *
 * Why the values live in their own table at all (2026-09-01), rather than
 * being re-derived from `receipts` the way they were until now:
 *
 * - The derivation could only ever offer what still existed. Deleting the
 *   one receipt that carried "office supplies" silently deleted the option
 *   too, and there was no way to remove an option without deleting a
 *   retained tax record to do it. The table separates "a value I want
 *   offered" from "a receipt I have", which is what makes an explicit
 *   `DELETE /api/receipts/options/:field` possible at all.
 * - It also makes renaming one. A typo'd vendor was previously fixable only
 *   by opening every receipt that carried it; now one PATCH rewrites the
 *   receipts and the option together, in one transaction.
 */
export const RECEIPT_OPTION_FIELDS = [
  "vendor",
  "category",
  "payment_method",
] as const;

export type ReceiptOptionField = (typeof RECEIPT_OPTION_FIELDS)[number];
