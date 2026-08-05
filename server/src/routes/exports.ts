import { Hono } from "hono";
import type { SessionTokens } from "../auth/session.js";
import { ApiError } from "../http/errors.js";
import { sessionAuth, type AuthedEnv } from "../http/sessionAuth.js";

interface ExportRouteDependencies {
  sessionTokens: SessionTokens;
}

/**
 * POST /api/export and GET /api/export/:id exist in the spec's API surface
 * (§6) but generation is wave-2 work. Until then they answer 501 honestly
 * rather than pretending: still auth-gated, so the surface's security shape
 * is already final.
 *
 * Wave-2 note: the spec defines a job id + polling model but no job store;
 * see the wave-1 gate report.
 */
export function exportRoutes(deps: ExportRouteDependencies): Hono<AuthedEnv> {
  const router = new Hono<AuthedEnv>();
  router.use("*", sessionAuth(deps.sessionTokens));

  const notImplemented = () => {
    throw new ApiError(
      501,
      "not_implemented",
      "Export generation is wave-2 work",
    );
  };
  router.post("/", notImplemented);
  router.get("/:id", notImplemented);

  return router;
}
