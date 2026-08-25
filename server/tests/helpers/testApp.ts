import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { createApp } from "../../src/app.js";
import { createSessionTokens } from "../../src/auth/session.js";
import { createDb } from "../../src/db/client.js";
import {
  assertSeparateTestDatabase,
  resolveDevDatabaseUrl,
  resolveTestDatabaseUrl,
} from "./testDatabase.js";
import {
  exportJobs,
  receiptImages,
  receipts,
  users,
} from "../../src/db/schema.js";
import type { LlmParseSweepHandle } from "../../src/parse/llmParseSweep.js";
import {
  fakeAppleTokenRevoker,
  type FakeAppleTokenRevoker,
} from "./fakeAppleTokenRevoker.js";
import { fakeAppleVerifier } from "./fakeAppleVerifier.js";
import {
  fakeObjectStorage,
  type FakeObjectStorage,
} from "./fakeObjectStorage.js";

// Guarded here as well as in globalSetup: a harness constructed outside
// vitest (a future script, a REPL) must hit the same refusal.
const TEST_DATABASE_URL = resolveTestDatabaseUrl(process.env);
assertSeparateTestDatabase(TEST_DATABASE_URL, resolveDevDatabaseUrl(process.env));
/**
 * Exported so a test can sign a token this app will genuinely VERIFY, which is
 * the only way to exercise what happens after verification succeeds (PR-12).
 * A locally-minted garbage token is rejected before it gets there.
 */
export const TEST_SESSION_SECRET = "test-session-secret-0123456789abcdef";

export interface TestHarness {
  app: Hono;
  db: ReturnType<typeof createDb>["db"];
  storage: FakeObjectStorage;
  /**
   * Present unless the harness was built with `appleTokenRevoker: false`,
   * which is how a test reaches the unconfigured-key branch of account
   * deletion.
   */
  appleTokenRevoker: FakeAppleTokenRevoker | undefined;
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

export function createTestHarness(
  options: {
    edgeSharedSecret?: string;
    llmParseSweep?: LlmParseSweepHandle;
    webOrigins?: readonly string[];
    /** False builds an app with no revoker, as an unconfigured key would. */
    appleTokenRevoker?: false;
  } = {},
): TestHarness {
  const { db, pool } = createDb(TEST_DATABASE_URL);
  const storage = fakeObjectStorage();
  const revoker =
    options.appleTokenRevoker === false ? undefined : fakeAppleTokenRevoker();
  const app = createApp({
    db,
    appleVerifier: fakeAppleVerifier(),
    sessionTokens: createSessionTokens(TEST_SESSION_SECRET),
    storage,
    ...(revoker !== undefined && { appleTokenRevoker: revoker }),
    ...(options.edgeSharedSecret !== undefined && {
      edgeSharedSecret: options.edgeSharedSecret,
    }),
    ...(options.llmParseSweep !== undefined && {
      llmParseSweep: options.llmParseSweep,
    }),
    ...(options.webOrigins !== undefined && {
      webOrigins: options.webOrigins,
    }),
  });

  return {
    app,
    db,
    storage,
    appleTokenRevoker: revoker,

    async resetDatabase() {
      // Child tables first; no CASCADE so an unexpected new table cannot be
      // silently emptied.
      await db.delete(receiptImages);
      await db.delete(receipts);
      await db.delete(exportJobs);
      await db.delete(users);
      storage.objects.clear();
      if (revoker !== undefined) {
        revoker.codes.length = 0;
        revoker.failure = undefined;
      }
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

/**
 * An image sub-object whose objectKey is owned by the given user, in
 * exactly the shape POST /api/receipts/upload-url issues - which is the
 * only shape the create route accepts.
 */
export function imageFor(userId: string, sha256: string) {
  return {
    objectKey: `${userId}/2026/03/${randomUUID()}.jpg`,
    sha256,
  };
}
