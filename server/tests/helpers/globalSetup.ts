import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import {
  assertSeparateTestDatabase,
  resolveDevDatabaseUrl,
  resolveTestDatabaseUrl,
} from "./testDatabase.js";

/**
 * Runs once before the suite: refuse a config that would aim the tests at
 * the dev database, then create the test database if it is missing and
 * bring it to the current migration state. After this, every test file
 * connects to a database that exists, is migrated, and is disposable.
 */
export default async function globalSetup(): Promise<void> {
  const testUrl = resolveTestDatabaseUrl(process.env);
  const devUrl = resolveDevDatabaseUrl(process.env);
  assertSeparateTestDatabase(testUrl, devUrl);

  await createDatabaseIfMissing(testUrl);

  const pool = new Pool({ connectionString: testUrl });
  try {
    await migrate(drizzle(pool), { migrationsFolder: "drizzle" });
  } finally {
    await pool.end();
  }
}

async function createDatabaseIfMissing(testUrl: string): Promise<void> {
  const database = new URL(testUrl).pathname.replace(/^\//, "");

  // CREATE DATABASE cannot run inside the target database, so connect to
  // the server's maintenance database (`postgres`, present in the official
  // image) with the same credentials.
  const adminUrl = new URL(testUrl);
  adminUrl.pathname = "/postgres";
  const admin = new Pool({ connectionString: adminUrl.toString() });
  try {
    const existing = await admin.query(
      "SELECT 1 FROM pg_database WHERE datname = $1",
      [database],
    );
    if (existing.rowCount === 0) {
      // Identifier, not a value, so it cannot be parameterized; quote it.
      await admin.query(`CREATE DATABASE "${database.replaceAll('"', '""')}"`);
    }
  } finally {
    await admin.end();
  }
}
