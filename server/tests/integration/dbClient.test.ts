import { spawn } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import type { AddressInfo } from "node:net";
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

describe("the pool's connect timeout", () => {
  /**
   * PR-9(a). The pool was built with `connectionString` alone, so no connect
   * timer was ever armed and a checkout against a host that accepts the TCP
   * connection and never completes the handshake waited forever.
   *
   * ⚠ These pass NO options, deliberately. That is the whole point: the
   * project has now caught eight assertions that could not fail, and two of
   * them were tests that passed an override for the very value they claimed to
   * pin, leaving the DEFAULT that production uses covered by nothing. What
   * `createDb` produces from a URL alone is what `src/index.ts` runs on, so it
   * is what these measure.
   *
   * Falsification, predicted then run, by deleting `connectionTimeoutMillis`
   * from `createDb`:
   *   Predicted: the first case fails on `toBe(10_000)` with undefined, and
   *   the second fails its upper time bound.
   *   Actual: the first failed exactly as predicted at :211. The second did
   *   NOT fail an assertion - it never reached one. It hung until vitest
   *   killed it at 40 s ("Test timed out in 40000ms"), and the afterEach hook
   *   then timed out too, because `pool.end()` on a pool with a pending
   *   connect never settles either.
   *   Gap, and it is the better outcome: the failure mode of the mutation is
   *   the finding itself. "Waits forever" is not something an assertion can
   *   observe from inside the wait, which is why the upper bound exists at all
   *   and why the vitest timeout is the real witness.
   */
  const opened: ReturnType<typeof createDb>[] = [];
  const sinks: Server[] = [];
  const held: Socket[] = [];

  afterEach(async () => {
    // ⚠ Order matters, and getting it wrong hangs the suite rather than
    // failing it. `server.close()` stops accepting but does NOT drop sockets
    // already accepted, and `pool.end()` waits on a connect that the sink is
    // still holding open. So the held sockets are destroyed first, which lets
    // both of the others settle. Found by this teardown timing out at 10 s
    // while the test it followed had already passed.
    for (const socket of held.splice(0)) {
      socket.destroy();
    }
    await Promise.all(opened.splice(0).map(({ pool }) => pool.end().catch(() => {})));
    await Promise.all(
      sinks.splice(0).map(
        (server) => new Promise<void>((resolve) => server.close(() => resolve())),
      ),
    );
  });

  it("is set by DEFAULT, not only when a caller asks for one", () => {
    const db = createDb(TEST_DATABASE_URL);
    opened.push(db);
    // Unset this reads `undefined`, which pg-pool tests for falsiness and
    // treats as "no timer".
    expect(db.pool.options.connectionTimeoutMillis).toBe(10_000);
  });

  it("fails a checkout against a black-holed host instead of waiting forever", async () => {
    // A socket that accepts the connection and then says nothing at all: the
    // wedged-proxy / black-holed-endpoint case, which is the one an unset
    // timeout hangs on. A closed port would fail fast on its own and would
    // prove nothing.
    const sink = createServer((socket) => {
      // Accept and hold. No Postgres handshake will ever arrive. The socket is
      // kept so teardown can destroy it; dropping it here would make this a
      // connection-refused test, which proves nothing.
      held.push(socket);
    });
    sinks.push(sink);
    await new Promise<void>((resolve) => sink.listen(0, "127.0.0.1", resolve));
    const { port } = sink.address() as AddressInfo;

    const db = createDb(`postgres://kept:kept@127.0.0.1:${port}/kept_test`);
    opened.push(db);

    const startedAt = Date.now();
    await expect(db.pool.query("select 1")).rejects.toThrow(/timeout/i);
    const elapsed = Date.now() - startedAt;

    // Bounded by the default, not by anything this test passed in. The upper
    // bound is what fails if the timeout is removed; the lower bound is what
    // fails if someone "fixes" a slow test by dropping the value to something
    // that would refuse a waking Neon compute.
    expect(elapsed).toBeGreaterThan(8_000);
    expect(elapsed).toBeLessThan(20_000);
  }, 40_000);
});
