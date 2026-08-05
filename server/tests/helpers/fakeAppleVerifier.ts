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
      const parts = identityToken.split(":");
      if (parts[0] !== "apple-token" || parts.length < 2 || parts[1] === "") {
        throw new AppleVerificationError("Fake verifier rejected the token");
      }
      return {
        appleSub: parts[1],
        email: parts.length >= 3 ? parts[2] : null,
      };
    },
  };
}
