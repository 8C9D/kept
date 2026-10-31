import { readFile } from "node:fs/promises";
import type { BackupBody, BackupTransport } from "../../src/db/backupTransport.js";
import { ObjectNotFoundError } from "../../src/storage/objectStorage.js";

/**
 * An in-memory BackupTransport that honours the contract the real two do:
 * absence is `ObjectNotFoundError`, and anything else rejects as itself.
 *
 * `failNext` queues errors for a key, one per call, so a test can say "this
 * object times out twice". `calls` is what tests assert on to prove a skip
 * really did not touch storage. `ignoreDeletes` is the wrangler case the
 * transport's docblock warns about: a delete that reports success and removes
 * nothing.
 */
export interface MemoryBackupTransport extends BackupTransport {
  objects: Map<string, Uint8Array>;
  calls: Array<{ verb: "get" | "put" | "delete"; bucket: string; key: string }>;
  failNext(key: string, ...errors: Error[]): void;
  ignoreDeletes(key: string): void;
  contentTypes: Map<string, string>;
  maxConcurrent(): number;
}

export function memoryBackupTransport(options: { delayMs?: number } = {}): MemoryBackupTransport {
  const objects = new Map<string, Uint8Array>();
  const contentTypes = new Map<string, string>();
  const queued = new Map<string, Error[]>();
  const ignored = new Set<string>();
  const calls: MemoryBackupTransport["calls"] = [];
  let inFlight = 0;
  let peak = 0;

  const enter = async (verb: "get" | "put" | "delete", bucket: string, key: string) => {
    calls.push({ verb, bucket, key });
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    if (options.delayMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs));
    }
    inFlight -= 1;
    const error = queued.get(key)?.shift();
    if (error !== undefined) {
      throw error;
    }
  };

  return {
    objects,
    contentTypes,
    calls,
    failNext(key, ...errors) {
      queued.set(key, [...(queued.get(key) ?? []), ...errors]);
    },
    ignoreDeletes(key) {
      ignored.add(key);
    },
    maxConcurrent: () => peak,
    async get(bucket, key) {
      await enter("get", bucket, key);
      const bytes = objects.get(`${bucket}/${key}`);
      if (bytes === undefined) {
        throw new ObjectNotFoundError(key);
      }
      return bytes;
    },
    async put(bucket, key, body: BackupBody, contentType) {
      await enter("put", bucket, key);
      objects.set(
        `${bucket}/${key}`,
        "file" in body ? new Uint8Array(await readFile(body.file)) : body.bytes,
      );
      contentTypes.set(`${bucket}/${key}`, contentType);
    },
    async delete(bucket, key) {
      await enter("delete", bucket, key);
      if (!ignored.has(key)) {
        objects.delete(`${bucket}/${key}`);
        contentTypes.delete(`${bucket}/${key}`);
      }
    },
  };
}
