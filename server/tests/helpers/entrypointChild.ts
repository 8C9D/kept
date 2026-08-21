import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { resolveTestDatabaseUrl } from "./testDatabase.js";

/**
 * Spawning the REAL production entrypoint as a child process, shared by the
 * two suites that do it: the startup probes, whose claim is "the process
 * refuses to serve", and the shutdown drain, whose claim is "the process exits
 * 0 after finishing what it was doing". Neither claim is observable from inside
 * vitest - one ends a process and the other is a signal handler - so both watch
 * a child's output and its exit status from outside.
 *
 * Shared rather than copied because the environment below is not boilerplate:
 * every entry in it is load-bearing, and two copies drifting apart would take
 * one of the suites back to passing for the wrong reason (see the STORAGE_*
 * note).
 */
export const ENTRYPOINT = fileURLToPath(
  new URL("../../src/index.ts", import.meta.url),
);

/**
 * Start the entrypoint on `port`, with `overrides` layered over the defaults.
 *
 * ANTHROPIC_API_KEY is stripped from the child's environment: src/index.ts
 * kicks the LLM parse sweep at startup whenever it is set, which bills a real
 * API. NODE_ENV is forced away from production so assertProductionEnv (which
 * would demand https storage and that key) stays out of what these suites
 * measure.
 */
export function spawnEntrypoint(
  port: number,
  overrides: Record<string, string> = {},
): ChildProcessByStdio<null, Readable, Readable> {
  const {
    ANTHROPIC_API_KEY: _anthropic,
    NODE_ENV: _nodeEnv,
    PORT: _port,
    ...inherited
  } = process.env;

  return spawn(process.execPath, ["--import", "tsx", ENTRYPOINT], {
    env: {
      ...inherited,
      SESSION_JWT_SECRET: "startup-probe-secret-0123456789abcdef",
      APPLE_CLIENT_ID: "net.keptapp.test",
      // Defaulted to a database that answers so each case overrides only the
      // thing it is actually exercising. Without this a test that varies
      // STORAGE_* alone gets the missing-variable refusal instead, which looks
      // like a pass for the wrong reason.
      DATABASE_URL: resolveTestDatabaseUrl(process.env),
      // Never 3000 - a stale dev server has held that port on this machine for
      // six recorded runs. Each caller passes a port nothing else uses.
      PORT: String(port),
      // ⚠ STORAGE_* is set explicitly, and that is not tidiness. These are the
      // branch selector in src/index.ts: unset, the entrypoint takes the
      // local-MinIO path and the configured-storage probe never runs. The first
      // version of these tests inherited the shell, which on this machine has
      // no STORAGE_*, so every child took the MinIO branch and the entire
      // `else` block could be deleted with the suite still green (REVIEW-FINAL
      // F-3). Setting them here also stops the suite depending on whatever a
      // developer happens to have exported.
      STORAGE_ENDPOINT: "http://localhost:9000",
      STORAGE_BUCKET: "kept",
      STORAGE_ACCESS_KEY_ID: "kept",
      STORAGE_SECRET_ACCESS_KEY: "kept-local-dev",
      ...overrides,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}
