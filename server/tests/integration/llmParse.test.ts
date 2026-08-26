import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { receipts } from "../../src/db/schema.js";
import {
  RECEIPT_PARSE_PROMPT_VERSION,
  type LlmSuggestionRecord,
} from "../../src/domain/llmSuggestions.js";
import type { OcrFieldSuggestions } from "../../src/domain/ocrSuggestions.js";
import { RECEIPT_PARSE_MODEL } from "../../src/parse/claudeReceiptParser.js";
import {
  MAX_PARSE_ATTEMPTS,
  createLlmParseSweep,
  runLlmParseSweep,
} from "../../src/parse/llmParseSweep.js";
import {
  createTestHarness,
  imageFor,
  receiptBody,
} from "../helpers/testApp.js";

/**
 * The server-side LLM parse sweep and its wiring: the capture routes kick
 * it, it fills `llm_suggestions` under the null-only guard, and the read
 * paths serve the §7.3 merge. The model itself is faked - what is under
 * test is the sweep's selection, idempotency, degradation, and the API
 * carrying the merged result.
 */

const parseCalls: string[] = [];
let currentParse: (text: string) => Promise<OcrFieldSuggestions> = () =>
  Promise.reject(new Error("test did not configure a parse"));

const sweep = createLlmParseSweep({
  get db() {
    return harness.db;
  },
  parse(text) {
    parseCalls.push(text);
    return currentParse(text);
  },
});
const harness = createTestHarness({ llmParseSweep: sweep });
afterAll(() => harness.close());

let token: string;
let userId: string;

beforeEach(async () => {
  await harness.resetDatabase();
  parseCalls.length = 0;
  currentParse = () =>
    Promise.reject(new Error("test did not configure a parse"));
  ({ token, userId } = await harness.signIn("llm-parse-user"));
});

function llmValues(
  overrides: Partial<OcrFieldSuggestions> = {},
): OcrFieldSuggestions {
  return {
    vendor: "Fancy Vendor (BCE)",
    purchasedAt: "2026-07-11",
    totalCents: 4553,
    hstCents: 204,
    subtotalCents: 4348,
    vendorTaxNumber: "R105216170",
    ...overrides,
  };
}

/** Inserts a receipt row directly - the sweep reads rows, not the API. */
async function insertReceipt(
  overrides: Partial<typeof receipts.$inferInsert> = {},
): Promise<string> {
  const rows = await harness.db
    .insert(receipts)
    .values({
      userId,
      purchasedAt: "2026-03-15",
      capturedAt: new Date("2026-03-15T18:30:00Z"),
      vendor: "Row Vendor",
      ...overrides,
    })
    .returning({ id: receipts.id });
  const id = rows[0]?.id;
  if (id === undefined) {
    throw new Error("Insert returned no row");
  }
  return id;
}

async function storedRecord(id: string): Promise<LlmSuggestionRecord | null> {
  const rows = await harness.db
    .select({ llmSuggestions: receipts.llmSuggestions })
    .from(receipts)
    .where(eq(receipts.id, id));
  return rows[0]?.llmSuggestions ?? null;
}

describe("runLlmParseSweep", () => {
  it("parses exactly the live rows with OCR text and no record - confirmed ones included", async () => {
    currentParse = () => Promise.resolve(llmValues());
    const pendingWithText = await insertReceipt({ ocrRawText: "pending text" });
    // Confirmed deliberately: it cannot benefit from suggestions, but its
    // parse grows the accuracy set the n=5 caveat needs.
    const confirmedWithText = await insertReceipt({
      ocrRawText: "confirmed text",
      status: "confirmed",
      totalCents: 4554,
    });
    const withoutText = await insertReceipt({});
    const deleted = await insertReceipt({
      ocrRawText: "deleted text",
      deletedAt: new Date(),
    });
    const alreadyRecorded = await insertReceipt({
      ocrRawText: "already recorded",
      llmSuggestions: {
        model: "earlier-model",
        requestedAt: "2026-08-07T00:00:00.000Z",
        suggestions: llmValues({ vendor: "Earlier Writer" }),
      },
    });

    const result = await runLlmParseSweep({
      db: harness.db,
      parse: currentParse,
    });

    expect(result).toMatchObject({ attempted: 2, written: 2, superseded: 0 });
    expect(result.failed).toEqual([]);

    const written = await storedRecord(pendingWithText);
    expect(written?.model).toBe(RECEIPT_PARSE_MODEL);
    expect(written?.promptVersion).toBe(RECEIPT_PARSE_PROMPT_VERSION);
    expect(written?.suggestions).toEqual(llmValues());
    expect((await storedRecord(confirmedWithText))?.suggestions).toEqual(
      llmValues(),
    );
    expect(await storedRecord(withoutText)).toBeNull();
    expect(await storedRecord(deleted)).toBeNull();
    // Immutable: the pre-existing record is untouched.
    expect((await storedRecord(alreadyRecorded))?.suggestions?.vendor).toBe(
      "Earlier Writer",
    );
  });

  it("is idempotent: a second run finds nothing and never calls the model", async () => {
    await insertReceipt({ ocrRawText: "some text" });
    const parse = (text: string) => {
      parseCalls.push(text);
      return Promise.resolve(llmValues());
    };
    await runLlmParseSweep({ db: harness.db, parse });
    expect(parseCalls).toHaveLength(1);

    const second = await runLlmParseSweep({ db: harness.db, parse });
    expect(second).toEqual({
      attempted: 0,
      written: 0,
      superseded: 0,
      failed: [],
    });
    expect(parseCalls).toHaveLength(1);
  });

  it("keeps the first writer's record under concurrent runs - the loser counts the row superseded", async () => {
    const id = await insertReceipt({ ocrRawText: "contested text" });

    // Both sweeps read the row before either writes; the gates make the
    // interleaving deterministic instead of hoping the event loop races.
    let releaseA!: () => void;
    let releaseB!: () => void;
    const gateA = new Promise<void>((resolve) => (releaseA = resolve));
    const gateB = new Promise<void>((resolve) => (releaseB = resolve));
    let aSelected!: () => void;
    let bSelected!: () => void;
    const bothSelected = Promise.all([
      new Promise<void>((resolve) => (aSelected = resolve)),
      new Promise<void>((resolve) => (bSelected = resolve)),
    ]);

    const runA = runLlmParseSweep({
      db: harness.db,
      parse: async () => {
        aSelected();
        await gateA;
        return llmValues({ vendor: "First Writer" });
      },
    });
    const runB = runLlmParseSweep({
      db: harness.db,
      parse: async () => {
        bSelected();
        await gateB;
        return llmValues({ vendor: "Second Writer" });
      },
    });

    await bothSelected;
    releaseA();
    const resultA = await runA;
    releaseB();
    const resultB = await runB;

    expect(resultA).toMatchObject({ written: 1, superseded: 0 });
    expect(resultB).toMatchObject({ written: 0, superseded: 1 });
    expect(resultB.failed).toEqual([]);
    // The guarded UPDATE is what this pins: without the null-only WHERE
    // clause the second writer would overwrite, and this vendor would read
    // "Second Writer".
    expect((await storedRecord(id))?.suggestions?.vendor).toBe("First Writer");
  });

  it("abandons a row after MAX_PARSE_ATTEMPTS failures with a durable failure record", async () => {
    const id = await insertReceipt({
      ocrRawText: "unparseable text",
      ocrSuggestions: {
        vendor: "SCANNED VENDOR",
        purchasedAt: null,
        totalCents: 11300,
        hstCents: null,
        subtotalCents: null,
        vendorTaxNumber: null,
      },
    });
    const failureCounts = new Map<string, number>();
    const deps = {
      db: harness.db,
      parse: () => Promise.reject(new Error("schema validation failed")),
      failureCounts,
    };

    // Attempts 1 and 2: the row stays null, eligible for the next sweep.
    for (const attempt of [1, 2]) {
      const result = await runLlmParseSweep(deps);
      expect(result.failed).toEqual([
        { id, error: expect.any(Error), abandoned: false },
      ]);
      expect(failureCounts.get(id)).toBe(attempt);
      expect(await storedRecord(id)).toBeNull();
    }

    // Attempt 3: the failure becomes data.
    const third = await runLlmParseSweep(deps);
    expect(third.failed).toEqual([
      { id, error: expect.any(Error), abandoned: true },
    ]);
    const record = await storedRecord(id);
    expect(record).toMatchObject({
      model: RECEIPT_PARSE_MODEL,
      promptVersion: RECEIPT_PARSE_PROMPT_VERSION,
      error: "schema validation failed",
      attempts: MAX_PARSE_ATTEMPTS,
      suggestions: null,
    });
    expect(failureCounts.has(id)).toBe(false);

    // The record stops the re-billing: no sweep selects the row again.
    const fourth = await runLlmParseSweep(deps);
    expect(fourth.attempted).toBe(0);

    // And the read path serves the heuristic-only merge - a failure record
    // means "the LLM produced nothing", never a broken response.
    const detail = await harness.request(token, "GET", `/api/receipts/${id}`);
    const body = (await detail.json()) as {
      suggestions: Record<string, unknown>;
    };
    expect(body.suggestions.vendor).toEqual({
      value: "SCANNED VENDOR",
      source: "heuristic",
    });
  });

  it("does not cap attempts when no failure counter is supplied - the backfill's single pass", async () => {
    const id = await insertReceipt({ ocrRawText: "still failing" });
    const deps = {
      db: harness.db,
      parse: () => Promise.reject(new Error("boom")),
    };
    for (let run = 0; run < MAX_PARSE_ATTEMPTS + 1; run += 1) {
      const result = await runLlmParseSweep(deps);
      expect(result.failed).toEqual([
        { id, error: expect.any(Error), abandoned: false },
      ]);
    }
    expect(await storedRecord(id)).toBeNull();
  });

  it("contains a failing parse to its row and keeps sweeping", async () => {
    const failing = await insertReceipt({ ocrRawText: "FAIL" });
    const fine = await insertReceipt({ ocrRawText: "fine text" });

    const result = await runLlmParseSweep({
      db: harness.db,
      parse: (text) =>
        text === "FAIL"
          ? Promise.reject(new Error("model unreachable"))
          : Promise.resolve(llmValues()),
    });

    expect(result).toMatchObject({ attempted: 2, written: 1 });
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.id).toBe(failing);
    // The failed row states its absence and stays eligible for the next
    // sweep; the healthy row is unaffected.
    expect(await storedRecord(failing)).toBeNull();
    expect((await storedRecord(fine))?.suggestions).toEqual(llmValues());
  });
});

describe("the capture routes kick the sweep", () => {
  it("creates the receipt and serves it even with the model API unreachable", async () => {
    // Honest scope: this create would also succeed with the sweep unwired,
    // since the route never awaits the parse. What the test pins is the
    // pair of facts that make the degradation real: the kick DOES reach the
    // model (parseCalls below fails if the wiring is removed) and its
    // failure leaves the receipt heuristic-only rather than failing
    // anything.
    currentParse = () => Promise.reject(new Error("ECONNREFUSED"));

    const response = await harness.request(token, "POST", "/api/receipts", {
      ...receiptBody({ image: imageFor(userId, "2".repeat(64)) }),
      ocrRawText: "TOTAL 113.00",
      ocrSuggestions: { vendor: "SCANNED VENDOR", totalCents: 11300 },
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as {
      id: string;
      suggestions: { vendor: { value: string; source: string } };
    };
    // Heuristic-only merge, provenance stated.
    expect(created.suggestions.vendor).toEqual({
      value: "SCANNED VENDOR",
      source: "heuristic",
    });

    await vi.waitFor(
      () => {
        expect(parseCalls).toContain("TOTAL 113.00");
      },
      { timeout: 5000 },
    );
    // A rejecting parse writes nothing; the row states the absence.
    expect(await storedRecord(created.id)).toBeNull();
  });

  it("parses a capture in the background and serves the merged suggestions on both read paths", async () => {
    currentParse = () =>
      Promise.resolve(llmValues({ purchasedAt: "2026-07-11" }));

    const response = await harness.request(token, "POST", "/api/receipts", {
      ...receiptBody({
        image: imageFor(userId, "3".repeat(64)),
        purchasedAt: "2011-07-26",
      }),
      ocrRawText: "FANCY VENDOR TOTAL 45.54",
      ocrSuggestions: {
        vendor: "FANCY VENDOR",
        purchasedAt: "2011-07-26",
        totalCents: 4554,
      },
    });
    expect(response.status).toBe(201);
    const created = (await response.json()) as { id: string };

    await vi.waitFor(
      async () => {
        expect(await storedRecord(created.id)).not.toBeNull();
      },
      { timeout: 5000 },
    );
    // The record keeps every LLM amount - the money rule governs what the
    // merge serves, not what is recorded, so parse-accuracy can keep
    // scoring the path.
    expect((await storedRecord(created.id))?.suggestions).toEqual(
      llmValues({ purchasedAt: "2026-07-11" }),
    );

    const detail = await harness.request(
      token,
      "GET",
      `/api/receipts/${created.id}`,
    );
    const detailBody = (await detail.json()) as {
      suggestions: Record<string, unknown>;
      ocrSuggestions: Record<string, unknown>;
    };
    // The §7.3 merge, rendered by the domain layer: amounts from the
    // heuristic only, vendor from the LLM, the disagreeing date flagged.
    expect(detailBody.suggestions.vendor).toEqual({
      value: "Fancy Vendor (BCE)",
      source: "llm",
    });
    expect(detailBody.suggestions.totalCents).toEqual({
      value: 4554,
      source: "heuristic",
    });
    // The heuristic found no HST or subtotal; the LLM's amounts are stored
    // but never served - the fields come back absent.
    expect(detailBody.suggestions.hstCents).toEqual({
      value: null,
      source: null,
    });
    expect(detailBody.suggestions.subtotalCents).toEqual({
      value: null,
      source: null,
    });
    // ⚠ TRANSITIONAL: the merge computes no tax number any more, but the
    // response still carries the key as a stated absence, because the
    // shipped iOS 1.0 (1) build decodes it with a non-optional key and
    // would fail to decode the whole receipt without it. Removed when no
    // installed build decodes it.
    expect(detailBody.suggestions.vendorTaxNumber).toEqual({
      value: null,
      source: null,
    });
    expect(detailBody.suggestions.purchasedAt).toEqual({
      value: "2011-07-26",
      source: "heuristic",
      disagreement: true,
    });
    // The raw heuristic record stays on the detail response for the
    // shipped iOS client, unchanged by the merge.
    expect(detailBody.ocrSuggestions).toMatchObject({
      vendor: "FANCY VENDOR",
    });

    const list = await harness.request(token, "GET", "/api/receipts");
    const listBody = (await list.json()) as {
      receipts: { id: string; suggestions: Record<string, unknown> }[];
    };
    const listed = listBody.receipts.find((r) => r.id === created.id);
    expect(listed?.suggestions.vendor).toEqual({
      value: "Fancy Vendor (BCE)",
      source: "llm",
    });
    // The shim rides the list response too - it is the response the shipped
    // client decodes on every launch.
    expect(listed?.suggestions.vendorTaxNumber).toEqual({
      value: null,
      source: null,
    });
  });
});
