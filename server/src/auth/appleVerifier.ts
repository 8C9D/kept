import {
  createRemoteJWKSet,
  errors as joseErrors,
  jwtVerify,
  type JWTVerifyGetKey,
} from "jose";

/**
 * What a verified Sign in with Apple identity token tells us. `appleSub` is
 * the stable subject identifier and the only thing treated as identity;
 * email is often an Apple relay address and is informational (spec §5).
 */
export interface AppleIdentity {
  appleSub: string;
  email: string | null;
}

export interface AppleIdentityVerifier {
  /**
   * Resolves for a valid token. Throws AppleVerificationError when the TOKEN
   * is the problem, and AppleKeysUnavailableError when the token could not be
   * judged at all.
   */
  verify(identityToken: string): Promise<AppleIdentity>;
}

export class AppleVerificationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AppleVerificationError";
  }
}

/**
 * Apple's signing keys could not be obtained, so nothing is known about the
 * token either way - an outage at Apple, or this machine's egress failing.
 *
 * Its own class, because the two failures want opposite handling. A bad token
 * is the caller's and is answered 401 in silence; this one is ours, is true of
 * every sign-in at once, and answered as a 401 it reads as "your token is bad"
 * to all of them with nothing in the log to say otherwise.
 */
export class AppleKeysUnavailableError extends Error {
  constructor(options: { cause: unknown }) {
    super("Apple's signing keys could not be fetched", options);
    this.name = "AppleKeysUnavailableError";
  }
}

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_JWKS_URL = new URL("https://appleid.apple.com/auth/keys");

/**
 * The production verifier: checks the token's RS256 signature against
 * Apple's published public keys. createRemoteJWKSet caches the key set and
 * refetches it when it sees an unknown key id, which is exactly Apple's key
 * rotation model.
 *
 * `clientIds` is a set because the same Apple account signs in from two
 * client shapes (wave 7): the iOS app's identity token carries the bundle id
 * as its audience, the web client's carries the Services ID Apple issues for
 * web sign-in. One verifier, one user table - the subject is the identity,
 * the audience only proves the token was minted for one of OUR clients.
 * The set never grows from input: it is fixed at construction from
 * configuration the entrypoint read.
 *
 * Tests and local development inject a fake AppleIdentityVerifier into
 * createApp instead. There is deliberately no flag, environment variable, or
 * config value that switches this implementation off: the only way to bypass
 * it is to construct the app with a different verifier, which the production
 * entrypoint never does.
 */
export function createAppleIdentityVerifier(
  clientIds: readonly string[],
): AppleIdentityVerifier {
  assertClientIds(clientIds);
  const appleKeys = createRemoteJWKSet(APPLE_JWKS_URL);
  return {
    verify: (identityToken) =>
      verifyAppleIdentityToken(identityToken, appleKeys, clientIds),
  };
}

/**
 * The verification itself, taking its key source as a value so a test can
 * hand it locally-generated keys and prove the audience logic - which is
 * the part wave 7 changed - without Apple's JWKS endpoint in the loop.
 */
export async function verifyAppleIdentityToken(
  identityToken: string,
  keys: JWTVerifyGetKey,
  clientIds: readonly string[],
): Promise<AppleIdentity> {
  assertClientIds(clientIds);
  let payload;
  try {
    ({ payload } = await jwtVerify(identityToken, reportingKeyFailures(keys), {
      issuer: APPLE_ISSUER,
      // jose accepts the token if its audience matches ANY entry; a token
      // minted for neither client is rejected.
      audience: [...clientIds],
      algorithms: ["RS256"],
    }));
  } catch (error) {
    if (error instanceof AppleKeysUnavailableError) {
      throw error;
    }
    throw new AppleVerificationError(
      "Apple identity token failed verification",
      { cause: error },
    );
  }
  if (typeof payload.sub !== "string" || payload.sub === "") {
    throw new AppleVerificationError(
      "Apple identity token has no subject",
    );
  }
  return {
    appleSub: payload.sub,
    email: typeof payload.email === "string" ? payload.email : null,
  };
}

/**
 * Sorts a key-source failure from a token failure by WHERE it happened rather
 * than by a list of error classes. jose throws its own `JWKSTimeout` for a
 * timeout, a bare `JOSEError` for a non-200 or an unparseable body, and lets
 * `fetch`'s TypeError straight through for a network failure - so naming them
 * would be enumerating an implementation, and the next one would quietly read
 * as a bad token. Anything the key source throws means the keys were not
 * obtained, except the two answers that are statements ABOUT this token: the
 * key set arrived, and no key in it (or more than one) matches what the token
 * asks for. A forged `kid` lands there, and that stays a 401.
 *
 * Everything else `jwtVerify` rejects - signature, issuer, audience, expiry -
 * happens outside this function and keeps meaning a bad token.
 */
function reportingKeyFailures(keys: JWTVerifyGetKey): JWTVerifyGetKey {
  return async (protectedHeader, token) => {
    try {
      return await keys(protectedHeader, token);
    } catch (error) {
      if (
        error instanceof joseErrors.JWKSNoMatchingKey ||
        error instanceof joseErrors.JWKSMultipleMatchingKeys
      ) {
        throw error;
      }
      throw new AppleKeysUnavailableError({ cause: error });
    }
  };
}

/**
 * An empty audience list would make jwtVerify accept any audience-less
 * check path a future refactor invents; refuse construction instead of
 * verifying nothing.
 */
function assertClientIds(clientIds: readonly string[]): void {
  if (clientIds.length === 0 || clientIds.some((id) => id === "")) {
    throw new Error(
      "Apple verifier requires at least one non-empty client id",
    );
  }
}
