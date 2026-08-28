import { LOCAL_DEV_DATABASE_URL, createDb } from "./client.js";
import { assertLocalDatabase } from "./databaseUrl.js";
import { userEvents } from "./schema.js";
import {
  aggregateActionReport,
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
 */
const databaseUrl = process.env.DATABASE_URL ?? LOCAL_DEV_DATABASE_URL;
assertLocalDatabase(
  databaseUrl,
  "DATABASE_URL",
  "action-report reads every row of user_events",
);

const { db, pool } = createDb(databaseUrl);

async function report() {
  const rows = await db
    .select({
      action: userEvents.action,
      field: userEvents.field,
      count: userEvents.count,
    })
    .from(userEvents);

  const events: RawEvent[] = rows.map((row) => ({
    // The column type is `text` (schema.ts: enforced at the schema
    // boundary, not by Postgres) - trusted here because every row was
    // written by this same server through the validated route.
    action: row.action as EventAction,
    field: row.field as EventField | null,
    count: row.count,
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
    const overrideRate =
      decided === 0
        ? "-"
        : `${Math.round((activity.suggestionOverridden / decided) * 100)}%`;
    console.log(
      padded(activity.field, 14) +
        padded(String(activity.editedEvents), 8) +
        padded(String(activity.editedTotal), 13) +
        padded(String(activity.suggestionAccepted), 10) +
        padded(String(activity.suggestionOverridden), 12) +
        overrideRate,
    );
  }
  console.log(
    "\n'edited' = field_edited events logged · 'total edits' = their counts " +
      "summed (one save after four corrections is 1 edited, 4 total edits) · " +
      "'override rate' = overridden / (accepted + overridden)",
  );

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

report().catch((err) => {
  console.error(err);
  process.exit(1);
});
