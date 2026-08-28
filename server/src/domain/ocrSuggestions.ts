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
   *
   * `other_fees` gets no suggestion field, deliberately: it is a residual
   * category with no consistent printed label ("delivery fee", "service
   * charge", "bottle deposit", a foreign tax line all land there), so there
   * is nothing for a heuristic to pattern-match and nothing an accuracy
   * measurement could score against.
   */
  tipCents: number | null;
  vendorTaxNumber: string | null;
}

export const OCR_SUGGESTION_FIELDS = [
  "vendor",
  "purchasedAt",
  "totalCents",
  "hstCents",
  "subtotalCents",
  "tipCents",
  "vendorTaxNumber",
] as const satisfies readonly (keyof OcrFieldSuggestions)[];
