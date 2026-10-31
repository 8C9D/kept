import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NOTICE_FILE, NOTICE_TEXT } from "../../src/db/backupPrune.js";
import { SERVER_DIR } from "../helpers/backupWorld.js";

/**
 * `server/ops/kept-backup.sh`, for what it does with the job's notice. The real
 * script text with two substitutions and nothing else: `osascript` becomes a
 * recorder, because a test must not post "a deleted account" to the owner's screen,
 * and `npm run db:backup` becomes a stand-in that exits as told.
 *
 * macOS only, as the script is: Linux CI has no zsh or osascript to speak of. This
 * is the one backup test that skips rather than fails, because here a skip is not
 * hiding anything. It is the machine the script cannot run on.
 */

describe.runIf(process.platform === "darwin")("kept-backup.sh and the notice", () => {
  let root: string;
  let localDir: string;
  let calls: string;
  let script: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "kept-script-"));
    localDir = join(root, "backups");
    calls = join(root, "osascript-calls");
    mkdirSync(localDir);
    mkdirSync(join(root, "home", ".kept"), { recursive: true });
    mkdirSync(join(root, "server", "ops"), { recursive: true });
    writeFileSync(calls, "");

    const osascript = join(root, "osascript");
    writeFileSync(
      osascript,
      `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg" >> "${calls}"; done\nprintf 'END\\n' >> "${calls}"\nexit "\${OSASCRIPT_EXIT:-0}"\n`,
    );
    chmodSync(osascript, 0o755);

    const job = join(root, "job");
    writeFileSync(
      job,
      `#!/bin/sh\nif [ -n "$JOB_NOTICE" ]; then printf '%s\\n' "$JOB_NOTICE" > "$BACKUP_LOCAL_DIR/notice"; fi\nif [ -n "$JOB_SLEEP" ]; then touch "${root}/job-started"; exec sleep "$JOB_SLEEP"; fi\nexit "\${JOB_EXIT:-0}"\n`,
    );
    chmodSync(job, 0o755);

    const source = readFileSync(join(SERVER_DIR, "ops", "kept-backup.sh"), "utf8");
    expect(source).toContain("/usr/bin/osascript");
    expect(source).toMatch(/^npm run db:backup$/m);
    script = join(root, "server", "ops", "kept-backup.sh");
    writeFileSync(
      script,
      source.replaceAll("/usr/bin/osascript", osascript).replace(/^npm run db:backup$/m, job),
    );
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const writeEnv = () =>
    writeFileSync(
      join(root, "home", ".kept", "backup.env"),
      `BACKUP_LOCAL_DIR="${localDir}"\nexport BACKUP_LOCAL_DIR\n`,
    );

  function runScript(env: Record<string, string> = {}, signalWhenStarted?: NodeJS.Signals) {
    return new Promise<{ code: number | null; elapsedMs: number }>((resolve, reject) => {
      const startedAt = Date.now();
      const child = spawn("/bin/zsh", [script], {
        env: { HOME: join(root, "home"), PATH: process.env.PATH, ...env },
        stdio: "ignore",
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, elapsedMs: Date.now() - startedAt }));
      if (signalWhenStarted !== undefined) {
        const wait = setInterval(() => {
          if (existsSync(join(root, "job-started"))) {
            clearInterval(wait);
            child.kill(signalWhenStarted);
          }
        }, 20);
      }
    });
  }

  const noticePath = () => join(localDir, NOTICE_FILE);
  const recorded = () => readFileSync(calls, "utf8");

  it("posts the notice on a green run and removes it", async () => {
    writeEnv();
    const { code } = await runScript({ JOB_NOTICE: NOTICE_TEXT });

    expect(code).toBe(0);
    expect(recorded()).toContain(NOTICE_TEXT);
    expect(existsSync(noticePath())).toBe(false);
  });

  it("posts it on a failing run too, and the job's exit code stands", async () => {
    writeEnv();
    const { code } = await runScript({ JOB_NOTICE: NOTICE_TEXT, JOB_EXIT: "1" });

    expect(code).toBe(1);
    expect(recorded()).toContain("Kept backup failed");
    expect(recorded()).toContain(NOTICE_TEXT);
    expect(existsSync(noticePath())).toBe(false);
  });

  it("posts nothing when there is no notice", async () => {
    writeEnv();
    const { code } = await runScript();

    expect(code).toBe(0);
    expect(recorded()).toBe("");
  });

  it("posts one left by a hand run, which never passes through this script", async () => {
    writeEnv();
    writeFileSync(noticePath(), `${NOTICE_TEXT}\n`);
    await runScript();

    expect(recorded()).toContain(NOTICE_TEXT);
    expect(existsSync(noticePath())).toBe(false);
  });

  it("keeps a notice it could not post, for the next run, and the exit code stands", async () => {
    writeEnv();
    const { code } = await runScript({ JOB_NOTICE: NOTICE_TEXT, OSASCRIPT_EXIT: "1" });

    expect(code).toBe(0);
    expect(existsSync(noticePath())).toBe(true);
  });

  it("hands the text over as an argument, never as AppleScript source", async () => {
    writeEnv();
    const hostile = 'x" & (do shell script "touch owned") & "y';
    await runScript({ JOB_NOTICE: hostile });

    const lines = recorded().split("\n");
    expect(lines).toContain(hostile);
    expect(lines[lines.indexOf(hostile) - 1]).toBe("--");
    expect(lines.filter((line) => line.includes("display notification"))).toEqual([
      'display notification (item 1 of argv) with title "Kept backup"',
    ]);
  });

  it("posts it when launchd stops the job, ending at once with 143 as it always did", async () => {
    writeEnv();
    const { code, elapsedMs } = await runScript({ JOB_NOTICE: NOTICE_TEXT, JOB_SLEEP: "30" }, "SIGTERM");

    expect(code).toBe(143);
    expect(elapsedMs).toBeLessThan(15_000);
    expect(recorded()).toContain(NOTICE_TEXT);
    expect(existsSync(noticePath())).toBe(false);
  });

  it("survives every exit before BACKUP_LOCAL_DIR is known", async () => {
    const { code } = await runScript();

    expect(code).toBe(78);
    expect(recorded()).toContain("Kept backup failed");
    expect(recorded()).not.toContain("item 1 of argv");
  });
});
