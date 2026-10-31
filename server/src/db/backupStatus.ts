import { resolveBackupStatusDir } from "./backupConfig.js";
import { readBackupStatus } from "./backupReport.js";

/**
 * "Is the backup working?", answerable by anyone, at any time, with nothing but
 * the directory it writes to. It reads `last-success.json`, `last-run.json` and
 * `pending-prune.tsv` and nothing else, so it needs no database URL, no bucket
 * and no credential, and it cannot be the thing that fails.
 *
 * Exits 1 when the last success is older than 48 hours or absent, so that
 * something else can run it and care about the exit code. A pending prune of a
 * deleted account is listed with its date and does not change the exit code.
 * Usage:
 *
 *   BACKUP_LOCAL_DIR=/absolute/path npm run db:backup-status
 */

const status = await readBackupStatus(resolveBackupStatusDir(process.env), new Date());
for (const line of status.lines) {
  console.log(line);
}
process.exitCode = status.healthy ? 0 : 1;
