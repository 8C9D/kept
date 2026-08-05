import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { SessionTokens } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import { unauthorizedError } from "./errors.js";

/**
 * Hono context variables available to authenticated handlers. `userId` set
 * here, from the verified session token, is the ONLY source of user
 * identity in the API (spec §6): no route reads a user id from a path,
 * query, body, or header.
 */
export type AuthedEnv = {
  Variables: {
    userId: string;
  };
};

const BEARER_PREFIX = "Bearer ";

export function sessionAuth(
  sessionTokens: SessionTokens,
  db: Db,
): MiddlewareHandler<AuthedEnv> {
  return async (c, next) => {
    const header = c.req.header("Authorization");
    if (header === undefined || !header.startsWith(BEARER_PREFIX)) {
      throw unauthorizedError();
    }
    const claims = await sessionTokens.verify(
      header.slice(BEARER_PREFIX.length),
    );
    if (claims === null) {
      throw unauthorizedError();
    }

    // The token is genuine; now check it is still current. A missing user
    // or a bumped token_version both mean this session has been revoked.
    const rows = await db
      .select({ tokenVersion: users.tokenVersion })
      .from(users)
      .where(eq(users.id, claims.userId));
    const user = rows[0];
    if (user === undefined || user.tokenVersion !== claims.tokenVersion) {
      throw unauthorizedError();
    }

    c.set("userId", claims.userId);
    await next();
  };
}
