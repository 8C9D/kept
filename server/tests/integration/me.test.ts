import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness } from "../helpers/testApp.js";

const harness = createTestHarness();
afterAll(() => harness.close());

describe("/api/me", () => {
  let token: string;

  beforeEach(async () => {
    await harness.resetDatabase();
    ({ token } = await harness.signIn("me-user", "Me User"));
  });

  it("returns the profile with the default Dec 31 fiscal year end", async () => {
    const response = await harness.request(token, "GET", "/api/me");
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.displayName).toBe("Me User");
    expect(body.fiscalYearEndMonth).toBe(12);
    expect(body.fiscalYearEndDay).toBe(31);
    expect(body).not.toHaveProperty("appleSub");
    expect(body).not.toHaveProperty("apple_sub");
  });

  it("updates the fiscal year end", async () => {
    const response = await harness.request(token, "PATCH", "/api/me", {
      fiscalYearEndMonth: 3,
      fiscalYearEndDay: 31,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.fiscalYearEndMonth).toBe(3);
    expect(body.fiscalYearEndDay).toBe(31);
  });

  it("rejects a fiscal year end that names no real day", async () => {
    const response = await harness.request(token, "PATCH", "/api/me", {
      fiscalYearEndMonth: 2,
      fiscalYearEndDay: 30,
    });
    expect(response.status).toBe(400);
  });

  it("validates a partial update against the stored other half", async () => {
    // Stored default is day 31; June has no 31st, so month alone must fail.
    const response = await harness.request(token, "PATCH", "/api/me", {
      fiscalYearEndMonth: 6,
    });
    expect(response.status).toBe(400);
  });

  it("rejects out-of-range values outright", async () => {
    const response = await harness.request(token, "PATCH", "/api/me", {
      fiscalYearEndMonth: 13,
      fiscalYearEndDay: 1,
    });
    expect(response.status).toBe(400);
  });
});
