import { and, isNotNull, isNull, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { receipts } from "../db/schema.js";
import {
  RECEIPT_PARSE_PROMPT_VERSION,
  type LlmParseFailureRecord,
  type LlmParseSuccessRecord,
} from "../domain/llmSuggestions.js";
import { redactedMessage } from "../observability/errorSummary.js";
import type { OcrFieldSuggestions } from "../domain/ocrSuggestions.js";
import { RECEIPT_PARSE_MODEL } from "./claudeReceiptParser.js";

/**
 * The server-side LLM parse runs as a sweep over rows, not inline in the
 * create route - the same reasoning as export jobs being rows rather than
 * process memory: the work's state IS the receipt row (`llm_suggestions`
 * null with `ocr_raw_text` present means "not parsed yet"), so a restart
 * loses nothing and the next sweep simply picks the row up again.
 *
 * Confirmed receipts are swept too, deliberately: a confirmed receipt
 * cannot benefit from the suggestions, but its parse grows the accuracy
 * set scored by `npm run parse-accuracy` - which is exactly what §7.3's
 * n=5 caveat needs.
 *
 * Concurrency is bounded at one request in flight, as the backfill's is,
 * and 429/5xx backoff is the SDK's built-in retry inside the injected
 * parse function. Writes keep the immutability clause: the UPDATE re-checks
 * `WHERE llm_suggestions IS NULL`, so under concurrent sweeps (a restart
 * overlapping an interval run, the backfill script beside a dev server)
 * exactly one writer lands and the other counts the row superseded.
 */

export interface SweepRow {
  id: string;
  vendor: string | null;
  status: "pending" | "confirmed";
}

export type SweepOutcome = "written" | "superseded" | "failed" | "abandoned";

/**
 * How many failed parses a receipt gets before the sweep writes a failure
 * record and stops re-selecting it. Each attempt bills the API, and the
 * kicks plus the interval mean an unbounded retry is a slow leak once the
 * backlog lands. Counted per process (a restart grants a fresh set), which
 * bounds the leak without any bookkeeping surviving anywhere but the
 * eventual failure record itself.
 */
export const MAX_PARSE_ATTEMPTS = 3;

export interface LlmParseSweepResult {
  attempted: number;
  written: number;
  /** Rows another writer filled between this sweep's read and its write. */
  superseded: number;
  /** `abandoned`: this failure was the row's last - a failure record now
   * occupies the column and no sweep will select the row again. */
  failed: { id: string; error: unknown; abandoned: boolean }[];
}

export interface LlmParseSweepDependencies {
  db: Db;
  /**
   * The one parse path (claudeReceiptParser's parseReceiptText, bound to a
   * client), injected as a value so tests exercise the sweep without an
   * Anthropic key and no second implementation ever grows here.
   */
  parse: (ocrRawText: string) => Promise<OcrFieldSuggestions>;
  /** Per-row progress, for the backfill script's console reporting. */
  onRow?: (row: SweepRow, outcome: SweepOutcome, error?: unknown) => void;
  /**
   * Per-receipt failure counts, owned by the caller so they persist across
   * sweep runs; when the count reaches MAX_PARSE_ATTEMPTS the sweep writes
   * a failure record instead of leaving the row for another retry. Absent
   * (the backfill's single manual pass), no cap applies: a failed row stays
   * null and the script exits loudly.
   */
  failureCounts?: Map<string, number>;
}

export async function runLlmParseSweep(
  deps: LlmParseSweepDependencies,
): Promise<LlmParseSweepResult> {
  const rows = await deps.db
    .select({
      id: receipts.id,
      vendor: receipts.vendor,
      status: receipts.status,
      ocrRawText: receipts.ocrRawText,
    })
    .from(receipts)
    .where(
      and(
        isNotNull(receipts.ocrRawText),
        isNull(receipts.llmSuggestions),
        isNull(receipts.deletedAt),
      ),
    )
    .orderBy(receipts.createdAt);

  const result: LlmParseSweepResult = {
    attempted: rows.length,
    written: 0,
    superseded: 0,
    failed: [],
  };

  for (const row of rows) {
    if (row.ocrRawText === null) {
      // Filtered to non-null above; reaching this means the query broke.
      throw new Error(`Receipt ${row.id} lost its OCR text between query and read`);
    }
    try {
      const suggestions = await deps.parse(row.ocrRawText);
      const record: LlmParseSuccessRecord = {
        model: RECEIPT_PARSE_MODEL,
        promptVersion: RECEIPT_PARSE_PROMPT_VERSION,
        requestedAt: new Date().toISOString(),
        suggestions,
      };
      const superseded = !(await writeIfStillNull(deps.db, row.id, record));
      deps.failureCounts?.delete(row.id);
      if (superseded) {
        // The immutability clause refused: a concurrent sweep or the
        // backfill script wrote the column first. The row reached its goal
        // state, so this is an outcome to count, not an error - but the
        // guard is still what keeps the first record immutable.
        result.superseded += 1;
        deps.onRow?.(row, "superseded");
      } else {
        result.written += 1;
        deps.onRow?.(row, "written");
      }
    } catch (error) {
      const attempts = (deps.failureCounts?.get(row.id) ?? 0) + 1;
      deps.failureCounts?.set(row.id, attempts);
      const abandoned =
        deps.failureCounts !== undefined && attempts >= MAX_PARSE_ATTEMPTS;
      if (abandoned) {
        // The failure becomes data, not just a log line: the record stops
        // the null-guard re-selecting (and re-billing) the row forever,
        // and parse-accuracy reads it as "the LLM produced nothing".
        const record: LlmParseFailureRecord = {
          model: RECEIPT_PARSE_MODEL,
          promptVersion: RECEIPT_PARSE_PROMPT_VERSION,
          requestedAt: new Date().toISOString(),
          error: redactedMessage(error),
          attempts,
          suggestions: null,
        };
        await writeIfStillNull(deps.db, row.id, record);
        deps.failureCounts?.delete(row.id);
      }
      result.failed.push({ id: row.id, error, abandoned });
      deps.onRow?.(row, abandoned ? "abandoned" : "failed", error);
    }
  }

  return result;
}

/**
 * The null-only guarded write, for success and failure records alike.
 * Returns false when the immutability clause refused because another
 * writer landed first.
 */
async function writeIfStillNull(
  db: Db,
  receiptId: string,
  record: LlmParseSuccessRecord | LlmParseFailureRecord,
): Promise<boolean> {
  const updated = await db
    .update(receipts)
    .set({ llmSuggestions: record })
    .where(and(eq(receipts.id, receiptId), isNull(receipts.llmSuggestions)))
    .returning({ id: receipts.id });
  return updated.length > 0;
}

export interface LlmParseSweepHandle {
  /**
   * Run a sweep soon, fire-and-forget. Never throws and never blocks the
   * caller: a receipt create must not fail, block, or wait on the model.
   * Kicks arriving mid-sweep coalesce into one follow-up run.
   */
  kick(): void;
}

export function createLlmParseSweep(
  deps: Omit<LlmParseSweepDependencies, "onRow" | "failureCounts">,
): LlmParseSweepHandle {
  let running = false;
  let rerunRequested = false;
  // Owned here so the count survives across kicks and interval runs; a
  // restart grants every failing row a fresh MAX_PARSE_ATTEMPTS.
  const failureCounts = new Map<string, number>();

  async function drain(): Promise<void> {
    running = true;
    try {
      do {
        rerunRequested = false;
        const result = await runLlmParseSweep({ ...deps, failureCounts });
        if (result.attempted > 0) {
          console.log(
            `LLM parse sweep: ${result.written} written, ` +
              `${result.superseded} superseded, ${result.failed.length} failed ` +
              `of ${result.attempted}`,
          );
        }
        for (const failure of result.failed) {
          // Receipt id only - never the OCR text or a vendor name; server
          // logs carry no receipt contents (spec §10B).
          console.error(
            failure.abandoned
              ? `LLM parse failed for receipt ${failure.id} for the ` +
                  `${MAX_PARSE_ATTEMPTS}th time; failure record written, ` +
                  `no further retries`
              : `LLM parse failed for receipt ${failure.id}; a later sweep retries it`,
          );
          console.error(failure.error);
        }
      } while (rerunRequested);
    } finally {
      running = false;
    }
  }

  return {
    kick() {
      if (running) {
        rerunRequested = true;
        return;
      }
      drain().catch((error) => {
        // runLlmParseSweep only throws before any parse (the select) or on
        // a broken query invariant; per-row failures are already contained.
        console.error("LLM parse sweep did not complete");
        console.error(error);
      });
    },
  };
}
