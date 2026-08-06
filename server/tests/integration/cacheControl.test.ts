import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness } from "../helpers/testApp.js";

const harness = createTestHarness();
afterAll(() => harness.close());

// API responses are live state; a cached one served offline shows a person
// stale data dressed as current (wave-5 device diagnostic: iOS answered an
// offline pull-to-refresh from its heuristic HTTP cache because these
// responses carried no cache directive). The header is the contract every
// client inherits, so it is asserted on both outcomes a client sees.
describe("Cache-Control", () => {
  let token: string;

  beforeEach(async () => {
    await harness.resetDatabase();
    ({ token } = await harness.signIn("cache-user", "Cache User"));
  });

  it("marks successful API responses no-store", async () => {
    const response = await harness.request(token, "GET", "/api/receipts");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("marks error responses no-store too", async () => {
    const response = await harness.request(null, "GET", "/api/me");
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
