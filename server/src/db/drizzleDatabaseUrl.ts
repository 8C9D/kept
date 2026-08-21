/**
 * Which database `drizzle-kit` is pointed at, lifted out of drizzle.config.ts
 * so the one case that must not default quietly is unit-testable.
 *
 * The localhost fallback stays: it is what lets a clean checkout run
 * `npm run db:generate` and `npm run db:migrate` against the docker-compose
 * database with no ceremony, the same argument as the entrypoint's MinIO
 * default. What it must not do is survive into production. Migrations there
 * run from inside the Fly machine (`fly ssh console -C "npm run db:migrate"`,
 * NODE_ENV=production from the Dockerfile), and a DATABASE_URL that failed to
 * reach that process would send drizzle-kit at a localhost Postgres that does
 * not exist on the machine. It fails - ECONNREFUSED, nothing corrupted - but
 * it names the wrong problem, pointing the operator at a database rather than
 * at the variable that never arrived.
 *
 * So the fallback is scoped to the environment it was written for, and
 * production gets the refusal shape src/index.ts already uses: stop with the
 * missing variable named, rather than proceed on a guess.
 */

/** Local dev database from docker-compose.yml; real URLs live in .env.local. */
export const LOCAL_DEV_DATABASE_URL = "postgres://kept:kept@localhost:5432/kept";

export function resolveDrizzleDatabaseUrl(
  env: Record<string, string | undefined>,
): string {
  const databaseUrl = env.DATABASE_URL;
  // Empty counts as absent, as it does in the entrypoint's REQUIRED_ENV check:
  // an exported-but-blank variable is a configuration mistake, not a value.
  if (databaseUrl !== undefined && databaseUrl !== "") {
    return databaseUrl;
  }

  if (env.NODE_ENV === "production") {
    // ⚠ Names no file. This is read once, inside a machine whose image carries
    // only package.json, tsconfig.json, drizzle.config.ts, drizzle/ and src/
    // (see the Dockerfile), so a citation of docs/ would point at a document
    // the reader cannot open - the mistake src/index.ts's storage refusal
    // documents having made.
    throw new Error(
      "Missing required environment variables: DATABASE_URL. drizzle-kit " +
        "falls back to the local docker-compose database when it is unset, " +
        "which under NODE_ENV=production would dial a Postgres that does not " +
        "exist on this machine and report a refused connection instead of the " +
        "missing variable. Set DATABASE_URL for this command; on Fly it is a " +
        "secret, so check `fly secrets list`.",
    );
  }

  return LOCAL_DEV_DATABASE_URL;
}
