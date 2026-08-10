import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { createDb } from "../../src/db/client.js";
import {
  assertSeparateTestDatabase,
  resolveDevDatabaseUrl,
  resolveTestDatabaseUrl,
} from "../helpers/testDatabase.js";

const TEST_DATABASE_URL = resolveTestDatabaseUrl(process.env);
assertSeparateTestDatabase(TEST_DATABASE_URL, resolveDevDatabaseUrl(process.env));

const CHILD_SCRIPT = fileURLToPath(
  new URL("../helpers/poolSurvivalChild.ts", import.meta.url),
);

/**
 * The pool's error listener, which is the only thing standing between a
 * routine server-side connection close and the process exiting.
 *
 * ⚠ The thing that makes this hard to test honestly is that vitest catches the
 * uncaught exception the missing listener produces, and reports it *beside*
 * the test instead of killing the worker. So an in-process assertion of "the
 * process survived" passes either way. That is not a supposition: this file's
 * first draft asserted exactly that and survived its own falsification.
 * Hence the child process in `helpers/poolSurvivalChild.ts` - an exit code
 * read from outside is the only witness that cannot be intercepted.
 *
 * All three tests below were run with the listener deleted and all three fail.
 */
describe("database pool error handling", () => {
  let pools: ReturnType<typeof createDb>[] = [];

  beforeEach(() => {
    pools = [];
  });

  afterEach(async () => {
    for (const { pool } of pools) {
      await pool.end();
    }
  });

  function open() {
    const handle = createDb(TEST_DATABASE_URL);
    pools.push(handle);
    return handle;
  }

  it("keeps a process alive when the server terminates its idle connection", async () => {
    // Asserted across a process boundary, deliberately. Vitest installs its
    // own uncaughtException handling, so in-process this test passes with the
    // listener deleted - measured, not supposed: that was this test's first
    // draft, and it survived its own falsification. The child's exit code is
    // the only honest witness to "the process did not die".
    const child = spawn(
      process.execPath,
      ["--import", "tsx", CHILD_SCRIPT, TEST_DATABASE_URL],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("child never reported READY")),
        20_000,
      );
      child.stdout.on("data", () => {
        if (stdout.includes("READY")) {
          clearTimeout(timer);
          resolve();
        }
      });
      child.on("exit", () => {
        clearTimeout(timer);
        reject(new Error(`child exited before READY: ${stdout}`));
      });
    });

    // The child's own backend, named by the child, rather than "whatever is
    // idle on this database" - which a stray psql or a leaked pool from an
    // earlier crashed run would also satisfy.
    const childBackendPid = Number(/READY (\d+)/.exec(stdout)?.[1]);
    expect(Number.isInteger(childBackendPid)).toBe(true);

    const killer = open();
    const terminated = await killer.db.execute<{ terminated: boolean }>(sql`
      select pg_terminate_backend(${childBackendPid}) as terminated
    `);
    // A run that terminates nothing would pass while proving nothing.
    expect(terminated.rows[0]?.terminated).toBe(true);

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
    });

    expect(stdout).toContain("SURVIVED");
    expect(exitCode).toBe(0);
  }, 30_000);

  it("logs the terminated connection without reproducing the database error's text", async () => {
    const { db } = open();
    // Named, not inferred from "whatever is idle", for the same reason as above.
    const backend = await db.execute<{ pid: number }>(
      sql`select pg_backend_pid() as pid`,
    );
    const backendPid = backend.rows[0]?.pid;
    expect(backendPid).toBeGreaterThan(0);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const killer = open();
      const terminated = await killer.db.execute<{ terminated: boolean }>(
        sql`select pg_terminate_backend(${backendPid}) as terminated`,
      );
      expect(terminated.rows[0]?.terminated).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 250));

      const lines = logged.mock.calls.map((call) => call.join(" "));
      const line = lines.find((text) =>
        text.includes("Idle database connection error"),
      );
      expect(line).toBeDefined();
      // The SQLSTATE survives, because a log line saying only "something
      // failed" is not enough to act on...
      expect(line).toContain("57P01");
      // ...and the error's own message does not, because a database error's
      // text is never safe to reproduce (see observability/errorSummary).
      expect(line).not.toContain("terminating connection");
    } finally {
      logged.mockRestore();
    }

    // "Survived in a usable state", asserted by using it. `pool.ended` was
    // here first and was removed: it only says nobody called `end()`, which
    // nothing in this test does, so it could not fail.
    const after = await db.execute(sql`select 1 as alive`);
    expect(after.rows[0]).toEqual({ alive: 1 });
  });

  it("does not throw when the pool emits an error with no client attached", () => {
    const { pool } = open();
    // The listener's presence IS the behaviour: emit('error') on an
    // EventEmitter without one throws. Deleting the listener fails this line.
    expect(() => pool.emit("error", new Error("synthetic"))).not.toThrow();
  });
});
