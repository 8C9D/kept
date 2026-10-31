import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DeleteBucketCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool } from "pg";
import { createDb } from "../../src/db/client.js";
import {
  exportJobs,
  receiptFieldOptions,
  receiptImages,
  receipts,
  userEvents,
  users,
} from "../../src/db/schema.js";
import { ObjectNotFoundError } from "../../src/storage/objectStorage.js";
import {
  receiptImageObjectKey,
  type UploadContentType,
} from "../../src/storage/objectKeys.js";
import {
  LOCAL_DEV_STORAGE_CONFIG,
  createBucketIfMissing,
  createS3ObjectStorage,
  type S3StorageConfig,
} from "../../src/storage/s3ObjectStorage.js";
import { resolveTestDatabaseUrl } from "./testDatabase.js";

/**
 * A disposable world for the backup job: one real database, two real buckets
 * and a local directory, all of them private to one test.
 *
 * The database is its own, created beside the suite's test database on the same
 * server with the same credentials, rather than the suite's shared one, because
 * the disaster drill has to be able to destroy it. A drill that stopped short of
 * dropping the database would not be a drill, and one that dropped the shared
 * test database would break every test file that ran after it.
 *
 * The job itself is always the real thing, spawned the way an operator runs it:
 * `npm run db:backup`, configured by environment, with real pg_dump, a real
 * throwaway cluster and real MinIO. Nothing here reaches inside it.
 */

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

export const POSTGRES_TOOLS = ["pg_dump", "pg_restore", "initdb", "pg_ctl", "psql"];

/**
 * ⚠ Throws rather than skips. A backup test that skipped itself on a machine
 * without the binaries would read as green on exactly the machine that cannot
 * run the backup, and that is how a job comes to fail unnoticed.
 */
export function assertPostgresBinaries(): void {
  const missing = POSTGRES_TOOLS.filter((tool) => {
    const probe = spawnSync(tool, ["--version"], { encoding: "utf8" });
    return probe.error !== undefined || probe.status !== 0;
  });
  if (missing.length > 0) {
    throw new Error(
      `The backup tests need PostgreSQL 16+ binaries on PATH and could not run: ` +
        `${missing.join(", ")}. On macOS: export PATH=/opt/homebrew/opt/postgresql@17/bin:$PATH. ` +
        "In CI: .github/workflows/server.yml adds /usr/lib/postgresql/16/bin. " +
        "These tests fail rather than skip, on purpose.",
    );
  }
}

export interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout and stderr together, for "this must appear nowhere". */
  output: string;
}

export interface SeededImage {
  id: string;
  userId: string;
  receiptId: string;
  objectKey: string;
  sha256: string;
  bytes: Uint8Array;
  deleted: boolean;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export type BackupWorld = Awaited<ReturnType<typeof createBackupWorld>>;

export async function createBackupWorld() {
  const suffix = randomBytes(5).toString("hex");
  const root = mkdtempSync(join(tmpdir(), "kept-backup-world-"));
  const localDir = join(root, "local");
  // The job's TMPDIR, so that "the throwaway cluster is gone" can be asserted of
  // one directory instead of a machine-wide temp folder other things use.
  const jobTmp = join(root, "tmp");
  mkdirSync(jobTmp, { recursive: true });

  const sourceBucket = `kept-bkp-src-${suffix}`;
  const backupBucket = `kept-bkp-dst-${suffix}`;
  const buckets = [sourceBucket, backupBucket];

  const baseUrl = new URL(resolveTestDatabaseUrl(process.env));
  const databaseName = `${baseUrl.pathname.replace(/^\//, "")}_bkp_${suffix}`;
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = "/postgres";
  const urlOf = (database: string) => {
    const url = new URL(baseUrl);
    url.pathname = `/${database}`;
    return url.toString();
  };
  const sourceUrl = urlOf(databaseName);
  const scratchDatabases = new Set<string>();

  const admin = new Pool({ connectionString: adminUrl.toString() });
  const createDatabase = async (name: string) => {
    await admin.query(`CREATE DATABASE "${name}"`);
    scratchDatabases.add(name);
    return urlOf(name);
  };
  const dropDatabase = async (name: string) => {
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    scratchDatabases.delete(name);
  };

  await createDatabase(databaseName);
  const migrationPool = new Pool({ connectionString: sourceUrl });
  try {
    await migrate(drizzle(migrationPool), { migrationsFolder: join(SERVER_DIR, "drizzle") });
  } finally {
    await migrationPool.end();
  }

  let database: ReturnType<typeof createDb> | undefined = createDb(sourceUrl);
  const db = () => {
    if (database === undefined) {
      throw new Error("The source database was closed by this test");
    }
    return database.db;
  };

  const storageOf = (bucket: string) =>
    createS3ObjectStorage({ ...LOCAL_DEV_STORAGE_CONFIG, bucket });
  const s3Config = (bucket: string): S3StorageConfig => ({ ...LOCAL_DEV_STORAGE_CONFIG, bucket });
  const client = new S3Client({
    endpoint: LOCAL_DEV_STORAGE_CONFIG.endpoint,
    region: LOCAL_DEV_STORAGE_CONFIG.region,
    credentials: {
      accessKeyId: LOCAL_DEV_STORAGE_CONFIG.accessKeyId,
      secretAccessKey: LOCAL_DEV_STORAGE_CONFIG.secretAccessKey,
    },
    forcePathStyle: true,
  });

  for (const bucket of buckets) {
    await createBucketIfMissing(s3Config(bucket));
  }

  const createBucket = async (name: string) => {
    await createBucketIfMissing(s3Config(name));
    buckets.push(name);
    return name;
  };

  const objectKeys = async (bucket: string): Promise<string[]> => {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const page = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
      );
      keys.push(...(page.Contents ?? []).map((item) => item.Key as string));
      token = page.NextContinuationToken;
    } while (token !== undefined);
    return keys.sort();
  };

  const deleteObject = (bucket: string, key: string) =>
    client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));

  const emptyBucket = async (bucket: string) => {
    for (const key of await objectKeys(bucket)) {
      await deleteObject(bucket, key);
    }
  };

  const putObject = (bucket: string, key: string, bytes: Uint8Array) =>
    storageOf(bucket).upload(key, bytes, "application/octet-stream");

  /** The object's bytes, or undefined when storage says it is not there. */
  const getObject = async (bucket: string, key: string): Promise<Uint8Array | undefined> => {
    try {
      return await storageOf(bucket).download(key);
    } catch (error) {
      if (error instanceof ObjectNotFoundError) {
        return undefined;
      }
      throw error;
    }
  };

  /** What an operator would export, with nothing inherited that could steer it. */
  const environment = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of Object.keys(env)) {
      if (/^(BACKUP_|STORAGE_|RESTORE_)/.test(name) || name === "DATABASE_URL") {
        delete env[name];
      }
    }
    return {
      ...env,
      TMPDIR: jobTmp,
      DATABASE_URL: sourceUrl,
      BACKUP_LOCAL_DIR: localDir,
      BACKUP_TRANSPORT: "s3",
      BACKUP_SOURCE_BUCKET: sourceBucket,
      BACKUP_STORAGE_BUCKET: backupBucket,
      BACKUP_STORAGE_ENDPOINT: LOCAL_DEV_STORAGE_CONFIG.endpoint,
      BACKUP_STORAGE_ACCESS_KEY_ID: LOCAL_DEV_STORAGE_CONFIG.accessKeyId,
      BACKUP_STORAGE_SECRET_ACCESS_KEY: LOCAL_DEV_STORAGE_CONFIG.secretAccessKey,
      ...overrides,
    };
  };

  /**
   * The environment launchd gives a job: a HOME and a PATH, and no locale. The
   * job's config and the test's TMPDIR are all that is added back.
   */
  const launchdEnvironment = (): NodeJS.ProcessEnv =>
    Object.fromEntries(
      Object.entries(environment()).filter(
        ([name]) =>
          name === "HOME" ||
          name === "PATH" ||
          name === "TMPDIR" ||
          name === "DATABASE_URL" ||
          name.startsWith("BACKUP_"),
      ),
    );

  const runScript = (script: string, env: NodeJS.ProcessEnv): Promise<CommandResult> =>
    run("npm", ["run", script], { cwd: SERVER_DIR, env });

  const runBackup = (overrides: Record<string, string> = {}) =>
    runScript("db:backup", environment(overrides));

  /**
   * The job with its clock moved, by `offsetMs` from now. Older runs are moved
   * into the past rather than a later run into the future, so that the run whose
   * behaviour a test is really about can be plain `runBackup`: the operator's
   * entrypoint, with nothing in it that knows it is being tested. There is no
   * environment variable in the job for this and there must not be one: a clock a
   * stray line in backup.env could move is a clock that could trigger a prune.
   * See tests/helpers/backupAtClock.ts.
   */
  const runBackupAt = (offsetMs: number, overrides: Record<string, string> = {}) =>
    run(process.execPath, ["--import", "tsx", "tests/helpers/backupAtClock.ts"], {
      cwd: SERVER_DIR,
      env: { ...environment(overrides), BACKUP_TEST_CLOCK_OFFSET_MS: String(offsetMs) },
    });

  const seedUser = async (name: string) => {
    const [user] = await db()
      .insert(users)
      .values({ appleSub: `${name}-${suffix}-${randomUUID()}` })
      .returning();
    return user!;
  };

  /**
   * A receipt with `pages` images. `upload` decides what the source bucket
   * holds: the right bytes, the wrong bytes, or nothing at all.
   */
  const addReceipt = async (options: {
    userId: string;
    pages?: number;
    deleted?: boolean;
    contentType?: UploadContentType;
    upload?: "good" | "corrupt" | "none";
  }): Promise<SeededImage[]> => {
    const capturedAt = new Date(Date.UTC(2026, 9, 15, 12));
    const deletedAt = options.deleted === true ? new Date() : null;
    const [receipt] = await db()
      .insert(receipts)
      .values({
        userId: options.userId,
        purchasedAt: "2026-10-15",
        capturedAt,
        status: "confirmed",
        totalCents: 1234,
        deletedAt,
      })
      .returning();

    const images: SeededImage[] = [];
    for (let page = 1; page <= (options.pages ?? 1); page += 1) {
      const contentType = options.contentType ?? "image/jpeg";
      const header = contentType === "application/pdf" ? "%PDF-1.7" : "\xff\xd8\xff\xe0";
      const bytes = new Uint8Array(
        Buffer.concat([Buffer.from(header, "latin1"), randomBytes(2048)]),
      );
      const objectKey = receiptImageObjectKey(options.userId, capturedAt, randomUUID(), contentType);
      const digest = sha256(bytes);
      const [row] = await db()
        .insert(receiptImages)
        .values({
          receiptId: receipt!.id,
          userId: options.userId,
          page,
          objectKey,
          sha256: digest,
          deletedAt,
        })
        .returning();

      const upload = options.upload ?? "good";
      if (upload !== "none") {
        await putObject(
          sourceBucket,
          objectKey,
          upload === "good" ? bytes : new Uint8Array(randomBytes(2048)),
        );
      }
      images.push({
        id: row!.id,
        userId: options.userId,
        receiptId: receipt!.id,
        objectKey,
        sha256: digest,
        bytes,
        deleted: deletedAt !== null,
      });
    }
    return images;
  };

  /**
   * Two users, a two-page receipt, a PDF, a tombstoned receipt, and a row in
   * every other table: 2 users, 4 receipts, 5 images (4 live, 1 tombstoned).
   */
  const seed = async () => {
    const alice = await seedUser("alice");
    const bob = await seedUser("bob");
    const images = [
      ...(await addReceipt({ userId: alice.id, pages: 2 })),
      ...(await addReceipt({ userId: alice.id, contentType: "application/pdf" })),
      ...(await addReceipt({ userId: alice.id, deleted: true })),
      ...(await addReceipt({ userId: bob.id })),
    ];
    await db().insert(receiptFieldOptions).values({
      userId: alice.id,
      field: "vendor",
      value: "Option vendor",
      lastUsedAt: new Date(),
    });
    await db().insert(userEvents).values({
      userId: alice.id,
      occurredAt: new Date(),
      client: "web",
      action: "confirm_saved",
    });
    await db().insert(exportJobs).values({
      userId: bob.id,
      status: "complete",
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31",
    });
    return { alice, bob, images };
  };

  /**
   * What `DELETE /api/me` leaves behind: the rows gone, children first, and the
   * user's objects gone from the source bucket. Only the backup still has them.
   */
  const deleteAccount = async (userId: string) => {
    await db().delete(receiptImages).where(eq(receiptImages.userId, userId));
    await db().delete(receipts).where(eq(receipts.userId, userId));
    await db().delete(receiptFieldOptions).where(eq(receiptFieldOptions.userId, userId));
    await db().delete(exportJobs).where(eq(exportJobs.userId, userId));
    await db().delete(userEvents).where(eq(userEvents.userId, userId));
    await db().delete(users).where(eq(users.id, userId));
    for (const key of await objectKeys(sourceBucket)) {
      if (key.startsWith(`${userId}/`)) {
        await deleteObject(sourceBucket, key);
      }
    }
  };

  /** Directories left in the job's TMPDIR, plus any process still using it. */
  const leftovers = () => ({
    clusters: readdirSync(jobTmp).filter((name) => name.startsWith("kept-backup-cluster-")),
    processes: spawnSync("pgrep", ["-f", jobTmp], { encoding: "utf8" }).stdout.trim(),
  });

  /** Puts executables ahead of the real tools on PATH, for the shim tests. */
  const shimDir = join(root, "shims");
  const shim = (name: string, script: string) => {
    mkdirSync(shimDir, { recursive: true });
    const path = join(shimDir, name);
    writeFileSync(path, script, { mode: 0o755 });
    return path;
  };
  const pathWithShims = () => `${shimDir}:${process.env.PATH}`;

  const readJson = (name: string) => JSON.parse(readFileSync(join(localDir, name), "utf8"));

  /** Releases the job's source connection, so the database can be dropped. */
  const closeDatabase = async () => {
    await database?.pool.end();
    database = undefined;
  };

  const close = async () => {
    await closeDatabase();
    for (const name of [...scratchDatabases]) {
      await dropDatabase(name);
    }
    await admin.end();
    for (const bucket of buckets) {
      await emptyBucket(bucket);
      await client.send(new DeleteBucketCommand({ Bucket: bucket }));
    }
    client.destroy();
    rmSync(root, { recursive: true, force: true });
  };

  return {
    root,
    localDir,
    jobTmp,
    sourceUrl,
    sourceBucket,
    backupBucket,
    databaseName,
    urlOf,
    db,
    seed,
    seedUser,
    addReceipt,
    objectKeys,
    getObject,
    putObject,
    deleteObject,
    emptyBucket,
    createBucket,
    createDatabase,
    dropDatabase,
    closeDatabase,
    environment,
    launchdEnvironment,
    runBackup,
    runBackupAt,
    runScript,
    deleteAccount,
    leftovers,
    shim,
    pathWithShims,
    readJson,
    storageOf,
    close,
  };
}

export function run(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv },
): Promise<CommandResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => {
      resolvePromise({ code, stdout, stderr, output: `${stdout}\n${stderr}` });
    });
  });
}

export { SERVER_DIR };
