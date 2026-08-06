import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Integration tests share one Postgres database; running files
    // sequentially keeps their truncate-then-act cycles from interleaving.
    fileParallelism: false,
    // Refuses to aim at the dev database, then creates and migrates the
    // separate test database (wave-4 kickoff §1).
    globalSetup: ["tests/helpers/globalSetup.ts"],
  },
});
