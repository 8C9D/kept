import AdmZip from "adm-zip";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import {
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJobs } from "../../src/db/schema.js";
import {
  DEFAULT_EXPORT_LIMITS,
  streamZipToStorage,
} from "../../src/export/generateExport.js";
import { runExportJob } from "../../src/export/runExportJob.js";
import { exportObjectKey } from "../../src/storage/objectKeys.js";
import {
  ObjectNotFoundError,
  type ObjectStorage,
} from "../../src/storage/objectStorage.js";
import {
  LOCAL_DEV_STORAGE_CONFIG,
  MULTIPART_PART_BYTES,
  createBucketIfMissing,
  createS3ObjectStorage,
} from "../../src/storage/s3ObjectStorage.js";
import {
  createTestHarness,
  imageFor,
  receiptBody,
} from "../helpers/testApp.js";

/**
 * The export as it really runs: `runExportJob` reading from and writing to
 * real MinIO, with real multipart uploads. Storage is wrapped only where a test
 * needs something to go wrong at a chosen moment, so each failure below happens
 * to the same code path production takes.
 *
 * A failure mode here that merely "ends up failed" proves little. Each one also
 * asserts it left nothing behind, because a truncated zip that looks finished
 * is the worst thing this pipeline can produce, and that it did not hang,
 * because vitest's own timeout on a hang would report a different defect.
 *
 * Vitest fails a run on any unhandled rejection, which is what holds the
 * no-unhandled-rejection property over every test in this file.
 */

const harness = createTestHarness();
const real = createS3ObjectStorage(LOCAL_DEV_STORAGE_CONFIG);
const s3 = new S3Client({
  endpoint: LOCAL_DEV_STORAGE_CONFIG.endpoint,
  region: LOCAL_DEV_STORAGE_CONFIG.region,
  credentials: {
    accessKeyId: LOCAL_DEV_STORAGE_CONFIG.accessKeyId,
    secretAccessKey: LOCAL_DEV_STORAGE_CONFIG.secretAccessKey,
  },
  forcePathStyle: LOCAL_DEV_STORAGE_CONFIG.forcePathStyle,
});

let token: string;
let userId: string;
const period = { periodStart: "2026-01-01", periodEnd: "2026-12-31" };

beforeAll(async () => {
  await createBucketIfMissing(LOCAL_DEV_STORAGE_CONFIG);
});

// Every user a test ran as, so the megabytes of real objects can go afterwards.
const usersSeen = new Set<string>();

afterAll(async () => {
  for (const seen of usersSeen) {
    for (const prefix of [`${seen}/`, `exports/${seen}/`]) {
      for (const key of await real.listKeys(prefix)) {
        await real.delete(key);
      }
    }
  }
  await harness.close();
  s3.destroy();
});

beforeEach(async () => {
  await harness.resetDatabase();
  ({ token, userId } = await harness.signIn("export-streaming-user", "Streamer"));
  usersSeen.add(userId);
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A confirmed receipt whose image is really in MinIO. */
async function receiptWithImage(
  bytes: Buffer,
  purchasedAt: string,
): Promise<{ id: string; objectKey: string }> {
  const image = imageFor(userId, sha256(bytes));
  await real.upload(image.objectKey, bytes, "image/jpeg");
  const response = await harness.request(token, "POST", "/api/receipts", {
    ...receiptBody({ status: "confirmed", purchasedAt }),
    image,
  });
  expect(response.status).toBe(201);
  const { id } = (await response.json()) as { id: string };
  return { id, objectKey: image.objectKey };
}

async function queuedJob(): Promise<string> {
  const [job] = await harness.db
    .insert(exportJobs)
    .values({ userId, ...period })
    .returning({ id: exportJobs.id });
  if (job === undefined) {
    throw new Error("Test export job insert returned no row");
  }
  return job.id;
}

async function jobRow(jobId: string) {
  const [job] = await harness.db
    .select()
    .from(exportJobs)
    .where(eq(exportJobs.id, jobId));
  if (job === undefined) {
    throw new Error("Test export job row is missing");
  }
  return job;
}

function zipKey(jobId: string): string {
  return exportObjectKey(userId, jobId, "Receipts-2026.zip");
}

async function expectNothingStored(jobId: string): Promise<void> {
  await expect(real.download(zipKey(jobId))).rejects.toBeInstanceOf(
    ObjectNotFoundError,
  );
  const { Uploads } = await s3.send(
    new ListMultipartUploadsCommand({
      Bucket: LOCAL_DEV_STORAGE_CONFIG.bucket,
      Prefix: zipKey(jobId),
    }),
  );
  expect(Uploads ?? []).toEqual([]);
}

/** Runs a job that must fail, and returns what it recorded. */
async function failedJob(
  storage: ObjectStorage,
  limits?: Parameters<typeof runExportJob>[2],
) {
  const jobId = await queuedJob();
  await expect(
    runExportJob({ db: harness.db, storage }, jobId, limits),
  ).rejects.toThrow();
  const job = await jobRow(jobId);
  expect(job.status).toBe("failed");
  expect(job.objectKey).toBeNull();
  await expectNothingStored(jobId);
  return { jobId, error: job.error as string };
}

/** Real storage with `downloadStream` rewritten for the keys `when` picks. */
function intercepting(
  when: (objectKey: string) => boolean,
  downloadStream: ObjectStorage["downloadStream"],
): ObjectStorage {
  return {
    ...real,
    downloadStream: (objectKey) =>
      when(objectKey)
        ? downloadStream(objectKey)
        : real.downloadStream(objectKey),
  };
}

describe("a real export through real multipart storage", () => {
  it("produces a zip over one part whose every entry is byte-identical, in order", async () => {
    // Three images totalling more than two parts, so the zip really is
    // multipart. Predicted: ETag ends `-3`, the data files come first in
    // their old order, and every entry is DEFLATED.
    const images = [randomBytes(9_000_000), randomBytes(9_000_000), randomBytes(1_000_000)];
    const first = await receiptWithImage(images[0] as Buffer, "2026-01-10");
    const second = await receiptWithImage(images[1] as Buffer, "2026-02-10");
    const third = await receiptWithImage(images[2] as Buffer, "2026-03-10");

    const jobId = await queuedJob();
    await runExportJob({ db: harness.db, storage: real }, jobId);

    const job = await jobRow(jobId);
    expect(job.error).toBeNull();
    expect(job.status).toBe("complete");
    expect(job.objectKey).toBe(zipKey(jobId));

    const stored = await s3.send(
      new HeadObjectCommand({
        Bucket: LOCAL_DEV_STORAGE_CONFIG.bucket,
        Key: zipKey(jobId),
      }),
    );
    expect(stored.ContentLength).toBeGreaterThan(MULTIPART_PART_BYTES * 2);
    expect(stored.ETag).toMatch(/-3"$/);
    expect(stored.ContentType).toBe("application/zip");

    const zip = new AdmZip(Buffer.from(await real.download(zipKey(jobId))));
    const entries = zip.getEntries();
    expect(entries.map((entry) => entry.entryName.split("/")[0])).toEqual([
      "receipts-2026.xlsx",
      "receipts-2026.csv",
      "receipts-2026.json",
      "images",
      "images",
      "images",
    ]);

    const shortId = (id: string) => id.replaceAll("-", "").slice(0, 8);
    const expected = [
      [`images/2026/01/2026-01-10_Test-Vendor_${shortId(first.id)}.jpg`, images[0]],
      [`images/2026/02/2026-02-10_Test-Vendor_${shortId(second.id)}.jpg`, images[1]],
      [`images/2026/03/2026-03-10_Test-Vendor_${shortId(third.id)}.jpg`, images[2]],
    ] as const;
    for (const [name, bytes] of expected) {
      const entry = zip.getEntry(name);
      expect(entry).not.toBeNull();
      expect(sha256(entry?.getData() as Buffer)).toBe(sha256(bytes as Buffer));
      expect(entry?.header.method).toBe(8); // DEFLATED
    }
    for (const name of ["receipts-2026.csv", "receipts-2026.json"]) {
      expect(zip.getEntry(name)?.header.method).toBe(8); // DEFLATED
    }
    expect(zip.readAsText("receipts-2026.csv")).toContain("Test Vendor");
  }, 60_000);

  it("stores a small export as one plain object, and an empty period too", async () => {
    await receiptWithImage(randomBytes(2048), "2026-01-10");
    const jobId = await queuedJob();

    await runExportJob({ db: harness.db, storage: real }, jobId);

    expect((await jobRow(jobId)).status).toBe("complete");
    const stored = await s3.send(
      new HeadObjectCommand({
        Bucket: LOCAL_DEV_STORAGE_CONFIG.bucket,
        Key: zipKey(jobId),
      }),
    );
    expect(stored.ETag).not.toContain("-");

    await harness.resetDatabase();
    ({ token, userId } = await harness.signIn("export-streaming-empty"));
    usersSeen.add(userId);
    const emptyJob = await queuedJob();
    await runExportJob({ db: harness.db, storage: real }, emptyJob);
    expect((await jobRow(emptyJob)).status).toBe("complete");
  }, 30_000);

  it("bundles a zero-byte image rather than waiting for bytes that never come", async () => {
    // A presigned PUT of an empty file is a real object, and an entry that
    // ends before it starts is the edge a stream pump gets wrong by hanging.
    const empty = await receiptWithImage(Buffer.alloc(0), "2026-01-10");
    const jobId = await queuedJob();

    await runExportJob({ db: harness.db, storage: real }, jobId);

    expect((await jobRow(jobId)).status).toBe("complete");
    const zip = new AdmZip(Buffer.from(await real.download(zipKey(jobId))));
    const image = zip
      .getEntries()
      .find((entry) => entry.entryName.startsWith("images/"));
    expect(image?.entryName).toContain(empty.id.replaceAll("-", "").slice(0, 8));
    expect(image?.getData()).toHaveLength(0);
  }, 15_000);

  it("opens one object at a time, each finished before the next is opened", async () => {
    // archiver would queue every stream and leave N GetObject sockets idle.
    // Predicted: never more than one body open at once, across six receipts.
    const count = 6;
    for (let index = 0; index < count; index++) {
      await receiptWithImage(randomBytes(70_000), `2026-01-${10 + index}`);
    }
    let open = 0;
    let mostOpen = 0;
    let opened = 0;
    const storage = intercepting(
      () => true,
      async (objectKey) => {
        const object = await real.downloadStream(objectKey);
        open += 1;
        opened += 1;
        mostOpen = Math.max(mostOpen, open);
        object.body.once("close", () => {
          open -= 1;
        });
        return object;
      },
    );

    const jobId = await queuedJob();
    await runExportJob({ db: harness.db, storage }, jobId);

    expect((await jobRow(jobId)).status).toBe("complete");
    expect(opened).toBe(count);
    expect(mostOpen).toBe(1);
  }, 30_000);
});

describe("a source failing partway", () => {
  it("fails the job promptly and aborts the upload when an image errors mid-body", async () => {
    // The hang this exists for: archiver pipes a source through a PassThrough
    // of its own, `pipe` does not forward errors, and so a source that died
    // left its entry open forever. The first image is over a part, so a
    // multipart upload is genuinely in progress when the second one breaks.
    await receiptWithImage(randomBytes(MULTIPART_PART_BYTES + 1_000_000), "2026-01-10");
    const broken = await receiptWithImage(randomBytes(1_000_000), "2026-02-10");

    const storage = intercepting(
      (objectKey) => objectKey === broken.objectKey,
      async () => ({
        body: Readable.from(
          (function* () {
            yield randomBytes(256 * 1024);
            throw new Error("connection reset by R2 mid-object");
          })(),
          { objectMode: false },
        ),
        contentLength: 1_000_000,
      }),
    );

    const startedAt = Date.now();
    const { error } = await failedJob(storage);

    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(error).toContain("connection reset by R2 mid-object");
    // A failure of storage is not a missing photo, and nobody is told to
    // delete a receipt over it.
    expect(error).not.toMatch(/never finished uploading/);
    expect(error).not.toMatch(/delete/i);
  }, 30_000);

  it("gives up on an object that stops sending, and destroys it", async () => {
    const stalled = await receiptWithImage(randomBytes(4096), "2026-01-10");
    const body = new Readable({ read() {} });
    body.push(randomBytes(1024)); // some bytes, then silence

    const storage = intercepting(
      (objectKey) => objectKey === stalled.objectKey,
      async () => ({ body, contentLength: 4096 }),
    );

    const startedAt = Date.now();
    const { error } = await failedJob(storage, { objectStallMs: 150 });

    expect(Date.now() - startedAt).toBeLessThan(5_000);
    expect(error).toContain(`receipt ${stalled.id} page 1`);
    expect(error).toMatch(/stopped sending/);
    expect(body.destroyed).toBe(true);
  }, 15_000);

  it("gives up on a read that never answers at all, and disposes of a late arrival", async () => {
    const stalled = await receiptWithImage(randomBytes(4096), "2026-01-10");
    let arrive = (_value: { body: Readable; contentLength: number }) => {};
    const late = new Readable({ read() {} });

    const storage = intercepting(
      (objectKey) => objectKey === stalled.objectKey,
      () =>
        new Promise((resolve) => {
          arrive = resolve;
        }),
    );

    const { error } = await failedJob(storage, { objectStallMs: 150 });
    expect(error).toMatch(/stopped sending/);

    // The read that lost the race turns up holding a socket nobody owns.
    arrive({ body: late, contentLength: 4096 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(late.destroyed).toBe(true);
  }, 15_000);

  it("does not call a healthy object stalled because the upload is the slow side", async () => {
    // Backpressure stops the reads, and a watchdog on bytes-in-motion would
    // fire on a perfectly good object. Both halves of the setup are load-
    // bearing, and the first version of this test had neither: the source has
    // to outrun every buffer between it and the upload (archiver alone holds
    // 1 MiB), or backpressure never reaches it; and it has to be always ready,
    // so a timer that fires can only have fired on the sink's wait.
    const object = await receiptWithImage(randomBytes(1024), "2026-01-10");
    const chunkBytes = 64 * 1024;
    const totalChunks = 64; // 4 MiB
    const storage: ObjectStorage = {
      ...intercepting(
        (objectKey) => objectKey === object.objectKey,
        async () => ({
          body: Readable.from(
            (function* () {
              for (let index = 0; index < totalChunks; index++) {
                yield randomBytes(chunkBytes);
              }
            })(),
            { objectMode: false },
          ),
          contentLength: chunkBytes * totalChunks,
        }),
      ),
      async uploadStream(objectKey, body, contentType) {
        const throttled = Readable.from(
          (async function* () {
            for await (const chunk of body as AsyncIterable<Uint8Array>) {
              await new Promise((resolve) => setTimeout(resolve, 40));
              yield chunk;
            }
          })(),
          { objectMode: false },
        );
        await real.uploadStream(objectKey, throttled, contentType);
      },
    };

    const jobId = await queuedJob();
    await runExportJob({ db: harness.db, storage }, jobId, {
      objectStallMs: 100,
    });

    const job = await jobRow(jobId);
    expect(job.error).toBeNull();
    expect(job.status).toBe("complete");
  }, 30_000);

  it("still reports a photo that was never uploaded as that, in the same words", async () => {
    const response = await harness.request(token, "POST", "/api/receipts", {
      ...receiptBody({ status: "confirmed" }),
      image: imageFor(userId, "c1".repeat(32)),
    });
    expect(response.status).toBe(201);
    const { id } = (await response.json()) as { id: string };

    const { error } = await failedJob(real);

    // Against the real store this time: the translation is the adapter's,
    // and the sentence is what the export screen shows.
    expect(error).toBe(
      `Receipt ${id} has no image in storage for page 1, so this export ` +
        `cannot be completed - that page's photo never finished uploading. ` +
        `Replace that page's image to repair it without losing the receipt's ` +
        `vendor, date, total or HST. If you would rather start over, delete ` +
        `the receipt and capture it again; deleting it first is what lets an ` +
        `identical photo be accepted. If the paper is gone, deleting the ` +
        `receipt will let the export run without it.`,
    );
  }, 15_000);
});

describe("the upload failing partway", () => {
  it("fails the job, and stops reading the source it was fed from", async () => {
    await receiptWithImage(randomBytes(4_000_000), "2026-01-10");
    const bodies: Readable[] = [];
    const storage: ObjectStorage = {
      ...real,
      async downloadStream(objectKey) {
        const object = await real.downloadStream(objectKey);
        bodies.push(object.body);
        return object;
      },
      async uploadStream(_objectKey, body) {
        for await (const _chunk of body as AsyncIterable<Uint8Array>) {
          throw new Error("the store refused a part");
        }
      },
    };

    const { error } = await failedJob(storage);

    expect(error).toBe("the store refused a part");
    for (const body of bodies) {
      expect(body.destroyed).toBe(true);
    }
  }, 15_000);
});

describe("the size budget", () => {
  it("defaults to 4 GiB, which memory no longer has anything to do with", () => {
    expect(DEFAULT_EXPORT_LIMITS.maxTotalBytes).toBe(4 * 1024 ** 3);
    expect(DEFAULT_EXPORT_LIMITS.objectStallMs).toBe(60_000);
  });

  it("refuses from the stated size, before a byte of that object has moved", async () => {
    // The 1 GB PDF on a confirmed receipt: this refusal used to land only
    // after `download` had put the whole object in memory.
    const huge = await receiptWithImage(randomBytes(1_000_000), "2026-01-10");
    let body: Readable | undefined;
    const storage = intercepting(
      (objectKey) => objectKey === huge.objectKey,
      async (objectKey) => {
        const object = await real.downloadStream(objectKey);
        body = object.body;
        return object;
      },
    );

    const { error } = await failedJob(storage, { maxTotalBytes: 500_000 });

    expect(error).toMatch(/size limit.*shorter period/);
    expect(body?.readableDidRead).toBe(false);
    expect(body?.destroyed).toBe(true);
  }, 15_000);

  it("refuses while counting when the store states no size", async () => {
    const unsized = await receiptWithImage(randomBytes(3_000_000), "2026-01-10");
    let sent = 0;
    const storage = intercepting(
      (objectKey) => objectKey === unsized.objectKey,
      async () => ({
        body: Readable.from(
          (function* () {
            for (let index = 0; index < 100; index++) {
              sent += 64 * 1024;
              yield randomBytes(64 * 1024);
            }
          })(),
          { objectMode: false },
        ),
        contentLength: null,
      }),
    );

    const { error } = await failedJob(storage, { maxTotalBytes: 1_000_000 });

    expect(error).toMatch(/size limit.*shorter period/);
    // Stopped at the limit, not after the object had been read to the end.
    expect(sent).toBeLessThan(2_000_000);
  }, 15_000);

  it("refuses when the data files alone are over, without opening an upload", async () => {
    await receiptWithImage(randomBytes(1024), "2026-01-10");
    const upload = vi.spyOn(real, "uploadStream");
    try {
      const { error } = await failedJob(real, { maxTotalBytes: 10 });
      expect(error).toMatch(/size limit.*shorter period/);
      expect(upload).not.toHaveBeenCalled();
    } finally {
      upload.mockRestore();
    }
  }, 15_000);
});

describe("streamZipToStorage's failure shape", () => {
  it("surfaces an error from the archive itself, with no unhandled rejection", async () => {
    // The shape the old buildZip had: a `finished` promise that could reject
    // while `await fill` was still pending, with no handler attached, which
    // an unhandled-rejection exit turns into the whole API going down. Only
    // a direct call can make archiver itself error: an empty entry name is
    // refused by `append`, and `generateExport` never builds one.
    const objectKey = `test-${randomUUID()}/archive-error.zip`;

    await expect(
      streamZipToStorage(real, objectKey, async (zip) => {
        await zip.addData("", "this entry has no name");
      }),
    ).rejects.toThrow(/entry name/i);

    await expect(real.download(objectKey)).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
  }, 15_000);

  it("never stores a truncated zip when `fill` throws after writing entries", async () => {
    const objectKey = `test-${randomUUID()}/fill-throws.zip`;
    const failure = new Error("fill broke after two entries");

    await expect(
      streamZipToStorage(real, objectKey, async (zip) => {
        await zip.addData("one.txt", "first");
        await zip.addData("two.txt", "second");
        throw failure;
      }),
    ).rejects.toBe(failure);

    await expect(real.download(objectKey)).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
  }, 15_000);

  it("reports the first failure, not the consequence that followed it", async () => {
    const objectKey = `test-${randomUUID()}/first-failure.zip`;
    const original = new Error("the real cause");
    const storage: ObjectStorage = {
      ...real,
      async uploadStream(_key, body) {
        // Rejects with the stream's error, which is `fail` reporting back.
        for await (const _chunk of body as AsyncIterable<Uint8Array>) {
          // Consumed like the real adapter, so the failure reaches it here.
        }
        throw new Error("the upload only saw the consequence");
      },
    };

    await expect(
      streamZipToStorage(storage, objectKey, async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  }, 15_000);
});

/**
 * `failAbandonedJobs` retires a running job past the stale clock, and it
 * cannot tell dead from slow. Simulated here by rewriting the row from inside
 * the upload, which is exactly the moment such a job is still working.
 */
describe("a job retired while it was still running", () => {
  const ABANDONED =
    "The export stopped before it finished, most likely because the server restarted. Run it again.";

  function retiredMidRun(jobIdOf: () => string, outcome: "ok" | "fails"): ObjectStorage {
    return {
      ...real,
      async uploadStream(objectKey, body, contentType) {
        await harness.db
          .update(exportJobs)
          .set({ status: "failed", error: ABANDONED, completedAt: new Date() })
          .where(eq(exportJobs.id, jobIdOf()));
        if (outcome === "fails") {
          throw new Error("failed after being retired");
        }
        await real.uploadStream(objectKey, body, contentType);
      },
    };
  }

  it("cannot flip from failed to complete", async () => {
    await receiptWithImage(randomBytes(2048), "2026-01-10");
    const jobId = await queuedJob();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await runExportJob(
        { db: harness.db, storage: retiredMidRun(() => jobId, "ok") },
        jobId,
      );
      expect(logged.mock.calls.flat().join(" ")).toContain(
        `Export job ${jobId} finished after it had been retired`,
      );
    } finally {
      logged.mockRestore();
    }

    const job = await jobRow(jobId);
    expect(job.status).toBe("failed");
    expect(job.error).toBe(ABANDONED);
    expect(job.objectKey).toBeNull();
  }, 15_000);

  it("cannot overwrite the reason the client was already shown", async () => {
    await receiptWithImage(randomBytes(2048), "2026-01-10");
    const jobId = await queuedJob();

    await expect(
      runExportJob(
        { db: harness.db, storage: retiredMidRun(() => jobId, "fails") },
        jobId,
      ),
    ).rejects.toThrow("failed after being retired");

    const job = await jobRow(jobId);
    expect(job.status).toBe("failed");
    expect(job.error).toBe(ABANDONED);
  }, 15_000);
});
