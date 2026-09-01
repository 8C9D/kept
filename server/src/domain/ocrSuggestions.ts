/**
 * What the on-device parser suggested for one receipt, exactly as the
 * client reported it at create time. Every field is nullable because every
 * heuristic can come up empty; null means "the parser found nothing", which
 * is a real result, not missing data.
 *
 * Stored verbatim on the receipt and never updated. The human then edits
 * or accepts each field on the confirm screen, and the difference between
 * this record and the confirmed values is the parser's measured accuracy
 * (spec §7.3: "decide this with data, not taste").
 */
export interface OcrFieldSuggestions {
  vendor: string | null;
  /** yyyy-mm-dd */
  purchasedAt: string | null;
  totalCents: number | null;
  hstCents: number | null;
  subtotalCents: number | null;
  /**
   * Gratuity (2026-08-28). An amount like every other money field here, so
   * it follows the same heuristic-only merge rule (mergedSuggestions.ts) -
   * no exception for tip just because it arrived later.
   */
  tipCents: number | null;
  /**
   * Every charge that is neither subtotal, tax nor tip - a service charge,
   * a credit-card surcharge, delivery, an eco fee, a bottle deposit, cash
   * rounding (2026-09-01, prompt v5).
   *
   * This field was deliberately absent until today, on the reasoning that
   * the category has no consistent printed label for a heuristic to
   * pattern-match. That reasoning was about the HEURISTIC, and it still
   * holds: the on-device parser reports null here and always will. What
   * changed is the evidence - over 136 real production receipts the fees
   * nobody extracts are printed in plain words ("12% Service charge $5.99",
   * "Credit card 2.4% surcharge", "Rounding 0.02", "Eco fee") and reading
   * words rather than matching labels is exactly what the model is for. So
   * the LLM is asked for it, the value is stored and scored, and the merge
   * serves it under the same money rules as every other amount.
   */
  otherFeesCents: number | null;
  /**
   * The payment method as printed on the slip - MASTERCARD, VISA, INTERAC,
   * DEBIT, AMEX, CASH (2026-09-01, prompt v5).
   *
   * Diagnosis over the same 136 receipts: ~80% print one and it is stored on
   * 0 of 130. Free text like `category` (root CLAUDE.md: never an enum), so
   * "the brand as printed" is the whole rule and no taxonomy grows here.
   * The on-device heuristic reports null - it has no payment-method rule -
   * which makes this an LLM-preferred field like `vendor`.
   */
  paymentMethod: string | null;
  vendorTaxNumber: string | null;
}

/**
 * Where a receipt's `ocr_raw_text` came from (2026-09-01).
 *
 * - `vision` - on-device OCR of a photograph. Every receipt captured before
 *   this column existed is one of these, which is why the column is nullable
 *   and null reads as vision-era rather than as "unknown".
 * - `pdf-text` - a PDF's own text layer, extracted rather than recognised.
 *   No camera, no character recognition, and so none of the failure modes
 *   the OCR rules were written against: see `mergedSuggestions.ts` for the
 *   one merge rule this distinction changes, and why it changes only there.
 */
export const OCR_SOURCES = ["vision", "pdf-text"] as const;

export type OcrSource = (typeof OCR_SOURCES)[number];

export const OCR_SUGGESTION_FIELDS = [
  "vendor",
  "purchasedAt",
  "totalCents",
  "hstCents",
  "subtotalCents",
  "tipCents",
  "otherFeesCents",
  "paymentMethod",
  "vendorTaxNumber",
] as const satisfies readonly (keyof OcrFieldSuggestions)[];
