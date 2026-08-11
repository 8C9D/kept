import { createServer, type Socket } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LOCAL_DEV_STORAGE_CONFIG,
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

afterAll(() => {
  // Objects under runPrefix are left behind deliberately: MinIO's volume
  // is disposable dev state, and deleting would need list+delete surface
  // the ObjectStorage interface does not (and should not) expose.
});

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

  it("download of a missing key fails loudly, and names itself NoSuchKey", async () => {
    // The name is load-bearing, not incidental. `generateExport` decides
    // whether a failed download means "this receipt's photo is gone" or
    // "storage did not answer" by `error.name === "NoSuchKey"`, and the two
    // lead to opposite advice - one of them tells a person to delete a
    // receipt. Only this test runs against a real S3 client; the fake
    // asserts the name by fiat, so if the real name ever drifts, that check
    // silently becomes a no-op with every other test still green.
    await expect(
      storage.download(`${runPrefix}/does-not-exist.jpg`),
    ).rejects.toThrow();
    await expect(
      storage.download(`${runPrefix}/does-not-exist.jpg`),
    ).rejects.toMatchObject({ name: "NoSuchKey" });
  });
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
