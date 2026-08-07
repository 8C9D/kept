import { execFileSync } from "node:child_process";

/**
 * Naming what is already holding the port, when the server cannot have it.
 *
 * ⚠ This exists because of a measured, repeated failure rather than a
 * hypothetical one. Four times across waves 3-6, a `npm run dev` from an
 * earlier session was still holding port 3000 when a later session went to
 * verify something. `EADDRINUSE` and a stack trace is technically a report,
 * but it is the wrong one: it says the port is taken, when the fact that
 * matters is *which build is answering on it*. A stale server serves the
 * code it was started with, so every measurement taken against it is a
 * measurement of an older checkout that looks exactly like a passing one.
 * The August 2026 audit called it "a pattern rather than an incident".
 *
 * So the message names the process, when it started, and what it is - and
 * says plainly what a stale listener means for anything measured against it.
 */

export interface PortListener {
  pid: number;
  /** The short name lsof reports, e.g. "node". */
  command: string;
  /** From `ps`; null when the process vanished between the two calls. */
  startedAt: string | null;
  /** The full argv from `ps`, which is what identifies a stale Kept server. */
  fullCommand: string | null;
}

/**
 * Parse `lsof -nP -iTCP:<port> -sTCP:LISTEN` output. Header line skipped;
 * malformed lines ignored rather than guessed at, since this runs on a
 * failure path and must not fail itself.
 */
export function parseLsofListeners(
  output: string,
): Array<{ pid: number; command: string }> {
  return output
    .split("\n")
    .slice(1)
    .flatMap((line) => {
      const [command, pid] = line.trim().split(/\s+/);
      if (command === undefined || pid === undefined) {
        return [];
      }
      const parsed = Number(pid);
      return Number.isInteger(parsed) ? [{ pid: parsed, command }] : [];
    });
}

/** True when the process on the port is another copy of this server. */
function isKeptDevServer(listener: PortListener): boolean {
  return listener.fullCommand?.includes("src/index.ts") ?? false;
}

export function formatPortInUseMessage(
  port: number,
  listeners: PortListener[],
): string {
  const lines = [`Port ${port} is already in use, so the Kept API did not start.`, ""];

  if (listeners.length === 0) {
    // lsof is absent, or the holder belongs to another user. Still worth
    // saying what to do; just not who to blame.
    lines.push(
      `  Could not identify the process holding the port.`,
      `  Try:  lsof -nP -iTCP:${port} -sTCP:LISTEN`,
      "",
      `  Or start beside it:  PORT=${port + 1} npm run dev`,
    );
    return lines.join("\n");
  }

  for (const listener of listeners) {
    lines.push(
      `  pid ${listener.pid}  ${listener.command}` +
        (listener.startedAt === null ? "" : `  started ${listener.startedAt}`),
    );
    if (listener.fullCommand !== null) {
      lines.push(`    ${listener.fullCommand}`);
    }
  }
  lines.push("");

  if (listeners.some(isKeptDevServer)) {
    lines.push(
      `  ⚠ That is another Kept server - almost certainly an earlier`,
      `    "npm run dev" that outlived the terminal that started it.`,
      `    It is serving the code it was started with, so anything you`,
      `    measure against port ${port} right now is measuring that older`,
      `    process and not your checkout.`,
      "",
    );
  }

  const pids = listeners.map((listener) => listener.pid).join(" ");
  lines.push(
    `  kill ${pids}    # then run npm run dev again`,
    `  PORT=${port + 1} npm run dev    # or start beside it`,
  );
  return lines.join("\n");
}

/**
 * Best-effort identification. Every call is wrapped: this runs while the
 * process is already failing, and a diagnostic that throws would replace a
 * clear message with a confusing one.
 */
export function findPortListeners(port: number): PortListener[] {
  const output = runQuietly("lsof", [
    "-nP",
    `-iTCP:${port}`,
    "-sTCP:LISTEN",
  ]);
  if (output === null) {
    return [];
  }
  const seen = new Set<number>();
  return parseLsofListeners(output)
    .filter((listener) => {
      // lsof prints one row per file descriptor; the same server can hold
      // several on one port.
      if (seen.has(listener.pid)) {
        return false;
      }
      seen.add(listener.pid);
      return true;
    })
    .map((listener) => ({
      ...listener,
      startedAt: psField(listener.pid, "lstart="),
      fullCommand: psField(listener.pid, "command="),
    }));
}

function psField(pid: number, format: string): string | null {
  return runQuietly("ps", ["-o", format, "-p", String(pid)])?.trim() || null;
}

function runQuietly(command: string, args: string[]): string | null {
  try {
    return execFileSync(command, args, {
      encoding: "utf8",
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // lsof exits non-zero when nothing matches, and may not exist at all.
    // Both mean "no answer", which the caller renders as the generic form.
    return null;
  }
}
