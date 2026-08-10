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
 *   - **Headers and bodies**, which is where the bearer token and every
 *     receipt field live.
 *
 * That leaves the line saying what happened and how long it took, which is
 * what a three-user deployment needs, without adding a second place receipt
 * data can escape.
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
      console.log(
        JSON.stringify({
          msg: "request",
          method: c.req.method,
          // Falls back to the raw path only when nothing matched, and a 404's
          // path is client-supplied rather than one of ours - so it is
          // reported as unmatched rather than echoed into the log.
          route: c.req.routePath === "/*" ? "unmatched" : c.req.routePath,
          status: c.res.status,
          durationMs,
          authenticated: c.get("userId") !== undefined,
        }),
      );
    }
  };
}
