import { describe, expect, it, vi } from "vitest";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { renderError } from "../../src/http/errors.js";
import type { Context } from "hono";
import {
  errorSummary,
  redactedMessage,
} from "../../src/observability/errorSummary.js";

/**
 * The strings a real leak put in the log during the August 2026 audit. Kept
 * verbatim so the assertions below fail on the exact exposure that happened
 * rather than on a paraphrase of it.
 */
const VENDOR = "Dr Smith Psychiatry Clinic";
const TAX_NUMBER = "123456789RT0001";
const PRIVATE_NOTE = "PRIVATE: therapy session, do not disclose";
const SQL = 'insert into "receipts" ("vendor", "ocr_raw_text", "notes") values ($1, $2, $3)';

/**
 * The real drizzle error class, wrapping a node-postgres-shaped cause -
 * not a hand-written stub. The leak lives in how DrizzleQueryError builds
 * its own message from (query, params), so a stub that merely holds those
 * as properties would test the wrong thing and pass either way.
 */
function failedQueryError(): DrizzleQueryError {
  const databaseError = Object.assign(
    new Error(`value "2147483648" is out of range for type integer`),
    {
      severity: "ERROR",
      code: "22003",
      table: "receipts",
      routine: "int4in",
      where: `PL/pgSQL function inline_code_block line 1 at SQL statement`,
      detail: `Failing row contains (${VENDOR}, ${TAX_NUMBER}, ${PRIVATE_NOTE}).`,
    },
  );
  return new DrizzleQueryError(SQL, [VENDOR, TAX_NUMBER, PRIVATE_NOTE], databaseError);
}

const SENSITIVE = [VENDOR, TAX_NUMBER, PRIVATE_NOTE, SQL, "Failing row contains"];

describe("errorSummary", () => {
  it("reproduces the leak it exists to prevent, so the test below is meaningful", () => {
    // Guard on the premise: if a future drizzle stops putting the bound
    // parameters in its own message, the assertions below would pass for a
    // reason unrelated to this module and quietly stop protecting anything.
    const raw = failedQueryError();
    expect(raw.message).toContain(PRIVATE_NOTE);
    expect(raw.message).toContain(SQL);
  });

  it("withholds every row value and the statement itself", () => {
    const summary = errorSummary(failedQueryError());
    for (const secret of SENSITIVE) {
      expect(summary).not.toContain(secret);
    }
  });

  it("still says enough to act on", () => {
    const summary = errorSummary(failedQueryError());
    expect(summary).toContain("DrizzleQueryError");
    expect(summary).toContain("code=22003");
    expect(summary).toContain("table=receipts");
  });

  it("keeps our own errors readable, message and frames intact", () => {
    const summary = errorSummary(new Error("Receipt insert returned no row"));
    expect(summary).toContain("Error: Receipt insert returned no row");
    expect(summary).toContain("at ");
  });

  it("describes a thrown non-Error by type rather than by value", () => {
    const summary = errorSummary({ vendor: VENDOR });
    expect(summary).toContain("non-Error value thrown");
    expect(summary).not.toContain(VENDOR);
  });

  it("walks the cause chain without following a cycle forever", () => {
    const inner: Error & { cause?: unknown } = new Error("inner");
    const outer = new Error("outer", { cause: inner });
    inner.cause = outer;
    expect(errorSummary(outer)).toContain("caused by");
  });
});

describe("redactedMessage", () => {
  it("says nothing about a database failure", () => {
    const message = redactedMessage(failedQueryError());
    expect(message).toBe("A database error occurred");
    for (const secret of SENSITIVE) {
      expect(message).not.toContain(secret);
    }
  });

  /**
   * The over-redaction direction. This message is written for the person
   * looking at the export screen and names the action that fixes it; a
   * blanket redaction of every error would replace it with nothing useful.
   */
  it("preserves a message written to be read by the person who hit it", () => {
    const limit = new Error(
      "Export exceeds the 256 MiB size limit; export a shorter period",
    );
    expect(redactedMessage(limit)).toBe(limit.message);
  });
});

describe("renderError", () => {
  it("logs the redacted summary, not the error", () => {
    const logged: unknown[] = [];
    const spy = vi
      .spyOn(console, "error")
      .mockImplementation((...args: unknown[]) => {
        logged.push(...args);
      });
    const context = {
      json: (body: unknown, status: number) => ({ body, status }),
    } as unknown as Context;

    try {
      renderError(failedQueryError(), context);
    } finally {
      spy.mockRestore();
    }

    const line = logged.map((entry) => String(entry)).join(" ");
    for (const secret of SENSITIVE) {
      expect(line).not.toContain(secret);
    }
    expect(line).toContain("code=22003");
  });
});
