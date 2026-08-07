import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createAppleIdentityVerifier } from "./auth/appleVerifier.js";
import { createSessionTokens } from "./auth/session.js";
import { createDb } from "./db/client.js";
import {
  findPortListeners,
  formatPortInUseMessage,
} from "./observability/portInUse.js";
import {
  LOCAL_DEV_STORAGE_CONFIG,
  createBucketIfMissing,
  createS3ObjectStorage,
  resolveStorageConfig,
} from "./storage/s3ObjectStorage.js";

/**
 * The production entrypoint. Configuration is read here and nowhere else,
 * and a missing value stops the process at startup with a list of what is
 * absent - not later, at the first request that needed it.
 */
const REQUIRED_ENV = [
  "DATABASE_URL",
  "SESSION_JWT_SECRET",
  "APPLE_CLIENT_ID",
] as const;

const missingEnv = REQUIRED_ENV.filter((name) => {
  const value = process.env[name];
  return value === undefined || value === "";
});
if (missingEnv.length > 0) {
  throw new Error(
    `Missing required environment variables: ${missingEnv.join(", ")}`,
  );
}
const databaseUrl = process.env.DATABASE_URL as string;
const sessionSecret = process.env.SESSION_JWT_SECRET as string;
const appleClientId = process.env.APPLE_CLIENT_ID as string;

const port = Number(process.env.PORT ?? "3000");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`PORT must be a port number, got: ${process.env.PORT}`);
}

// Object storage: STORAGE_* when set (R2 in deployment, or MinIO under a
// custom endpoint), otherwise the docker-compose MinIO default - in which
// case the bucket is auto-created, so a clean checkout serves images with
// no ceremony. (Wave-3 gate review: wave 4's capture path cannot run
// against a server that cannot store.)
const configuredStorage = resolveStorageConfig(process.env);
const storageConfig = configuredStorage ?? LOCAL_DEV_STORAGE_CONFIG;
if (configuredStorage === null) {
  console.log(
    `Object storage: local MinIO default at ${storageConfig.endpoint} (set STORAGE_* to point elsewhere)`,
  );
  try {
    await createBucketIfMissing(storageConfig);
  } catch (error) {
    // Same philosophy as the env check above: stop at startup with the
    // fix named, not at the first request that needed an image.
    throw new Error(
      `MinIO is not reachable at ${storageConfig.endpoint} - run "docker compose up -d" in server/`,
      { cause: error },
    );
  }
}

const { db } = createDb(databaseUrl);
const app = createApp({
  db,
  // Always the real verifier. Local development and tests inject fakes by
  // constructing their own app; this file offers no way to do so.
  appleVerifier: createAppleIdentityVerifier(appleClientId),
  sessionTokens: createSessionTokens(sessionSecret),
  storage: createS3ObjectStorage(storageConfig),
});

const server = serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Kept API listening on port ${info.port}`);
});

// Same philosophy as the env and MinIO checks above: stop with the fix
// named. A bare EADDRINUSE reports the wrong fact - the useful one is
// which build is answering on that port (see portInUse).
server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EADDRINUSE") {
    throw error;
  }
  console.error(formatPortInUseMessage(port, findPortListeners(port)));
  process.exit(1);
});
