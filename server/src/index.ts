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
  assertStorageReachable,
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
    await assertStorageReachable(storageConfig);
  } catch (error) {
    // ⚠ This names the operation the probe actually issues, and that is the
    // whole point of the sentence. It used to say "read the bucket's metadata"
    // and to cite a ledger file, and both were wrong: the probe was moved off
    // `HeadBucket` and onto a `GetObject` precisely BECAUSE bucket metadata is
    // the permission an R2 token scoped "read and write to one bucket" is not
    // known to carry, so the old text sent an operator to check the one thing
    // the fix exists to avoid needing. The cited file is not copied into the
    // image (see the Dockerfile), so it named a document the reader cannot
    // open. A refusal message is read exactly once, by someone with a broken
    // deploy, and it has to be true on its own.
    //
    // Reported through errorSummary and exited, rather than thrown - the same
    // shape as the database probe below, and for that probe's reason rather
    // than a stylistic one. A thrown error is printed by node's default
    // handler, which dumps the whole object, and the object here is an AWS SDK
    // error carrying `$metadata` and whatever else the SDK hung on it. Measured
    // today it leaks no credential; "it happens to be safe" is the phrasing the
    // paragraph above rejects for this message's own wording, and it is no
    // better as a guarantee about the dump printed underneath it. errorSummary
    // decides what an error is allowed to say. node's default handler decides
    // nothing.
    console.error(
      `Object storage did not answer at ${storageConfig.endpoint} for bucket ` +
        `"${storageConfig.bucket}", so this process is refusing to serve. Check ` +
        `STORAGE_ENDPOINT, STORAGE_BUCKET and the credentials in ` +
        `STORAGE_ACCESS_KEY_ID / STORAGE_SECRET_ACCESS_KEY - and, if those are ` +
        `right, that the token may read objects in that bucket: the probe ` +
        `issues one GetObject and expects it to come back "no such key". ` +
        `That is the same permission the export download path needs.`,
    );
    console.error(errorSummary(error));
    process.exit(1);
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
  // Reported through errorSummary and exited, rather than thrown. The
  // difference is not style: a `pg` failure carries database-error markers,
  // and a thrown error is printed by node's default handler, which dumps the
  // whole object - the exact thing PR-2 established must never happen. A
  // connection failure happens to carry no row values; "happens to" is not the
  // guarantee this project chose to rest on, and the next failure to reach
  // this line might be a different one.
  //
  // The configured-storage probe above now reports the same way, for the same
  // reason (round 3 §8 observation 1). The local-MinIO branch above it is the
  // one path still throwing raw, and that is deliberate rather than missed: it
  // is reachable only with STORAGE_* unset, which assertProductionEnv refuses
  // in production, so its dump can only ever reach a developer's own terminal.
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
/** Held so the shutdown path below can clear it; see the note there. */
let sweepTimer: NodeJS.Timeout | undefined;
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
  sweepTimer = setInterval(() => llmParseSweep.kick(), SWEEP_INTERVAL_MS);
  // Unref'd so this timer alone never keeps the process alive: an interval is
  // a handle, and a six-hour one would hold the event loop open for six hours
  // after everything else had finished.
  sweepTimer.unref();
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

/**
 * How long the process waits for in-flight requests after a shutdown signal
 * before it stops waiting and exits anyway.
 *
 * 3 s is a judgement, not a measurement, and is written down as one. The budget
 * it has to fit inside is the platform's: `fly deploy` and `fly machine stop`
 * signal the old machine, wait `kill_timeout` - fly.toml sets none, so the
 * platform default of 5 s - and then SIGKILL, which severs exactly what this
 * path exists to protect. Three seconds of drain plus the pool's second below
 * leaves a second of that budget spare for the signal to reach a busy event
 * loop; a cap that overruns the platform's own is not a cap, it is a wish.
 *
 * What it is measured against on the other side: every route here answers from
 * a small number of Postgres round trips against a pool whose connect bound is
 * 10 s, so a request still running at 3 s was not going to finish inside the
 * kill_timeout under any cap. The known exception is an export DOWNLOAD, which
 * streams a year of images and can legitimately run longer - it is severed, and
 * that is safe because the export job is a row: it survives the restart and the
 * client asks for the file again.
 */
const SHUTDOWN_DRAIN_TIMEOUT_MS = 3_000;

/**
 * The same idea for the database pool, and it is a separate bound because it
 * guards a different hang. `pool.end()` resolves when every client is back, and
 * db/client.ts's own docstring records that a timed-out startup probe can leave
 * a checkout that is never released - one of those and `end()` never settles.
 * A second is generous for the real case (returning idle clients, which is
 * local work) and refuses to spend the rest of the kill_timeout on the other.
 */
const POOL_CLOSE_TIMEOUT_MS = 1_000;

let shuttingDown = false;

/**
 * Graceful shutdown, which this process had none of: with no signal handler
 * registered, `kill -TERM` ended it instantly and every request in flight was
 * severed mid-response on every single deploy (PR-5).
 *
 * Announced rather than silent, on the same reasoning as the storage probe's
 * "checking ..." line above: a process that goes quiet for three seconds and
 * then exits is indistinguishable, in a log, from one that hung. The line
 * carries the signal name and nothing else - no configuration, no request data.
 */
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) {
    // A second signal is whoever sent it saying they are not willing to wait
    // for the drain. Honour that immediately - and not with 0, because this
    // exit did not do what the line below promised: requests were cut off.
    console.error(
      `${signal} received again - exiting now, without finishing the drain`,
    );
    process.exit(1);
  }
  shuttingDown = true;
  console.log(
    `${signal} received - draining in-flight requests, then exiting`,
  );
  void drainAndExit();
}

async function drainAndExit(): Promise<void> {
  // The sweep interval is already unref'd, so it is not what would hold the
  // loop open and clearing it is not what makes this exit possible. It is
  // cleared because the drain is about to end the pool the sweep queries
  // through, and a kick landing in that window fails for a reason nobody needs
  // to read. No test covers it: a six-hour interval cannot be made to fire
  // inside a three-second drain from outside the process, and the alternative
  // to one cheap line is a race nobody would find twice.
  if (sweepTimer !== undefined) {
    clearInterval(sweepTimer);
  }

  const closed = new Promise<void>((resolve, reject) => {
    // `close` stops the listener at once, then waits for the connections that
    // are sending a request or waiting for a response - and, since node 19,
    // only those: a keep-alive connection sitting BETWEEN requests is let go
    // rather than waited on.
    //
    // ⚠ This paragraph replaced an explicit `server.closeIdleConnections()`
    // call here, and the reason is worth keeping. That call read as the
    // load-bearing line of the drain - every request from the iOS client
    // arrives on a kept-alive connection, so the idle case IS the common case -
    // and deleting it changed nothing: measured on node 24.15, `close`'s
    // callback fires in 0 ms with an answered keep-alive socket still open. A
    // line no test can tell from its own absence is a line that will be
    // believed. If some future node goes back to waiting on idle sockets, the
    // cap below is what bounds it, and the keep-alive case in
    // tests/integration/gracefulShutdown.test.ts is what reports it.
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });

  const drain = await settleWithin(closed, SHUTDOWN_DRAIN_TIMEOUT_MS);
  if (drain.state === "timed out") {
    console.error(
      `In-flight requests did not finish within ${SHUTDOWN_DRAIN_TIMEOUT_MS}ms - ` +
        `closing the remaining connections and exiting anyway, because the ` +
        `platform's kill_timeout would SIGKILL this process moments later.`,
    );
    // The one line in this file that ends a connection someone is still using,
    // and it is here rather than left to `process.exit` below because `close`
    // explicitly does NOT touch these - "stop waiting" has to mean "let them
    // go" somewhere. The exit a few milliseconds later would drop the sockets
    // too, so no test can tell this line from its absence; it is kept for the
    // same reason the sentence above names the cap rather than going quiet.
    // (The `in` guard is type narrowing, not doubt: `serve` is declared as an
    // http/http2 union and this file only ever builds the http one.)
    if ("closeAllConnections" in server) {
      server.closeAllConnections();
    }
  } else if (drain.state === "failed") {
    console.error("The HTTP server did not close cleanly during shutdown");
    console.error(errorSummary(drain.error));
  }

  const poolClosed = await settleWithin(pool.end(), POOL_CLOSE_TIMEOUT_MS);
  if (poolClosed.state === "timed out") {
    console.error(
      `The database pool did not finish closing within ${POOL_CLOSE_TIMEOUT_MS}ms - ` +
        `exiting with connections still open, which the database reaps on its side.`,
    );
  } else if (poolClosed.state === "failed") {
    // Said, never swallowed. There is nothing left to recover here - the
    // process is one line from exiting - but a teardown that failed silently
    // is how a leaked connection becomes a mystery later.
    console.error("The database pool did not close cleanly during shutdown");
    console.error(errorSummary(poolClosed.error));
  }

  // 0 deliberately, and in all three of the cases above: the exit code answers
  // "did this process shut down because it was asked to", and a deploy that
  // reported failure every time a teardown detail went wrong would train the
  // operator to ignore it. What went wrong is on stderr, where it is read.
  process.exit(0);
}

type SettleOutcome =
  | { state: "settled" }
  | { state: "failed"; error: unknown }
  | { state: "timed out" };

/**
 * Wait for `work`, but not past `timeoutMs`, and report which happened.
 *
 * Deliberately not db/client.ts's `withTimeout`, which rejects on expiry: there
 * a timeout is a failure to report, here it is a decision to stop waiting, and
 * both outcomes are ordinary. A rejection is captured rather than raced, so a
 * promise that fails AFTER the deadline has passed cannot land as an unhandled
 * rejection on a process that has already moved on.
 */
async function settleWithin(
  work: Promise<unknown>,
  timeoutMs: number,
): Promise<SettleOutcome> {
  const settled: Promise<SettleOutcome> = work.then(
    () => ({ state: "settled" }),
    (error: unknown) => ({ state: "failed", error }),
  );
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      settled,
      new Promise<SettleOutcome>((resolve) => {
        timer = setTimeout(() => resolve({ state: "timed out" }), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

// SIGINT as well as SIGTERM: Fly signals a stopping machine with SIGINT, and
// Ctrl-C in local development sends the same. Both mean "stop", and only one of
// them was ever going to be the one that mattered in production.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => shutdown(signal));
}
