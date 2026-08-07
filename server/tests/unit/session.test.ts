import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { describe, expect, it } from "vitest";
import { createSessionTokens } from "../../src/auth/session.js";

const SECRET = "unit-test-session-secret-0123456789abcdef";
const USER_ID = "3f9a1c2e-8b4d-4f6a-9c0d-1e2f3a4b5c6d";
const KEY = new TextEncoder().encode(SECRET);

describe("session tokens", () => {
  it("verifies a token it issued and returns the claims", async () => {
    const sessions = createSessionTokens(SECRET);
    const token = await sessions.issue(USER_ID, 3);
    expect(await sessions.verify(token)).toEqual({
      userId: USER_ID,
      tokenVersion: 3,
    });
  });

  it("rejects a token signed with a different secret", async () => {
    const ours = createSessionTokens(SECRET);
    const theirs = createSessionTokens(
      "a-completely-different-secret-0123456789",
    );
    const token = await theirs.issue(USER_ID, 0);
    expect(await ours.verify(token)).toBeNull();
  });

  it("rejects a tampered token", async () => {
    const sessions = createSessionTokens(SECRET);
    const token = await sessions.issue(USER_ID, 0);
    const tampered = `${token.slice(0, -4)}AAAA`;
    expect(await sessions.verify(tampered)).toBeNull();
  });

  it("rejects garbage that is not a JWT at all", async () => {
    const sessions = createSessionTokens(SECRET);
    expect(await sessions.verify("not-a-jwt")).toBeNull();
  });

  it("rejects an expired token", async () => {
    const sessions = createSessionTokens(SECRET);
    const expired = await new SignJWT({ tv: 0 })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(USER_ID)
      .setIssuedAt(new Date("2020-01-01T00:00:00Z"))
      .setExpirationTime(new Date("2020-01-02T00:00:00Z"))
      .sign(KEY);
    expect(await sessions.verify(expired)).toBeNull();
  });

  it("rejects a token with no subject", async () => {
    const sessions = createSessionTokens(SECRET);
    const subjectless = await new SignJWT({ tv: 0 })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(KEY);
    expect(await sessions.verify(subjectless)).toBeNull();
  });

  it("rejects a token without a token-version claim", async () => {
    const sessions = createSessionTokens(SECRET);
    const versionless = await new SignJWT({})
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(USER_ID)
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(KEY);
    expect(await sessions.verify(versionless)).toBeNull();
  });

  it("rejects a token whose tv claim is not an integer", async () => {
    const sessions = createSessionTokens(SECRET);
    // Each of these is a well-signed token that only differs in tv. A
    // string "0" or a fractional version cannot be compared against the
    // integer column, so it is not a session either.
    for (const tv of ["0", 1.5, null, true, { value: 0 }]) {
      const malformed = await new SignJWT({ tv })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(USER_ID)
        .setIssuedAt()
        .setExpirationTime("30d")
        .sign(KEY);
      expect(await sessions.verify(malformed)).toBeNull();
    }
  });

  it("rejects an unsigned token claiming alg none", async () => {
    const sessions = createSessionTokens(SECRET);
    // Hand-assembled, because no signer will produce this: header and
    // payload base64url-encoded with an empty signature - the classic
    // "trust me, I need no key" forgery.
    const encode = (value: object) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = [
      encode({ alg: "none", typ: "JWT" }),
      encode({
        sub: USER_ID,
        tv: 0,
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
      "",
    ].join(".");
    expect(await sessions.verify(unsigned)).toBeNull();
  });

  it("rejects an HMAC token signed with a public key (algorithm confusion)", async () => {
    const sessions = createSessionTokens(SECRET);
    // The classic confusion attack: a verifier that picks its algorithm
    // from the token's own header would treat an RSA public key as an
    // HMAC secret. Ours pins HS256, so a token that declares RS256 is
    // refused whatever it was signed with.
    const { publicKey } = await generateKeyPair("RS256", {
      extractable: true,
    });
    const publicJwk = await exportJWK(publicKey);
    const confused = await new SignJWT({ tv: 0 })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(USER_ID)
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(new TextEncoder().encode(publicJwk.n as string));
    expect(await sessions.verify(confused)).toBeNull();

    // And a genuinely RS256-signed token is refused by the pin itself.
    const { privateKey } = await generateKeyPair("RS256", {
      extractable: true,
    });
    const rsaSigned = await new SignJWT({ tv: 0 })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject(USER_ID)
      .setIssuedAt()
      .setExpirationTime("30d")
      .sign(privateKey);
    expect(await sessions.verify(rsaSigned)).toBeNull();
  });

  it("refuses to be constructed with a weak secret", () => {
    expect(() => createSessionTokens("short")).toThrow(/at least 32/);
  });
});
