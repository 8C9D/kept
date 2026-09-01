import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { receipts } from "../../src/db/schema.js";
import type { OcrFieldSuggestions } from "../../src/domain/ocrSuggestions.js";
import {
  createTestHarness,
  imageFor,
  receiptBody,
} from "../helpers/testApp.js";

/**
 * `reviewedFields` and `ocrSource` end to end (2026-09-01): what the client
 * sends, what the row keeps, and what the served `suggestions` block does
 * about it.
 *
 * The rule under test is the one in domain/mergedSuggestions.ts - a field a
 * human has been through is served with no suggestion, so reopening a
 * pending draft cannot re-offer a parser's guess over the person's own work.
 * The unit tests pin the merge; these pin the wiring: the columns, the
 * response, and the two write paths that set them.
 */

const harness = createTestHarness();
afterAll(() => harness.close());

interface SuggestionValue {
  value: unknown;
  source: string | null;
  disagreement?: boolean;
}

interface ReceiptResponse {
  id: string;
  status: string;
  reviewedFields: string[];
  ocrSource: string | null;
  suggestions: Record<string, SuggestionValue> | null;
}

let token: string;
let userId: string;

beforeEach(async () => {
  await harness.resetDatabase();
  ({ token, userId } = await harness.signIn("reviewed-fields-user"));
});

let shaCounter = 0;

const HEURISTIC: OcrFieldSuggestions = {
  vendor: "HEURSITIC VENDOR",
  purchasedAt: "2026-03-15",
  totalCents: 11300,
  hstCents: 1300,
  subtotalCents: 10000,
  tipCents: null,
  otherFeesCents: null,
  paymentMethod: null,
  vendorTaxNumber: null,
};

const LLM: OcrFieldSuggestions = {
  vendor: "Heuristic Vendor Inc.",
  purchasedAt: "2026-03-15",
  totalCents: 11300,
  hstCents: 1300,
  subtotalCents: 10000,
  tipCents: null,
  otherFeesCents: null,
  paymentMethod: null,
  vendorTaxNumber: null,
};

async function create(
  fields: Record<string, unknown>,
): Promise<ReceiptResponse> {
  shaCounter += 1;
  const sha = shaCounter.toString(16).padStart(64, "0");
  const body = receiptBody({
    ocrSuggestions: HEURISTIC,
    ...fields,
    image: imageFor(userId, sha),
  });
  const response = await harness.request(token, "POST", "/api/receipts", body);
  expect(response.status).toBe(201);
  return (await response.json()) as ReceiptResponse;
}

/** Writes the immutable LLM record the sweep would have written. */
async function withLlmRecord(id: string): Promise<void> {
  await harness.db
    .update(receipts)
    .set({
      llmSuggestions: {
        model: "test-model",
        requestedAt: "2026-03-15T18:31:00.000Z",
        suggestions: LLM,
      },
    })
    .where(eq(receipts.id, id));
}

async function fetchDetail(id: string): Promise<ReceiptResponse> {
  const response = await harness.request(token, "GET", `/api/receipts/${id}`);
  expect(response.status).toBe(200);
  return (await response.json()) as ReceiptResponse;
}

describe("reviewedFields on create and PATCH", () => {
  it("defaults to an empty array for a client that says nothing", async () => {
    const created = await create({});
    expect(created.reviewedFields).toEqual([]);
    expect(created.ocrSource).toBeNull();
  });

  it("stores what the create sent, and serves it back on every read path", async () => {
    const created = await create({
      reviewedFields: ["totalCents", "vendor"],
      ocrSource: "vision",
    });
    expect(created.reviewedFields).toEqual(["totalCents", "vendor"]);
    expect(created.ocrSource).toBe("vision");

    const detail = await fetchDetail(created.id);
    expect(detail.reviewedFields).toEqual(["totalCents", "vendor"]);
    expect(detail.ocrSource).toBe("vision");

    const list = (await (
      await harness.request(token, "GET", "/api/receipts")
    ).json()) as { receipts: ReceiptResponse[] };
    expect(list.receipts[0]?.reviewedFields).toEqual(["totalCents", "vendor"]);
    expect(list.receipts[0]?.ocrSource).toBe("vision");
  });

  it("deduplicates a repeated field name", async () => {
    const created = await create({
      reviewedFields: ["vendor", "vendor", "totalCents"],
    });
    expect(created.reviewedFields).toEqual(["vendor", "totalCents"]);
  });

  it("REPLACES the stored set on PATCH, never merges into it", async () => {
    // Un-reviewing a field - the person cleared it and wants the parser's
    // guess offered again - has to be expressible, and a server-side union
    // would make it impossible.
    const created = await create({ reviewedFields: ["totalCents", "vendor"] });
    const response = await harness.request(
      token,
      "PATCH",
      `/api/receipts/${created.id}`,
      { reviewedFields: ["hstCents"] },
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as ReceiptResponse).reviewedFields).toEqual([
      "hstCents",
    ]);
  });

  it("leaves the stored set alone when a PATCH does not mention it", async () => {
    const created = await create({ reviewedFields: ["totalCents"] });
    const response = await harness.request(
      token,
      "PATCH",
      `/api/receipts/${created.id}`,
      { vendor: "Corrected Vendor" },
    );
    expect(((await response.json()) as ReceiptResponse).reviewedFields).toEqual([
      "totalCents",
    ]);
  });

  it("keeps the set through a confirming PATCH rather than clearing it", async () => {
    const created = await create({ reviewedFields: ["totalCents"] });
    const response = await harness.request(
      token,
      "PATCH",
      `/api/receipts/${created.id}`,
      { status: "confirmed" },
    );
    const body = (await response.json()) as ReceiptResponse;
    expect(body.status).toBe("confirmed");
    // Irrelevant once confirmed, but clearing it would be a write whose only
    // purpose is tidiness - and one an unconfirm would want back.
    expect(body.reviewedFields).toEqual(["totalCents"]);
  });

  it("can be emptied explicitly", async () => {
    const created = await create({ reviewedFields: ["totalCents"] });
    const response = await harness.request(
      token,
      "PATCH",
      `/api/receipts/${created.id}`,
      { reviewedFields: [] },
    );
    expect(((await response.json()) as ReceiptResponse).reviewedFields).toEqual(
      [],
    );
  });

  it("400s a field name outside the vocabulary", async () => {
    shaCounter += 1;
    const response = await harness.request(token, "POST", "/api/receipts", {
      ...receiptBody({ reviewedFields: ["totalCents", "somethingElse"] }),
      image: imageFor(userId, shaCounter.toString(16).padStart(64, "0")),
    });
    expect(response.status).toBe(400);
  });

  it("400s an ocrSource outside the vocabulary", async () => {
    shaCounter += 1;
    const response = await harness.request(token, "POST", "/api/receipts", {
      ...receiptBody({ ocrSource: "scanner" }),
      image: imageFor(userId, shaCounter.toString(16).padStart(64, "0")),
    });
    expect(response.status).toBe(400);
  });

  it("400s more names than the vocabulary has", async () => {
    shaCounter += 1;
    const response = await harness.request(token, "POST", "/api/receipts", {
      ...receiptBody({ reviewedFields: Array(11).fill("vendor") }),
      image: imageFor(userId, shaCounter.toString(16).padStart(64, "0")),
    });
    expect(response.status).toBe(400);
  });
});

describe("what a reviewed field does to the served suggestions", () => {
  it("withholds the suggestion for a reviewed field on a pending receipt", async () => {
    const created = await create({ reviewedFields: ["vendor"] });
    await withLlmRecord(created.id);

    const detail = await fetchDetail(created.id);
    expect(detail.status).toBe("pending");
    expect(detail.suggestions?.vendor).toEqual({ value: null, source: null });
    // Its neighbours are untouched.
    expect(detail.suggestions?.totalCents).toEqual({
      value: 11300,
      source: "heuristic",
      disagreement: false,
      withheld: false,
    });
  });

  it("still serves the stored value itself - only the suggestion is withheld", async () => {
    const created = await create({
      vendor: "What The Person Typed",
      reviewedFields: ["vendor"],
    });
    const detail = (await fetchDetail(created.id)) as ReceiptResponse & {
      vendor: string;
    };
    expect(detail.vendor).toBe("What The Person Typed");
    expect(detail.suggestions?.vendor).toEqual({ value: null, source: null });
  });

  it("serves a confirmed receipt's suggestions in full, reviewed or not", async () => {
    // Nothing prefills from a confirmed receipt, and these records are what
    // the §7.3 accuracy comparison reads.
    const created = await create({
      status: "confirmed",
      reviewedFields: ["vendor", "totalCents"],
    });
    await withLlmRecord(created.id);

    const detail = await fetchDetail(created.id);
    expect(detail.suggestions?.vendor).toEqual({
      value: "Heuristic Vendor Inc.",
      source: "llm",
    });
    expect(detail.suggestions?.totalCents).toEqual({
      value: 11300,
      source: "heuristic",
      disagreement: false,
      withheld: false,
    });
  });

  it("leaves the immutable ocr_suggestions record untouched", async () => {
    // Suppression governs what is SERVED. What a parser said is a record,
    // and the accuracy measurement reads it.
    const created = await create({ reviewedFields: ["vendor", "totalCents"] });
    const detail = (await fetchDetail(created.id)) as ReceiptResponse & {
      ocrSuggestions: OcrFieldSuggestions;
    };
    expect(detail.ocrSuggestions).toEqual(HEURISTIC);
  });
});

describe("a PDF's text layer", () => {
  it("serves the LLM's amounts when there is no heuristic to serve", async () => {
    shaCounter += 1;
    const response = await harness.request(token, "POST", "/api/receipts", {
      ...receiptBody({
        ocrSource: "pdf-text",
        ocrRawText: "INVOICE\nSUBTOTAL 100.00\nHST 13.00\nTOTAL 113.00",
      }),
      image: imageFor(userId, shaCounter.toString(16).padStart(64, "0")),
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as ReceiptResponse;
    // No on-device heuristic runs over PDF text, so the receipt carries no
    // ocrSuggestions at all - the shape this exception exists for.
    await withLlmRecord(created.id);

    const detail = await fetchDetail(created.id);
    expect(detail.ocrSource).toBe("pdf-text");
    expect(detail.suggestions?.totalCents).toEqual({
      value: 11300,
      source: "llm",
      disagreement: false,
      withheld: false,
    });
    expect(detail.suggestions?.subtotalCents).toEqual({
      value: 10000,
      source: "llm",
      disagreement: false,
      withheld: false,
    });
  });

  it("keeps a photographed receipt's amounts heuristic-only", async () => {
    shaCounter += 1;
    const response = await harness.request(token, "POST", "/api/receipts", {
      ...receiptBody({ ocrSource: "vision", ocrRawText: "TOTAL 113.00" }),
      image: imageFor(userId, shaCounter.toString(16).padStart(64, "0")),
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as ReceiptResponse;
    await withLlmRecord(created.id);

    const detail = await fetchDetail(created.id);
    expect(detail.suggestions?.totalCents).toEqual({
      value: null,
      source: null,
      disagreement: false,
      withheld: false,
    });
    expect(detail.suggestions?.subtotalCents).toEqual({
      value: null,
      source: null,
      disagreement: false,
      withheld: false,
    });
  });
});
