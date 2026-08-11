import type { MiddlewareHandler } from "hono";

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
      console.log(
        JSON.stringify({
          msg: "request",
          method: c.req.method,
          // The matched route pattern, never the requested path: a 404's path
          // is client-supplied, so it is reported as unmatched rather than
          // echoed into the log.
          //
          // ⚠ "unmatched" also covers refusals that answered BEFORE routing -
          // the edge-secret 403 and the body-limit 413 - which are not 404s.
          // The alternative is echoing the client's path, which is the one
          // thing this field exists to avoid, so the ambiguity is kept and
          // the status code is what separates the cases: 404 means no such
          // route, 403 and 413 mean refused before we looked for one.
          route: c.req.routePath === "/*" ? "unmatched" : c.req.routePath,
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
