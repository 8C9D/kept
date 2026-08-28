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
export interface LlmParseSuccessRecord {
  /** Exact model id the suggestions came from, for accuracy attribution. */
  model: string;
  /**
   * Which RECEIPT_PARSE_PROMPT_VERSION produced the suggestions. Absent on
   * records written before the stamp existed - those are version 1, the
   * pre-verbatim-vendor prompt from the first backfill (Aug 7, 2026).
   */
  promptVersion?: number;
  /** ISO timestamp of the parse request. */
  requestedAt: string;
  suggestions: OcrFieldSuggestions;
}

/**
 * Written by the sweep when a receipt's parse has failed MAX_PARSE_ATTEMPTS
 * times (Aug 8, 2026): the null column would otherwise re-select - and
 * re-bill - the row on every sweep, forever, and the failure would live
 * only in a log. `suggestions: null` states "the LLM produced nothing",
 * which parse-accuracy scores as exactly that - distinct from a row the
 * LLM was never run on, which carries no record at all. Re-parsing an
 * abandoned row means clearing the column by hand: a deliberate act, like
 * everything else that writes here twice.
 */
export interface LlmParseFailureRecord {
  model: string;
  promptVersion: number;
  /** ISO timestamp of the final attempt. */
  requestedAt: string;
  /** Why the final attempt failed. */
  error: string;
  attempts: number;
  suggestions: null;
}

export type LlmSuggestionRecord = LlmParseSuccessRecord | LlmParseFailureRecord;

export function isLlmParseFailure(
  record: LlmSuggestionRecord,
): record is LlmParseFailureRecord {
  return record.suggestions === null;
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
    vendor: {
      type: ["string", "null"],
      description:
        "The business name as printed. Include suffixes, parentheses, and " +
        "abbreviations that are part of the name; exclude branch or store " +
        "numbers, addresses, and phone numbers. Do not normalize, expand, " +
        "translate, or tidy it. A logo or wordmark is often split across " +
        "adjacent lines; join them.",
    },
    purchasedAt: {
      type: ["string", "null"],
      description: "yyyy-mm-dd",
    },
    totalCents: { type: ["integer", "null"] },
    hstCents: { type: ["integer", "null"] },
    subtotalCents: { type: ["integer", "null"] },
    // Gratuity (prompt v4, 2026-08-28 - The owner asked for a second amount the
    // heuristic already suggests, so the model gets asked for it too). Like
    // every other amount here it is stored and scored but never served - the
    // merge stays heuristic-only for money (mergedSuggestions.ts) - so this
    // field exists for parse-accuracy, not for the confirm screen.
    tipCents: { type: ["integer", "null"] },
  },
  required: [
    "vendor",
    "purchasedAt",
    "totalCents",
    "hstCents",
    "subtotalCents",
    "tipCents",
  ],
  additionalProperties: false,
} as const;

/**
 * Bumped whenever the request's meaning changes - the system prompt or the
 * schema field descriptions - so stored llm_suggestions records stay
 * attributable to the prompt generation that produced them and
 * parse-accuracy can keep the generations apart.
 * Version 1 (implicit - records without a promptVersion field) lacked the
 * verbatim-vendor rule; version 2 added it after the first accuracy run
 * showed the model tidying "Noodle House (BCE)" down to "Noodle House". The
 * rule lives in the vendor field's schema description, not the shared
 * system prompt: a first draft that put it in the system prompt coincided
 * with a date regression, consistent with a verbatim instruction reaching a
 * field that must interpret rather than transcribe.
 * Version 3 stopped asking for the supplier's tax number at all
 * (2026-08-26): the field is gone from the receipt, so the request asks for
 * one fewer thing and its answers are not comparable with version 2's.
 * Version 4 (2026-08-28, first-use product feedback) does two things at
 * once: the system prompt gains the split-HST rule (component tax lines at
 * different rates - 5% + 8% = 13% in Ontario - must be summed, unless a
 * printed line already totals them), and the schema starts asking for
 * tipCents, which prompts 1-3 never requested. A v3 record's hstCents was
 * never asked to sum anything, so a receipt whose HST prints as two
 * components would have scored a plausible-looking single-component read as
 * a "match" under the old prompt; v3 and v4 hstCents are not the same
 * question and are not comparable in parse-accuracy. tipCents is absent on
 * every v1-v3 record for a stronger reason than "not yet run" - those
 * prompts never asked for it, so there is nothing to backfill.
 */
export const RECEIPT_PARSE_PROMPT_VERSION = 4;

/**
 * Domain rules for the extraction, stated as facts about Canadian receipts
 * rather than step-by-step heuristics - the model's judgment over the text
 * is the whole point (the on-device heuristics already do rule-following).
 *
 * The rules encode the wave-5 and Food Basics lessons: HST/GST are one CRA
 * program, and multiple date representations must be cross-checked. Vendor
 * guidance lives in the schema's vendor field description, scoped to that
 * field alone - see the prompt-version comment above for why: it is a
 * transcription instruction for the one field that transcribes, and a first
 * draft that generalized it into the shared prompt made the model tidy the
 * very thing it was meant to preserve. The split-HST rule below is the other
 * kind - a fact about how Canadian receipts print tax, not an instruction
 * scoped to reading one field literally - so it sits with the other domain
 * facts here, immediately beside the GST-zero rule it must stay compatible
 * with (2026-08-28, prompt v4).
 */
export const RECEIPT_PARSE_SYSTEM_PROMPT = `You extract fields from the OCR text of a Canadian retail receipt.

Rules:
- Return null for anything not printed on the receipt. Never guess or fabricate a value.
- All money amounts are integer cents: $45.54 is 4554.
- totalCents is the final amount paid, hstCents is the HST or GST amount, subtotalCents is the pre-tax subtotal, tipCents is the gratuity if one is printed.
- HST and GST are the same federal program. If both are printed, the non-zero amount charged is the tax; an explicit $0.00 beside a charged sibling line is not.
- HST is sometimes printed as two or more component lines at different rates that together make up the province's combined rate - 5% + 8% = 13% is the common Ontario case - and when that happens, hstCents is their sum, not any single component. But some receipts print both the component lines and a separate line that already totals them for the same tax: when a printed line's amount already equals the sum of the component lines beneath it, that printed line is hstCents, and the components must not be added to it again - summing every tax-labelled line you see double-counts. A component printed as $0.00 still contributes nothing to the sum either way, so this rule and the GST-zero rule above never conflict.
- purchasedAt is the purchase date as yyyy-mm-dd. Receipts often print a date more than once in different formats; cross-check them against each other (a printed time can disambiguate), and prefer an unambiguous representation over an ambiguous one. A purchase date is in the recent past, never in the future.
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
  // Gratuity (prompt v4, 2026-08-28): asked for like any other amount, and
  // validated the same way. Stored and scored, never served - the merge
  // stays heuristic-only for money (mergedSuggestions.ts) - but that is a
  // fact about mergeSuggestions, not about what this path returns, so it is
  // no longer stamped here as a placeholder.
  tipCents: parsedCents,
});

export function validateLlmParseResponse(value: unknown): OcrFieldSuggestions {
  return {
    ...llmParseResponseSchema.parse(value),
    // The stored record carries every suggestion field, so a later reader
    // never has to tell "key absent" from "parser found nothing". Since
    // version 3 of the prompt this path is not asked for a tax number, so
    // null is the literal truth about what it produced - not a default
    // standing in for an answer. tipCents needs no equivalent stamp any
    // more (contrast the previous pass, which stamped it null here because
    // v3 never asked): the spread above already carries the model's actual
    // answer now that v4's schema requests one.
    vendorTaxNumber: null,
  };
}
