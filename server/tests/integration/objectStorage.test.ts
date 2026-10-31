import { createHash, randomBytes } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { Readable } from "node:stream";
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ObjectNotFoundError } from "../../src/storage/objectStorage.js";
import {
  LOCAL_DEV_STORAGE_CONFIG,
  MULTIPART_PART_BYTES,
  assertStorageReachable,
  createBucketIfMissing,
  createS3ObjectStorage,
  resolveStorageConfig,
} from "../../src/storage/s3ObjectStorage.js";

/**
 * The storage adapter against the real MinIO container from
 * docker-compose - like the Postgres tests, this requires `docker compose
 * up -d`. The point is to exercise the exact presigned path the clients
 * use: a URL is fetched with plain HTTP, no SDK on the client side, which
 * is how a phone will use it.
 */
const storage = createS3ObjectStorage(LOCAL_DEV_STORAGE_CONFIG);

// Distinct prefix per run so reruns never collide on leftover objects.
const runPrefix = `test-${Date.now()}`;

beforeAll(async () => {
  await createBucketIfMissing(LOCAL_DEV_STORAGE_CONFIG);
});

afterAll(async () => {
  // These tests upload tens of megabytes of random bytes per run, which is too
  // much to leave in even a disposable volume.
  await deleteUnder(runPrefix);
});

async function deleteUnder(prefix: string): Promise<void> {
  const keys = await storage.listKeys(prefix);
  for (let index = 0; index < keys.length; index += 32) {
    await Promise.all(
      keys.slice(index, index + 32).map((key) => storage.delete(key)),
    );
  }
}

describe("s3ObjectStorage against MinIO", () => {
  it("round-trips bytes through presigned PUT and GET, as a client would", async () => {
    const objectKey = `${runPrefix}/2026/08/roundtrip.jpg`;
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

    const uploadUrl = await storage.presignUpload(objectKey, "image/jpeg");
    const putResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg" },
      body: bytes,
    });
    expect(putResponse.status).toBe(200);

    const downloadUrl = await storage.presignDownload(objectKey);
    const getResponse = await fetch(downloadUrl);
    expect(getResponse.status).toBe(200);
    const fetched = new Uint8Array(await getResponse.arrayBuffer());
    expect(fetched).toEqual(bytes);
  });

  it("presigned uploads reject a content type other than the one signed", async () => {
    // The upload-url route signs the client's declared content type; a
    // swapped type at PUT time must fail the signature, or the type check
    // in uploadUrlSchema would be decorative.
    const objectKey = `${runPrefix}/2026/08/wrong-type.jpg`;
    const uploadUrl = await storage.presignUpload(objectKey, "image/jpeg");
    const putResponse = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/pdf" },
      body: new Uint8Array([1]),
    });
    expect(putResponse.status).toBe(403);
  });

  it("round-trips server-side upload and download (the export path)", async () => {
    const objectKey = `${runPrefix}/exports/export.zip`;
    const bytes = new Uint8Array([0x50, 0x4b, 3, 4, 9, 9, 9]);

    await storage.upload(objectKey, bytes, "application/zip");
    expect(await storage.download(objectKey)).toEqual(bytes);
  });

  it("download of a missing key answers the ObjectStorage contract, not S3's dialect", async () => {
    // Load-bearing, not incidental. `generateExport` decides whether a failed
    // download means "this receipt's photo is gone" or "storage did not
    // answer", and the two lead to opposite advice - one of them tells a
    // person to delete a receipt. That decision is now made on
    // ObjectNotFoundError rather than on `error.name === "NoSuchKey"`, and
    // this is the only test that drives the translation with a real S3
    // client: the fake honours the contract by fiat, so if the real store's
    // spelling ever drifts, nothing else in the suite would notice - the
    // adapter would stop translating and every absence would surface as an
    // unexplained failure.
    await expect(
      storage.download(`${runPrefix}/does-not-exist.jpg`),
    ).rejects.toBeInstanceOf(ObjectNotFoundError);
    // The store's own word is kept rather than swallowed, so a log line can
    // still say which answer produced this - and so the spelling the adapter
    // matches on is pinned to what MinIO/R2 really send.
    const error = await storage
      .download(`${runPrefix}/does-not-exist.jpg`)
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
    expect((error as Error).cause).toMatchObject({ name: "NoSuchKey" });
  });

  it("delete erases the bytes, and deleting an absent key succeeds", async () => {
    // Both halves against the real store, because the second is the one a
    // fake can only assert by fiat - and it is a contract this codebase
    // depends on: account deletion (DELETE /api/me) walks a list of keys
    // that includes uploads which never finished, and a deleter that threw
    // on absence would report the ordinary case as a failed deletion.
    const objectKey = `${runPrefix}/2026/08/to-be-deleted.jpg`;
    await storage.upload(objectKey, new Uint8Array([7, 7, 7]), "image/jpeg");
    expect(await storage.download(objectKey)).toEqual(new Uint8Array([7, 7, 7]));

    await storage.delete(objectKey);
    await expect(storage.download(objectKey)).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
    await expect(storage.delete(objectKey)).resolves.toBeUndefined();
    await expect(
      storage.delete(`${runPrefix}/2026/08/never-existed.jpg`),
    ).resolves.toBeUndefined();
  });

  it("does not report a refused credential as a successful delete", async () => {
    // The other side of the idempotence above. "Absent is success" must not
    // widen into "any failure is success": a token that may not delete has
    // to reject, or account deletion would report objects erased that are
    // still sitting in the bucket.
    const objectKey = `${runPrefix}/2026/08/delete-credential-check.jpg`;
    await storage.upload(objectKey, new Uint8Array([1, 2, 3]), "image/jpeg");
    const wrongCredential = createS3ObjectStorage({
      ...LOCAL_DEV_STORAGE_CONFIG,
      secretAccessKey: "not-the-secret",
    });

    await expect(wrongCredential.delete(objectKey)).rejects.toThrow();
    // And the object is still there, which is what the rejection claimed.
    expect(await storage.download(objectKey)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("does not report a refused credential as an absent object", async () => {
    // The other half of the same distinction, and the half a fake cannot
    // test: a real client, a real failure that is not absence. Nothing but a
    // genuinely missing object may come back as ObjectNotFoundError, or the
    // export path would tell someone to delete a receipt over a bad key.
    const objectKey = `${runPrefix}/2026/08/credential-check.jpg`;
    await storage.upload(objectKey, new Uint8Array([1, 2, 3]), "image/jpeg");
    const wrongCredential = createS3ObjectStorage({
      ...LOCAL_DEV_STORAGE_CONFIG,
      secretAccessKey: "not-the-secret",
    });

    const error = await wrongCredential.download(objectKey).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ObjectNotFoundError);
  });
});

/**
 * A stream that hands over `bytes` in chunks of a size nothing would choose,
 * so a part boundary can never accidentally line up with a chunk boundary.
 */
function chunked(bytes: Buffer, chunkSize = 1_300_021): Readable {
  function* chunks() {
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      yield bytes.subarray(offset, offset + chunkSize);
    }
  }
  return Readable.from(chunks(), { objectMode: false });
}

/** A stream that delivers `bytes` and then fails. */
function failingAfter(bytes: Buffer, failure: Error): Readable {
  return Readable.from(
    (function* () {
      yield bytes;
      throw failure;
    })(),
    { objectMode: false },
  );
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The real multipart path, against MinIO. What this cannot prove is R2's own
 * enforcement of the same-size rule: MinIO accepts mixed part sizes, so a test
 * here passing does not mean R2 would. That is why the part sizes are read back
 * and asserted rather than inferred from the upload having worked.
 */
describe("uploadStream against MinIO", () => {
  const s3 = new S3Client({
    endpoint: LOCAL_DEV_STORAGE_CONFIG.endpoint,
    region: LOCAL_DEV_STORAGE_CONFIG.region,
    credentials: {
      accessKeyId: LOCAL_DEV_STORAGE_CONFIG.accessKeyId,
      secretAccessKey: LOCAL_DEV_STORAGE_CONFIG.secretAccessKey,
    },
    forcePathStyle: LOCAL_DEV_STORAGE_CONFIG.forcePathStyle,
  });
  const bucket = LOCAL_DEV_STORAGE_CONFIG.bucket;

  const head = (objectKey: string, partNumber?: number) =>
    s3.send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        ...(partNumber !== undefined && { PartNumber: partNumber }),
      }),
    );

  const inProgressUploads = async (objectKey: string) => {
    const { Uploads } = await s3.send(
      new ListMultipartUploadsCommand({ Bucket: bucket, Prefix: objectKey }),
    );
    return Uploads ?? [];
  };

  it("round-trips more than a part, in parts of exactly one size", async () => {
    const objectKey = `${runPrefix}/exports/multipart.zip`;
    const bytes = randomBytes(2 * MULTIPART_PART_BYTES + 4_000_000);

    await storage.uploadStream(objectKey, chunked(bytes), "application/zip");

    expect(sha256(await storage.download(objectKey))).toBe(sha256(bytes));
    const object = await head(objectKey);
    // `-3` is the store's own statement that this went up as three parts.
    expect(object.ETag).toMatch(/-3"$/);
    expect(object.ContentType).toBe("application/zip");
    // R2's rule, checked on what was stored.
    expect((await head(objectKey, 1)).ContentLength).toBe(MULTIPART_PART_BYTES);
    expect((await head(objectKey, 2)).ContentLength).toBe(MULTIPART_PART_BYTES);
    expect((await head(objectKey, 3)).ContentLength).toBe(4_000_000);
  }, 30_000);

  it("handles a stream that ends exactly on a part boundary", async () => {
    // The off-by-one case: a final flush of zero bytes would be an empty part,
    // and an empty last part is an upload the store refuses.
    const objectKey = `${runPrefix}/exports/exact-part.zip`;
    const bytes = randomBytes(MULTIPART_PART_BYTES);

    await storage.uploadStream(objectKey, chunked(bytes), "application/zip");

    expect(sha256(await storage.download(objectKey))).toBe(sha256(bytes));
    expect((await head(objectKey)).ETag).toMatch(/-1"$/);
  }, 30_000);

  it("stores a stream shorter than a part as one plain object", async () => {
    const objectKey = `${runPrefix}/exports/short.zip`;
    const bytes = randomBytes(1024);

    await storage.uploadStream(objectKey, chunked(bytes, 100), "application/zip");

    expect(await storage.download(objectKey)).toEqual(new Uint8Array(bytes));
    const object = await head(objectKey);
    expect(object.ETag).not.toContain("-");
    expect(object.ContentType).toBe("application/zip");
  });

  it("stores an empty stream as an empty object, which multipart cannot do", async () => {
    const objectKey = `${runPrefix}/exports/empty.zip`;

    await storage.uploadStream(
      objectKey,
      Readable.from([], { objectMode: false }),
      "application/zip",
    );

    expect((await head(objectKey)).ContentLength).toBe(0);
    expect(await storage.download(objectKey)).toEqual(new Uint8Array());
  });

  it("aborts when the stream fails after a part has gone up, leaving nothing", async () => {
    const objectKey = `${runPrefix}/exports/stream-fails.zip`;
    const failure = new Error("the zip stream broke");

    await expect(
      storage.uploadStream(
        objectKey,
        failingAfter(randomBytes(MULTIPART_PART_BYTES + 1024), failure),
        "application/zip",
      ),
    ).rejects.toBe(failure);

    await expect(storage.download(objectKey)).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
    expect(await inProgressUploads(objectKey)).toEqual([]);
  }, 30_000);

  it("leaves nothing when the stream fails before a part ever filled", async () => {
    const objectKey = `${runPrefix}/exports/fails-early.zip`;
    const failure = new Error("failed before a part");

    await expect(
      storage.uploadStream(
        objectKey,
        failingAfter(randomBytes(1024), failure),
        "application/zip",
      ),
    ).rejects.toBe(failure);

    await expect(storage.download(objectKey)).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
  });

  describe("when the store itself fails", () => {
    /**
     * Fails the first command of this type and sends everything else, so the
     * real client does the real work up to the moment under test.
     */
    function failFirst(commandType: unknown, failure: Error) {
      const send = S3Client.prototype.send as (
        this: S3Client,
        ...args: unknown[]
      ) => unknown;
      let failed = false;
      return vi
        .spyOn(S3Client.prototype, "send")
        .mockImplementation(function (this: S3Client, ...args: unknown[]) {
          if (
            !failed &&
            args[0] instanceof (commandType as new (...a: never[]) => object)
          ) {
            failed = true;
            return Promise.reject(failure);
          }
          return send.apply(this, args) as never;
        });
    }

    it("aborts when a part is refused", async () => {
      const objectKey = `${runPrefix}/exports/part-refused.zip`;
      const failure = new Error("InternalError on part 1");
      const spy = failFirst(UploadPartCommand, failure);
      try {
        await expect(
          storage.uploadStream(
            objectKey,
            chunked(randomBytes(MULTIPART_PART_BYTES + 1024)),
            "application/zip",
          ),
        ).rejects.toBe(failure);
      } finally {
        spy.mockRestore();
      }

      await expect(storage.download(objectKey)).rejects.toBeInstanceOf(
        ObjectNotFoundError,
      );
      expect(await inProgressUploads(objectKey)).toEqual([]);
    }, 30_000);

    it("aborts when completion is refused", async () => {
      const objectKey = `${runPrefix}/exports/complete-refused.zip`;
      const failure = new Error("InvalidPart");
      const spy = failFirst(CompleteMultipartUploadCommand, failure);
      try {
        await expect(
          storage.uploadStream(
            objectKey,
            chunked(randomBytes(MULTIPART_PART_BYTES + 1024)),
            "application/zip",
          ),
        ).rejects.toBe(failure);
      } finally {
        spy.mockRestore();
      }

      await expect(storage.download(objectKey)).rejects.toBeInstanceOf(
        ObjectNotFoundError,
      );
      expect(await inProgressUploads(objectKey)).toEqual([]);
    }, 30_000);

    it("logs a failed abort and still reports the original failure", async () => {
      const objectKey = `${runPrefix}/exports/abort-fails.zip`;
      const failure = new Error("the original failure");
      const abortFailure = new Error("abort was refused too");
      const spy = failFirst(AbortMultipartUploadCommand, abortFailure);
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await expect(
          storage.uploadStream(
            objectKey,
            failingAfter(randomBytes(MULTIPART_PART_BYTES + 1024), failure),
            "application/zip",
          ),
        ).rejects.toBe(failure);
        const line = logged.mock.calls.flat().join(" ");
        expect(line).toContain("Could not abort multipart upload");
        expect(line).toContain("abort was refused too");
        // An export key contains the user id.
        expect(line).not.toContain(objectKey);
      } finally {
        spy.mockRestore();
        logged.mockRestore();
      }

      // The positive control the "nothing in progress" assertions above lean
      // on: the listing really does see an upload that was left behind.
      const uploads = await inProgressUploads(objectKey);
      expect(uploads).toHaveLength(1);
      await s3.send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: objectKey,
          UploadId: uploads[0]?.UploadId,
        }),
      );
    }, 30_000);
  });
});

describe("downloadStream against MinIO", () => {
  it("streams the bytes and states the size", async () => {
    const objectKey = `${runPrefix}/2026/08/stream-me.jpg`;
    const bytes = randomBytes(100_000);
    await storage.upload(objectKey, bytes, "image/jpeg");

    const { body, contentLength } = await storage.downloadStream(objectKey);

    expect(contentLength).toBe(100_000);
    expect(body).toBeInstanceOf(Readable);
    const received: Uint8Array[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      received.push(chunk);
    }
    expect(sha256(Buffer.concat(received))).toBe(sha256(bytes));
  });

  it("answers absence on the same contract as download, up front", async () => {
    const error = await storage
      .downloadStream(`${runPrefix}/does-not-exist.jpg`)
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
    expect(error).toBeInstanceOf(ObjectNotFoundError);
    expect((error as Error).cause).toMatchObject({ name: "NoSuchKey" });
  });

  it("does not report a refused credential as an absent object", async () => {
    const objectKey = `${runPrefix}/2026/08/stream-credential.jpg`;
    await storage.upload(objectKey, new Uint8Array([1, 2, 3]), "image/jpeg");
    const wrongCredential = createS3ObjectStorage({
      ...LOCAL_DEV_STORAGE_CONFIG,
      secretAccessKey: "not-the-secret",
    });

    const error = await wrongCredential.downloadStream(objectKey).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ObjectNotFoundError);
  });
});

describe("listKeys against MinIO", () => {
  it("returns every key under a prefix and nothing beside it", async () => {
    const prefix = `${runPrefix}/list-scoped/`;
    await storage.upload(`${prefix}a.jpg`, new Uint8Array([1]), "image/jpeg");
    await storage.upload(`${prefix}b/c.jpg`, new Uint8Array([1]), "image/jpeg");
    await storage.upload(
      `${runPrefix}/list-scoped-sibling/d.jpg`,
      new Uint8Array([1]),
      "image/jpeg",
    );

    expect((await storage.listKeys(prefix)).sort()).toEqual([
      `${prefix}a.jpg`,
      `${prefix}b/c.jpg`,
    ]);
  });

  it("answers an empty list for a prefix nothing is under", async () => {
    expect(await storage.listKeys(`${runPrefix}/nothing-here/`)).toEqual([]);
  });

  it("walks past one page: S3 answers at most 1000 keys per request", async () => {
    // Reached through a real listing or not at all - a page size here would
    // be a parameter nothing in production passes. 1001 is the smallest count
    // that fails if the continuation token is ignored.
    const prefix = `${runPrefix}/list-paged/`;
    const keys = Array.from(
      { length: 1001 },
      (_, index) => `${prefix}${String(index).padStart(4, "0")}.jpg`,
    );
    for (let index = 0; index < keys.length; index += 32) {
      await Promise.all(
        keys
          .slice(index, index + 32)
          .map((key) => storage.upload(key, new Uint8Array([1]), "image/jpeg")),
      );
    }

    expect((await storage.listKeys(prefix)).sort()).toEqual(keys);

    await deleteUnder(prefix);
    expect(await storage.listKeys(prefix)).toEqual([]);
  }, 60_000);
});

describe("resolveStorageConfig", () => {
  it("returns null when nothing is set", () => {
    expect(resolveStorageConfig({})).toBeNull();
  });

  it("throws naming the missing variables when partially set", () => {
    expect(() =>
      resolveStorageConfig({ STORAGE_ENDPOINT: "http://localhost:9000" }),
    ).toThrow(/STORAGE_BUCKET.*STORAGE_ACCESS_KEY_ID.*STORAGE_SECRET_ACCESS_KEY/);
  });

  it("resolves a full configuration with defaults applied", () => {
    const config = resolveStorageConfig({
      STORAGE_ENDPOINT: "https://accountid.r2.cloudflarestorage.com",
      STORAGE_BUCKET: "kept",
      STORAGE_ACCESS_KEY_ID: "key",
      STORAGE_SECRET_ACCESS_KEY: "secret",
    });
    expect(config).toEqual({
      endpoint: "https://accountid.r2.cloudflarestorage.com",
      bucket: "kept",
      accessKeyId: "key",
      secretAccessKey: "secret",
      region: "auto",
      forcePathStyle: true,
    });
  });
});

/**
 * The startup probe (src/index.ts) refuses to serve until storage answers.
 *
 * These exist because the first version of that probe shipped with no test at
 * all: its body could be replaced with `return;` and the whole suite stayed
 * green, and what slipped through that gap was a probe with no timeout, which
 * hung a boot indefinitely and silently (REVIEW-1 F1, F3).
 */
describe("assertStorageReachable, the startup storage probe", () => {
  it("resolves against the bucket that is really there", async () => {
    await expect(
      assertStorageReachable(LOCAL_DEV_STORAGE_CONFIG),
    ).resolves.toBeUndefined();
  });

  it("rejects a bucket that does not exist, and does not create it", async () => {
    const absent = `no-such-bucket-${runPrefix}`;
    await expect(
      assertStorageReachable({ ...LOCAL_DEV_STORAGE_CONFIG, bucket: absent }),
    ).rejects.toThrow();

    // The probe is read-only, and that is a property worth an assertion rather
    // than a comment: its sibling createBucketIfMissing conjures a bucket, and
    // a deployed bucket is provisioned deliberately with lifecycle rules
    // (spec §10B). A probe that quietly created one would be a rule broken at
    // boot, on the prefix the 30-day export expiry is written against.
    await expect(
      assertStorageReachable({ ...LOCAL_DEV_STORAGE_CONFIG, bucket: absent }),
    ).rejects.toThrow();
  });

  it("rejects a wrong credential rather than accepting it", async () => {
    await expect(
      assertStorageReachable({
        ...LOCAL_DEV_STORAGE_CONFIG,
        secretAccessKey: "not-the-secret",
      }),
    ).rejects.toThrow();
  });

  it("gives up on an endpoint that accepts the connection and never answers", async () => {
    // The regression this file exists to prevent. Without the probe client's
    // own timeouts the SDK waits forever: measured at 45 s and still pending,
    // with the entrypoint emitting zero bytes, binding no port and never
    // exiting - strictly worse than the defect the probe was added to close.
    const accepted: Socket[] = [];
    const sink = createServer((socket) => {
      accepted.push(socket);
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
    const address = sink.address();
    if (address === null || typeof address === "string") {
      throw new Error("could not read the sink's port");
    }

    try {
      const startedAt = Date.now();
      await expect(
        assertStorageReachable(
          {
            ...LOCAL_DEV_STORAGE_CONFIG,
            endpoint: `http://127.0.0.1:${address.port}`,
          },
          // An explicit short timeout so this test costs a second rather than
          // the ten the default spends. What is under test is that SOME bound
          // exists and is honoured - the default's value is a judgement call,
          // its existence is the property.
          800,
        ),
      ).rejects.toThrow(/did not answer within 800ms/);
      // Bounded, not merely eventual.
      expect(Date.now() - startedAt).toBeLessThan(5_000);
    } finally {
      // The accepted sockets are destroyed by hand first: `close()` alone
      // waits for open connections to end, and the whole point of this sink is
      // that its connections never end. (net.Server has no
      // closeAllConnections; that is http.Server's.)
      for (const socket of accepted) {
        socket.destroy();
      }
      await new Promise((resolve) => sink.close(resolve));
    }
  }, 30_000);
});
