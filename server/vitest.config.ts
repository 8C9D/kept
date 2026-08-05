import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // Integration tests share one Postgres database; running files
    // sequentially keeps their truncate-then-act cycles from interleaving.
    fileParallelism: false,
  },
});
