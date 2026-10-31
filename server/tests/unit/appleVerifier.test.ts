import { createServer, type Server, type ServerResponse } from "node:http";
import {
  SignJWT,
  createLocalJWKSet,
  createRemoteJWKSet,
  exportJWK,
  generateKeyPair,
} from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { JWK, JWTVerifyGetKey } from "jose";
import {
  AppleKeysUnavailableError,
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
let publicJwk: JWK;
let keys: JWTVerifyGetKey;
let wrongKeys: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  signingKey = pair.privateKey as CryptoKey;
  publicJwk = { ...(await exportJWK(pair.publicKey)), alg: "RS256" };
  keys = createLocalJWKSet({ keys: [publicJwk] });
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

/**
 * The line between "the token is bad" and "the token could not be judged",
 * driven through the real `createRemoteJWKSet` against a real local socket
 * wherever possible. jose reports these failures in three different ways - its
 * own timeout class, a bare JOSEError, and fetch's TypeError passed straight
 * through - and a stubbed key function would prove only the stub.
 */
describe("a key source that cannot answer", () => {
  let server: Server | undefined;

  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise((resolve) => {
      if (server === undefined) {
        resolve(undefined);
      } else {
        server.close(resolve);
      }
    });
    server = undefined;
  });

  async function jwksServer(
    respond: (response: ServerResponse) => void,
  ): Promise<URL> {
    server = createServer((_request, response) => respond(response));
    await new Promise<void>((resolve) =>
      server?.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("could not read the JWKS server's port");
    }
    return new URL(`http://127.0.0.1:${address.port}/auth/keys`);
  }

  async function verifyAgainst(remote: JWTVerifyGetKey): Promise<unknown> {
    const token = await appleToken({ sub: "000123.abc" });
    return verifyAppleIdentityToken(token, remote, CLIENT_IDS).then(
      () => undefined,
      (error: unknown) => error,
    );
  }

  it("reports a 500 from Apple as unavailable, not as a bad token", async () => {
    const url = await jwksServer((response) => {
      response.statusCode = 500;
      response.end("Internal Server Error");
    });

    const error = await verifyAgainst(createRemoteJWKSet(url));

    expect(error).toBeInstanceOf(AppleKeysUnavailableError);
    expect(error).not.toBeInstanceOf(AppleVerificationError);
  });

  it("reports a timeout as unavailable", async () => {
    const url = await jwksServer(() => {
      // Accepts the request and never answers, the shape of a wedged proxy.
    });

    const error = await verifyAgainst(
      createRemoteJWKSet(url, { timeoutDuration: 100 }),
    );

    expect(error).toBeInstanceOf(AppleKeysUnavailableError);
  });

  it("reports a refused connection as unavailable, which is the VM's egress failing", async () => {
    const url = await jwksServer((response) => response.end());
    server?.closeAllConnections();
    await new Promise((resolve) => server?.close(resolve));
    server = undefined;

    const error = await verifyAgainst(createRemoteJWKSet(url));

    expect(error).toBeInstanceOf(AppleKeysUnavailableError);
    // The real cause is kept for the log rather than discarded.
    expect((error as Error).cause).toBeInstanceOf(TypeError);
  });

  it("reports a 200 that is not a key set as unavailable", async () => {
    const url = await jwksServer((response) => response.end("<html>"));

    expect(await verifyAgainst(createRemoteJWKSet(url))).toBeInstanceOf(
      AppleKeysUnavailableError,
    );
  });

  it("still calls a token bad when the keys arrived and none of them matches", async () => {
    // A rotated-out or forged `kid`. The key set was fetched fine, so this is
    // a statement about the token, and it must stay a 401.
    const url = await jwksServer((response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ keys: [{ ...publicJwk, kid: "other" }] }));
    });
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "RS256", kid: "not-a-real-kid" })
      .setIssuer("https://appleid.apple.com")
      .setAudience(IOS_CLIENT_ID)
      .setSubject("000123.abc")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(signingKey);

    await expect(
      verifyAppleIdentityToken(token, createRemoteJWKSet(url), CLIENT_IDS),
    ).rejects.toBeInstanceOf(AppleVerificationError);
  });

  it("still verifies a good token from a key set that is really there", async () => {
    const url = await jwksServer((response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ keys: [publicJwk] }));
    });
    const token = await appleToken({ sub: "000123.abc" });

    const identity = await verifyAppleIdentityToken(
      token,
      createRemoteJWKSet(url),
      CLIENT_IDS,
    );

    expect(identity.appleSub).toBe("000123.abc");
  });

  it("never asks for keys at all over a token that is not even a JWT", async () => {
    // A garbage token must not be able to reach Apple on the server's behalf,
    // and must never read as an outage.
    let asked = false;
    const failing: JWTVerifyGetKey = async () => {
      asked = true;
      throw new Error("the key source was consulted");
    };

    await expect(
      verifyAppleIdentityToken("not-a-jwt", failing, CLIENT_IDS),
    ).rejects.toBeInstanceOf(AppleVerificationError);
    expect(asked).toBe(false);
  });
});
