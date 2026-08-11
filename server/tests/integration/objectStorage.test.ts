import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LOCAL_DEV_STORAGE_CONFIG,
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
