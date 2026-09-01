import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { receipts } from "../../src/db/schema.js";
import { RECEIPT_PARSE_PROMPT_VERSION } from "../../src/domain/llmSuggestions.js";
import type { OcrFieldSuggestions } from "../../src/domain/ocrSuggestions.js";
import { LlmParseError } from "../../src/parse/claudeReceiptParser.js";
import type { ParseOcrText } from "../../src/routes/receipts.js";
import {
  createTestHarness,
  imageFor,
  receiptBody,
} from "../helpers/testApp.js";

/**
 * `POST /api/receipts/parse` (2026-09-01) - the capture-time parse the iOS
 * confirm screen calls while the person is still holding the paper. The
 * model is faked; what is under test is the route: what it accepts, what it
 * answers, what it does when no key is configured, and - the load-bearing
 * one - that it writes nothing.
 *
 * Why this endpoint exists at all is in the route's own comment: 51 of 54
 * confirmations in the parse diagnosis happened at capture time, and the
 * model read the vendor right 63% of the time against the heuristic's 39%.
 * A suggestion that arrives with the sweep, minutes later, is a suggestion
 * nobody sees.
 */

const FAKE_MODEL = "claude-sonnet-5-fake";

const calls: { text: string; capturedAt: Date }[] = [];
let currentParse: (text: string) => Promise<OcrFieldSuggestions> = () =>
  Promise.reject(new Error("test did not configure a parse"));

const parseOcrText: ParseOcrText = {
  model: FAKE_MODEL,
  parse(text, capturedAt) {
    calls.push({ text, capturedAt });
    return currentParse(text);
  },
};

const harness = createTestHarness({ parseOcrText });
/** A second app with no key configured at all - the local-dev shape. */
const unconfigured = createTestHarness();

afterAll(async () => {
  await harness.close();
  await unconfigured.close();
});

let token: string;
let userId: string;

const OCR_TEXT = [
  "food",
  "Basics",
  "SUBTOTAL 9.86",
  "TOTAL 9-86",
  "Total of your savings 3.25",
  "DateTime: 26/07/11 12:03:44",
  "MASTERCARD",
].join("\n");

const SUGGESTIONS: OcrFieldSuggestions = {
  vendor: "Food Basics",
  purchasedAt: "2026-07-11",
  totalCents: 986,
  hstCents: null,
  subtotalCents: 986,
  tipCents: null,
  otherFeesCents: null,
  paymentMethod: "MASTERCARD",
  vendorTaxNumber: null,
};

beforeEach(async () => {
  await harness.resetDatabase();
  calls.length = 0;
  currentParse = () => Promise.resolve(SUGGESTIONS);
  ({ token, userId } = await harness.signIn("parse-route-user"));
});

function body(overrides: Record<string, unknown> = {}) {
  return {
    ocrRawText: OCR_TEXT,
    capturedAt: "2026-08-30T02:51:00Z",
    ...overrides,
  };
}

describe("POST /api/receipts/parse", () => {
  it("refuses without a session: the endpoint spends money per call", async () => {
    const response = await harness.request(null, "POST", "/api/receipts/parse", body());
    expect(response.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it("answers the suggestions with the stamps a stored record carries", async () => {
    const response = await harness.request(
      token,
      "POST",
      "/api/receipts/parse",
      body(),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      suggestions: SUGGESTIONS,
      model: FAKE_MODEL,
      promptVersion: RECEIPT_PARSE_PROMPT_VERSION,
    });
  });

  it("hands the parse the text and the capture instant, and nothing else", async () => {
    await harness.request(token, "POST", "/api/receipts/parse", body());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.text).toBe(OCR_TEXT);
    expect(calls[0]?.capturedAt.toISOString()).toBe("2026-08-30T02:51:00.000Z");
  });

  /**
   * The clause this route had to be built around: `llm_suggestions` is
   * written once, by the sweep, and never updated (spec §7.3). A second
   * caller that also wrote would make the stored record's model and prompt
   * stamps meaningless. Re-reading the table is the only assertion that
   * actually proves it - an exit code would not.
   */
  it("writes nothing at all: the receipts table is untouched afterwards", async () => {
    await harness.request(token, "POST", "/api/receipts/upload-url", {
      contentType: "image/jpeg",
    });
    const created = await harness.request(token, "POST", "/api/receipts", {
      ...receiptBody({ ocrRawText: "SUBTOTAL 1.00" }),
      image: imageFor(userId, "b".repeat(64)),
    });
    expect(created.status).toBe(201);

    const before = await harness.db.select().from(receipts);
    const response = await harness.request(
      token,
      "POST",
      "/api/receipts/parse",
      body(),
    );
    expect(response.status).toBe(200);
    const after = await harness.db.select().from(receipts);

    expect(after).toEqual(before);
    expect(after).toHaveLength(1);
    // Named separately from the deep-equality above: a future column that
    // this route started filling in would have to survive both.
    expect(after[0]?.llmSuggestions).toBeNull();
  });

  it("is not shadowed by the /:id route it is registered above", async () => {
    // Hono matches in registration order, so a `/parse` declared after
    // `/:id` would be answered as a lookup of the receipt whose id is
    // "parse" - a 404 that looks like a missing route.
    const response = await harness.request(
      token,
      "POST",
      "/api/receipts/parse",
      body(),
    );
    expect(response.status).not.toBe(404);
  });

  it("answers 503 when no key is configured, rather than faking an empty parse", async () => {
    const { token: otherToken } = await unconfigured.signIn("parse-unconfigured");
    const response = await unconfigured.request(
      otherToken,
      "POST",
      "/api/receipts/parse",
      body(),
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: {
        code: "parse_unavailable",
        message: expect.any(String),
      },
    });
  });

  it("answers 502 on a parse failure, with our message and nothing of the model's", async () => {
    currentParse = () =>
      Promise.reject(
        new LlmParseError("Model response was not parseable JSON", {
          cause: new Error("SyntaxError [message withheld] at position 41"),
        }),
      );
    const response = await harness.request(
      token,
      "POST",
      "/api/receipts/parse",
      body(),
    );
    expect(response.status).toBe(502);
    const payload = (await response.json()) as { error: { code: string; message: string } };
    expect(payload.error.code).toBe("parse_failed");
    expect(payload.error.message).toBe("Model response was not parseable JSON");
    // The cause chain never reaches the wire: it is where a sanitized-but-
    // still-model-shaped fragment would live.
    expect(JSON.stringify(payload)).not.toContain("position 41");
  });

  it("answers 500, not 502, when the failure is not a parse failure", async () => {
    // A network or SDK error is not "the model said something wrong", and
    // rendering it as a parse failure would hide an outage behind a
    // client-facing explanation.
    currentParse = () => Promise.reject(new Error("connect ECONNREFUSED"));
    const response = await harness.request(
      token,
      "POST",
      "/api/receipts/parse",
      body(),
    );
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("ECONNREFUSED");
  });

  describe("the body it accepts", () => {
    it("refuses text past the 100 000-character bound", async () => {
      const response = await harness.request(
        token,
        "POST",
        "/api/receipts/parse",
        body({ ocrRawText: "x".repeat(100_001) }),
      );
      expect(response.status).toBe(400);
      expect(calls).toHaveLength(0);
    });

    it("refuses an empty text: parsing nothing is not a request", async () => {
      const response = await harness.request(
        token,
        "POST",
        "/api/receipts/parse",
        body({ ocrRawText: "" }),
      );
      expect(response.status).toBe(400);
    });

    it("refuses a capture timestamp without an offset", async () => {
      const response = await harness.request(
        token,
        "POST",
        "/api/receipts/parse",
        body({ capturedAt: "2026-08-30" }),
      );
      expect(response.status).toBe(400);
    });

    it("refuses an unexpected key, a receipt id most of all", async () => {
      // Strict, like every schema here. This route is deliberately not
      // about a row, and a key it silently ignored would be an invitation
      // to make it one.
      const response = await harness.request(
        token,
        "POST",
        "/api/receipts/parse",
        body({ receiptId: "00000000-0000-4000-8000-000000000000" }),
      );
      expect(response.status).toBe(400);
      expect(calls).toHaveLength(0);
    });
  });
});
