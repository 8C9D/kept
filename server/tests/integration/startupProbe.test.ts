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

  it("retries and waits by DEFAULT, not only when a caller asks for it", async () => {
    // REVIEW-FINAL F-2. Every other case here passes `attempts` and `delayMs`
    // explicitly, so the *production* budget - the one the entrypoint uses, the
    // one ASSUMPTION 5 rests on, and the one docs/Runbook.md §0 now promises an
    // operator - was pinned by nothing: forcing the defaults to `attempts = 1,
    // delayMs = 0` left the whole suite at 287/287.
    //
    // This case passes NO options, so it fails if either default is weakened.
    let calls = 0;
    const startedAt = Date.now();
    const real = poolFor(TEST_DATABASE_URL);
    const flaky = {
      async query(text: string) {
        calls += 1;
        // Fails four times, which is exactly what a five-attempt budget
        // tolerates and a smaller one does not.
        if (calls <= 4) {
          throw new Error("ECONNREFUSED (still waking)");
        }
        return real.query(text);
      },
    } as unknown as Pool;

    await expect(assertDatabaseReachable(flaky)).resolves.toBeUndefined();
    expect(calls).toBe(5);
    // And it actually waited between attempts rather than spinning: four gaps
    // at the default second apart. Asserted well under 4000 ms so a slow
    // machine cannot fail it, and well over 0 so a zeroed delay cannot pass it.
    expect(Date.now() - startedAt).toBeGreaterThan(2_000);
  }, 30_000);

  it("gives up on a probe that never settles, carrying its own bound", async () => {
    // ⚠ This comment used to read "because the pool sets no connect timeout:
    // createDb passes connectionString alone, so connectionTimeoutMillis is 0".
    // Round 3 made all three clauses false - PR-9(a) gave the pool a 10 s
    // connect timeout, and REVIEW-0 established that an unset value is never
    // coerced to 0, it simply arms no timer. Corrected here rather than left,
    // for the same reason as the docstring in src/db/client.ts: this round's
    // own findings were about prose that outlived the code it described.
    //
    // The behaviour under test is unchanged and still worth pinning. The
    // probe's race bounds an ATTEMPT, which is not what the pool's option
    // bounds: `pool.query` spans more than a connect, and a checkout served by
    // an already-open client never touches the connect timeout at all. The
    // fake below never settles for any reason, so only the probe's own bound
    // can end it.
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

  it("refuses to serve when configured object storage does not answer", async () => {
    // REVIEW-FINAL F-3: the entrypoint's storage branch had no coverage at all
    // - the whole `else` block could be deleted with the suite green. This
    // drives it through the real entrypoint, pointed at a port nothing listens
    // on.
    const result = await runEntrypoint({ STORAGE_ENDPOINT: "http://127.0.0.1:9089" });

    expect(result.exitCode).not.toBe(0);
    expect(result.output).not.toContain("Kept API listening");
    expect(result.output).toContain("Object storage did not answer");
    // The credential is in this child's environment; it must not be in its log.
    expect(result.output).not.toContain("kept-local-dev");
  }, 40_000);

  it("tells the operator which permission the probe actually needs, and names no file the image does not carry", async () => {
    // R3-1. `868d796` moved the probe from HeadBucket to a GetObject of a key
    // that cannot exist, deliberately, because a bucket-scoped "read and write"
    // R2 token is not known to permit bucket-level metadata - and it left this
    // refusal telling the operator to go check exactly that metadata
    // permission. It also pointed at PROD-READINESS-ROUND-2.md, which
    // server/Dockerfile does not COPY into the image, so the one reader of this
    // sentence cannot open the document it sends them to.
    //
    // Falsification, predicted then run, per the project's rule:
    //   Predicted: reverting src/index.ts to the old wording fails this case on
    //   the `not.toContain("PROD-READINESS-ROUND-2.md")` assertion.
    //   Actual: it failed two assertions EARLIER, on `toMatch(/GetObject/)`
    //   (startupProbe.test.ts:248), because the old message names no operation
    //   at all and vitest reports only the first failure.
    //   Gap, recorded rather than smoothed over: the prediction was written
    //   about what the old message says WRONG, and the assertion that fires
    //   first is about what it does not say at ALL. Both directions are pinned
    //   deliberately - the positive assertions fail if the operation is
    //   unnamed, the negative ones fail if either half of the old text returns
    //   - so a partial revert cannot slip through whichever fires first.
    const result = await runEntrypoint({ STORAGE_ENDPOINT: "http://127.0.0.1:9089" });

    expect(result.output).toContain("Object storage did not answer");
    // The permission it names must be the one the probe uses.
    expect(result.output).toMatch(/GetObject/);
    expect(result.output).toMatch(/may read objects in that bucket/);
    // Neither half of the old message may come back.
    expect(result.output).not.toMatch(/bucket's metadata/);
    expect(result.output).not.toContain("PROD-READINESS-ROUND-2.md");
    // A refusal is read on a machine that has only what the Dockerfile copied,
    // so it may not send the reader to a repository file at all.
    expect(result.output).not.toMatch(/PROD-READINESS|reviews\//);
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
        // Defaulted to a database that answers so each case below overrides
        // only the thing it is actually exercising. Without this a test that
        // varies STORAGE_* alone gets the missing-variable refusal instead,
        // which looks like a pass for the wrong reason.
        DATABASE_URL: TEST_DATABASE_URL,
        // A port nothing else in this suite uses, and never 3000 - a stale dev
        // server has held that port on this machine for six recorded runs.
        PORT: "3097",
        // ⚠ STORAGE_* is set explicitly, and that is not tidiness. These are
        // the branch selector at src/index.ts: unset, the entrypoint takes the
        // local-MinIO path and the configured-storage probe never runs. The
        // first version of these tests inherited the shell, which on this
        // machine has no STORAGE_*, so every child took the MinIO branch and
        // the entire `else` block could be deleted with the suite still green
        // (REVIEW-FINAL F-3). Setting them here also stops the suite depending
        // on whatever a developer happens to have exported.
        STORAGE_ENDPOINT: "http://localhost:9000",
        STORAGE_BUCKET: "kept",
        STORAGE_ACCESS_KEY_ID: "kept",
        STORAGE_SECRET_ACCESS_KEY: "kept-local-dev",
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
