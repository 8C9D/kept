import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dbCredentials: {
    // Local dev database from docker-compose.yml; real URLs live in .env.local.
    url: process.env.DATABASE_URL ?? "postgres://kept:kept@localhost:5432/kept",
  },
});
