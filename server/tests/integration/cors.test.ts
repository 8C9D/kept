import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "../helpers/testApp.js";

/**
 * CORS for the web client (wave 7), through the real app rather than the
 * middleware in isolation. The properties that matter:
 *
 *   - exactly the configured origins are granted, nothing reflected;
 *   - a deployment with no WEB_ORIGIN grants nothing at all (today's
 *     production, and every deployment before the web client existed);
 *   - the grant carries the methods and headers the web client uses -
 *     PATCH for inline edits, Authorization for the bearer token;
 *   - no credentials grant, because the token travels in a header.
 */

const WEB_ORIGIN = "https://keptapp.net";
const EVIL_ORIGIN = "https://evil.example";

describe("CORS for the web client", () => {
  let harness: TestHarness;
  let bare: TestHarness;

  beforeAll(() => {
    harness = createTestHarness({ webOrigins: [WEB_ORIGIN] });
    bare = createTestHarness();
  });
  afterAll(async () => {
    await harness.close();
    await bare.close();
  });

  it("answers a preflight for the configured origin with the client's methods and headers", async () => {
    const response = await harness.app.request("/api/receipts", {
      method: "OPTIONS",
      headers: {
        Origin: WEB_ORIGIN,
        "Access-Control-Request-Method": "PATCH",
        "Access-Control-Request-Headers": "authorization,content-type",
      },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe(WEB_ORIGIN);
    expect(response.headers.get("access-control-allow-methods")).toContain("PATCH");
    expect(
      response.headers.get("access-control-allow-headers")?.toLowerCase(),
    ).toContain("authorization");
    // The bearer token is a header, never a cookie; a credentials grant
    // would be an affordance nothing uses.
    expect(response.headers.get("access-control-allow-credentials")).toBeNull();
  });

  /**
   * Regression, 2026-08-28. `PUT /api/receipts/:id/images/:page` (replacing a
   * page's image) was the API's first PUT route, and `allowMethods` was not
   * updated with it. The route worked perfectly under curl - which sends no
   * preflight - and was dead from the web client, because the browser's
   * preflight was refused before the request was ever made. A missing method
   * here is invisible to every test that calls the app directly, which is why
   * this one goes through OPTIONS.
   */
  it("allows every method the API's routes actually use, PUT included", async () => {
    for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
      const response = await harness.app.request("/api/receipts", {
        method: "OPTIONS",
        headers: {
          Origin: WEB_ORIGIN,
          "Access-Control-Request-Method": method,
          "Access-Control-Request-Headers": "authorization,content-type",
        },
      });
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-methods")).toContain(
        method,
      );
    }
  });

  it("marks an actual response for the configured origin", async () => {
    const response = await harness.app.request("/api/me", {
      headers: { Origin: WEB_ORIGIN },
    });
    // 401 - no session - and the CORS grant must still be present, or the
    // browser hides the status and the web client cannot even show
    // "signed out".
    expect(response.status).toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBe(WEB_ORIGIN);
  });

  it("grants nothing to an unconfigured origin", async () => {
    const preflight = await harness.app.request("/api/receipts", {
      method: "OPTIONS",
      headers: {
        Origin: EVIL_ORIGIN,
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(preflight.headers.get("access-control-allow-origin")).toBeNull();

    const response = await harness.app.request("/api/me", {
      headers: { Origin: EVIL_ORIGIN },
    });
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("grants nothing at all when no web origin is configured", async () => {
    // Today's production shape, and the iOS-only shape forever: no
    // WEB_ORIGIN, no CORS surface, exactly as before wave 7.
    const response = await bare.app.request("/api/me", {
      headers: { Origin: WEB_ORIGIN },
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});
