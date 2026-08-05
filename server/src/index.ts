import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { createAppleIdentityVerifier } from "./auth/appleVerifier.js";
import { createSessionTokens } from "./auth/session.js";
import { createDb } from "./db/client.js";
import { unconfiguredObjectStorage } from "./storage/objectStorage.js";

/**
 * The production entrypoint. Configuration is read here and nowhere else,
 * and a missing value stops the process at startup with a list of what is
 * absent - not later, at the first request that needed it.
 */
const REQUIRED_ENV = [
  "DATABASE_URL",
  "SESSION_JWT_SECRET",
  "APPLE_CLIENT_ID",
] as const;

const missingEnv = REQUIRED_ENV.filter((name) => {
  const value = process.env[name];
  return value === undefined || value === "";
});
if (missingEnv.length > 0) {
  throw new Error(
    `Missing required environment variables: ${missingEnv.join(", ")}`,
  );
}
const databaseUrl = process.env.DATABASE_URL as string;
const sessionSecret = process.env.SESSION_JWT_SECRET as string;
const appleClientId = process.env.APPLE_CLIENT_ID as string;

const port = Number(process.env.PORT ?? "3000");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`PORT must be a port number, got: ${process.env.PORT}`);
}

const { db } = createDb(databaseUrl);
const app = createApp({
  db,
  // Always the real verifier. Local development and tests inject fakes by
  // constructing their own app; this file offers no way to do so.
  appleVerifier: createAppleIdentityVerifier(appleClientId),
  sessionTokens: createSessionTokens(sessionSecret),
  storage: unconfiguredObjectStorage(), // R2 adapter arrives with wave 2
});

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Kept API listening on port ${info.port}`);
});
