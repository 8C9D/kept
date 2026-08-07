import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  createTestHarness,
  imageFor,
  receiptBody,
} from "../helpers/testApp.js";

/**
 * Request bodies are bounded before any handler runs (security review,
 * August 2026). The route reachable without a session is the one that
 * matters: anyone holding the unlisted install link can reach
 * POST /api/auth/apple, and without a limit the server buffers whatever
 * they send before verification gets a chance to reject it.
 */
const harness = createTestHarness();
afterAll(() => harness.close());

/** Comfortably past the 1 MiB limit, cheap to build. */
const OVERSIZED = "A".repeat(2 * 1024 * 1024);

describe("request body limits", () => {
  let token: string;
  let userId: string;

  beforeEach(async () => {
    await harness.resetDatabase();
    ({ token, userId } = await harness.signIn("body-limit-user"));
  });

  it("refuses an oversized body on the unauthenticated auth route", async () => {
    const response = await harness.request(null, "POST", "/api/auth/apple", {
      identityToken: OVERSIZED,
    });
    expect(response.status).toBe(413);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("request_too_large");
  });

  it("refuses an oversized body on an authenticated route", async () => {
    const response = await harness.request(token, "POST", "/api/receipts", {
      ...receiptBody({ image: imageFor(userId, "a".repeat(64)) }),
      notes: OVERSIZED,
    });
    expect(response.status).toBe(413);
  });

  it("still accepts a create at the schemas' own maximum size", async () => {
    // The limit is derived from the schema caps, so it must not be able to
    // refuse a request the schemas would accept. This is the test that
    // fails if the limit is ever set too low. U+0001 is the worst case the
    // caps allow: one character to zod's .max(), six bytes on the wire.
    const escapeHeavy = "\u0001".repeat(100_000);
    const response = await harness.request(token, "POST", "/api/receipts", {
      ...receiptBody({ image: imageFor(userId, "b".repeat(64)) }),
      ocrRawText: escapeHeavy,
      notes: "n".repeat(5_000),
      vendor: "v".repeat(200),
      vendorTaxNumber: "t".repeat(50),
      category: "c".repeat(200),
      paymentMethod: "p".repeat(100),
    });
    expect(response.status).toBe(201);
  });

  it("leaves ordinary requests untouched", async () => {
    const response = await harness.request(token, "GET", "/api/receipts");
    expect(response.status).toBe(200);
  });
});
