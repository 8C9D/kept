import { createRemoteJWKSet, jwtVerify } from "jose";

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
  /** Resolves for a valid token, throws AppleVerificationError otherwise. */
  verify(identityToken: string): Promise<AppleIdentity>;
}

export class AppleVerificationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AppleVerificationError";
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
 * Tests and local development inject a fake AppleIdentityVerifier into
 * createApp instead. There is deliberately no flag, environment variable, or
 * config value that switches this implementation off: the only way to bypass
 * it is to construct the app with a different verifier, which the production
 * entrypoint never does.
 */
export function createAppleIdentityVerifier(
  clientId: string,
): AppleIdentityVerifier {
  const appleKeys = createRemoteJWKSet(APPLE_JWKS_URL);

  return {
    async verify(identityToken: string): Promise<AppleIdentity> {
      let payload;
      try {
        ({ payload } = await jwtVerify(identityToken, appleKeys, {
          issuer: APPLE_ISSUER,
          audience: clientId,
          algorithms: ["RS256"],
        }));
      } catch (error) {
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
    },
  };
}
