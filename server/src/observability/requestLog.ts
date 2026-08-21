import type { Context, MiddlewareHandler } from "hono";
import { routePath } from "hono/route";

/**
 * How a refusal that answers BEFORE Hono routes names itself in the log's
 * `route` field.
 *
 * These strings are an operator interface, not prose: `fly logs` is grepped
 * and grouped by this exact value, so they stay stable and machine-groupable
 * and are written down in Runbook §7. Neither one carries any part of the
 * request the client sent.
 */
export const REFUSAL_LABELS = {
  edgeSecret: "refused:edge-secret",
  bodyLimit: "refused:body-limit",
} as const;

export type RefusalLabel = (typeof REFUSAL_LABELS)[keyof typeof REFUSAL_LABELS];

/** The context variable the refusing middlewares set and the log line reads. */
const REFUSED_BY = "refusedBy";

/**
 * Called by a middleware that is about to answer without calling `next()`,
 * so the log can say WHICH refusal it was rather than that some request
 * matched no route. Both sides go through one typed function because the
 * label is the only thing separating these from 404 noise; a string literal
 * typed out at each call site would reintroduce the ambiguity silently.
 */
export function markRefused(c: Context, label: RefusalLabel): void {
  c.set(REFUSED_BY, label);
}

/**
 * One structured line per request, and the only thing the deployed process
 * says about ordinary traffic.
 *
 * Before this, a machine emitted three lines at boot and then nothing: no
 * request rate, no latency, no status codes, and nothing at all for a 400,
 * 401, 403, 404, 409 or 413. `fly logs` after "the app says it can't sync"
 * showed the boot banner and silence, so the first question anyone would ask
 * - is it reaching us at all, and what are we answering? - had no answer on
 * the machine.
 *
 * ⚠ What is deliberately NOT in the line, because this project's logs sit one
 * error-monitor away from leaving the machine (spec §10B):
 *
 *   - **The query string.** `GET /api/receipts?q=...` carries whatever the
 *     person typed into search, which is vendor names off their own receipts.
 *   - **The path as requested.** The matched route pattern is logged instead,
 *     so `/api/receipts/{uuid}` becomes `/api/receipts/:id`. Nothing needs the
 *     id, and a receipt id is a handle to a tax record.
 *   - **The user id.** Whether a session was presented is the diagnostic fact;
 *     *whose* it was is not, and a user id is also the first path segment of
 *     every one of that person's object keys.
 *
 *   - **Headers and bodies**, which is where the bearer token and every
 *     receipt field live.
 *
 * That leaves the line saying what happened and how long it took, which is
 * what a three-user deployment needs, without adding a second place receipt
 * data can escape.
 *
 * ⚠ The third bullet named the diagnostic fact and then did not report it.
 * The line carried `authenticated` alone, computed from whether `userId` was
 * set - which happens only after the bearer header parses, the JWT verifies,
 * the user row is found and `token_version` matches. So it answered "did
 * authentication SUCCEED", and a client sending no token at all, a client
 * sending a forged one, and a client whose session had been revoked all
 * logged the identical line. Those have different causes and different fixes,
 * and "the app says it can't sync" is exactly the question this log gets
 * opened for. Both facts are reported now: `sessionPresented` is the one that
 * bullet promised, and `authenticated` keeps the meaning it always had, so
 * nothing already reading the line changes under it.
 */
export function requestLog(): MiddlewareHandler {
  return async (c, next) => {
    const startedAt = performance.now();
    try {
      await next();
    } finally {
      // In a `finally` so a request that throws past the error handler is
      // still counted - an uncounted request is exactly the one worth seeing.
      const durationMs = Math.round(performance.now() - startedAt);

      // ⚠ `c.res` is a lazy getter: read when nothing ever set a response, it
      // MANUFACTURES a 200. So a request that died without producing one -
      // Hono rethrows a non-Error without calling onError - would be logged
      // as a success, which is worse than not logging it at all. `finalized`
      // is the question actually being asked: did a response happen.
      const answered = c.finalized;

      // The matched route pattern, never the requested path: a 404's path is
      // client-supplied, so it is reported as unmatched rather than echoed
      // into the log.
      //
      // ⚠ Two refusals answer BEFORE Hono routes - the edge-secret 403 and
      // the body-limit 413 - and both are registered at the catch-all `/*`,
      // so both used to read "unmatched", byte-identical to a 404. In
      // production that ambiguity is not hypothetical: the edge secret IS
      // set, so a Cloudflare Transform Rule that stops adding the header
      // turns every request into a 403 whose line differs from ordinary
      // 404 noise in the status code alone - and the status code is what
      // someone reads AFTER deciding a group of lines is worth opening.
      // Each refusing middleware now labels itself (`markRefused`) and the
      // label wins over the pattern; a genuine 404 still reads "unmatched".
      // The labels are fixed strings, so this still never echoes the path.
      const refusedBy = c.get(REFUSED_BY) as RefusalLabel | undefined;
      const pattern = routePath(c);

      console.log(
        JSON.stringify({
          msg: "request",
          method: c.req.method,
          route: refusedBy ?? (pattern === "/*" ? "unmatched" : pattern),
          status: answered ? c.res.status : null,
          ...(answered ? {} : { threw: true }),
          durationMs,
          // Whether a bearer credential arrived at all. Its VALUE is never
          // read here and never logged - only that the header was present and
          // well-formed enough to be a session attempt, which is the same
          // condition sessionAuth uses before it tries to verify anything.
          sessionPresented:
            c.req.header("Authorization")?.startsWith("Bearer ") === true,
          // Whether that credential was accepted. `userId` is set only at the
          // far end of sessionAuth, so this stays "authentication succeeded".
          authenticated: c.get("userId") !== undefined,
        }),
      );
    }
  };
}
