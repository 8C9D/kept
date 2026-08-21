import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Every pool in `src/` is `createDb`'s, and this is the only thing that says so.
 *
 * N-1: five dev scripts (seed, claim, llmParseProbe, llmPromptReparse,
 * parseAccuracyReport) each built `new Pool({ connectionString })` by hand, so
 * none of them gained the pool error listener PR-1 added to `createDb` - the
 * one standing between a routine server-side close of an idle connection and
 * the process dying with a dump that once printed the password - nor PR-9(a)'s
 * `connectionTimeoutMillis`. Two fixes landed in `createDb` and five callers
 * silently kept their own pools.
 *
 * ⚠ This asserts ROUTING, not the two properties themselves, and the split is
 * deliberate rather than an omission. What the listener and the connect timeout
 * DO is pinned where they are implemented, against a real database, in
 * tests/integration/dbClient.test.ts - including the child-process test that is
 * the only honest witness to "the process did not die". Re-asserting them here
 * would be a second copy that passes for its own reasons. What nothing pinned
 * was the link: a script that constructs its own pool inherits neither fix, and
 * before this test that regression failed nothing at all.
 *
 * Source text rather than runtime behaviour, because the defect IS a
 * construction site. Each of these scripts builds its pool at module top level
 * and then immediately does its work - seeding deletes three tables - so there
 * is no way to import one and inspect its pool without running it.
 *
 * Scoped to the whole of `src/` rather than to the five files named above, so
 * that the sixth script written next year is covered by something other than
 * whoever reviews it. Tests keep their own pools (helpers/globalSetup.ts builds
 * one against an admin URL to create the test database, before any app code
 * exists to route through) and are out of scope here.
 */

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));

// The one legitimate construction site: the factory every other caller uses.
const POOL_FACTORY = join(SRC_DIR, "db", "client.ts");

function typescriptFilesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name));
}

describe("database pool construction", () => {
  it("happens only in createDb, so every caller inherits its error listener and connect timeout", () => {
    const files = typescriptFilesUnder(SRC_DIR);
    // A scan that found nothing to scan would pass while proving nothing.
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain(POOL_FACTORY);

    const offenders = files
      .filter((file) => file !== POOL_FACTORY)
      .filter((file) => /new Pool\s*\(/.test(readFileSync(file, "utf8")))
      .map((file) => relative(SRC_DIR, file).split(sep).join("/"))
      .sort();

    expect(offenders).toEqual([]);
  });

  it("is reachable from the scripts that used to build their own pools", () => {
    // The other half of the same property: "no `new Pool`" is also satisfied by
    // a script that opens no database at all, so this names the five files N-1
    // found and asserts they go through the factory rather than merely not
    // going around it.
    const routed = [
      "db/seed.ts",
      "db/claim.ts",
      "db/llmParseProbe.ts",
      "db/llmPromptReparse.ts",
      "db/parseAccuracyReport.ts",
    ];
    for (const file of routed) {
      const source = readFileSync(join(SRC_DIR, file), "utf8");
      expect(source, file).toMatch(/createDb\s*\(/);
    }
  });
});
