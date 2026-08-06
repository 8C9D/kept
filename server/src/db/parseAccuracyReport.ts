import { and, eq, isNotNull, isNull, notLike } from "drizzle-orm";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { LOCAL_DEV_DATABASE_URL } from "./client.js";
import { receipts, users } from "./schema.js";
import { cents, centsToDecimalString } from "../domain/money.js";
import {
  accuracyPercent,
  measureAccuracy,
  type MeasuredReceipt,
  type Mismatch,
} from "../domain/parseAccuracy.js";
import type { OcrFieldSuggestions } from "../domain/ocrSuggestions.js";

/**
 * `npm run parse-accuracy` - the wave-4 gate's number (spec §7.3, §9):
 * per-field parse accuracy over every receipt the real user has confirmed.
 * Confirming receipts on the phone IS the data entry; this just reads it
 * back. Dev tooling in the db:claim mould: it refuses to guess when the
 * real user is missing or ambiguous.
 */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? LOCAL_DEV_DATABASE_URL,
});
const db = drizzle(pool);

const FIELD_LABELS: Record<keyof OcrFieldSuggestions, string> = {
  totalCents: "total",
  purchasedAt: "date",
  vendor: "vendor",
  hstCents: "hst",
  subtotalCents: "subtotal",
  vendorTaxNumber: "tax number",
};

async function report() {
  const realUsers = await db
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .where(notLike(users.appleSub, "synthetic-%"));
  const realUser = realUsers[0];
  if (realUser === undefined) {
    throw new Error(
      "No real user found - sign in on a device and confirm some scanned receipts first",
    );
  }
  if (realUsers.length > 1) {
    throw new Error(
      `Found ${realUsers.length} real users; refusing to guess whose accuracy to measure`,
    );
  }

  const rows = await db
    .select()
    .from(receipts)
    .where(
      and(
        eq(receipts.userId, realUser.id),
        eq(receipts.status, "confirmed"),
        isNull(receipts.deletedAt),
        isNotNull(receipts.ocrSuggestions),
      ),
    )
    .orderBy(receipts.createdAt);

  const measured: MeasuredReceipt[] = rows.map((row) => {
    if (row.ocrSuggestions === null) {
      // Filtered to non-null above; reaching this means the query broke.
      throw new Error(`Receipt ${row.id} lost its suggestions between query and read`);
    }
    return {
      id: row.id,
      suggestions: row.ocrSuggestions,
      confirmed: {
        vendor: row.vendor,
        purchasedAt: row.purchasedAt,
        totalCents: row.totalCents,
        hstCents: row.hstCents,
        subtotalCents: row.subtotalCents,
        vendorTaxNumber: row.vendorTaxNumber,
      },
    };
  });

  const result = measureAccuracy(measured);
  const who = realUser.displayName ?? realUser.id;

  if (result.receiptCount === 0) {
    console.log(
      `No confirmed receipts with a suggestion record for ${who} yet.\n` +
        `Scan and confirm receipts on the phone, then re-run.`,
    );
    await pool.end();
    return;
  }

  console.log(
    `Parse accuracy over ${result.receiptCount} confirmed receipt${result.receiptCount === 1 ? "" : "s"} (${who})\n`,
  );
  console.log(
    padded("field", 12) +
      padded("accuracy", 10) +
      padded("kept", 6) +
      padded("fixed", 7) +
      padded("missed", 8) +
      "absent-right",
  );
  for (const tally of result.tallies) {
    const percent = accuracyPercent(tally);
    console.log(
      padded(FIELD_LABELS[tally.field], 12) +
        padded(percent === null ? "-" : `${percent}%`, 10) +
        padded(String(tally.match), 6) +
        padded(String(tally.mismatch), 7) +
        padded(String(tally.missed), 8) +
        String(tally.correctlyAbsent),
    );
  }
  console.log(
    "\nkept = suggestion confirmed unchanged · fixed = human corrected it · " +
      "missed = parser found nothing, human filled it in · " +
      "absent-right = parser found nothing and there was nothing",
  );

  if (result.mismatches.length > 0) {
    const vendorById = new Map(
      rows.map((row) => [row.id, row.vendor ?? "no vendor"]),
    );
    console.log("\nEvery correction, for diagnosing the heuristics:");
    for (const mismatch of result.mismatches) {
      const context = `${vendorById.get(mismatch.receiptId)}, ${mismatch.receiptId.slice(0, 8)}`;
      console.log(
        `  ${FIELD_LABELS[mismatch.field]}: suggested ${formatValue(mismatch.field, mismatch.suggested)}, ` +
          `confirmed ${formatValue(mismatch.field, mismatch.confirmed)} (${context})`,
      );
    }
  }

  await pool.end();
}

function formatValue(
  field: Mismatch["field"],
  value: string | number | null,
): string {
  if (value === null) {
    return "nothing";
  }
  if (typeof value === "number") {
    return `$${centsToDecimalString(cents(value))}`;
  }
  return `"${value}"`;
}

function padded(text: string, width: number): string {
  return text.padEnd(width);
}

report().catch((err) => {
  console.error(err);
  process.exit(1);
});
