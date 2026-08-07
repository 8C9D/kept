import { createHash } from "node:crypto";
import { isNull } from "drizzle-orm";
import { createDb } from "./client.js";
import { exportJobs, receiptImages, receipts, users } from "./schema.js";
import {
  LOCAL_DEV_STORAGE_CONFIG,
  createS3ObjectStorage,
  resolveStorageConfig,
} from "../storage/s3ObjectStorage.js";

/**
 * Proves a restored database is the records, not a file that restored
 * without error.
 *
 * §10B: "an untested backup is an assumption, not a backup", and retention
 * is the one requirement whose failure cannot be undone. `pg_restore`
 * exiting 0 is an exit code, not evidence (CLAUDE.md), so this compares the
 * restored database against the source it was taken from and then follows
 * the restored image rows out into object storage:
 *
 *   1. row counts per table, source vs restored;
 *   2. every live receipt image's object key resolves in storage;
 *   3. the bytes behind each key re-hash to the digest the RESTORED row
 *      carries.
 *
 * Step 3 is the one that matters. A key that resolves proves an object is
 * there; only the digest proves it is the right object and that the row
 * pointing at it survived the round trip - the same check the wave-5 gate
 * used on device, applied to a backup.
 *
 * Read-only on both databases and on storage, so it is safe to point at
 * production. Usage:
 *
 *   SOURCE_DATABASE_URL=... RESTORED_DATABASE_URL=... npm run db:verify-restore
 *
 * Storage comes from STORAGE_* (the local MinIO default when unset), so the
 * drill runs locally today and identically against R2 after deployment.
 */

const TABLES = [
  { name: "users", table: users },
  { name: "receipts", table: receipts },
  { name: "receipt_images", table: receiptImages },
  { name: "export_jobs", table: exportJobs },
] as const;

async function main(): Promise<void> {
  const sourceUrl = required("SOURCE_DATABASE_URL");
  const restoredUrl = required("RESTORED_DATABASE_URL");
  if (sourceUrl === restoredUrl) {
    throw new Error(
      "SOURCE_DATABASE_URL and RESTORED_DATABASE_URL are the same database. " +
        "Comparing a database with itself would pass no matter what the " +
        "backup contained.",
    );
  }

  const source = createDb(sourceUrl);
  const restored = createDb(restoredUrl);
  const failures: string[] = [];

  try {
    console.log("Row counts (source -> restored):");
    for (const { name, table } of TABLES) {
      const sourceCount = (await source.db.select().from(table)).length;
      const restoredCount = (await restored.db.select().from(table)).length;
      const verdict = sourceCount === restoredCount ? "ok" : "MISMATCH";
      console.log(`  ${name.padEnd(15)} ${sourceCount} -> ${restoredCount}  ${verdict}`);
      if (sourceCount !== restoredCount) {
        failures.push(`${name}: ${sourceCount} rows in source, ${restoredCount} restored`);
      }
    }

    // Live rows only: a soft-deleted image's bytes are kept for retention,
    // but nothing guarantees an object still exists behind a tombstone.
    const images = await restored.db
      .select({
        objectKey: receiptImages.objectKey,
        sha256: receiptImages.sha256,
      })
      .from(receiptImages)
      .where(isNull(receiptImages.deletedAt));

    const storage = createS3ObjectStorage(
      resolveStorageConfig(process.env) ?? LOCAL_DEV_STORAGE_CONFIG,
    );

    console.log(`\nImage objects behind the ${images.length} live restored row(s):`);
    for (const image of images) {
      try {
        const bytes = await storage.download(image.objectKey);
        const digest = createHash("sha256").update(bytes).digest("hex");
        if (digest === image.sha256) {
          console.log(`  ok        ${image.objectKey}`);
        } else {
          console.log(`  DIGEST    ${image.objectKey}`);
          failures.push(
            `${image.objectKey}: stored bytes hash to ${digest}, row says ${image.sha256}`,
          );
        }
      } catch (error) {
        console.log(`  MISSING   ${image.objectKey}`);
        failures.push(`${image.objectKey}: ${describe(error)}`);
      }
    }

    if (images.length === 0) {
      // Not a pass. A restore verified against zero images has verified
      // nothing about the half of the record that lives outside Postgres.
      failures.push(
        "The restored database holds no live image rows, so this run proves " +
          "nothing about image recoverability.",
      );
    }
  } finally {
    await source.pool.end();
    await restored.pool.end();
  }

  if (failures.length > 0) {
    console.error(`\nRESTORE NOT VERIFIED - ${failures.length} problem(s):`);
    for (const failure of failures) {
      console.error(`  - ${failure}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log("\nRestore verified: row counts match and every live image re-hashes to its row.");
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
}

function describe(error: unknown): string {
  if (typeof error === "object" && error !== null && "name" in error) {
    return (error as { name: string }).name;
  }
  return String(error);
}

await main();
