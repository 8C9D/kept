import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AppleRevocationError } from "../../src/auth/appleTokenRevoker.js";
import {
  exportJobs,
  receiptFieldOptions,
  receiptImages,
  receipts,
  userEvents,
  users,
} from "../../src/db/schema.js";
import { exportObjectKey } from "../../src/storage/objectKeys.js";
import {
  createTestHarness,
  imageFor,
  receiptBody,
} from "../helpers/testApp.js";

const harness = createTestHarness();
afterAll(() => harness.close());

/** The bytes a client would have PUT to the presigned URL. */
const IMAGE_BYTES = new Uint8Array([1, 2, 3, 4]);

/**
 * Create a receipt and put its image in storage, the way the real flow does
 * in two steps: the API records where the object landed, the client PUTs the
 * bytes there directly (spec §6 - images never transit the API, so nothing
 * server-side would have written them).
 */
async function captureReceipt(
  token: string,
  userId: string,
  sha256: string,
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; objectKey: string }> {
  const image = imageFor(userId, sha256);
  const response = await harness.request(
    token,
    "POST",
    "/api/receipts",
    receiptBody({ image, ...overrides }),
  );
  if (response.status !== 201) {
    throw new Error(`Test capture failed with status ${response.status}`);
  }
  const { id } = (await response.json()) as { id: string };
  harness.storage.objects.set(image.objectKey, IMAGE_BYTES);
  return { id, objectKey: image.objectKey };
}

/**
 * Log one behavioural event through the real route (spec: "action logging
 * for all user actions" - 2026-08-28). No field value is ever sent; this
 * exists only to prove `DELETE /api/me` also destroys the log, not to
 * exercise the logging endpoint itself (events.test.ts owns that).
 */
async function logEvent(token: string): Promise<void> {
  const response = await harness.request(token, "POST", "/api/events", {
    events: [
      {
        action: "field_edited",
        occurredAt: new Date().toISOString(),
        client: "ios",
        field: "total",
        count: 3,
      },
    ],
  });
  if (response.status !== 202) {
    throw new Error(`Test event log failed with status ${response.status}`);
  }
}

/** A completed export job with its zip in storage. */
async function completedExport(userId: string): Promise<string> {
  const inserted = await harness.db
    .insert(exportJobs)
    .values({
      userId,
      status: "complete",
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31",
      completedAt: new Date(),
    })
    .returning({ id: exportJobs.id });
  const jobId = inserted[0]?.id;
  if (jobId === undefined) {
    throw new Error("Test export job insert returned no row");
  }
  const objectKey = exportObjectKey(userId, jobId, "Receipts-2026.zip");
  await harness.db
    .update(exportJobs)
    .set({ objectKey })
    .where(eq(exportJobs.id, jobId));
  harness.storage.objects.set(objectKey, IMAGE_BYTES);
  return objectKey;
}

describe("DELETE /api/me (account deletion)", () => {
  let token: string;
  let userId: string;

  beforeEach(async () => {
    await harness.resetDatabase();
    ({ token, userId } = await harness.signIn("deleting-user", "Deleting User"));
  });

  it("refuses without a session", async () => {
    const response = await harness.request(null, "DELETE", "/api/me");
    expect(response.status).toBe(401);
    // And nothing moved: an unauthenticated DELETE must not be a way to
    // discover, let alone remove, anything.
    const remaining = await harness.db.select().from(users);
    expect(remaining).toHaveLength(1);
  });

  it("removes every row and every object the account owned", async () => {
    // One confirmed receipt, one pending, and one the person already
    // soft-deleted: all three are the account's, and retention - which is
    // what the tombstone records - is exactly what this request revokes.
    const confirmed = await captureReceipt(token, userId, "a".repeat(64));
    const pending = await captureReceipt(token, userId, "b".repeat(64), {
      status: "pending",
      totalCents: null,
    });
    const tombstoned = await captureReceipt(token, userId, "c".repeat(64));
    expect(
      (await harness.request(token, "DELETE", `/api/receipts/${tombstoned.id}`))
        .status,
    ).toBe(204);
    const exportKey = await completedExport(userId);
    await logEvent(token);
    await logEvent(token);

    const response = await harness.request(token, "DELETE", "/api/me", {
      appleAuthorizationCode: "fresh-code-from-reauthorization",
    });
    expect(response.status).toBe(204);

    // The database, read directly rather than through the API: an endpoint
    // that answers 404 proves visibility, not absence.
    expect(await harness.db.select().from(users)).toHaveLength(0);
    expect(await harness.db.select().from(receipts)).toHaveLength(0);
    expect(await harness.db.select().from(receiptImages)).toHaveLength(0);
    expect(await harness.db.select().from(exportJobs)).toHaveLength(0);
    // The behavioural log, too: leaving it behind would be a broken promise
    // to the person who asked to be deleted (2026-08-28 logging feature).
    expect(await harness.db.select().from(userEvents)).toHaveLength(0);
    // And their remembered vendors, categories and payment methods
    // (2026-09-01) - a table of the person's own words, which is exactly
    // the kind of thing a deletion is expected to take with it.
    expect(await harness.db.select().from(receiptFieldOptions)).toHaveLength(0);

    // And the bytes, read out of the store the same way.
    expect(harness.storage.objects.has(confirmed.objectKey)).toBe(false);
    expect(harness.storage.objects.has(pending.objectKey)).toBe(false);
    expect(harness.storage.objects.has(tombstoned.objectKey)).toBe(false);
    expect(harness.storage.objects.has(exportKey)).toBe(false);
    expect(harness.storage.objects.size).toBe(0);
  });

  it("kills the session it was called with, without a token_version bump", async () => {
    expect(
      (await harness.request(token, "DELETE", "/api/me")).status,
    ).toBe(204);
    // The token is still cryptographically valid; it names a user row that
    // is not there, which sessionAuth treats as a dead session.
    const after = await harness.request(token, "GET", "/api/me");
    expect(after.status).toBe(401);
  });

  it("touches nothing belonging to another account", async () => {
    const other = await harness.signIn("surviving-user", "Surviving User");
    const theirs = await captureReceipt(
      other.token,
      other.userId,
      "d".repeat(64),
    );
    const theirExport = await completedExport(other.userId);
    const mine = await captureReceipt(token, userId, "e".repeat(64));
    await logEvent(other.token);
    await logEvent(token);

    expect(
      (await harness.request(token, "DELETE", "/api/me")).status,
    ).toBe(204);

    // Theirs, entirely intact - row, image row, export job, event, and bytes.
    const survivingUsers = await harness.db.select().from(users);
    expect(survivingUsers.map((row) => row.id)).toEqual([other.userId]);
    const survivingReceipts = await harness.db.select().from(receipts);
    expect(survivingReceipts.map((row) => row.id)).toEqual([theirs.id]);
    expect(await harness.db.select().from(receiptImages)).toHaveLength(1);
    expect(await harness.db.select().from(exportJobs)).toHaveLength(1);
    const survivingEvents = await harness.db.select().from(userEvents);
    expect(survivingEvents.map((row) => row.userId)).toEqual([other.userId]);
    const survivingOptions = await harness.db
      .select()
      .from(receiptFieldOptions);
    expect(
      [...new Set(survivingOptions.map((row) => row.userId))],
    ).toEqual([other.userId]);
    expect(survivingOptions.length).toBeGreaterThan(0);
    expect(harness.storage.objects.has(theirs.objectKey)).toBe(true);
    expect(harness.storage.objects.has(theirExport)).toBe(true);
    // Mine, gone.
    expect(harness.storage.objects.has(mine.objectKey)).toBe(false);

    // And their session still works, which is the property the row counts
    // above only imply.
    const theirProfile = await harness.request(other.token, "GET", "/api/me");
    expect(theirProfile.status).toBe(200);
  });

  it("forwards the client's authorization code to Apple's revocation", async () => {
    const response = await harness.request(token, "DELETE", "/api/me", {
      appleAuthorizationCode: "c-abc123",
    });
    expect(response.status).toBe(204);
    expect(harness.appleTokenRevoker?.codes).toEqual(["c-abc123"]);
  });

  it("deletes the account anyway when Apple refuses the revocation", async () => {
    // Apple's own guidance: fulfil the deletion request even when the tokens
    // cannot be revoked. Refusing to delete because appleid.apple.com
    // answered 400 would deny the person the thing the guideline grants.
    const revoker = harness.appleTokenRevoker;
    if (revoker === undefined) {
      throw new Error("The default harness must carry a revoker");
    }
    revoker.failure = new AppleRevocationError(
      "Apple answered 400 at https://appleid.apple.com/auth/token: invalid_grant",
    );
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await harness.request(token, "DELETE", "/api/me", {
        appleAuthorizationCode: "c-expired",
      });
      expect(response.status).toBe(204);
      expect(await harness.db.select().from(users)).toHaveLength(0);
      // Loud, not silent: the whole point of the branch is that a stopped
      // revocation is visible from the outside. And the line is emitted
      // AFTER the commit, so "Account deleted" is a fact when it is said.
      expect(logged.mock.calls.flat().join(" ")).toContain(
        "Account deleted without revoking Apple tokens: Apple refused or " +
          "could not be reached",
      );
    } finally {
      logged.mockRestore();
    }
  });

  it("says so when the client sends no authorization code", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await harness.request(token, "DELETE", "/api/me");
      expect(response.status).toBe(204);
      expect(logged.mock.calls.flat().join(" ")).toContain(
        "no appleAuthorizationCode",
      );
    } finally {
      logged.mockRestore();
    }
  });

  it("refuses a body carrying a user id, and deletes nothing", async () => {
    // The most attractive place in the API to smuggle one in. The schema is
    // strict, so it is a 400 rather than something quietly ignored - and the
    // account is still there afterwards.
    const response = await harness.request(token, "DELETE", "/api/me", {
      userId: "00000000-0000-4000-8000-000000000000",
    });
    expect(response.status).toBe(400);
    expect(await harness.db.select().from(users)).toHaveLength(1);
  });

  it("refuses a body that is not JSON, and deletes nothing", async () => {
    const response = await harness.app.request("/api/me", {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "not json",
    });
    expect(response.status).toBe(400);
    expect(await harness.db.select().from(users)).toHaveLength(1);
  });
});

describe("DELETE /api/me with no Apple key configured", () => {
  const unconfigured = createTestHarness({ appleTokenRevoker: false });
  afterAll(() => unconfigured.close());

  it("still deletes the account, and states the gap", async () => {
    await unconfigured.resetDatabase();
    const { token } = await unconfigured.signIn("no-key-user");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await unconfigured.request(token, "DELETE", "/api/me", {
        appleAuthorizationCode: "c-unused",
      });
      expect(response.status).toBe(204);
      expect(await unconfigured.db.select().from(users)).toHaveLength(0);
      expect(logged.mock.calls.flat().join(" ")).toContain(
        "no Sign in with Apple key is configured",
      );
    } finally {
      logged.mockRestore();
    }
  });
});
