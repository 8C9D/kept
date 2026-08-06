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

  // Every API response is live state and must never be served from an
  // HTTP cache. Without this header, iOS's CFNetwork heuristically cached
  // list responses and answered an OFFLINE pull-to-refresh with a stale
  // 200 - the app's failure UI never fired because, as far as the app
  // could see, the request succeeded (wave-5 device diagnostic). The
  // client also disables its cache; this states the contract at the
  // source so every future client inherits it.
  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  app.route("/api/auth", authRoutes(deps));
  app.route("/api/receipts", receiptRoutes(deps));
  app.route("/api/export", exportRoutes(deps));
  app.route("/api/me", meRoutes(deps));

  return app;
}
