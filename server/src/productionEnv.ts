import { databaseIdentity } from "./db/databaseUrl.js";
import { resolveStorageConfig } from "./storage/s3ObjectStorage.js";

/**
 * What "production" must look like before the process is allowed to serve.
 *
 * The entrypoint already refuses to start on missing environment variables;
 * this extends that posture to the deployed shape (wave-6 kickoff: prefer
 * configuration that fails loudly at startup over configuration that
 * defaults quietly). Everything here is a condition under which the server
 * would RUN but be quietly wrong in production:
 *
 * - No STORAGE_* set falls back to the docker-compose MinIO on localhost,
 *   which does not exist on a Fly machine - the failure would surface as
 *   the first image upload, not at boot.
 * - A plain-http storage endpoint would presign http:// URLs, sending
 *   receipt image bytes over cleartext (the audit's N5: the ATS exception,
 *   the API base URL, and the storage endpoint are three separate places
 *   that each have to become HTTPS).
 * - A loopback DATABASE_URL on a Fly machine names a database that is not
 *   there; the deployment target is Neon, whose hostnames are remote by
 *   construction. This is the mirror image of assertLocalDatabase, which
 *   keeps the destructive dev scripts OFF remote databases.
 * - A short SESSION_JWT_SECRET undermines HS256; 32 bytes is the minimum
 *   the algorithm's security argument assumes. Checked only in production
 *   so a throwaway dev secret stays a dev convenience.
 * - A missing ANTHROPIC_API_KEY is silent feature loss: the LLM parse
 *   sweep disables itself and every receipt quietly degrades to
 *   heuristic-only suggestions, with nothing failing to say so.
 *
 * Gated on NODE_ENV=production, which the Dockerfile sets - a laptop
 * `npm run dev` keeps its MinIO fallback and its ceremony-free start.
 */
export function assertProductionEnv(
  env: Record<string, string | undefined>,
): void {
  if (env.NODE_ENV !== "production") {
    return;
  }

  // Throws on partial STORAGE_* configuration, naming what is missing.
  const storage = resolveStorageConfig(env);
  if (storage === null) {
    throw new Error(
      "NODE_ENV is production but no STORAGE_* variables are set. " +
        "Production has no MinIO fallback; configure STORAGE_ENDPOINT, " +
        "STORAGE_BUCKET, STORAGE_ACCESS_KEY_ID and STORAGE_SECRET_ACCESS_KEY " +
        "(the R2 bucket and its API token).",
    );
  }
  if (!storage.endpoint.startsWith("https://")) {
    throw new Error(
      `STORAGE_ENDPOINT must be https in production, got: ${storage.endpoint}. ` +
        "Presigned URLs inherit this endpoint, so a plain-http value sends " +
        "receipt images over cleartext.",
    );
  }

  const database = databaseIdentity(env.DATABASE_URL ?? "", "DATABASE_URL");
  if (database.host === "localhost") {
    throw new Error(
      "DATABASE_URL names a loopback database, which does not exist on a " +
        "production machine. Point it at the Neon connection string.",
    );
  }

  if ((env.SESSION_JWT_SECRET ?? "").length < 32) {
    throw new Error(
      "SESSION_JWT_SECRET is shorter than 32 characters. In production the " +
        "session-signing secret must carry at least 256 bits; generate one " +
        "with: openssl rand -base64 48",
    );
  }

  if ((env.ANTHROPIC_API_KEY ?? "") === "") {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. The server-side LLM parse sweep " +
        "(spec §7.3) needs it; without the key the server would run with " +
        "receipts silently degrading to heuristic-only suggestions. In " +
        "local development the sweep just disables itself, stated at boot.",
    );
  }
}
