import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema.js";

/** The docker-compose dev database; seed and tests default to it. */
export const LOCAL_DEV_DATABASE_URL =
  "postgres://kept:kept@localhost:5432/kept";

export function createDb(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export type Db = ReturnType<typeof createDb>["db"];
