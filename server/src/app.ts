import { Hono } from "hono";
import type { AppleIdentityVerifier } from "./auth/appleVerifier.js";
import type { SessionTokens } from "./auth/session.js";
import type { Db } from "./db/client.js";
import { renderError } from "./http/errors.js";
import { authRoutes } from "./routes/auth.js";
import { exportRoutes } from "./routes/exports.js";
import { meRoutes } from "./routes/me.js";
import { receiptRoutes } from "./routes/receipts.js";
import type { ObjectStorage } from "./storage/objectStorage.js";

/**
 * Everything the app needs arrives here as a value; nothing inside reads
 * the environment. That keeps the test-mode Apple verifier structurally
 * confined: tests construct the app with a fake, the production entrypoint
 * (index.ts) always constructs the real one, and no configuration value
 * can swap them.
 */
export interface AppDependencies {
  db: Db;
  appleVerifier: AppleIdentityVerifier;
  sessionTokens: SessionTokens;
  storage: ObjectStorage;
}

export function createApp(deps: AppDependencies): Hono {
  const app = new Hono();
  app.onError(renderError);

  app.route("/api/auth", authRoutes(deps));
  app.route("/api/receipts", receiptRoutes(deps));
  app.route("/api/export", exportRoutes(deps));
  app.route("/api/me", meRoutes(deps));

  return app;
}
