import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PENDING_PRUNE_FILE } from "../../src/db/backupPrune.js";
import {
  LAST_RUN_FILE,
  LAST_SUCCESS_FILE,
  NO_IMAGES,
  STALE_AFTER_MS,
  assessBackupStatus,
  formatRunSummary,
  readBackupStatus,
  readLastGreenUsers,
  writeLastRun,
  writeLastSuccess,
  type BackupRunRecord,
} from "../../src/db/backupReport.js";

const NOW = new Date("2026-10-31T12:00:00.000Z");
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();

const SUCCESS = {
  state: "ok" as const,
  value: { time: hoursAgo(5), dumpKey: "pg/kept-20261031-070000.dump", sha256: "abc" },
};
const RUN_OK = {
  state: "ok" as const,
  value: { finishedAt: hoursAgo(5), ok: true, failures: [], warnings: [] },
};

describe("assessBackupStatus", () => {
  it("is healthy with a recent success, and says how recent", () => {
    const status = assessBackupStatus({ lastSuccess: SUCCESS, lastRun: RUN_OK, now: NOW });
    expect(status.healthy).toBe(true);
    expect(status.lines.join("\n")).toContain("(5.0 hours ago)");
    expect(status.lines.join("\n")).toContain("pg/kept-20261031-070000.dump");
  });

  it("is healthy at exactly 48 hours and stale just past it", () => {
    const at = (ageMs: number) => ({
      state: "ok" as const,
      value: { ...SUCCESS.value, time: new Date(NOW.getTime() - ageMs).toISOString() },
    });
    expect(
      assessBackupStatus({ lastSuccess: at(STALE_AFTER_MS), lastRun: RUN_OK, now: NOW }).healthy,
    ).toBe(true);
    const stale = assessBackupStatus({
      lastSuccess: at(STALE_AFTER_MS + 1000),
      lastRun: RUN_OK,
      now: NOW,
    });
    expect(stale.healthy).toBe(false);
    expect(stale.lines.join("\n")).toContain("STALE");
  });

  it("is unhealthy when there has never been a success", () => {
    const status = assessBackupStatus({
      lastSuccess: { state: "absent" },
      lastRun: { state: "absent" },
      now: NOW,
    });
    expect(status.healthy).toBe(false);
    expect(status.lines.join("\n")).toContain("Last success: NONE");
  });

  it("treats an unreadable record as no evidence at all", () => {
    const status = assessBackupStatus({
      lastSuccess: { state: "unreadable" },
      lastRun: RUN_OK,
      now: NOW,
    });
    expect(status.healthy).toBe(false);
    expect(status.lines.join("\n")).toContain("UNREADABLE");
  });

  it("lists the last failures, while a recent success keeps it healthy", () => {
    const status = assessBackupStatus({
      lastSuccess: SUCCESS,
      lastRun: {
        state: "ok",
        value: {
          finishedAt: hoursAgo(1),
          ok: false,
          failures: ["MISSING some/key: absent from storage"],
          warnings: [],
        },
      },
      now: NOW,
    });
    expect(status.healthy).toBe(true);
    expect(status.lines.join("\n")).toContain("FAILED with 1 problem(s)");
    expect(status.lines.join("\n")).toContain("MISSING some/key");
  });

  it("shows warnings", () => {
    const status = assessBackupStatus({
      lastSuccess: SUCCESS,
      lastRun: {
        state: "ok",
        value: { finishedAt: hoursAgo(1), ok: true, failures: [], warnings: ["a tombstone"] },
      },
      now: NOW,
    });
    expect(status.lines.join("\n")).toContain("a tombstone");
  });

  it("lists a pending prune with its dates, and it never makes the job unhealthy", () => {
    const status = assessBackupStatus({
      lastSuccess: SUCCESS,
      lastRun: RUN_OK,
      pendingPrunes: {
        state: "ok",
        value: [
          {
            userId: "6f3a1c1e-0d4b-4b7e-9a57-2f4b0e3f9a10",
            firstSeenAt: "2026-10-30T06:00:00.000Z",
            pruneAfter: "2026-11-29T06:00:00.000Z",
          },
        ],
      },
      now: NOW,
    });
    expect(status.healthy).toBe(true);
    const text = status.lines.join("\n");
    expect(text).toContain("Pending prunes: 1 deleted account(s)");
    expect(text).toContain("6f3a1c1e-0d4b-4b7e-9a57-2f4b0e3f9a10");
    expect(text).toContain("first seen gone 2026-10-30T06:00:00.000Z");
    expect(text).toContain("pruned after 2026-11-29T06:00:00.000Z");
  });

  it("says nothing about prunes when none are pending", () => {
    const status = assessBackupStatus({
      lastSuccess: SUCCESS,
      lastRun: RUN_OK,
      pendingPrunes: { state: "ok", value: [] },
      now: NOW,
    });
    expect(status.lines.join("\n")).not.toContain("Pending prunes");
  });

  it("states a long age in days", () => {
    const status = assessBackupStatus({
      lastSuccess: { state: "ok", value: { ...SUCCESS.value, time: hoursAgo(120) } },
      lastRun: RUN_OK,
      now: NOW,
    });
    expect(status.lines.join("\n")).toContain("(5.0 days ago)");
  });
});

describe("the records on disk", () => {
  let localDir: string;

  beforeEach(() => {
    localDir = mkdtempSync(join(tmpdir(), "kept-report-"));
  });

  afterEach(() => {
    rmSync(localDir, { recursive: true, force: true });
  });

  const green: BackupRunRecord = {
    startedAt: hoursAgo(6),
    finishedAt: hoursAgo(5),
    ok: true,
    dump: { key: "pg/kept-20261031-070000.dump", sha256: "abc", bytes: 12 },
    tableCounts: { receipts: 3 },
    imageCounts: { ...NO_IMAGES, rows: 3 },
    pendingPrunes: [],
    failures: [],
    warnings: [],
  };

  it("reads back what a run writes", async () => {
    await writeLastSuccess(localDir, { ...green, dump: green.dump! });
    await writeLastRun(localDir, green);
    const status = await readBackupStatus(localDir, NOW);
    expect(status.healthy).toBe(true);
    expect(status.lines[0]).toContain(hoursAgo(5));
  });

  it("is unhealthy in an empty directory, with no credentials anywhere near it", async () => {
    const status = await readBackupStatus(localDir, NOW);
    expect(status.healthy).toBe(false);
  });

  it("keeps the users of a green run where the prune can read them", async () => {
    await writeLastSuccess(localDir, { ...green, dump: green.dump! }, ["a", "b"]);
    expect(await readLastGreenUsers(localDir)).toEqual(["a", "b"]);
  });

  it("has no baseline from a record older than the list, or no record at all", async () => {
    expect(await readLastGreenUsers(localDir)).toBeUndefined();
    await writeLastSuccess(localDir, { ...green, dump: green.dump! });
    expect(await readLastGreenUsers(localDir)).toBeUndefined();
    writeFileSync(join(localDir, LAST_SUCCESS_FILE), '{"time":"x"}');
    expect(await readLastGreenUsers(localDir)).toBeUndefined();
  });

  it("reads the pending file, so a hand edit shows before the next run does", async () => {
    await writeLastSuccess(localDir, { ...green, dump: green.dump! });
    await writeLastRun(localDir, green);
    writeFileSync(
      join(localDir, PENDING_PRUNE_FILE),
      "6f3a1c1e-0d4b-4b7e-9a57-2f4b0e3f9a10\t2026-10-30T06:00:00.000Z\n",
    );
    const status = await readBackupStatus(localDir, NOW);
    expect(status.healthy).toBe(true);
    expect(status.lines.join("\n")).toContain("pruned after 2026-11-29T06:00:00.000Z");
  });

  it("says so when the pending file cannot be read, and stays healthy", async () => {
    await writeLastSuccess(localDir, { ...green, dump: green.dump! });
    writeFileSync(join(localDir, PENDING_PRUNE_FILE), "not an entry\n");
    const status = await readBackupStatus(localDir, NOW);
    expect(status.healthy).toBe(true);
    expect(status.lines.join("\n")).toContain("Pending prunes: UNREADABLE");
  });

  /**
   * The run in progress when this feature landed writes exactly this record,
   * and every last-run.json written since August has no such field.
   */
  it("still reads a last-run.json from before pending prunes existed", async () => {
    const { pendingPrunes: _pendingPrunes, ...older } = green;
    writeFileSync(join(localDir, LAST_RUN_FILE), JSON.stringify(older));
    await writeLastSuccess(localDir, { ...green, dump: green.dump! });
    const status = await readBackupStatus(localDir, NOW);
    expect(status.healthy).toBe(true);
    expect(status.lines.join("\n")).not.toContain("UNREADABLE");
  });

  it("is unhealthy on a truncated record", async () => {
    writeFileSync(join(localDir, LAST_SUCCESS_FILE), '{"time":');
    expect((await readBackupStatus(localDir, NOW)).healthy).toBe(false);
  });

  it("is unhealthy on a record with no usable time", async () => {
    writeFileSync(join(localDir, LAST_SUCCESS_FILE), '{"time":"last tuesday"}');
    writeFileSync(join(localDir, LAST_RUN_FILE), "[]");
    const status = await readBackupStatus(localDir, NOW);
    expect(status.healthy).toBe(false);
    expect(status.lines.join("\n")).toContain("UNREADABLE");
  });
});

describe("formatRunSummary", () => {
  const record: BackupRunRecord = {
    startedAt: hoursAgo(1),
    finishedAt: hoursAgo(0),
    ok: false,
    dump: { key: "pg/kept-20261031-110000.dump", sha256: "abc", bytes: 12 },
    tableCounts: { receipts: 3, receipt_images: 4 },
    imageCounts: { ...NO_IMAGES, rows: 4, live: 3, tombstoned: 1, fetched: 3, notMirrored: 1 },
    pendingPrunes: [],
    failures: ["MISSING some/key: absent from storage", "UNREACHABLE other/key"],
    warnings: ["a warning"],
  };

  it("lists every problem and says the dump is kept", () => {
    const summary = formatRunSummary(record);
    expect(summary).toContain("BACKUP FAILED - 2 problem(s):");
    expect(summary).toContain("  - MISSING some/key");
    expect(summary).toContain("  - UNREACHABLE other/key");
    expect(summary).toContain("The local dump is kept.");
    expect(summary).toContain("a warning");
  });

  it("states what it did", () => {
    const summary = formatRunSummary({ ...record, ok: true, failures: [], warnings: [] });
    expect(summary).toContain("Backup complete");
    expect(summary).toContain("pg/kept-20261031-110000.dump");
    expect(summary).toContain("receipts 3, receipt_images 4");
    expect(summary).toContain("4 rows (3 live, 1 tombstoned)");
    expect(summary).not.toContain("warning");
  });

  it("lists pending prunes with their dates", () => {
    const summary = formatRunSummary({
      ...record,
      pendingPrunes: [
        {
          userId: "6f3a1c1e-0d4b-4b7e-9a57-2f4b0e3f9a10",
          firstSeenAt: "2026-10-30T06:00:00.000Z",
          pruneAfter: "2026-11-29T06:00:00.000Z",
        },
      ],
    });
    expect(summary).toContain("1 deleted account(s) pending prune:");
    expect(summary).toContain("pruned after 2026-11-29T06:00:00.000Z");
  });

  it("survives a run that never reached a dump", () => {
    const { dump: _dump, ...noDump } = record;
    expect(formatRunSummary({ ...noDump, tableCounts: {} })).toContain("BACKUP FAILED");
  });
});
