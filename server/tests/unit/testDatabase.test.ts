import { describe, expect, it } from "vitest";
import {
  LOCAL_TEST_DATABASE_URL,
  assertSeparateTestDatabase,
  resolveDevDatabaseUrl,
  resolveTestDatabaseUrl,
} from "../helpers/testDatabase.js";

const DEV_URL = "postgres://kept:kept@localhost:5432/kept";

describe("assertSeparateTestDatabase", () => {
  it("refuses when both URLs name the same database", () => {
    expect(() => assertSeparateTestDatabase(DEV_URL, DEV_URL)).toThrowError(
      /same database as DATABASE_URL/,
    );
  });

  it("refuses when only the credentials differ", () => {
    expect(() =>
      assertSeparateTestDatabase(
        "postgres://other:secret@localhost:5432/kept",
        DEV_URL,
      ),
    ).toThrowError(/same database/);
  });

  it("refuses when the ports differ only by an explicit default", () => {
    expect(() =>
      assertSeparateTestDatabase("postgres://kept:kept@localhost/kept", DEV_URL),
    ).toThrowError(/same database/);
  });

  it("refuses when only the loopback spelling differs", () => {
    expect(() =>
      assertSeparateTestDatabase("postgres://kept:kept@127.0.0.1:5432/kept", DEV_URL),
    ).toThrowError(/same database/);
    expect(() =>
      assertSeparateTestDatabase("postgres://kept:kept@[::1]:5432/kept", DEV_URL),
    ).toThrowError(/same database/);
  });

  it("allows a different database name in the same container", () => {
    expect(() =>
      assertSeparateTestDatabase(LOCAL_TEST_DATABASE_URL, DEV_URL),
    ).not.toThrow();
  });

  it("allows the same database name on a different host or port", () => {
    expect(() =>
      assertSeparateTestDatabase(
        "postgres://kept:kept@db.example.test:5432/kept",
        DEV_URL,
      ),
    ).not.toThrow();
    expect(() =>
      assertSeparateTestDatabase(
        "postgres://kept:kept@localhost:5433/kept",
        DEV_URL,
      ),
    ).not.toThrow();
  });

  it("rejects an unparseable URL loudly rather than comparing garbage", () => {
    expect(() =>
      assertSeparateTestDatabase("not a url", DEV_URL),
    ).toThrowError(/not a parseable URL/);
  });
});

describe("URL resolution", () => {
  it("defaults TEST_DATABASE_URL to the kept_test database", () => {
    expect(resolveTestDatabaseUrl({})).toBe(LOCAL_TEST_DATABASE_URL);
    expect(resolveTestDatabaseUrl({ TEST_DATABASE_URL: "" })).toBe(
      LOCAL_TEST_DATABASE_URL,
    );
  });

  it("uses an explicit TEST_DATABASE_URL when set", () => {
    const url = "postgres://kept:kept@localhost:5432/kept_ci";
    expect(resolveTestDatabaseUrl({ TEST_DATABASE_URL: url })).toBe(url);
  });

  it("defaults the dev comparison target to the docker-compose database", () => {
    expect(resolveDevDatabaseUrl({})).toBe(DEV_URL);
  });

  it("compares against an explicit DATABASE_URL when set", () => {
    const url = "postgres://kept:kept@db.example.test:5432/kept";
    expect(resolveDevDatabaseUrl({ DATABASE_URL: url })).toBe(url);
  });
});
