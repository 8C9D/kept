import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { users } from "../../src/db/schema.js";
import { SignJWT } from "jose";
import { createTestHarness, TEST_SESSION_SECRET } from "../helpers/testApp.js";

const harness = createTestHarness();
afterAll(() => harness.close());

describe("POST /api/auth/apple", () => {
  beforeEach(() => harness.resetDatabase());

  it("creates a user on first sign-in and returns a usable session", async () => {
    const { token, userId } = await harness.signIn("new-sub", "Test User");

    const rows = await harness.db
      .select()
      .from(users)
      .where(eq(users.appleSub, "new-sub"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe(userId);
    expect(rows[0]?.displayName).toBe("Test User");

    const me = await harness.request(token, "GET", "/api/me");
    expect(me.status).toBe(200);
  });

  it("reuses the same user on repeat sign-ins", async () => {
    const first = await harness.signIn("repeat-sub");
    const second = await harness.signIn("repeat-sub");
    expect(second.userId).toBe(first.userId);

    const rows = await harness.db
      .select()
      .from(users)
      .where(eq(users.appleSub, "repeat-sub"));
    expect(rows).toHaveLength(1);
  });

  it("stores a null display name when Apple provides none", async () => {
    const { userId } = await harness.signIn("nameless-sub");
    const rows = await harness.db
      .select()
      .from(users)
      .where(eq(users.id, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.displayName).toBeNull();
  });

  it("rejects an invalid identity token with 401", async () => {
    const response = await harness.request(null, "POST", "/api/auth/apple", {
      identityToken: "forged-token",
    });
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_identity_token");
  });

  it("rejects an empty body with 400", async () => {
    const response = await harness.request(null, "POST", "/api/auth/apple", {});
    expect(response.status).toBe(400);
  });
});

describe("session enforcement on protected routes", () => {
  beforeEach(() => harness.resetDatabase());

  it.each([
    ["GET", "/api/receipts"],
    ["POST", "/api/receipts"],
    ["GET", "/api/me"],
    ["POST", "/api/export"],
  ])("%s %s without a token is 401", async (method, path) => {
    const response = await harness.request(null, method, path);
    expect(response.status).toBe(401);
  });

  it("rejects a syntactically invalid bearer token", async () => {
    const response = await harness.request(
      "not-a-real-token",
      "GET",
      "/api/receipts",
    );
    expect(response.status).toBe(401);
  });

  it("rejects a well-formed session for a user that does not exist", async () => {
    const { token, userId } = await harness.signIn("doomed-sub");
    // Simulate a stale session: the user row is gone but the JWT lives on.
    await harness.db.delete(users).where(eq(users.id, userId));
    const response = await harness.request(token, "GET", "/api/me");
    expect(response.status).toBe(401);
  });

  it("answers 401, not 500, to a genuinely-signed token whose subject is not a user id", async () => {
    // PR-12, end to end. The unit case in tests/unit/session.test.ts pins the
    // verifier; this pins the STATUS CODE, which is the part of the finding
    // that mattered - `sub` reached `eq(users.id, ...)` against a `uuid`
    // column and Postgres answered 22P02, which rendered as
    // "Internal server error".
    //
    // Signed with the harness's own secret, which is what makes this a
    // forgery-shaped input rather than a garbage-token one: the token is
    // cryptographically genuine and names nobody.
    //
    // Falsification, predicted then run:
    //   Predicted: reverting session.ts to the non-empty-string check fails
    //   this on `expect(response.status).toBe(401)`, receiving 500.
    //   Actual: exactly that, at :118 - "expected 500 to be 401". No gap, and
    //   the 500 is the finding reproduced through the real route.
    const forged = await new SignJWT({ tv: 0 })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject("not-a-uuid")
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(new TextEncoder().encode(TEST_SESSION_SECRET));

    const response = await harness.request(forged, "GET", "/api/me");
    expect(response.status).toBe(401);
    const body = (await response.json()) as { error?: { code?: string } };
    expect(body.error?.code).toBe("unauthorized");
  });

  it("revokes every outstanding session when token_version is bumped", async () => {
    const { token, userId } = await harness.signIn("revoked-sub");
    const before = await harness.request(token, "GET", "/api/me");
    expect(before.status).toBe(200);

    await harness.db
      .update(users)
      .set({ tokenVersion: 1 })
      .where(eq(users.id, userId));

    const after = await harness.request(token, "GET", "/api/me");
    expect(after.status).toBe(401);

    // A fresh sign-in issues a token carrying the new version, which works.
    const again = await harness.signIn("revoked-sub");
    const refreshed = await harness.request(again.token, "GET", "/api/me");
    expect(refreshed.status).toBe(200);
  });
});
