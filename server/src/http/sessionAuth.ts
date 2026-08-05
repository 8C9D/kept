import type { MiddlewareHandler } from "hono";
import type { SessionTokens } from "../auth/session.js";
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
): MiddlewareHandler<AuthedEnv> {
  return async (c, next) => {
    const header = c.req.header("Authorization");
    if (header === undefined || !header.startsWith(BEARER_PREFIX)) {
      throw unauthorizedError();
    }
    const userId = await sessionTokens.verify(
      header.slice(BEARER_PREFIX.length),
    );
    if (userId === null) {
      throw unauthorizedError();
    }
    c.set("userId", userId);
    await next();
  };
}
