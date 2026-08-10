/**
 * Run as a CHILD PROCESS by `tests/integration/dbClient.test.ts`, and it has
 * to be a child process rather than a function call.
 *
 * The behaviour under test is "the process does not die". Inside vitest that
 * is unobservable: vitest installs its own uncaughtException handling, so a
 * pool error with no listener is reported beside the test instead of killing
 * the worker - and an in-process assertion written against it passes whether
 * the listener exists or not. That was measured, not assumed: the first draft
 * of this test did exactly that and survived its own falsification.
 *
 * So the assertion is the child's exit code, read from outside.
 *
 * Prints READY once a pooled connection is established and idle, then waits.
 * The parent terminates that connection from a separate pool. If the listener
 * is doing its job the child prints SURVIVED and exits 0; if it is missing,
 * the child dies on an uncaught exception with a non-zero code and no SURVIVED.
 */
import { sql } from "drizzle-orm";
import { createDb } from "../../src/db/client.js";

const databaseUrl = process.argv[2];
if (databaseUrl === undefined) {
  throw new Error("poolSurvivalChild needs a database URL as argv[2]");
}

const { db, pool } = createDb(databaseUrl);

// The connection must exist before it can be terminated - the reason this
// defect never showed on an unauthenticated request, which never checks one
// out of the pool.
await db.execute(sql`select 1`);
console.log("READY");

// Long enough for the parent to terminate the backend and for the socket
// error to arrive, and short enough that a hung child fails the test rather
// than the suite.
await new Promise((resolve) => setTimeout(resolve, 1500));

// Still here. Prove the pool also still works, so "survived" cannot mean
// "survived in a broken state".
const after = await db.execute(sql`select 1 as alive`);
if (after.rows[0]?.alive !== 1) {
  throw new Error("pool survived but no longer answers");
}

console.log("SURVIVED");
await pool.end();
