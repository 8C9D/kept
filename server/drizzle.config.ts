import { defineConfig } from "drizzle-kit";
import { resolveDrizzleDatabaseUrl } from "./src/db/drizzleDatabaseUrl.js";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    // Local dev database from docker-compose.yml; real URLs live in .env.local.
    // Production refuses the fallback rather than dialling a localhost that is
    // not there - see src/db/drizzleDatabaseUrl.ts.
    url: resolveDrizzleDatabaseUrl(process.env),
  },
});
