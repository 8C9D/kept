import Anthropic from "@anthropic-ai/sdk";
import { LOCAL_DEV_DATABASE_URL, createDb } from "./client.js";
import { assertLocalDatabase } from "./databaseUrl.js";
import {
  RECEIPT_PARSE_PROMPT_VERSION,
  type LlmSuggestionRecord,
} from "../domain/llmSuggestions.js";
import { OCR_SUGGESTION_FIELDS } from "../domain/ocrSuggestions.js";
import type { OcrFieldSuggestions } from "../domain/ocrSuggestions.js";
import {
  resolveReceiptParseModel,
  parseReceiptText,
} from "../parse/claudeReceiptParser.js";

// Resolved once per run, and handed to every call, so a configured
// RECEIPT_PARSE_MODEL cannot have one model do the work while another
// name is recorded (2026-08-28).
const receiptParseModel = resolveReceiptParseModel(process.env);

/**
 * `npm run parse-llm-reparse [-- <runs>]` - a one-off check, not a test, of
 * what the current prompt version would say about the confirmed receipts
 * that were already parsed under an older prompt (first run Aug 8, 2026,
 * for the verbatim-vendor rule of prompt v2). Same reasoning as
 * parse-llm-probe: it costs money and is nondeterministic, so it runs on
 * demand and its outcome gets recorded, rather than sitting in CI.
 *
 * <runs> (default 1) parses each receipt that many times, because a single
 * nondeterministic sample cannot distinguish a prompt effect from run-to-
 * run variance; the output marks each field stable or unstable across the
 * runs.
 *
 * It never writes to the database - the stored llm_suggestions records stay
 * exactly as the old prompt wrote them; that immutability is what keeps the
 * generations comparable. The only query is a SELECT.
 */
const databaseUrl = process.env.DATABASE_URL ?? LOCAL_DEV_DATABASE_URL;
assertLocalDatabase(
  databaseUrl,
  "DATABASE_URL",
  "this reparse sends stored receipt text to the Anthropic API",
);

const apiKey = process.env.ANTHROPIC_API_KEY;
if (apiKey === undefined || apiKey === "") {
  console.error("ANTHROPIC_API_KEY is not set. Add it to server/.env.local, then re-run.");
  process.exit(1);
}

const runsArg = process.argv[2];
const runs = runsArg === undefined ? 1 : Number(runsArg);
if (!Number.isInteger(runs) || runs < 1 || runs > 10) {
  console.error(`Runs per receipt must be an integer from 1 to 10, got "${runsArg}"`);
  process.exit(1);
}

// Only the pool: every query here is raw SQL, so the drizzle handle
// `createDb` also returns has no caller.
const { pool } = createDb(databaseUrl);
const client = new Anthropic({ apiKey });

function show(value: string | number | null): string {
  return value === null ? "null" : typeof value === "string" ? `"${value}"` : String(value);
}

async function reparse() {
  const result = await pool.query<{
    id: string;
    vendor: string | null;
    ocr_raw_text: string | null;
    llm_suggestions: LlmSuggestionRecord;
  }>(
    `select id, vendor, ocr_raw_text, llm_suggestions
     from receipts
     where status = 'confirmed' and llm_suggestions is not null and deleted_at is null
     order by created_at`,
  );
  if (result.rows.length === 0) {
    console.log("No confirmed receipts with an llm_suggestions record to reparse.");
    await pool.end();
    return;
  }

  console.log(
    `Reparsing ${result.rows.length} confirmed receipt${result.rows.length === 1 ? "" : "s"} ` +
      `x ${runs} run${runs === 1 ? "" : "s"} with ${receiptParseModel} ` +
      `under prompt v${RECEIPT_PARSE_PROMPT_VERSION} (read-only)\n`,
  );

  for (const row of result.rows) {
    if (row.ocr_raw_text === null) {
      throw new Error(`Receipt ${row.id} has llm_suggestions but no OCR text`);
    }
    const oldRecord = row.llm_suggestions;
    if (oldRecord.suggestions === null) {
      // A parse-failure record (§7.3's retry cap): there is no stored
      // suggestion set to compare a new prompt against.
      console.log(
        `${row.id.slice(0, 8)} skipped: parse-failure record, no suggestions to compare\n`,
      );
      continue;
    }
    const samples: OcrFieldSuggestions[] = [];
    for (let i = 0; i < runs; i += 1) {
      samples.push(await parseReceiptText(client, row.ocr_raw_text, receiptParseModel));
    }

    const oldGen = oldRecord.promptVersion ?? 1;
    console.log(`${row.id.slice(0, 8)} (old record: ${oldRecord.model}, prompt v${oldGen})`);
    console.log(
      `  vendor: old ${show(oldRecord.suggestions.vendor)} · ` +
        `new [${samples.map((s) => show(s.vendor)).join(", ")}] · ` +
        `confirmed ${show(row.vendor)}`,
    );
    console.log(
      `  date:   old ${show(oldRecord.suggestions.purchasedAt)} · ` +
        `new [${samples.map((s) => show(s.purchasedAt)).join(", ")}]`,
    );
    const unstable = OCR_SUGGESTION_FIELDS.filter((field) =>
      samples.some((s) => (s[field] ?? null) !== (samples[0]![field] ?? null)),
    );
    const driftedStable = OCR_SUGGESTION_FIELDS.filter(
      (field) =>
        !unstable.includes(field) &&
        (samples[0]![field] ?? null) !== (oldRecord.suggestions[field] ?? null),
    );
    console.log(
      `  stability: ${unstable.length === 0 ? "all fields stable across runs" : `UNSTABLE across runs: ${unstable.join(", ")}`}`,
    );
    if (driftedStable.length > 0) {
      for (const field of driftedStable) {
        console.log(
          `  drift vs old (stable): ${field}: ${show(oldRecord.suggestions[field] ?? null)} -> ${show(samples[0]![field] ?? null)}`,
        );
      }
    }
    console.log();
  }

  await pool.end();
}

reparse().catch((err) => {
  console.error(err);
  process.exit(1);
});
