import {
  AppleVerificationError,
  type AppleIdentityVerifier,
} from "../../src/auth/appleVerifier.js";

/**
 * Test stand-in for Sign in with Apple. A token of the form
 * "apple-token:<sub>" or "apple-token:<sub>:<email>" verifies; anything
 * else fails the way a forged real token would.
 *
 * This lives under tests/ and reaches the app only by explicit injection
 * into createApp; no production code path constructs it.
 */
export function fakeAppleVerifier(): AppleIdentityVerifier {
  return {
    async verify(identityToken: string) {
      const [scheme, sub, email] = identityToken.split(":");
      if (scheme !== "apple-token" || sub === undefined || sub === "") {
        throw new AppleVerificationError("Fake verifier rejected the token");
      }
      return { appleSub: sub, email: email ?? null };
    },
  };
}
