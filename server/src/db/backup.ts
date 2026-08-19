import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { assertPgDumpVersion, resolveBackupConfig, timestampKey } from "./backupConfig.js";

/**
 * The scheduled dump Runbook §4 says retention actually rests on: a
 * `pg_dump -Fc` of DATABASE_URL, uploaded to a bucket that is not Neon and
 * not this laptop alone.
 *
 * The refusals live in `backupConfig.ts` (unit-tested): every variable
 * required with no defaults, the backup bucket never the image bucket,
 * pg_dump never older than the database.
 *
 * Usage (see Runbook §4 for scheduling):
 *
 *   DATABASE_URL=... \
 *   BACKUP_STORAGE_ENDPOINT=... BACKUP_STORAGE_BUCKET=kept-backups \
 *   BACKUP_STORAGE_ACCESS_KEY_ID=... BACKUP_STORAGE_SECRET_ACCESS_KEY=... \
 *   npm run db:backup
 *
 * The upload is verified by re-reading the object's ContentLength against
 * the local file, and the file's sha256 is printed so a restore drill can
 * check it is holding the same bytes. The client builds its own S3Client
 * rather than widening `s3ObjectStorage`'s surface, the same deliberate
 * trade the key-normalization probe recorded (wave-6 §6).
 */

async function main(): Promise<void> {
  const config = resolveBackupConfig(process.env);

  assertPgDumpVersion(execFileSync("pg_dump", ["--version"], { encoding: "utf8" }));

  const workDir = mkdtempSync(join(tmpdir(), "kept-backup-"));
  const dumpPath = join(workDir, "kept.dump");
  try {
    execFileSync("pg_dump", [config.databaseUrl, "-Fc", "-f", dumpPath], {
      stdio: ["ignore", "inherit", "inherit"],
    });

    const bytes = readFileSync(dumpPath);
    if (bytes.length === 0) {
      throw new Error("pg_dump wrote an empty file; refusing to upload it as a backup.");
    }
    const digest = createHash("sha256").update(bytes).digest("hex");
    const key = timestampKey(new Date());

    const client = new S3Client({
      endpoint: config.endpoint,
      region: "auto",
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: true,
    });
    await client.send(
      new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: bytes,
        ContentType: "application/octet-stream",
      }),
    );

    const head = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
    if (head.ContentLength !== bytes.length) {
      throw new Error(
        `Upload verification failed: local dump is ${bytes.length} bytes, ` +
          `stored object reports ${head.ContentLength}.`,
      );
    }

    console.log(`Backup uploaded: ${config.bucket}/${key}`);
    console.log(`  ${bytes.length} bytes, sha256 ${digest}`);
    console.log(
      "This is an untested backup until a restore drill has run against it (Runbook §4).",
    );
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

await main();
