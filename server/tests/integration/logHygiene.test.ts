import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OcrFieldSuggestions } from "../../src/domain/ocrSuggestions.js";
import { createLlmParseSweep } from "../../src/parse/llmParseSweep.js";
import {
  createTestHarness,
  imageFor,
  receiptBody,
} from "../helpers/testApp.js";

/**
 * Spec §10B, asserted rather than asserted-in-a-comment: **server logs carry
 * no receipt contents.**
 *
 * This file exists because that invariant had been written into three
 * comments and tested nowhere, and it broke twice. The August 2026 audit
 * found `renderError` printing a whole receipt through a failed query's bound
 * parameters; that was fixed on Aug 6, and on Aug 8 `llmParseSweep`
 * reintroduced the same thing two lines below a comment promising it never
 * happens - with a green suite throughout, because nothing in 263 tests
 * looked at what was printed.
 *
 * Each test asserts a *specific* field of a *specific* receipt is absent from
 * what was actually written, and first asserts that something was written at
 * all - an "it looks redacted" assertion would pass on an empty log.
 */

const VENDOR = "Dr Smith Psychiatry Clinic";
const TAX_NUMBER = "123456789RT0001";
const NOTE = "PRIVATE therapy session do not disclose";
const OCR_TEXT = "PATIENT COPY - Dr Smith Psychiatry - session fee 123.45";

/** Postgres refuses this inside jsonb, which is how a real query is made to fail. */
const NUL = String.fromCharCode(0);

const harness = createTestHarness();
afterAll(() => harness.close());

let token: string;
let userId: string;
let lines: string[];
let restoreConsole: (() => void) | null = null;

beforeEach(async () => {
  await harness.resetDatabase();
  ({ token, userId } = await harness.signIn("log-hygiene-user"));
  lines = [];
});

function captureConsole(): void {
  const collect = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  const errorSpy = vi.spyOn(console, "error").mockImplementation(collect);
  const logSpy = vi.spyOn(console, "log").mockImplementation(collect);
  restoreConsole = () => {
    errorSpy.mockRestore();
    logSpy.mockRestore();
    restoreConsole = null;
  };
}

// Restored in a hook as well as inline, so an assertion that throws mid-test
// cannot leave the rest of the suite running with a mocked console.
afterEach(() => {
  restoreConsole?.();
});

async function createSensitiveReceipt(): Promise<string> {
  const response = await harness.request(
    token,
    "POST",
    "/api/receipts",
    receiptBody({
      vendor: VENDOR,
      vendorTaxNumber: TAX_NUMBER,
      notes: NOTE,
      ocrRawText: OCR_TEXT,
      image: imageFor(userId, "b".repeat(64)),
    }),
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

describe("the LLM parse sweep's failure log", () => {
  /**
   * Drives the REAL `createLlmParseSweep` drain - the code that owns the
   * `console.error` under test - rather than re-implementing its reporting.
   * A test that called `errorSummary` itself and asserted the result was
   * clean would pass with `llmParseSweep.ts` completely untouched.
   */
  async function runSweep(
    parse: (text: string) => Promise<OcrFieldSuggestions>,
  ): Promise<string> {
    captureConsole();
    const sweep = createLlmParseSweep({ db: harness.db, parse });
    sweep.kick();
    // The drain never blocks its caller by contract (a capture must not wait
    // on the model), so its own output is the only thing to wait on.
    await vi.waitFor(
      () => {
        expect(lines.join("\n")).toContain("LLM parse failed for receipt");
      },
      { timeout: 10_000, interval: 25 },
    );
    // One more tick so the summary line that follows it is captured too.
    await new Promise((resolve) => setTimeout(resolve, 100));
    restoreConsole?.();
    return lines.join("\n");
  }

  it("names the receipt and withholds its contents when the write fails", async () => {
    const receiptId = await createSensitiveReceipt();

    // The failure is a real UPDATE rejected by Postgres, inside the sweep's
    // own try block - which is the path that logs, and the path whose error
    // carries the statement's bound parameters in its message.
    const logs = await runSweep(async () => ({
      vendor: `${VENDOR}${NUL}`,
      purchasedAt: "2026-03-15",
      totalCents: 11300,
      hstCents: 1300,
      subtotalCents: 10000,
      vendorTaxNumber: TAX_NUMBER,
    }));

    // The receipt id IS logged - it is the handle that makes the line
    // actionable, and it is not receipt content.
    expect(logs).toContain(receiptId);
    // A line saying only "something failed" is not actionable either, so the
    // SQLSTATE survives redaction. 22P05 is "unsupported Unicode escape".
    expect(logs).toContain("22P05");

    // And none of the receipt survives.
    expect(logs).not.toContain(VENDOR);
    expect(logs).not.toContain(TAX_NUMBER);
    expect(logs).not.toContain("11300");
    expect(logs).not.toContain("session fee");
    // Nor the statement that carried them.
    expect(logs).not.toContain('update "receipts"');
    expect(logs).not.toContain("params:");
  });

  it("keeps the model's own error text, and still withholds the receipt", async () => {
    const receiptId = await createSensitiveReceipt();

    // The other way into the same catch: the parse throws. An error from a
    // model client is not a database error, so its message is ours to keep -
    // what must never appear is the receipt the sweep was working on.
    //
    // ⚠ Stated because it matters: **this test passes with the redaction
    // reverted.** A plain Error printed raw exposes nothing, which is the
    // whole point of the branch it covers - it guards the *over*-redaction
    // direction, so a future tightening cannot silently swallow the one
    // message worth reading. The test above is the one that fails when the
    // fix is removed, and it was falsified.
    const logs = await runSweep(async (text) => {
      throw new Error(`upstream refused after reading ${text.length} chars`);
    });

    expect(logs).toContain(receiptId);
    expect(logs).toContain("upstream refused");
    expect(logs).not.toContain(OCR_TEXT);
    expect(logs).not.toContain("session fee");
    expect(logs).not.toContain(VENDOR);
  });
});

describe("the request log", () => {
  async function captureRequest(run: () => Promise<void>): Promise<string> {
    captureConsole();
    try {
      await run();
    } finally {
      restoreConsole?.();
    }
    return lines.join("\n");
  }

  function requestLine(logs: string): Record<string, unknown> | undefined {
    for (const text of logs.split("\n")) {
      try {
        const parsed = JSON.parse(text) as Record<string, unknown>;
        if (parsed.msg === "request") {
          return parsed;
        }
      } catch {
        // Not every line is the request log; the boot lines are plain text.
      }
    }
    return undefined;
  }

  it("records one line per request, by route pattern rather than by path", async () => {
    const receiptId = await createSensitiveReceipt();

    const logs = await captureRequest(async () => {
      const response = await harness.request(
        token,
        "GET",
        `/api/receipts/${receiptId}`,
      );
      expect(response.status).toBe(200);
    });

    const line = requestLine(logs);
    expect(line).toBeDefined();
    expect(line?.method).toBe("GET");
    expect(line?.status).toBe(200);
    expect(line?.authenticated).toBe(true);
    expect(line?.route).toBe("/api/receipts/:id");
    expect(typeof line?.durationMs).toBe("number");
    // Nothing needs the id, and a receipt id is a handle to a tax record.
    expect(logs).not.toContain(receiptId);
  });

  it("never writes the search term, which is the person's own vendor names", async () => {
    await createSensitiveReceipt();

    const logs = await captureRequest(async () => {
      const response = await harness.request(
        token,
        "GET",
        `/api/receipts?q=${encodeURIComponent("Psychiatry")}`,
      );
      expect(response.status).toBe(200);
    });

    expect(requestLine(logs)).toBeDefined();
    expect(logs).not.toContain("Psychiatry");
    expect(logs).not.toContain("q=");
  });

  it("never writes the bearer token or the user id", async () => {
    const logs = await captureRequest(async () => {
      const response = await harness.request(token, "GET", "/api/me");
      expect(response.status).toBe(200);
    });

    expect(requestLine(logs)).toBeDefined();
    expect(logs).not.toContain(token);
    expect(logs).not.toContain(userId);
  });

  it("records an unauthenticated refusal, the case that had no log line at all", async () => {
    const logs = await captureRequest(async () => {
      const response = await harness.request(null, "GET", "/api/me");
      expect(response.status).toBe(401);
    });

    const line = requestLine(logs);
    expect(line?.status).toBe(401);
    expect(line?.authenticated).toBe(false);
  });

  it("records a body refused before any route ran", async () => {
    const oversize = "x".repeat(2 * 1024 * 1024);
    const logs = await captureRequest(async () => {
      const response = await harness.request(token, "POST", "/api/receipts", {
        notes: oversize,
      });
      expect(response.status).toBe(413);
    });

    // The 413 comes from bodyLimit, which answers without calling the next
    // handler - the shape that previously escaped the cache header too.
    const line = requestLine(logs);
    expect(line?.status).toBe(413);
    expect(logs).not.toContain(oversize);
  });
});
