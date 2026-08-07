import { describe, expect, it } from "vitest";
import { assertProductionEnv } from "../../src/productionEnv.js";

/**
 * The deployed shape, asserted as configuration.
 *
 * Each case here is a configuration under which the server would start and
 * serve while being quietly wrong in production - the failure would surface
 * as a broken image upload, a cleartext presigned URL, or a database that
 * is not there, rather than as a refusal at boot. This is the wave-6
 * kickoff's "prefer configuration that fails loudly at startup" applied to
 * the deployment.
 */

const PRODUCTION: Record<string, string> = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://kept:pw@ep-example-123.us-east-2.aws.neon.tech/kept",
  SESSION_JWT_SECRET: "s".repeat(48),
  APPLE_CLIENT_ID: "com.arthurzhang.kept",
  STORAGE_ENDPOINT: "https://accountid.r2.cloudflarestorage.com",
  STORAGE_BUCKET: "kept",
  STORAGE_ACCESS_KEY_ID: "r2-access-key",
  STORAGE_SECRET_ACCESS_KEY: "r2-secret-key",
};

function withoutKeys(...names: string[]): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...PRODUCTION };
  for (const name of names) {
    delete env[name];
  }
  return env;
}

describe("assertProductionEnv", () => {
  it("accepts a fully production-shaped environment", () => {
    expect(() => assertProductionEnv(PRODUCTION)).not.toThrow();
  });

  it("refuses production with no storage configured rather than falling back to local MinIO", () => {
    const env = withoutKeys(
      "STORAGE_ENDPOINT",
      "STORAGE_BUCKET",
      "STORAGE_ACCESS_KEY_ID",
      "STORAGE_SECRET_ACCESS_KEY",
    );
    expect(() => assertProductionEnv(env)).toThrow(/no STORAGE_\* variables/);
  });

  it("refuses partially configured storage, naming what is missing", () => {
    const env = withoutKeys("STORAGE_SECRET_ACCESS_KEY");
    expect(() => assertProductionEnv(env)).toThrow(
      /partially configured.*STORAGE_SECRET_ACCESS_KEY/s,
    );
  });

  it("refuses a plain-http storage endpoint, because presigned URLs inherit it", () => {
    const env = { ...PRODUCTION, STORAGE_ENDPOINT: "http://minio.internal:9000" };
    expect(() => assertProductionEnv(env)).toThrow(/must be https in production/);
  });

  it("refuses a loopback database URL, which names nothing on a deployed machine", () => {
    const env = { ...PRODUCTION, DATABASE_URL: "postgres://kept:kept@localhost:5432/kept" };
    expect(() => assertProductionEnv(env)).toThrow(/loopback database/);
  });

  it("refuses a session secret shorter than 32 characters", () => {
    const env = { ...PRODUCTION, SESSION_JWT_SECRET: "short-dev-secret" };
    expect(() => assertProductionEnv(env)).toThrow(/at least 256 bits/);
  });

  /**
   * The other half, and not a formality: a check that fired everywhere
   * would make `npm run dev` demand R2 credentials to serve a laptop, and
   * the pressure to weaken it would land on the production case.
   */
  it("checks nothing outside production, so local development keeps its MinIO fallback", () => {
    const dev = {
      DATABASE_URL: "postgres://kept:kept@localhost:5432/kept",
      SESSION_JWT_SECRET: "dev",
      APPLE_CLIENT_ID: "com.arthurzhang.kept",
    };
    expect(() => assertProductionEnv(dev)).not.toThrow();
    expect(() => assertProductionEnv({ ...dev, NODE_ENV: "development" })).not.toThrow();
  });
});
