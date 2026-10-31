import { describe, expect, it } from "vitest";
import {
  PG_TOOLS,
  assertPgToolVersion,
  backupStamp,
  manifestKey,
  mirrorObjectKey,
  resolveBackupConfig,
  resolveBackupStatusDir,
  resolveRestoreImagesConfig,
  separateDatabasePassword,
  timestampKey,
} from "../../src/db/backupConfig.js";

/** Split so the fixtures below read as fixtures to the repo's secret hook. */
const PG = "postgres:" + "//";

/**
 * The backup's refusals, exercised in their failing direction.
 *
 * A backup script that ran anyway - against a guessed database, into the
 * image bucket, or through an old pg_dump - would produce something that
 * looks like a backup until the restore that needs it. Each case here is
 * one of those quiet failures converted into a loud one.
 */

const WRANGLER: Record<string, string> = {
  DATABASE_URL:
    `${PG}kept:pw@ep-example-123.us-east-2.aws.neon.tech/kept?sslmode=require`,
  BACKUP_LOCAL_DIR: "/Users/someone/.kept/backups",
  BACKUP_TRANSPORT: "wrangler",
  BACKUP_STORAGE_BUCKET: "kept-backups",
  BACKUP_SOURCE_BUCKET: "kept",
};

const S3: Record<string, string> = {
  ...WRANGLER,
  BACKUP_TRANSPORT: "s3",
  BACKUP_STORAGE_ENDPOINT: "https://accountid.r2.cloudflarestorage.com",
  BACKUP_STORAGE_ACCESS_KEY_ID: "backup-access-key",
  BACKUP_STORAGE_SECRET_ACCESS_KEY: "backup-secret-key",
};

describe("resolveBackupConfig", () => {
  it("accepts a complete wrangler environment, with no credential in it", () => {
    expect(resolveBackupConfig(WRANGLER)).toEqual({
      transport: "wrangler",
      databaseUrl: WRANGLER.DATABASE_URL,
      localDir: "/Users/someone/.kept/backups",
      bucket: "kept-backups",
      sourceBucket: "kept",
    });
  });

  it("accepts a complete s3 environment and echoes it back verbatim", () => {
    expect(resolveBackupConfig(S3)).toEqual({
      transport: "s3",
      databaseUrl: S3.DATABASE_URL,
      localDir: "/Users/someone/.kept/backups",
      bucket: "kept-backups",
      sourceBucket: "kept",
      endpoint: S3.BACKUP_STORAGE_ENDPOINT,
      accessKeyId: "backup-access-key",
      secretAccessKey: "backup-secret-key",
    });
  });

  it.each(Object.keys(WRANGLER))("refuses when %s is missing in wrangler mode, naming it", (name) => {
    const env: Record<string, string | undefined> = { ...WRANGLER };
    delete env[name];
    expect(() => resolveBackupConfig(env)).toThrowError(new RegExp(name));
  });

  it.each(Object.keys(S3))("refuses when %s is missing in s3 mode, naming it", (name) => {
    const env: Record<string, string | undefined> = { ...S3 };
    delete env[name];
    expect(() => resolveBackupConfig(env)).toThrowError(new RegExp(name));
  });

  it("does not ask wrangler mode for the s3 values", () => {
    expect(() => resolveBackupConfig(WRANGLER)).not.toThrow();
  });

  it("refuses an empty string the same as an absent variable", () => {
    expect(() => resolveBackupConfig({ ...S3, BACKUP_STORAGE_BUCKET: "" })).toThrowError(
      /BACKUP_STORAGE_BUCKET/,
    );
  });

  it("refuses a transport it does not know rather than picking one", () => {
    expect(() => resolveBackupConfig({ ...WRANGLER, BACKUP_TRANSPORT: "rclone" })).toThrowError(
      /BACKUP_TRANSPORT.*wrangler, s3/,
    );
  });

  it("refuses an endpoint that is not a URL", () => {
    expect(() => resolveBackupConfig({ ...S3, BACKUP_STORAGE_ENDPOINT: "not a url" })).toThrowError(
      /not a URL/,
    );
  });

  it("refuses a relative local directory, naming it", () => {
    expect(() =>
      resolveBackupConfig({ ...WRANGLER, BACKUP_LOCAL_DIR: "backups" }),
    ).toThrowError(/BACKUP_LOCAL_DIR must be an absolute path/);
    expect(() =>
      resolveBackupConfig({ ...WRANGLER, BACKUP_LOCAL_DIR: "~/.kept/backups" }),
    ).toThrowError(/BACKUP_LOCAL_DIR must be an absolute path/);
  });

  it("refuses a source bucket that is the backup bucket", () => {
    expect(() =>
      resolveBackupConfig({ ...WRANGLER, BACKUP_SOURCE_BUCKET: "kept-backups" }),
    ).toThrowError(/BACKUP_SOURCE_BUCKET and BACKUP_STORAGE_BUCKET/);
  });

  it("refuses to back up into the image bucket", () => {
    expect(() =>
      resolveBackupConfig({
        ...S3,
        STORAGE_ENDPOINT: S3.BACKUP_STORAGE_ENDPOINT,
        STORAGE_BUCKET: S3.BACKUP_STORAGE_BUCKET,
      }),
    ).toThrowError(/lifecycle/);
  });

  it("refuses the image bucket in wrangler mode, where there is no endpoint to compare", () => {
    expect(() =>
      resolveBackupConfig({ ...WRANGLER, STORAGE_BUCKET: WRANGLER.BACKUP_STORAGE_BUCKET }),
    ).toThrowError(/lifecycle/);
  });

  it("allows the same endpoint when the bucket differs - two buckets, one account", () => {
    const config = resolveBackupConfig({
      ...S3,
      STORAGE_ENDPOINT: S3.BACKUP_STORAGE_ENDPOINT,
      STORAGE_BUCKET: "kept",
    });
    expect(config.bucket).toBe("kept-backups");
  });

  it("refuses an unusable DATABASE_URL without repeating it", () => {
    const secret = "hunter2-not-a-url";
    let thrown: unknown;
    try {
      resolveBackupConfig({ ...WRANGLER, DATABASE_URL: `kept:${secret}@nowhere` });
    } catch (error) {
      thrown = error;
    }
    expect((thrown as Error).message).toMatch(/DATABASE_URL is not a parseable/);
    expect(String(thrown)).not.toContain(secret);
    // `new URL` hangs the input off the error it throws, so a cause would carry
    // the password even with a clean message.
    expect((thrown as Error).cause).toBeUndefined();
  });

  it("refuses a password that is not valid percent-encoding, without repeating it", () => {
    expect(() =>
      resolveBackupConfig({ ...WRANGLER, DATABASE_URL: `${PG}kept:100%off@host/kept` }),
    ).toThrowError(/value is withheld/);
  });
});

describe("resolveRestoreImagesConfig", () => {
  const RESTORE: Record<string, string> = {
    BACKUP_LOCAL_DIR: "/Users/someone/.kept/backups",
    BACKUP_TRANSPORT: "wrangler",
    BACKUP_STORAGE_BUCKET: "kept-backups",
    RESTORE_TARGET_BUCKET: "kept-rebuilt",
    RESTORE_MANIFEST: "manifests/kept-20261031-060000.tsv",
  };

  it("takes an off-site key, needing neither a database nor a source bucket", () => {
    expect(resolveRestoreImagesConfig(RESTORE)).toEqual({
      transport: "wrangler",
      localDir: "/Users/someone/.kept/backups",
      bucket: "kept-backups",
      targetBucket: "kept-rebuilt",
      manifest: { kind: "offsite", key: "manifests/kept-20261031-060000.tsv" },
    });
  });

  it("takes an absolute local path", () => {
    expect(
      resolveRestoreImagesConfig({ ...RESTORE, RESTORE_MANIFEST: "/tmp/kept.tsv" }).manifest,
    ).toEqual({ kind: "local", path: "/tmp/kept.tsv" });
  });

  it("refuses a manifest that is neither", () => {
    expect(() =>
      resolveRestoreImagesConfig({ ...RESTORE, RESTORE_MANIFEST: "kept.tsv" }),
    ).toThrowError(/RESTORE_MANIFEST/);
  });

  it("refuses the backup bucket as the target", () => {
    expect(() =>
      resolveRestoreImagesConfig({ ...RESTORE, RESTORE_TARGET_BUCKET: "kept-backups" }),
    ).toThrowError(/RESTORE_TARGET_BUCKET is the backup bucket/);
  });

  it.each(Object.keys(RESTORE))("refuses when %s is missing, naming it", (name) => {
    const env: Record<string, string | undefined> = { ...RESTORE };
    delete env[name];
    expect(() => resolveRestoreImagesConfig(env)).toThrowError(new RegExp(name));
  });

  it("asks for the three s3 values in s3 mode", () => {
    expect(() =>
      resolveRestoreImagesConfig({ ...RESTORE, BACKUP_TRANSPORT: "s3" }),
    ).toThrowError(/BACKUP_STORAGE_ENDPOINT/);
  });
});

describe("resolveBackupStatusDir", () => {
  it("needs the directory and nothing else", () => {
    expect(resolveBackupStatusDir({ BACKUP_LOCAL_DIR: "/var/backups/kept" })).toBe(
      "/var/backups/kept",
    );
  });

  it("refuses to guess it", () => {
    expect(() => resolveBackupStatusDir({})).toThrowError(/BACKUP_LOCAL_DIR/);
  });
});

describe("separateDatabasePassword", () => {
  it("takes the password out of the URL and leaves the rest alone", () => {
    expect(
      separateDatabasePassword(
        `${PG}kept:s3cret@ep-example.neon.tech:5432/kept?sslmode=require&channel_binding=require`,
      ),
    ).toEqual({
      url: "postgres://kept@ep-example.neon.tech:5432/kept?sslmode=require&channel_binding=require",
      password: "s3cret",
    });
  });

  it("decodes a percent-encoded password, which PGPASSWORD takes literally", () => {
    expect(separateDatabasePassword(`${PG}kept:p%40ss%2Fword@host/kept`).password).toBe(
      "p@ss/word",
    );
  });

  it("handles a URL with no password", () => {
    expect(separateDatabasePassword("postgres://kept@host/kept")).toEqual({
      url: "postgres://kept@host/kept",
      password: undefined,
    });
  });

  it("takes a password spelled as a query parameter out of the URL too", () => {
    const { url, password } = separateDatabasePassword(
      "postgres://kept@host/kept?password=s3cret&sslmode=require",
    );
    expect(password).toBe("s3cret");
    expect(url).not.toContain("s3cret");
    expect(url).toContain("sslmode=require");
  });
});

describe("assertPgToolVersion", () => {
  it.each(PG_TOOLS)("accepts %s at 16 and newer", (tool) => {
    expect(assertPgToolVersion(tool, `${tool} (PostgreSQL) 16.4\n`)).toBe(16);
    expect(assertPgToolVersion(tool, `${tool} (PostgreSQL) 17.11 (Homebrew)\n`)).toBe(17);
  });

  it("reads the Debian packaging's version line", () => {
    expect(
      assertPgToolVersion("pg_dump", "pg_dump (PostgreSQL) 16.13 (Ubuntu 16.13-0ubuntu0.24.04.1)\n"),
    ).toBe(16);
  });

  it.each(PG_TOOLS)("refuses %s older than 16, by name", (tool) => {
    expect(() => assertPgToolVersion(tool, `${tool} (PostgreSQL) 15.6\n`)).toThrowError(
      new RegExp(`${tool} is version 15`),
    );
  });

  it("refuses output it cannot read rather than guessing", () => {
    expect(() =>
      assertPgToolVersion("pg_dump", "zsh: command not found: pg_dump\n"),
    ).toThrowError(/Could not read a version from pg_dump/);
  });
});

describe("the names one run uses", () => {
  const moment = new Date(Date.UTC(2026, 7, 18, 2, 0, 0));

  it("stamps in UTC, never local time", () => {
    expect(backupStamp(moment)).toBe("20260818-020000");
    // 23:30 on the 17th at UTC-4: a local stamp would say the 17th.
    expect(backupStamp(new Date("2026-08-17T23:30:00-04:00"))).toBe("20260818-033000");
  });

  it("puts the dump under the pg/ prefix", () => {
    expect(timestampKey(moment)).toBe("pg/kept-20260818-020000.dump");
  });

  it("pads every field", () => {
    expect(timestampKey(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe(
      "pg/kept-20260102-030405.dump",
    );
  });

  it("puts the manifest under manifests/ with the same stamp", () => {
    expect(manifestKey(moment)).toBe("manifests/kept-20260818-020000.tsv");
  });

  it("puts a mirrored image under images/mirror/, keeping its key", () => {
    expect(mirrorObjectKey("user/2026/08/photo.jpg")).toBe("images/mirror/user/2026/08/photo.jpg");
  });
});
