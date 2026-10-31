import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ObjectNotFoundError,
  type ObjectStorage,
} from "../storage/objectStorage.js";
import { createS3ObjectStorage } from "../storage/s3ObjectStorage.js";
import type { BackupTransportConfig } from "./backupConfig.js";
import { describeToolOutcome, spawnTool, type ToolResult } from "./backupTools.js";

/**
 * How the backup moves bytes, and the reason there are two ways.
 *
 * The job needs R2 and has no R2 API token: the dashboard path was never
 * walked, so the original job refused every night from 2026-08-20. Wrangler's
 * OAuth login cannot mint a token but it can read and write objects, which is
 * how every real backup since has been taken by hand. So `wrangler` is the mode
 * production runs and `s3` is the mode a minted token would use, and also what
 * the integration tests drive against MinIO.
 *
 * `get` carries the same contract as `ObjectStorage.download`, for the same
 * reason (see that docblock): an object that is not there rejects with
 * `ObjectNotFoundError`, and everything else rejects as itself. `MISSING` and
 * `UNREACHABLE` are decided on that distinction and nothing else.
 *
 * `delete` carries `ObjectStorage.delete`'s contract, the opposite one: absence
 * is the outcome being asked for, so deleting a key that is not there succeeds.
 * Only the deleted-account prune calls it (backupPrune.ts), and it goes through
 * `deleteVerified`, because resolving here does not prove anything was removed.
 */
export interface BackupTransport {
  get(bucket: string, key: string): Promise<Uint8Array>;
  put(bucket: string, key: string, body: BackupBody, contentType: string): Promise<void>;
  delete(bucket: string, key: string): Promise<void>;
}

export type BackupBody = { file: string } | { bytes: Uint8Array };

/** One bucket of a transport, in the shape `fetchRestoredImage` reads. */
export function bucketReader(
  transport: BackupTransport,
  bucket: string,
): Pick<ObjectStorage, "download"> {
  return { download: (key) => transport.get(bucket, key) };
}

export function createBackupTransport(config: BackupTransportConfig): BackupTransport {
  return config.transport === "wrangler"
    ? createWranglerTransport({ localDir: config.localDir })
    : createS3Transport(config);
}

/**
 * One call's budget. A judgement, not a measurement: receipts are a few hundred
 * KB, and the largest thing either transport carries is a dump far under what
 * five minutes moves on a home connection. It exists so that a stalled call ends
 * as a reported failure rather than hanging the run forever.
 */
const CALL_TIMEOUT_MS = 5 * 60_000;

/** The installed CLI's words for an absent object (`getR2Object`, 4.124.0). */
const WRANGLER_ABSENT_MESSAGE = "The specified key does not exist.";

/** How much of wrangler's error line is worth carrying into a failure. */
const WRANGLER_DETAIL_LIMIT = 200;

/**
 * A wrangler failure that is not absence. `detail` is what the image leg prints
 * (see `errorName` in restoreImageCheck.ts): S3 errors have a distinguishing
 * `name`, and wrangler has an exit code of 1 for everything, so without it every
 * cause from an expired login to a 500 would read identically in the log.
 */
export class WranglerError extends Error {
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.name = "WranglerError";
    this.detail = detail;
  }
}

/**
 * The `wrangler r2 object` subcommands, against the installed CLI's behaviour.
 * Three facts from reading and running it (4.124.0):
 *
 *   - Absence is exit 1 plus `The specified key does not exist.` on stderr,
 *     inside ANSI colour, and nothing else distinguishes it from any other
 *     failure. A CLI update that rewords the message turns real absences into
 *     `UNREACHABLE`: wrong, but loudly and in the safe direction, because a
 *     tombstoned image's absence then fails the run instead of warning.
 *
 *   - ⚠ That message also covers a missing BUCKET. `fetchR2Objects` maps any
 *     404 to `null`, and `r2 object get` reports every null as a missing key,
 *     so a mistyped BACKUP_SOURCE_BUCKET reads as "every image is MISSING".
 *     The CLI gives this adapter nothing to tell them apart with. The live rows
 *     then fail the run, so it cannot pass; it only misnames the cause. `put`
 *     has its own message and reports a missing bucket correctly.
 *
 *   - ⚠ The file is created before the request is made, so a failed get leaves
 *     a 0-byte file at `--file`, and the CLI's own mode (644) applies to it. A
 *     later pass trusting that file would count it as a backed-up image, which
 *     is a trap the hand-run procedure hit. Every get therefore lands in a temp
 *     directory of its own, private by mkdtemp, removed on every path. An exit
 *     code alone is never trusted either: the caller's digest check is what
 *     decides whether the bytes are the object.
 *
 * And one from reading `deleteR2Object` in the same version (it cannot be run
 * here without touching real R2):
 *
 *   - ⚠ `delete` exits 0 on an absent key, which is what this adapter needs, and
 *     for the same reason exits 0 on a missing BUCKET: `fetchR2Objects` maps any
 *     404 to `null` and the delete never looks at the answer. A mistyped bucket
 *     would "delete" everything and change nothing. Two things stand between
 *     that and a prune believing it: a prune runs only after a green run, which
 *     has just put a dump in this bucket and read it back, and `deleteVerified`
 *     asks for each object afterwards. Any failure that is not a 404 is exit 1
 *     with an `[ERROR]` line, as for `get`.
 *
 * The cwd is BACKUP_LOCAL_DIR so wrangler can never pick up a project config.
 * Wrangler's limit on `put` is 300 MiB, which a dump is nowhere near (173 KB
 * measured 2026-10-02); past it the put fails loudly, naming the size.
 */
export function createWranglerTransport(options: {
  localDir: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): BackupTransport {
  const timeoutMs = options.timeoutMs ?? CALL_TIMEOUT_MS;
  const env = { ...(options.env ?? process.env), WRANGLER_SEND_METRICS: "false" };
  const wrangler = (args: readonly string[]) =>
    spawnTool("wrangler", ["r2", "object", ...args], { cwd: options.localDir, env, timeoutMs });

  const withTempDirectory = async <T>(work: (directory: string) => Promise<T>): Promise<T> => {
    const directory = await mkdtemp(join(options.localDir, ".transport-"));
    try {
      return await work(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };

  const failure = (result: ToolResult) => {
    const reason = firstErrorLine(result);
    const outcome = describeToolOutcome(result, timeoutMs);
    return new WranglerError(reason === undefined ? outcome : `${outcome}: ${reason}`);
  };

  const putFile = async (bucket: string, key: string, file: string, contentType: string) => {
    const result = await wrangler([
      "put",
      `${bucket}/${key}`,
      "--remote",
      "--file",
      file,
      "--content-type",
      contentType,
    ]);
    if (result.exitCode !== 0) {
      throw failure(result);
    }
  };

  return {
    get: (bucket, key) =>
      withTempDirectory(async (directory) => {
        const file = join(directory, "object");
        const result = await wrangler(["get", `${bucket}/${key}`, "--remote", "--file", file]);
        if (result.exitCode !== 0) {
          if (`${result.stdout}\n${result.stderr}`.includes(WRANGLER_ABSENT_MESSAGE)) {
            throw new ObjectNotFoundError(key, {
              cause: new WranglerError(WRANGLER_ABSENT_MESSAGE),
            });
          }
          throw failure(result);
        }
        return new Uint8Array(await readFile(file));
      }),

    async put(bucket, key, body, contentType) {
      if ("file" in body) {
        await putFile(bucket, key, body.file, contentType);
        return;
      }
      await withTempDirectory(async (directory) => {
        const file = join(directory, "object");
        await writeFile(file, body.bytes, { mode: 0o600 });
        await putFile(bucket, key, file, contentType);
      });
    },

    async delete(bucket, key) {
      const result = await wrangler(["delete", `${bucket}/${key}`, "--remote"]);
      if (result.exitCode !== 0) {
        throw failure(result);
      }
    },
  };
}

/** Wrangler's `[ERROR]` line, without the colour, or undefined if it printed none. */
function firstErrorLine(result: ToolResult): string | undefined {
  const line = `${result.stderr}\n${result.stdout}`
    .replaceAll(ANSI_ESCAPE, "")
    .split("\n")
    .find((candidate) => candidate.includes("[ERROR]"));
  return line
    ?.slice(line.indexOf("[ERROR]") + "[ERROR]".length)
    .trim()
    .slice(0, WRANGLER_DETAIL_LIMIT);
}

// eslint-disable-next-line no-control-regex
const ANSI_ESCAPE = /\u001b\[[0-9;]*m/g;

/**
 * One token scoped to both buckets, so one adapter per bucket from one set of
 * credentials.
 *
 * Built on `createS3ObjectStorage` rather than its own client, and that is the
 * contract rather than a convenience: `download` is the one place S3's spelling
 * of "not there" becomes `ObjectNotFoundError`, and a second reader of the S3
 * error names would be the duplication that module exists to remove.
 *
 * The timeout is a race this adapter owns, for the reason
 * `assertStorageReachable` documents: the SDK's handler options do nothing
 * without a dependency this project does not declare. The abandoned request
 * keeps its socket, which is why the entry points end with `process.exit`.
 */
function createS3Transport(
  config: Extract<BackupTransportConfig, { transport: "s3" }>,
): BackupTransport {
  const stores = new Map<string, ObjectStorage>();
  const storeFor = (bucket: string) => {
    let store = stores.get(bucket);
    if (store === undefined) {
      store = createS3ObjectStorage({
        endpoint: config.endpoint,
        region: "auto",
        bucket,
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
        forcePathStyle: true,
      });
      stores.set(bucket, store);
    }
    return store;
  };

  return {
    get: (bucket, key) => bounded(storeFor(bucket).download(key)),
    put: (bucket, key, body, contentType) =>
      bounded(
        (async () => {
          const bytes = "file" in body ? new Uint8Array(await readFile(body.file)) : body.bytes;
          await storeFor(bucket).upload(key, bytes, contentType);
        })(),
      ),
    delete: (bucket, key) => bounded(storeFor(bucket).delete(key)),
  };
}

class BackupCallTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Object storage did not answer within ${timeoutMs}ms`);
    this.name = "BackupCallTimeoutError";
  }
}

async function bounded<T>(work: Promise<T>, timeoutMs: number = CALL_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BackupCallTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
