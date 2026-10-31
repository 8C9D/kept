import { resolveRestoreImagesConfig } from "./backupConfig.js";
import { restoreImages } from "./backupImageRestore.js";

/**
 * Rebuilds a bucket from a backup manifest: `npm run db:restore-images`. The
 * rules are in `backupImageRestore.ts`. Usage:
 *
 *   BACKUP_LOCAL_DIR=/absolute/path   the mirror, if this laptop still has one
 *   BACKUP_TRANSPORT=wrangler         or s3, plus its three BACKUP_STORAGE_* values
 *   BACKUP_STORAGE_BUCKET=kept-backups
 *   RESTORE_TARGET_BUCKET=kept        never the backup bucket
 *   RESTORE_MANIFEST=manifests/kept-YYYYMMDD-HHMMSS.tsv
 *                                     an off-site key, or an absolute local path
 *   npm run db:restore-images
 *
 * Exits non-zero with every problem listed. A `MISSING` on a tombstoned row is a
 * warning only: nothing guarantees bytes behind a tombstone.
 */

const config = resolveRestoreImagesConfig(process.env);
const result = await restoreImages(config);

const summary =
  `${result.rows} manifest rows: ${result.restored} restored to ${config.targetBucket}, ` +
  `${result.alreadyPresent} already there with the right digest`;
if (result.failures.length > 0) {
  console.error(`\nIMAGES NOT RESTORED - ${result.failures.length} problem(s):`);
  for (const failure of result.failures) {
    console.error(`  - ${failure}`);
  }
}
for (const warning of result.warnings) {
  console.log(`warning: ${warning}`);
}
console.log(summary);

// process.exit for the reason backup.ts gives.
process.exit(result.failures.length > 0 ? 1 : 0);
