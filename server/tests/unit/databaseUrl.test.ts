import { describe, expect, it } from "vitest";
import { assertLocalDatabase } from "../../src/db/databaseUrl.js";

const ACTION = "db:seed deletes every user, receipt and image row";

function assert(url: string) {
  return () => assertLocalDatabase(url, "DATABASE_URL", ACTION);
}

describe("assertLocalDatabase", () => {
  it("allows every loopback spelling of the docker-compose database", () => {
    expect(assert("postgres://kept:kept@localhost:5432/kept")).not.toThrow();
    expect(assert("postgres://kept:kept@127.0.0.1:5432/kept")).not.toThrow();
    expect(assert("postgres://kept:kept@[::1]:5432/kept")).not.toThrow();
    expect(assert("postgres://kept:kept@localhost/kept")).not.toThrow();
  });

  /**
   * The deployment target is Neon, so the production database is remote by
   * construction. This is the case the guard exists for.
   */
  it("refuses a managed Postgres host", () => {
    expect(
      assert("postgres://user:pw@ep-cool-name-123.us-east-2.aws.neon.tech/kept"),
    ).toThrowError(/not on this machine/);
  });

  /**
   * A `.local` name resolves to *a* machine on the network, not necessarily
   * this one - and the storage endpoint in this project is already spelled
   * that way, so it is a plausible thing to paste in by hand.
   */
  it("refuses an mDNS name that merely looks local", () => {
    expect(
      assert("postgres://kept:kept@dev-mac.local:5432/kept"),
    ).toThrowError(/not on this machine/);
  });

  it("names the host it refused and what it was about to do", () => {
    expect(assert("postgres://kept:kept@db.example.test:5432/kept")).toThrowError(
      /db\.example\.test:5432\/kept/,
    );
    expect(assert("postgres://kept:kept@db.example.test:5432/kept")).toThrowError(
      /deletes every user, receipt and image row/,
    );
  });

  it("rejects an unparseable URL loudly rather than guessing", () => {
    expect(assert("not a url")).toThrowError(/not a parseable URL/);
  });
});
