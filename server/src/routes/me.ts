import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { SessionTokens } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { users } from "../db/schema.js";
import { ApiError } from "../http/errors.js";
import { updateMeSchema } from "../http/schemas.js";
import { parseOrThrow, readJsonBody } from "../http/validate.js";
import { sessionAuth, type AuthedEnv } from "../http/sessionAuth.js";
import { isValidFiscalYearEnd } from "../domain/fiscalPeriod.js";

interface MeRouteDependencies {
  db: Db;
  sessionTokens: SessionTokens;
}

/** GET/PATCH /api/me - own profile and fiscal year settings. */
export function meRoutes(deps: MeRouteDependencies): Hono<AuthedEnv> {
  const router = new Hono<AuthedEnv>();
  router.use("*", sessionAuth(deps.sessionTokens, deps.db));

  router.get("/", async (c) => {
    const user = await loadUser(deps.db, c.get("userId"));
    return c.json(profileOf(user));
  });

  router.patch("/", async (c) => {
    const body = parseOrThrow(updateMeSchema, await readJsonBody(c));
    const user = await loadUser(deps.db, c.get("userId"));

    // Month and day may be updated independently, but the resulting pair -
    // merged with what is stored - must name a real day of a real month
    // (Feb 29 allowed; see domain). Two racing partial updates could in
    // principle each validate against stale halves; with this user count
    // that risk is accepted rather than locked against.
    const fiscalYearEnd = {
      month: body.fiscalYearEndMonth ?? user.fiscalYearEndMonth,
      day: body.fiscalYearEndDay ?? user.fiscalYearEndDay,
    };
    if (!isValidFiscalYearEnd(fiscalYearEnd)) {
      throw new ApiError(
        400,
        "invalid_request",
        `fiscal year end month ${fiscalYearEnd.month} has no day ${fiscalYearEnd.day}`,
      );
    }

    // Write only what the client asked to change.
    const changes: Partial<typeof users.$inferInsert> = {};
    if (body.fiscalYearEndMonth !== undefined)
      changes.fiscalYearEndMonth = body.fiscalYearEndMonth;
    if (body.fiscalYearEndDay !== undefined)
      changes.fiscalYearEndDay = body.fiscalYearEndDay;
    if (body.displayName !== undefined) changes.displayName = body.displayName;

    const updated = await deps.db
      .update(users)
      .set(changes)
      .where(eq(users.id, user.id))
      .returning();
    const updatedUser = updated[0];
    if (updatedUser === undefined) {
      // Same impossible-in-practice state loadUser guards: the user row
      // vanished between read and write.
      throw new ApiError(401, "unauthorized", "Session user no longer exists");
    }
    return c.json(profileOf(updatedUser));
  });

  return router;
}

async function loadUser(db: Db, userId: string) {
  const rows = await db.select().from(users).where(eq(users.id, userId));
  const user = rows[0];
  if (user === undefined) {
    // A valid session naming a nonexistent user should be impossible;
    // treat it as an invalid session rather than a 404 on oneself.
    throw new ApiError(401, "unauthorized", "Session user no longer exists");
  }
  return user;
}

/** The API shape of a profile; apple_sub stays internal. */
function profileOf(user: typeof users.$inferSelect) {
  return {
    id: user.id,
    displayName: user.displayName,
    email: user.email,
    fiscalYearEndMonth: user.fiscalYearEndMonth,
    fiscalYearEndDay: user.fiscalYearEndDay,
  };
}
