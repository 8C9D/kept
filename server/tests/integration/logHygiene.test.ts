import { randomUUID } from "node:crypto";
import type Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { receipts } from "../../src/db/schema.js";
import { llmParseResponseSchema } from "../../src/domain/llmSuggestions.js";
import type { OcrFieldSuggestions } from "../../src/domain/ocrSuggestions.js";
import { requestLog } from "../../src/observability/requestLog.js";
import { parseReceiptText } from "../../src/parse/claudeReceiptParser.js";
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

/**
 * The sentinel for the LLM branch below. V8 quotes about ten characters of
 * `JSON.parse`'s input inside the SyntaxError it throws, so a whole vendor
 * name is the wrong thing to assert absent - only its first characters ever
 * fit in that window, and `not.toContain(VENDOR)` would pass over a real
 * leak of exactly this much of it.
 */
const VENDOR_HEAD = VENDOR.slice(0, 8);

/** Only the fronted harness below uses it; its value never reaches a log. */
const EDGE_SECRET = "edge-secret-value-for-log-tests-0123456789";

const harness = createTestHarness();
/**
 * A second app with the edge check configured, which is the only way to
 * drive the 403 that answers before Hono routes. Production always has this
 * set, so the refusal it labels is a production-only shape.
 */
const fronted = createTestHarness({ edgeSharedSecret: EDGE_SECRET });
afterAll(async () => {
  await harness.close();
  await fronted.close();
});

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
      notes: NOTE,
      ocrRawText: OCR_TEXT,
      image: imageFor(userId, "b".repeat(64)),
    }),
  );
  expect(response.status).toBe(201);
  return ((await response.json()) as { id: string }).id;
}

/**
 * A model client whose single reply is `reply`, so the REAL `parseReceiptText`
 * runs against it. The SyntaxError under test has to be V8's own - the whole
 * question is what `JSON.parse` writes into its message - so nothing here
 * hand-builds an error.
 */
function modelReplying(reply: string): Anthropic {
  return {
    messages: {
      create: () =>
        Promise.resolve({
          stop_reason: "end_turn",
          content: [{ type: "text", text: reply }],
        }),
    },
  } as unknown as Anthropic;
}

/**
 * V8's own message for a reply that is not JSON, so the tests below assert
 * against what this Node actually says rather than a remembered wording.
 */
function jsonParseMessage(reply: string): string {
  try {
    JSON.parse(reply);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("This fixture must not be parseable JSON");
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
      // The receipt row carries no tax number since 2026-08-26, but the
      // immutable suggestion record still can - and this is the jsonb the
      // failing UPDATE binds, so TAX_NUMBER really is in the statement
      // whose text must not reach the log.
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

  it("keeps a non-database error's own message, so redaction cannot swallow the one line worth reading", async () => {
    const receiptId = await createSensitiveReceipt();

    // The other way into the same catch: the parse throws. An error from a
    // model client is not a database error, so its message is ours to keep.
    //
    // ⚠ This test guards the OVER-redaction direction only, and says so
    // because an earlier draft claimed more. It passes with the redaction
    // reverted - a plain Error printed raw exposes nothing - so it is not
    // evidence for PR-2's fix; the test above is, and it was falsified.
    //
    // ⚠ And it deliberately does not assert that this branch is free of
    // receipt content, because a synthetic error that could never have
    // carried a vendor cannot be evidence of that either way. The two cases
    // below do assert it, through the real parser against a real
    // `JSON.parse` failure - which is where N-2 actually lived.
    const logs = await runSweep(async (text) => {
      throw new Error(`upstream refused after reading ${text.length} chars`);
    });

    expect(logs).toContain(receiptId);
    expect(logs).toContain("upstream refused");
  });

  it("withholds the model's own words when its reply is not JSON at all", async () => {
    // N-2. The realistic failure: instead of the JSON schema the model
    // answers in prose about the receipt it was shown - so its reply IS
    // receipt content, and `JSON.parse` quotes the front of it.
    const reply = `${VENDOR} - session fee 123.45, no JSON here`;
    // The leak asserted at its source before its absence is asserted
    // anywhere: this is the message the parser's catch block receives, and
    // it carries the vendor. Without this leg the test could pass because
    // the SyntaxError never said anything interesting.
    const v8Message = jsonParseMessage(reply);
    expect(v8Message).toContain(VENDOR_HEAD);

    const receiptId = await createSensitiveReceipt();
    const logs = await runSweep((text) =>
      parseReceiptText(modelReplying(reply), text),
    );

    expect(logs).toContain(receiptId);
    // Still diagnosable: our own message names the failure mode, and the
    // sanitized cause still names the class that produced it.
    expect(logs).toContain("Model response was not parseable JSON");
    expect(logs).toContain("SyntaxError");
    // And the model's output does not reach the log, in whole or in part.
    expect(logs).not.toContain(v8Message);
    expect(logs).not.toContain(VENDOR_HEAD);
    expect(logs).not.toContain(VENDOR);
  });

  it("keeps the offset a malformed reply stopped at, the one fact worth reading", async () => {
    // The other JSON failure family. V8 splits them: a reply it cannot
    // tokenize gets a quoted snippet and no offset (the case above), while a
    // structurally broken one gets `at position N` and quotes nothing. This
    // leg guards the diagnosability half of the fix - the offset must
    // survive the sanitizing - and it is one-directional: it would pass with
    // the raw cause restored, because this message never had a snippet in it
    // to leak. The case above is the one that falsifies.
    const reply = `{"vendor": "${VENDOR}", "totalCents": 12345,}`;
    const position = /at position (\d+)/.exec(jsonParseMessage(reply))?.[1];
    expect(position).toBeDefined();

    await createSensitiveReceipt();
    const logs = await runSweep((text) =>
      parseReceiptText(modelReplying(reply), text),
    );

    expect(logs).toContain(`at position ${position}`);
    expect(logs).not.toContain(VENDOR_HEAD);
  });

  it("withholds the keys the model invented when its reply fails validation", async () => {
    // Round 4 §4a's residual, closed. The reply parses as JSON but fails
    // the strict schema on a key the model made up - and zod writes the
    // offending keys into its message verbatim, so a key that quotes the
    // receipt would ride the cause chain into the log the way the
    // JSON.parse snippet did (N-2). The invented key here carries exactly
    // that shape of content.
    const inventedKey = "Dr Smith session fee";
    const reply = JSON.stringify({
      vendor: VENDOR,
      purchasedAt: "2026-03-15",
      totalCents: "11300", // wrong type, so a field-level path is exercised too
      hstCents: 1300,
      subtotalCents: 10000,
      [inventedKey]: 11300,
    });
    // The leak asserted at its source first: this is the ZodError the
    // parser's catch receives, and its message carries the invented key.
    // Without this leg, a zod that stopped echoing keys would make the
    // absence assertions below vacuous.
    const zodResult = llmParseResponseSchema.safeParse(JSON.parse(reply));
    expect(zodResult.success).toBe(false);
    if (!zodResult.success) {
      expect(zodResult.error.message).toContain(inventedKey);
    }

    const receiptId = await createSensitiveReceipt();
    const logs = await runSweep((text) =>
      parseReceiptText(modelReplying(reply), text),
    );

    expect(logs).toContain(receiptId);
    // Still diagnosable: the failure mode, the issue codes, and the paths -
    // which are our own schema's key names - all survive.
    expect(logs).toContain("Model response did not validate as receipt suggestions");
    expect(logs).toContain("ZodError");
    expect(logs).toContain("unrecognized_keys");
    expect(logs).toContain("invalid_type at totalCents");
    // And nothing the model wrote reaches the log: not the invented key
    // (which is also the vendor's name here), not any zod message text.
    expect(logs).not.toContain("Dr Smith");
    expect(logs).not.toContain("Unrecognized keys");
  });

  it("stores the redacted message in the durable failure record, never the cause", async () => {
    // The failure record is the other place this error becomes text, and it
    // outlives every log line. `runLlmParseSweep` is driven directly because
    // the record is only written on the last of MAX_PARSE_ATTEMPTS failures,
    // and the count is the caller's.
    //
    // ⚠ One-directional, like the offset case: `redactedMessage` reads
    // `error.message` and never walks the cause chain, so this passed before
    // the parser was fixed too. It is here to pin that the record carries
    // the outer message alone - not as evidence for the fix.
    const receiptId = await createSensitiveReceipt();
    const reply = `${VENDOR} - session fee 123.45, no JSON here`;

    const result = await runLlmParseSweep({
      db: harness.db,
      parse: (text) => parseReceiptText(modelReplying(reply), text),
      failureCounts: new Map([[receiptId, MAX_PARSE_ATTEMPTS - 1]]),
    });
    expect(result.failed).toEqual([
      { id: receiptId, error: expect.any(Error), abandoned: true },
    ]);

    const rows = await harness.db
      .select({ llmSuggestions: receipts.llmSuggestions })
      .from(receipts)
      .where(eq(receipts.id, receiptId));
    const record = rows[0]?.llmSuggestions;
    expect(record).toMatchObject({
      error: "Model response was not parseable JSON",
      attempts: MAX_PARSE_ATTEMPTS,
      suggestions: null,
    });
    // The whole stored row, not just the field we expected to be clean.
    expect(JSON.stringify(record)).not.toContain(VENDOR_HEAD);
  });

  it("redacts a failure that stops the whole sweep, not only a single row's", async () => {
    // The drain's own catch - the second of the two lines PR-2 changed, and
    // the one no test pointed at. Reached when the sweep throws outside the
    // per-row try: here, the SELECT that chooses rows.
    const brokenDb = {
      select() {
        throw Object.assign(
          new Error(
            `Failed query: select ... from receipts\nparams: ${VENDOR},${TAX_NUMBER}`,
          ),
          // The marker that tells errorSummary this is a database error and
          // its text is not safe to reproduce.
          { query: "select ... from receipts", params: [VENDOR, TAX_NUMBER] },
        );
      },
    };

    captureConsole();
    const sweep = createLlmParseSweep({
      db: brokenDb as unknown as Parameters<typeof createLlmParseSweep>[0]["db"],
      parse: async () => {
        throw new Error("never reached");
      },
    });
    sweep.kick();
    await vi.waitFor(
      () => {
        expect(lines.join("\n")).toContain("LLM parse sweep did not complete");
      },
      { timeout: 10_000, interval: 25 },
    );
    restoreConsole?.();

    const logs = lines.join("\n");
    expect(logs).toContain("LLM parse sweep did not complete");
    expect(logs).not.toContain(VENDOR);
    expect(logs).not.toContain(TAX_NUMBER);
    expect(logs).not.toContain("params:");
  });
});

describe("the request log", () => {
  async function captureRequest(run: () => Promise<void>): Promise<string> {
    // ⚠ Reset per capture, not only per test. `lines` is module-level and was
    // cleared in `beforeEach` alone, which is invisible while every case
    // captures exactly once and wrong the moment one captures twice:
    // `requestLine` returns the FIRST request line it can parse, so a second
    // capture in the same test silently re-reads the first capture's line.
    // Found by the two-capture case below, which passed its "rejected" leg and
    // then failed its "absent" leg against the rejected leg's own line.
    lines = [];
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
    // No Authorization header at all, so nothing was presented either.
    expect(line?.sessionPresented).toBe(false);
  });

  it("separates a rejected session from no session, which is the question this log exists to answer", async () => {
    // R3-2. The docstring on requestLog listed "whether a session was
    // presented" as the diagnostic fact it keeps in exchange for withholding
    // the user id, and the spec said so too - and the line reported only
    // whether authentication SUCCEEDED. So a client that stopped sending a
    // token and a client whose every token is being rejected produced byte-
    // identical lines, and those have opposite remedies.
    //
    // Falsification, predicted then run, both directions:
    //   Predicted: deleting `sessionPresented` from requestLog.ts fails this on
    //   `expect(rejected?.sessionPresented).toBe(true)` with undefined.
    //   Actual: exactly that, at :362. No gap.
    //   Predicted: hardcoding the field to `true` fails the absent leg.
    //   Actual: exactly that, at :363, "expected true to be false". No gap.
    // The pairing is what makes it discriminate. Asserting `true` on one line
    // alone passes against a hardcoded field, which is why the no-header case
    // must come out false in the same run.
    //
    // ⚠ The first version of this case was itself unfalsifiable, and the way it
    // failed is worth keeping. `lines` is module-level and was cleared only in
    // `beforeEach`, while `requestLine` returns the FIRST parseable request
    // line - so the second capture below re-read the first capture's line and
    // the absent leg was asserting against the rejected leg's own output. It
    // showed up as "expected true to be false" on unmutated code. `captureRequest`
    // now resets per capture; every single-capture case above is unaffected.
    const rejectedLogs = await captureRequest(async () => {
      // Genuine shape, wrong signature: this is what a revoked or forged
      // session looks like at the boundary.
      const response = await harness.request(
        "not-a-real-token.and-not-signed.by-this-server",
        "GET",
        "/api/me",
      );
      expect(response.status).toBe(401);
    });
    const rejected = requestLine(rejectedLogs);

    const absentLogs = await captureRequest(async () => {
      const response = await harness.request(null, "GET", "/api/me");
      expect(response.status).toBe(401);
    });
    const absent = requestLine(absentLogs);

    // Both are 401s and both failed to authenticate, which is precisely why
    // the status code could not separate them.
    expect(rejected?.status).toBe(401);
    expect(absent?.status).toBe(401);
    expect(rejected?.authenticated).toBe(false);
    expect(absent?.authenticated).toBe(false);

    // And this is the fact that now tells them apart.
    expect(rejected?.sessionPresented).toBe(true);
    expect(absent?.sessionPresented).toBe(false);

    // The credential itself still never reaches the log.
    expect(rejectedLogs).not.toContain("not-a-real-token");
  });

  it("reports a request that produced no response as such, rather than as a success", async () => {
    // Hono rethrows a non-Error without calling onError, so no response is
    // ever set. `c.res` would manufacture a 200 on read, which would log the
    // one request most worth seeing as a success. Driven through a bare app
    // because nothing in this codebase throws a non-Error on purpose.
    const app = new Hono();
    app.use("*", requestLog());
    app.get("/boom", () => {
      throw "not an Error";
    });

    captureConsole();
    await expect(app.request("/boom")).rejects.toBeTruthy();
    restoreConsole?.();

    const line = requestLine(lines.join("\n"));
    expect(line).toBeDefined();
    expect(line?.status).toBeNull();
    expect(line?.threw).toBe(true);
  });

  it("records a body refused before any route ran, under its own label", async () => {
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
    // N-5. This used to read "unmatched", the same string a 404 gets, and
    // the exact label is what an operator greps for, so it is pinned exactly.
    expect(line?.route).toBe("refused:body-limit");
    // The requested path is still withheld: the label is a constant, not a
    // dressed-up echo of what the client asked for.
    expect(logs).not.toContain("/api/receipts");
  });

  it("records an edge-secret refusal under its own label, not as an unmatched route", async () => {
    // N-5. Production runs with the edge secret set, so a Cloudflare
    // Transform Rule that stopped adding the header would turn every request
    // into this 403 - and every line would have said "unmatched", which is
    // also what genuine 404 noise says. The label is the only thing that
    // separates "the edge stopped fronting us" from "someone is probing
    // paths that do not exist".
    const receiptId = randomUUID();
    const logs = await captureRequest(async () => {
      const response = await fronted.request(
        null,
        "GET",
        `/api/receipts/${receiptId}`,
      );
      expect(response.status).toBe(403);
    });

    const line = requestLine(logs);
    expect(line?.status).toBe(403);
    expect(line?.route).toBe("refused:edge-secret");
    // Refused or not, the path the client asked for stays out of the log -
    // including the receipt id in it, which is a handle to a tax record.
    expect(logs).not.toContain(receiptId);
    expect(logs).not.toContain("/api/receipts");
    // And the secret the middleware compared against is not log material either.
    expect(logs).not.toContain(EDGE_SECRET);
  });

  it("still reports a genuine 404 as unmatched, so the refusals above are distinguishable from it", async () => {
    // The third leg, and the one that makes the other two mean anything: if
    // 404s were labelled too, or if the refusals fell back to this string,
    // the field would be back to answering one question with three cases.
    const nonce = randomUUID();
    const logs = await captureRequest(async () => {
      const response = await harness.request(
        token,
        "GET",
        `/api/no-such-route/${nonce}`,
      );
      expect(response.status).toBe(404);
    });

    const line = requestLine(logs);
    expect(line?.status).toBe(404);
    expect(line?.route).toBe("unmatched");
    expect(logs).not.toContain(nonce);
    expect(logs).not.toContain("no-such-route");
  });
});
