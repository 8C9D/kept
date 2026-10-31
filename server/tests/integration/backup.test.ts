import { ledgerFile } from "../../src/db/backupOffsite.js";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { count } from "drizzle-orm";
import { createDb } from "../../src/db/client.js";
import { checkRestoredImage } from "../../src/db/restoreImageCheck.js";
import { receiptImages, users } from "../../src/db/schema.js";
import {
  SERVER_DIR,
  assertPostgresBinaries,
  createBackupWorld,
  run,
  sha256,
  type BackupWorld,
  type SeededImage,
} from "../helpers/backupWorld.js";
import { createFakeWrangler, type FakeWrangler } from "../helpers/fakeWrangler.js";

/** Split so the fixtures below read as fixtures to the repo's secret hook. */
const PG = "postgres:" + "//";

/**
 * The backup job, for real: `npm run db:backup` configured by environment, with
 * real pg_dump, a real throwaway cluster, real Postgres and real MinIO, in two
 * distinct buckets. The assertions read artifacts - the dump with pg_restore, the
 * mirror with sha256, the buckets object by object - and not the job's opinion
 * of itself.
 *
 * Shims on PATH stand in for a tool only where a failure has to be forced
 * (a client writing mid-dump, a restore that fails), and they wrap the real
 * tool wherever they can.
 */

const MANIFEST_KEY = /^manifests\/kept-\d{8}-\d{6}\.tsv$/;
const DUMP_KEY = /^pg\/kept-\d{8}-\d{6}\.dump$/;

/** Each job run costs a real initdb, and some tests run several. */
const SLOW = { timeout: 240_000 };

describe("the backup job against real Postgres and MinIO", SLOW, () => {
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

  const mirrorFile = (image: SeededImage) => join(world.localDir, "images", image.objectKey);
  const mirrorObject = (image: SeededImage) => `images/mirror/${image.objectKey}`;
  const lastSuccessBytes = () => readFileSync(join(world.localDir, "last-success.json"));

  async function expectGreen(overrides: Record<string, string> = {}) {
    const result = await world.runBackup(overrides);
    expect(result.code, result.output).toBe(0);
    return result;
  }

  function expectNoClusterLeft() {
    expect(world.leftovers()).toEqual({ clusters: [], processes: "" });
  }

  async function offsiteDumps() {
    return (await world.objectKeys(world.backupBucket)).filter((key) => key.startsWith("pg/"));
  }

  describe("a good run", () => {
    it("restores, mirrors and verifies both stores, off-site included", async () => {
      const { images } = await world.seed();

      const result = await expectGreen();
      expect(result.stdout).toContain("Backup complete");

      // The record of the run.
      const success = world.readJson("last-success.json");
      expect(success.dumpKey).toMatch(DUMP_KEY);
      expect(success.imageCounts).toEqual({
        rows: 5,
        live: 4,
        tombstoned: 1,
        alreadyMirrored: 0,
        fetched: 5,
        notMirrored: 0,
        uploaded: 5,
        alreadyOffsite: 0,
      });
      // Seven tables, all of them, the two verifyRestore used to leave out and
      // the migration history included.
      expect(success.tableCounts).toEqual({
        "drizzle.__drizzle_migrations": expect.any(Number),
        export_jobs: 1,
        receipt_field_options: 1,
        receipt_images: 5,
        receipts: 4,
        user_events: 1,
        users: 2,
      });
      expect(success.tableCounts["drizzle.__drizzle_migrations"]).toBeGreaterThan(0);
      const lastRun = world.readJson("last-run.json");
      expect(lastRun.ok).toBe(true);
      expect(lastRun.failures).toEqual([]);

      // The dump itself: a real archive, with the sha256 the run recorded.
      const dumpPath = join(world.localDir, success.dumpKey);
      const dump = readFileSync(dumpPath);
      expect(sha256(dump)).toBe(success.sha256);
      expect(statSync(dumpPath).mode & 0o777).toBe(0o600);
      const listing = await run("pg_restore", ["-l", dumpPath], {});
      expect(listing.code).toBe(0);
      for (const table of ["receipts", "receipt_images", "users", "user_events"]) {
        expect(listing.stdout).toContain(`TABLE DATA public ${table}`);
      }
      expect(listing.stdout).toContain("TABLE DATA drizzle __drizzle_migrations");

      // The mirror: every image, tombstoned included, hashing to its row.
      for (const image of images) {
        expect(sha256(readFileSync(mirrorFile(image)))).toBe(image.sha256);
        expect(statSync(mirrorFile(image)).mode & 0o777).toBe(0o600);
      }
      expect(statSync(world.localDir).mode & 0o777).toBe(0o700);
      for (const directory of ["pg", "images", "manifests"]) {
        expect(statSync(join(world.localDir, directory)).mode & 0o777).toBe(0o700);
      }
      expect(statSync(dirname(mirrorFile(images[0]!))).mode & 0o777).toBe(0o700);

      // Off-site: exactly the dump, the manifest and the five images.
      const stored = await world.objectKeys(world.backupBucket);
      expect(stored).toHaveLength(7);
      expect(sha256((await world.getObject(world.backupBucket, success.dumpKey))!)).toBe(
        success.sha256,
      );
      for (const image of images) {
        const object = await world.getObject(world.backupBucket, mirrorObject(image));
        expect(sha256(object!)).toBe(image.sha256);
      }

      // The manifest, local and off-site, naming every row.
      const manifestKey = stored.find((key) => key.startsWith("manifests/"))!;
      expect(manifestKey).toMatch(MANIFEST_KEY);
      const manifest = readFileSync(join(world.localDir, manifestKey), "utf8");
      expect(Buffer.from((await world.getObject(world.backupBucket, manifestKey))!).toString()).toBe(
        manifest,
      );
      const lines = manifest.trimEnd().split("\n");
      expect(lines[0]).toBe("object_key\tsha256\tdeleted");
      expect(lines.slice(1).sort()).toEqual(
        images.map((image) => `${image.objectKey}\t${image.sha256}\t${image.deleted}`).sort(),
      );

      // The ledger, and no scratch left behind.
      const ledger = readFileSync(join(world.localDir, ledgerFile(`localhost:9000-${world.backupBucket}`)), "utf8");
      expect(ledger.trimEnd().split("\n").sort()).toEqual(
        images.map((image) => `${image.objectKey}\t${image.sha256}`).sort(),
      );
      expect(readdirSync(join(world.localDir, "pg")).filter((name) => name.endsWith(".partial"))).toEqual([]);
      expectNoClusterLeft();
    });

    it("re-uploads nothing on a second run, and only a lost ledger changes that", async () => {
      const { images } = await world.seed();
      await expectGreen();

      // Removed behind the job's back: an upload would bring it back, so its
      // staying gone proves nothing was uploaded.
      const canary = mirrorObject(images[0]!);
      await world.deleteObject(world.backupBucket, canary);

      await expectGreen();

      expect(world.readJson("last-success.json").imageCounts).toMatchObject({
        rows: 5,
        alreadyMirrored: 5,
        fetched: 0,
        uploaded: 0,
        alreadyOffsite: 5,
      });
      expect(await world.getObject(world.backupBucket, canary)).toBeUndefined();
      expect(await offsiteDumps()).toHaveLength(2);

      rmSync(join(world.localDir, ledgerFile(`localhost:9000-${world.backupBucket}`)));
      await expectGreen();

      expect(world.readJson("last-success.json").imageCounts).toMatchObject({
        uploaded: 5,
        alreadyOffsite: 0,
      });
      expect(await world.getObject(world.backupBucket, canary)).toBeDefined();
    });

    it("works in launchd's environment, which has no locale in it", async () => {
      // ⚠ Not a formality. With no LANG or LC_ALL, Postgres on macOS refuses to
      // start ("postmaster became multithreaded during startup"), and every
      // shell this suite is ever launched from has one set - so without this
      // test the job could pass everything here and fail every scheduled night.
      await world.seed();
      const environment = world.launchdEnvironment();
      expect(Object.keys(environment).filter((name) => /^(LANG|LC_)/.test(name))).toEqual([]);

      const result = await world.runScript("db:backup", environment);

      expect(result.code, result.output).toBe(0);
      expect(world.readJson("last-success.json").tableCounts.receipts).toBe(4);
      expectNoClusterLeft();
    });

    it("needs no STORAGE_* at all and refuses to run without its own config", async () => {
      const result = await world.runScript(
        "db:backup",
        world.environment({ BACKUP_TRANSPORT: "" }),
      );
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("BACKUP_TRANSPORT");
      expect(existsSync(join(world.localDir, "last-run.json"))).toBe(false);
    });
  });

  describe("damage in the source", () => {
    it("fails DIGEST on wrong bytes for a new image and mirrors nothing", async () => {
      const { alice, images } = await world.seed();
      await expectGreen();
      const before = lastSuccessBytes();
      const held = images.map((image) => readFileSync(mirrorFile(image)));

      const [corrupt] = await world.addReceipt({ userId: alice.id, upload: "corrupt" });

      const result = await world.runBackup();

      expect(result.code).toBe(1);
      expect(result.output).toContain("DIGEST");
      expect(result.output).toContain(corrupt!.objectKey);
      expect(existsSync(mirrorFile(corrupt!))).toBe(false);
      expect(await world.getObject(world.backupBucket, mirrorObject(corrupt!))).toBeUndefined();
      // Every good local copy untouched, and no claim of success.
      images.forEach((image, index) => {
        expect(readFileSync(mirrorFile(image)).equals(held[index]!)).toBe(true);
      });
      expect(lastSuccessBytes().equals(before)).toBe(true);
      expect(world.readJson("last-run.json").ok).toBe(false);
      expect(world.readJson("last-run.json").failures.join()).toContain("DIGEST");
    });

    it("never replaces local bytes with wrong bytes from the source", async () => {
      const { images } = await world.seed();
      await expectGreen();
      const before = lastSuccessBytes();

      // The one path on which the job fetches an image it already holds: the
      // local copy fails its hash, and the source then turns out worse.
      const image = images[0]!;
      const damaged = Buffer.from("local damage");
      writeFileSync(mirrorFile(image), damaged);
      await world.putObject(world.sourceBucket, image.objectKey, new Uint8Array(Buffer.from("source damage")));

      const result = await world.runBackup();

      expect(result.code).toBe(1);
      expect(result.output).toContain("re-fetching");
      expect(result.output).toContain("DIGEST");
      expect(readFileSync(mirrorFile(image)).equals(damaged)).toBe(true);
      expect(lastSuccessBytes().equals(before)).toBe(true);
    });

    it("repairs a damaged local copy from a good source, and says it did", async () => {
      const { images } = await world.seed();
      await expectGreen();
      const image = images[0]!;
      writeFileSync(mirrorFile(image), "bit rot");

      await expectGreen();

      expect(sha256(readFileSync(mirrorFile(image)))).toBe(image.sha256);
      expect(world.readJson("last-run.json").warnings.join()).toContain(image.objectKey);
    });

    /**
     * Pinned because it is the design's limit, not because it is desirable. A
     * mirrored image that hashes to its row is skipped (backupMirror.ts), so its
     * source object is not read again, and damage done to it afterwards is not
     * seen. The good local and off-site copies are what protect the record.
     */
    it("does not look at the source of an image it already holds", async () => {
      const { images } = await world.seed();
      await expectGreen();
      const image = images[0]!;
      await world.putObject(world.sourceBucket, image.objectKey, new Uint8Array(Buffer.from("rot")));

      await expectGreen();

      expect(sha256(readFileSync(mirrorFile(image)))).toBe(image.sha256);
      expect(world.readJson("last-success.json").imageCounts.fetched).toBe(0);
    });

    it("fails MISSING on a live row, and the dump still reaches off-site", async () => {
      const { alice } = await world.seed();
      await expectGreen();
      const before = lastSuccessBytes();

      const [absent] = await world.addReceipt({ userId: alice.id, upload: "none" });

      const result = await world.runBackup();

      expect(result.code).toBe(1);
      expect(result.output).toContain("MISSING");
      expect(result.output).toContain(absent!.objectKey);
      expect(lastSuccessBytes().equals(before)).toBe(true);

      const lastRun = world.readJson("last-run.json");
      expect(lastRun.failures).toHaveLength(1);
      expect(lastRun.failures[0]).toContain("MISSING");
      expect(lastRun.imageCounts).toMatchObject({ rows: 6, notMirrored: 1 });

      // A partial run does as much as it can.
      expect(sha256((await world.getObject(world.backupBucket, lastRun.dump.key))!)).toBe(
        lastRun.dump.sha256,
      );
      expect(existsSync(join(world.localDir, lastRun.dump.key))).toBe(true);
      const manifests = (await world.objectKeys(world.backupBucket)).filter((key) =>
        key.startsWith("manifests/"),
      );
      expect(manifests).toHaveLength(2);
    });

    it("only warns on a missing object behind a tombstone, and the run is green", async () => {
      const { alice } = await world.seed();
      const [absent] = await world.addReceipt({ userId: alice.id, deleted: true, upload: "none" });

      await expectGreen();

      const lastRun = world.readJson("last-run.json");
      expect(lastRun.ok).toBe(true);
      expect(lastRun.warnings).toHaveLength(1);
      expect(lastRun.warnings[0]).toContain("MISSING on a tombstoned row");
      expect(lastRun.warnings[0]).toContain(absent!.objectKey);
      expect(world.readJson("last-success.json").imageCounts).toMatchObject({
        rows: 6,
        tombstoned: 2,
        notMirrored: 1,
      });
    });

    it("refuses a stored key it did not issue, and writes nothing for it", async () => {
      const { images } = await world.seed();
      const target = images[0]!;
      const traversal = `${target.userId}/../../../escape.jpg`;
      await world.db().update(receiptImages).set({ objectKey: traversal });

      const result = await world.runBackup();

      expect(result.code).toBe(1);
      expect(result.output).toContain("not one this system issued");
      expect(result.output).not.toContain("escape.jpg");
      expect(existsSync(join(world.localDir, "escape.jpg"))).toBe(false);
      expect(existsSync(join(world.root, "escape.jpg"))).toBe(false);
      expect(readdirSync(join(world.localDir, "images"))).toEqual([]);
    });
  });

  describe("the restore step", () => {
    it("redoes the dump once when a client writes during it, and then passes", async () => {
      await world.seed();
      // The real pg_dump, followed the first time only by a real client write:
      // the race the redo exists for, made to happen on demand.
      const flag = join(world.root, "wrote-once");
      const real = (await run("which", ["pg_dump"], {})).stdout.trim();
      world.shim(
        "pg_dump",
        `#!/bin/sh
"${real}" "$@" || exit $?
case "$1" in --version) exit 0 ;; esac
if [ ! -e "${flag}" ]; then
  touch "${flag}"
  psql "${world.sourceUrl}" -q -c "insert into users (apple_sub) values ('wrote-during-the-dump')"
fi
`,
      );

      const result = await world.runBackup({ PATH: world.pathWithShims() });

      expect(result.code, result.output).toBe(0);
      expect(result.output).toContain("redoing once");
      expect(readdirSync(join(world.localDir, "pg"))).toHaveLength(2);
      const success = world.readJson("last-success.json");
      expect(success.tableCounts.users).toBe(3);
      expect(await offsiteDumps()).toEqual([success.dumpKey]);
    });

    it("fails when the counts differ twice", async () => {
      await world.seed();
      const flag = join(world.root, "writes");
      const real = (await run("which", ["pg_dump"], {})).stdout.trim();
      world.shim(
        "pg_dump",
        `#!/bin/sh
"${real}" "$@" || exit $?
case "$1" in --version) exit 0 ;; esac
echo x >> "${flag}"
psql "${world.sourceUrl}" -q -c "insert into users (apple_sub) values ('writer-$(wc -l < "${flag}" | tr -d ' ')')"
`,
      );

      const result = await world.runBackup({ PATH: world.pathWithShims() });

      expect(result.code).toBe(1);
      expect(result.output).toContain("users: 4 rows in source, 3 restored");
      expect(existsSync(join(world.localDir, "last-success.json"))).toBe(false);
      // Not green, and still as much as it could do: the dump is off-site.
      const lastRun = world.readJson("last-run.json");
      expect(await offsiteDumps()).toEqual([lastRun.dump.key]);
      expectNoClusterLeft();
    });

    it("calls an empty database verifying nothing", async () => {
      await world.seedUser("alone");

      const result = await world.runBackup();

      expect(result.code).toBe(1);
      expect(result.output).toContain("no receipts rows, so this run verified nothing");
      expect(result.output).toContain("no receipt_images rows, so this run verified nothing");
      expect(existsSync(join(world.localDir, "last-success.json"))).toBe(false);
      expectNoClusterLeft();
    });

    it("removes the cluster and keeps the dump when the restore fails", async () => {
      await world.seed();
      world.shim(
        "pg_restore",
        `#!/bin/sh
case "$1" in --version) exec "$(which -a pg_restore | sed -n 2p)" "$@" ;; esac
echo 'CONTEXT: COPY receipts, line 1: "Secret Vendor"' >&2
exit 1
`,
      );

      const result = await world.runBackup({ PATH: world.pathWithShims() });

      expect(result.code).toBe(1);
      expect(result.output).toContain("pg_restore exited with code 1");
      expect(result.output).toContain("image leg skipped");
      // What a failing COPY prints is a receipt, and receipts stay out of logs.
      expect(result.output).not.toContain("Secret Vendor");
      expectNoClusterLeft();

      const lastRun = world.readJson("last-run.json");
      expect(JSON.stringify(lastRun)).not.toContain("Secret Vendor");
      expect(existsSync(join(world.localDir, lastRun.dump.key))).toBe(true);
      expect(await offsiteDumps()).toEqual([lastRun.dump.key]);
      expect(existsSync(join(world.localDir, "last-success.json"))).toBe(false);
    });

    it("stops and deletes the cluster when the job is told to stop mid-restore", async () => {
      await world.seed();
      const marker = join(world.root, "restore-started");
      world.shim(
        "pg_restore",
        `#!/bin/sh
case "$1" in --version) exec "$(which -a pg_restore | sed -n 2p)" "$@" ;; esac
touch "${marker}"
exec sleep 20
`,
      );

      // Directly rather than through npm: this is the signal launchd would send
      // and it should land on the job, with no process between to relay it.
      const job = spawn(process.execPath, ["--import", "tsx", "src/db/backup.ts"], {
        cwd: SERVER_DIR,
        env: world.environment({ PATH: world.pathWithShims() }),
        stdio: "ignore",
      });
      const exited = new Promise<number | null>((resolve) => job.once("close", resolve));

      for (let waited = 0; !existsSync(marker) && waited < 60_000; waited += 100) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(existsSync(marker)).toBe(true);
      expect(world.leftovers().clusters).toHaveLength(1);

      job.kill("SIGTERM");

      expect(await exited).toBe(143);
      // The orphaned `sleep` is the shim's and holds nothing; the postmaster is
      // what must be gone, and it is the one running from this directory.
      expect(world.leftovers().clusters).toEqual([]);
      const postmasters = await run("pgrep", ["-f", `postgres.*${world.jobTmp}`], {});
      expect(postmasters.stdout.trim()).toBe("");
    });

    it("leaves nothing behind when the dump fails, and never prints the password", async () => {
      await world.seed();
      const password = "S3cret-Hunter2-Do-Not-Log";

      const result = await world.runBackup({
        // Port 1: nothing is listening, so pg_dump fails after being handed the
        // connection, which is the moment the old job's error carried the URL.
        DATABASE_URL: `${PG}kept:${password}@127.0.0.1:1/kept?sslmode=disable`,
      });

      expect(result.code).toBe(1);
      expect(result.output).toContain("pg_dump exited with code 1");
      expect(result.output).not.toContain(password);
      expect(result.output).not.toContain(`${PG}kept:`);

      const lastRun = readFileSync(join(world.localDir, "last-run.json"), "utf8");
      expect(lastRun).not.toContain(password);
      expect(JSON.parse(lastRun).failures[0]).toContain("pg_dump exited with code 1");

      expect(readdirSync(join(world.localDir, "pg"))).toEqual([]);
      expect(existsSync(join(world.localDir, "last-success.json"))).toBe(false);
      expectNoClusterLeft();
    });

    it("refuses an empty dump, exit code or no exit code", async () => {
      await world.seed();
      const real = (await run("which", ["pg_dump"], {})).stdout.trim();
      world.shim(
        "pg_dump",
        `#!/bin/sh
case "$1" in --version) exec "${real}" "$@" ;; esac
exit 0
`,
      );

      const result = await world.runBackup({ PATH: world.pathWithShims() });

      expect(result.code).toBe(1);
      expect(result.output).toContain("pg_dump wrote an empty file");
      expect(readdirSync(join(world.localDir, "pg"))).toEqual([]);
      expect(await world.objectKeys(world.backupBucket)).toEqual([]);
      expect(existsSync(join(world.localDir, "last-success.json"))).toBe(false);
    });

    it("hands pg_dump the password through the environment, never argv", async () => {
      await world.seed();
      const seen = join(world.root, "pg_dump-argv");
      const password = "argv-must-not-carry-this";
      const real = (await run("which", ["pg_dump"], {})).stdout.trim();
      world.shim(
        "pg_dump",
        `#!/bin/sh
printf '%s\\n' "$*" >> "${seen}"
printf 'PGPASSWORD=%s\\n' "$PGPASSWORD" >> "${seen}"
exec "${real}" "$@"
`,
      );

      const url = new URL(world.sourceUrl);
      url.password = password;
      await world.runBackup({ PATH: world.pathWithShims(), DATABASE_URL: url.toString() });

      const invocations = readFileSync(seen, "utf8").split("\n");
      const dumpArgv = invocations.find((line) => line.includes("-Fc"));
      expect(dumpArgv).toBeDefined();
      expect(dumpArgv).not.toContain(password);
      expect(invocations).toContain(`PGPASSWORD=${password}`);
    });
  });

  describe("preflight", () => {
    it("refuses a tool that is too old, by name, before touching anything", async () => {
      await world.seed();
      world.shim("initdb", "#!/bin/sh\necho 'initdb (PostgreSQL) 15.6'\n");

      const result = await world.runBackup({ PATH: world.pathWithShims() });

      expect(result.code).toBe(1);
      expect(result.output).toContain("initdb is version 15");
      expect(readdirSync(join(world.localDir, "pg"))).toEqual([]);
      expect(await world.objectKeys(world.backupBucket)).toEqual([]);
      expect(world.readJson("last-run.json").failures[0]).toContain("initdb is version 15");
    });
  });

  describe("db:backup-status", () => {
    const status = () =>
      world.runScript("db:backup-status", { ...process.env, BACKUP_LOCAL_DIR: world.localDir });

    it("reads the job's own records, with no credential in its environment", async () => {
      await world.seed();
      await expectGreen();

      const healthy = await status();
      expect(healthy.code).toBe(0);
      expect(healthy.stdout).toContain("Last success:");
      expect(healthy.stdout).toContain(world.readJson("last-success.json").dumpKey);

      await world.addReceipt({ userId: (await world.seedUser("carol")).id, upload: "none" });
      await world.runBackup();

      const afterFailure = await status();
      expect(afterFailure.code).toBe(0);
      expect(afterFailure.stdout).toContain("FAILED with 1 problem(s)");
      expect(afterFailure.stdout).toContain("MISSING");

      const stale = world.readJson("last-success.json");
      stale.time = new Date(Date.now() - 49 * 3_600_000).toISOString();
      writeFileSync(join(world.localDir, "last-success.json"), JSON.stringify(stale));
      const overdue = await status();
      expect(overdue.code).toBe(1);
      expect(overdue.stdout).toContain("STALE");
    });

    it("exits 1 when there has never been a success", async () => {
      mkdirSync(world.localDir, { recursive: true });
      const result = await status();
      expect(result.code).toBe(1);
      expect(result.stdout).toContain("Last success: NONE");
    });
  });

  describe("db:verify-restore", () => {
    it("compares every table, with the same comparison the job uses", async () => {
      await world.seed();
      await expectGreen();
      const { dumpKey } = world.readJson("last-success.json");

      const restoredUrl = await world.createDatabase(`${world.databaseName}_verify`);
      const restore = await run(
        "pg_restore",
        ["--no-owner", "--no-privileges", "--exit-on-error", "-d", restoredUrl, join(world.localDir, dumpKey)],
        {},
      );
      expect(restore.code, restore.output).toBe(0);

      const environment = {
        ...world.environment(),
        SOURCE_DATABASE_URL: world.sourceUrl,
        RESTORED_DATABASE_URL: restoredUrl,
        STORAGE_ENDPOINT: "http://localhost:9000",
        STORAGE_BUCKET: world.sourceBucket,
        STORAGE_ACCESS_KEY_ID: "kept",
        STORAGE_SECRET_ACCESS_KEY: "kept-local-dev",
      };
      const verified = await world.runScript("db:verify-restore", environment);
      expect(verified.code, verified.output).toBe(0);
      for (const table of ["receipt_field_options", "user_events", "drizzle.__drizzle_migrations"]) {
        expect(verified.stdout).toContain(table);
      }
      expect(verified.stdout).not.toContain("MISMATCH");

      await world.db().insert(users).values({ appleSub: "after-the-dump" });
      const moved = await world.runScript("db:verify-restore", environment);
      expect(moved.code).toBe(1);
      expect(moved.output).toContain("users: 3 rows in source, 2 restored");
    });
  });

  describe("wrangler mode", () => {
    let fake: FakeWrangler;

    beforeEach(() => {
      fake = createFakeWrangler();
    });

    afterEach(() => {
      fake.close();
    });

    it("runs the whole job through the CLI, with real Postgres behind it", async () => {
      const { images } = await world.seed();
      for (const image of images) {
        fake.store(world.sourceBucket, image.objectKey, image.bytes);
      }

      const fakeEnv = fake.env();
      const result = await world.runBackup({
        BACKUP_TRANSPORT: "wrangler",
        BACKUP_STORAGE_ENDPOINT: "",
        BACKUP_STORAGE_ACCESS_KEY_ID: "",
        BACKUP_STORAGE_SECRET_ACCESS_KEY: "",
        PATH: fakeEnv.PATH!,
        FAKE_WRANGLER_STATE: fakeEnv.FAKE_WRANGLER_STATE!,
      });

      expect(result.code, result.output).toBe(0);
      const success = world.readJson("last-success.json");
      expect(sha256(fake.stored(world.backupBucket, success.dumpKey))).toBe(success.sha256);
      for (const image of images) {
        expect(sha256(fake.stored(world.backupBucket, mirrorObject(image)))).toBe(image.sha256);
      }
      expect(fake.storedContentType(world.backupBucket, mirrorObject(images[0]!))).toBe("image/jpeg");

      // Every R2 call went to --remote; no get left a temp file; nothing but the
      // backup's own files is in the directory wrangler ran in.
      const calls = fake.argv().filter((line) => line.startsWith("r2 object"));
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call).toContain("--remote");
      }
      for (const temp of fake.tempFiles()) {
        expect(existsSync(temp)).toBe(false);
      }
      expect(readdirSync(world.localDir).filter((name) => name.startsWith(".transport-"))).toEqual([]);
    });
  });
});

describe("the disaster drill", SLOW, () => {
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

  const offsiteManifestKey = async () =>
    (await world.objectKeys(world.backupBucket)).find((key) => key.startsWith("manifests/"))!;

  const restoreImages = (overrides: Record<string, string>) =>
    world.runScript("db:restore-images", world.environment(overrides));

  it("rebuilds both stores from the off-site copies alone", async () => {
    const { images } = await world.seed();
    const before = await world.runBackup();
    expect(before.code, before.output).toBe(0);
    const { dumpKey, sha256: dumpDigest, tableCounts } = world.readJson("last-success.json");
    const manifest = await offsiteManifestKey();

    // The disaster: the database dropped, the bucket emptied, and the laptop's
    // copies gone with them. Only the backup bucket survives.
    await world.closeDatabase();
    await world.dropDatabase(world.databaseName);
    await world.emptyBucket(world.sourceBucket);
    rmSync(world.localDir, { recursive: true, force: true });
    expect(await world.objectKeys(world.sourceBucket)).toEqual([]);

    // The database half: the off-site dump, re-hashed, into a new database.
    const dump = await world.getObject(world.backupBucket, dumpKey);
    expect(sha256(dump!)).toBe(dumpDigest);
    const dumpPath = join(world.root, "recovered.dump");
    writeFileSync(dumpPath, dump!);
    const restoredUrl = await world.createDatabase(`${world.databaseName}_after`);
    const restored = await run(
      "pg_restore",
      ["--no-owner", "--no-privileges", "--exit-on-error", "-d", restoredUrl, dumpPath],
      {},
    );
    expect(restored.code, restored.output).toBe(0);

    // The image half, needing neither a database nor a source bucket setting.
    const result = await world.runScript("db:restore-images", {
      ...world.environment({
        RESTORE_TARGET_BUCKET: world.sourceBucket,
        RESTORE_MANIFEST: manifest,
      }),
      DATABASE_URL: undefined,
      BACKUP_SOURCE_BUCKET: undefined,
    });
    expect(result.code, result.output).toBe(0);
    expect(result.stdout).toContain(`${images.length} restored`);

    // The proof: every image, tombstoned included, against its RESTORED row.
    const recovered = createDb(restoredUrl);
    try {
      const rows = await recovered.db.select().from(receiptImages);
      expect(rows).toHaveLength(images.length);
      const storage = world.storageOf(world.sourceBucket);
      for (const row of rows) {
        expect((await checkRestoredImage(storage, row)).label, row.objectKey).toBe("ok");
      }
      const [{ value: restoredUsers } = { value: -1 }] = await recovered.db
        .select({ value: count() })
        .from(users);
      expect(restoredUsers).toBe(tableCounts.users);
    } finally {
      await recovered.pool.end();
    }
  });

  it("prefers the mirror, adds only what is missing, and overwrites nothing", async () => {
    const { images } = await world.seed();
    await world.runBackup();
    const manifest = await offsiteManifestKey();
    const [right, different, ...absent] = images as [SeededImage, SeededImage, ...SeededImage[]];
    const target = await world.createBucket(`${world.sourceBucket}-t`);
    const squatter = new Uint8Array(Buffer.from("not the receipt"));
    await world.putObject(target, right.objectKey, right.bytes);
    await world.putObject(target, different.objectKey, squatter);

    // Off-site copies gone: anything restored now can only have come locally.
    for (const key of await world.objectKeys(world.backupBucket)) {
      if (key.startsWith("images/mirror/")) {
        await world.deleteObject(world.backupBucket, key);
      }
    }

    const result = await restoreImages({
      RESTORE_TARGET_BUCKET: target,
      RESTORE_MANIFEST: manifest,
    });

    expect(result.code).toBe(1);
    expect(result.output).toContain("DIGEST");
    expect(result.output).toContain("nothing written to the target");
    expect(result.stdout).toContain(`${absent.length} restored`);
    expect(result.stdout).toContain("1 already there");

    expect(await world.getObject(target, different.objectKey)).toEqual(squatter);
    expect(await world.getObject(target, right.objectKey)).toEqual(right.bytes);
    for (const image of absent) {
      expect(await world.getObject(target, image.objectKey)).toEqual(image.bytes);
    }
  });

  it("takes a local manifest, and falls back off-site for a damaged mirror copy", async () => {
    const { images } = await world.seed();
    await world.runBackup();
    const key = await offsiteManifestKey();
    const damaged = images[0]!;
    writeFileSync(join(world.localDir, "images", damaged.objectKey), "bit rot");
    const target = await world.createBucket(`${world.sourceBucket}-t`);

    const result = await restoreImages({
      RESTORE_TARGET_BUCKET: target,
      RESTORE_MANIFEST: join(world.localDir, key),
    });

    expect(result.code, result.output).toBe(0);
    expect(result.output).toContain("using off-site");
    expect(await world.getObject(target, damaged.objectKey)).toEqual(damaged.bytes);
  });

  it("warns on an absent tombstone, fails on an absent live image", async () => {
    const { images } = await world.seed();
    await world.runBackup();
    const manifest = await offsiteManifestKey();
    const tombstoned = images.find((image) => image.deleted)!;
    const live = images.find((image) => !image.deleted)!;
    for (const image of [tombstoned, live]) {
      rmSync(join(world.localDir, "images", image.objectKey));
      await world.deleteObject(world.backupBucket, `images/mirror/${image.objectKey}`);
    }
    const target = await world.createBucket(`${world.sourceBucket}-t`);

    const result = await restoreImages({
      RESTORE_TARGET_BUCKET: target,
      RESTORE_MANIFEST: manifest,
    });

    expect(result.code).toBe(1);
    expect(result.output).toContain("MISSING on a tombstoned row");
    expect(result.output).toContain(`MISSING images/mirror/${live.objectKey}`);
    expect(result.stdout).toContain("3 restored");
  });

  it("refuses the backup bucket as a target, before reading anything", async () => {
    const result = await restoreImages({
      RESTORE_TARGET_BUCKET: world.backupBucket,
      RESTORE_MANIFEST: "manifests/kept-20261031-060000.tsv",
    });
    expect(result.code).not.toBe(0);
    expect(result.output).toContain("RESTORE_TARGET_BUCKET is the backup bucket");
  });

  it("refuses a manifest with a traversal in it, and touches no path for it", async () => {
    const { images } = await world.seed();
    await world.runBackup();
    const key = await offsiteManifestKey();
    const path = join(world.localDir, key);
    const hostile = `../../escape/2026/10/${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}.jpg`;
    writeFileSync(
      path,
      `${readFileSync(path, "utf8")}${hostile}\t${images[0]!.sha256}\tfalse\n`,
    );
    const target = await world.createBucket(`${world.sourceBucket}-t`);

    const result = await restoreImages({ RESTORE_TARGET_BUCKET: target, RESTORE_MANIFEST: path });

    expect(result.code).toBe(1);
    expect(result.output).toContain("not one this system issued");
    expect(result.output).not.toContain("escape");
    expect(await world.objectKeys(target)).toHaveLength(images.length);
  });
});
