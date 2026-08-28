/// <reference types="vite/client" />

/**
 * Replaced with a string literal at build time by vite.config.ts's `define`
 * (git short SHA, or a build-date fallback) - src/events.ts's `appVersion`
 * for POST /api/events. Never read from `process.env` or fetched at
 * runtime: the whole point is that it costs nothing and cannot drift from
 * the code that shipped it.
 */
declare const __APP_VERSION__: string;

/**
 * The minimal slice of `node:child_process`'s types vite.config.ts needs
 * for that same `appVersion`, declared locally rather than pulling in
 * `@types/node` as a devDependency - this client's "no new dependencies"
 * rule (CLAUDE.md) is stated for the runtime bundle, but a build-config-
 * only package is still one more thing to keep patched and version-matched
 * for two lines of typing, and Node supplies the real implementation at
 * build time regardless of what TypeScript knows about it here. Lives in
 * this global-scope declaration file, not vite.config.ts itself, because a
 * module-scoped file (one with its own imports) treats `declare module` as
 * an augmentation of an existing module rather than a fresh one.
 */
declare module "node:child_process" {
  export function execSync(
    command: string,
    options?: { stdio?: unknown },
  ): { toString(): string };
}
