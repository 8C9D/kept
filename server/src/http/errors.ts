import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { errorSummary } from "../observability/errorSummary.js";

/**
 * The one error shape every route uses: throw an ApiError anywhere in a
 * handler and the app-level error handler renders it. One style, no
 * per-route variations.
 *
 * `extra` is for the rare error a client can act on beyond reading it -
 * `existingReceiptId` on a create's `duplicate_image` is the case that needed
 * it. Its keys are rendered beside `code` and `message` and can never replace
 * them, so every client's decoding of those two stays true. Whatever goes in
 * here reaches the wire verbatim: it is response data, chosen by the throwing
 * route, and it must already be scoped to the session user.
 */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly extra?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * 404 for "yours doesn't exist" and for "exists but is not yours" alike:
 * a 403 would confirm the resource exists, which is an information leak
 * across the isolation boundary (spec §3 constraint 4).
 */
export function notFoundError(): ApiError {
  return new ApiError(404, "not_found", "Not found");
}

export function unauthorizedError(): ApiError {
  return new ApiError(401, "unauthorized", "A valid session token is required");
}

export function renderError(error: unknown, c: Context): Response {
  if (error instanceof ApiError) {
    return c.json(
      { error: { ...error.extra, code: error.code, message: error.message } },
      error.status,
    );
  }
  // Unknown errors are logged server-side and rendered without detail
  // client-side; internals never leak into a response. The log line is
  // redacted too: a failed query's error carries the statement's bound
  // parameters - vendor, notes, amounts - in its own message, so the error
  // object is never handed to console directly (see errorSummary).
  console.error("Unhandled error:", errorSummary(error));
  return c.json(
    { error: { code: "internal_error", message: "Internal server error" } },
    500,
  );
}
