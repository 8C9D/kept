import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { userEvents } from "../../src/db/schema.js";
import { createTestHarness } from "../helpers/testApp.js";

/**
 * POST /api/events - batched behavioural telemetry (the owner's 2026-08-28
 * ask). The one rule this suite exists to prove above every other: userId
 * comes from the session and nowhere else, which is why "a body carrying a
 * userId is refused" gets its own test rather than being folded into the
 * happy-path assertion.
 */

const harness = createTestHarness();
afterAll(() => harness.close());

let token: string;
let userId: string;

beforeEach(async () => {
  await harness.resetDatabase();
  ({ token, userId } = await harness.signIn("events-user"));
});

/**
 * `field`/`count`/`receiptId`/`durationMs`/`appVersion` are `.optional()`
 * only (schemas.ts), never `.nullable()`: there is no PATCH for an event,
 * so "clear this key" has no meaning and an explicit null is refused like
 * any other unexpected shape. That matches what Swift's auto-synthesized
 * `Encodable` actually sends for a nil Optional property - `encodeIfPresent`
 * omits the key rather than writing `null` - so a test override of `null`
 * here means "omit this key", the same thing a real client's encoder means
 * by leaving a property nil.
 */
function validEvent(overrides: Record<string, unknown> = {}) {
  const merged: Record<string, unknown> = {
    action: "field_edited",
    occurredAt: "2026-08-28T10:00:00Z",
    client: "ios",
    field: "total",
    count: 3,
    ...overrides,
  };
  for (const [key, value] of Object.entries(merged)) {
    if (value === null) {
      delete merged[key];
    }
  }
  return merged;
}

describe("POST /api/events", () => {
  it("refuses without a session", async () => {
    const response = await harness.request(null, "POST", "/api/events", {
      events: [validEvent()],
    });
    expect(response.status).toBe(401);
    expect(await harness.db.select().from(userEvents)).toHaveLength(0);
  });

  it("accepts a batch and stores every row under the session's user id", async () => {
    const response = await harness.request(token, "POST", "/api/events", {
      events: [
        validEvent({ action: "confirm_opened", field: null, count: null }),
        validEvent({
          action: "field_edited",
          field: "total",
          count: 4,
          durationMs: 1500,
        }),
      ],
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 2 });

    const rows = await harness.db
      .select()
      .from(userEvents)
      .where(eq(userEvents.userId, userId));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.userId === userId)).toBe(true);

    const edited = rows.find((row) => row.action === "field_edited");
    expect(edited?.field).toBe("total");
    expect(edited?.count).toBe(4);
    expect(edited?.durationMs).toBe(1500);
    expect(edited?.client).toBe("ios");
    expect(edited?.occurredAt.toISOString()).toBe("2026-08-28T10:00:00.000Z");
    // received_at is server-stamped, independent of the client-claimed
    // occurred_at - the whole reason both columns exist.
    expect(edited?.receivedAt).toBeInstanceOf(Date);

    const opened = rows.find((row) => row.action === "confirm_opened");
    expect(opened?.field).toBeNull();
    expect(opened?.count).toBeNull();
  });

  it("stores an optional appVersion and defaults absent optionals to null", async () => {
    const response = await harness.request(token, "POST", "/api/events", {
      events: [validEvent({ appVersion: "1.0 (2)", field: null, count: null })],
    });
    expect(response.status).toBe(202);
    const rows = await harness.db.select().from(userEvents);
    expect(rows[0]?.appVersion).toBe("1.0 (2)");
    expect(rows[0]?.receiptId).toBeNull();
  });

  it("refuses a body that tries to carry a userId", async () => {
    const response = await harness.request(token, "POST", "/api/events", {
      events: [validEvent()],
      userId: "00000000-0000-4000-8000-000000000000",
    });
    expect(response.status).toBe(400);
    expect(await harness.db.select().from(userEvents)).toHaveLength(0);
  });

  it("refuses an event whose userId is nested inside the batch", async () => {
    const response = await harness.request(token, "POST", "/api/events", {
      events: [
        validEvent({ userId: "00000000-0000-4000-8000-000000000000" }),
      ],
    });
    expect(response.status).toBe(400);
    expect(await harness.db.select().from(userEvents)).toHaveLength(0);
  });

  it("refuses an unknown action", async () => {
    const response = await harness.request(token, "POST", "/api/events", {
      events: [validEvent({ action: "receipt_teleported" })],
    });
    expect(response.status).toBe(400);
    expect(await harness.db.select().from(userEvents)).toHaveLength(0);
  });

  it("refuses an unknown field", async () => {
    const response = await harness.request(token, "POST", "/api/events", {
      events: [validEvent({ field: "socialSecurityNumber" })],
    });
    expect(response.status).toBe(400);
    expect(await harness.db.select().from(userEvents)).toHaveLength(0);
  });

  it("refuses an empty batch", async () => {
    const response = await harness.request(token, "POST", "/api/events", {
      events: [],
    });
    expect(response.status).toBe(400);
  });

  it("refuses a batch over 50 events", async () => {
    const events = Array.from({ length: 51 }, () => validEvent());
    const response = await harness.request(token, "POST", "/api/events", {
      events,
    });
    expect(response.status).toBe(400);
    expect(await harness.db.select().from(userEvents)).toHaveLength(0);
  });

  it("accepts exactly 50 events", async () => {
    const events = Array.from({ length: 50 }, () => validEvent());
    const response = await harness.request(token, "POST", "/api/events", {
      events,
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: 50 });
  });

  it("refuses an occurredAt far in the future", async () => {
    const response = await harness.request(token, "POST", "/api/events", {
      events: [validEvent({ occurredAt: "2099-01-01T00:00:00Z" })],
    });
    expect(response.status).toBe(400);
    expect(await harness.db.select().from(userEvents)).toHaveLength(0);
  });

  it("refuses an occurredAt from before Kept could have produced one", async () => {
    const response = await harness.request(token, "POST", "/api/events", {
      events: [validEvent({ occurredAt: "1970-01-01T00:00:00Z" })],
    });
    expect(response.status).toBe(400);
    expect(await harness.db.select().from(userEvents)).toHaveLength(0);
  });

  it("accepts a receiptId naming a receipt that does not exist - by design", async () => {
    // The whole point of the missing foreign key (schema.ts): an event log
    // must never refuse to record because the row it mentions is not there.
    const ghostReceiptId = "11111111-2222-4000-8000-333333333333";
    const response = await harness.request(token, "POST", "/api/events", {
      events: [
        validEvent({
          action: "receipt_viewed",
          field: null,
          count: null,
          receiptId: ghostReceiptId,
        }),
      ],
    });
    expect(response.status).toBe(202);
    const rows = await harness.db.select().from(userEvents);
    expect(rows[0]?.receiptId).toBe(ghostReceiptId);
  });

  it("refuses an unexpected top-level key", async () => {
    const response = await harness.request(token, "POST", "/api/events", {
      events: [validEvent()],
      source: "debugger",
    });
    expect(response.status).toBe(400);
  });

  it("refuses an unexpected key inside one event (no free-form payload)", async () => {
    const response = await harness.request(token, "POST", "/api/events", {
      events: [validEvent({ value: "$45.00" })],
    });
    expect(response.status).toBe(400);
    expect(await harness.db.select().from(userEvents)).toHaveLength(0);
  });

  it("scopes writes to the session's own user, never another's", async () => {
    const other = await harness.signIn("events-other-user");

    const mine = await harness.request(token, "POST", "/api/events", {
      events: [validEvent({ action: "sign_in", field: null, count: null })],
    });
    const theirs = await harness.request(other.token, "POST", "/api/events", {
      events: [
        validEvent({ action: "sign_in", field: null, count: null }),
        validEvent({ action: "sign_out", field: null, count: null }),
      ],
    });
    expect(mine.status).toBe(202);
    expect(theirs.status).toBe(202);

    const myRows = await harness.db
      .select()
      .from(userEvents)
      .where(eq(userEvents.userId, userId));
    const theirRows = await harness.db
      .select()
      .from(userEvents)
      .where(eq(userEvents.userId, other.userId));

    expect(myRows).toHaveLength(1);
    expect(theirRows).toHaveLength(2);
    expect(myRows.every((row) => row.userId === userId)).toBe(true);
    expect(theirRows.every((row) => row.userId === other.userId)).toBe(true);
  });
});
