import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness } from "../helpers/testApp.js";

const EDGE_SECRET = "edge-secret-value-for-tests-0123456789";

const fronted = createTestHarness({ edgeSharedSecret: EDGE_SECRET });
const bare = createTestHarness();
afterAll(async () => {
  await fronted.close();
  await bare.close();
});

/**
 * Cloudflare in front of the origin is what carries the §10B rate limiter,
 * and a limiter is only as real as the origin's refusal to be reached
 * around it: Fly gives every app a public `*.fly.dev` hostname, so without
 * this header check the limiter guards one door of a two-door building.
 */
describe("edge shared secret", () => {
  beforeEach(async () => {
    await fronted.resetDatabase();
  });

  it("refuses a request that did not come through the edge, before any route runs", async () => {
    const response = await fronted.request(null, "GET", "/api/me");
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: "forbidden" } });
  });

  it("refuses the unauthenticated sign-in route too - the one a stranger with the link can reach", async () => {
    const response = await fronted.request(null, "POST", "/api/auth/apple", {
      identityToken: "apple-token:someone",
    });
    expect(response.status).toBe(403);
  });

  it("refuses a wrong secret", async () => {
    const response = await fronted.app.request("/api/me", {
      headers: { "x-kept-edge-secret": `${EDGE_SECRET}-wrong` },
    });
    expect(response.status).toBe(403);
  });

  it("lets a request carrying the secret through to the ordinary auth outcome", async () => {
    const response = await fronted.app.request("/api/me", {
      headers: { "x-kept-edge-secret": EDGE_SECRET },
    });
    // 401, not 403: the edge check passed and the session check answered.
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: { code: "unauthorized" } });
  });

  it("keeps the no-store contract on its own refusal, which no route produces", async () => {
    const response = await fronted.request(null, "GET", "/api/me");
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  /**
   * The other half: configured off, nothing changes. Without this, deleting
   * the middleware entirely would still leave every assertion above passing
   * on a harness that simply never mounted it.
   */
  it("is absent when unconfigured, so a first deploy and local dev are unaffected", async () => {
    const response = await bare.request(null, "GET", "/api/me");
    expect(response.status).toBe(401);
  });
});
