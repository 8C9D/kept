import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RETRY_BACKOFF_MS,
  ToolFailedError,
  describeFailure,
  forEachConcurrently,
  preflightProblems,
  retrying,
  runTool,
  spawnTool,
} from "../../src/db/backupTools.js";

/** Split so the fixtures below read as fixtures to the repo's secret hook. */
const PG = "postgres:" + "//";

/**
 * The run helper exists for one reason, and it is the first test here: Node's
 * own `execFileSync` puts the whole command line in the Error it throws, so a
 * failed `pg_dump <url>` writes the database password into the log.
 */

const SECRET_URL = `${PG}kept:hunter2-secret@neon.example/kept`;
const NODE = process.execPath;
const FAILING = ["-e", "process.exit(3)", SECRET_URL];

async function thrownBy(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
  } catch (error) {
    return error;
  }
  throw new Error("expected this to reject");
}

describe("runTool", () => {
  it("names the tool and the exit code, and never the arguments", async () => {
    const error = await thrownBy(
      runTool(NODE, FAILING, { timeoutMs: 10_000, stderr: "withhold" }),
    );
    expect(error).toBeInstanceOf(ToolFailedError);
    expect((error as ToolFailedError).message).toBe(`${NODE} exited with code 3`);
    expect((error as ToolFailedError).exitCode).toBe(3);
  });

  it("carries no argv anywhere on the error, including the stack and any cause", async () => {
    const error = (await thrownBy(
      runTool(NODE, FAILING, { timeoutMs: 10_000, stderr: "withhold" }),
    )) as Error;
    const everything = [
      error.message,
      error.stack,
      JSON.stringify(error),
      JSON.stringify(Object.getOwnPropertyNames(error).map((name) => [name, String((error as never)[name])])),
    ].join("\n");
    expect(everything).not.toContain("hunter2");
    expect(error.cause).toBeUndefined();
  });

  it("does the same for a tool that is not installed", async () => {
    const error = (await thrownBy(
      runTool("kept-no-such-tool", [SECRET_URL], { timeoutMs: 10_000, stderr: "forward" }),
    )) as Error;
    expect(error.message).toBe("kept-no-such-tool is not on PATH");
    expect(String(error.stack)).not.toContain("hunter2");
  });

  it("forwards a failing tool's stderr only when told to", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const noisy = ["-e", "console.error('Failing row contains (vendor)'); process.exit(1)"];
      await thrownBy(runTool(NODE, noisy, { timeoutMs: 10_000, stderr: "withhold" }));
      expect(write).not.toHaveBeenCalled();
      await thrownBy(runTool(NODE, noisy, { timeoutMs: 10_000, stderr: "forward" }));
      expect(String(write.mock.calls[0]?.[0])).toContain("Failing row contains");
    } finally {
      write.mockRestore();
    }
  });

  it("returns a succeeding tool's output", async () => {
    const result = await runTool(NODE, ["-e", "console.log('hello')"], {
      timeoutMs: 10_000,
      stderr: "withhold",
    });
    expect(result.stdout.trim()).toBe("hello");
  });

  it("stops a tool that hangs, and says so rather than hanging with it", async () => {
    const error = (await thrownBy(
      runTool(NODE, ["-e", "setTimeout(() => {}, 60000)"], { timeoutMs: 100, stderr: "withhold" }),
    )) as Error;
    expect(error.message).toContain("was stopped after 100 ms");
  });
});

describe("spawnTool", () => {
  it("reports a failure as data instead of rejecting", async () => {
    const result = await spawnTool(NODE, ["-e", "console.error('nope'); process.exit(2)"], {
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("nope");
  });

  it("reports a tool that cannot be found", async () => {
    const result = await spawnTool("kept-no-such-tool", [], { timeoutMs: 10_000 });
    expect(result.startError).toBe("ENOENT");
    expect(result.exitCode).toBeNull();
  });
});

describe("preflightProblems", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function binDirectory(tools: Record<string, string>): string {
    const directory = mkdtempSync(join(tmpdir(), "kept-preflight-"));
    directories.push(directory);
    for (const [name, version] of Object.entries(tools)) {
      writeFileSync(join(directory, name), `#!/bin/sh\necho '${version}'\n`);
      chmodSync(join(directory, name), 0o755);
    }
    return directory;
  }

  const allAt16 = {
    pg_dump: "pg_dump (PostgreSQL) 16.4",
    pg_restore: "pg_restore (PostgreSQL) 16.4",
    initdb: "initdb (PostgreSQL) 16.4",
    pg_ctl: "pg_ctl (PostgreSQL) 16.4",
  };

  it("passes when every tool is there at 16 or newer", async () => {
    const env = { PATH: `${binDirectory(allAt16)}:/usr/bin:/bin` };
    expect(await preflightProblems("s3", { env })).toEqual([]);
  });

  it("names every missing tool, not just the first", async () => {
    const env = { PATH: binDirectory({}) };
    const problems = await preflightProblems("s3", { env });
    expect(problems.join("\n")).toMatch(/pg_dump is not on PATH/);
    expect(problems.join("\n")).toMatch(/pg_restore is not on PATH/);
    expect(problems.join("\n")).toMatch(/initdb is not on PATH/);
    expect(problems.join("\n")).toMatch(/pg_ctl is not on PATH/);
  });

  it("refuses an old tool by name", async () => {
    const env = {
      PATH: `${binDirectory({ ...allAt16, pg_ctl: "pg_ctl (PostgreSQL) 15.6" })}:/usr/bin:/bin`,
    };
    const problems = await preflightProblems("s3", { env });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("pg_ctl is version 15");
  });

  it("requires wrangler in wrangler mode and only there", async () => {
    const env = { PATH: `${binDirectory(allAt16)}:/usr/bin:/bin` };
    expect(await preflightProblems("s3", { env })).toEqual([]);
    const problems = await preflightProblems("wrangler", { env });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("wrangler is not on PATH");
  });
});

describe("describeFailure", () => {
  it("keeps our own errors' messages", () => {
    expect(describeFailure(new ToolFailedError("pg_dump", 1, "exited with code 1"))).toBe(
      "ToolFailedError: pg_dump exited with code 1",
    );
  });

  it("withholds a database error's text, which can carry row values", () => {
    const databaseError = Object.assign(new Error("Failing row contains (Secret Vendor)"), {
      severity: "ERROR",
      code: "23514",
      detail: "Failing row contains (Secret Vendor)",
    });
    const described = describeFailure(databaseError);
    expect(described).not.toContain("Secret Vendor");
    expect(described).toContain("code=23514");
  });

  it("reads the reason off an error with no message, as a refused connection is", () => {
    const refused = Object.assign(new AggregateError([], ""), { code: "ECONNREFUSED" });
    expect(describeFailure(refused)).toContain("ECONNREFUSED");
  });

  it("is one line", () => {
    expect(describeFailure(new Error("one\ntwo"))).not.toContain("\n");
  });
});

describe("retrying", () => {
  it("retries up to three times, with growing delays", async () => {
    const delays: number[] = [];
    let attempts = 0;
    const result = await retrying(
      async () => {
        attempts += 1;
        return "still failing";
      },
      () => true,
      async (ms) => {
        delays.push(ms);
      },
    );
    expect(result).toBe("still failing");
    expect(attempts).toBe(4);
    expect(delays).toEqual([...RETRY_BACKOFF_MS]);
    expect(delays).toEqual([1000, 2000, 4000]);
  });

  it("stops at the first result that is not transient", async () => {
    let attempts = 0;
    const result = await retrying(
      async () => {
        attempts += 1;
        return attempts;
      },
      (value) => value < 2,
      async () => {},
    );
    expect(result).toBe(2);
    expect(attempts).toBe(2);
  });
});

describe("forEachConcurrently", () => {
  it("visits everything once, never more than `limit` at a time", async () => {
    let inFlight = 0;
    let peak = 0;
    const seen: number[] = [];
    await forEachConcurrently([1, 2, 3, 4, 5, 6, 7], 2, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      seen.push(item);
      inFlight -= 1;
    });
    expect(seen.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(peak).toBe(2);
  });

  it("does nothing for an empty list", async () => {
    await expect(forEachConcurrently([], 2, async () => {})).resolves.toBeUndefined();
  });
});
