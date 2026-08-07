import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
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
  /**
   * When set, every request must carry this value in `x-kept-edge-secret`,
   * which a Cloudflare Transform Rule adds at the edge. This is what makes
   * the edge rate limiter (spec §4.2 / §10B) enforceable rather than
   * decorative: without it, anyone who guesses the origin's fly.dev
   * hostname talks to the origin directly and the limiter never sees them.
   * Optional so a fresh deployment works before Cloudflare is in front,
   * and absent in local development.
   */
  edgeSharedSecret?: string;
}

/**
 * The largest request body any route can legitimately receive.
 *
 * Images never transit the API (spec §6: the client PUTs them straight to
 * object storage through a presigned URL), so every body here is JSON whose
 * size the schemas already bound. The create-receipt body is the biggest:
 * `ocrRawText` caps at 100 000 characters and `notes` at 5 000, with the
 * remaining strings under 1 400 together. zod counts characters, not bytes,
 * and JSON can spend six bytes on one character (`\uXXXX`), so the true
 * worst case is roughly 640 KB. One MiB clears that with room to spare and
 * still refuses anything an order of magnitude larger.
 *
 * Without this, `POST /api/auth/apple` - the one route reachable without a
 * session, by anyone holding the unlisted install link - buffers whatever
 * it is sent before verification can reject it. Measured during the August
 * 2026 security review: six concurrent 50 MB posts took the process from
 * 285 MB to 654 MB of resident memory, attacker-controlled and unbounded.
 */
const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

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
  //
  // Outermost deliberately: middleware that answers without calling the
  // next handler - bodyLimit's 413 below - would otherwise skip this and
  // return an uncacheable-by-nobody error. "Every response" has to mean
  // the ones no route ever saw.
  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  // Between the cache header (which must cover this middleware's own 403)
  // and the body limit (a request refused here must be refused before its
  // body is buffered). Comparison is constant-time over digests so neither
  // length nor prefix leaks through timing.
  const edgeSecret = deps.edgeSharedSecret;
  if (edgeSecret !== undefined && edgeSecret !== "") {
    app.use("*", async (c, next) => {
      const presented = c.req.header("x-kept-edge-secret") ?? "";
      if (!digestsMatch(presented, edgeSecret)) {
        return c.json(
          {
            error: {
              code: "forbidden",
              message: "Requests must arrive through the configured edge",
            },
          },
          403,
        );
      }
      await next();
    });
  }

  // Ahead of every route, so an oversized body is refused before any
  // handler, verifier, or database query does work on it.
  app.use(
    "*",
    bodyLimit({
      maxSize: MAX_REQUEST_BODY_BYTES,
      onError: (c) =>
        c.json(
          {
            error: {
              code: "request_too_large",
              message: "Request body is too large",
            },
          },
          413,
        ),
    }),
  );

  app.route("/api/auth", authRoutes(deps));
  app.route("/api/receipts", receiptRoutes(deps));
  app.route("/api/export", exportRoutes(deps));
  app.route("/api/me", meRoutes(deps));

  return app;
}

/** Constant-time string comparison; hashing first makes unequal lengths
 * comparable without an early return. */
function digestsMatch(presented: string, expected: string): boolean {
  const presentedDigest = createHash("sha256").update(presented).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(presentedDigest, expectedDigest);
}
