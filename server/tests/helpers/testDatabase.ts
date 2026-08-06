import { LOCAL_DEV_DATABASE_URL } from "../../src/db/client.js";

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

function databaseIdentity(
  url: string,
  label: string,
): { host: string; port: string; database: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new Error(`${label} is not a parseable URL: ${url}`, {
      cause: error,
    });
  }
  return {
    host: normalizeHost(parsed.hostname),
    // Postgres URLs may omit the port; both sides then default alike.
    port: parsed.port === "" ? "5432" : parsed.port,
    database: parsed.pathname.replace(/^\//, ""),
  };
}

/**
 * The loopback spellings all reach the same local Postgres; comparing them
 * literally would let "127.0.0.1" slip past a guard written as
 * "localhost". General DNS aliases stay unresolved - this guard protects
 * the local dev database, not every topology.
 */
function normalizeHost(host: string): string {
  const loopbackAliases = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
  return loopbackAliases.has(host.toLowerCase()) ? "localhost" : host.toLowerCase();
}
