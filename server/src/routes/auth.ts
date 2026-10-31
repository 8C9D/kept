import { Hono } from "hono";
import { eq } from "drizzle-orm";
import {
  AppleKeysUnavailableError,
  AppleVerificationError,
  type AppleIdentityVerifier,
} from "../auth/appleVerifier.js";
import type { SessionTokens } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import { ApiError } from "../http/errors.js";
import { appleSignInSchema } from "../http/schemas.js";
import { parseOrThrow, readJsonBody } from "../http/validate.js";
import { errorSummary } from "../observability/errorSummary.js";

interface AuthRouteDependencies {
  db: Db;
  appleVerifier: AppleIdentityVerifier;
  sessionTokens: SessionTokens;
}

/**
 * POST /api/auth/apple - exchange an Apple identity token for a session JWT.
 * The only route that does not require a session, because it is how a
 * session is obtained.
 */
export function authRoutes(deps: AuthRouteDependencies): Hono {
  const router = new Hono();

  router.post("/apple", async (c) => {
    const body = parseOrThrow(appleSignInSchema, await readJsonBody(c));

    let identity;
    try {
      identity = await deps.appleVerifier.verify(body.identityToken);
    } catch (error) {
      if (error instanceof AppleVerificationError) {
        throw new ApiError(
          401,
          "invalid_identity_token",
          "Apple identity token failed verification",
        );
      }
      if (error instanceof AppleKeysUnavailableError) {
        // Logged here because this is the only trace an outage leaves: unlike
        // a bad token it is true of every sign-in at once and nobody's fault
        // on the client. errorSummary carries the fetch failure and its cause,
        // and the identity token is in neither - nothing about the request is
        // passed to the log, deliberately.
        console.error(
          "Sign in with Apple is failing: could not fetch Apple's signing keys:",
          errorSummary(error),
        );
        throw new ApiError(
          503,
          "apple_unavailable",
          "Sign in with Apple can't be reached right now. Try again in a few minutes.",
        );
      }
      throw error;
    }

    const user = await findOrCreateUser(deps.db, identity, body.displayName);
    const token = await deps.sessionTokens.issue(user.id, user.tokenVersion);

    return c.json({
      token,
      user: {
        id: user.id,
        displayName: user.displayName,
        email: user.email,
      },
    });
  });

  return router;
}

async function findOrCreateUser(
  db: Db,
  identity: { appleSub: string; email: string | null },
  displayName: string | undefined,
) {
  // Insert-then-fallback rather than select-then-insert so two concurrent
  // first sign-ins cannot both pass a "does it exist" check; the unique
  // constraint on apple_sub arbitrates.
  const inserted = await db
    .insert(users)
    .values({
      appleSub: identity.appleSub,
      email: identity.email,
      displayName: displayName ?? null,
    })
    .onConflictDoNothing({ target: users.appleSub })
    .returning();
  const insertedUser = inserted[0];
  if (insertedUser !== undefined) {
    return insertedUser;
  }

  const existing = await db
    .select()
    .from(users)
    .where(eq(users.appleSub, identity.appleSub));
  const existingUser = existing[0];
  if (existingUser === undefined) {
    // The insert conflicted, so the row must exist; not finding it means
    // something is genuinely broken.
    throw new Error(
      `User with apple_sub ${identity.appleSub} conflicted on insert but was not found`,
    );
  }
  return existingUser;
}
