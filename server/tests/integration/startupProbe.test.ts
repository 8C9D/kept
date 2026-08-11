import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { assertDatabaseReachable } from "../../src/db/client.js";
import { resolveTestDatabaseUrl } from "../helpers/testDatabase.js";

const TEST_DATABASE_URL = resolveTestDatabaseUrl(process.env);
const UNREACHABLE_DATABASE_URL = TEST_DATABASE_URL.replace(
  /^postgres:\/\/([^:]+):[^@]*@/,
  "postgres://$1:wrong-password@",
);

const ENTRYPOINT = fileURLToPath(new URL("../../src/index.ts", import.meta.url));

describe("assertDatabaseReachable", () => {
  const pools: Pool[] = [];

  afterEach(async () => {
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
  });

  function poolFor(url: string): Pool {
    const pool = new Pool({ connectionString: url });
    // Without a listener, a pool whose connection fails re-emits on the pool
    // and an EventEmitter 'error' with no listener is an uncaught exception -
    // the defect round 1 closed in createDb. These bare pools are the test's
    // own, so they need their own.
    pool.on("error", () => {});
    pools.push(pool);
    return pool;
  }

  it("resolves against a database that answers", async () => {
    await expect(
      assertDatabaseReachable(poolFor(TEST_DATABASE_URL)),
    ).resolves.toBeUndefined();
  });

  it("rejects a wrong credential rather than waiting forever", async () => {
    await expect(
      assertDatabaseReachable(poolFor(UNREACHABLE_DATABASE_URL), {
        attempts: 2,
        delayMs: 10,
        timeoutMs: 2000,
      }),
    ).rejects.toThrow(/did not answer after 2 attempts/);
  });

  it("retries rather than failing on the first refusal, which is what a waking Neon compute looks like", async () => {
    // The retry is the whole reason this probe is safe to put in front of an
    // autosuspending database, so it is asserted rather than assumed: a pool
    // that fails once and then answers must be accepted.
    let calls = 0;
    const real = poolFor(TEST_DATABASE_URL);
    const flaky = {
      async query(text: string) {
        calls += 1;
        if (calls === 1) {
          throw new Error("ECONNREFUSED (the compute is still waking)");
        }
        return real.query(text);
      },
    } as unknown as Pool;

    await expect(
      assertDatabaseReachable(flaky, { attempts: 3, delayMs: 10 }),
    ).resolves.toBeUndefined();
    expect(calls).toBe(2);
  });

  it("gives up on a probe that never settles, because the pool sets no connect timeout", async () => {
    // PR-9: createDb passes connectionString alone, so connectionTimeoutMillis
    // is 0 - "wait forever". If the probe leaned on the pool's timeout instead
    // of carrying its own, a black-holed host would hang startup indefinitely
    // rather than refusing it.
    const neverSettles = {
      query() {
        return new Promise(() => {});
      },
    } as unknown as Pool;

    const startedAt = Date.now();
    await expect(
      assertDatabaseReachable(neverSettles, {
        attempts: 2,
        delayMs: 10,
        timeoutMs: 150,
      }),
    ).rejects.toThrow(/did not answer after 2 attempts/);
    // Two 150 ms timeouts plus a 10 ms gap; comfortably under a second, and
    // emphatically not forever.
    expect(Date.now() - startedAt).toBeLessThan(3000);
  });
});

/**
 * The claim these cover is "the PROCESS refuses to serve", and that is not
 * observable from inside vitest: the entrypoint's failure is a top-level
 * throw, and vitest's own error handling would report it beside the test
 * instead of ending a process. An in-process assertion would pass whether the
 * probe existed or not - which is exactly the unfalsifiable shape this project
 * has now caught six times (see tests/helpers/poolSurvivalChild.ts).
 *
 * So the entrypoint is spawned as a child and the assertions are its exit
 * code and its output, read from outside.
 *
 * Falsification, run before this was committed. Predicted first, then run,
 * then the gap recorded - because a test whose failing direction was never
 * run is a claim, not a check.
 *
 *   Predicted: with the probe deleted from src/index.ts, the first test below
 *   fails on `expect(exitCode).not.toBe(0)`.
 *   Actual: it fails one assertion later, on
 *   `expect(result.output).not.toContain("Kept API listening")`, with
 *   "Kept API listening on port 3097" in the received output.
 *   Why: the harness kills a child that announces itself listening, so the
 *   exit code is null rather than 0, and `null` is `not.toBe(0)`. The
 *   listening line is what actually distinguishes the two worlds, which is
 *   why it is asserted separately rather than being left to the exit code.
 *
 * All four `assertDatabaseReachable` cases above were falsified, each by
 * deleting or inverting the behaviour it pins - the count was wrong in the
 * first draft of this comment, which said three and then named two mutations
 * (REVIEW-1 F4a):
 *
 *   - forcing `attempts` to 1 fails the retry case, and both cases that pin
 *     the "after 2 attempts" wording;
 *   - replacing `withTimeout(pool.query(...))` with a bare `pool.query(...)`
 *     fails the never-settles case with "Test timed out in 5000ms" instead of
 *     rejecting in under a second;
 *   - inverting the probe so it never accepts fails the "resolves against a
 *     database that answers" case.
 *
 * "rejects a wrong credential rather than waiting forever" is the weak one and
 * is left standing deliberately: a probe that ALWAYS rejects satisfies it, so
 * it discriminates only in company with the resolves-when-answering case above
 * it. Said here rather than left for a reviewer to find.
 */
describe("the entrypoint's startup probe", () => {
  it("refuses to serve when the database does not answer, and never binds the port", async () => {
    const result = await runEntrypoint({
      DATABASE_URL: UNREACHABLE_DATABASE_URL,
    });

    expect(result.exitCode).not.toBe(0);
    // The whole point: no listener. A process that printed this line would be
    // the defect, since that is the line an operator reads as success.
    expect(result.output).not.toContain("Kept API listening");
    // Named well enough to act on...
    expect(result.output).toMatch(/did not answer/);
    expect(result.output).toContain("DATABASE_URL");
    // ...and without the credential, because DATABASE_URL carries a password
    // and this text goes to the machine's log.
    expect(result.output).not.toContain("wrong-password");
  }, 40_000);

  it("never prints the password, even when DATABASE_URL is malformed enough to confuse a URL parser", async () => {
    // REVIEW-1 F2. A DATABASE_URL that lost its `postgres://` prefix still
    // parses: `new URL()` puts the userinfo in the pathname, so databaseIdentity
    // returns the password as the *database name*. The refusal message used to
    // render that field, on the line whose own comment said it withheld the URL
    // because "DATABASE_URL carries the password".
    //
    // The password below is fabricated, and the assertion is that it does not
    // come back out.
    const result = await runEntrypoint({
      DATABASE_URL: "kept:s3cr3t-PASSWORD@localhost:5432/kept_test",
    });

    expect(result.output).not.toContain("s3cr3t-PASSWORD");
    // ...and the refusal still happened, so this cannot be satisfied by a
    // process that silently did nothing.
    expect(result.output).not.toContain("Kept API listening");
    expect(result.exitCode).not.toBe(0);
  }, 40_000);

  it("still starts against a database that answers, so the probe cannot be a false alarm", async () => {
    // The negative test above passes if the entrypoint refuses to start for
    // ANY reason. This is the one that says the refusal is specific.
    const result = await runEntrypoint({ DATABASE_URL: TEST_DATABASE_URL });

    expect(result.output).toContain("Kept API listening");
    expect(result.output).not.toMatch(/did not answer/);
  }, 40_000);
});

interface EntrypointResult {
  exitCode: number | null;
  output: string;
}

/**
 * Run the real production entrypoint as a child process and collect what it
 * said. Resolves when the child exits, or when it announces it is listening -
 * a healthy start never exits on its own, so that case is killed deliberately.
 *
 * ANTHROPIC_API_KEY is stripped from the child's environment: src/index.ts
 * kicks the LLM parse sweep at startup whenever it is set, which bills a real
 * API. NODE_ENV is forced away from production so assertProductionEnv (which
 * would demand https storage and that key) stays out of what this measures.
 */
async function runEntrypoint(
  env: Record<string, string>,
): Promise<EntrypointResult> {
  const {
    ANTHROPIC_API_KEY: _anthropic,
    NODE_ENV: _nodeEnv,
    PORT: _port,
    ...inherited
  } = process.env;

  const child = spawn(
    process.execPath,
    ["--import", "tsx", ENTRYPOINT],
    {
      env: {
        ...inherited,
        SESSION_JWT_SECRET: "startup-probe-secret-0123456789abcdef",
        APPLE_CLIENT_ID: "net.keptapp.test",
        // A port nothing else in this suite uses, and never 3000 - a stale dev
        // server has held that port on this machine for five recorded runs.
        PORT: "3097",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let output = "";
  return new Promise<EntrypointResult>((resolve, reject) => {
    const settle = (exitCode: number | null) => {
      clearTimeout(guard);
      resolve({ exitCode, output });
    };
    const guard = setTimeout(() => {
      child.kill("SIGKILL");
      settle(null);
    }, 30_000);

    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("Kept API listening")) {
        // A healthy entrypoint never exits by itself; it has said everything
        // this test needs, so it is stopped here.
        child.kill("SIGKILL");
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", reject);
    child.on("close", settle);
  });
}
