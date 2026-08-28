import { describe, expect, it, vi } from "vitest";
import { EventQueue, attachLifecycleFlush } from "../src/events.js";
import type { UserEvent } from "../src/types.js";

/**
 * events.ts's own split - a pure `EventQueue` (transport injected) and a
 * thin `attachLifecycleFlush` DOM-wiring layer with its targets injected
 * too - exists so this file needs no jsdom or real browser, matching every
 * other test in this client. `configureEventLogging`/`logEvent`/the real
 * `fetch`-based transport touch `document`/`window`/the network by design
 * and are exercised by the live click-through instead (CLAUDE.md's
 * artifact-verification rule), not here.
 */

const NOW = "2026-08-28T12:00:00.000Z";

function event(overrides: Partial<UserEvent> = {}): UserEvent {
  return { action: "sign_in", occurredAt: NOW, client: "web", ...overrides };
}

/** A transport that records every batch it was called with. */
function recordingTransport(): {
  transport: (batch: UserEvent[]) => Promise<void>;
  calls: UserEvent[][];
} {
  const calls: UserEvent[][] = [];
  return {
    calls,
    transport: async (batch) => {
      calls.push(batch);
    },
  };
}

describe("EventQueue - batching", () => {
  it("flushes automatically once the size threshold is reached", async () => {
    const { transport, calls } = recordingTransport();
    const queue = new EventQueue(transport, { flushThreshold: 3 });
    queue.enqueue(event());
    queue.enqueue(event());
    expect(queue.size).toBe(2);
    expect(calls).toHaveLength(0);
    queue.enqueue(event()); // the third - crosses the threshold
    // enqueue's threshold flush is fire-and-forget (`void this.flush()`);
    // let the microtask it kicked off run before asserting on it.
    await Promise.resolve();
    await Promise.resolve();
    expect(queue.size).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(3);
  });

  it("an over-limit enqueue never produces an over-50 request", async () => {
    const { transport, calls } = recordingTransport();
    // A threshold well past the server's 50-per-request cap, so nothing
    // auto-flushes until the explicit flush() below - the scenario this
    // test exists for: a burst that piles up past 50 before anything ever
    // sends.
    const queue = new EventQueue(transport, { flushThreshold: 1_000 });
    for (let i = 0; i < 120; i++) {
      queue.enqueue(event());
    }
    expect(queue.size).toBe(120);
    await queue.flush();
    expect(queue.size).toBe(0);
    const totalSent = calls.reduce((sum, batch) => sum + batch.length, 0);
    expect(totalSent).toBe(120);
    for (const batch of calls) {
      expect(batch.length).toBeLessThanOrEqual(50);
    }
    // 120 events, chunked at 50, is 3 requests (50 + 50 + 20) - pin the
    // exact chunking, not just the ceiling.
    expect(calls.map((batch) => batch.length)).toEqual([50, 50, 20]);
  });

  it("a failing transport never throws to the caller", async () => {
    const failing = vi.fn(async () => {
      throw new Error("the server is unreachable");
    });
    const queue = new EventQueue(failing);
    queue.enqueue(event());
    await expect(queue.flush()).resolves.toBeUndefined();
    expect(failing).toHaveBeenCalledTimes(1);
    // The queue was still drained - a lost batch is a gap in the log, not
    // something retried forever.
    expect(queue.size).toBe(0);
  });

  it("flush() is a no-op on an empty queue - never calls the transport", async () => {
    const { transport, calls } = recordingTransport();
    const queue = new EventQueue(transport);
    await queue.flush();
    expect(calls).toHaveLength(0);
  });
});

/** A fake `addEventListener`/`removeEventListener` target that records
 * listeners so a test can fire them directly - no jsdom required. */
function fakeTarget(): {
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
  fire: (type: string) => void;
  listenerCount: (type: string) => number;
} {
  const listeners = new Map<string, Set<() => void>>();
  return {
    addEventListener: (type, listener) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type, listener) => {
      listeners.get(type)?.delete(listener);
    },
    fire: (type) => {
      for (const listener of listeners.get(type) ?? []) {
        listener();
      }
    },
    listenerCount: (type) => listeners.get(type)?.size ?? 0,
  };
}

describe("attachLifecycleFlush - flush on page hide", () => {
  it("draining the queue on pagehide, so a closed tab does not lose the batch", async () => {
    const { transport, calls } = recordingTransport();
    // A threshold nothing here will reach, so the only way this batch ever
    // sends is the lifecycle listener under test.
    const queue = new EventQueue(transport, { flushThreshold: 1_000 });
    queue.enqueue(event());
    queue.enqueue(event());

    const doc = { ...fakeTarget(), visibilityState: "visible" };
    const win = fakeTarget();
    const detach = attachLifecycleFlush(queue, doc, win);

    expect(queue.size).toBe(2);
    win.fire("pagehide");
    await Promise.resolve();
    await Promise.resolve();

    expect(queue.size).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(2);

    detach();
  });

  it("also flushes on visibilitychange going to hidden, but not while visible", async () => {
    const { transport, calls } = recordingTransport();
    const queue = new EventQueue(transport, { flushThreshold: 1_000 });
    queue.enqueue(event());

    const doc = { ...fakeTarget(), visibilityState: "visible" };
    const win = fakeTarget();
    attachLifecycleFlush(queue, doc, win);

    doc.fire("visibilitychange"); // still "visible" - must not flush
    await Promise.resolve();
    expect(calls).toHaveLength(0);

    doc.visibilityState = "hidden";
    doc.fire("visibilitychange");
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toHaveLength(1);
  });

  it("the returned teardown removes both listeners and stops the timer", () => {
    const { transport } = recordingTransport();
    const queue = new EventQueue(transport);
    const doc = { ...fakeTarget(), visibilityState: "visible" };
    const win = fakeTarget();
    const detach = attachLifecycleFlush(queue, doc, win);
    expect(doc.listenerCount("visibilitychange")).toBe(1);
    expect(win.listenerCount("pagehide")).toBe(1);
    detach();
    expect(doc.listenerCount("visibilitychange")).toBe(0);
    expect(win.listenerCount("pagehide")).toBe(0);
  });
});

describe("privacy: no event payload can carry a receipt field value", () => {
  const ALLOWED_KEYS = new Set([
    "action",
    "occurredAt",
    "client",
    "appVersion",
    "field",
    "receiptId",
    "durationMs",
    "count",
  ]);
  // Mirrors server/src/domain/userEvents.ts's EVENT_FIELDS - the fixed
  // vocabulary `field` may draw from, transcribed the same way types.ts
  // transcribes everything else the server owns.
  const KNOWN_FIELDS = new Set([
    "total",
    "purchasedAt",
    "vendor",
    "hst",
    "subtotal",
    "tip",
    "otherFees",
    "category",
    "paymentMethod",
    "notes",
  ]);

  it("sends only the fixed key set - the shape of what the module actually sends, not what a comment claims", async () => {
    const sent: UserEvent[] = [];
    const queue = new EventQueue(async (batch) => {
      sent.push(...batch);
    });
    // A representative sample across this client's vocabulary, including
    // the row-types that most tempt a "just log the value too" shortcut:
    // an edited amount field, and a suggestion outcome.
    queue.enqueue(event({ action: "sign_in" }));
    queue.enqueue(
      event({
        action: "field_edited",
        field: "total",
        count: 3,
        receiptId: "r-1",
        appVersion: "6ec8ff4",
      }),
    );
    queue.enqueue(
      event({ action: "suggestion_overridden", field: "hst", receiptId: "r-1" }),
    );
    queue.enqueue(event({ action: "export_downloaded" }));
    await queue.flush();

    expect(sent.length).toBe(4);
    for (const sentEvent of sent) {
      for (const key of Object.keys(sentEvent)) {
        expect(ALLOWED_KEYS.has(key)).toBe(true);
      }
      if (sentEvent.field !== undefined) {
        expect(KNOWN_FIELDS.has(sentEvent.field)).toBe(true);
      }
    }
  });

  it("the UserEvent type has no field for a receipt value - a stray key fails to compile", () => {
    // This only passes `tsc` if the assignment below is a genuine type
    // error: `UserEvent` (types.ts) has no index signature, so TypeScript's
    // excess-property check on this object literal is what pins "no value
    // key, ever" at the type level, not just at runtime.
    const illegal: UserEvent = {
      action: "field_edited",
      occurredAt: NOW,
      client: "web",
      field: "total",
      // @ts-expect-error - `value` is not, and must never become, a key
      // UserEvent can carry.
      value: 4999,
    };
    expect(illegal).toBeDefined();
  });
});
