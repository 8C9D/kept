import { SignJWT, importPKCS8 } from "jose";

/**
 * Revoking a person's Sign in with Apple tokens when they delete their
 * account, which Apple requires of every app that offers Sign in with Apple
 * (App Store Review Guideline 5.1.1(v): the app must let a person delete
 * the account from inside the app, and an app using Sign in with Apple must
 * call Apple's REST revocation endpoint as part of it).
 *
 * The seam is an interface for the same reason AppleIdentityVerifier is one:
 * the real implementation talks to `appleid.apple.com` with a signed client
 * secret, tests inject a fake into createApp, and there is deliberately no
 * flag or configuration value that switches the real one off - the only way
 * to get a different revoker is to construct the app with one, which the
 * production entrypoint never does.
 */
export interface AppleTokenRevoker {
  /**
   * Exchange a fresh authorization code for the person's refresh token and
   * revoke it. Resolves when Apple has accepted the revocation; rejects with
   * AppleRevocationError when Apple refused or could not be reached.
   *
   * The code is single-use, minted seconds earlier by the client's
   * re-authorization at deletion time, and is the ONLY thing this needs from
   * the request: the account being deleted is still decided by the session
   * token, never by anything in the body (spec §6).
   */
  revoke(authorizationCode: string): Promise<void>;
}

export class AppleRevocationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "AppleRevocationError";
  }
}

/**
 * What Apple's portal has to have issued before revocation can work, and
 * what the entrypoint reads into it:
 *
 *   clientId    the audience the authorization code was minted for - the
 *               iOS bundle id (APPLE_CLIENT_ID), because the code always
 *               comes from the native re-authorization the iOS client runs
 *               at deletion time. A web client that ever performs its own
 *               re-authorization would need the Services ID here instead,
 *               which is why this is a value rather than a constant.
 *   teamId      APPLE_TEAM_ID - the client secret's issuer.
 *   keyId       APPLE_SIGN_IN_KEY_ID - the Key ID of a "Sign in with Apple"
 *               key created in the developer portal.
 *   privateKey  APPLE_SIGN_IN_PRIVATE_KEY - the PKCS#8 PEM contents of that
 *               key's .p8 file, which Apple lets you download exactly once.
 */
export interface AppleSignInCredentials {
  clientId: string;
  teamId: string;
  keyId: string;
  privateKey: string;
}

const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
const APPLE_REVOKE_URL = "https://appleid.apple.com/auth/revoke";
const APPLE_AUDIENCE = "https://appleid.apple.com";

/**
 * How long a minted client secret is good for. Apple caps it at six months;
 * this one lives for the two requests it is about to make and is minted
 * fresh each time, so nothing has to be cached, rotated, or invalidated.
 */
const CLIENT_SECRET_LIFETIME = "5m";

/**
 * A bound on both Apple round trips. Account deletion is a foreground
 * request a person is waiting on, and Apple being slow must not hold the
 * whole deletion open indefinitely - the route treats a revocation failure
 * as loud-but-not-fatal, and it can only do that if the failure arrives.
 */
const APPLE_REQUEST_TIMEOUT_MS = 10_000;

export function createAppleTokenRevoker(
  credentials: AppleSignInCredentials,
): AppleTokenRevoker {
  assertCredentials(credentials);
  return {
    async revoke(authorizationCode) {
      const clientSecret = await mintClientSecret(credentials);
      // Two steps, and both are Apple's: an authorization code is not
      // itself revocable, so it is first exchanged for the refresh token
      // that is. Revoking the refresh token invalidates the access tokens
      // issued alongside it, which is the whole of what the app holds.
      const refreshToken = await exchangeAuthorizationCode(
        authorizationCode,
        credentials.clientId,
        clientSecret,
      );
      await revokeToken(refreshToken, credentials.clientId, clientSecret);
    },
  };
}

/**
 * The client secret Apple's token endpoints authenticate with: a short-lived
 * ES256 JWT signed with the portal key, issued by the team, addressed to
 * Apple, about this client. Apple rejects any other shape.
 */
async function mintClientSecret(
  credentials: AppleSignInCredentials,
): Promise<string> {
  let key;
  try {
    key = await importPKCS8(credentials.privateKey, "ES256");
  } catch (error) {
    // A malformed .p8 is a configuration fault, not Apple refusing us, and
    // it must not read as "Apple declined". The key material itself is never
    // in the message - `cause` carries jose's own, which names the parse
    // failure and not the bytes.
    throw new AppleRevocationError(
      "The configured Sign in with Apple private key could not be read as a PKCS#8 key",
      { cause: error },
    );
  }
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: credentials.keyId })
    .setIssuer(credentials.teamId)
    .setIssuedAt()
    .setExpirationTime(CLIENT_SECRET_LIFETIME)
    .setAudience(APPLE_AUDIENCE)
    .setSubject(credentials.clientId)
    .sign(key);
}

async function exchangeAuthorizationCode(
  authorizationCode: string,
  clientId: string,
  clientSecret: string,
): Promise<string> {
  // No redirect_uri: the code comes from a native iOS authorization, where
  // the bundle id is the client and there is no redirect to name. A code
  // minted by a web flow would need one, and would need the Services ID as
  // client_id - see AppleSignInCredentials.
  const payload = await postForm(APPLE_TOKEN_URL, {
    grant_type: "authorization_code",
    code: authorizationCode,
    client_id: clientId,
    client_secret: clientSecret,
  });
  const refreshToken = (payload as { refresh_token?: unknown }).refresh_token;
  if (typeof refreshToken !== "string" || refreshToken === "") {
    // Apple answered 200 without the one field this exists to obtain. Loud,
    // because silently skipping the revocation below is exactly the failure
    // this whole module exists to prevent.
    throw new AppleRevocationError(
      "Apple's token exchange succeeded but returned no refresh token",
    );
  }
  return refreshToken;
}

async function revokeToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<void> {
  await postForm(APPLE_REVOKE_URL, {
    client_id: clientId,
    client_secret: clientSecret,
    token: refreshToken,
    token_type_hint: "refresh_token",
  });
}

/**
 * One form POST to Apple, with every non-2xx and every transport failure
 * arriving as AppleRevocationError. Apple's success body for /auth/revoke is
 * empty, so an unparseable body on a 2xx is success, not a fault.
 *
 * ⚠ Apple's error body is `{"error":"invalid_client"}` and similar - short
 * machine codes, no personal data - so it is carried into the message
 * verbatim. That is a deliberate exception to this codebase's default of
 * withholding upstream detail, and it is safe for the specific reason that
 * the field is an enumerated OAuth code. The token and the client secret are
 * never in it: they are in the request, and this reads only the response.
 */
async function postForm(
  url: string,
  fields: Record<string, string>,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
      signal: AbortSignal.timeout(APPLE_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    throw new AppleRevocationError(`Apple did not answer at ${url}`, {
      cause: error,
    });
  }

  const body = await response.text().catch(() => "");
  if (!response.ok) {
    throw new AppleRevocationError(
      `Apple answered ${response.status} at ${url}: ${appleErrorCode(body)}`,
    );
  }
  if (body === "") {
    return {};
  }
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new AppleRevocationError(
      `Apple answered ${response.status} at ${url} with a body that is not JSON`,
      { cause: error },
    );
  }
}

/** Apple's OAuth error code, or a stated absence - never the raw body. */
function appleErrorCode(body: string): string {
  try {
    const code = (JSON.parse(body) as { error?: unknown }).error;
    return typeof code === "string" ? code : "no error code";
  } catch {
    return "no error code";
  }
}

function assertCredentials(credentials: AppleSignInCredentials): void {
  const missing = (
    ["clientId", "teamId", "keyId", "privateKey"] as const
  ).filter((name) => credentials[name] === "");
  if (missing.length > 0) {
    throw new Error(
      `Apple token revoker requires non-empty ${missing.join(", ")}`,
    );
  }
}
