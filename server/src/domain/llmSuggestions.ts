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
        "two or more adjacent lines and set in different cases - a " +
        "lower-case word directly above a capitalised one is part of the " +
        "same name, not a category heading followed by a name. Join those " +
        "lines.",
    },
    purchasedAt: {
      type: ["string", "null"],
      description: "yyyy-mm-dd",
    },
    totalCents: { type: ["integer", "null"] },
    hstCents: { type: ["integer", "null"] },
    subtotalCents: { type: ["integer", "null"] },
    // Gratuity (prompt v4, 2026-08-28 - The owner asked for a second amount the
    // heuristic already suggests, so the model gets asked for it too).
    tipCents: { type: ["integer", "null"] },
    // Prompt v5 (2026-09-01). Both fields exist because the diagnosis over
    // 136 real production receipts found them printed and unextracted: fee
    // and surcharge lines nobody was asked for, and a payment method on
    // ~80% of slips stored on 0 of 130 receipts.
    otherFeesCents: {
      type: ["integer", "null"],
      description:
        "The total of every charge that is neither subtotal, tax nor tip: " +
        "a service charge, a credit-card surcharge, a delivery fee, an eco " +
        "fee, a bottle deposit, cash rounding. Null if the receipt prints " +
        "no such line.",
    },
    paymentMethod: {
      type: ["string", "null"],
      description:
        "The payment method as printed, short: VISA, MASTERCARD, AMEX, " +
        "DEBIT, INTERAC, CASH, or the printed brand; null if not printed.",
    },
  },
  required: [
    "vendor",
    "purchasedAt",
    "totalCents",
    "hstCents",
    "subtotalCents",
    "tipCents",
    "otherFeesCents",
    "paymentMethod",
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
 * Version 5 (2026-09-01) is the largest rewrite since version 1, and it
 * follows a diagnosis over 136 real production receipts rather than a field
 * report. Four things change the request's meaning at once:
 *   1. The user message gains a first line, `Captured on: yyyy-mm-dd`. v1-v4
 *      sent the OCR text and nothing else, so the model had no upper bound
 *      on the purchase date and no way to break a tie between two readings
 *      of the same ambiguous token. MUJI's `09/05/2026` was read as
 *      September 5 - after the day the photo was taken - and nothing in the
 *      request could have told the model otherwise.
 *   2. The date rules name what the diagnosis actually found: `26/07/19` on
 *      a Canadian card slip is yy/mm/dd (both parsers agreed on 2019-07-26
 *      on 12 receipts, so the disagreement flag never fired), and
 *      sweepstakes deadlines, `expires`, `TIMED ORDER` and warranty dates
 *      are decoys.
 *   3. The total and tax rules name the label traps: a $218.94 Costco
 *      purchase stored as the $8.50 on its "TOTAL DISCOUNT(S)" line, a card
 *      slip's TIP line entered as HST, and the two dozen tax and subtotal
 *      label spellings the heuristic misses.
 *   4. The schema asks for `otherFeesCents` and `paymentMethod`, which no
 *      earlier prompt requested.
 * A v4 record's `purchasedAt`, `totalCents` and `hstCents` are therefore not
 * answers to the same question v5 asks, and the two generations are not
 * comparable on those fields in parse-accuracy - the same argument v4 made
 * about v3's `hstCents`. `otherFeesCents` and `paymentMethod` are absent on
 * every v1-v4 record for the stronger reason `tipCents` was absent on v1-v3:
 * those prompts never asked, so there is nothing to backfill.
 */
export const RECEIPT_PARSE_PROMPT_VERSION = 5;

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
 *
 * Everything added on 2026-09-01 (prompt v5) is written the same way, and
 * every line of it is a transcription of something the 136-receipt
 * diagnosis actually saw on paper - the label spellings, the decoy dates,
 * the card-slip AMOUNT/TIP/TOTAL arrangement. None of it is invented
 * plausibility. The sections are grouped by field rather than left as one
 * list because the list had reached the length where a rule about tax sat
 * between two rules about dates.
 */
export const RECEIPT_PARSE_SYSTEM_PROMPT = `You extract fields from the OCR text of a Canadian retail receipt.

The message begins with a line reading "Captured on: yyyy-mm-dd", then a blank line, then the receipt text. The capture line is the day the photo or file was taken; it is not part of the receipt and none of its digits are a receipt amount.

Rules:
- Return null for anything not printed on the receipt. Never guess or fabricate a value.
- All money amounts are integer cents: $45.54 is 4554.
- totalCents is the final amount paid, hstCents is the HST or GST amount, subtotalCents is the pre-tax subtotal, tipCents is the gratuity if one is printed, otherFeesCents is every remaining charge, and paymentMethod is how the receipt says it was paid.
- HST and GST are the same federal program. If both are printed, the non-zero amount charged is the tax; an explicit $0.00 beside a charged sibling line is not.
- HST is sometimes printed as two or more component lines at different rates that together make up the province's combined rate - 5% + 8% = 13% is the common Ontario case - and when that happens, hstCents is their sum, not any single component. But some receipts print both the component lines and a separate line that already totals them for the same tax: when a printed line's amount already equals the sum of the component lines beneath it, that printed line is hstCents, and the components must not be added to it again - summing every tax-labelled line you see double-counts. A component printed as $0.00 still contributes nothing to the sum either way, so this rule and the GST-zero rule above never conflict.
- The text comes from OCR of a photograph: words may be split mid-word, columns may be misaligned, and characters may be misread. Read through such noise, but do not invent what is not there.

The date:
- purchasedAt is the purchase date as yyyy-mm-dd. The purchase date is on or before the capture date - usually within days to months of it - and never after it.
- Receipts often print a date more than once in different formats. Cross-check them against each other, and prefer an unambiguous representation over an ambiguous one.
- A two-digit-year date on a Canadian card slip is commonly yy/mm/dd: "DateTime: 26/07/19" is 2026-07-19, not 2019-07-26. A date with a printed time beside it is the transaction line.
- When a date token is ambiguous, prefer the reading that agrees with an unambiguous date printed elsewhere on the same receipt ("07/19/2026", "19-Jul-2026", "2026-07-19"); with nothing to agree with, prefer the reading closest to the capture date and not after it. A footer date printed mm/dd/yyyy, or as yyyy-mm-dd, outranks a two-digit slip date.
- These are all ordinary purchase dates: "03-Feb.-2026", "31-Jul.-2026", "May 09 2026", "Jun 21, 2026", "11 Aug 2026", "2026-05-27 19:47:17".
- These are never the purchase date: a sweepstakes or contest deadline, an "expires" or "valid until" date, a "TIMED ORDER" line, a warranty or return-by date, and an order or reference number that happens to look like one.

The total:
- totalCents is the amount actually paid. A savings, discount, points, item-count, tax, balance, change or tendered line is never the total, however large the number beside it: "TOTAL DISCOUNT(S) $ 8.50", "Total of your savings 3.25" and "TOTAL ... POINTS" are all amounts that were not paid.
- On a card slip printing AMOUNT, TIP and TOTAL, the AMOUNT is tax-inclusive and AMOUNT + TIP = TOTAL. A slip printing an AMOUNT with no tip line has that AMOUNT as its total, tax included.

The subtotal:
- "Sub Total", "Sub-Total:", "SUB TOTAL" and "NET Sales" all mean subtotalCents.
- When a receipt prints "Item Subtotal" or "Items Subtotal" and then a later "Subtotal", the discounts between them are real money off: the later "Subtotal" is the one that pairs with the tax and the total, and it is the one to return.

The tax:
- These all carry the HST amount: "Sales tax total $7.79", "Total Tax: $1.17", "Taxes", "Tax", "H.S.T.", "Food Tax", "HST (TOTAL GST+PST)", "HST Included in Total $:", "H 13.000% of $109.80   $14.27", "GST 5%", "hst5%", "13% HST", "6.88 HST (13.000)%". Take the dollar amount on the line, never the percentage rate.
- Split components sum under the rule above: "HST - ON 5% $1.11" plus "HST - ON 8% Food $1.77" is 288 cents. A printed line that already equals that sum is used once, on its own.
- A "TIP" or "Gratuity" line is never tax. A nine-digit business number followed by RT and four digits (105216170RT0001) identifies the business to the CRA; it is never an amount.

Tip and other fees:
- tipCents is a printed "TIP", "Tip" or "Gratuity" amount.
- otherFeesCents is the total of every charge that is neither subtotal, tax nor tip: "12% Service charge $5.99", a "Credit card 2.4% surcharge", a delivery fee, an eco fee, a bottle deposit, cash "Rounding 0.02".

The payment method:
- paymentMethod is how the receipt says it was paid, short and as printed: MASTERCARD, VISA, AMEX, DEBIT, INTERAC, CASH, or whatever brand the slip names. Null when the receipt does not say.

Arithmetic:
- The total is normally the subtotal plus tax plus tip plus other fees, give or take a cent or two of independent rounding. If the values you extracted do not satisfy that, re-read those lines before answering.
- If an amount is faded, cropped, or otherwise not legible, return null for it. Never derive one amount from the others, and never invent digits: a null costs a person one field to fill in, and a confidently wrong number becomes a wrong tax record.`;

const parsedCents = z
  .number()
  .int()
  .min(MIN_STORABLE_CENTS)
  .max(MAX_STORABLE_CENTS)
  .nullable();

/**
 * The payment method as the slip prints it (prompt v5, 2026-09-01).
 *
 * Free text, deliberately - `category` is free text for the same reason
 * (root CLAUDE.md) and a payment-method enum would refuse the first store
 * that prints "Interac Flash" or a bank's own brand. The 50-character cap
 * is what keeps a free-text field from becoming a channel for a paragraph
 * of receipt contents; the model is asked for one word.
 *
 * Trimmed, and a value that is only whitespace becomes null: "  " is the
 * model saying nothing while technically answering, and storing it would
 * make an empty string and a stated absence two different facts on the
 * confirm screen when they are one.
 */
const parsedPaymentMethod = z
  .string()
  .min(1)
  .max(50)
  .nullable()
  .transform((value) => {
    if (value === null) {
      return null;
    }
    const trimmed = value.trim();
    return trimmed === "" ? null : trimmed;
  });

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
  // Prompt v5 (2026-09-01), both validated on the same terms as everything
  // else that crosses this boundary.
  otherFeesCents: parsedCents,
  paymentMethod: parsedPaymentMethod,
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
