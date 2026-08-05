import type { Context } from "hono";
import type { ZodType } from "zod";
import { ApiError } from "./errors.js";

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
