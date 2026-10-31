import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupStamp, parseBackupStamp } from "../../src/db/backupConfig.js";
import { ledgerFile } from "../../src/db/backupOffsite.js";
import {
  DELETED_ACCOUNT_PRUNE_DAYS,
  NOTICE_FILE,
  NOTICE_TEXT,
  PENDING_PRUNE_FILE,
  applyAccountPlan,
  assessDeletedAccounts,
  formatPendingPrunes,
  parsePendingPrunes,
  pendingPruneViews,
  reconcileAccounts,
  type AccountPlan,
  type PendingPrune,
} from "../../src/db/backupPrune.js";
import { BackupLog } from "../../src/db/backupReport.js";
import { memoryBackupTransport, type MemoryBackupTransport } from "../helpers/memoryBackupTransport.js";

/**
 * The prune against a real directory and the memory transport. What matters most
 * here is what survives, so the tests below assert the survivors by name: the
 * other user's images, and every dump from the boundary on.
 */

const GONE = "6f3a1c1e-0d4b-4b7e-9a57-2f4b0e3f9a10";
const KEPT = "11111111-2222-4333-8444-555555555555";
const SHA = "a".repeat(64);
const BUCKET = "kept-backups";
const DESTINATION = BUCKET;
const DAY_MS = 24 * 60 * 60 * 1000;

const FIRST_SEEN = new Date("2026-10-01T06:00:00.000Z");
const daysAfterFirstSeen = (days: number) => new Date(FIRST_SEEN.getTime() + days * DAY_MS);
const entry: PendingPrune = { userId: GONE, firstSeenAt: FIRST_SEEN.toISOString() };

const dumpKey = (at: Date) => `pg/kept-${backupStamp(at)}.dump`;
const manifestKey = (at: Date) => `manifests/kept-${backupStamp(at)}.tsv`;
const imageKey = (userId: string) => `${userId}/2026/10/${randomUUID()}.jpg`;

describe("parseBackupStamp", () => {
  it("reads the job's stamp back as the instant it was written from", () => {
    const at = new Date("2026-10-31T13:44:48.000Z");
    expect(parseBackupStamp(`kept-${backupStamp(at)}.dump`)).toEqual(at);
  });

  it("is UTC whatever this machine's zone is", () => {
    // 23:30 on the 31st in a stamp is the 31st in UTC, and is 19:30 EDT. A local
    // reading on a laptop in EDT would put this dump four hours later.
    expect(parseBackupStamp("kept-20261031-233000.dump")?.toISOString()).toBe(
      "2026-10-31T23:30:00.000Z",
    );
  });

  it("reads a hand-run name, a manifest, and a killed run's leftovers", () => {
    const expected = "2026-10-02T23:10:52.000Z";
    for (const name of [
      "kept-20261002-manual-231052.dump",
      "kept-20261002-231052.tsv",
      "kept-20261002-231052.dump.partial",
      "kept-20261002-231052.tsv.0123456789ab.partial",
    ]) {
      expect(parseBackupStamp(name)?.toISOString(), name).toBe(expected);
    }
  });

  it("refuses what is not a stamp, a calendar date that does not exist included", () => {
    for (const name of [
      "kept-prod-20261002.dump",
      "kept-20261345-010101.dump",
      "kept-20260230-010101.dump",
      "kept-20261001-256161.dump",
      "backup.dump",
      ".DS_Store",
    ]) {
      expect(parseBackupStamp(name), name).toBeUndefined();
    }
  });
});

describe("the pending file", () => {
  it("round-trips", () => {
    const text = formatPendingPrunes([entry]);
    expect(text).toBe(`${GONE}\t${FIRST_SEEN.toISOString()}\n`);
    expect(parsePendingPrunes(text)).toEqual({ entries: [entry], problems: [] });
  });

  it("names a line it cannot read and never quotes it", () => {
    for (const line of [
      "garbage",
      `${GONE}\tnot-a-date`,
      `${GONE}\t${FIRST_SEEN.toISOString()}\textra`,
      `../../etc\t${FIRST_SEEN.toISOString()}`,
      GONE,
    ]) {
      const { entries, problems } = parsePendingPrunes(`${line}\n`);
      expect(entries, line).toEqual([]);
      expect(problems, line).toEqual([`${PENDING_PRUNE_FILE} line 1 is not a readable entry`]);
    }
  });

  it("refuses a user listed twice rather than choosing a date", () => {
    const line = `${GONE}\t${FIRST_SEEN.toISOString()}\n`;
    expect(parsePendingPrunes(`${line}${line}`).problems).toHaveLength(1);
  });

  it("works out the date from the ruling", () => {
    const [view] = pendingPruneViews([entry]);
    expect(view?.pruneAfter).toBe(daysAfterFirstSeen(DELETED_ACCOUNT_PRUNE_DAYS).toISOString());
  });
});

describe("reconcileAccounts", () => {
  const reconcile = (input: {
    pending?: PendingPrune[];
    held?: string[];
    lastGreenUsers?: string[];
    restored: string[];
    now?: Date;
  }) =>
    reconcileAccounts({
      pending: input.pending ?? [],
      held: new Set(input.held ?? []),
      lastGreenUsers: input.lastGreenUsers,
      restoredUsers: new Set(input.restored),
      seenAt: FIRST_SEEN.toISOString(),
      now: input.now ?? FIRST_SEEN,
    });

  it("schedules a user who vanished, at the stamp of the dump that proved it", () => {
    expect(reconcile({ held: [GONE, KEPT], restored: [KEPT] })).toEqual({
      added: [entry],
      cancelled: [],
      waiting: [],
      due: [],
    });
  });

  it("does nothing for a backup that holds nobody yet", () => {
    expect(reconcile({ restored: [KEPT] })).toEqual({
      added: [],
      cancelled: [],
      waiting: [],
      due: [],
    });
  });

  it("does not move the date of a user already pending", () => {
    const plan = reconcile({
      pending: [{ userId: GONE, firstSeenAt: "2026-09-20T06:00:00.000Z" }],
      held: [GONE, KEPT],
      restored: [KEPT],
    }) as AccountPlan;
    expect(plan.added).toEqual([]);
    expect(plan.waiting[0]?.firstSeenAt).toBe("2026-09-20T06:00:00.000Z");
  });

  it("is not due at exactly the window, and is due just past it", () => {
    const at = (ms: number) =>
      reconcile({
        pending: [entry],
        held: [GONE, KEPT],
        restored: [KEPT],
        now: new Date(FIRST_SEEN.getTime() + ms),
      }) as AccountPlan;
    const window = DELETED_ACCOUNT_PRUNE_DAYS * DAY_MS;
    expect(at(window).due).toEqual([]);
    expect(at(window).waiting).toEqual([entry]);
    expect(at(window + 1).due).toEqual([entry]);
  });

  it("cancels a user who is back, however overdue the entry is", () => {
    const plan = reconcile({
      pending: [entry],
      held: [GONE, KEPT],
      restored: [GONE, KEPT],
      now: daysAfterFirstSeen(90),
    }) as AccountPlan;
    expect(plan.cancelled).toEqual([entry]);
    expect(plan.due).toEqual([]);
  });

  it("refuses an empty users table", () => {
    const outcome = reconcile({ pending: [entry], held: [GONE, KEPT], restored: [] });
    expect(outcome).toMatchObject({ refused: expect.stringContaining("users table is empty") });
  });

  it("refuses when every known user vanished at once, whoever else is in the table", () => {
    const outcome = reconcile({ held: [GONE, KEPT], restored: [randomUUID()] });
    expect(outcome).toMatchObject({ refused: expect.stringContaining("all 2 known user(s)") });
  });

  /**
   * The bug this test pins was real. The image leg runs first, so a database
   * wiped and signed into again has its one new user on disk before this looks:
   * held by the disk's account, one known user survived. Measured against the last
   * green run, none did, and the answer does not change on the nights that follow.
   */
  it("is not fooled by a replacement user the image leg has already mirrored", () => {
    const newcomer = randomUUID();
    const outcome = reconcile({
      held: [GONE, KEPT, newcomer],
      lastGreenUsers: [GONE, KEPT],
      restored: [newcomer],
    });
    expect(outcome).toMatchObject({ refused: expect.stringContaining("all 2 known user(s)") });
  });

  it("says how a refusal ends, because it repeats every night until it does", () => {
    const outcome = reconcile({ lastGreenUsers: [GONE], restored: [KEPT] });
    expect(outcome).toMatchObject({ refused: expect.stringContaining("last-success.json") });
  });

  it("schedules one deletion among the last green run's users", () => {
    const plan = reconcile({
      held: [GONE, KEPT],
      lastGreenUsers: [GONE, KEPT],
      restored: [KEPT],
    }) as AccountPlan;
    expect(plan.added).toEqual([entry]);
  });

  it("counts a user with no images, who the disk knows nothing about", () => {
    const noImages = randomUUID();
    const plan = reconcile({
      held: [GONE],
      lastGreenUsers: [GONE, noImages],
      restored: [noImages],
    }) as AccountPlan;
    expect(plan.added).toEqual([entry]);
  });

  it("counts entries already pending as known, so a due prune cannot slip past", () => {
    const outcome = reconcile({
      pending: [entry],
      held: [KEPT],
      restored: [randomUUID()],
      now: daysAfterFirstSeen(31),
    });
    expect(outcome).toMatchObject({ refused: expect.stringContaining("all 2 known user(s)") });
  });
});

describe("a prune, on disk", () => {
  let localDir: string;
  let transport: MemoryBackupTransport;
  let log: BackupLog;
  const gone = [imageKey(GONE), imageKey(GONE)];
  const kept = [imageKey(KEPT)];

  const before = new Date("2026-09-20T06:00:00.000Z");
  const boundary = FIRST_SEEN;
  const after = daysAfterFirstSeen(20);
  const newest = daysAfterFirstSeen(31);

  const noWait = () => Promise.resolve();
  const context = () => ({
    localDir,
    bucket: BUCKET,
    destination: DESTINATION,
    transport,
    log,
    wait: noWait,
  });
  const offsite = (key: string) => `${BUCKET}/${key}`;
  const ledgerPath = () => join(localDir, ledgerFile(DESTINATION));

  function place(key: string, inBucket = key): void {
    const path = join(localDir, key);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "bytes");
    transport.objects.set(offsite(inBucket), new Uint8Array([1]));
  }

  function placeImage(key: string): void {
    place(join("images", key), `images/mirror/${key}`);
  }

  beforeEach(() => {
    localDir = mkdtempSync(join(tmpdir(), "kept-prune-"));
    transport = memoryBackupTransport();
    log = new BackupLog();
    for (const directory of ["pg", "manifests", "images"]) {
      mkdirSync(join(localDir, directory));
    }
    for (const at of [before, boundary, after, newest]) {
      place(dumpKey(at));
      place(manifestKey(at));
    }
    [...gone, ...kept].forEach(placeImage);
    writeFileSync(ledgerPath(), [...gone, ...kept].map((key) => `${key}\t${SHA}\n`).join(""));
    writeFileSync(join(localDir, PENDING_PRUNE_FILE), formatPendingPrunes([entry]));
  });

  afterEach(() => {
    rmSync(localDir, { recursive: true, force: true });
  });

  const assess = async (now: Date, restored = [KEPT], pending = [entry]) => {
    const outcome = await assessDeletedAccounts({
      localDir,
      destination: DESTINATION,
      pending,
      restoredUsers: restored,
      dumpKey: dumpKey(newest),
      now,
    });
    if ("refused" in outcome) {
      throw new Error(outcome.refused);
    }
    return outcome;
  };

  const pruneAt = async (now: Date) => applyAccountPlan(await assess(now), context(), now);

  /** The dump every `assess` here names: `newest`, read off its stamp. */
  const dumpSeen = () => parseBackupStamp(`kept-${backupStamp(newest)}.dump`)!.toISOString();
  const pendingFile = () => readFileSync(join(localDir, PENDING_PRUNE_FILE), "utf8");
  const local = (key: string) => existsSync(join(localDir, key));

  function expectNothingRemoved(): void {
    for (const at of [before, boundary, after, newest]) {
      for (const key of [dumpKey(at), manifestKey(at)]) {
        expect(local(key), key).toBe(true);
        expect(transport.objects.has(offsite(key)), key).toBe(true);
      }
    }
    for (const key of [...gone, ...kept]) {
      expect(local(join("images", key)), key).toBe(true);
      expect(transport.objects.has(offsite(`images/mirror/${key}`)), key).toBe(true);
    }
  }

  function expectSurvivors(): void {
    for (const at of [boundary, after, newest]) {
      for (const key of [dumpKey(at), manifestKey(at)]) {
        expect(local(key), key).toBe(true);
        expect(transport.objects.has(offsite(key)), key).toBe(true);
      }
    }
    for (const key of kept) {
      expect(local(join("images", key)), key).toBe(true);
      expect(transport.objects.has(offsite(`images/mirror/${key}`)), key).toBe(true);
    }
  }

  function expectPruned(): void {
    for (const key of [dumpKey(before), manifestKey(before)]) {
      expect(local(key), key).toBe(false);
      expect(transport.objects.has(offsite(key)), key).toBe(false);
    }
    for (const key of gone) {
      expect(transport.objects.has(offsite(`images/mirror/${key}`)), key).toBe(false);
    }
    expect(local(join("images", GONE))).toBe(false);
    expect(readFileSync(ledgerPath(), "utf8")).toBe(kept.map((key) => `${key}\t${SHA}\n`).join(""));
  }

  it("schedules, raises a notice, and removes nothing", async () => {
    rmSync(join(localDir, PENDING_PRUNE_FILE));
    const remaining = await applyAccountPlan(await assess(boundary, [KEPT], []), context(), boundary);

    expect(remaining).toEqual([{ userId: GONE, firstSeenAt: dumpSeen() }]);
    expect(pendingFile()).toBe(`${GONE}\t${dumpSeen()}\n`);
    expect(readFileSync(join(localDir, NOTICE_FILE), "utf8")).toBe(`${NOTICE_TEXT}\n`);
    expect(NOTICE_TEXT).not.toContain(GONE);
    expectNothingRemoved();
    expect(transport.calls.filter(({ verb }) => verb === "delete")).toEqual([]);
  });

  it("raises no second notice for a user already pending", async () => {
    await pruneAt(daysAfterFirstSeen(5));
    expect(existsSync(join(localDir, NOTICE_FILE))).toBe(false);
    expect(pendingFile()).toBe(formatPendingPrunes([entry]));
  });

  it("does nothing at 29 days", async () => {
    await pruneAt(daysAfterFirstSeen(29));
    expectNothingRemoved();
    expect(pendingFile()).toBe(formatPendingPrunes([entry]));
    expect(log.failures).toEqual([]);
  });

  it("prunes at 31 days: images, older dumps, the ledger, the mirror, the entry", async () => {
    const remaining = await pruneAt(daysAfterFirstSeen(31));

    expect(remaining).toEqual([]);
    expect(pendingFile()).toBe("");
    expect(log.failures).toEqual([]);
    expectPruned();
    expectSurvivors();
    expect(log.warnings.join()).toContain(`Pruned deleted account ${GONE}`);
  });

  it("keeps the dump taken at firstSeenAt: the boundary is the first one without them", async () => {
    await pruneAt(daysAfterFirstSeen(31));
    expect(local(dumpKey(boundary))).toBe(true);
    expect(local(manifestKey(boundary))).toBe(true);
  });

  it("deletes off-site before local, for every object", async () => {
    const seen: Array<{ key: string; localStillThere: boolean }> = [];
    const realDelete = transport.delete.bind(transport);
    transport.delete = async (bucket, key) => {
      seen.push({
        key,
        localStillThere: key.startsWith("images/") ? local(key.replace("mirror/", "")) : local(key),
      });
      await realDelete(bucket, key);
    };
    await pruneAt(daysAfterFirstSeen(31));
    expect(seen.length).toBe(gone.length + 2);
    expect(seen.every(({ localStillThere }) => localStillThere)).toBe(true);
    // Images first, then the dumps and manifests, as the ruling orders it.
    expect(seen.slice(0, gone.length).every(({ key }) => key.startsWith("images/mirror/"))).toBe(true);
  });

  it("never deletes the newest dump, even if every date says it should go", async () => {
    // A clock or an edited file has put firstSeenAt after everything on disk.
    const future = { userId: GONE, firstSeenAt: daysAfterFirstSeen(40).toISOString() };
    await applyAccountPlan(
      { added: [], cancelled: [], waiting: [], due: [future] },
      context(),
      daysAfterFirstSeen(100),
    );
    expect(local(dumpKey(newest))).toBe(true);
    expect(transport.objects.has(offsite(dumpKey(newest)))).toBe(true);
    expect(local(manifestKey(newest))).toBe(true);
    expect(local(dumpKey(after))).toBe(false);
  });

  it("keeps a hand-run dump newer than firstSeenAt and removes an older one", async () => {
    place("pg/kept-20261020-manual-120000.dump");
    place("pg/kept-20260921-manual-120000.dump");
    await pruneAt(daysAfterFirstSeen(31));
    expect(local("pg/kept-20261020-manual-120000.dump")).toBe(true);
    expect(local("pg/kept-20260921-manual-120000.dump")).toBe(false);
    expect(transport.objects.has(offsite("pg/kept-20260921-manual-120000.dump"))).toBe(false);
  });

  it("removes a killed run's partial file, and asks nothing of off-site for it", async () => {
    const partial = `${dumpKey(before)}.partial`;
    writeFileSync(join(localDir, partial), "half a dump");
    await pruneAt(daysAfterFirstSeen(31));
    expect(local(partial)).toBe(false);
    expect(transport.calls.some(({ key }) => key === partial)).toBe(false);
  });

  it("refuses a dump with no readable stamp, before deleting anything", async () => {
    writeFileSync(join(localDir, "pg/kept-prod-20261002.dump"), "unknown");

    await pruneAt(daysAfterFirstSeen(31));

    expect(log.failures).toHaveLength(1);
    expect(log.failures[0]).toContain("pg/kept-prod-20261002.dump has no stamp");
    expectNothingRemoved();
    expect(pendingFile()).toBe(formatPendingPrunes([entry]));
  });

  it("ignores a dotfile Finder left", async () => {
    writeFileSync(join(localDir, "pg/.DS_Store"), "");
    await pruneAt(daysAfterFirstSeen(31));
    expect(log.failures).toEqual([]);
    expectPruned();
  });

  it("still finds the images when the ledger, a cache, was lost", async () => {
    rmSync(ledgerPath());
    await pruneAt(daysAfterFirstSeen(31));
    for (const key of gone) {
      expect(transport.objects.has(offsite(`images/mirror/${key}`)), key).toBe(false);
    }
    for (const key of kept) {
      expect(transport.objects.has(offsite(`images/mirror/${key}`)), key).toBe(true);
    }
  });

  it("still finds the images when the mirror directory is already gone", async () => {
    rmSync(join(localDir, "images", GONE), { recursive: true });
    await pruneAt(daysAfterFirstSeen(31));
    expect(log.failures).toEqual([]);
    for (const key of gone) {
      expect(transport.objects.has(offsite(`images/mirror/${key}`)), key).toBe(false);
    }
  });

  it("refuses a ledger key under the user that this system never issued", async () => {
    const lines = readFileSync(ledgerPath(), "utf8");
    writeFileSync(ledgerPath(), `${lines}${GONE}/../${KEPT}/2026/10/x.jpg\t${SHA}\n`);
    await pruneAt(daysAfterFirstSeen(31));
    expect(log.failures.join()).toContain("did not issue");
    expectNothingRemoved();
    expect(pendingFile()).toBe(formatPendingPrunes([entry]));
  });

  it("does not believe a delete that changed nothing: the entry and local copies stay", async () => {
    const image = `images/mirror/${gone[0]!}`;
    transport.ignoreDeletes(image);
    await pruneAt(daysAfterFirstSeen(31));
    expect(log.failures.join()).toContain("still there after the delete");
    expect(pendingFile()).toBe(formatPendingPrunes([entry]));
    expect(local(join("images", gone[0]!))).toBe(true);
  });

  it("stops midway keeping every local copy, and a later run finishes", async () => {
    // Four tries, all of which fail: the images are gone off-site by now, and
    // this dump is the object the run cannot get past.
    const key = dumpKey(before);
    const down = () => new Error("R2 is having a bad night");
    transport.failNext(key, down(), down(), down(), down());

    const first = await pruneAt(daysAfterFirstSeen(31));

    expect(first).toEqual([entry]);
    expect(pendingFile()).toBe(formatPendingPrunes([entry]));
    expect(log.failures).toHaveLength(1);
    expect(log.failures[0]).toContain(key);
    expect(log.failures[0]).toContain("the entry stays");
    // The deletes that succeeded happened, and nothing local moved: not the dump
    // that failed, not its manifest, not the mirror, not the ledger.
    for (const image of gone) {
      expect(transport.objects.has(offsite(`images/mirror/${image}`)), image).toBe(false);
      expect(local(join("images", image)), image).toBe(true);
    }
    expect(local(key)).toBe(true);
    expect(local(manifestKey(before))).toBe(true);
    expect(readFileSync(ledgerPath(), "utf8")).toContain(gone[0]!);
    expectSurvivors();

    log = new BackupLog();
    const second = await pruneAt(daysAfterFirstSeen(32));

    expect(second).toEqual([]);
    expect(log.failures).toEqual([]);
    expect(pendingFile()).toBe("");
    expectPruned();
    expectSurvivors();
  });

  it("carries on to the next account when one fails", async () => {
    const third = "99999999-8888-4777-8666-555555555555";
    const image = imageKey(third);
    placeImage(image);
    const stuck = `images/mirror/${gone[0]!}`;
    transport.ignoreDeletes(stuck);
    const later = { userId: third, firstSeenAt: FIRST_SEEN.toISOString() };

    const remaining = await applyAccountPlan(
      { added: [], cancelled: [], waiting: [], due: [entry, later] },
      context(),
      daysAfterFirstSeen(31),
    );

    expect(remaining).toEqual([entry]);
    expect(local(join("images", third))).toBe(false);
    expect(local(join("images", gone[0]!))).toBe(true);
  });

  it("cancels without touching anything, and an in-window ledger stays whole", async () => {
    const ledger = readFileSync(ledgerPath(), "utf8");
    const remaining = await applyAccountPlan(
      await assess(daysAfterFirstSeen(10), [GONE, KEPT]),
      context(),
      daysAfterFirstSeen(10),
    );
    expect(remaining).toEqual([]);
    expect(pendingFile()).toBe("");
    expectNothingRemoved();
    expect(readFileSync(ledgerPath(), "utf8")).toBe(ledger);
    expect(transport.calls.filter(({ verb }) => verb === "delete")).toEqual([]);
  });

  /**
   * The hole this closes: a prune stopped midway has removed the images off-site
   * with the ledger still naming them, and if the account is then restored, the
   * ledger's "already there" would keep them from ever going back.
   */
  it("drops a past-due cancellation's ledger lines, so the next run re-uploads", async () => {
    const remaining = await applyAccountPlan(
      await assess(daysAfterFirstSeen(31), [GONE, KEPT]),
      context(),
      daysAfterFirstSeen(31),
    );
    expect(remaining).toEqual([]);
    expect(readFileSync(ledgerPath(), "utf8")).toBe(kept.map((key) => `${key}\t${SHA}\n`).join(""));
    expectNothingRemoved();
  });

  it("leaves the other account's mirror as the only one in the directory", async () => {
    await pruneAt(daysAfterFirstSeen(31));
    expect(readdirSync(join(localDir, "images"))).toEqual([KEPT]);
  });
});
