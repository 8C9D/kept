import { z } from "zod";
import { InvalidDateError, parseIsoDate } from "./calendarDate.js";
import { MAX_STORABLE_CENTS, MIN_STORABLE_CENTS } from "./money.js";
import type { OcrFieldSuggestions } from "./ocrSuggestions.js";

/**
 * What a language model suggested for one receipt, parsed from the stored
 * `ocr_raw_text` server-side (ruled Aug 7, 2026). Stored verbatim on the
 * receipt and never updated, exactly like `ocr_suggestions`: the pair of
 * immutable records against the human-confirmed fields is what lets
 * `npm run parse-accuracy` score the two paths separately.
 *
 * The model only ever sees `ocr_raw_text` - never a field a person typed.
 * That is a ruling, not an implementation detail; the request builder in
 * src/parse enforces it and a test asserts it.
 */
export interface LlmSuggestionRecord {
  /** Exact model id the suggestions came from, for accuracy attribution. */
  model: string;
  /** ISO timestamp of the parse request. */
  requestedAt: string;
  suggestions: OcrFieldSuggestions;
}

/**
 * The JSON schema sent with the API request (structured outputs), so the
 * model's reply is guaranteed to be exactly this shape. Every field is
 * required and nullable: null is the stated "not printed on this receipt",
 * and an absent key would be indistinguishable from a forgotten one.
 */
export const RECEIPT_PARSE_JSON_SCHEMA = {
  type: "object",
  properties: {
    vendor: { type: ["string", "null"] },
    purchasedAt: {
      type: ["string", "null"],
      description: "yyyy-mm-dd",
    },
    totalCents: { type: ["integer", "null"] },
    hstCents: { type: ["integer", "null"] },
    subtotalCents: { type: ["integer", "null"] },
    vendorTaxNumber: { type: ["string", "null"] },
  },
  required: [
    "vendor",
    "purchasedAt",
    "totalCents",
    "hstCents",
    "subtotalCents",
    "vendorTaxNumber",
  ],
  additionalProperties: false,
} as const;

/**
 * Domain rules for the extraction, stated as facts about Canadian receipts
 * rather than step-by-step heuristics - the model's judgment over the text
 * is the whole point (the on-device heuristics already do rule-following).
 *
 * The rules encode the wave-5 and Food Basics lessons: HST/GST are one CRA
 * program; multiple date representations must be cross-checked; tax numbers
 * may carry a letter prefix; wordmarks split across lines.
 */
export const RECEIPT_PARSE_SYSTEM_PROMPT = `You extract fields from the OCR text of a Canadian retail receipt.

Rules:
- Return null for anything not printed on the receipt. Never guess or fabricate a value.
- All money amounts are integer cents: $45.54 is 4554.
- totalCents is the final amount paid, hstCents is the HST or GST amount, subtotalCents is the pre-tax subtotal.
- HST and GST are the same federal program. If both are printed, the non-zero amount charged is the tax; an explicit $0.00 beside a charged sibling line is not.
- purchasedAt is the purchase date as yyyy-mm-dd. Receipts often print a date more than once in different formats; cross-check them against each other (a printed time can disambiguate), and prefer an unambiguous representation over an ambiguous one. A purchase date is in the recent past, never in the future.
- vendor is the store's name as a customer would say it. A logo or wordmark is often split across adjacent lines; join them.
- vendorTaxNumber is the supplier's GST/HST registration number, exactly as printed including any letter prefix or suffix (for example R105216170 or 123456789RT0001). Card numbers, phone numbers, and transaction references are not tax numbers.
- The text comes from OCR of a photograph: words may be split mid-word, columns may be misaligned, and characters may be misread. Read through such noise, but do not invent what is not there.`;

const parsedCents = z
  .number()
  .int()
  .min(MIN_STORABLE_CENTS)
  .max(MAX_STORABLE_CENTS)
  .nullable();

const parsedDate = z
  .string()
  .refine(
    (value) => {
      try {
        parseIsoDate(value);
        return true;
      } catch (error) {
        if (error instanceof InvalidDateError) {
          return false;
        }
        throw error;
      }
    },
    { error: "must be a valid yyyy-mm-dd date" },
  )
  .nullable();

/**
 * What the model actually returned, validated before anything stores it.
 * Structured outputs guarantee the shape at the API layer, but the values
 * still cross a trust boundary: a date that is not a real calendar date or
 * an amount outside the storable range is refused loudly here, never
 * written and never quietly corrected.
 */
export const llmParseResponseSchema = z.strictObject({
  vendor: z.string().min(1).max(200).nullable(),
  purchasedAt: parsedDate,
  totalCents: parsedCents,
  hstCents: parsedCents,
  subtotalCents: parsedCents,
  vendorTaxNumber: z.string().min(1).max(50).nullable(),
});

export function validateLlmParseResponse(value: unknown): OcrFieldSuggestions {
  return llmParseResponseSchema.parse(value);
}
