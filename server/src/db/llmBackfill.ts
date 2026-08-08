import Anthropic from "@anthropic-ai/sdk";
import { and, isNotNull, isNull } from "drizzle-orm";
import { eq } from "drizzle-orm";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { LOCAL_DEV_DATABASE_URL } from "./client.js";
import { assertLocalDatabase } from "./databaseUrl.js";
import { receipts } from "./schema.js";
import {
  RECEIPT_PARSE_PROMPT_VERSION,
  type LlmSuggestionRecord,
} from "../domain/llmSuggestions.js";
import {
  RECEIPT_PARSE_MODEL,
  parseReceiptText,
} from "../parse/claudeReceiptParser.js";

/**
 * `npm run parse-llm-backfill` - run the LLM parse over every receipt that
 * has stored OCR text and no LLM suggestion record yet, and write the
 * result to `llm_suggestions` (ruled Aug 7, 2026; sequenced ahead of the
 * server parse so parse-accuracy can score the model against already-
 * confirmed receipts before anything ships to a client).
 *
 * The column is immutable: this script only ever fills nulls, and the
 * UPDATE re-checks that under a WHERE clause rather than trusting the
 * earlier read. Re-running is safe and does nothing.
 *
 * Local-database-only, same guard as db:seed and db:claim. Not because it
 * deletes anything - it does not - but because it sends receipt text to an
 * external API and writes to tax records, and pointing it at production
 * should be a decision someone makes deliberately, not a DATABASE_URL that
 * happened to be exported.
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

const pool = new Pool({ connectionString: databaseUrl });
const db = drizzle(pool);
const client = new Anthropic({ apiKey });

async function backfill() {
  const rows = await db
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

  if (rows.length === 0) {
    console.log(
      "Nothing to backfill: every live receipt with OCR text already has an LLM suggestion record.",
    );
    await pool.end();
    return;
  }

  console.log(
    `Backfilling ${rows.length} receipt${rows.length === 1 ? "" : "s"} with ${RECEIPT_PARSE_MODEL}\n`,
  );

  const failures: { id: string; error: unknown }[] = [];
  for (const row of rows) {
    const label = `${row.vendor ?? "no vendor"} · ${row.status} · ${row.id.slice(0, 8)}`;
    if (row.ocrRawText === null) {
      // Filtered to non-null above; reaching this means the query broke.
      throw new Error(`Receipt ${row.id} lost its OCR text between query and read`);
    }
    try {
      const suggestions = await parseReceiptText(client, row.ocrRawText);
      const record: LlmSuggestionRecord = {
        model: RECEIPT_PARSE_MODEL,
        promptVersion: RECEIPT_PARSE_PROMPT_VERSION,
        requestedAt: new Date().toISOString(),
        suggestions,
      };
      const updated = await db
        .update(receipts)
        .set({ llmSuggestions: record })
        .where(and(eq(receipts.id, row.id), isNull(receipts.llmSuggestions)))
        .returning({ id: receipts.id });
      if (updated.length === 0) {
        // The immutability clause refused: something wrote the column since
        // the select. Loud, because two writers here means a design breach.
        throw new Error("llm_suggestions was already set; refusing to overwrite");
      }
      console.log(`  ok      ${label}`);
    } catch (error) {
      failures.push({ id: row.id, error });
      console.error(`  FAILED  ${label}`);
      console.error(error);
    }
  }

  await pool.end();

  console.log(
    `\n${rows.length - failures.length}/${rows.length} backfilled` +
      (failures.length > 0 ? `, ${failures.length} failed (listed above)` : ""),
  );
  if (failures.length > 0) {
    process.exit(1);
  }
}

backfill().catch((err) => {
  console.error(err);
  process.exit(1);
});
