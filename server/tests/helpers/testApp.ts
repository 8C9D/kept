import type { Hono } from "hono";
import { createApp } from "../../src/app.js";
import { createSessionTokens } from "../../src/auth/session.js";
import { LOCAL_DEV_DATABASE_URL, createDb } from "../../src/db/client.js";
import {
  exportJobs,
  receiptImages,
  receipts,
  users,
} from "../../src/db/schema.js";
import { fakeAppleVerifier } from "./fakeAppleVerifier.js";
import {
  fakeObjectStorage,
  type FakeObjectStorage,
} from "./fakeObjectStorage.js";

const TEST_DATABASE_URL = process.env.DATABASE_URL ?? LOCAL_DEV_DATABASE_URL;
const TEST_SESSION_SECRET = "test-session-secret-0123456789abcdef";

export interface TestHarness {
  app: Hono;
  db: ReturnType<typeof createDb>["db"];
  storage: FakeObjectStorage;
  /** Empties all tables; call before each test for a known-blank slate. */
  resetDatabase(): Promise<void>;
  /** Signs in through the real auth route. */
  signIn(
    appleSub: string,
    displayName?: string,
  ): Promise<{ token: string; userId: string }>;
  /** GET/POST/PATCH/DELETE with a session token attached. */
  request(
    token: string | null,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<Response>;
  close(): Promise<void>;
}

export function createTestHarness(): TestHarness {
  const { db, pool } = createDb(TEST_DATABASE_URL);
  const storage = fakeObjectStorage();
  const app = createApp({
    db,
    appleVerifier: fakeAppleVerifier(),
    sessionTokens: createSessionTokens(TEST_SESSION_SECRET),
    storage,
  });

  return {
    app,
    db,
    storage,

    async resetDatabase() {
      // Child tables first; no CASCADE so an unexpected new table cannot be
      // silently emptied.
      await db.delete(receiptImages);
      await db.delete(receipts);
      await db.delete(exportJobs);
      await db.delete(users);
      storage.objects.clear();
    },

    async signIn(appleSub: string, displayName?: string) {
      const response = await this.request(null, "POST", "/api/auth/apple", {
        identityToken: `apple-token:${appleSub}`,
        ...(displayName !== undefined && { displayName }),
      });
      if (response.status !== 200) {
        throw new Error(`Test sign-in failed with status ${response.status}`);
      }
      const body = (await response.json()) as {
        token: string;
        user: { id: string };
      };
      return { token: body.token, userId: body.user.id };
    },

    async request(
      token: string | null,
      method: string,
      path: string,
      body?: unknown,
    ): Promise<Response> {
      const headers: Record<string, string> = {};
      if (token !== null) {
        headers.Authorization = `Bearer ${token}`;
      }
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
      }
      return app.request(path, {
        method,
        headers,
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    },

    async close() {
      await pool.end();
    },
  };
}

/** A valid create-receipt body; override fields per test. */
export function receiptBody(overrides: Record<string, unknown> = {}) {
  return {
    purchasedAt: "2026-03-15",
    capturedAt: "2026-03-15T18:30:00Z",
    vendor: "Test Vendor",
    totalCents: 11300,
    subtotalCents: 10000,
    hstCents: 1300,
    isBusiness: true,
    image: {
      objectKey: "OVERRIDE-ME/2026/03/image.jpg",
      sha256: "a".repeat(64),
    },
    ...overrides,
  };
}

/** An image sub-object whose objectKey is owned by the given user. */
export function imageFor(userId: string, sha256: string) {
  return {
    objectKey: `${userId}/2026/03/${sha256.slice(0, 8)}.jpg`,
    sha256,
  };
}
