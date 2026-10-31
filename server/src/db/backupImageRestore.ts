import { readFile } from "node:fs/promises";
import { mirrorObjectKey, type RestoreImagesConfig } from "./backupConfig.js";
import { ensurePrivateDir, mirrorPath, readIfPresent, sha256Hex } from "./backupFiles.js";
import { fetchWithRetries, recordUnfetched } from "./backupMirror.js";
import {
  contentTypeForKey,
  isIssuedManifestKey,
  parseManifest,
  uploadVerified,
  type ManifestRow,
} from "./backupOffsite.js";
import { BackupLog } from "./backupReport.js";
import {
  IMAGE_CONCURRENCY,
  describeFailure,
  forEachConcurrently,
  retrying,
} from "./backupTools.js";
import {
  bucketReader,
  createBackupTransport,
  type BackupTransport,
} from "./backupTransport.js";

/**
 * The disaster-recovery half of the backup: a bucket rebuilt from a manifest.
 * The database half is `pg_restore` of the off-site dump (Runbook §4); this runs
 * after it, and `db:verify-restore` proves the two meet.
 *
 * It is written around one rule: it may only ever add a missing object to the
 * target. A restore aimed at a bucket that is partly alive must not be able to
 * make things worse, so an object already there with the right bytes is left,
 * one with different bytes is reported and left, and a target that cannot say
 * which it is gets nothing written over it. The backup bucket is refused as a
 * target outright (backupConfig.ts).
 *
 * The bytes come from the local mirror when a copy there hashes to the manifest,
 * and from off-site otherwise, because the laptop is one of the things a
 * disaster can take. Every object is read back after writing.
 */

export interface ImageRestoreResult {
  rows: number;
  restored: number;
  alreadyPresent: number;
  failures: string[];
  warnings: string[];
}

export async function restoreImages(config: RestoreImagesConfig): Promise<ImageRestoreResult> {
  const log = new BackupLog();
  // Before anything else: wrangler runs with this directory as its cwd, and the
  // laptop may be new.
  await ensurePrivateDir(config.localDir);
  const transport = createBackupTransport(config);

  const result: ImageRestoreResult = {
    rows: 0,
    restored: 0,
    alreadyPresent: 0,
    failures: log.failures,
    warnings: log.warnings,
  };

  const manifest = parseManifest(await readManifest(config, transport));
  manifest.problems.forEach((problem) => log.fail(problem));
  result.rows = manifest.rows.length;
  if (manifest.rows.length === 0) {
    log.fail("The manifest names no images, so this run restored nothing.");
    return result;
  }

  const target = bucketReader(transport, config.targetBucket);
  const offsite = bucketReader(transport, config.bucket);

  await forEachConcurrently(manifest.rows, IMAGE_CONCURRENCY, async (row) => {
    try {
      if (!isIssuedManifestKey(row.objectKey)) {
        // No key in the message, for the reason `mirrorImages` gives, and this
        // one has no row id to offer instead, so it names the digest.
        log.fail(`manifest row with sha256 ${row.sha256}: object key is not one this system issued; not used`);
        return;
      }

      const present = await fetchWithRetries(target, row);
      if (present.label === "ok") {
        result.alreadyPresent += 1;
        return;
      }
      if (present.label !== "MISSING") {
        // DIGEST: something else is at this key, and it is not ours to replace.
        // UNREACHABLE: this run cannot tell, and writing blind is how a restore
        // overwrites the one good object.
        log.fail(`${present.label} ${present.failure}; nothing written to the target`);
        return;
      }

      const bytes = await sourceBytes(row, config, offsite, log);
      if (bytes === undefined) {
        return;
      }

      const failure = await uploadVerified({
        transport,
        bucket: config.targetBucket,
        key: row.objectKey,
        body: { bytes },
        contentType: contentTypeForKey(row.objectKey),
        sha256: row.sha256,
      });
      if (failure === undefined) {
        result.restored += 1;
      } else {
        log.fail(`restore ${failure}`);
      }
    } catch (error) {
      log.fail(`image ${row.objectKey}: ${describeFailure(error)}`);
    }
  });

  return result;
}

async function readManifest(
  config: RestoreImagesConfig,
  transport: BackupTransport,
): Promise<string> {
  const { manifest } = config;
  if (manifest.kind === "local") {
    return readFile(manifest.path, "utf8");
  }
  const outcome = await retrying(
    async () => {
      try {
        return { bytes: await transport.get(config.bucket, manifest.key) };
      } catch (error) {
        return { failure: describeFailure(error) };
      }
    },
    (attempt) => attempt.failure !== undefined,
  );
  if (outcome.bytes === undefined) {
    throw new Error(`Could not read ${manifest.key} from off-site: ${outcome.failure}`);
  }
  return Buffer.from(outcome.bytes).toString("utf8");
}

/** The image's bytes, from the mirror if it holds them and off-site if it does not. */
async function sourceBytes(
  row: ManifestRow,
  config: RestoreImagesConfig,
  offsite: ReturnType<typeof bucketReader>,
  log: BackupLog,
): Promise<Uint8Array | undefined> {
  const local = await readIfPresent(mirrorPath(config.localDir, row.objectKey));
  if (local !== undefined) {
    if (sha256Hex(local) === row.sha256) {
      return local;
    }
    log.warn(`${row.objectKey}: mirror copy does not hash to the manifest; using off-site`);
  }

  const fetched = await fetchWithRetries(offsite, {
    objectKey: mirrorObjectKey(row.objectKey),
    sha256: row.sha256,
  });
  if (fetched.label === "ok") {
    return fetched.bytes;
  }
  recordUnfetched(fetched, row.deleted, log);
  return undefined;
}
