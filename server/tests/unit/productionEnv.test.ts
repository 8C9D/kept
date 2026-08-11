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
  // ⚠ Carries `?sslmode=require`, as every real Neon connection string does.
  // It did NOT until round 3, and that omission was the finding (R2-4) sitting
  // in the fixture that was supposed to represent a correct production shape.
  DATABASE_URL:
    "postgres://kept:pw@ep-example-123.us-east-2.aws.neon.tech/kept?sslmode=require",
  SESSION_JWT_SECRET: "s".repeat(48),
  APPLE_CLIENT_ID: "com.arthurzhang.kept",
  ANTHROPIC_API_KEY: "sk-ant-test-key",
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

  it("refuses a database URL that does not require TLS, as it does an http storage endpoint", () => {
    // R2-4. The same function required https of STORAGE_ENDPOINT and asked
    // nothing of DATABASE_URL eight lines later, though the connection carries
    // the same receipts: vendor, HST, the supplier's GST/HST number, notes and
    // ocr_raw_text. `pg` negotiates no TLS on its own - measured, a URL with
    // no sslmode yields `pool.options.ssl === undefined`.
    //
    // Falsification, predicted then run:
    //   Predicted: with the requiresTls check removed from productionEnv.ts,
    //   every case below fails, because each URL would be accepted.
    //   Actual: it fails on the FIRST url and stops, at :97 -
    //   "postgres://kept:pw@ep-example.neon.tech/kept: expected [Function] to
    //   throw an error". Gap, recorded: vitest reports one failure per case,
    //   so the loop pins four rejections and falsifies visibly on one. The url
    //   passed as the assertion label is what makes which one legible.
    for (const url of [
      // No sslmode at all: the shape this fixture itself carried until round 3.
      "postgres://kept:pw@ep-example.neon.tech/kept",
      // Explicitly off.
      "postgres://kept:pw@ep-example.neon.tech/kept?sslmode=disable",
      // ⚠ The two that matter most. libpq's `prefer` and `allow` both fall
      // back to CLEARTEXT when the server declines, so accepting them would
      // make this check decorative against exactly the silent downgrade it
      // exists to catch.
      "postgres://kept:pw@ep-example.neon.tech/kept?sslmode=prefer",
      "postgres://kept:pw@ep-example.neon.tech/kept?sslmode=allow",
    ]) {
      expect(
        () => assertProductionEnv({ ...PRODUCTION, DATABASE_URL: url }),
        url,
      ).toThrow(/does not require TLS/);
    }

    // And the spellings that do encrypt are accepted, so this cannot be
    // satisfied by a check that refuses every URL.
    for (const url of [
      "postgres://kept:pw@ep-example.neon.tech/kept?sslmode=require",
      "postgres://kept:pw@ep-example.neon.tech/kept?sslmode=verify-full",
      "postgres://kept:pw@ep-example.neon.tech/kept?sslmode=VERIFY-CA",
      "postgres://kept:pw@ep-example.neon.tech/kept?ssl=true",
    ]) {
      expect(
        () => assertProductionEnv({ ...PRODUCTION, DATABASE_URL: url }),
        url,
      ).not.toThrow();
    }
  });

  it("refuses a session secret shorter than 32 characters", () => {
    const env = { ...PRODUCTION, SESSION_JWT_SECRET: "short-dev-secret" };
    expect(() => assertProductionEnv(env)).toThrow(/at least 256 bits/);
  });

  it("refuses a missing ANTHROPIC_API_KEY, which would be silent LLM-parse loss", () => {
    expect(() => assertProductionEnv(withoutKeys("ANTHROPIC_API_KEY"))).toThrow(
      /ANTHROPIC_API_KEY/,
    );
    expect(() =>
      assertProductionEnv({ ...PRODUCTION, ANTHROPIC_API_KEY: "" }),
    ).toThrow(/ANTHROPIC_API_KEY/);
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
