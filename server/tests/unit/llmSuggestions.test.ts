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
  const request = buildParseRequest(rawText);

  it("sends exactly the OCR text as the only user content - never user-entered fields (ruling, Aug 7 2026)", () => {
    expect(request.messages).toEqual([{ role: "user", content: rawText }]);
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
  it("carries prompt version 4", () => {
    expect(RECEIPT_PARSE_PROMPT_VERSION).toBe(4);
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
    expect(buildParseRequest("SUBTOTAL 1.00", "claude-haiku-4-5").model).toBe(
      "claude-haiku-4-5",
    );
    expect(buildParseRequest("SUBTOTAL 1.00").model).toBe(
      DEFAULT_RECEIPT_PARSE_MODEL,
    );
  });
});
