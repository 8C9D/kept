import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import type { JWTVerifyGetKey } from "jose";
import {
  AppleVerificationError,
  createAppleIdentityVerifier,
  verifyAppleIdentityToken,
} from "../../src/auth/appleVerifier.js";

/**
 * The audience logic wave 7 changed, proven against locally-generated keys
 * rather than Apple's JWKS: the same verifier must accept a token minted
 * for the iOS bundle id or for the web Services ID, and nothing else. The
 * signature and issuer checks ride along because a test that stubbed them
 * out would prove the audience of a token nobody verified.
 */

const IOS_CLIENT_ID = "com.arthurzhang.kept";
const WEB_CLIENT_ID = "com.arthurzhang.kept.web";
const CLIENT_IDS = [IOS_CLIENT_ID, WEB_CLIENT_ID];

let signingKey: CryptoKey;
let keys: JWTVerifyGetKey;
let wrongKeys: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey as CryptoKey;
  keys = createLocalJWKSet({
    keys: [{ ...(await exportJWK(pair.publicKey)), alg: "RS256" }],
  });
  const otherPair = await generateKeyPair("RS256");
  wrongKeys = createLocalJWKSet({
    keys: [{ ...(await exportJWK(otherPair.publicKey)), alg: "RS256" }],
  });
});

function appleToken(claims: {
  issuer?: string;
  audience?: string;
  sub?: string;
  email?: string;
}): Promise<string> {
  const jwt = new SignJWT({
    ...(claims.email !== undefined && { email: claims.email }),
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(claims.issuer ?? "https://appleid.apple.com")
    .setAudience(claims.audience ?? IOS_CLIENT_ID)
    .setIssuedAt()
    .setExpirationTime("5m");
  if (claims.sub !== undefined) {
    jwt.setSubject(claims.sub);
  }
  return jwt.sign(signingKey);
}

describe("verifyAppleIdentityToken", () => {
  it("accepts a token minted for the iOS client id", async () => {
    const token = await appleToken({
      audience: IOS_CLIENT_ID,
      sub: "000123.abc",
      email: "relay@privaterelay.appleid.com",
    });
    const identity = await verifyAppleIdentityToken(token, keys, CLIENT_IDS);
    expect(identity.appleSub).toBe("000123.abc");
    expect(identity.email).toBe("relay@privaterelay.appleid.com");
  });

  it("accepts a token minted for the web Services ID - the wave-7 case", async () => {
    const token = await appleToken({ audience: WEB_CLIENT_ID, sub: "000123.abc" });
    const identity = await verifyAppleIdentityToken(token, keys, CLIENT_IDS);
    expect(identity.appleSub).toBe("000123.abc");
  });

  it("rejects a token minted for someone else's client", async () => {
    // The realistic misuse: a valid Apple token from an unrelated app,
    // replayed here. The signature and issuer are genuinely Apple's shape;
    // only the audience says it was never meant for this server.
    const token = await appleToken({
      audience: "com.example.other-app",
      sub: "000123.abc",
    });
    await expect(
      verifyAppleIdentityToken(token, keys, CLIENT_IDS),
    ).rejects.toBeInstanceOf(AppleVerificationError);
  });

  it("rejects the web audience when only the iOS id is configured - today's production", async () => {
    const token = await appleToken({ audience: WEB_CLIENT_ID, sub: "000123.abc" });
    await expect(
      verifyAppleIdentityToken(token, keys, [IOS_CLIENT_ID]),
    ).rejects.toBeInstanceOf(AppleVerificationError);
  });

  it("still rejects a wrong issuer and a wrong signature", async () => {
    const wrongIssuer = await appleToken({
      issuer: "https://not-apple.example",
      sub: "000123.abc",
    });
    await expect(
      verifyAppleIdentityToken(wrongIssuer, keys, CLIENT_IDS),
    ).rejects.toBeInstanceOf(AppleVerificationError);

    const rightClaims = await appleToken({ sub: "000123.abc" });
    await expect(
      verifyAppleIdentityToken(rightClaims, wrongKeys, CLIENT_IDS),
    ).rejects.toBeInstanceOf(AppleVerificationError);
  });

  it("rejects a token with no subject", async () => {
    const token = await appleToken({});
    await expect(
      verifyAppleIdentityToken(token, keys, CLIENT_IDS),
    ).rejects.toBeInstanceOf(AppleVerificationError);
  });

  it("refuses to construct or verify with an empty client id list", async () => {
    expect(() => createAppleIdentityVerifier([])).toThrow(
      /at least one non-empty client id/,
    );
    const token = await appleToken({ sub: "000123.abc" });
    await expect(verifyAppleIdentityToken(token, keys, [])).rejects.toThrow(
      /at least one non-empty client id/,
    );
  });
});
