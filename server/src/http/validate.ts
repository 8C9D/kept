import type { Context } from "hono";
import type { ZodType } from "zod";
import { ApiError, notFoundError } from "./errors.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A malformed id cannot name any resource, so it gets the same 404 a
 * missing or foreign resource gets - one indistinguishable outcome for
 * "not yours to see" (spec §3 constraint 4).
 */
export function uuidParamOrNotFound(param: string): string {
  if (!UUID_PATTERN.test(param)) {
    throw notFoundError();
  }
  return param;
}

/**
 * Read a request body as JSON, treating malformed or missing JSON as the
 * client error it is (400), never as a server fault (500).
 */
export async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new ApiError(400, "invalid_request", "Request body must be JSON");
  }
}

/**
 * The same, for a route whose body is optional: DELETE /api/me carries one
 * only when the client has an Apple authorization code to hand over, and
 * `c.req.json()` treats an absent body as malformed JSON. An EMPTY body
 * becomes an empty object - which the route's strict schema then validates
 * like any other - while a non-empty body that is not JSON is still the 400
 * it is. "No body" and "junk body" stay different answers.
 */
export async function readOptionalJsonBody(c: Context): Promise<unknown> {
  const raw = await c.req.text();
  if (raw.trim() === "") {
    return {};
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(400, "invalid_request", "Request body must be JSON");
  }
}

/**
 * Every request body and query string is parsed through a strict zod schema
 * before it reaches domain code; nothing downstream ever sees unvalidated
 * input (framework §10.2, "untyped boundaries").
 */
export function parseOrThrow<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path === "" ? issue.message : `${path}: ${issue.message}`;
      })
      .join("; ");
    throw new ApiError(400, "invalid_request", details);
  }
  return result.data;
}
