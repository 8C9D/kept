import Anthropic from "@anthropic-ai/sdk";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createAppleIdentityVerifier } from "./auth/appleVerifier.js";
import { createSessionTokens } from "./auth/session.js";
import { createDb } from "./db/client.js";
import {
  findPortListeners,
  formatPortInUseMessage,
} from "./observability/portInUse.js";
import { parseReceiptText } from "./parse/claudeReceiptParser.js";
import { createLlmParseSweep } from "./parse/llmParseSweep.js";
import { assertProductionEnv } from "./productionEnv.js";
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

// Under NODE_ENV=production (the Dockerfile sets it) the deployed shape is
// checked too: real storage configured over https, a non-loopback database,
// a full-strength session secret. A no-op in local development.
assertProductionEnv(process.env);

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

// The server-side LLM parse (spec §7.3). Kicked at startup for anything a
// restart interrupted, after each capture by the receipt routes, and on an
// interval as the retry net for rows whose parse failed. The interval is
// deliberately long: the kicks cover the normal path, and an idle-hours
// query cadence would keep Neon's autosuspending compute awake for nothing.
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
const llmParseSweep =
  anthropicApiKey !== undefined && anthropicApiKey !== ""
    ? createLlmParseSweep({
        db,
        parse: (() => {
          const client = new Anthropic({ apiKey: anthropicApiKey });
          return (ocrRawText: string) => parseReceiptText(client, ocrRawText);
        })(),
      })
    : undefined;
if (llmParseSweep === undefined) {
  // Impossible in production - assertProductionEnv has already refused a
  // missing key there. In local dev it is a stated degradation, not silence.
  console.log(
    "ANTHROPIC_API_KEY is not set - LLM receipt parsing disabled, suggestions are heuristic-only",
  );
} else {
  llmParseSweep.kick();
  setInterval(() => llmParseSweep.kick(), SWEEP_INTERVAL_MS).unref();
}

const app = createApp({
  db,
  // Always the real verifier. Local development and tests inject fakes by
  // constructing their own app; this file offers no way to do so.
  appleVerifier: createAppleIdentityVerifier(appleClientId),
  sessionTokens: createSessionTokens(sessionSecret),
  storage: createS3ObjectStorage(storageConfig),
  // Set once Cloudflare fronts the origin (see docs/Runbook.md); unset,
  // the origin answers anyone - correct for dev and for the first deploy.
  edgeSharedSecret: process.env.EDGE_SHARED_SECRET,
  ...(llmParseSweep !== undefined && { llmParseSweep }),
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
