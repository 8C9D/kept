import { describe, expect, it } from "vitest";
import {
  RECEIPT_PARSE_JSON_SCHEMA,
  RECEIPT_PARSE_PROMPT_VERSION,
  RECEIPT_PARSE_SYSTEM_PROMPT,
  llmParseResponseSchema,
  validateLlmParseResponse,
} from "../../src/domain/llmSuggestions.js";
import {
  DEFAULT_RECEIPT_PARSE_MODEL,
  buildParseRequest,
  resolveReceiptParseModel,
} from "../../src/parse/claudeReceiptParser.js";

const validResponse = {
  vendor: "Food Basics",
  purchasedAt: "2026-07-11",
  totalCents: 4554,
  hstCents: 89,
  subtotalCents: 4465,
  // Prompt v4 (2026-08-28): the model is now asked for a tip like every
  // other amount, so a fully populated response includes one.
  tipCents: 300,
  // Prompt v5 (2026-09-01).
  otherFeesCents: 150,
  paymentMethod: "MASTERCARD",
};

/**
 * What the model is asked for, plus the keys the stored record carries
 * anyway so that a later reader never has to tell "key absent" from "parser
 * found nothing". `vendorTaxNumber` is the one such key left: prompt
 * version 3 stopped asking for it (2026-08-26) and no later version asks
 * again, so it is stamped null rather than answered. `tipCents` is no
 * longer one of these (contrast the previous pass, which stamped it null
 * here too) - prompt v4 asks for it, so it comes back in the model's own
 * response and needs no stamp.
 */
const validRecord = { ...validResponse, vendorTaxNumber: null };

describe("validateLlmParseResponse", () => {
  it("accepts a fully populated response", () => {
    expect(validateLlmParseResponse(validResponse)).toEqual(validRecord);
  });

  it("accepts all-null: a receipt where nothing was legible is a real result", () => {
    const allNull = {
      vendor: null,
      purchasedAt: null,
      totalCents: null,
      hstCents: null,
      subtotalCents: null,
      tipCents: null,
      otherFeesCents: null,
      paymentMethod: null,
    };
    expect(validateLlmParseResponse(allNull)).toEqual({
      ...allNull,
      vendorTaxNumber: null,
    });
  });

  it("rejects a tax number the model volunteered: version 3 stopped asking", () => {
    expect(() =>
      validateLlmParseResponse({
        ...validResponse,
        vendorTaxNumber: "R105216170",
      }),
    ).toThrow();
  });

  it("rejects a missing field: absent and null must stay distinguishable", () => {
    const { hstCents: _hstCents, ...missingHst } = validResponse;
    expect(() => validateLlmParseResponse(missingHst)).toThrow();
  });

  it("rejects a response missing tipCents - prompt v4 requires it like every other amount", () => {
    const { tipCents: _tipCents, ...missingTip } = validResponse;
    expect(() => validateLlmParseResponse(missingTip)).toThrow();
  });

  it("returns the model's own tip, not a hardcoded null", () => {
    // Pins the v4 behaviour against the previous pass's stamp: before v4
    // asked for a tip, this function always wrote tipCents: null itself,
    // regardless of what (if anything) the response contained. Two
    // different non-null inputs producing two different outputs is what
    // proves the value now flows through rather than being overwritten.
    expect(validateLlmParseResponse({ ...validResponse, tipCents: 500 }).tipCents).toBe(
      500,
    );
    expect(
      validateLlmParseResponse({ ...validResponse, tipCents: null }).tipCents,
    ).toBeNull();
  });

  it("rejects an unexpected key", () => {
    expect(() =>
      validateLlmParseResponse({ ...validResponse, otherTaxCents: 100 }),
    ).toThrow();
  });

  it("rejects non-integer cents", () => {
    expect(() =>
      validateLlmParseResponse({ ...validResponse, totalCents: 45.54 }),
    ).toThrow();
  });

  it("rejects cents outside the storable range", () => {
    expect(() =>
      validateLlmParseResponse({ ...validResponse, totalCents: 2_147_483_648 }),
    ).toThrow();
  });

  it("rejects a date that is not a real calendar date", () => {
    expect(() =>
      validateLlmParseResponse({ ...validResponse, purchasedAt: "2026-02-30" }),
    ).toThrow();
  });

  it("rejects a non-yyyy-mm-dd date", () => {
    expect(() =>
      validateLlmParseResponse({ ...validResponse, purchasedAt: "26/07/11" }),
    ).toThrow();
  });

  it("rejects an empty vendor: the model must say null, not ''", () => {
    expect(() =>
      validateLlmParseResponse({ ...validResponse, vendor: "" }),
    ).toThrow();
  });

  it("requires v5's two new fields like every other one", () => {
    for (const key of ["otherFeesCents", "paymentMethod"] as const) {
      const { [key]: _dropped, ...missing } = validResponse;
      expect(() => validateLlmParseResponse(missing)).toThrow();
    }
  });

  it("returns the model's own payment method, trimmed", () => {
    expect(
      validateLlmParseResponse({ ...validResponse, paymentMethod: " VISA " })
        .paymentMethod,
    ).toBe("VISA");
  });

  it("reads a whitespace-only payment method as the absence it is", () => {
    // The model answering "   " is the model saying nothing. Storing that
    // would make an empty string and a stated absence two different facts
    // on the confirm screen when they are one.
    expect(
      validateLlmParseResponse({ ...validResponse, paymentMethod: "   " })
        .paymentMethod,
    ).toBeNull();
  });

  it("rejects an empty payment method: null is how the model says nothing", () => {
    expect(() =>
      validateLlmParseResponse({ ...validResponse, paymentMethod: "" }),
    ).toThrow();
  });

  it("rejects a payment method long enough to carry receipt contents", () => {
    expect(() =>
      validateLlmParseResponse({ ...validResponse, paymentMethod: "x".repeat(51) }),
    ).toThrow();
  });
});

describe("RECEIPT_PARSE_JSON_SCHEMA", () => {
  it("requires every field it declares, so absence can never masquerade as null", () => {
    // Welded to the schema that validates the reply rather than to a
    // remembered list: a property added to one and not the other is what
    // this catches.
    expect([...RECEIPT_PARSE_JSON_SCHEMA.required].sort()).toEqual(
      Object.keys(RECEIPT_PARSE_JSON_SCHEMA.properties).sort(),
    );
    expect([...RECEIPT_PARSE_JSON_SCHEMA.required].sort()).toEqual(
      Object.keys(llmParseResponseSchema.shape).sort(),
    );
  });

  it("forbids additional properties", () => {
    expect(RECEIPT_PARSE_JSON_SCHEMA.additionalProperties).toBe(false);
  });
});

describe("buildParseRequest", () => {
  const rawText = "food\nBasics\nTOTAL 45.54";
  const capturedAt = new Date("2026-08-30T02:51:00Z");
  const request = buildParseRequest(rawText, capturedAt);

  /**
   * The Aug 7 ruling - the model sees what the paper says, never a field a
   * person typed - with the one thing added on 2026-09-01 that is not the
   * paper: the capture date. It is a machine timestamp the client stamps at
   * the shutter, not a field any confirm screen edits, so the ruling's
   * intent holds; and it is what bounds the purchase date, which nothing in
   * the request could do before (MUJI's DD/MM/YYYY slip came back dated
   * after the day the photo was taken).
   *
   * Asserted as the exact string rather than by `toContain`, because "the
   * user content is these two things and nothing else" is the property, and
   * a substring check would pass on a request that had quietly grown a
   * third.
   */
  it("sends the capture date and the OCR text, and nothing else (ruling, Aug 7 2026)", () => {
    expect(request.messages).toEqual([
      { role: "user", content: `Captured on: 2026-08-30\n\n${rawText}` },
    ]);
  });

  it("states the capture date in UTC, the direction that cannot exclude a real purchase", () => {
    // A local-midnight-crossing capture. UTC can only push the stated day
    // LATER than the person's own, and the prompt's rule is "on or before
    // the capture date" - so a day of slack never rules out a legitimate
    // same-day purchase.
    const request = buildParseRequest(rawText, new Date("2026-08-29T23:30:00-04:00"));
    expect(request.messages[0]?.content).toContain("Captured on: 2026-08-30");
  });

  /**
   * ⚠ The regression this pins is the 2026-09-01 production failure, not a
   * style preference. Sonnet 5 runs adaptive thinking when `thinking` is
   * omitted and thinking tokens count against max_tokens: the live request
   * on a 398-character receipt returned stop_reason "max_tokens", 1024
   * output tokens all of them thinking, and no text block - three attempts
   * in a row, which is how receipt 415701a3 earned a failure record. With
   * thinking disabled the same request answered end_turn in 67 tokens.
   */
  it("disables thinking, which is what makes the 1024-token ceiling ample", () => {
    expect(request.thinking).toEqual({ type: "disabled" });
    expect(request.max_tokens).toBe(1024);
  });

  it("pins the ruled model", () => {
    expect(request.model).toBe(DEFAULT_RECEIPT_PARSE_MODEL);
    // Sonnet 5 since 2026-08-28 (the owner's field report of wrong dates,
    // amounts, and vendor names - see the model comment in
    // claudeReceiptParser.ts); Haiku 4.5 before that.
    expect(DEFAULT_RECEIPT_PARSE_MODEL).toBe("claude-sonnet-5");
  });

  it("constrains the response to the suggestion schema", () => {
    expect(request.output_config).toEqual({
      format: { type: "json_schema", schema: RECEIPT_PARSE_JSON_SCHEMA },
    });
  });
});

describe("verbatim-vendor ruling (Aug 8 2026)", () => {
  it("lives in the vendor field's schema description, scoped to that field alone", () => {
    const description = RECEIPT_PARSE_JSON_SCHEMA.properties.vendor.description;
    expect(description).toContain("business name as printed");
    expect(description).toContain("Do not normalize, expand, translate, or tidy");
    expect(description).toContain("exclude branch or store numbers");
  });

  it("stays out of the shared system prompt, where it reached the date field", () => {
    expect(RECEIPT_PARSE_SYSTEM_PROMPT).not.toMatch(/vendor is/);
    expect(RECEIPT_PARSE_SYSTEM_PROMPT).not.toContain("as printed on the receipt, including suffixes");
  });
});

describe("the 2026-08-26 field reduction", () => {
  it("asks for nothing about tax numbers, in the schema or the prompt", () => {
    expect(Object.keys(RECEIPT_PARSE_JSON_SCHEMA.properties)).not.toContain(
      "vendorTaxNumber",
    );
    expect(RECEIPT_PARSE_SYSTEM_PROMPT).not.toMatch(/tax number/i);
    expect(RECEIPT_PARSE_SYSTEM_PROMPT).not.toMatch(/registration number/i);
  });
});

describe("prompt v4 (2026-08-28 product feedback)", () => {
  // A meaning change without a bump would corrupt generation attribution:
  // stored records would claim a prompt that never produced them. v4 bumps
  // for two independent reasons at once - the split-HST rule and the new
  // tip field - so a v3 record's hstCents and a v4 record's hstCents are not
  // answers to the same question (v3 was never asked to sum components).
  // The version assertion moved to the v5 block above when v5 shipped; what
  // stays here is that v4's own rules survived the rewrite, which is the
  // part that would regress silently.
  it("is not the current version any more - v5 superseded it 2026-09-01", () => {
    expect(RECEIPT_PARSE_PROMPT_VERSION).toBeGreaterThan(4);
  });

  it("asks for tipCents, required and nullable like every other amount", () => {
    expect(Object.keys(RECEIPT_PARSE_JSON_SCHEMA.properties)).toContain(
      "tipCents",
    );
    expect(RECEIPT_PARSE_JSON_SCHEMA.properties.tipCents).toEqual({
      type: ["integer", "null"],
    });
    expect(RECEIPT_PARSE_JSON_SCHEMA.required).toContain("tipCents");
  });

  it("states the split-HST rule: sum components, but not on top of a line that already totals them", () => {
    // The rule itself, not just its presence - the wording is what stops a
    // future edit from silently reintroducing the double-count trap.
    expect(RECEIPT_PARSE_SYSTEM_PROMPT).toMatch(/5% \+ 8% = 13%/);
    expect(RECEIPT_PARSE_SYSTEM_PROMPT).toMatch(/hstCents is their sum/);
    expect(RECEIPT_PARSE_SYSTEM_PROMPT).toContain(
      "must not be added to it again",
    );
    expect(RECEIPT_PARSE_SYSTEM_PROMPT).toContain("double-counts");
  });

  /**
   * ⚠ Test honesty: this is a text-content assertion on a prompt string,
   * exactly the kind of thing that is brittle against rewording. Kept
   * anyway, deliberately, because §7.3's device-failure lessons are the
   * regressions this project has actually had, and both were prompt
   * regressions: the GST-zero rule exists because a real receipt's "GST
   * $0.00" once reached the HST field, and the verbatim-vendor rule (tested
   * above) exists because a v1 prompt tidied "Noodle House (BCE)" down to
   * "Noodle House". A wording change that breaks this test is exactly the
   * moment to re-read the rule and confirm the new wording still says it,
   * not a false alarm to silence.
   */
  it("keeps the GST-zero rule the split-HST rule sits beside, and the two do not contradict", () => {
    expect(RECEIPT_PARSE_SYSTEM_PROMPT).toContain(
      "HST and GST are the same federal program",
    );
    expect(RECEIPT_PARSE_SYSTEM_PROMPT).toContain(
      "an explicit $0.00 beside a charged sibling line is not",
    );
    // The trap the brief calls out by name: wording that could be read as
    // "sum every tax-labelled line you see" would double-count exactly the
    // receipts that print both components and a combined total line.
    expect(RECEIPT_PARSE_SYSTEM_PROMPT).not.toMatch(
      /add every tax-labelled line/i,
    );
  });
});

/**
 * Prompt v5 (2026-09-01), driven by the diagnosis over 136 real production
 * receipts rather than by a field report.
 *
 * ⚠ These are text-content assertions on a prompt string, brittle against
 * rewording by design - the same deliberate choice the v4 block below
 * documents. Every phrase asserted here corresponds to a receipt that was
 * actually parsed wrongly in production, so a wording change that breaks
 * one is the moment to re-read the rule and confirm the new wording still
 * says it.
 */
describe("prompt v5 (2026-09-01 parse diagnosis)", () => {
  it("carries prompt version 5", () => {
    expect(RECEIPT_PARSE_PROMPT_VERSION).toBe(5);
  });

  it("asks for otherFeesCents and paymentMethod, required like everything else", () => {
    const properties = Object.keys(RECEIPT_PARSE_JSON_SCHEMA.properties);
    expect(properties).toContain("otherFeesCents");
    expect(properties).toContain("paymentMethod");
    expect(RECEIPT_PARSE_JSON_SCHEMA.required).toContain("otherFeesCents");
    expect(RECEIPT_PARSE_JSON_SCHEMA.required).toContain("paymentMethod");
    expect(RECEIPT_PARSE_JSON_SCHEMA.properties.otherFeesCents.type).toEqual([
      "integer",
      "null",
    ]);
    expect(RECEIPT_PARSE_JSON_SCHEMA.properties.paymentMethod.type).toEqual([
      "string",
      "null",
    ]);
  });

  it("explains the capture line the request now carries", () => {
    expect(RECEIPT_PARSE_SYSTEM_PROMPT).toContain("Captured on: yyyy-mm-dd");
    expect(RECEIPT_PARSE_SYSTEM_PROMPT).toContain(
      "it is not part of the receipt",
    );
  });

  it("bounds the purchase date by the capture date", () => {
    // MUJI prints DD/MM/YYYY; 09/05/2026 was read as September 5, after the
    // day the photo was taken, and nothing rejected it.
    expect(RECEIPT_PARSE_SYSTEM_PROMPT).toContain(
      "on or before the capture date",
    );
    expect(RECEIPT_PARSE_SYSTEM_PROMPT).toContain("never after it");
  });

  it("states the yy/mm/dd card-slip rule that 12 receipts got wrong", () => {
    // Both parsers agreed on 2019-07-26 for "DateTime: 26/07/19", so the
    // disagreement flag never fired and nobody noticed.
    expect(RECEIPT_PARSE_SYSTEM_PROMPT).toContain("26/07/19");
    expect(RECEIPT_PARSE_SYSTEM_PROMPT).toContain("2026-07-19, not 2019-07-26");
    expect(RECEIPT_PARSE_SYSTEM_PROMPT).toMatch(/footer date printed mm\/dd\/yyyy/);
  });

  it("names the decoy dates", () => {
    for (const decoy of ["sweepstakes", "expires", "TIMED ORDER", "warranty"]) {
      expect(RECEIPT_PARSE_SYSTEM_PROMPT).toContain(decoy);
    }
  });

  it("states that a savings or discount line is never the total", () => {
    // A $218.94 Costco purchase was stored as the $8.50 on its
    // "TOTAL DISCOUNT(S)" line.
    expect(RECEIPT_PARSE_SYSTEM_PROMPT).toContain("TOTAL DISCOUNT(S)");
    expect(RECEIPT_PARSE_SYSTEM_PROMPT).toContain("Total of your savings");
    expect(RECEIPT_PARSE_SYSTEM_PROMPT).toContain("is never the total");
  });

  it("states the card slip's AMOUNT + TIP = TOTAL arrangement", () => {
    // Twice, the TIP line on such a slip was entered as HST.
    expect(RECEIPT_PARSE_SYSTEM_PROMPT).toContain("AMOUNT + TIP = TOTAL");
    expect(RECEIPT_PARSE_SYSTEM_PROMPT).toMatch(
      /"TIP" or "Gratuity" line is never tax/,
    );
  });

  it("distinguishes a pre-discount item subtotal from the real one", () => {
    // Longos: Items Subtotal 52.55, Multi-Save -0.45, Subtotal 52.10.
    expect(RECEIPT_PARSE_SYSTEM_PROMPT).toContain("Items Subtotal");
    expect(RECEIPT_PARSE_SYSTEM_PROMPT).toContain(
      'the later "Subtotal" is the one that pairs with the tax and the total',
    );
  });

  it("lists the tax labels the heuristic misses", () => {
    for (const label of [
      "Sales tax total",
      "Total Tax",
      "H.S.T.",
      "Food Tax",
      "HST (TOTAL GST+PST)",
      "HST Included in Total $:",
      "H 13.000% of $109.80",
      "hst5%",
      "6.88 HST (13.000)%",
    ]) {
      expect(RECEIPT_PARSE_SYSTEM_PROMPT).toContain(label);
    }
    expect(RECEIPT_PARSE_SYSTEM_PROMPT).toContain(
      "never the percentage rate",
    );
  });

  it("defines the fee and payment-method fields nobody was extracting", () => {
    expect(RECEIPT_PARSE_SYSTEM_PROMPT).toContain("12% Service charge $5.99");
    expect(RECEIPT_PARSE_SYSTEM_PROMPT).toContain("Credit card 2.4% surcharge");
    expect(RECEIPT_PARSE_SYSTEM_PROMPT).toContain("Rounding 0.02");
    expect(RECEIPT_PARSE_SYSTEM_PROMPT).toContain(
      "MASTERCARD, VISA, AMEX, DEBIT, INTERAC, CASH",
    );
  });

  it("tells the model to answer null rather than derive or invent an amount", () => {
    // A photo with the amount column cropped out produced 1750/201/1549 out
    // of one visible item price; a faded "Subtotal 17 / Tax 35" produced
    // confident wrong cents.
    expect(RECEIPT_PARSE_SYSTEM_PROMPT).toContain(
      "Never derive one amount from the others",
    );
    expect(RECEIPT_PARSE_SYSTEM_PROMPT).toContain("never invent digits");
    expect(RECEIPT_PARSE_SYSTEM_PROMPT).toContain(
      "re-read those lines before answering",
    );
  });
});

describe("resolveReceiptParseModel - the 2026-08-28 override", () => {
  it("defaults to Sonnet 5 when nothing is configured", () => {
    expect(resolveReceiptParseModel({})).toBe(DEFAULT_RECEIPT_PARSE_MODEL);
    expect(DEFAULT_RECEIPT_PARSE_MODEL).toBe("claude-sonnet-5");
  });

  it("takes a configured model id", () => {
    expect(
      resolveReceiptParseModel({ RECEIPT_PARSE_MODEL: "claude-haiku-4-5" }),
    ).toBe("claude-haiku-4-5");
  });

  /**
   * An empty or whitespace-only variable is what an unset Fly secret and a
   * fat-fingered `RECEIPT_PARSE_MODEL=` both look like from here. Falling
   * back beats sending an empty model id to the API and failing every
   * parse on a row that would then be retried three times and abandoned.
   */
  it("falls back when the variable is empty or whitespace", () => {
    expect(resolveReceiptParseModel({ RECEIPT_PARSE_MODEL: "" })).toBe(
      DEFAULT_RECEIPT_PARSE_MODEL,
    );
    expect(resolveReceiptParseModel({ RECEIPT_PARSE_MODEL: "   " })).toBe(
      DEFAULT_RECEIPT_PARSE_MODEL,
    );
  });

  it("is what the request actually carries", () => {
    const capturedAt = new Date("2026-08-30T02:51:00Z");
    expect(
      buildParseRequest("SUBTOTAL 1.00", capturedAt, "claude-haiku-4-5").model,
    ).toBe("claude-haiku-4-5");
    expect(buildParseRequest("SUBTOTAL 1.00", capturedAt).model).toBe(
      DEFAULT_RECEIPT_PARSE_MODEL,
    );
  });
});
