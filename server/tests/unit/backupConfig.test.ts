import { describe, expect, it } from "vitest";
import {
  assertPgDumpVersion,
  resolveBackupConfig,
  timestampKey,
} from "../../src/db/backupConfig.js";

/**
 * The backup's refusals, exercised in their failing direction.
 *
 * A backup script that ran anyway - against a guessed database, into the
 * image bucket, or through an old pg_dump - would produce something that
 * looks like a backup until the restore that needs it. Each case here is
 * one of those quiet failures converted into a loud one.
 */

const COMPLETE: Record<string, string> = {
  DATABASE_URL:
    "postgres://kept:pw@ep-example-123.us-east-2.aws.neon.tech/kept?sslmode=require",
  BACKUP_STORAGE_ENDPOINT: "https://accountid.r2.cloudflarestorage.com",
  BACKUP_STORAGE_BUCKET: "kept-backups",
  BACKUP_STORAGE_ACCESS_KEY_ID: "backup-access-key",
  BACKUP_STORAGE_SECRET_ACCESS_KEY: "backup-secret-key",
};

describe("resolveBackupConfig", () => {
  it("accepts a complete environment and echoes it back verbatim", () => {
    const config = resolveBackupConfig(COMPLETE);
    expect(config).toEqual({
      databaseUrl: COMPLETE.DATABASE_URL,
      endpoint: COMPLETE.BACKUP_STORAGE_ENDPOINT,
      bucket: "kept-backups",
      accessKeyId: "backup-access-key",
      secretAccessKey: "backup-secret-key",
    });
  });

  it.each(Object.keys(COMPLETE))("refuses when %s is missing, naming it", (name) => {
    const env: Record<string, string | undefined> = { ...COMPLETE };
    delete env[name];
    expect(() => resolveBackupConfig(env)).toThrowError(new RegExp(name));
  });

  it("refuses an empty string the same as an absent variable", () => {
    expect(() => resolveBackupConfig({ ...COMPLETE, BACKUP_STORAGE_BUCKET: "" })).toThrowError(
      /BACKUP_STORAGE_BUCKET/,
    );
  });

  it("refuses an endpoint that is not a URL", () => {
    expect(() =>
      resolveBackupConfig({ ...COMPLETE, BACKUP_STORAGE_ENDPOINT: "not a url" }),
    ).toThrowError(/not a URL/);
  });

  it("refuses to back up into the image bucket", () => {
    expect(() =>
      resolveBackupConfig({
        ...COMPLETE,
        STORAGE_ENDPOINT: COMPLETE.BACKUP_STORAGE_ENDPOINT,
        STORAGE_BUCKET: COMPLETE.BACKUP_STORAGE_BUCKET,
      }),
    ).toThrowError(/lifecycle/);
  });

  it("allows the same endpoint when the bucket differs - two buckets, one account", () => {
    const config = resolveBackupConfig({
      ...COMPLETE,
      STORAGE_ENDPOINT: COMPLETE.BACKUP_STORAGE_ENDPOINT,
      STORAGE_BUCKET: "kept",
    });
    expect(config.bucket).toBe("kept-backups");
  });
});

describe("assertPgDumpVersion", () => {
  it("accepts 16 and newer", () => {
    expect(assertPgDumpVersion("pg_dump (PostgreSQL) 16.4\n")).toBe(16);
    expect(assertPgDumpVersion("pg_dump (PostgreSQL) 17.0\n")).toBe(17);
  });

  it("refuses older than 16, naming the container alternative", () => {
    expect(() => assertPgDumpVersion("pg_dump (PostgreSQL) 15.6\n")).toThrowError(/postgres:16/);
  });

  it("refuses output it cannot read rather than guessing", () => {
    expect(() => assertPgDumpVersion("zsh: command not found: pg_dump\n")).toThrowError(
      /Could not read a version/,
    );
  });
});

describe("timestampKey", () => {
  it("stamps in UTC under the pg/ prefix", () => {
    expect(timestampKey(new Date(Date.UTC(2026, 7, 18, 2, 0, 0)))).toBe(
      "pg/kept-20260818-020000.dump",
    );
  });
});
