import { resolveBackupConfig } from "../../src/db/backupConfig.js";
import { formatRunSummary } from "../../src/db/backupReport.js";
import { runBackup } from "../../src/db/backupRun.js";

/**
 * `src/db/backup.ts` with its clock moved, for `world.runBackupAt`: a real process,
 * real pg_dump, a real restore and real storage, with one thing different. The
 * offset is read here, in tests, and nowhere in `src`, so nothing an operator can
 * set reaches the job's idea of the time.
 */

const offsetMs = Number(process.env.BACKUP_TEST_CLOCK_OFFSET_MS);
if (!Number.isFinite(offsetMs)) {
  throw new Error("BACKUP_TEST_CLOCK_OFFSET_MS must be a number of milliseconds.");
}

const record = await runBackup(
  resolveBackupConfig(process.env),
  () => new Date(Date.now() + offsetMs),
);
console.log(formatRunSummary(record));
process.exit(record.ok ? 0 : 1);
