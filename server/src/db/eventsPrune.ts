import { lt } from "drizzle-orm";
import { LOCAL_DEV_DATABASE_URL, createDb } from "./client.js";
import { assertLocalDatabase } from "./databaseUrl.js";
import { userEvents } from "./schema.js";
import { eventRetentionCutoff } from "../domain/userEvents.js";

/**
 * `npm run events:prune` - delete `user_events` rows older than the
 * retention window (domain/userEvents.ts, `EVENT_RETENTION_DAYS`: 180
 * days). These rows are diagnostic, not tax records - spec §10B's six-year
 * retention is about `receipts` and `receipt_images` and does not apply
 * here - so pruning them on a schedule is ordinary housekeeping, not a
 * retention violation.
 *
 * Deliberately a script a person runs, not a background sweeper. This
 * project's own pattern is that work is rows and scripts are explicit -
 * see how export-job staleness (routes/exports.ts) is a status COMPUTED at
 * request time from a row's age, not a reaper process running unattended
 * against the database. The trigger for turning this into an automated job
 * (a cron beside the nightly backup, say) would be user_events actually
 * growing large enough to matter operationally - index bloat, backup size,
 * a table scan showing up in a slow-query log - not simply existing past
 * its retention window on some fixed clock, which nothing yet measures.
 *
 * Local-database-only, same guard as db:seed: an unconditional DELETE
 * pointed at production by an exported DATABASE_URL should be a decision
 * someone makes deliberately, not an accident of a leftover shell variable.
 */
const databaseUrl = process.env.DATABASE_URL ?? LOCAL_DEV_DATABASE_URL;
assertLocalDatabase(
  databaseUrl,
  "DATABASE_URL",
  "events:prune deletes every user_events row older than the retention window",
);

const { db, pool } = createDb(databaseUrl);

async function prune() {
  const cutoff = eventRetentionCutoff(new Date());
  const deleted = await db
    .delete(userEvents)
    .where(lt(userEvents.receivedAt, cutoff))
    .returning({ id: userEvents.id });

  console.log(
    `Pruned ${deleted.length} user_events row(s) received before ${cutoff.toISOString()}.`,
  );

  await pool.end();
}

prune().catch((err) => {
  console.error(err);
  process.exit(1);
});
