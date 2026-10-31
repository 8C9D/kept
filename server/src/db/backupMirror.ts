import { dirname } from "node:path";
import type { ObjectStorage } from "../storage/objectStorage.js";
import { isIssuedObjectKey } from "../storage/objectKeys.js";
import { ensurePrivateDir, mirrorPath, readIfPresent, sha256Hex, writeFileAtomically } from "./backupFiles.js";
import type { BackupLog } from "./backupReport.js";
import {
  IMAGE_CONCURRENCY,
  describeFailure,
  forEachConcurrently,
  retrying,
  type Sleep,
} from "./backupTools.js";
import { bucketReader, type BackupTransport } from "./backupTransport.js";
import {
  fetchRestoredImage,
  type RestoredImageFetch,
  type RestoredImageRow,
} from "./restoreImageCheck.js";

/**
 * The second store. Postgres holds the records and the bucket holds the images
 * they point at, so a dump alone has restored half a receipt (Runbook §4).
 *
 * The rows come from the RESTORED database, not the source: the point is to
 * prove that what the backup says exists can be found, and the row a restore
 * would hand back is the only row whose opinion matters on the day.
 *
 * Tombstoned rows are included. A soft delete is not an erasure (§10B): those
 * bytes are retained tax records, and the only difference is that nothing
 * guarantees they are still there, so their absence warns where a live row's
 * fails.
 *
 * ⚠ An image that is mirrored and hashes to its row is skipped, which means its
 * source object is never read again. This job therefore notices damage to the
 * source only for images it has not mirrored yet: a bucket object corrupted
 * after its first backup stays undetected here, because the mirror holds the
 * good bytes and the run has no reason to look. That is the deliberate price of
 * not re-reading a growing bucket through a CLI every night.
 */
export interface BackupImageRow {
  id: string;
  userId: string;
  objectKey: string;
  sha256: string;
  deleted: boolean;
}

export interface MirrorOutcome {
  /** Rows with a local copy known to hash to the row, ready to go off-site. */
  held: BackupImageRow[];
  alreadyMirrored: number;
  fetched: number;
}

/**
 * `fetchRestoredImage`, retried while storage is not answering. MISSING is not
 * retried: that is storage answering.
 */
export function fetchWithRetries(
  storage: Pick<ObjectStorage, "download">,
  image: RestoredImageRow,
  wait?: Sleep,
): Promise<RestoredImageFetch> {
  return retrying(
    () => fetchRestoredImage(storage, image),
    (fetched) => fetched.label === "UNREACHABLE",
    wait,
  );
}

/**
 * Bytes that could not be had, and what that means for this row. One rule for
 * the backup and the restore: a tombstone excuses absence and nothing else, so
 * wrong bytes or a silent store still fail a tombstoned row.
 */
export function recordUnfetched(
  fetched: Exclude<RestoredImageFetch, { label: "ok" }>,
  deleted: boolean,
  log: BackupLog,
): void {
  if (fetched.label === "MISSING" && deleted) {
    log.warn(`MISSING on a tombstoned row, which nothing guarantees: ${fetched.failure}`);
  } else {
    log.fail(`${fetched.label} ${fetched.failure}`);
  }
}

export async function mirrorImages(
  rows: readonly BackupImageRow[],
  context: {
    localDir: string;
    sourceBucket: string;
    transport: BackupTransport;
    log: BackupLog;
    wait?: Sleep;
  },
): Promise<MirrorOutcome> {
  const { localDir, log } = context;
  const source = bucketReader(context.transport, context.sourceBucket);
  const outcome: MirrorOutcome = { held: [], alreadyMirrored: 0, fetched: 0 };

  await forEachConcurrently(rows, IMAGE_CONCURRENCY, async (row) => {
    try {
      // Before the key goes anywhere near a path. The failure names the row's
      // id rather than the key: an unissued key may name another user's prefix
      // (assertIssuedObjectKey has the reasoning), and the id finds the row.
      if (!isIssuedObjectKey(row.objectKey, row.userId)) {
        log.fail(`receipt_images row ${row.id}: object key is not one this system issued; not used`);
        return;
      }

      const path = mirrorPath(localDir, row.objectKey);
      const local = await readIfPresent(path);
      if (local !== undefined) {
        const digest = sha256Hex(local);
        if (digest === row.sha256) {
          outcome.alreadyMirrored += 1;
          outcome.held.push(row);
          return;
        }
        log.warn(`${row.objectKey}: mirror copy hashes to ${digest}, row says ${row.sha256}; re-fetching`);
      }

      const fetched = await fetchWithRetries(source, row, context.wait);

      // Only `ok` carries bytes, so wrong bytes have no path to the disk here:
      // a good local copy, or the file a re-fetch found damaged, stays as it is.
      if (fetched.label !== "ok") {
        recordUnfetched(fetched, row.deleted, log);
        return;
      }
      await ensurePrivateDir(dirname(path));
      await writeFileAtomically(path, fetched.bytes);
      outcome.fetched += 1;
      outcome.held.push(row);
    } catch (error) {
      // A full disk, a permissions failure: this row's problem, and the rest of
      // the run still has a dump to get off-site.
      log.fail(`image ${row.objectKey}: ${describeFailure(error)}`);
    }
  });

  return outcome;
}
