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
