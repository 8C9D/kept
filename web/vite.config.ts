/// <reference types="vitest/config" />
import { execSync } from "node:child_process";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The dev server's origin is the one the API's dev-default CORS grant
// names (server/src/index.ts); pinning the port keeps the pair honest -
// Vite would otherwise silently move to 5174 when 5173 is taken, and every
// API call would fail with a CORS error that looks like a server bug.

/**
 * `appVersion` for POST /api/events (2026-08-28 telemetry): this client has
 * no version string today - no App Store build number, no package.json
 * bump on release - so the git short SHA is the one build-time value that
 * is both honest (it names the exact code that produced an event) and free
 * (no new tooling, no manual bump to forget). Falls back to a build-date
 * stamp rather than a fabricated "1.0.0" if `git` is unavailable at build
 * time (a stripped-down build image with no `.git`) - still truthful about
 * what it is, just coarser. Baked in via `define`, so it costs nothing at
 * runtime: every reference below is replaced with a string literal at
 * build time, same mechanism as `import.meta.env.DEV`.
 */
function appVersion(): string {
  try {
    return execSync("git rev-parse --short HEAD", {
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(appVersion()),
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
