/**
 * Pure configuration and guard logic for the scheduled backup (Runbook §4),
 * kept separate from `backup.ts` so the refusals are unit-testable without
 * running pg_dump or touching a bucket.
 *
 * Every value is required and nothing defaults. A backup that silently fell
 * back to the wrong database or the wrong bucket would look exactly like a
 * working one until the day it is needed, which is the §10B failure mode
 * ("an untested backup is an assumption, not a backup") in its worst form.
 */

export interface BackupConfig {
  databaseUrl: string;
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
}

const REQUIRED = [
  "DATABASE_URL",
  "BACKUP_STORAGE_ENDPOINT",
  "BACKUP_STORAGE_BUCKET",
  "BACKUP_STORAGE_ACCESS_KEY_ID",
  "BACKUP_STORAGE_SECRET_ACCESS_KEY",
] as const;

export function resolveBackupConfig(env: Record<string, string | undefined>): BackupConfig {
  const missing = REQUIRED.filter((name) => env[name] === undefined || env[name] === "");
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}. ` +
        "Nothing defaults: a backup that guessed its database or bucket " +
        "would look like a working backup until the restore that needs it.",
    );
  }

  const endpoint = env.BACKUP_STORAGE_ENDPOINT!;
  try {
    // Constructor for the validity check only; the value is used as given.
    new URL(endpoint);
  } catch {
    throw new Error(`BACKUP_STORAGE_ENDPOINT is not a URL: ${endpoint}`);
  }

  const bucket = env.BACKUP_STORAGE_BUCKET!;
  if (env.STORAGE_ENDPOINT === endpoint && env.STORAGE_BUCKET === bucket) {
    throw new Error(
      "BACKUP_STORAGE_* points at the image bucket (same endpoint and " +
        "bucket as STORAGE_*). Backups do not go where a lifecycle rule " +
        "lives - use the dedicated backup bucket (Runbook §4).",
    );
  }

  return {
    databaseUrl: env.DATABASE_URL!,
    endpoint,
    bucket,
    accessKeyId: env.BACKUP_STORAGE_ACCESS_KEY_ID!,
    secretAccessKey: env.BACKUP_STORAGE_SECRET_ACCESS_KEY!,
  };
}

/**
 * Runbook §4: pg_dump must be 16 or newer, matching the server. Anything
 * older can emit an archive the newer pg_restore refuses, and the failure
 * would surface at restore time - the one moment a backup must not fail.
 */
export function assertPgDumpVersion(versionOutput: string): number {
  const match = versionOutput.match(/pg_dump \(PostgreSQL\) (\d+)/);
  if (match === null) {
    throw new Error(
      `Could not read a version from pg_dump: "${versionOutput.trim()}". ` +
        "Install PostgreSQL 16+ client tools, or dump through the pinned " +
        "container instead (Runbook §4): docker run --rm postgres:16 pg_dump ...",
    );
  }
  const major = Number(match[1]);
  if (major < 16) {
    throw new Error(
      `pg_dump is version ${major}; the database is Postgres 16, so the ` +
        "dump must come from 16+ client tools. Install them, or use the " +
        "postgres:16 container per Runbook §4.",
    );
  }
  return major;
}

/** UTC-stamped object key: a sortable name that never collides day to day. */
export function timestampKey(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp =
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`;
  return `pg/kept-${stamp}.dump`;
}
