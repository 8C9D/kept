import { decodeProtectedHeader, exportPKCS8, generateKeyPair, jwtVerify } from "jose";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  AppleRevocationError,
  createAppleTokenRevoker,
} from "../../src/auth/appleTokenRevoker.js";

/**
 * Revocation, proven against a stubbed `fetch` and a locally generated
 * P-256 key rather than against appleid.apple.com. What is under test is
 * everything this codebase decides: the two-step shape Apple's API requires
 * (an authorization code is not revocable, so it is exchanged for the
 * refresh token that is), the exact client-secret JWT Apple authenticates
 * with, and that every way this can fail arrives as AppleRevocationError
 * rather than as a bare fetch rejection the route would not recognise.
 *
 * What it deliberately cannot prove: that Apple accepts the secret. Nothing
 * short of the real endpoint with a real portal key can, and that is stated
 * in docs/DECISIONS.md as the one leg of this feature that stays unverified
 * until the owner mints the key.
 */

const CLIENT_ID = "com.arthurzhang.kept";
const TEAM_ID = "TEAM123456";
const KEY_ID = "KEY0987654";

let privateKey: string;
let publicKey: CryptoKey;

beforeAll(async () => {
  const pair = await generateKeyPair("ES256", { extractable: true });
  privateKey = await exportPKCS8(pair.privateKey as CryptoKey);
  publicKey = pair.publicKey as CryptoKey;
});

interface RecordedCall {
  url: string;
  fields: URLSearchParams;
}

/**
 * A `fetch` that records the form posts and answers each one from a script.
 * Returns the recorded calls so a test can assert what Apple was actually
 * sent - the client secret included, which is the point.
 */
function stubApple(
  responses: readonly Response[],
): { calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let index = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    calls.push({
      url,
      fields: new URLSearchParams(String(init.body)),
    });
    const response = responses[index];
    index += 1;
    if (response === undefined) {
      throw new Error(`Unscripted request to ${url}`);
    }
    return response;
  });
  return { calls };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

function revoker() {
  return createAppleTokenRevoker({
    clientId: CLIENT_ID,
    teamId: TEAM_ID,
    keyId: KEY_ID,
    privateKey,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createAppleTokenRevoker", () => {
  it("exchanges the code, then revokes the refresh token it got back", async () => {
    const { calls } = stubApple([
      json(200, { refresh_token: "r-token", access_token: "a-token" }),
      new Response("", { status: 200 }),
    ]);

    await revoker().revoke("c-fromreauth");

    expect(calls).toHaveLength(2);
    const [exchange, revoke] = calls;
    expect(exchange?.url).toBe("https://appleid.apple.com/auth/token");
    expect(exchange?.fields.get("grant_type")).toBe("authorization_code");
    expect(exchange?.fields.get("code")).toBe("c-fromreauth");
    expect(exchange?.fields.get("client_id")).toBe(CLIENT_ID);
    // No redirect_uri: the code comes from a native authorization, which
    // provided none, and Apple's rule is to include it only if the original
    // authorization request did.
    expect(exchange?.fields.has("redirect_uri")).toBe(false);

    expect(revoke?.url).toBe("https://appleid.apple.com/auth/revoke");
    expect(revoke?.fields.get("token")).toBe("r-token");
    expect(revoke?.fields.get("token_type_hint")).toBe("refresh_token");
    expect(revoke?.fields.get("client_id")).toBe(CLIENT_ID);
  });

  it("signs a client secret in exactly the shape Apple requires", async () => {
    const { calls } = stubApple([
      json(200, { refresh_token: "r-token" }),
      new Response("", { status: 200 }),
    ]);
    await revoker().revoke("c-fromreauth");

    const secret = calls[0]?.fields.get("client_secret");
    if (secret === null || secret === undefined) {
      throw new Error("no client_secret was sent");
    }
    // ES256 and the key id in the header; Apple rejects anything else, and
    // TN3107 names a wrong or missing header as a cause of invalid_client.
    expect(decodeProtectedHeader(secret)).toMatchObject({
      alg: "ES256",
      kid: KEY_ID,
    });
    // Verified with the public half, so this proves a real signature over
    // the claims rather than a decode of an unsigned blob.
    const { payload } = await jwtVerify(secret, publicKey, {
      issuer: TEAM_ID,
      audience: "https://appleid.apple.com",
    });
    // sub is the client id and is case-sensitive to Apple; a Services ID
    // here against a native code is the classic invalid_client.
    expect(payload.sub).toBe(CLIENT_ID);
    const { iat, exp } = payload;
    if (iat === undefined || exp === undefined) {
      throw new Error("the client secret must carry iat and exp");
    }
    // Apple's cap is six months. This one lives for the two requests it is
    // about to make, so nothing has to cache or rotate it.
    expect(exp - iat).toBeLessThanOrEqual(15 * 60);
  });

  it("carries Apple's own error code out of a refused exchange", async () => {
    const { calls } = stubApple([json(400, { error: "invalid_grant" })]);
    const error = await revoker()
      .revoke("c-expired")
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
    // One assertion per property of the same single failure, deliberately -
    // a second `revoke()` here would run off the end of the script and
    // reject as "Apple did not answer", which is a different error wearing
    // the same type and would let this pass for the wrong reason.
    expect(error).toBeInstanceOf(AppleRevocationError);
    expect((error as Error).message).toContain("invalid_grant");
    // And nothing was revoked: a failed exchange must not go on to POST an
    // undefined token to /auth/revoke.
    expect(calls).toHaveLength(1);
  });

  it("refuses a 200 exchange that carries no refresh token", async () => {
    // The silent failure this whole module exists to prevent: a 200 with
    // nothing revocable in it, followed by a revoke that never happened.
    stubApple([json(200, { access_token: "a-token" })]);
    await expect(revoker().revoke("c-fromreauth")).rejects.toThrow(
      /no refresh token/,
    );
  });

  it("reports a refused revocation, not just a refused exchange", async () => {
    stubApple([
      json(200, { refresh_token: "r-token" }),
      json(400, { error: "invalid_client" }),
    ]);
    await expect(revoker().revoke("c-fromreauth")).rejects.toThrow(
      /invalid_client/,
    );
  });

  it("accepts the empty body Apple answers a successful revocation with", async () => {
    stubApple([
      json(200, { refresh_token: "r-token" }),
      new Response("", { status: 200 }),
    ]);
    await expect(revoker().revoke("c-fromreauth")).resolves.toBeUndefined();
  });

  it("reports Apple not answering as a revocation failure, not a crash", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    const error = await revoker()
      .revoke("c-fromreauth")
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );
    expect(error).toBeInstanceOf(AppleRevocationError);
    // The transport's own answer is kept as `cause`, never swallowed.
    expect((error as Error).cause).toBeInstanceOf(TypeError);
  });

  it("reports an unreadable private key as configuration, not as Apple refusing", async () => {
    const badKey = createAppleTokenRevoker({
      clientId: CLIENT_ID,
      teamId: TEAM_ID,
      keyId: KEY_ID,
      privateKey: "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----\n",
    });
    await expect(badKey.revoke("c-fromreauth")).rejects.toThrow(
      /could not be read as a PKCS#8 key/,
    );
  });

  it("refuses construction on an empty credential rather than signing nonsense", async () => {
    expect(() =>
      createAppleTokenRevoker({
        clientId: CLIENT_ID,
        teamId: "",
        keyId: KEY_ID,
        privateKey,
      }),
    ).toThrow(/teamId/);
  });
});
