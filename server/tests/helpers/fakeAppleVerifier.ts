import {
  AppleKeysUnavailableError,
  AppleVerificationError,
  type AppleIdentityVerifier,
} from "../../src/auth/appleVerifier.js";

/** The token that fails the way an Apple outage does, not a forged token. */
export const APPLE_OUTAGE_TOKEN = "apple-keys-unreachable";

/**
 * Test stand-in for Sign in with Apple. A token of the form
 * "apple-token:<sub>" or "apple-token:<sub>:<email>" verifies; anything
 * else fails the way a forged real token would, except `APPLE_OUTAGE_TOKEN`,
 * which fails the way Apple's key endpoint being unreachable does.
 *
 * This lives under tests/ and reaches the app only by explicit injection
 * into createApp; no production code path constructs it.
 */
export function fakeAppleVerifier(): AppleIdentityVerifier {
  return {
    async verify(identityToken: string) {
      if (identityToken === APPLE_OUTAGE_TOKEN) {
        throw new AppleKeysUnavailableError({
          cause: new TypeError("fetch failed"),
        });
      }
      const [scheme, sub, email] = identityToken.split(":");
      if (scheme !== "apple-token" || sub === undefined || sub === "") {
        throw new AppleVerificationError("Fake verifier rejected the token");
      }
      return { appleSub: sub, email: email ?? null };
    },
  };
}
