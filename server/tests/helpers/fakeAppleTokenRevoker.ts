import {
  AppleRevocationError,
  type AppleTokenRevoker,
} from "../../src/auth/appleTokenRevoker.js";

export interface FakeAppleTokenRevoker extends AppleTokenRevoker {
  /** Every code handed to revoke(), in order. */
  readonly codes: string[];
  /** When set, revoke() rejects with it instead of recording a success. */
  failure: AppleRevocationError | undefined;
}

/**
 * Test stand-in for Apple's revocation endpoints. Records what it was asked
 * to revoke so a test can assert the route forwarded the client's code, and
 * can be told to fail so the route's "delete anyway, loudly" branch is
 * exercised rather than assumed.
 *
 * Lives under tests/ and reaches the app only by explicit injection into
 * createApp; no production code path constructs it.
 */
export function fakeAppleTokenRevoker(): FakeAppleTokenRevoker {
  const codes: string[] = [];
  // Named and closed over rather than reached through `this`: the route
  // calls `deps.appleTokenRevoker.revoke(code)` today, but a fake whose
  // behaviour depends on its call site would quietly change meaning the day
  // someone destructures it.
  const revoker: FakeAppleTokenRevoker = {
    codes,
    failure: undefined,
    async revoke(authorizationCode: string) {
      if (revoker.failure !== undefined) {
        throw revoker.failure;
      }
      codes.push(authorizationCode);
    },
  };
  return revoker;
}
