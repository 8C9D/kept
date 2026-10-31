import { spawn } from "node:child_process";
import { errorSummary } from "../observability/errorSummary.js";
import {
  PG_TOOLS,
  assertPgToolVersion,
  type BackupTransportName,
} from "./backupConfig.js";

/**
 * Running other programs, retrying and bounding things - the mechanics the
 * backup job shares, separated from what it does with them.
 */

/** How much of a tool's output is kept. Enough to read a failure; not a dump. */
const OUTPUT_TAIL_BYTES = 64 * 1024;

/** How long a SIGTERM gets before a timed-out tool is killed outright. */
const KILL_GRACE_MS = 5_000;

const VERSION_PROBE_TIMEOUT_MS = 30_000;

export interface ToolOptions {
  /**
   * Required, so that no call can hang silently. launchd reports nothing about
   * a job that never exits, which makes a stuck tool the one failure that
   * neither the log nor the notification would ever show.
   */
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

export interface ToolResult {
  /** Null when the tool never started, timed out or died on a signal. */
  exitCode: number | null;
  /** `ENOENT` and friends, set when the tool could not be started at all. */
  startError?: string;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

/**
 * ⚠ The message carries the tool's name and how it ended, and never its
 * arguments, and that is the entire reason this class exists. Node's own
 * `execFileSync` builds its Error from the whole command line, so a failed
 * `pg_dump <url>` writes the database password into whatever logged the error.
 *
 * No `cause` either, for the same reason: spawn's errors carry `spawnargs`, and
 * a logger printing the chain would print the argv this class just kept out of
 * the message.
 */
export class ToolFailedError extends Error {
  constructor(
    readonly tool: string,
    readonly exitCode: number | null,
    outcome: string,
  ) {
    super(`${tool} ${outcome}`);
    this.name = "ToolFailedError";
  }
}

/**
 * Runs a tool to completion and reports how it ended, whichever way. Never
 * rejects: a caller who needs to read a failure's output, which is how the
 * wrangler adapter tells absence from everything else, gets it as data rather
 * than off an error object where a logger could print it.
 */
export function spawnTool(
  tool: string,
  args: readonly string[],
  options: ToolOptions,
): Promise<ToolResult> {
  return new Promise((resolve) => {
    const child = spawn(tool, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killTimer: NodeJS.Timeout | undefined;
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = keepTail(stdout + chunk.toString("utf8"));
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = keepTail(stderr + chunk.toString("utf8"));
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS);
    }, options.timeoutMs);

    const settle = (result: Omit<ToolResult, "stdout" | "stderr" | "timedOut">) => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      resolve({ ...result, timedOut, stdout, stderr });
    };

    child.once("error", (error: NodeJS.ErrnoException) => {
      settle({ exitCode: null, signal: null, startError: error.code ?? "unknown error" });
    });
    child.once("close", (exitCode, signal) => {
      settle({ exitCode, signal });
    });
  });
}

/**
 * Runs a tool that must succeed; anything else throws a ToolFailedError.
 *
 * `stderr` is a required choice rather than a default because it is a decision
 * about what reaches the log. `forward` prints the tool's own stderr on
 * failure, which is what makes "pg_dump exited with code 1" actionable;
 * `withhold` drops it. pg_restore must withhold: a failing COPY echoes the row
 * it choked on, and no receipt contents go in a log.
 */
export async function runTool(
  tool: string,
  args: readonly string[],
  options: ToolOptions & { stderr: "forward" | "withhold" },
): Promise<ToolResult> {
  const result = await spawnTool(tool, args, options);
  if (result.exitCode === 0) {
    return result;
  }
  if (options.stderr === "forward" && result.stderr !== "") {
    process.stderr.write(result.stderr.endsWith("\n") ? result.stderr : `${result.stderr}\n`);
  }
  throw new ToolFailedError(tool, result.exitCode, describeToolOutcome(result, options.timeoutMs));
}

export function describeToolOutcome(result: ToolResult, timeoutMs: number): string {
  if (result.startError === "ENOENT") {
    return "is not on PATH";
  }
  if (result.startError !== undefined) {
    return `could not be started (${result.startError})`;
  }
  if (result.timedOut) {
    return `was stopped after ${timeoutMs} ms without finishing`;
  }
  if (result.signal !== null) {
    return `was killed by ${result.signal}`;
  }
  return `exited with code ${result.exitCode}`;
}

function keepTail(text: string): string {
  return text.length > OUTPUT_TAIL_BYTES ? text.slice(-OUTPUT_TAIL_BYTES) : text;
}

/**
 * Step 1 of a run: every tool on PATH at a usable version, or a refusal by
 * name. Every problem rather than the first, because each one is a separate
 * trip to the terminal for whoever is fixing the laptop.
 */
export async function preflightProblems(
  transport: BackupTransportName,
  options: { env?: NodeJS.ProcessEnv; cwd?: string } = {},
): Promise<string[]> {
  const problems: string[] = [];
  const probe = { ...options, timeoutMs: VERSION_PROBE_TIMEOUT_MS, stderr: "withhold" } as const;

  for (const tool of PG_TOOLS) {
    try {
      const { stdout } = await runTool(tool, ["--version"], probe);
      assertPgToolVersion(tool, stdout);
    } catch (error) {
      problems.push(describeFailure(error));
    }
  }

  if (transport === "wrangler") {
    try {
      await runTool("wrangler", ["--version"], {
        ...probe,
        env: { ...(options.env ?? process.env), WRANGLER_SEND_METRICS: "false" },
      });
    } catch (error) {
      problems.push(describeFailure(error));
    }
  }
  return problems;
}

/**
 * One line of what went wrong, safe to log and to store.
 *
 * Through `errorSummary` rather than `error.message`, because a database
 * error's message is exactly what must never reach a log (see its header): a
 * failed query's text can carry row values. The first line is the name and
 * message of our own errors and the withheld form of a database one; the rest
 * is stack frames.
 *
 * An empty message happens for real: a refused connection to `localhost` is an
 * AggregateError with no text and its reason in `.code`.
 */
export function describeFailure(error: unknown): string {
  const [summary = ""] = errorSummary(error).split("\n", 1);
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return summary.endsWith(": ") && typeof code === "string" ? `${summary}${code}` : summary;
}

export type Sleep = (ms: number) => Promise<void>;

export const sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The delays before each retry; one first try plus these three. A judgement,
 * not a measurement, sized from the one data point there is: 8 of 78 wrangler
 * gets failed transiently on 2026-08-28 and all 8 succeeded on retry.
 */
export const RETRY_BACKOFF_MS = [1_000, 2_000, 4_000] as const;

/** Repeats `work` while its result says it is worth another try. */
export async function retrying<T>(
  work: () => Promise<T>,
  isTransient: (result: T) => boolean,
  wait: Sleep = sleep,
): Promise<T> {
  let result = await work();
  for (const delayMs of RETRY_BACKOFF_MS) {
    if (!isTransient(result)) {
      break;
    }
    await wait(delayMs);
    result = await work();
  }
  return result;
}

/**
 * Two lanes, because three or four parallel wrangler calls produced transient
 * failures in practice and two did not. Applies to the s3 transport as well:
 * nothing here is in a hurry at 02:00.
 */
export const IMAGE_CONCURRENCY = 2;

/**
 * `work` is expected to record its own failures rather than reject: one image
 * must not stop the others, so a rejection here is a bug and surfaces as one.
 */
export async function forEachConcurrently<T>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const item = items[next] as T;
      next += 1;
      await work(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}
