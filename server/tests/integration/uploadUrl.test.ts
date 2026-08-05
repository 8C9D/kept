import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestHarness } from "../helpers/testApp.js";

const harness = createTestHarness();
afterAll(() => harness.close());

describe("POST /api/receipts/upload-url", () => {
  let token: string;
  let userId: string;

  beforeEach(async () => {
    await harness.resetDatabase();
    ({ token, userId } = await harness.signIn("upload-user"));
  });

  it("issues a key under the session user's prefix and a matching URL", async () => {
    const response = await harness.request(
      token,
      "POST",
      "/api/receipts/upload-url",
      { contentType: "image/jpeg" },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      objectKey: string;
      uploadUrl: string;
    };
    expect(body.objectKey.startsWith(`${userId}/`)).toBe(true);
    expect(body.objectKey.endsWith(".jpg")).toBe(true);
    expect(body.uploadUrl).toContain(body.objectKey);
  });

  it("issues distinct keys for repeated requests", async () => {
    const first = await harness.request(token, "POST",
      "/api/receipts/upload-url",
      { contentType: "application/pdf" },
    );
    const second = await harness.request(token, "POST",
      "/api/receipts/upload-url",
      { contentType: "application/pdf" },
    );
    const a = (await first.json()) as { objectKey: string };
    const b = (await second.json()) as { objectKey: string };
    expect(a.objectKey).not.toBe(b.objectKey);
  });

  it("rejects a content type the clients never send", async () => {
    const response = await harness.request(
      token,
      "POST",
      "/api/receipts/upload-url",
      { contentType: "image/gif" },
    );
    expect(response.status).toBe(400);
  });
});
