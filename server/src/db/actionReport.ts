import { eq } from "drizzle-orm";
import { LOCAL_DEV_DATABASE_URL, createDb } from "./client.js";
import { assertLocalDatabase } from "./databaseUrl.js";
import { receipts, userEvents } from "./schema.js";
import {
  aggregateActionReport,
  EDIT_COUNT_BUCKET_LABELS,
  type RawEvent,
} from "../domain/actionReport.js";
import type { EventAction, EventField } from "../domain/userEvents.js";

/**
 * `npm run action-report` - the report the whole logging feature exists to
 * produce (the owner's 2026-08-28 ask: "learn from usage ... a user editing
 * the total amount repeatedly signals the total-extraction path is
 * unreliable"). Reads user_events and prints which fields get edited after
 * being suggested, and how often, so a pattern like "total is being
 * hand-corrected on nearly every receipt" is visible without anyone writing
 * a query. Read-only dev tooling, in the parse-accuracy mould
 * (parseAccuracyReport.ts) - the aggregation itself lives in
 * domain/actionReport.ts, pure and unit-tested, the same split that file
 * uses.
 *
 * Not scoped to a single "real" user the way parse-accuracy is. That guard
 * exists there because the report computes one accuracy percentage, and a
 * second real user would make "whose accuracy" ambiguous. This report has
 * no such ambiguity - it aggregates across the whole household's usage,
 * which is exactly the shape of evidence the owner asked for, and there are
 * only ever two real users to begin with.
 *
 * Local-database-only, same guard as the other dev scripts: even a
 * read-only script should not be one exported DATABASE_URL away from
 * scanning the production table.
 *
 * 2026-08-28 (UX-enhancements proposal #4): LEFT JOINs `receipts` onto
 * `user_events` so the aggregator can tell "edited where a parser actually
 * suggested something" apart from "edited where nothing was suggested at
 * all". A plain JOIN would silently drop every event whose receipt has not
 * synced yet or has since been deleted - `receipt_id` carries no foreign
 * key for exactly that reason (spec §5) - and dropping rows from a count
 * is a worse error than reporting them as `unknown_receipt`, which is what
 * the aggregator does for a row this join cannot resolve.
 */
const databaseUrl = process.env.DATABASE_URL ?? LOCAL_DEV_DATABASE_URL;
assertLocalDatabase(
  databaseUrl,
  "DATABASE_URL",
  "action-report reads every row of user_events",
);

const { db, pool } = createDb(databaseUrl);

/**
 * Below this many events, a rate is a coin flip, not a finding - the same
 * caveat `parse-accuracy` states about its own 5-receipt sample. Applied to
 * every rate this report prints, not just the override rate: this table
 * will run against a handful of events at first, and a 100% figure over 3
 * of them must never read as settled.
 */
const MIN_READABLE_N = 5;

/**
 * `status` is NOT NULL on the table, so the only reason the LEFT JOIN types
 * it nullable is the no-match case - which the `receiptId === null` branch
 * has already taken. Narrowed loudly rather than defaulted: a default would
 * quietly file a real row under whichever status was chosen.
 */
function joinedStatus(status: "pending" | "confirmed" | null): "pending" | "confirmed" {
  if (status === null) {
    throw new Error("An event joined to a receipt whose status is null");
  }
  return status;
}

async function report() {
  // A LEFT JOIN, deliberately: `user_events.receipt_id` is a weak
  // reference (no FK, spec §5), so an event can legitimately name a
  // receipt this query cannot find. Those rows must still be counted - as
  // `unknown_receipt` (domain/actionReport.ts), never silently dropped.
  const rows = await db
    .select({
      action: userEvents.action,
      field: userEvents.field,
      count: userEvents.count,
      receiptId: receipts.id,
      ocrSuggestions: receipts.ocrSuggestions,
      llmSuggestions: receipts.llmSuggestions,
      status: receipts.status,
      ocrSource: receipts.ocrSource,
    })
    .from(userEvents)
    .leftJoin(receipts, eq(userEvents.receiptId, receipts.id));

  const events: RawEvent[] = rows.map((row) => ({
    // The column type is `text` (schema.ts: enforced at the schema
    // boundary, not by Postgres) - trusted here because every row was
    // written by this same server through the validated route.
    action: row.action as EventAction,
    field: row.field as EventField | null,
    count: row.count,
    receiptSuggestions:
      row.receiptId === null
        ? undefined
        : {
            ocrSuggestions: row.ocrSuggestions,
            // A parse-failure record (§7.3's retry cap) carries
            // `suggestions: null` - "the LLM produced nothing", not "the
            // LLM never ran". Either way there is no LLM value to merge.
            llmSuggestions: row.llmSuggestions?.suggestions ?? null,
            status: joinedStatus(row.status),
            ocrSource: row.ocrSource,
          },
  }));

  const result = aggregateActionReport(events);

  if (result.eventCount === 0) {
    console.log(
      "No events logged yet. POST /api/events fires from both clients as " +
        "people use the app; nothing to report until some arrive.",
    );
    await pool.end();
    return;
  }

  console.log(`User action log - ${result.eventCount} event(s)\n`);
  if (result.eventCount < MIN_READABLE_N) {
    console.log(
      `⚠ Only ${result.eventCount} event(s) total. Every rate below carries ` +
        `an (n=...) - read a row whose n is below ${MIN_READABLE_N} as "not ` +
        `enough evidence yet", not as a finding, the same way this project's ` +
        `parse-accuracy table is not read at n=5.\n`,
    );
  }

  console.log("Field editing, most-edited first:\n");
  console.log(
    padded("field", 14) +
      padded("edited", 8) +
      padded("total edits", 13) +
      padded("accepted", 10) +
      padded("overridden", 12) +
      "override rate",
  );
  for (const activity of result.fieldActivity) {
    const decided = activity.suggestionAccepted + activity.suggestionOverridden;
    console.log(
      padded(activity.field, 14) +
        padded(String(activity.editedEvents), 8) +
        padded(String(activity.editedTotal), 13) +
        padded(String(activity.suggestionAccepted), 10) +
        padded(String(activity.suggestionOverridden), 12) +
        rateWithN(activity.suggestionOverridden, decided),
    );
  }
  console.log(
    "\n'edited' = field_edited events logged · 'total edits' = their counts " +
      "summed (one save after four corrections is 1 edited, 4 total edits) · " +
      "'override rate' = overridden / (accepted + overridden), n = that " +
      "denominator",
  );

  if (result.parsePathBreakdown.length > 0) {
    console.log("\nField edits by parse path, most-edited first:\n");
    console.log(
      padded("field", 14) + padded("parse path", 16) + padded("edited (n)", 12) + "total edits",
    );
    for (const row of result.parsePathBreakdown) {
      console.log(
        padded(row.field, 14) +
          padded(row.parsePath, 16) +
          padded(`${row.editedEvents}${thinFlag(row.editedEvents)}`, 12) +
          String(row.editedTotal),
      );
    }
    console.log(
      "\n'suggested' = the field's served suggestion (heuristic or LLM) " +
        "carried a value the person then changed - the only row here that is " +
        "evidence a parse path is unreliable · 'not_suggested' = the receipt " +
        "is known but neither parser produced a value - filling a gap, not " +
        "correcting a wrong answer · 'not_parseable' = this field has no " +
        "suggestion path at all (category, notes) - always a person typing " +
        "from scratch · 'unknown_receipt' = the " +
        "event's receipt reference did not resolve (not synced yet, or since " +
        `deleted) - parse path genuinely unknown, not the same as ` +
        `'not_suggested' · '*' after edited (n) = n below ${MIN_READABLE_N}, ` +
        "too few to read as a pattern",
    );
  }

  if (result.editHistograms.length > 0) {
    console.log(
      "\nRepeat-edit distribution per field (edits to one field before one save):\n",
    );
    console.log(
      padded("field", 14) +
        EDIT_COUNT_BUCKET_LABELS.map((label) => padded(label, 8)).join(""),
    );
    for (const histogram of result.editHistograms) {
      console.log(
        padded(histogram.field, 14) +
          EDIT_COUNT_BUCKET_LABELS.map((label) =>
            padded(String(histogram.buckets[label]), 8),
          ).join(""),
      );
    }
    console.log(
      "\nEach cell counts field_edited EVENTS (one save's worth of edits to " +
        "one field on one receipt) whose count fell in that bucket - not the " +
        "'total edits' sum above. One receipt in the '6+' column is the " +
        "signal this report exists to surface: 'total is being hand-corrected " +
        "once per receipt' and 'someone is fighting the total field on one " +
        "bad receipt' look identical in a mean and different here.",
    );
  }

  console.log("\nAll actions, most frequent first:\n");
  for (const tally of result.actionTallies) {
    if (tally.count === 0) {
      continue;
    }
    console.log(`  ${padded(tally.action, 26)}${tally.count}`);
  }

  await pool.end();
}

function padded(text: string, width: number): string {
  return text.padEnd(width);
}

/** " (too thin)" appended once a count falls under MIN_READABLE_N. */
function thinFlag(n: number): string {
  return n < MIN_READABLE_N ? "*" : "";
}

/**
 * A percentage with its own denominator stated alongside it, and a plain
 * word for "too thin to read" rather than leaving the reader to notice the
 * n is small - the brief's own example: a 100% override rate over 3 events
 * must never print as an unqualified "100%".
 */
function rateWithN(numerator: number, denominator: number): string {
  if (denominator === 0) {
    return "- (n=0)";
  }
  const pct = Math.round((numerator / denominator) * 100);
  return denominator < MIN_READABLE_N
    ? `${pct}% (n=${denominator}, too few to read)`
    : `${pct}% (n=${denominator})`;
}

report().catch((err) => {
  console.error(err);
  process.exit(1);
});
