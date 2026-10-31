import { isAbsolute } from "node:path";

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

/**
 * Which way bytes reach R2. Required rather than inferred, because the two
 * fail differently and the reason for each is an account fact: `wrangler`
 * exists because nobody ever minted the R2 keys `s3` needs, and wrangler's
 * OAuth login can read and write objects though it cannot mint tokens.
 */
export const BACKUP_TRANSPORTS = ["wrangler", "s3"] as const;
export type BackupTransportName = (typeof BACKUP_TRANSPORTS)[number];

/**
 * What `s3` mode adds. `wrangler` mode has no equivalent on purpose: its
 * credential is wrangler's own login, which never passes through this process.
 */
export interface S3BackupCredentials {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export type BackupTransportConfig = { localDir: string } & (
  | { transport: "wrangler" }
  | ({ transport: "s3" } & S3BackupCredentials)
);

export type BackupConfig = BackupTransportConfig & {
  databaseUrl: string;
  /** Where backups go. Never the image bucket. */
  bucket: string;
  /** Where receipt images live, read by the image leg. */
  sourceBucket: string;
};

const REQUIRED = [
  "DATABASE_URL",
  "BACKUP_LOCAL_DIR",
  "BACKUP_TRANSPORT",
  "BACKUP_STORAGE_BUCKET",
  "BACKUP_SOURCE_BUCKET",
] as const;

/** Required in s3 mode only: one token, scoped to both buckets. */
const S3_REQUIRED = [
  "BACKUP_STORAGE_ENDPOINT",
  "BACKUP_STORAGE_ACCESS_KEY_ID",
  "BACKUP_STORAGE_SECRET_ACCESS_KEY",
] as const;

export function resolveBackupConfig(env: Record<string, string | undefined>): BackupConfig {
  refuseMissing(env, REQUIRED);
  const transport = resolveBackupTransport(env);

  const databaseUrl = env.DATABASE_URL!;
  assertUsableDatabaseUrl(databaseUrl);

  const bucket = env.BACKUP_STORAGE_BUCKET!;
  const sourceBucket = env.BACKUP_SOURCE_BUCKET!;
  if (sourceBucket === bucket) {
    throw new Error(
      `BACKUP_SOURCE_BUCKET and BACKUP_STORAGE_BUCKET are both "${bucket}". ` +
        "A backup held in the store it protects is not a backup - use the " +
        "dedicated backup bucket (Runbook §4).",
    );
  }

  // Wrangler always means this account's R2, so it has no endpoint to compare
  // and the bucket name alone decides. In s3 mode the same name on another
  // endpoint is a different bucket.
  const sameStore = transport.transport === "wrangler" || env.STORAGE_ENDPOINT === transport.endpoint;
  if (sameStore && env.STORAGE_BUCKET === bucket) {
    throw new Error(
      "BACKUP_STORAGE_BUCKET is the image bucket (same bucket as " +
        "STORAGE_BUCKET, on the same store). Backups do not go where a " +
        "lifecycle rule lives - use the dedicated backup bucket (Runbook §4).",
    );
  }

  return { ...transport, databaseUrl, bucket, sourceBucket };
}

export type RestoreManifestSource =
  | { kind: "local"; path: string }
  | { kind: "offsite"; key: string };

export type RestoreImagesConfig = BackupTransportConfig & {
  /** Where the mirrored images and the manifest are held off-site. */
  bucket: string;
  /** The bucket being rebuilt. */
  targetBucket: string;
  manifest: RestoreManifestSource;
};

const RESTORE_REQUIRED = [
  "BACKUP_LOCAL_DIR",
  "BACKUP_TRANSPORT",
  "BACKUP_STORAGE_BUCKET",
  "RESTORE_TARGET_BUCKET",
  "RESTORE_MANIFEST",
] as const;

/**
 * `npm run db:restore-images`. DATABASE_URL and BACKUP_SOURCE_BUCKET are
 * deliberately not on this list: this runs on the day those are the things
 * that are gone, and everything it needs is in the manifest and the mirror.
 */
export function resolveRestoreImagesConfig(
  env: Record<string, string | undefined>,
): RestoreImagesConfig {
  refuseMissing(env, RESTORE_REQUIRED);
  const transport = resolveBackupTransport(env);

  const bucket = env.BACKUP_STORAGE_BUCKET!;
  const targetBucket = env.RESTORE_TARGET_BUCKET!;
  if (targetBucket === bucket) {
    throw new Error(
      `RESTORE_TARGET_BUCKET is the backup bucket ("${bucket}"). Restoring ` +
        "writes objects, and the backup is the one store a disaster recovery " +
        "must not write to.",
    );
  }

  return {
    ...transport,
    bucket,
    targetBucket,
    manifest: resolveManifestSource(env.RESTORE_MANIFEST!),
  };
}

/** `npm run db:backup-status` needs the directory and nothing else. */
export function resolveBackupStatusDir(env: Record<string, string | undefined>): string {
  refuseMissing(env, ["BACKUP_LOCAL_DIR"]);
  return resolveLocalDir(env.BACKUP_LOCAL_DIR!);
}

function resolveBackupTransport(env: Record<string, string | undefined>): BackupTransportConfig {
  const localDir = resolveLocalDir(env.BACKUP_LOCAL_DIR!);
  const transport = env.BACKUP_TRANSPORT!;
  if (transport === "wrangler") {
    return { transport, localDir };
  }
  if (transport !== "s3") {
    throw new Error(
      `BACKUP_TRANSPORT is "${transport}"; it must be one of ` +
        `${BACKUP_TRANSPORTS.join(", ")}. Nothing defaults.`,
    );
  }

  refuseMissing(env, S3_REQUIRED);
  const endpoint = env.BACKUP_STORAGE_ENDPOINT!;
  try {
    // Constructor for the validity check only; the value is used as given.
    new URL(endpoint);
  } catch {
    throw new Error(`BACKUP_STORAGE_ENDPOINT is not a URL: ${endpoint}`);
  }
  return {
    transport,
    localDir,
    endpoint,
    accessKeyId: env.BACKUP_STORAGE_ACCESS_KEY_ID!,
    secretAccessKey: env.BACKUP_STORAGE_SECRET_ACCESS_KEY!,
  };
}

function refuseMissing(env: Record<string, string | undefined>, names: readonly string[]): void {
  const missing = names.filter((name) => env[name] === undefined || env[name] === "");
  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}. ` +
        "Nothing defaults: a backup that guessed its database or bucket " +
        "would look like a working backup until the restore that needs it.",
    );
  }
}

/**
 * Relative is refused rather than resolved. The job runs from wherever npm put
 * it, and wrangler runs with this directory as its cwd, so a relative value
 * names a different place from each of them. A quoted `~` lands here too: the
 * shell does not expand it, and the error is better than a directory named `~`.
 */
function resolveLocalDir(value: string): string {
  if (!isAbsolute(value)) {
    throw new Error(`BACKUP_LOCAL_DIR must be an absolute path; got "${value}".`);
  }
  return value;
}

/** A local manifest is an absolute path; anything else must be an off-site key. */
function resolveManifestSource(value: string): RestoreManifestSource {
  if (isAbsolute(value)) {
    return { kind: "local", path: value };
  }
  if (!/^manifests\/kept-\d{8}-\d{6}\.tsv$/.test(value)) {
    throw new Error(
      `RESTORE_MANIFEST is "${value}"; it must be an absolute local path or ` +
        "an off-site key of the form manifests/kept-YYYYMMDD-HHMMSS.tsv.",
    );
  }
  return { kind: "offsite", key: value };
}

/**
 * ⚠ The value is deliberately not in either message, unlike the endpoint
 * refusal above: this one holds the production password. So is the original
 * error - `new URL` hangs the input off it as `.input`, and a logger that
 * prints the object would print the URL.
 */
function assertUsableDatabaseUrl(databaseUrl: string): void {
  let usable: boolean;
  try {
    separateDatabasePassword(databaseUrl);
    // Parsing alone proves little: any `word:anything` is a valid URL, and
    // `user:password@host` with its scheme dropped is exactly that.
    usable = /^postgres(ql)?:$/.test(new URL(databaseUrl).protocol);
  } catch {
    usable = false;
  }
  if (!usable) {
    throw new Error(
      "DATABASE_URL is not a parseable postgres:// URL, or its password is " +
        "not valid percent-encoding. (The value is withheld: it holds a password.)",
    );
  }
}

/**
 * Splits the password off a Postgres URL, so that it can reach pg_dump through
 * PGPASSWORD and never through argv.
 *
 * ⚠ argv is the leak this exists to close, twice over. It is world-readable in
 * `ps` for as long as the dump runs, and `execFileSync`'s thrown Error embeds
 * the whole command line in its message - which is how the previous version of
 * this job would have written the Neon password into its own log on any failed
 * dump. Scrubbing the text afterwards would be the fragile fix: a tool that
 * never received the password cannot echo it back in any spelling.
 */
export function separateDatabasePassword(databaseUrl: string): {
  url: string;
  password: string | undefined;
} {
  const parsed = new URL(databaseUrl);
  // libpq also accepts `?password=`, and a URL that used it must not carry the
  // secret into argv just because it was spelled the other way.
  const inQuery = parsed.searchParams.get("password");
  if (inQuery !== null) {
    parsed.searchParams.delete("password");
  }
  const inAuthority = parsed.password === "" ? undefined : decodeURIComponent(parsed.password);
  parsed.password = "";
  return { url: parsed.toString(), password: inAuthority ?? inQuery ?? undefined };
}

/** The Postgres tools one run needs: a real restore needs a real cluster. */
export const PG_TOOLS = ["pg_dump", "pg_restore", "initdb", "pg_ctl"] as const;
export type PgTool = (typeof PG_TOOLS)[number];

/**
 * Runbook §4: the tools must be 16 or newer, matching the server. An older
 * pg_dump can emit an archive the newer pg_restore refuses, and the failure
 * would surface at restore time - the one moment a backup must not fail.
 *
 * The container alternative this used to suggest does not fit any more: the
 * job starts a throwaway cluster itself, every run, so all four tools have to
 * be on this machine.
 */
export function assertPgToolVersion(tool: PgTool, versionOutput: string): number {
  const match = versionOutput.match(new RegExp(`${tool} \\(PostgreSQL\\) (\\d+)`));
  if (match === null) {
    throw new Error(
      `Could not read a version from ${tool}: "${versionOutput.trim()}". ` +
        "Install PostgreSQL 16+ and put its bin directory on PATH.",
    );
  }
  const major = Number(match[1]);
  if (major < 16) {
    throw new Error(
      `${tool} is version ${major}; the database is Postgres 16, so the ` +
        "backup needs 16+ tools. Install them and put them on PATH.",
    );
  }
  return major;
}

/** The UTC stamp one run's dump and manifest share. Sortable, and never local. */
export function backupStamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}` +
    `-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}`
  );
}

/**
 * The instant in a backup file's name, or undefined when it holds none.
 *
 * The name and not the file's mtime, because a stamp is what a dump and its
 * off-site copy share: an mtime changes with a copy or a restore, and the stamp
 * is the one record of when a dump was taken that cannot drift. Read as UTC, and
 * rebuilt to prove it was a real instant: `Date.UTC` rolls month 13 over into the
 * next year without a word, and a prune is the wrong place for that to happen.
 *
 * Hand-run dumps count, as `kept-YYYYMMDD-manual-HHMMSS`: the same UTC, spelled
 * the way the procedure before this job spelled it.
 */
export function parseBackupStamp(name: string): Date | undefined {
  const match = /^kept-(\d{4})(\d{2})(\d{2})-(?:manual-)?(\d{2})(\d{2})(\d{2})\./.exec(name);
  if (match === null) {
    return undefined;
  }
  const [, year, month, day, hour, minute, second] = match.map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const instant = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const written = `${match[1]}${match[2]}${match[3]}-${match[4]}${match[5]}${match[6]}`;
  return backupStamp(instant) === written ? instant : undefined;
}

/**
 * UTC-stamped object key: a sortable name that never collides day to day.
 * Also the dump's path under BACKUP_LOCAL_DIR, so a file and its off-site copy
 * are named the same thing.
 */
export function timestampKey(now: Date): string {
  return `pg/kept-${backupStamp(now)}.dump`;
}

/** One run's manifest, under the same relative name locally and off-site. */
export function manifestKey(now: Date): string {
  return `manifests/kept-${backupStamp(now)}.tsv`;
}

/** Where a receipt image's bytes are held off-site. */
export function mirrorObjectKey(objectKey: string): string {
  return `images/mirror/${objectKey}`;
}
