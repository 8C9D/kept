import Anthropic from "@anthropic-ai/sdk";
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createAppleIdentityVerifier } from "./auth/appleVerifier.js";
import { createSessionTokens } from "./auth/session.js";
import { assertDatabaseReachable, createDb } from "./db/client.js";
import { databaseIdentity } from "./db/databaseUrl.js";
import { errorSummary } from "./observability/errorSummary.js";
import {
  findPortListeners,
  formatPortInUseMessage,
} from "./observability/portInUse.js";
import { parseReceiptText } from "./parse/claudeReceiptParser.js";
import { createLlmParseSweep } from "./parse/llmParseSweep.js";
import { assertProductionEnv } from "./productionEnv.js";
import {
  LOCAL_DEV_STORAGE_CONFIG,
  assertBucketReachable,
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
} else {
  // The branch above has always proved local storage answers. Configured
  // storage - R2 in deployment, and any STORAGE_* set on a laptop - had no
  // equivalent, so a wrong token surfaced as the first image upload rather
  // than at boot. Read-only: this asks whether the bucket is there, and
  // never creates one.
  //
  // Announced before it blocks, like the MinIO branch above: this is the
  // first thing that talks to a network at boot, and a boot that says
  // nothing until it succeeds is indistinguishable from a boot that hung.
  console.log(
    `Object storage: checking ${storageConfig.endpoint} for bucket "${storageConfig.bucket}"`,
  );
  try {
    await assertBucketReachable(storageConfig);
  } catch (error) {
    throw new Error(
      `Object storage did not answer at ${storageConfig.endpoint} for bucket ` +
        `"${storageConfig.bucket}", so this process is refusing to serve. Check ` +
        `STORAGE_ENDPOINT, STORAGE_BUCKET and the credentials in ` +
        `STORAGE_ACCESS_KEY_ID / STORAGE_SECRET_ACCESS_KEY - and, if those are ` +
        `right, that the token is permitted to read the bucket's metadata ` +
        `(see ASSUMPTIONS in PROD-READINESS-ROUND-2.md).`,
      { cause: error },
    );
  }
}

const { db, pool } = createDb(databaseUrl);

// The configuration checks above all ask whether a value is present and
// well-shaped. This is the one that asks whether the service it names is
// actually there - the gap that let a wrong password produce a process that
// listened, satisfied the Runbook's `GET /api/me` → 401 deploy check (which
// never opens a connection), and answered 500 to every real request.
try {
  await assertDatabaseReachable(pool);
} catch (error) {
  // Reported through errorSummary and exited, rather than thrown like the
  // storage failures above. The difference is not style: a `pg` failure
  // carries database-error markers, and a thrown error is printed by node's
  // default handler, which dumps the whole object - the exact thing PR-2
  // established must never happen. A connection failure happens to carry no
  // row values; "happens to" is not the guarantee this project chose to rest
  // on, and the next failure to reach this line might be a different one.
  console.error(
    `Database at ${describeDatabaseTarget(databaseUrl)} did not answer, so this ` +
      `process is refusing to serve. Check DATABASE_URL and that the database ` +
      `is running and reachable from here.`,
  );
  console.error(errorSummary(error));
  process.exit(1);
}

/**
 * Name the database this process was pointed at, for a log line, carrying
 * nothing secret.
 *
 * ⚠ Host and port ONLY. The first version of this message also rendered the
 * database name, and that is how a password reaches the log: `databaseIdentity`
 * reads it from the URL's pathname, and a DATABASE_URL that lost its
 * `postgres://` prefix still parses - the userinfo then lands in the pathname,
 * so `kept:hunter2@localhost:5432/kept` renders as `:5432/hunter2@localhost:
 * 5432/kept`. Measured, on the very line whose comment said it withheld the
 * URL because "DATABASE_URL carries the password".
 *
 * Parsing is guarded for the same reason: `databaseIdentity` throws with the
 * whole URL inside its own message, and this is called on a path where nothing
 * has parsed it first (`assertProductionEnv` returns immediately outside
 * production).
 */
function describeDatabaseTarget(url: string): string {
  try {
    const identity = databaseIdentity(url, "DATABASE_URL");
    return `${identity.host}:${identity.port}`;
  } catch {
    return "the configured DATABASE_URL (which is not a parseable URL)";
  }
}

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
