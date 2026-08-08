import Anthropic from "@anthropic-ai/sdk";
import { Pool } from "pg";
import { LOCAL_DEV_DATABASE_URL } from "./client.js";
import { assertLocalDatabase } from "./databaseUrl.js";
import type { OcrFieldSuggestions } from "../domain/ocrSuggestions.js";
import {
  RECEIPT_PARSE_MODEL,
  parseReceiptText,
} from "../parse/claudeReceiptParser.js";

/**
 * `npm run parse-llm-probe <receipt-id>` - a one-off check, not a test, that
 * the parse pipeline's output tracks the receipt's raw text and nothing else
 * (run Aug 7, 2026). It sends the receipt's ocr_raw_text to the real API
 * twice: once intact, once with every digit rotated (0->1 ... 9->0), which
 * scrambles amounts, dates, and the tax number while leaving the layout
 * alone. If the corrupted run comes back with the same values as the intact
 * run, the pipeline is reading something other than the text it claims to.
 *
 * A script rather than a test because it costs money and is nondeterministic:
 * it runs once and its outcome gets recorded, rather than sitting in CI.
 * It never writes to the database - the only query is a SELECT.
 */
const databaseUrl = process.env.DATABASE_URL ?? LOCAL_DEV_DATABASE_URL;
assertLocalDatabase(
  databaseUrl,
  "DATABASE_URL",
  "this probe sends stored receipt text to the Anthropic API",
);

const apiKey = process.env.ANTHROPIC_API_KEY;
if (apiKey === undefined || apiKey === "") {
  console.error("ANTHROPIC_API_KEY is not set. Add it to server/.env.local, then re-run.");
  process.exit(1);
}

const idArg = process.argv[2];
if (idArg === undefined || idArg === "") {
  console.error("Usage: npm run parse-llm-probe -- <receipt-id or unique prefix>");
  process.exit(1);
}

function rotateDigits(text: string): string {
  return text.replace(/[0-9]/g, (d) => String((Number(d) + 1) % 10));
}

const FIELDS = [
  "vendor",
  "purchasedAt",
  "totalCents",
  "subtotalCents",
  "hstCents",
  "vendorTaxNumber",
] as const;

const pool = new Pool({ connectionString: databaseUrl });
const client = new Anthropic({ apiKey });

async function probe() {
  const result = await pool.query<{ id: string; vendor: string | null; ocr_raw_text: string | null }>(
    "select id, vendor, ocr_raw_text from receipts where id::text like $1 || '%' and deleted_at is null",
    [idArg],
  );
  if (result.rows.length !== 1) {
    throw new Error(
      `Expected exactly one live receipt matching "${idArg}", found ${result.rows.length}`,
    );
  }
  const row = result.rows[0]!;
  if (row.ocr_raw_text === null) {
    throw new Error(`Receipt ${row.id} has no stored OCR text to probe with`);
  }

  const corruptedText = rotateDigits(row.ocr_raw_text);
  console.log(
    `Probing ${row.vendor ?? "no vendor"} · ${row.id.slice(0, 8)} with ${RECEIPT_PARSE_MODEL}`,
  );
  console.log("Corruption: every digit rotated +1 (0->1 ... 9->0)\n");

  const intact = await parseReceiptText(client, row.ocr_raw_text);
  const corrupted = await parseReceiptText(client, corruptedText);

  const width = Math.max(
    ...FIELDS.map((f) => String(intact[f] ?? "null").length),
    "intact".length,
  );
  console.log(`${"field".padEnd(16)}${"intact".padEnd(width + 2)}corrupted`);
  const differing: string[] = [];
  for (const field of FIELDS) {
    const a = intact[field] ?? null;
    const b = corrupted[field] ?? null;
    if (a !== b) differing.push(field);
    console.log(
      `${field.padEnd(16)}${String(a ?? "null").padEnd(width + 2)}${String(b ?? "null")}`,
    );
  }

  console.log(
    differing.length === 0
      ? "\nSUSPICIOUS: the corrupted run returned the same values as the intact run - the pipeline is not tracking the raw text"
      : `\nOK: corrupted run differs on ${differing.length}/${FIELDS.length} fields (${differing.join(", ")}) - the output tracks the raw text`,
  );

  await pool.end();
}

probe().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Referenced so the FIELDS list stays welded to the suggestion shape: a field
// added to OcrFieldSuggestions without a row here fails the type below.
type ProbedFields = (typeof FIELDS)[number];
const _exhaustive: keyof OcrFieldSuggestions extends ProbedFields ? true : never = true;
void _exhaustive;
