import { and, eq, isNotNull, isNull, notLike } from "drizzle-orm";
import { LOCAL_DEV_DATABASE_URL, createDb } from "./client.js";
import { receipts, users } from "./schema.js";
import { cents, centsToDecimalString } from "../domain/money.js";
import {
  accuracyPercent,
  compareSuggestionPaths,
  measureAccuracy,
  type AccuracyReport,
  type MeasuredReceipt,
  type Mismatch,
  type TwoPathReceipt,
} from "../domain/parseAccuracy.js";
import type { OcrFieldSuggestions } from "../domain/ocrSuggestions.js";
import { isLlmParseFailure } from "../domain/llmSuggestions.js";

/**
 * `npm run parse-accuracy` - the wave-4 gate's number (spec §7.3, §9):
 * per-field parse accuracy over every receipt the real user has confirmed.
 * Confirming receipts on the phone IS the data entry; this just reads it
 * back. Dev tooling in the db:claim mould: it refuses to guess when the
 * real user is missing or ambiguous.
 */
const { db, pool } = createDb(
  process.env.DATABASE_URL ?? LOCAL_DEV_DATABASE_URL,
);

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
  const vendorById = new Map(
    rows.map((row) => [row.id, row.vendor ?? "no vendor"]),
  );

  if (result.receiptCount === 0) {
    console.log(
      `No confirmed receipts with a suggestion record for ${who} yet.\n` +
        `Scan and confirm receipts on the phone, then re-run.`,
    );
    await pool.end();
    return;
  }

  printAccuracyTable(
    `On-device heuristics, over ${result.receiptCount} confirmed receipt${result.receiptCount === 1 ? "" : "s"} (${who})`,
    result,
  );
  console.log(
    "\nkept = suggestion confirmed unchanged · fixed = human corrected it · " +
      "missed = parser found nothing, human filled it in · " +
      "absent-right = parser found nothing and there was nothing",
  );
  printMismatches(result.mismatches, vendorById, "heuristics");

  // The LLM path, over the subset of the same receipts that carry an LLM
  // suggestion record (backfilled or, later, parsed at create).
  const llmRows = rows.filter((row) => row.llmSuggestions !== null);
  if (llmRows.length === 0) {
    console.log(
      "\nNo LLM suggestion records on any confirmed receipt yet - " +
        "run `npm run parse-llm-backfill`, then re-run this report.",
    );
    await pool.end();
    return;
  }

  // A parse-failure record (§7.3's retry cap) scores as "the LLM produced
  // nothing" - every field null, tallied as missed or absent-right. That is
  // deliberately distinct from a receipt with no record at all, which never
  // enters this table.
  const nothingSuggested: OcrFieldSuggestions = {
    vendor: null,
    purchasedAt: null,
    totalCents: null,
    hstCents: null,
    subtotalCents: null,
    vendorTaxNumber: null,
  };
  const failureCount = llmRows.filter(
    (row) => row.llmSuggestions !== null && isLlmParseFailure(row.llmSuggestions),
  ).length;
  if (failureCount > 0) {
    console.log(
      `\n${failureCount} of these carr${failureCount === 1 ? "ies" : "y"} a ` +
        `parse-failure record (the sweep gave up after repeated errors); ` +
        `scored as the LLM producing nothing.`,
    );
  }

  const llmMeasured: MeasuredReceipt[] = llmRows.map((row) => {
    if (row.llmSuggestions === null || row.ocrSuggestions === null) {
      throw new Error(`Receipt ${row.id} lost its suggestions between query and read`);
    }
    return {
      id: row.id,
      suggestions: row.llmSuggestions.suggestions ?? nothingSuggested,
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
  const llmResult = measureAccuracy(llmMeasured);
  const models = [...new Set(llmRows.map((row) => row.llmSuggestions?.model))];
  console.log("");
  printAccuracyTable(
    `LLM parse (${models.join(", ")}), over ${llmResult.receiptCount} of those receipt${llmResult.receiptCount === 1 ? "" : "s"}`,
    llmResult,
  );
  printMismatches(llmResult.mismatches, vendorById, "LLM parse");

  const twoPath: TwoPathReceipt[] = llmMeasured.map((entry) => {
    const row = llmRows.find((candidate) => candidate.id === entry.id);
    if (row?.ocrSuggestions == null) {
      throw new Error(`Receipt ${entry.id} has an LLM record but no heuristic one`);
    }
    return {
      id: entry.id,
      heuristic: row.ocrSuggestions,
      llm: entry.suggestions,
      confirmed: entry.confirmed,
    };
  });
  const disagreements = compareSuggestionPaths(twoPath);
  if (disagreements.length === 0) {
    console.log(
      "\nThe two paths agreed on every field of every receipt they both parsed.",
    );
  } else {
    console.log("\nWhere the two paths disagreed, and whom the human sided with:");
    for (const d of disagreements) {
      const context = `${vendorById.get(d.receiptId)}, ${d.receiptId.slice(0, 8)}`;
      const winner =
        d.matchedConfirmed === "neither"
          ? "neither matched the confirmed value"
          : `${d.matchedConfirmed === "llm" ? "LLM" : "heuristic"} matched the confirmed value`;
      console.log(
        `  ${FIELD_LABELS[d.field]}: heuristic ${formatValue(d.field, d.heuristicSuggested)}, ` +
          `LLM ${formatValue(d.field, d.llmSuggested)}, ` +
          `confirmed ${formatValue(d.field, d.confirmed)} - ${winner} (${context})`,
      );
    }
  }

  // §7.3's own measurement plan was ten receipts; under that, a headline
  // percentage cannot distinguish a good model from a lucky one (the owner's
  // caution, Aug 7 2026), so the report says so instead of presenting one
  // as settled.
  if (llmResult.receiptCount < 10) {
    const distinctVendors = new Set(
      llmRows.map((row) => (row.vendor ?? "no vendor").toLowerCase()),
    ).size;
    console.log(
      `\n⚠ Provisional: the two-path comparison covers ${llmResult.receiptCount} receipt${llmResult.receiptCount === 1 ? "" : "s"} ` +
        `from ${distinctVendors} distinct vendor${distinctVendors === 1 ? "" : "s"}. ` +
        `That cannot distinguish a good model from a lucky one - read the ` +
        `disagreement listing above rather than the percentages, and re-run ` +
        `after a few weeks of real use before treating §7.3's upgrade ` +
        `question as answered.`,
    );
  }

  await pool.end();
}

function printAccuracyTable(title: string, result: AccuracyReport) {
  console.log(`${title}\n`);
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
}

function printMismatches(
  mismatches: Mismatch[],
  vendorById: Map<string, string>,
  pathLabel: string,
) {
  if (mismatches.length === 0) {
    return;
  }
  console.log(`\nEvery correction, for diagnosing the ${pathLabel}:`);
  for (const mismatch of mismatches) {
    const context = `${vendorById.get(mismatch.receiptId)}, ${mismatch.receiptId.slice(0, 8)}`;
    console.log(
      `  ${FIELD_LABELS[mismatch.field]}: suggested ${formatValue(mismatch.field, mismatch.suggested)}, ` +
        `confirmed ${formatValue(mismatch.field, mismatch.confirmed)} (${context})`,
    );
  }
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
