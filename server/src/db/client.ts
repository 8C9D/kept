import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { errorSummary } from "../observability/errorSummary.js";
import * as schema from "./schema.js";

/** The docker-compose dev database; seed and tests default to it. */
export const LOCAL_DEV_DATABASE_URL =
  "postgres://kept:kept@localhost:5432/kept";

export function createDb(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl });

  // ⚠ Without this listener the process DIES when a pooled connection sitting
  // idle is closed from the server side. `pg` re-emits that client's error on
  // the pool (pg-pool/index.js, `idleListener`), and an EventEmitter 'error'
  // with no listener is an uncaught exception - so a routine event on the
  // database's side takes down the API. Measured against the real entrypoint:
  // one `pg_terminate_backend` on one idle connection, and the process exits
  // with `code: '57P01'` and the port goes dead.
  //
  // Routine is the operative word. Neon's compute autosuspends when idle,
  // which at three users is most of the time, and every failover, maintenance
  // window and connection reap closes idle connections the same way.
  //
  // Not fatal, deliberately: `pg` has already discarded the broken client, and
  // the next checkout opens a fresh connection. There is nothing to recover
  // and nothing for a caller to do, so this logs and returns. An in-flight
  // query is not silenced by this - it rejects through its own promise and
  // reaches the route's error handling as it always did.
  pool.on("error", (error) => {
    console.error("Idle database connection error:", errorSummary(error));
  });

  const db = drizzle(pool, { schema });
  return { db, pool };
}

export type Db = ReturnType<typeof createDb>["db"];

/**
 * Prove the database ANSWERS before the process agrees to serve.
 *
 * The entrypoint already refuses to start on a missing environment variable
 * and on a configuration that is not production-shaped. Both of those ask
 * about the string. Neither asks whether the service it names is there - and
 * `pg` connects lazily, so nothing else did either: a wrong password produced
 * a process that printed "Kept API listening", passed the `curl /api/me` →
 * 401 check the Runbook prescribes (that path never opens a connection), and
 * answered 500 to every authenticated request.
 *
 * Retried rather than probed once, because the deployment target autosuspends.
 * A Neon compute waking is the expected first-connection experience, not a
 * fault, and crashing on it would turn a routine cold start into a restart
 * loop. A wrong credential fails all the attempts and costs only the budget
 * below.
 *
 * Each attempt carries its own timeout because the pool has none: the pool is
 * built with `connectionString` alone, so `connectionTimeoutMillis` is 0 and a
 * connect against a black-holed host would otherwise hang here forever.
 *
 * A timed-out attempt leaves its query running on the pool, and the cost is
 * stated exactly rather than rounded down: with the default five attempts, up
 * to four can time out before one succeeds, so up to four checkouts outlive
 * their probe. One that eventually settles returns to the pool and is reclaimed
 * by pg's 10 s idle reaper; one that never settles is never idle and never
 * reaped, permanently costing a slot of the pool's `max` of 10. The bound that
 * makes this acceptable is not the reaper - it is that the only caller is
 * startup, which either proceeds once (worst case: a pool of 6) or exits.
 */
export async function assertDatabaseReachable(
  pool: Pool,
  options: { attempts?: number; delayMs?: number; timeoutMs?: number } = {},
): Promise<void> {
  const attempts = options.attempts ?? 5;
  const delayMs = options.delayMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 5000;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await withTimeout(pool.query("select 1"), timeoutMs);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw new Error(
    `Database did not answer after ${attempts} attempts`,
    { cause: lastError },
  );
}

class ProbeTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Probe did not answer within ${timeoutMs}ms`);
    this.name = "ProbeTimeoutError";
  }
}

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ProbeTimeoutError(timeoutMs)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
