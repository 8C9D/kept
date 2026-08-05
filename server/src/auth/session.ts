import { SignJWT, jwtVerify, errors as joseErrors } from "jose";

/**
 * Session tokens are backend-issued JWTs (spec §4.2): HS256 over a server
 * secret, subject = our user id. The Apple identity token is exchanged once
 * at sign-in; everything after runs on these.
 *
 * Each token also carries the user's token_version (`tv` claim). The auth
 * middleware compares it against the current column value, so bumping
 * users.token_version revokes every outstanding session for that user.
 */
export interface SessionClaims {
  userId: string;
  tokenVersion: number;
}

export interface SessionTokens {
  issue(userId: string, tokenVersion: number): Promise<string>;
  /**
   * Returns the claims for a valid token and null for anything else -
   * expired, tampered, or malformed. Invalid tokens are an expected input
   * on a public API, not an exceptional condition.
   */
  verify(token: string): Promise<SessionClaims | null>;
}

const SESSION_LIFETIME = "30d";

export function createSessionTokens(secret: string): SessionTokens {
  if (secret.length < 32) {
    throw new Error(
      "Session secret must be at least 32 characters; refusing to sign with a weak key",
    );
  }
  const key = new TextEncoder().encode(secret);

  return {
    async issue(userId: string, tokenVersion: number): Promise<string> {
      return new SignJWT({ tv: tokenVersion })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(userId)
        .setIssuedAt()
        .setExpirationTime(SESSION_LIFETIME)
        .sign(key);
    },

    async verify(token: string): Promise<SessionClaims | null> {
      try {
        const { payload } = await jwtVerify(token, key, {
          algorithms: ["HS256"],
        });
        if (typeof payload.sub !== "string" || payload.sub === "") {
          return null;
        }
        // A token without a usable tv claim predates (or forges) the
        // scheme; it cannot be checked, so it is not a valid session.
        if (typeof payload.tv !== "number" || !Number.isInteger(payload.tv)) {
          return null;
        }
        return { userId: payload.sub, tokenVersion: payload.tv };
      } catch (error) {
        // Only verification failures mean "not a valid session". Anything
        // else (a bug, an unexpected state) must stay loud.
        if (error instanceof joseErrors.JOSEError) {
          return null;
        }
        throw error;
      }
    },
  };
}
