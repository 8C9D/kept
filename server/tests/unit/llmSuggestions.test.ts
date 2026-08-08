import { describe, expect, it } from "vitest";
import {
  RECEIPT_PARSE_JSON_SCHEMA,
  RECEIPT_PARSE_PROMPT_VERSION,
  RECEIPT_PARSE_SYSTEM_PROMPT,
  validateLlmParseResponse,
} from "../../src/domain/llmSuggestions.js";
import { OCR_SUGGESTION_FIELDS } from "../../src/domain/ocrSuggestions.js";
import {
  RECEIPT_PARSE_MODEL,
  buildParseRequest,
} from "../../src/parse/claudeReceiptParser.js";

const validResponse = {
  vendor: "Food Basics",
  purchasedAt: "2026-07-11",
  totalCents: 4554,
  hstCents: 89,
  subtotalCents: 4465,
  vendorTaxNumber: "R105216170",
};

describe("validateLlmParseResponse", () => {
  it("accepts a fully populated response", () => {
    expect(validateLlmParseResponse(validResponse)).toEqual(validResponse);
  });

  it("accepts all-null: a receipt where nothing was legible is a real result", () => {
    const allNull = {
      vendor: null,
      purchasedAt: null,
      totalCents: null,
      hstCents: null,
      subtotalCents: null,
      vendorTaxNumber: null,
    };
    expect(validateLlmParseResponse(allNull)).toEqual(allNull);
  });

  it("rejects a missing field: absent and null must stay distinguishable", () => {
    const { hstCents: _hstCents, ...missingHst } = validResponse;
    expect(() => validateLlmParseResponse(missingHst)).toThrow();
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
  it("requires every suggestion field, so absence can never masquerade as null", () => {
    expect([...RECEIPT_PARSE_JSON_SCHEMA.required].sort()).toEqual(
      [...OCR_SUGGESTION_FIELDS].sort(),
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
    expect(request.model).toBe(RECEIPT_PARSE_MODEL);
    expect(RECEIPT_PARSE_MODEL).toBe("claude-haiku-4-5");
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

  it("carries prompt version 2: a meaning change without a bump would corrupt generation attribution", () => {
    expect(RECEIPT_PARSE_PROMPT_VERSION).toBe(2);
  });
});
