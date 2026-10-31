import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { ledgerFile } from "../../src/db/backupOffsite.js";
import { NOTICE_FILE, NOTICE_TEXT, PENDING_PRUNE_FILE } from "../../src/db/backupPrune.js";
import { users } from "../../src/db/schema.js";
import {
  assertPostgresBinaries,
  createBackupWorld,
  run,
  sha256,
  type BackupWorld,
  type SeededImage,
} from "../helpers/backupWorld.js";
import { createFakeWrangler } from "../helpers/fakeWrangler.js";

/**
 * Pruning a deleted account, through the real job against real Postgres and real
 * MinIO. The time is moved by back-dating the earlier runs, so the run that does
 * the deleting in these tests is plain `npm run db:backup` with today's clock.
 *
 * What these assert first is what must survive, because a prune that deletes the
 * right things and also one thing more is the failure this design exists to make
 * impossible. Every assertion reads a file or an object, never the job's opinion.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Real initdb per run, and these tests run several. */
const SLOW = { timeout: 300_000 };

describe("pruning a deleted account", SLOW, () => {
  let world: BackupWorld;

  beforeAll(() => {
    assertPostgresBinaries();
  });

  beforeEach(async () => {
    world = await createBackupWorld();
  }, 60_000);

  afterEach(async () => {
    await world.close();
  }, 60_000);

  const daysAgo = (days: number) => -days * DAY_MS;
  const localPath = (name: string) => join(world.localDir, name);
  const mirrorFile = (image: SeededImage) => localPath(join("images", image.objectKey));
  const mirrorObject = (image: SeededImage) => `images/mirror/${image.objectKey}`;

  const pendingFile = () => readFileSync(localPath(PENDING_PRUNE_FILE), "utf8");
  const ledgerPath = () => localPath(ledgerFile(`localhost:9000-${world.backupBucket}`));

  /** A run in the past that has to be green for the test to mean anything. */
  async function greenAt(days: number, overrides: Record<string, string> = {}) {
    const result = await world.runBackupAt(daysAgo(days), overrides);
    expect(result.code, result.output).toBe(0);
    return world.readJson("last-run.json").dump.key as string;
  }

  async function expectGreenNow(overrides: Record<string, string> = {}) {
    const result = await world.runBackup(overrides);
    expect(result.code, result.output).toBe(0);
    return world.readJson("last-run.json").dump.key as string;
  }

  /** The instant in a dump's name, as the job writes it into the pending file. */
  function stampOf(dumpKey: string): string {
    const [, y, mo, d, h, mi, s] = /kept-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(dumpKey)!;
    return `${y}-${mo}-${d}T${h}:${mi}:${s}.000Z`;
  }

  const manifestOf = (dumpKey: string) =>
    dumpKey.replace("pg/", "manifests/").replace(".dump", ".tsv");

  async function expectHeld(key: string) {
    expect(existsSync(localPath(key)), `local ${key}`).toBe(true);
    expect(await world.getObject(world.backupBucket, key), `off-site ${key}`).toBeDefined();
  }

  async function expectImageHeld(image: SeededImage) {
    expect(sha256(readFileSync(mirrorFile(image))), image.objectKey).toBe(image.sha256);
    const object = await world.getObject(world.backupBucket, mirrorObject(image));
    expect(sha256(object!), image.objectKey).toBe(image.sha256);
  }

  async function expectGone(key: string) {
    expect(existsSync(localPath(key)), `local ${key}`).toBe(false);
    expect(await world.getObject(world.backupBucket, key), `off-site ${key}`).toBeUndefined();
  }

  /** Whether a dump's contents name this id anywhere, read by pg_restore itself. */
  async function dumpNames(key: string, id: string): Promise<boolean> {
    const dump = await run("pg_restore", ["-f", "-", localPath(key)], {});
    expect(dump.code, dump.output).toBe(0);
    return dump.stdout.includes(id);
  }

  /** Two users with history, one of them just deleted. */
  async function worldWithDeletion() {
    const { alice, bob, images } = await world.seed();
    const aliceImages = images.filter((image) => image.userId === alice.id);
    const bobImages = images.filter((image) => image.userId === bob.id);
    expect(aliceImages).toHaveLength(4);
    expect(bobImages).toHaveLength(1);

    const oldest = await greenAt(36);
    const older = await greenAt(34);
    await world.deleteAccount(alice.id);
    return { alice, bob, aliceImages, bobImages, oldest, older };
  }

  it("schedules and notifies, waits 29 days, and prunes at 31 keeping the rest", async () => {
    const { alice, aliceImages, bobImages, oldest, older } = await worldWithDeletion();
    expect(await dumpNames(oldest, alice.id)).toBe(true);

    // Day 0: the first run that can see the user is gone.
    const boundary = await greenAt(31);
    expect(await dumpNames(boundary, alice.id)).toBe(false);

    expect(pendingFile()).toBe(`${alice.id}\t${stampOf(boundary)}\n`);
    const notice = readFileSync(localPath(NOTICE_FILE), "utf8");
    expect(notice).toBe(`${NOTICE_TEXT}\n`);
    expect(notice).not.toContain(alice.id);

    const lastRun = world.readJson("last-run.json");
    expect(lastRun.ok).toBe(true);
    expect(lastRun.pendingPrunes).toEqual([
      {
        userId: alice.id,
        firstSeenAt: stampOf(boundary),
        pruneAfter: new Date(new Date(stampOf(boundary)).getTime() + 30 * DAY_MS).toISOString(),
      },
    ]);
    for (const image of [...aliceImages, ...bobImages]) {
      await expectImageHeld(image);
    }
    for (const key of [oldest, older, boundary]) {
      await expectHeld(key);
      await expectHeld(manifestOf(key));
    }

    const status = await world.runScript("db:backup-status", {
      ...process.env,
      BACKUP_LOCAL_DIR: world.localDir,
    });
    expect(status.stdout).toContain(`Pending prunes: 1 deleted account(s)`);
    expect(status.stdout).toContain(alice.id);
    expect(status.stdout).toContain(lastRun.pendingPrunes[0].pruneAfter);

    // Day 29: nothing. The notice is what kept-backup.sh removes after posting it.
    rmSync(localPath(NOTICE_FILE));
    const before = pendingFile();
    const dayTwentyNine = await greenAt(2);
    expect(pendingFile()).toBe(before);
    expect(existsSync(localPath(NOTICE_FILE))).toBe(false);
    for (const image of [...aliceImages, ...bobImages]) {
      await expectImageHeld(image);
    }
    for (const key of [oldest, older, boundary, dayTwentyNine]) {
      await expectHeld(key);
    }

    // Day 31: the real entrypoint with the real clock.
    const dayThirtyOne = await expectGreenNow();

    // What must survive, first: every dump and manifest from the boundary on,
    // the boundary included, and the other user's image in both places.
    for (const key of [boundary, dayTwentyNine, dayThirtyOne]) {
      await expectHeld(key);
      await expectHeld(manifestOf(key));
      expect(await dumpNames(key, alice.id), key).toBe(false);
      expect(readFileSync(localPath(manifestOf(key)), "utf8")).not.toContain(alice.id);
    }
    for (const image of bobImages) {
      await expectImageHeld(image);
    }

    // What must be gone.
    for (const key of [oldest, older, manifestOf(oldest), manifestOf(older)]) {
      await expectGone(key);
    }
    for (const image of aliceImages) {
      expect(await world.getObject(world.backupBucket, mirrorObject(image))).toBeUndefined();
    }
    expect(existsSync(localPath(join("images", alice.id)))).toBe(false);
    expect(readdirSync(localPath("images"))).toEqual([bobImages[0]!.userId]);

    // The ledger rewritten down to the other user, and the entry closed.
    expect(readFileSync(ledgerPath(), "utf8")).toBe(
      bobImages.map((image) => `${image.objectKey}\t${image.sha256}\n`).join(""),
    );
    expect(pendingFile()).toBe("");
    expect(world.readJson("last-run.json").pendingPrunes).toEqual([]);
    expect(world.readJson("last-run.json").warnings.join()).toContain(
      `Pruned deleted account ${alice.id}`,
    );

    // The off-site bucket holds what a restore needs and nothing of hers.
    const stored = await world.objectKeys(world.backupBucket);
    expect(stored.filter((key) => key.startsWith("pg/"))).toHaveLength(3);
    expect(stored.filter((key) => key.startsWith("manifests/"))).toHaveLength(3);
    expect(stored.filter((key) => key.includes(alice.id))).toEqual([]);

    // And the job goes on working with a prune behind it.
    await expectGreenNow();
    expect(world.readJson("last-success.json").imageCounts).toMatchObject({
      rows: 1,
      uploaded: 0,
      alreadyOffsite: 1,
    });
  });

  it("cancels when the user reappears, even past the date, and prunes nothing", async () => {
    const { alice, aliceImages, bobImages, oldest, older } = await worldWithDeletion();
    const boundary = await greenAt(32);
    expect(pendingFile()).toContain(alice.id);

    await world.db().insert(users).values({ id: alice.id, appleSub: "alice-restored" });

    await expectGreenNow();

    expect(pendingFile()).toBe("");
    expect(world.readJson("last-run.json").pendingPrunes).toEqual([]);
    expect(world.readJson("last-run.json").warnings.join()).toContain("cancelled");
    for (const key of [oldest, older, boundary]) {
      await expectHeld(key);
      await expectHeld(manifestOf(key));
    }
    for (const image of [...aliceImages, ...bobImages]) {
      await expectImageHeld(image);
    }
  });

  it("treats a wiped database as a failure, on the very run a prune fell due", async () => {
    const { alice, aliceImages, bobImages, oldest, older } = await worldWithDeletion();
    const boundary = await greenAt(32);
    const entry = pendingFile();
    expect(entry).toContain(alice.id);

    await world.db().execute(sql`
      truncate receipt_images, receipts, receipt_field_options, export_jobs, user_events, users
    `);
    const before = readFileSync(localPath("last-success.json"));

    const result = await world.runBackup();

    expect(result.code).toBe(1);
    expect(result.output).toContain("no receipts rows, so this run verified nothing");
    expect(pendingFile()).toBe(entry);
    expect(readFileSync(localPath("last-success.json")).equals(before)).toBe(true);
    for (const key of [oldest, older, boundary]) {
      await expectHeld(key);
      await expectHeld(manifestOf(key));
    }
    for (const image of [...aliceImages, ...bobImages]) {
      await expectImageHeld(image);
    }
  });

  it("treats every known user vanishing at once as a failure, whoever replaced them", async () => {
    const { alice, bob, images } = await world.seed();
    await greenAt(36);
    const before = readFileSync(localPath("last-success.json"));

    // A database that dumps, restores and mirrors perfectly, and is not this
    // one: nothing short of the prune's own guard can tell.
    await world.deleteAccount(alice.id);
    await world.deleteAccount(bob.id);
    const carol = await world.seedUser("carol");
    await world.addReceipt({ userId: carol.id });

    const result = await world.runBackup();

    expect(result.code).toBe(1);
    expect(result.output).toContain("all 2 known user(s) are missing");
    expect(existsSync(localPath(PENDING_PRUNE_FILE))).toBe(false);
    expect(existsSync(localPath(NOTICE_FILE))).toBe(false);
    // A database that is not ours earns no claim of success.
    expect(readFileSync(localPath("last-success.json")).equals(before)).toBe(true);
    expect(world.readJson("last-run.json").ok).toBe(false);
    for (const image of images) {
      await expectImageHeld(image);
    }

    // And the next night is the same, with Carol's image mirrored by now. A guard
    // that lapsed here would schedule everyone a wiped database lost.
    expect(readdirSync(localPath("images"))).toContain(carol.id);
    const nextNight = await world.runBackup();

    expect(nextNight.code).toBe(1);
    expect(nextNight.output).toContain("all 2 known user(s) are missing");
    expect(existsSync(localPath(PENDING_PRUNE_FILE))).toBe(false);
    expect(readFileSync(localPath("last-success.json")).equals(before)).toBe(true);

    // A person saying this database is the real one ends it, and from there the
    // ordinary rules apply: scheduled, with the 30 days still to run.
    rmSync(localPath("last-success.json"));
    const accepted = await world.runBackup();
    expect(accepted.code, accepted.output).toBe(0);
    expect(pendingFile()).toContain(alice.id);
    expect(pendingFile()).toContain(bob.id);
    for (const image of images) {
      await expectImageHeld(image);
    }
  });

  it("does nothing on a run that was not green, with a prune already due", async () => {
    const { alice, bob, aliceImages, bobImages, oldest, older } = await worldWithDeletion();
    const boundary = await greenAt(32);
    const entry = pendingFile();
    expect(entry).toContain(alice.id);

    // One live image the source cannot produce: a failed run, and nothing else
    // about it is wrong. The dump, the mirror and the upload all work.
    await world.addReceipt({ userId: bob.id, upload: "none" });

    const result = await world.runBackup();

    expect(result.code).toBe(1);
    expect(result.output).toContain("MISSING");
    expect(result.output).not.toContain("Pruned deleted account");
    expect(pendingFile()).toBe(entry);
    expect(world.readJson("last-run.json").pendingPrunes).toHaveLength(1);
    for (const key of [oldest, older, boundary]) {
      await expectHeld(key);
      await expectHeld(manifestOf(key));
    }
    for (const image of [...aliceImages, ...bobImages]) {
      await expectImageHeld(image);
    }
    expect(readFileSync(ledgerPath(), "utf8")).toContain(aliceImages[0]!.objectKey);
  });

  /**
   * The last moment a run can stop being green: everything worked, the plan is
   * made, and then the claim of success cannot be written. A directory in the way
   * is how to force that here; a full disk is how it happens.
   */
  it("prunes nothing when last-success.json cannot be written", async () => {
    const { alice, aliceImages, oldest } = await worldWithDeletion();
    await greenAt(32);
    const entry = pendingFile();
    expect(entry).toContain(alice.id);
    rmSync(localPath("last-success.json"));
    mkdirSync(localPath("last-success.json"));

    const result = await world.runBackup();

    expect(result.code).toBe(1);
    expect(world.readJson("last-run.json").failures.join()).toContain("last-success.json");
    expect(pendingFile()).toBe(entry);
    await expectHeld(oldest);
    await expectImageHeld(aliceImages[0]!);
  });

  it("refuses to act on a pending file it cannot read, and does not rewrite it", async () => {
    const { aliceImages, oldest } = await worldWithDeletion();
    await greenAt(32);
    const damaged = `${pendingFile()}not a line\n`;
    writeFileSync(localPath(PENDING_PRUNE_FILE), damaged);

    const result = await world.runBackup();

    expect(result.code).toBe(1);
    expect(result.output).toContain("line 2 is not a readable entry");
    expect(pendingFile()).toBe(damaged);
    await expectHeld(oldest);
    await expectImageHeld(aliceImages[0]!);
  });

  describe("when a deletion fails midway", () => {
    let proxy: FlakyStore;

    beforeEach(async () => {
      proxy = await startFlakyStore();
    });

    afterEach(async () => {
      await proxy.close();
    });

    it("keeps the entry and every local copy, and a later run finishes", async () => {
      const through = { BACKUP_STORAGE_ENDPOINT: proxy.endpoint };
      const { alice } = await world.seed().then(async (seeded) => {
        await greenAt(36, through);
        return seeded;
      });
      const oldest = world.readJson("last-run.json").dump.key as string;
      const aliceImages = (await world.objectKeys(world.backupBucket)).filter((key) =>
        key.includes(alice.id),
      );
      await world.deleteAccount(alice.id);
      const boundary = await greenAt(32, through);
      const entry = pendingFile();
      const destination = localPath(ledgerFile(`${new URL(proxy.endpoint).host}-${world.backupBucket}`));
      const ledger = readFileSync(destination, "utf8");
      const success = world.readJson("last-success.json").time;

      // MinIO itself refuses this one delete. Her images go first, so this stops
      // the prune midway, between the images and the dumps.
      proxy.refuseDeletesOf(oldest);

      const failed = await world.runBackup(through);

      expect(failed.code).toBe(1);
      const lastRun = world.readJson("last-run.json");
      expect(lastRun.ok).toBe(false);
      expect(lastRun.failures).toHaveLength(1);
      expect(lastRun.failures[0]).toContain(`deleted-account prune of ${alice.id}`);
      expect(lastRun.failures[0]).toContain(oldest);
      expect(pendingFile()).toBe(entry);
      expect(lastRun.pendingPrunes).toHaveLength(1);

      // Midway: off-site the images are gone, and the dump it stopped on is not.
      for (const key of aliceImages) {
        expect(await world.getObject(world.backupBucket, key), key).toBeUndefined();
      }
      await expectHeld(oldest);
      await expectHeld(boundary);
      // And no local copy moved: the mirror, the dump, the manifest, the ledger.
      // The manifest's off-site copy may have gone in the other lane, which is why
      // this is local only: an entry that stays will ask again, and absent is fine.
      expect(existsSync(localPath(manifestOf(oldest)))).toBe(true);
      for (const key of aliceImages) {
        expect(existsSync(localPath(key.replace("images/mirror/", "images/"))), key).toBe(true);
      }
      expect(readFileSync(destination, "utf8")).toBe(ledger);

      // The backup itself was fine, and says so: a stuck delete is not a stopped
      // backup, so last-success moved on while the job still exited non-zero.
      expect(world.readJson("last-success.json").time).not.toBe(success);

      proxy.allowDeletes();
      const finishing = await world.runBackup(through);

      expect(finishing.code, finishing.output).toBe(0);
      expect(pendingFile()).toBe("");
      await expectGone(oldest);
      await expectGone(manifestOf(oldest));
      await expectHeld(boundary);
      await expectHeld(manifestOf(boundary));
      expect(existsSync(localPath(join("images", alice.id)))).toBe(false);
      expect(readFileSync(destination, "utf8")).not.toContain(alice.id);
    });
  });

  it("prunes through wrangler too, and does not believe a delete that did nothing", async () => {
    const fake = createFakeWrangler();
    try {
      const { alice, bob, images } = await world.seed();
      for (const image of images) {
        fake.store(world.sourceBucket, image.objectKey, image.bytes);
      }
      const fakeEnv = fake.env();
      const wrangler = {
        BACKUP_TRANSPORT: "wrangler",
        BACKUP_STORAGE_ENDPOINT: "",
        BACKUP_STORAGE_ACCESS_KEY_ID: "",
        BACKUP_STORAGE_SECRET_ACCESS_KEY: "",
        PATH: fakeEnv.PATH!,
        FAKE_WRANGLER_STATE: fakeEnv.FAKE_WRANGLER_STATE!,
      };
      const oldest = await greenAt(36, wrangler);
      await world.deleteAccount(alice.id);
      await greenAt(32, wrangler);

      // What a mistyped bucket would look like: exit 0, nothing gone. Deletes
      // run two at a time and the plan is shared, so it has to outlast every
      // retry of every object; a plan of exactly four let two objects split it
      // on a faster machine, and each then succeeded for real.
      fake.planDeletes(Array<"noop">(64).fill("noop"));
      const lying = await world.runBackup(wrangler);
      expect(lying.code, lying.output).toBe(1);
      expect(lying.output).toContain("still there after the delete");
      expect(pendingFile()).toContain(alice.id);
      expect(existsSync(localPath(oldest))).toBe(true);

      fake.planDeletes([]);
      await expectGreenNow(wrangler);

      expect(pendingFile()).toBe("");
      expect(existsSync(localPath(oldest))).toBe(false);
      expect(() => fake.stored(world.backupBucket, oldest)).toThrow();
      const deletes = fake.argv().filter((line) => line.startsWith("r2 object delete"));
      expect(deletes.length).toBeGreaterThan(0);
      for (const line of deletes) {
        expect(line).toMatch(new RegExp(`^r2 object delete ${world.backupBucket}/\\S+ --remote$`));
      }
      const bobImage = images.find((image) => image.userId === bob.id)!;
      expect(sha256(fake.stored(world.backupBucket, mirrorObject(bobImage)))).toBe(bobImage.sha256);
    } finally {
      fake.close();
    }
  });
});

interface FlakyStore {
  endpoint: string;
  refuseDeletesOf(key: string): void;
  allowDeletes(): void;
  close(): Promise<void>;
}

/**
 * MinIO, reached through a pipe that can refuse a DELETE, because a failure has to
 * be forced somewhere and this is the honest place: the job's s3 client talks to
 * real storage, gets a real error response, and retries as it would at 02:00. The
 * Host header is passed through untouched, since the request is signed over it.
 */
async function startFlakyStore(): Promise<FlakyStore> {
  let refused: string | undefined;
  const server: Server = createServer((incoming, outgoing) => {
    if (incoming.method === "DELETE" && refused !== undefined && incoming.url?.includes(refused)) {
      incoming.resume();
      outgoing.writeHead(403, { "Content-Type": "application/xml" });
      outgoing.end('<?xml version="1.0"?><Error><Code>AccessDenied</Code><Message>no</Message></Error>');
      return;
    }
    const upstream = request(
      {
        host: "localhost",
        port: 9000,
        method: incoming.method,
        path: incoming.url,
        headers: incoming.headers,
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(outgoing);
      },
    );
    upstream.on("error", () => outgoing.destroy());
    incoming.pipe(upstream);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    refuseDeletesOf: (key) => {
      refused = key;
    },
    allowDeletes: () => {
      refused = undefined;
    },
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
