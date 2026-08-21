import { describe, expect, it } from "vitest";
import {
  LOCAL_DEV_DATABASE_URL,
  resolveDrizzleDatabaseUrl,
} from "../../src/db/drizzleDatabaseUrl.js";

/**
 * Three branches, and the middle one is the whole point.
 *
 * `fly ssh console -C "npm run db:migrate"` runs with NODE_ENV=production; if
 * DATABASE_URL is not in that environment the old config handed drizzle-kit a
 * localhost URL and the operator got ECONNREFUSED against a database that was
 * never the target. Loud, but about the wrong thing.
 */

const NEON_URL =
  "postgres://kept:pw@ep-example-123.us-east-2.aws.neon.tech/kept?sslmode=require";

describe("resolveDrizzleDatabaseUrl", () => {
  it("returns DATABASE_URL verbatim when it is set", () => {
    expect(resolveDrizzleDatabaseUrl({ DATABASE_URL: NEON_URL })).toBe(NEON_URL);
  });

  it("returns DATABASE_URL in production too - a set value is never second-guessed", () => {
    expect(
      resolveDrizzleDatabaseUrl({ DATABASE_URL: NEON_URL, NODE_ENV: "production" }),
    ).toBe(NEON_URL);
  });

  it("refuses in production when DATABASE_URL is unset, naming the variable", () => {
    expect(() => resolveDrizzleDatabaseUrl({ NODE_ENV: "production" })).toThrowError(
      /Missing required environment variables: DATABASE_URL/,
    );
  });

  it("refuses in production on an empty DATABASE_URL, as the entrypoint does", () => {
    expect(() =>
      resolveDrizzleDatabaseUrl({ DATABASE_URL: "", NODE_ENV: "production" }),
    ).toThrowError(/Missing required environment variables: DATABASE_URL/);
  });

  it("says why the localhost fallback is wrong here, so ECONNREFUSED is not the first clue", () => {
    expect(() => resolveDrizzleDatabaseUrl({ NODE_ENV: "production" })).toThrowError(
      /does not exist on this machine/,
    );
  });

  it("cites no file the deployed image does not carry", () => {
    // The image copies package.json, tsconfig.json, drizzle.config.ts, drizzle/
    // and src/ - not docs/. A refusal read inside the machine must not send its
    // reader to a document that is not there.
    let message = "";
    try {
      resolveDrizzleDatabaseUrl({ NODE_ENV: "production" });
    } catch (error) {
      message = (error as Error).message;
    }
    // Asserted first so this case cannot pass by nothing having been thrown -
    // two negative matchers against "" are vacuously true.
    expect(message).toContain("DATABASE_URL");
    expect(message).not.toMatch(/docs\//);
    expect(message).not.toMatch(/\.md\b/);
  });

  it("falls back to the docker-compose database outside production - a clean checkout migrates", () => {
    expect(resolveDrizzleDatabaseUrl({})).toBe(LOCAL_DEV_DATABASE_URL);
    expect(LOCAL_DEV_DATABASE_URL).toBe("postgres://kept:kept@localhost:5432/kept");
  });

  it.each(["development", "test", undefined])(
    "falls back under NODE_ENV=%s: only the literal production string refuses",
    (nodeEnv) => {
      expect(resolveDrizzleDatabaseUrl({ NODE_ENV: nodeEnv })).toBe(
        LOCAL_DEV_DATABASE_URL,
      );
    },
  );
});
