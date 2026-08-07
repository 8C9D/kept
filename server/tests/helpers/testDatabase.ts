import { LOCAL_DEV_DATABASE_URL } from "../../src/db/client.js";
import { databaseIdentity } from "../../src/db/databaseUrl.js";

/**
 * The integration-test database: a distinct database name in the same
 * docker-compose container as the dev database. Running `npm test` must
 * never touch the dev data - a device-testing wave loses its signed-in
 * user and claimed receipts every time it does (wave-4 kickoff §1).
 */
export const LOCAL_TEST_DATABASE_URL =
  "postgres://kept:kept@localhost:5432/kept_test";

export function resolveTestDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const url = env.TEST_DATABASE_URL;
  return url === undefined || url === "" ? LOCAL_TEST_DATABASE_URL : url;
}

export function resolveDevDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const url = env.DATABASE_URL;
  return url === undefined || url === "" ? LOCAL_DEV_DATABASE_URL : url;
}

/**
 * Refuses to proceed when the test URL and the dev URL resolve to the same
 * database. Compares host, port, and database name - not the raw strings -
 * so differing credentials or query parameters cannot disguise the same
 * database as a different one.
 */
export function assertSeparateTestDatabase(
  testDatabaseUrl: string,
  devDatabaseUrl: string,
): void {
  const test = databaseIdentity(testDatabaseUrl, "TEST_DATABASE_URL");
  const dev = databaseIdentity(devDatabaseUrl, "DATABASE_URL");
  if (
    test.host === dev.host &&
    test.port === dev.port &&
    test.database === dev.database
  ) {
    throw new Error(
      `Refusing to run tests: TEST_DATABASE_URL resolves to the same ` +
        `database as DATABASE_URL (${dev.host}:${dev.port}/${dev.database}). ` +
        `Integration tests empty every table, which would destroy the dev ` +
        `data. Point TEST_DATABASE_URL at a separate database name.`,
    );
  }
}

