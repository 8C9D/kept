import { appendFile, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { EXTENSION_BY_CONTENT_TYPE, isIssuedObjectKey } from "../storage/objectKeys.js";
import { ObjectNotFoundError } from "../storage/objectStorage.js";
import { mirrorObjectKey, type BackupTransportConfig } from "./backupConfig.js";
import { mirrorPath, readIfPresent, sha256Hex, writeFileAtomically } from "./backupFiles.js";
import type { BackupImageRow } from "./backupMirror.js";
import type { BackupLog } from "./backupReport.js";
import {
  IMAGE_CONCURRENCY,
  describeFailure,
  forEachConcurrently,
  retrying,
  type Sleep,
} from "./backupTools.js";
import type { BackupBody, BackupTransport } from "./backupTransport.js";

/**
 * Getting the backup off this laptop, which is the half that makes it a backup
 * (§10B: "not this laptop alone"). Every object is re-downloaded and hashed
 * before anything counts it as stored: wrangler has no way to list a bucket, and
 * an exit code is not evidence.
 */

/**
 * The ledger remembers what one destination holds, so it is named after that
 * destination. A single file would keep saying "already off-site" after
 * BACKUP_STORAGE_BUCKET or the endpoint changed, and the run would report
 * success with a new bucket holding the dumps and none of the images.
 */
export function ledgerFile(destination: string): string {
  return `offsite-ledger-${destination.replace(/[^A-Za-z0-9.-]/g, "_")}.tsv`;
}

/** What `ledgerFile` is named after: the bucket, and in s3 mode the store too. */
export function backupDestination(config: BackupTransportConfig & { bucket: string }): string {
  return config.transport === "s3"
    ? `${new URL(config.endpoint).host}-${config.bucket}`
    : config.bucket;
}

/**
 * Puts an object and reads it back, returning what went wrong or undefined.
 *
 * Every failure is worth a retry, a wrong digest included: the read-back that
 * failed may be the fault rather than the stored object, and putting the same
 * bytes again is harmless.
 */
export async function uploadVerified(
  upload: {
    transport: BackupTransport;
    bucket: string;
    key: string;
    body: BackupBody;
    contentType: string;
    sha256: string;
  },
  wait?: Sleep,
): Promise<string | undefined> {
  const { transport, bucket, key, body, contentType, sha256 } = upload;
  return retrying(
    async () => {
      try {
        await transport.put(bucket, key, body, contentType);
        const digest = sha256Hex(await transport.get(bucket, key));
        return digest === sha256
          ? undefined
          : `${key}: stored object hashes to ${digest}, expected ${sha256}`;
      } catch (error) {
        return `${key}: ${describeFailure(error)}`;
      }
    },
    (failure) => failure !== undefined,
    wait,
  );
}

/**
 * Deletes an object and proves it is gone, returning what went wrong or undefined.
 *
 * The same reasoning as `uploadVerified`, and a sharper need for it: the wrangler
 * CLI exits 0 on any 404 (see `createWranglerTransport`), so an exit code here
 * says only that nothing complained. Absent before the call and absent after it
 * both succeed, which is what makes a prune safe to run again from the top.
 */
export async function deleteVerified(
  target: { transport: BackupTransport; bucket: string; key: string },
  wait?: Sleep,
): Promise<string | undefined> {
  const { transport, bucket, key } = target;
  return retrying(
    async () => {
      try {
        await transport.delete(bucket, key);
        await transport.get(bucket, key);
        return `${key}: still there after the delete`;
      } catch (error) {
        return error instanceof ObjectNotFoundError ? undefined : `${key}: ${describeFailure(error)}`;
      }
    },
    (failure) => failure !== undefined,
    wait,
  );
}

/**
 * Which images are already off-site and verified, as `key<TAB>sha256` lines.
 *
 * It is a cache and not a record: losing it costs one harmless re-upload, so a
 * line that cannot be read is simply not an entry. The sha256 is part of the
 * identity on purpose, so that a key whose digest ever changed reads as not
 * uploaded rather than as done.
 */
export function parseLedger(text: string): { entries: Set<string>; ignoredLines: number } {
  const entries = new Set<string>();
  let ignoredLines = 0;
  for (const line of text.split("\n")) {
    if (line === "") {
      continue;
    }
    const [key, sha256, extra] = line.split("\t");
    if (key === undefined || key === "" || extra !== undefined || !isSha256(sha256)) {
      ignoredLines += 1;
    } else {
      entries.add(ledgerEntry(key, sha256));
    }
  }
  return { entries, ignoredLines };
}

export function ledgerEntry(key: string, sha256: string): string {
  return `${key}\t${sha256}`;
}

/**
 * Every user the ledger names, read off the raw lines rather than `parseLedger`'s
 * entries: a line torn by a crash mid-append is not an entry, and it still names
 * an owner whose objects went off-site.
 */
export function ledgerOwners(text: string): Set<string> {
  const owners = new Set<string>();
  for (const line of text.split("\n")) {
    const owner = line.split("/", 1)[0] ?? "";
    if (isUserIdShaped(owner)) {
      owners.add(owner);
    }
  }
  return owners;
}

/** The keys under one user that the ledger can read. See `parseLedger`. */
export function ledgerKeysOf(text: string, userId: string): string[] {
  return [...parseLedger(text).entries]
    .map((entry) => entry.split("\t", 1)[0] ?? "")
    .filter((key) => key.startsWith(`${userId}/`));
}

/** The ledger's text with one user's lines gone and every other line untouched. */
export function ledgerWithoutUser(text: string, userId: string): string {
  return text
    .split("\n")
    .filter((line) => !line.startsWith(`${userId}/`))
    .join("\n");
}

function isSha256(value: string | undefined): value is string {
  return value !== undefined && /^[0-9a-f]{64}$/.test(value);
}

async function loadLedger(path: string, log: BackupLog): Promise<Set<string>> {
  const bytes = await readIfPresent(path);
  if (bytes === undefined) {
    return new Set();
  }
  const { entries, ignoredLines } = parseLedger(Buffer.from(bytes).toString("utf8"));
  if (ignoredLines > 0) {
    log.warn(`${basename(path)}: ${ignoredLines} unreadable line(s) ignored; those images re-upload`);
  }
  return entries;
}

/**
 * Uploads the mirrored images the ledger does not list, verifying each and
 * recording it only afterwards. Appended one line at a time, so a run that dies
 * halfway has kept everything it finished.
 */
export async function pushImagesOffsite(
  rows: readonly BackupImageRow[],
  context: {
    localDir: string;
    bucket: string;
    /** Identifies the store as well as the bucket; see `ledgerFile`. */
    destination: string;
    transport: BackupTransport;
    log: BackupLog;
    wait?: Sleep;
  },
): Promise<{ uploaded: number; alreadyOffsite: number }> {
  const { localDir, bucket, destination, transport, log, wait } = context;
  const ledgerName = ledgerFile(destination);
  const ledgerPath = join(localDir, ledgerName);
  const ledger = await loadLedger(ledgerPath, log);
  const pending = rows.filter((row) => !ledger.has(ledgerEntry(row.objectKey, row.sha256)));
  let uploaded = 0;

  await forEachConcurrently(pending, IMAGE_CONCURRENCY, async (row) => {
    const failure = await uploadVerified(
      {
        transport,
        bucket,
        key: mirrorObjectKey(row.objectKey),
        body: { file: mirrorPath(localDir, row.objectKey) },
        contentType: contentTypeForKey(row.objectKey),
        sha256: row.sha256,
      },
      wait,
    );
    if (failure !== undefined) {
      log.fail(`off-site image ${failure}`);
      return;
    }
    try {
      await appendFile(ledgerPath, `${ledgerEntry(row.objectKey, row.sha256)}\n`, { mode: 0o600 });
      uploaded += 1;
    } catch (error) {
      log.fail(`${ledgerName}: ${describeFailure(error)}`);
    }
  });

  return { uploaded, alreadyOffsite: rows.length - pending.length };
}

/** The issuing route's own map, read backwards, so the two cannot drift apart. */
export function contentTypeForKey(objectKey: string): string {
  const match = Object.entries(EXTENSION_BY_CONTENT_TYPE).find(([, extension]) =>
    objectKey.endsWith(`.${extension}`),
  );
  return match?.[0] ?? "application/octet-stream";
}

export interface ManifestRow {
  objectKey: string;
  sha256: string;
  deleted: boolean;
}

const MANIFEST_HEADER = "object_key\tsha256\tdeleted";

/**
 * One line per row, unissued keys included: a manifest is the record of what the
 * database said, and a row left out of it is a row nobody can notice is gone.
 *
 * Tabs, newlines and backslashes are escaped because a key that fails
 * `isIssuedObjectKey` can hold anything at all, and one line per row is what the
 * format rests on. Nothing unescapes them: an issued key contains none of those
 * characters, so an escaped value is one `db:restore-images` refuses anyway.
 */
export function formatManifest(rows: readonly BackupImageRow[]): string {
  const lines = rows.map(({ objectKey, sha256, deleted }) =>
    [manifestField(objectKey), manifestField(sha256), String(deleted)].join("\t"),
  );
  return `${[MANIFEST_HEADER, ...lines].join("\n")}\n`;
}

function manifestField(value: string): string {
  return value.replace(/[\\\t\r\n]/g, (character) => {
    const escapes: Record<string, string> = { "\\": "\\\\", "\t": "\\t", "\r": "\\r", "\n": "\\n" };
    return escapes[character] ?? character;
  });
}

/**
 * ⚠ A manifest is an input to a restore, read on the worst day and possibly
 * from somewhere else, so nothing in it is trusted yet: `problems` names each
 * line that could not be read, and the keys that parse still go through
 * `isIssuedManifestKey` before they touch a path.
 */
export function parseManifest(text: string): { rows: ManifestRow[]; problems: string[] } {
  const [header, ...lines] = text.split("\n");
  if (header !== MANIFEST_HEADER) {
    throw new Error("This is not a backup manifest: its first line is not the expected header.");
  }
  const rows: ManifestRow[] = [];
  const problems: string[] = [];
  lines.forEach((line, index) => {
    if (line === "") {
      return;
    }
    const [objectKey, sha256, deleted, extra] = line.split("\t");
    if (
      objectKey === undefined ||
      objectKey === "" ||
      !isSha256(sha256) ||
      (deleted !== "true" && deleted !== "false") ||
      extra !== undefined
    ) {
      // The line number and not the line: it may hold anything.
      problems.push(`manifest line ${index + 2} is not a readable row`);
      return;
    }
    rows.push({ objectKey, sha256, deleted: deleted === "true" });
  });
  return { rows, problems };
}

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUserIdShaped(value: string): boolean {
  return UUID_SEGMENT.test(value);
}

/**
 * `isIssuedObjectKey` for a key with no row beside it. A manifest has no user id
 * column, so the owner is read off the key - and must itself be shaped like a
 * user id, because the check pins a key to whatever owner it is handed, and
 * handed the first segment of `../2026/08/{uuid}.jpg` it would pass a traversal.
 */
export function isIssuedManifestKey(objectKey: string): boolean {
  const owner = objectKey.split("/", 1)[0] ?? "";
  return isUserIdShaped(owner) && isIssuedObjectKey(objectKey, owner);
}

/** Writes the run's manifest locally, then off-site, and verifies it there. */
export async function pushManifest(
  rows: readonly BackupImageRow[],
  context: {
    localDir: string;
    bucket: string;
    key: string;
    transport: BackupTransport;
    log: BackupLog;
    wait?: Sleep;
  },
): Promise<void> {
  const { localDir, bucket, key, transport, log, wait } = context;
  const text = formatManifest(rows);
  const path = join(localDir, key);
  await writeFileAtomically(path, text);
  const failure = await uploadVerified(
    {
      transport,
      bucket,
      key,
      body: { file: path },
      contentType: "text/tab-separated-values",
      sha256: sha256Hex(await readFile(path)),
    },
    wait,
  );
  if (failure !== undefined) {
    log.fail(`off-site manifest ${failure}`);
  }
}
