import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ObjectStorage } from "./objectStorage.js";

/**
 * The real ObjectStorage implementation, S3-compatible (spec §4.2). One
 * adapter serves both environments: locally it points at the MinIO
 * container in docker-compose, in deployment at Cloudflare R2 - so the
 * presigned upload/download path wave 4 depends on is exercised end to
 * end long before R2 credentials exist. (Wave-3 gate review.)
 */
export interface S3StorageConfig {
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO serves buckets as path prefixes, not subdomains. */
  forcePathStyle: boolean;
}

/** Presigned URLs are short-lived by design (spec §10B): long enough for
 * an upload or an image render, useless to anyone who finds one later. */
const PRESIGN_EXPIRY_SECONDS = 300;

/**
 * The docker-compose MinIO instance, used when no STORAGE_* environment is
 * set. These are local-container credentials committed on the same
 * reasoning as the Postgres kept/kept pair in docker-compose.yml: they
 * guard a database that only ever holds synthetic local data.
 */
export const LOCAL_DEV_STORAGE_CONFIG: S3StorageConfig = {
  endpoint: "http://localhost:9000",
  region: "us-east-1",
  bucket: "kept",
  accessKeyId: "kept",
  secretAccessKey: "kept-local-dev",
  forcePathStyle: true,
};

/**
 * Reads STORAGE_* into a config, with three honest outcomes: fully
 * configured, not configured at all (the caller falls back to the local
 * default), or - the case that must not pass silently - partially
 * configured, which throws naming exactly what is missing.
 */
export function resolveStorageConfig(
  env: Record<string, string | undefined>,
): S3StorageConfig | null {
  const names = [
    "STORAGE_ENDPOINT",
    "STORAGE_BUCKET",
    "STORAGE_ACCESS_KEY_ID",
    "STORAGE_SECRET_ACCESS_KEY",
  ] as const;
  const present = names.filter((name) => (env[name] ?? "") !== "");
  if (present.length === 0) {
    return null;
  }
  if (present.length < names.length) {
    const missing = names.filter((name) => !present.includes(name));
    throw new Error(
      `Object storage is partially configured; missing: ${missing.join(", ")}`,
    );
  }
  return {
    endpoint: env.STORAGE_ENDPOINT as string,
    bucket: env.STORAGE_BUCKET as string,
    accessKeyId: env.STORAGE_ACCESS_KEY_ID as string,
    secretAccessKey: env.STORAGE_SECRET_ACCESS_KEY as string,
    region: env.STORAGE_REGION ?? "auto",
    // Default on: right for MinIO and harmless for R2, which accepts both
    // addressing styles.
    forcePathStyle: env.STORAGE_FORCE_PATH_STYLE !== "false",
  };
}

export function createS3ObjectStorage(config: S3StorageConfig): ObjectStorage {
  const client = makeClient(config);
  const bucket = config.bucket;

  return {
    async presignUpload(objectKey, contentType) {
      return getSignedUrl(
        client,
        new PutObjectCommand({
          Bucket: bucket,
          Key: objectKey,
          ContentType: contentType,
        }),
        {
          expiresIn: PRESIGN_EXPIRY_SECONDS,
          // By default a presigned URL signs only the host header, which
          // would make uploadUrlSchema's content-type restriction
          // decorative: any bytes under any declared type would store.
          // Signing content-type binds the PUT to the type the client
          // declared and the server validated. (Found by the integration
          // test asserting a mismatched PUT fails.)
          signableHeaders: new Set(["content-type"]),
        },
      );
    },

    async presignDownload(objectKey) {
      return getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
        { expiresIn: PRESIGN_EXPIRY_SECONDS },
      );
    },

    async upload(objectKey, data, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: objectKey,
          Body: data,
          ContentType: contentType,
        }),
      );
    },

    async download(objectKey) {
      const response = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: objectKey }),
      );
      if (response.Body === undefined) {
        // A 200 with no body is not a state S3 defines; refuse loudly
        // rather than hand back empty bytes.
        throw new Error(`Object ${objectKey} returned no body`);
      }
      return response.Body.transformToByteArray();
    },
  };
}

/**
 * Creates the bucket if it does not exist. Only local development calls
 * this (dev default at startup, `npm run storage:init`, tests) - a
 * deployed environment's bucket is provisioned deliberately, lifecycle
 * rules and all (spec §10B), not conjured by the API server.
 */
export async function createBucketIfMissing(
  config: S3StorageConfig,
): Promise<void> {
  const client = makeClient(config);
  try {
    await client.send(new HeadBucketCommand({ Bucket: config.bucket }));
    return;
  } catch (error) {
    if (!isNotFound(error)) {
      throw error;
    }
  }
  await client.send(new CreateBucketCommand({ Bucket: config.bucket }));
}

/**
 * How long the startup probe below will wait for storage to answer. Generous
 * enough for a cold TLS handshake to R2 from another continent, and short
 * enough that a boot cannot stall behind it.
 */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Prove configured object storage ANSWERS, without creating anything.
 *
 * The sibling above conjures a bucket, and only local development may call it
 * - a deployed bucket is provisioned deliberately, lifecycle rules and all
 * (spec §10B). So the deployed shape gets the read-only half of the same
 * question, and a wrong R2 token stops the process at startup instead of
 * surfacing as the first image upload.
 *
 * ⚠ The operation is a `GetObject` on a key that cannot exist, NOT a
 * `HeadBucket`. That difference is the finding, not a preference. A boot-
 * blocking probe must use a permission the deployed credential is known to
 * have, and `docs/gates/wave-6.md:118` provisions the R2 token as scoped to
 * the bucket "with read and write" - it says nothing about bucket-level
 * metadata, and nothing in this project has ever issued `HeadBucket` against
 * R2 (`npm run storage:probe-keys` exercises `GetObject` and `PutObject`).
 * A token that could serve every request in the app but not answer
 * `HeadBucket` would have blocked the deploy outright, which is a P0 traded
 * for a P1. Reading a key is exactly what `download` does on the export path,
 * so a credential that fails this probe cannot serve an export either.
 *
 * `NoSuchKey`/`NotFound` is therefore SUCCESS: it is storage answering, in
 * full sentences, that the bucket is there and the credential may read it.
 * Everything else fails - `NoSuchBucket` (wrong bucket), a signature or
 * access-key error (wrong credential), a timeout (nothing answered).
 *
 * ⚠ The timeout is the whole reason this is safe to put in front of a boot,
 * and it was added after this shipped without one. The first version issued a
 * bare `HeadBucket`, and against a host that accepts the TCP connection and
 * never answers - a black-holed endpoint, a wedged proxy - it stayed pending
 * indefinitely: measured at 45 s and still going, with the process emitting
 * zero bytes, binding no port and never exiting. That traded a failure the
 * operator could read at the first image upload for one nothing anywhere
 * reports, which is the exact shape this round exists to remove.
 *
 * The second version passed `requestHandler: { connectionTimeout,
 * requestTimeout }` to the client, and that was measured too: it does nothing.
 * The same sink held it past 180 s. Configuring the SDK's handler properly
 * needs `@smithy/node-http-handler`, which is a dependency of the S3 client
 * rather than one this project declares, and importing it would be reaching
 * through someone else's manifest. So the bound is a race this module owns.
 *
 * That race is a near-copy of the one in db/client.ts, deliberately. The two
 * startup probes belong to different subsystems with no shared home, and the
 * alternatives are worse: a storage module importing from the database module
 * inverts the layering, and a new module for twelve lines is a boundary that
 * does not exist. If a third probe ever appears, that is the moment to hoist
 * it.
 *
 * Retries are the SDK's own rather than a loop here. R2 does not autosuspend,
 * so there is no cold start to wait out the way the database probe must, and
 * beyond that Fly restarts a machine whose process exits - which is only true
 * now that this is guaranteed to settle.
 *
 * Deliberately NOT a method on ObjectStorage: adding a `head` operation to
 * that interface is the open ruling about an existence check at capture time,
 * and this must not decide it in passing.
 */
export async function assertStorageReachable(
  config: S3StorageConfig,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<void> {
  const client = makeClient(config);
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client
        .send(new GetObjectCommand({ Bucket: config.bucket, Key: PROBE_KEY }))
        .catch((error: unknown) => {
          if (isMissingObject(error)) {
            return; // storage answered: bucket present, credential may read
          }
          throw error;
        }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(`Object storage did not answer within ${timeoutMs}ms`),
            ),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
    // The abandoned send keeps a socket open until the SDK gives up on it.
    // Destroying the client releases it, so a timed-out probe cannot leave the
    // process holding a handle it will never use - this client is the probe's
    // own and nothing else ever sends through it.
    client.destroy();
  }
}

/**
 * The key the probe reads and expects to be absent. Deliberately a shape
 * neither `receiptImageObjectKey` ({userId}/yyyy/mm/{uuid}.{ext}) nor
 * `exportObjectKey` (exports/{userId}/{jobId}/{filename}) can ever produce, so
 * it cannot collide with a real object no matter who is signed in.
 */
const PROBE_KEY = ".startup-probe/reachability";

/**
 * "That object is not there", as distinct from `isNotFound` below, which
 * answers "that BUCKET is not there". The probe needs them separated: an
 * absent object is the answer it wants, and an absent bucket is a failure.
 */
function isMissingObject(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("name" in error)) {
    return false;
  }
  const name = (error as { name: unknown }).name;
  return name === "NoSuchKey" || name === "NotFound";
}

function makeClient(config: S3StorageConfig): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    },
    forcePathStyle: config.forcePathStyle,
  });
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    ((error as { name: string }).name === "NotFound" ||
      (error as { name: string }).name === "NoSuchBucket")
  );
}
