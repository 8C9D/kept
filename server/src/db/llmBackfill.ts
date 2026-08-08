import Anthropic from "@anthropic-ai/sdk";
import { LOCAL_DEV_DATABASE_URL, createDb } from "./client.js";
import { assertLocalDatabase } from "./databaseUrl.js";
import {
  RECEIPT_PARSE_MODEL,
  parseReceiptText,
} from "../parse/claudeReceiptParser.js";
import { runLlmParseSweep } from "../parse/llmParseSweep.js";

/**
 * `npm run parse-llm-backfill` - run the LLM parse sweep once, from a
 * laptop, with per-receipt output and an exit code. Since Aug 8, 2026 the
 * server runs the same sweep itself (src/parse/llmParseSweep.ts, kicked at
 * startup, after captures, and on an interval); this script is the manual
 * way to run that one pass without starting a server - filling a freshly
 * claimed or seeded local database, or checking a parse fix loudly.
 *
 * The sweep core is shared, not duplicated: the null-only guarded write,
 * the confirmed-receipts-included selection, and the parse path are all
 * runLlmParseSweep's. A row another writer fills first reports as
 * superseded, which is a normal outcome now that the sweep and this script
 * can legitimately run beside each other.
 *
 * Local-database-only, same guard as db:seed and db:claim. Not because it
 * deletes anything - it does not - but because it sends receipt text to an
 * external API and writes to tax records, and pointing it at production
 * should be a decision someone makes deliberately, not a DATABASE_URL that
 * happened to be exported. Production's parsing is the server sweep's job.
 */
const databaseUrl = process.env.DATABASE_URL ?? LOCAL_DEV_DATABASE_URL;
assertLocalDatabase(
  databaseUrl,
  "DATABASE_URL",
  "this backfill sends stored receipt text to the Anthropic API and writes llm_suggestions",
);

const apiKey = process.env.ANTHROPIC_API_KEY;
if (apiKey === undefined || apiKey === "") {
  console.error(
    "ANTHROPIC_API_KEY is not set. Add it to server/.env.local (the script " +
      "loads that file the same way npm run dev does), then re-run.",
  );
  process.exit(1);
}

const { db, pool } = createDb(databaseUrl);
const client = new Anthropic({ apiKey });

async function backfill() {
  console.log(`Backfilling llm_suggestions with ${RECEIPT_PARSE_MODEL}\n`);

  const result = await runLlmParseSweep({
    db,
    parse: (ocrRawText) => parseReceiptText(client, ocrRawText),
    onRow(row, outcome, error) {
      const label = `${row.vendor ?? "no vendor"} · ${row.status} · ${row.id.slice(0, 8)}`;
      if (outcome === "failed") {
        console.error(`  FAILED      ${label}`);
        console.error(error);
      } else if (outcome === "superseded") {
        console.log(`  superseded  ${label} (another writer filled it first)`);
      } else {
        console.log(`  ok          ${label}`);
      }
    },
  });

  await pool.end();

  if (result.attempted === 0) {
    console.log(
      "Nothing to backfill: every live receipt with OCR text already has an LLM suggestion record.",
    );
    return;
  }
  console.log(
    `\n${result.written}/${result.attempted} backfilled` +
      (result.superseded > 0 ? `, ${result.superseded} superseded` : "") +
      (result.failed.length > 0
        ? `, ${result.failed.length} failed (listed above)`
        : ""),
  );
  if (result.failed.length > 0) {
    process.exit(1);
  }
}

backfill().catch((err) => {
  console.error(err);
  process.exit(1);
});
