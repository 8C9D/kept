/**
 * The session token, held in localStorage under one key.
 *
 * The trade, stated (DECISIONS 2026-08-21): a bearer token a script could
 * read, on a page that loads no third-party script anywhere a token exists
 * - Apple's sign-in JS is confined to the signed-OUT screen - against an
 * httpOnly cookie that would give the API a second authentication path to
 * carry forever. The token expires in 30 days and every route treats a 401
 * as sign-out, so a cleared or expired token degrades to the sign-in
 * screen, never to an error state.
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
