import { Hono } from "hono";
import type { SessionTokens } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { userEvents } from "../db/schema.js";
import { postEventsSchema } from "../http/schemas.js";
import { parseOrThrow, readJsonBody } from "../http/validate.js";
import { sessionAuth, type AuthedEnv } from "../http/sessionAuth.js";

interface EventRouteDependencies {
  db: Db;
  sessionTokens: SessionTokens;
}

/**
 * POST /api/events - batched behavioural telemetry (the owner's 2026-08-28
 * ask; domain/userEvents.ts carries the vocabulary and the privacy rule).
 *
 * Fire-and-forget, by contract with every client that calls it: a client
 * MUST NOT block a user action on this endpoint, retry it aggressively, or
 * surface its failure to the person using the app. Capture, confirm, and
 * every other real action in this app succeed or fail on their own terms;
 * this endpoint only ever watches.
 *
 * It follows that a strict 400 here is the correct outcome, not a gap to
 * paper over - a newer client sending an action name an older server does
 * not know loses that one event, silently, on the client's side. Losing
 * telemetry is always the acceptable failure; degrading a capture to keep
 * this endpoint happy would not be.
 */
export function eventRoutes(deps: EventRouteDependencies): Hono<AuthedEnv> {
  const router = new Hono<AuthedEnv>();
  router.use("*", sessionAuth(deps.sessionTokens, deps.db));

  router.post("/", async (c) => {
    const body = parseOrThrow(postEventsSchema, await readJsonBody(c));
    const userId = c.get("userId");

    // Explicit field map on every row, same reasoning as the receipt
    // routes: userId ALWAYS comes from the session, never the body - the
    // body's schema is strict, so a batch that tried to carry one was
    // already refused above, wholesale, rather than silently overwritten
    // here.
    await deps.db.insert(userEvents).values(
      body.events.map((event) => ({
        userId,
        occurredAt: new Date(event.occurredAt),
        client: event.client,
        appVersion: event.appVersion ?? null,
        action: event.action,
        field: event.field ?? null,
        receiptId: event.receiptId ?? null,
        durationMs: event.durationMs ?? null,
        count: event.count ?? null,
      })),
    );

    return c.json({ accepted: body.events.length }, 202);
  });

  return router;
}
