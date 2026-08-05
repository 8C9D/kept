import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * The one error shape every route uses: throw an ApiError anywhere in a
 * handler and the app-level error handler renders it. One style, no
 * per-route variations.
 */
export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
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
      { error: { code: error.code, message: error.message } },
      error.status,
    );
  }
  // Unknown errors are logged with detail server-side and rendered without
  // detail client-side; internals never leak into a response.
  console.error("Unhandled error:", error);
  return c.json(
    { error: { code: "internal_error", message: "Internal server error" } },
    500,
  );
}
