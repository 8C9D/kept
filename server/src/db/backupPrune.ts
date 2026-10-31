import { readdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import { mirrorObjectKey, parseBackupStamp } from "./backupConfig.js";
import { readIfPresent, writeFileAtomically } from "./backupFiles.js";
import {
  deleteVerified,
  isIssuedManifestKey,
  isUserIdShaped,
  ledgerFile,
  ledgerKeysOf,
  ledgerOwners,
  ledgerWithoutUser,
} from "./backupOffsite.js";
import type { BackupLog } from "./backupReport.js";
import {
  IMAGE_CONCURRENCY,
  describeFailure,
  forEachConcurrently,
  type Sleep,
} from "./backupTools.js";
import type { BackupTransport } from "./backupTransport.js";

/**
 * The one thing this job is allowed to destroy, and everything that stands
 * between it and destroying the wrong thing.
 *
 * The owner's ruling: a backup must not keep a deleted account forever. Backups
 * exist to survive accidents, though, so a routine that deletes from them is the
 * most dangerous code in the job, and the design is shaped by one question:
 * what could make this delete a backup it should have kept?
 *
 *   - It keys on a USER vanishing, never on rows or images vanishing. Receipt
 *     deletion is soft, so the only thing that removes a `users` row is
 *     `DELETE /api/me`, and a bug or a bad migration that loses receipts or
 *     objects is not an instruction to lose the backup of them too.
 *
 *   - Nothing happens at once. A vanished user gets an entry and a notice, and
 *     `DELETED_ACCOUNT_PRUNE_DAYS` pass before anything is removed. An accidental
 *     delete is undone by restoring the row: a user who reappears is cancelled.
 *
 *   - Only a green run may act, and only `reconcileAccounts` decides. A wiped
 *     database looks exactly like every account being deleted, so "all of them at
 *     once" and "there are no users" are refusals, reported as failures, and a
 *     refusal stands until a person ends it rather than lapsing the next night.
 *
 *   - A dump is removed only if it was taken before the first dump that proved
 *     the user gone, and the newest is never removed for any reason. A restore
 *     point therefore always outlives the prune.
 *
 * The order inside a prune is the other half. wrangler cannot list a bucket, so
 * the local `pg/` and `manifests/` directories and the local mirror are the only
 * inventory of what is off-site. Every off-site delete therefore comes first,
 * and nothing local is touched until all of them are proved: a failure midway
 * leaves the inventory whole for the next run, which starts again from the top
 * and finds the finished deletes already absent, and absence is success.
 *
 * ⚠ What this does NOT reach, because no inventory of it exists here: the
 * hand-run backups from before this job (`pg/kept-YYYYMMDD-manual-*.dump` and
 * `images/{date}/...` off-site, `kept-prod-*.dump` and `images-{date}/` locally),
 * and a user who never had an image, who leaves no directory and no ledger line
 * to notice vanishing. Neither can be pruned from here: both need a person.
 */

/** The owner's ruling (2026-10-31): long enough to notice, short enough to mean it. */
export const DELETED_ACCOUNT_PRUNE_DAYS = 30;

export const PENDING_PRUNE_FILE = "pending-prune.tsv";

/** `kept-backup.sh` posts this file and removes it. See `NOTICE_TEXT`. */
export const NOTICE_FILE = "notice";

/**
 * Static and free of ids on purpose. It lands on a lock screen, and a user id
 * has no business there: `db:backup-status` says which account, at a terminal.
 */
export const NOTICE_TEXT =
  `A deleted account's backups are scheduled to be pruned in ${DELETED_ACCOUNT_PRUNE_DAYS} days. ` +
  "Run npm run db:backup-status for the date.";

const PRUNE_WINDOW_MS = DELETED_ACCOUNT_PRUNE_DAYS * 24 * 60 * 60 * 1000;

export interface PendingPrune {
  userId: string;
  /**
   * The stamp of the first dump proved not to hold this user, and not the clock
   * at the moment it was noticed. That dump is the boundary: it is the newest
   * thing that needs no pruning, so it must not sort as "before". A wall clock
   * would put it on the wrong side, and a millisecond would too, because a dump's
   * name only has seconds in it.
   */
  firstSeenAt: string;
}

/** An entry as a reader wants it: `last-run.json` and the run's summary. */
export interface PendingPruneView extends PendingPrune {
  pruneAfter: string;
}

const instant = z.iso.datetime();

/**
 * ⚠ Unlike the ledger, this is a record and not a cache: an entry that is lost
 * restarts the clock, and one misread could aim the prune somewhere else. So a
 * line that cannot be read is a problem to report and never a line to skip, the
 * job acts on nothing while one exists, and it does not rewrite the file over it.
 * `isUserIdShaped` is also what makes the id safe to put in a path.
 */
export function parsePendingPrunes(text: string): { entries: PendingPrune[]; problems: string[] } {
  const entries: PendingPrune[] = [];
  const problems: string[] = [];
  const seen = new Set<string>();
  text.split("\n").forEach((line, index) => {
    if (line === "") {
      return;
    }
    const [userId, firstSeenAt, extra] = line.split("\t");
    if (
      userId === undefined ||
      !isUserIdShaped(userId) ||
      seen.has(userId) ||
      firstSeenAt === undefined ||
      !instant.safeParse(firstSeenAt).success ||
      extra !== undefined
    ) {
      // The line number and not the line: it may hold anything.
      problems.push(`${PENDING_PRUNE_FILE} line ${index + 1} is not a readable entry`);
      return;
    }
    seen.add(userId);
    entries.push({ userId, firstSeenAt });
  });
  return { entries, problems };
}

export function formatPendingPrunes(entries: readonly PendingPrune[]): string {
  return entries.map(({ userId, firstSeenAt }) => `${userId}\t${firstSeenAt}\n`).join("");
}

export async function readPendingPrunes(
  localDir: string,
): Promise<{ entries: PendingPrune[]; problems: string[] }> {
  const bytes = await readIfPresent(join(localDir, PENDING_PRUNE_FILE));
  return bytes === undefined
    ? { entries: [], problems: [] }
    : parsePendingPrunes(Buffer.from(bytes).toString("utf8"));
}

export function pendingPruneViews(entries: readonly PendingPrune[]): PendingPruneView[] {
  return entries.map((entry) => ({
    ...entry,
    pruneAfter: new Date(new Date(entry.firstSeenAt).getTime() + PRUNE_WINDOW_MS).toISOString(),
  }));
}

function isDue(entry: PendingPrune, now: Date): boolean {
  return now.getTime() - new Date(entry.firstSeenAt).getTime() > PRUNE_WINDOW_MS;
}

export type Reconciliation =
  | { refused: string }
  | {
      /** Vanished since the last green run: scheduled now, noticed now. */
      added: PendingPrune[];
      /** Back in `users`, as after a restore. */
      cancelled: PendingPrune[];
      /** Still inside the window. */
      waiting: PendingPrune[];
      /** Past the window, and still gone. */
      due: PendingPrune[];
    };

/**
 * Who has vanished, and whether that can be believed. Pure, and the only place
 * that decides: everything after it only carries out what this returned.
 *
 * ⚠ "Every known user" is measured against the users of the last GREEN run, and
 * not against what is on disk, for a reason found the hard way. By the time this
 * runs, the image leg has already mirrored whoever is in the database, so a
 * database wiped and then signed into again has a live user in `images/` and the
 * disk says one known user survived. A snapshot from before the mirror would catch
 * that for one night, and then that user would be known and the next night would
 * schedule everybody else. This baseline cannot drift that way: a refusal writes
 * no `last-success.json`, so the baseline stands and the refusal repeats every
 * night, with nothing else to remember. It ends when the users are back, or when
 * a person removes `last-success.json`, which is that person saying this database
 * is the real one. The disk is the fallback only for a directory with no green run
 * on record, or one from before `last-success.json` carried this list.
 *
 * Entries already pending count as known too. So if the last account really is
 * deleted, this refuses every night until a person looks at it, and that is the
 * right way round: it costs a notification, and the other way costs the backup.
 */
export function reconcileAccounts(input: {
  pending: readonly PendingPrune[];
  /** Who the backup holds anything for: mirror directories and ledger owners. */
  held: ReadonlySet<string>;
  /** The users of the last green run, from `last-success.json`, if it has them. */
  lastGreenUsers?: readonly string[] | undefined;
  restoredUsers: ReadonlySet<string>;
  /** The stamp of this run's dump, as an instant. */
  seenAt: string;
  now: Date;
}): Reconciliation {
  const { pending, held, lastGreenUsers, restoredUsers, seenAt, now } = input;
  if (restoredUsers.size === 0) {
    return {
      refused:
        "the restored users table is empty, which is what a wiped database looks like, " +
        "so nothing was scheduled or pruned",
    };
  }

  const pendingIds = new Set(pending.map((entry) => entry.userId));
  const known = new Set([...(lastGreenUsers ?? held), ...pendingIds]);
  if (known.size > 0 && [...known].every((userId) => !restoredUsers.has(userId))) {
    return {
      refused:
        `all ${known.size} known user(s) are missing from the restored users table at once, ` +
        "which is what a wiped or replaced database looks like, so nothing was scheduled or " +
        "pruned. This repeats every night until they are back or a person removes " +
        "last-success.json",
    };
  }

  const stillGone = pending.filter((entry) => !restoredUsers.has(entry.userId));
  return {
    added: [...held]
      .filter((userId) => !restoredUsers.has(userId) && !pendingIds.has(userId))
      .sort()
      .map((userId) => ({ userId, firstSeenAt: seenAt })),
    cancelled: pending.filter((entry) => restoredUsers.has(entry.userId)),
    waiting: stillGone.filter((entry) => !isDue(entry, now)),
    due: stillGone.filter((entry) => isDue(entry, now)),
  };
}

export type AccountPlan = Exclude<Reconciliation, { refused: string }>;

/**
 * Reads what the backup holds and reconciles it. Writes nothing, so it can run
 * before `last-success.json` is decided: a run that refuses here has found a
 * database that is not the one it has been backing up, and that is no success.
 */
export async function assessDeletedAccounts(input: {
  localDir: string;
  destination: string;
  pending: readonly PendingPrune[];
  lastGreenUsers?: readonly string[] | undefined;
  restoredUsers: readonly string[];
  dumpKey: string;
  now: Date;
}): Promise<Reconciliation> {
  const { localDir, destination, pending, lastGreenUsers, restoredUsers, dumpKey, now } = input;
  const seenAt = parseBackupStamp(basename(dumpKey));
  if (seenAt === undefined) {
    throw new Error(`This run's dump ${dumpKey} has no readable stamp.`);
  }
  return reconcileAccounts({
    pending,
    held: await heldUsers(localDir, destination),
    lastGreenUsers,
    restoredUsers: new Set(restoredUsers),
    seenAt: seenAt.toISOString(),
    now,
  });
}

async function heldUsers(localDir: string, destination: string): Promise<Set<string>> {
  const directories = await readdir(join(localDir, "images"));
  return new Set([
    ...directories.filter(isUserIdShaped),
    ...ledgerOwners(await readLedger(ledgerPath(localDir, destination))),
  ]);
}

function ledgerPath(localDir: string, destination: string): string {
  return join(localDir, ledgerFile(destination));
}

async function readLedger(path: string): Promise<string> {
  return Buffer.from((await readIfPresent(path)) ?? new Uint8Array()).toString("utf8");
}

export interface PruneContext {
  localDir: string;
  bucket: string;
  /** Identifies the store as well as the bucket; see `ledgerFile`. */
  destination: string;
  transport: BackupTransport;
  log: BackupLog;
  wait?: Sleep;
}

/**
 * Carries out a plan and returns what is still pending. Callers call it only
 * for a green run, once `last-success.json` is on disk.
 *
 * The notice goes first, so that an entry can never exist without one: if the
 * notice fails, nothing is recorded and the next run tries both again, and if
 * the entry fails, a notice with no entry is a false alarm and not a lost one.
 *
 * ⚠ A cancelled entry past its date may be a prune that stopped midway, with some
 * images already gone from off-site and the ledger still saying they are there,
 * and that ledger is what `pushImagesOffsite` trusts. The user's lines are dropped
 * so that the next run uploads and verifies them again: the ledger is a cache, and
 * that costs one harmless re-upload. Left alone it would lose those images from
 * off-site for good, with every run reporting green.
 */
export async function applyAccountPlan(
  plan: AccountPlan,
  context: PruneContext,
  now: Date,
): Promise<PendingPrune[]> {
  const { localDir, destination, log } = context;
  const { added, cancelled, waiting, due } = plan;
  let remaining: PendingPrune[] = [...waiting, ...due, ...added];

  if (added.length > 0) {
    await writeFileAtomically(join(localDir, NOTICE_FILE), `${NOTICE_TEXT}\n`);
  }
  if (added.length > 0 || cancelled.length > 0) {
    await writeFileAtomically(join(localDir, PENDING_PRUNE_FILE), formatPendingPrunes(remaining));
  }
  for (const { userId, firstSeenAt } of added) {
    log.warn(`Deleted account ${userId} scheduled for pruning; first seen gone at ${firstSeenAt}`);
  }
  for (const entry of cancelled) {
    if (isDue(entry, now)) {
      await dropLedgerLines(ledgerPath(localDir, destination), entry.userId);
    }
    log.warn(`Prune of ${entry.userId} cancelled: the account is back in the users table`);
  }

  for (const entry of due) {
    if (await pruneAccount(entry, context)) {
      remaining = remaining.filter(({ userId }) => userId !== entry.userId);
      await writeFileAtomically(join(localDir, PENDING_PRUNE_FILE), formatPendingPrunes(remaining));
    }
  }
  return remaining;
}

/**
 * One account, start to finish. Returns whether the entry can go. Every failure
 * is this account's and the next run's: it is listed, the entry stays, and any
 * other account due tonight still gets its turn.
 */
async function pruneAccount(entry: PendingPrune, context: PruneContext): Promise<boolean> {
  const { localDir, destination, log } = context;
  const { userId } = entry;
  const label = `deleted-account prune of ${userId}`;
  const ledger = ledgerPath(localDir, destination);
  try {
    // All inventory before any delete, so that an unreadable directory stops the
    // prune with everything still in place.
    const stale = await staleBackupFiles(localDir, new Date(entry.firstSeenAt));
    const images = (await offsiteImageKeys(localDir, ledger, userId)).map(mirrorObjectKey);
    const offsite = stale.filter((file) => file.offsite).map((file) => file.key);

    const failure =
      (await deleteAllOffsite(images, context)) ?? (await deleteAllOffsite(offsite, context));
    if (failure !== undefined) {
      log.fail(`${label}: ${failure}; nothing local was removed and the entry stays`);
      return false;
    }

    for (const file of stale) {
      await rm(join(localDir, file.key), { force: true });
    }
    await dropLedgerLines(ledger, userId);
    await rm(join(localDir, "images", userId), { recursive: true, force: true });
    log.warn(
      `Pruned deleted account ${userId}: ${images.length} image(s) off-site, ` +
        `${stale.length} dump or manifest file(s) before ${entry.firstSeenAt}`,
    );
    return true;
  } catch (error) {
    log.fail(`${label}: ${describeFailure(error)}; the entry stays`);
    return false;
  }
}

interface BackupFile {
  /** The same relative name locally and off-site. */
  key: string;
  takenAt: Date;
  /** A `.partial` is a killed run's leftover and never left this machine. */
  offsite: boolean;
}

/**
 * ⚠ Dumps and manifests taken before `firstSeenAt`, less the newest of each, which
 * is kept whatever the dates say: "never delete the newest dump" is not allowed
 * to rest on the clock having been right. Everything else this function does is
 * reasoning about dates, and that line is the one that does not.
 */
async function staleBackupFiles(localDir: string, firstSeenAt: Date): Promise<BackupFile[]> {
  const stale: BackupFile[] = [];
  for (const directory of ["pg", "manifests"]) {
    const files = await listBackupFiles(localDir, directory);
    const newest = Math.max(
      ...files.filter((file) => file.offsite).map((file) => file.takenAt.getTime()),
    );
    stale.push(...files.filter(({ takenAt }) => takenAt < firstSeenAt && takenAt.getTime() < newest));
  }
  return stale;
}

/**
 * Refuses, rather than skips, a name with no readable stamp: nothing can say
 * whether that file holds the account, and skipping it would close the entry
 * with the question unanswered and nobody told. Dotfiles are Finder's, not ours.
 */
async function listBackupFiles(localDir: string, directory: string): Promise<BackupFile[]> {
  const names = await readdir(join(localDir, directory));
  return names
    .filter((name) => !name.startsWith("."))
    .map((name) => {
      const key = `${directory}/${name}`;
      const takenAt = parseBackupStamp(name);
      if (takenAt === undefined) {
        throw new Error(`${key} has no stamp this job can read; move it out of the way`);
      }
      return { key, takenAt, offsite: !name.endsWith(".partial") };
    });
}

/**
 * The ledger's keys for this user, plus every key in their mirror directory. The
 * ledger alone is what the design needs and not what it can rely on: it is a cache
 * that may be deleted at any time (`parseLedger`), so a user whose lines were lost
 * would have their images left off-site forever, with the prune reporting success.
 * A delete of a key that was never uploaded is a no-op, so the union costs one
 * call. Whatever the mirror holds that is not an issued key is scratch from a
 * killed run, which never went anywhere.
 */
async function offsiteImageKeys(
  localDir: string,
  ledger: string,
  userId: string,
): Promise<string[]> {
  const keys = new Set(ledgerKeysOf(await readLedger(ledger), userId));
  for (const key of keys) {
    if (!isIssuedManifestKey(key)) {
      throw new Error(`the ledger holds a key under this user that this system did not issue`);
    }
  }
  for (const key of await mirroredKeys(localDir, userId)) {
    keys.add(key);
  }
  return [...keys];
}

async function mirroredKeys(localDir: string, userId: string): Promise<string[]> {
  let paths: string[];
  try {
    paths = await readdir(join(localDir, "images", userId), { recursive: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return paths.map((path) => `${userId}/${path}`).filter(isIssuedManifestKey);
}

/**
 * The first failure, or undefined. Stops starting new deletes once one has
 * failed, because the next run does the whole list again anyway.
 */
async function deleteAllOffsite(
  keys: readonly string[],
  context: PruneContext,
): Promise<string | undefined> {
  const { transport, bucket, wait } = context;
  let failure: string | undefined;
  await forEachConcurrently(keys, IMAGE_CONCURRENCY, async (key) => {
    if (failure === undefined) {
      failure = await deleteVerified({ transport, bucket, key }, wait);
    }
  });
  return failure;
}

async function dropLedgerLines(path: string, userId: string): Promise<void> {
  const text = await readLedger(path);
  const kept = ledgerWithoutUser(text, userId);
  if (kept !== text) {
    await writeFileAtomically(path, kept);
  }
}
