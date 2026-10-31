import { resolveBackupConfig } from "./backupConfig.js";
import { formatRunSummary } from "./backupReport.js";
import { runBackup } from "./backupRun.js";

/**
 * The scheduled backup Runbook §4 says retention actually rests on, and the
 * whole of it: a `pg_dump -Fc`, restored for real into a throwaway cluster and
 * compared with its source, every receipt image mirrored and hashed against the
 * row the restore handed back, and both stores put in a bucket that is not the
 * image bucket and read back to the same digests. `npm run db:backup` is the
 * only way in; `server/ops/kept-backup.sh` is how launchd runs it.
 *
 * What it replaced dumped Postgres alone, through R2 keys nobody ever minted, so
 * it refused every night from 2026-08-20 and every real backup since was a
 * hand-run procedure. This is that procedure, automated.
 *
 * One step removes rather than keeps: a green run prunes an account deleted more
 * than 30 days ago, and raises a notice when it first sees one (`backupPrune.ts`).
 *
 * The steps are in `backupRun.ts`, the refusals in `backupConfig.ts`. Nothing
 * defaults. Usage (see `server/ops/com.arthurzhang.kept-backup.plist` for the
 * scheduled form):
 *
 *   DATABASE_URL=...                   the direct, non-pooler endpoint
 *   BACKUP_LOCAL_DIR=/absolute/path    dumps, the mirror, the ledger, the records
 *   BACKUP_SOURCE_BUCKET=kept          the images
 *   BACKUP_STORAGE_BUCKET=kept-backups the backup; never the image bucket
 *   BACKUP_TRANSPORT=wrangler          wrangler's own OAuth login, or:
 *   BACKUP_TRANSPORT=s3                plus BACKUP_STORAGE_ENDPOINT, _ACCESS_KEY_ID
 *                                      and _SECRET_ACCESS_KEY, one token for both
 *
 * Exits non-zero with every problem listed if anything at all went wrong.
 * `npm run db:backup-status` reads what it left behind, with no credentials.
 */

const config = resolveBackupConfig(process.env);
const record = await runBackup(config);
console.log(formatRunSummary(record));

// process.exit rather than exitCode: a timed-out S3 call leaves its request
// behind (backupTransport.ts), and that socket must not hold launchd's slot.
process.exit(record.ok ? 0 : 1);
