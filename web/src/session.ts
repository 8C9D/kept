/**
 * The session token, held in localStorage under one key.
 *
 * The trade, stated (DECISIONS 2026-08-21): a bearer token a script could
 * read, on a page that loads no third-party script anywhere a token exists
 * - Apple's sign-in JS is confined to the sign-in controls, which render only
 * while there is no live token: on the signed-out screen, and over a view
 * whose token has just expired - against an httpOnly cookie that would give
 * the API a second authentication path to carry forever. The token expires
 * in 30 days. A cleared or expired token degrades to a sign-in prompt, never
 * to an error state: the sign-in screen when the 401 interrupted a read, and
 * a banner over the still-mounted view when it interrupted a save, so that
 * the expiry cannot cost the person what they typed (App.tsx).
 */
const TOKEN_KEY = "kept.session";

export function storedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    // Storage can be unavailable (private windows, blocked site data);
    // the app then simply starts signed out.
    return null;
  }
}

export function storeToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // The session still works for this page view; it just won't survive
    // a reload. Nothing to surface - sign-in worked.
  }
}

export function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing to clear if storage is unreachable.
  }
}

/**
 * Who a session token belongs to, read from the JWT's `sub` claim - which
 * is our user id (server/src/auth/session.ts) - or null if it cannot be read.
 *
 * Unverified, and fine to be: the server re-verifies every token on every
 * request, so nothing here grants anything. This only ever compares two
 * tokens this browser was handed, to answer the one question below.
 */
function sessionSubject(token: string): string | null {
  const payload = token.split(".")[1];
  if (payload === undefined) {
    return null;
  }
  try {
    const claims = JSON.parse(
      atob(payload.replace(/-/g, "+").replace(/_/g, "/")),
    ) as { sub?: unknown };
    return typeof claims.sub === "string" ? claims.sub : null;
  } catch {
    // Not a JWT this client can read - the caller's answer for that is the
    // safe one, "not provably the same person".
    return null;
  }
}

/**
 * Whether a new sign-in is the same person as the session it would resume.
 * It decides whether the receipt on screen may stay there: the expiry banner
 * sits over someone's open form, and a different Apple ID signing in at it
 * must get a fresh app rather than that form (CLAUDE.md constraint 3). An
 * unreadable token counts as different, which costs a draft and never
 * exposes one.
 */
export function sameSessionUser(token: string, other: string): boolean {
  const subject = sessionSubject(token);
  return subject !== null && subject === sessionSubject(other);
}
