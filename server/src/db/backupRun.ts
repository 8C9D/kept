import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDb } from "./client.js";
import { restoreDump, withThrowawayCluster } from "./backupCluster.js";
import {
  manifestKey,
  separateDatabasePassword,
  timestampKey,
  type BackupConfig,
} from "./backupConfig.js";
import {
  compareTableCounts,
  countMismatches,
  type TableCount,
} from "./backupCounts.js";
import { ensurePrivateDir, sha256Hex } from "./backupFiles.js";
import { mirrorImages, type BackupImageRow } from "./backupMirror.js";
import {
  backupDestination,
  pushImagesOffsite,
  pushManifest,
  uploadVerified,
} from "./backupOffsite.js";
import {
  applyAccountPlan,
  assessDeletedAccounts,
  pendingPruneViews,
  readPendingPrunes,
  type AccountPlan,
  type PendingPrune,
} from "./backupPrune.js";
import {
  BackupLog,
  NO_IMAGES,
  readLastGreenUsers,
  writeLastRun,
  writeLastSuccess,
  type BackupImageCounts,
  type BackupRunRecord,
} from "./backupReport.js";
import {
  describeFailure,
  preflightProblems,
  runTool,
} from "./backupTools.js";
import { createBackupTransport } from "./backupTransport.js";
import { receiptImages, users } from "./schema.js";

/**
 * One backup run, in order: preflight, dump, a real restore that is compared
 * with the source, the image leg, off-site, and a record of how it went.
 *
 * The shape to keep in mind is that a run does as much as it can. An unreachable
 * image does not stop the dump reaching off-site, and a dump that went wrong does
 * not stop the run from saying so: every failure lands in the log and in
 * `last-run.json`, the run exits non-zero with all of them listed, and only a run
 * with none writes `last-success.json`.
 *
 * The opposite holds for the last step. Pruning a deleted account is the one
 * thing here that removes a backup, so it runs only after a run with no failures
 * at all has written `last-success.json`, and a run that did less than everything
 * prunes nothing (backupPrune.ts).
 */

/** A judgement: the dump was 173 KB in October 2026. Bounds a stuck pg_dump. */
const DUMP_TIMEOUT_MS = 30 * 60_000;

interface DumpFile {
  key: string;
  path: string;
  takenAt: Date;
  sha256: string;
  bytes: number;
}

interface VerifiedRestore {
  counts: TableCount[];
  images: BackupImageRow[];
  /** Every `users` row the dump held: who still exists, for the prune. */
  userIds: string[];
}

interface DumpAttempt {
  dump: DumpFile;
  /** Absent when the dump did not restore. */
  restored?: VerifiedRestore;
}

/** The time, as a parameter: a 30-day window cannot be tested by waiting for it. */
export type Clock = () => Date;

export async function runBackup(
  config: BackupConfig,
  now: Clock = () => new Date(),
): Promise<BackupRunRecord> {
  const startedAt = now();
  const log = new BackupLog();

  await prepareDirectories(config.localDir);

  let attempt: DumpAttempt | undefined;
  let imageCounts: BackupImageCounts = NO_IMAGES;

  const problems = await preflightProblems(config.transport, { cwd: config.localDir });
  problems.forEach((problem) => log.fail(`preflight: ${problem}`));
  if (problems.length === 0) {
    attempt = await dumpAndCompareWithRedo(config, log, now);
    if (attempt !== undefined) {
      imageCounts = await sendEverywhere(config, attempt, log);
    }
  }

  return finish(config, log, { startedAt, finishedAt: now(), attempt, imageCounts }, now);
}

async function prepareDirectories(localDir: string): Promise<void> {
  await ensurePrivateDir(localDir);
  // images/ is filled per key; its subdirectories are made as they are needed.
  for (const directory of ["pg", "images", "manifests"]) {
    await ensurePrivateDir(join(localDir, directory));
  }
}

/**
 * Steps 2 and 3, redone once on a count mismatch. A client can write at 02:00,
 * and the source is counted after the dump's snapshot, so one mismatch is
 * ordinary. Two means the difference is not going away, or that the restore
 * really is short, and that is a failure.
 *
 * The first dump stays on disk when the redo supersedes it. It restored, it is a
 * valid copy of a tax record, and the only routine that ever removes one is the
 * deleted-account prune.
 */
async function dumpAndCompareWithRedo(
  config: BackupConfig,
  log: BackupLog,
  now: Clock,
): Promise<DumpAttempt | undefined> {
  const first = await dumpAndCompare(config, log, now);
  if (first?.restored === undefined) {
    return first;
  }
  const firstMismatches = countMismatches(first.restored.counts);
  if (firstMismatches.length === 0) {
    return first;
  }

  log.warn(`Row counts moved during the dump (${firstMismatches.join("; ")}); redoing once`);
  const second = await dumpAndCompare(config, log, now);
  // A redo that could not restore is not better than a dump that did. The
  // failure it hit is already in the log, and the first dump still goes off-site.
  const final = second?.restored === undefined ? first : second;
  for (const mismatch of countMismatches(final.restored?.counts ?? [])) {
    log.fail(`row counts: ${mismatch}`);
  }
  return final;
}

async function dumpAndCompare(
  config: BackupConfig,
  log: BackupLog,
  now: Clock,
): Promise<DumpAttempt | undefined> {
  let dump: DumpFile;
  try {
    dump = await takeDump(config, now());
  } catch (error) {
    log.fail(`dump: ${describeFailure(error)}`);
    return undefined;
  }
  console.log(`Dump written: ${dump.key}, ${dump.bytes} bytes, sha256 ${dump.sha256}`);

  try {
    const restored = await restoreAndCompare(config, dump, log);
    console.log("Restored into a throwaway cluster and compared with the source.");
    return { dump, restored };
  } catch (error) {
    log.fail(
      `restore: ${describeFailure(error)}. The dump is kept at ${dump.path}; pg_restore's ` +
        "own output is withheld from this log because it can quote row contents, " +
        "so run pg_restore by hand against that file to read it.",
    );
    return { dump };
  }
}

/**
 * Empty is refused because pg_dump exiting 0 is not evidence. The partial file
 * is created first, empty and 600, so that a dump of the tax records never exists
 * for a moment at whatever the umask allows; pg_dump writes into it and keeps
 * the mode.
 */
async function takeDump(config: BackupConfig, takenAt: Date): Promise<DumpFile> {
  const key = timestampKey(takenAt);
  const path = join(config.localDir, key);
  const partial = `${path}.partial`;
  const { url, password } = separateDatabasePassword(config.databaseUrl);
  try {
    await writeFile(partial, "", { mode: 0o600 });
    await runTool("pg_dump", [url, "-Fc", "-f", partial], {
      timeoutMs: DUMP_TIMEOUT_MS,
      // pg_dump's stderr is the only place the reason exists, and it cannot
      // quote the password: it was never given it (separateDatabasePassword).
      stderr: "forward",
      env: password === undefined ? process.env : { ...process.env, PGPASSWORD: password },
    });
    const bytes = await readFile(partial);
    if (bytes.length === 0) {
      throw new Error("pg_dump wrote an empty file; refusing to treat it as a backup.");
    }
    await rename(partial, path);
    return { key, path, takenAt, sha256: sha256Hex(bytes), bytes: bytes.length };
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

/**
 * The cluster stays up only for this function, and the image rows are read out
 * of it here: the image leg can take many minutes, and no reason justifies a
 * restored copy of every receipt sitting in a temp directory for them.
 */
async function restoreAndCompare(
  config: BackupConfig,
  dump: DumpFile,
  log: BackupLog,
): Promise<VerifiedRestore> {
  return withThrowawayCluster(
    (message) => log.fail(message),
    async (cluster) => {
      await restoreDump(cluster, dump.path);
      const source = createDb(config.databaseUrl);
      const restored = createDb(cluster.url);
      try {
        const counts = await compareTableCounts(source.pool, restored.pool);
        const rows = await restored.db
          .select({
            id: receiptImages.id,
            userId: receiptImages.userId,
            objectKey: receiptImages.objectKey,
            sha256: receiptImages.sha256,
            deletedAt: receiptImages.deletedAt,
          })
          .from(receiptImages);
        const accounts = await restored.db.select({ id: users.id }).from(users);
        return {
          counts,
          images: rows.map(({ deletedAt, ...row }) => ({ ...row, deleted: deletedAt !== null })),
          userIds: accounts.map(({ id }) => id),
        };
      } finally {
        await source.pool.end();
        await restored.pool.end();
      }
    },
  );
}

/**
 * Steps 4 and 5. The `try` blocks are the "does as much as it can" contract: the
 * mirror failing wholesale must not stop the dump going off-site.
 */
async function sendEverywhere(
  config: BackupConfig,
  attempt: DumpAttempt,
  log: BackupLog,
): Promise<BackupImageCounts> {
  const { dump, restored } = attempt;
  const { localDir, bucket, sourceBucket } = config;
  const transport = createBackupTransport(config);

  let imageCounts: BackupImageCounts = NO_IMAGES;
  let held: BackupImageRow[] = [];

  if (restored === undefined) {
    log.fail("image leg skipped: there is no restored database to read image rows from");
  } else {
    refuseVacuousRestore(restored.counts, log);
    try {
      const mirror = await mirrorImages(restored.images, {
        localDir,
        sourceBucket,
        transport,
        log,
      });
      held = mirror.held;
      const tombstoned = restored.images.filter((row) => row.deleted).length;
      imageCounts = {
        ...NO_IMAGES,
        rows: restored.images.length,
        live: restored.images.length - tombstoned,
        tombstoned,
        alreadyMirrored: mirror.alreadyMirrored,
        fetched: mirror.fetched,
        notMirrored: restored.images.length - mirror.held.length,
      };
      console.log(
        `Image mirror: ${mirror.alreadyMirrored} already held, ${mirror.fetched} fetched, ` +
          `of ${restored.images.length} rows.`,
      );
    } catch (error) {
      log.fail(`image leg: ${describeFailure(error)}`);
    }
  }

  const dumpFailure = await uploadVerified({
    transport,
    bucket,
    key: dump.key,
    body: { file: dump.path },
    contentType: "application/octet-stream",
    sha256: dump.sha256,
  });
  if (dumpFailure === undefined) {
    console.log(`Dump off-site and read back: ${bucket}/${dump.key}`);
  } else {
    log.fail(`off-site dump ${dumpFailure}`);
  }

  if (restored !== undefined) {
    try {
      const pushed = await pushImagesOffsite(held, {
        localDir,
        bucket,
        destination: backupDestination(config),
        transport,
        log,
      });
      imageCounts = { ...imageCounts, ...pushed };
      console.log(`Images off-site: ${pushed.uploaded} uploaded, ${pushed.alreadyOffsite} held.`);
    } catch (error) {
      log.fail(`off-site images: ${describeFailure(error)}`);
    }

    try {
      await pushManifest(restored.images, {
        localDir,
        bucket,
        key: manifestKey(dump.takenAt),
        transport,
        log,
      });
    } catch (error) {
      log.fail(`manifest: ${describeFailure(error)}`);
    }
  }

  return imageCounts;
}

/**
 * Not a pass. A restore verified against no receipts has verified nothing, and
 * the same goes for images: the half of the record outside Postgres would have
 * been proved by nothing at all. The same refusal `verifyRestore` makes.
 */
function refuseVacuousRestore(counts: readonly TableCount[], log: BackupLog): void {
  for (const table of ["receipts", "receipt_images"]) {
    if ((counts.find((count) => count.table === table)?.restored ?? 0) === 0) {
      log.fail(`The restored database holds no ${table} rows, so this run verified nothing.`);
    }
  }
}

/**
 * A failure here is a run that was green until now, and it is the owner's to look
 * at: a broken entry could be a prune aimed at the wrong account.
 */
async function readPendingForRun(localDir: string, log: BackupLog): Promise<PendingPrune[]> {
  try {
    const { entries, problems } = await readPendingPrunes(localDir);
    problems.forEach((problem) => log.fail(`deleted-account prune: ${problem}`));
    return entries;
  } catch (error) {
    log.fail(`deleted-account prune: ${describeFailure(error)}`);
    return [];
  }
}

/**
 * Before `last-success.json`, on purpose: a run that finds every known user gone
 * has found a database that is not the one it has been backing up, and a failure
 * here keeps that run from claiming success. That is also what makes the refusal
 * last: the file holding the users it compared against does not move on. Acting on
 * the plan comes after. This reads only, so a refusal leaves `pending-prune.tsv`
 * exactly as it was.
 */
async function assessAccounts(
  config: BackupConfig,
  log: BackupLog,
  attempt: DumpAttempt | undefined,
  pending: readonly PendingPrune[],
  now: Clock,
): Promise<AccountPlan | undefined> {
  if (attempt?.restored === undefined || log.failures.length > 0) {
    return undefined;
  }
  try {
    const outcome = await assessDeletedAccounts({
      localDir: config.localDir,
      destination: backupDestination(config),
      pending,
      lastGreenUsers: await readLastGreenUsers(config.localDir),
      restoredUsers: attempt.restored.userIds,
      dumpKey: attempt.dump.key,
      now: now(),
    });
    if ("refused" in outcome) {
      log.fail(`deleted-account prune: ${outcome.refused}`);
      return undefined;
    }
    return outcome;
  } catch (error) {
    log.fail(`deleted-account prune: ${describeFailure(error)}`);
    return undefined;
  }
}

/**
 * A record that cannot be written is one more failure rather than a crash: the
 * summary still has to reach the log, and the exit code still has to be honest.
 *
 * The prune comes after `last-success.json`, and that order is the guard: a plan
 * is carried out only if the failure list is still empty once that file is on
 * disk. A prune that then fails is listed like any other failure and exits
 * non-zero, and the success stands, because the backup it describes is restored
 * and off-site whatever happened to the deletes. Otherwise one stuck delete would
 * read as the whole backup having stopped.
 */
async function finish(
  config: BackupConfig,
  log: BackupLog,
  run: {
    startedAt: Date;
    finishedAt: Date;
    attempt: DumpAttempt | undefined;
    imageCounts: BackupImageCounts;
  },
  now: Clock,
): Promise<BackupRunRecord> {
  const { attempt } = run;
  let pending = await readPendingForRun(config.localDir, log);
  const plan = await assessAccounts(config, log, attempt, pending, now);

  const buildRecord = (finishedAt: Date): BackupRunRecord => ({
    startedAt: run.startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    ok: log.failures.length === 0 && attempt !== undefined,
    ...(attempt === undefined
      ? {}
      : {
          dump: {
            key: attempt.dump.key,
            sha256: attempt.dump.sha256,
            bytes: attempt.dump.bytes,
          },
        }),
    tableCounts: Object.fromEntries(
      (attempt?.restored?.counts ?? []).map(({ table, restored }) => [table, restored]),
    ),
    imageCounts: run.imageCounts,
    pendingPrunes: pendingPruneViews(pending),
    failures: log.failures,
    warnings: log.warnings,
  });

  const green = buildRecord(run.finishedAt);
  if (green.ok && green.dump !== undefined) {
    try {
      await writeLastSuccess(
        config.localDir,
        { ...green, dump: green.dump },
        attempt?.restored?.userIds,
      );
    } catch (error) {
      log.fail(`last-success.json: ${describeFailure(error)}`);
    }
  }

  if (plan !== undefined && log.failures.length === 0) {
    try {
      pending = await applyAccountPlan(
        plan,
        {
          localDir: config.localDir,
          bucket: config.bucket,
          destination: backupDestination(config),
          transport: createBackupTransport(config),
          log,
        },
        now(),
      );
    } catch (error) {
      log.fail(`deleted-account prune: ${describeFailure(error)}`);
    }
  }

  const record = buildRecord(now());
  try {
    await writeLastRun(config.localDir, record);
  } catch (error) {
    log.fail(`last-run.json: ${describeFailure(error)}`);
    return buildRecord(now());
  }
  return record;
}
