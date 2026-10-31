import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { writeFileAtomically } from "./backupFiles.js";
import {
  PENDING_PRUNE_FILE,
  pendingPruneViews,
  readPendingPrunes,
  type PendingPruneView,
} from "./backupPrune.js";

/**
 * What a run says about itself: the failures and warnings it collects, the two
 * records it leaves behind, and the reading of those records that
 * `db:backup-status` does with no credentials at all.
 *
 * Two files, because they answer different questions. `last-run.json` says what
 * happened last, whatever that was. `last-success.json` is the only claim that a
 * good backup exists, so nothing writes it unless every step was green: a job
 * that has been failing for a month must not be able to look like one that ran
 * this morning.
 *
 * A failed prune of a deleted account is the one failure that comes after that
 * file: it is a failure of the job, listed in `last-run.json` and exiting
 * non-zero, and not of the backup, which by then is restored and off-site.
 */

export const LAST_SUCCESS_FILE = "last-success.json";
export const LAST_RUN_FILE = "last-run.json";

/**
 * Two missed nights rather than one, so a laptop closed through a night's slot
 * does not page anyone: launchd runs a missed slot at next wake, which can put
 * two successes nearly 48 hours apart in ordinary use.
 */
export const STALE_AFTER_MS = 48 * 60 * 60 * 1000;

/**
 * Collects what went wrong as it goes. Printed as it happens as well as in the
 * summary, so that a run killed halfway has still told its log something.
 *
 * Every string put here reaches a log and a file on disk, so none may contain a
 * secret or a receipt's contents; object keys and digests are what they name.
 */
export class BackupLog {
  readonly failures: string[] = [];
  readonly warnings: string[] = [];

  fail(message: string): void {
    this.failures.push(message);
    console.error(`FAILED: ${message}`);
  }

  warn(message: string): void {
    this.warnings.push(message);
    console.error(`warning: ${message}`);
  }
}

export interface BackupImageCounts {
  rows: number;
  live: number;
  tombstoned: number;
  /** Already in the mirror, hashing to the row: not fetched. */
  alreadyMirrored: number;
  /** Fetched from the source this run and written to the mirror. */
  fetched: number;
  /** Rows with no good mirror copy after this run. */
  notMirrored: number;
  /** Uploaded off-site and verified this run. */
  uploaded: number;
  /** Already in the ledger: not uploaded. */
  alreadyOffsite: number;
}

export const NO_IMAGES: BackupImageCounts = {
  rows: 0,
  live: 0,
  tombstoned: 0,
  alreadyMirrored: 0,
  fetched: 0,
  notMirrored: 0,
  uploaded: 0,
  alreadyOffsite: 0,
};

export interface BackupRunRecord {
  startedAt: string;
  finishedAt: string;
  ok: boolean;
  dump?: { key: string; sha256: string; bytes: number };
  /** Rows per table in the RESTORED database; null where the table is absent. */
  tableCounts: Record<string, number | null>;
  imageCounts: BackupImageCounts;
  /** Deleted accounts waiting out their window, after this run. */
  pendingPrunes: PendingPruneView[];
  failures: string[];
  warnings: string[];
}

export async function writeLastRun(localDir: string, record: BackupRunRecord): Promise<void> {
  await writeJson(join(localDir, LAST_RUN_FILE), record);
}

/**
 * Only ever called with a green run; `last-success.json` must not lie.
 *
 * `userIds` is what makes this file the prune's baseline: the accounts of the last
 * run nothing was wrong with (`reconcileAccounts` has the reasoning).
 */
export async function writeLastSuccess(
  localDir: string,
  record: BackupRunRecord & { dump: NonNullable<BackupRunRecord["dump"]> },
  userIds: readonly string[] = [],
): Promise<void> {
  await writeJson(join(localDir, LAST_SUCCESS_FILE), {
    time: record.finishedAt,
    dumpKey: record.dump.key,
    sha256: record.dump.sha256,
    tableCounts: record.tableCounts,
    imageCounts: record.imageCounts,
    userIds,
  });
}

const lastGreenUsersSchema = z.object({ userIds: z.array(z.string()).min(1) });

/**
 * The users of the last green run, or undefined when no record says. Unreadable
 * counts as absent here as it does for `db:backup-status`, and the fallback is the
 * disk, which is weaker and is stated as such in `reconcileAccounts`.
 */
export async function readLastGreenUsers(localDir: string): Promise<string[] | undefined> {
  const record = await readRecord(join(localDir, LAST_SUCCESS_FILE), lastGreenUsersSchema);
  return record.state === "ok" ? record.value.userIds : undefined;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFileAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** The run's last word: what a person reads in the log the morning after. */
export function formatRunSummary(record: BackupRunRecord): string {
  const lines = [
    record.ok
      ? "Backup complete: restored, verified and off-site."
      : `BACKUP FAILED - ${record.failures.length} problem(s):`,
    ...record.failures.map((failure) => `  - ${failure}`),
  ];
  if (record.dump !== undefined) {
    lines.push(
      `Dump: ${record.dump.key}, ${record.dump.bytes} bytes, sha256 ${record.dump.sha256}`,
      record.ok ? "" : "The local dump is kept.",
    );
  }
  const tables = Object.entries(record.tableCounts);
  if (tables.length > 0) {
    lines.push(`Restored rows: ${tables.map(([table, n]) => `${table} ${n}`).join(", ")}`);
  }
  const images = record.imageCounts;
  lines.push(
    `Images: ${images.rows} rows (${images.live} live, ${images.tombstoned} tombstoned); ` +
      `mirror ${images.alreadyMirrored} held, ${images.fetched} fetched, ` +
      `${images.notMirrored} not mirrored; ` +
      `off-site ${images.alreadyOffsite} held, ${images.uploaded} uploaded`,
  );
  if (record.pendingPrunes.length > 0) {
    lines.push(
      `${record.pendingPrunes.length} deleted account(s) pending prune:`,
      ...record.pendingPrunes.map(pendingPruneLine),
    );
  }
  if (record.warnings.length > 0) {
    lines.push(
      `${record.warnings.length} warning(s):`,
      ...record.warnings.map((warning) => `  - ${warning}`),
    );
  }
  return lines.filter((line) => line !== "").join("\n");
}

function pendingPruneLine({ userId, firstSeenAt, pruneAfter }: PendingPruneView): string {
  return `  - ${userId}: first seen gone ${firstSeenAt}, pruned after ${pruneAfter}`;
}

const lastSuccessSchema = z.object({
  time: z.iso.datetime(),
  dumpKey: z.string(),
  sha256: z.string(),
});

const lastRunSchema = z.object({
  finishedAt: z.iso.datetime(),
  ok: z.boolean(),
  failures: z.array(z.string()),
  warnings: z.array(z.string()),
});

export type RecordRead<T> = { state: "absent" } | { state: "unreadable" } | { state: "ok"; value: T };

export interface BackupStatus {
  healthy: boolean;
  lines: string[];
}

/**
 * Whether the last success is recent enough, and what the last run said.
 * Healthy turns on `last-success.json` alone: a failed run last night with a
 * good one the night before is worth reading about, not paging about.
 *
 * Unreadable counts as absent. A record that cannot be parsed cannot be evidence
 * of a backup, and the fix is the same either way: look at the job.
 *
 * A pending prune is never unhealthy: it is the job doing what it was told. It
 * is shown so that the 30 days it exists for are days somebody can read it in.
 */
export function assessBackupStatus(input: {
  lastSuccess: RecordRead<z.infer<typeof lastSuccessSchema>>;
  lastRun: RecordRead<z.infer<typeof lastRunSchema>>;
  pendingPrunes?: RecordRead<PendingPruneView[]>;
  now: Date;
}): BackupStatus {
  const lines: string[] = [];
  let healthy = false;

  const { lastSuccess, lastRun, pendingPrunes, now } = input;
  if (lastSuccess.state === "ok") {
    const ageMs = now.getTime() - new Date(lastSuccess.value.time).getTime();
    healthy = ageMs <= STALE_AFTER_MS;
    lines.push(
      `Last success: ${lastSuccess.value.time} (${formatAge(ageMs)} ago)` +
        `${healthy ? "" : ` - STALE, older than ${STALE_AFTER_MS / 3_600_000} hours`}`,
      `  ${lastSuccess.value.dumpKey} sha256 ${lastSuccess.value.sha256}`,
    );
  } else {
    lines.push(
      lastSuccess.state === "absent"
        ? `Last success: NONE - no ${LAST_SUCCESS_FILE} in this directory`
        : `Last success: UNREADABLE - ${LAST_SUCCESS_FILE} could not be parsed`,
    );
  }

  if (lastRun.state === "ok") {
    const { finishedAt, ok, failures, warnings } = lastRun.value;
    lines.push(
      `Last run: ${finishedAt} (${formatAge(now.getTime() - new Date(finishedAt).getTime())} ago) ` +
        `${ok ? "ok" : `FAILED with ${failures.length} problem(s):`}`,
      ...failures.map((failure) => `  - ${failure}`),
    );
    if (warnings.length > 0) {
      lines.push(`  ${warnings.length} warning(s):`, ...warnings.map((text) => `  - ${text}`));
    }
  } else {
    lines.push(
      lastRun.state === "absent"
        ? `Last run: none recorded - no ${LAST_RUN_FILE} in this directory`
        : `Last run: UNREADABLE - ${LAST_RUN_FILE} could not be parsed`,
    );
  }

  if (pendingPrunes?.state === "unreadable") {
    lines.push(`Pending prunes: UNREADABLE - no prune runs until ${PENDING_PRUNE_FILE} parses`);
  } else if (pendingPrunes?.state === "ok" && pendingPrunes.value.length > 0) {
    lines.push(
      `Pending prunes: ${pendingPrunes.value.length} deleted account(s):`,
      ...pendingPrunes.value.map(pendingPruneLine),
    );
  }

  return { healthy, lines };
}

/**
 * Reads the two records and the pending-prune file, and nothing else. No
 * credentials, no network.
 *
 * The file rather than `last-run.json`'s copy of it, because the file is what the
 * next run will act on, and a `last-run.json` written before this feature existed
 * has no such field for this to depend on.
 */
export async function readBackupStatus(localDir: string, now: Date): Promise<BackupStatus> {
  return assessBackupStatus({
    lastSuccess: await readRecord(join(localDir, LAST_SUCCESS_FILE), lastSuccessSchema),
    lastRun: await readRecord(join(localDir, LAST_RUN_FILE), lastRunSchema),
    pendingPrunes: await readPendingForStatus(localDir),
    now,
  });
}

async function readPendingForStatus(localDir: string): Promise<RecordRead<PendingPruneView[]>> {
  try {
    const { entries, problems } = await readPendingPrunes(localDir);
    return problems.length > 0
      ? { state: "unreadable" }
      : { state: "ok", value: pendingPruneViews(entries) };
  } catch {
    return { state: "unreadable" };
  }
}

async function readRecord<T>(path: string, schema: z.ZodType<T>): Promise<RecordRead<T>> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "absent" };
    }
    return { state: "unreadable" };
  }
  try {
    const parsed = schema.safeParse(JSON.parse(text));
    return parsed.success ? { state: "ok", value: parsed.data } : { state: "unreadable" };
  } catch {
    return { state: "unreadable" };
  }
}

function formatAge(ageMs: number): string {
  const hours = ageMs / 3_600_000;
  return hours < 48 ? `${hours.toFixed(1)} hours` : `${(hours / 24).toFixed(1)} days`;
}
