import { API_ORIGIN } from "./api.js";
import type { PostEventsRequest, UserEvent } from "./types.js";

/**
 * The action-logging client for POST /api/events (the owner's 2026-08-28 ask;
 * server/src/routes/events.ts carries the endpoint's own contract, which
 * this module exists to honour on the sending side):
 *
 * 1. Fire and forget. Nothing here ever blocks a user action, retries
 *    aggressively, or lets a rejection escape into the UI - a telemetry
 *    post that makes a save feel slow, or that pops an error at someone
 *    confirming a receipt, is worse than no telemetry.
 * 2. A strict 400 is an acceptable outcome - if this client ever sends an
 *    action name an older deployed server does not know, the correct thing
 *    to lose is the telemetry, not the capture.
 * 3. No field values, ever - enforced structurally by `UserEvent`
 *    (types.ts) having no key that could carry one, not by this module
 *    remembering not to add one.
 *
 * Split into a pure queue (`EventQueue`, transport injected) and a thin
 * browser-wiring layer (`attachLifecycleFlush`, `configureEventLogging`,
 * `logEvent`) on purpose: the queue and its batching decisions are exactly
 * the part worth pinning with a test, and a test that needs no DOM is a
 * test that cannot rot when nobody is running it against a real browser.
 */

/** The server's own cap, postEventsSchema (http/schemas.ts): 1-50 events
 * per POST. This is the hard ceiling no single request may cross - not the
 * threshold that triggers a flush, which stays well under it. */
const SERVER_BATCH_LIMIT = 50;

/**
 * Flush once this many events are queued - comfortably under
 * `SERVER_BATCH_LIMIT`, so a burst of activity (a confirm session's several
 * field_edited/suggestion_* rows landing at once) empties the queue in one
 * request instead of brushing the server's own ceiling.
 */
const DEFAULT_FLUSH_THRESHOLD = 20;

/** Flush on this interval regardless of size, so a quiet session's queue
 * does not sit unsent until something else triggers a flush. */
const DEFAULT_FLUSH_INTERVAL_MS = 15_000;

export type EventTransport = (batch: UserEvent[]) => Promise<void>;

export interface EventQueueOptions {
  flushThreshold?: number;
  flushIntervalMs?: number;
}

/**
 * A pending-events buffer with no knowledge of fetch, tokens, or the DOM -
 * `transport` is handed in, so a test can swap it for a spy or a
 * deliberately-failing stub without touching a network stack.
 */
export class EventQueue {
  private pending: UserEvent[] = [];
  private readonly flushThreshold: number;
  private readonly flushIntervalMs: number;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly transport: EventTransport,
    options: EventQueueOptions = {},
  ) {
    this.flushThreshold = options.flushThreshold ?? DEFAULT_FLUSH_THRESHOLD;
    this.flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  }

  /** Events queued and not yet handed to the transport. Test-only surface -
   * nothing in this module reads it for a real decision. */
  get size(): number {
    return this.pending.length;
  }

  /**
   * Add one event. Synchronous and never throws - queuing is the one
   * operation a caller (a click handler, a save path) is ever on the hook
   * for; everything past this point runs on its own.
   */
  enqueue(event: UserEvent): void {
    this.pending.push(event);
    if (this.pending.length >= this.flushThreshold) {
      void this.flush();
    }
  }

  /**
   * Drain the whole queue now, one POST per chunk of at most
   * `SERVER_BATCH_LIMIT` events - rule 2's corollary: an enqueue burst well
   * past the threshold (a slow network stalling several flushes in a row)
   * must never produce a single over-50 request, so this always chunks
   * rather than trusting the threshold alone to keep batches small.
   *
   * The queue is cleared before any `await`, so events enqueued while this
   * flush's requests are still in flight land in a fresh batch rather than
   * being lost or double-sent. Every chunk's failure is swallowed here -
   * rule 1 - so a caller (the interval timer, a lifecycle listener,
   * `enqueue`'s own threshold trigger) never has anything to catch.
   */
  async flush(): Promise<void> {
    if (this.pending.length === 0) {
      return;
    }
    const draining = this.pending;
    this.pending = [];
    for (let start = 0; start < draining.length; start += SERVER_BATCH_LIMIT) {
      const chunk = draining.slice(start, start + SERVER_BATCH_LIMIT);
      try {
        await this.transport(chunk);
      } catch {
        // Fire-and-forget, by the endpoint's own contract (routes/
        // events.ts): losing telemetry - a strict 400 on an unknown action
        // name, a dropped connection, a signed-out token - is always the
        // acceptable failure here. Not re-queued: retrying a failed batch
        // is exactly the "aggressive retry" rule 1 forbids, and every event
        // already carries its own `occurredAt`, so a lost batch is a gap in
        // the log, not corrupted data.
      }
    }
  }

  /** Idempotent: a second call while a timer is already running is a no-op,
   * so callers do not have to track whether they already started one. */
  startTimer(): void {
    if (this.intervalHandle !== null) {
      return;
    }
    this.intervalHandle = setInterval(() => void this.flush(), this.flushIntervalMs);
  }

  stopTimer(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }
}

/** The subset of `Document`/`Window` this module actually touches -
 * injectable so `attachLifecycleFlush` has a test that needs neither jsdom
 * nor a real browser, matching every other test in this client. */
interface ListenerTarget {
  addEventListener: (type: string, listener: () => void) => void;
  removeEventListener: (type: string, listener: () => void) => void;
}
interface VisibilityDocumentLike extends ListenerTarget {
  readonly visibilityState: string;
}

/**
 * Wires a queue's flush to every signal a tab can disappear by, and starts
 * its interval timer. Two listeners, not one, because neither fires in
 * every case that loses a tab: `visibilitychange` -> "hidden" covers a tab
 * switch or a phone's browser being backgrounded, where `pagehide` may
 * never fire at all; `pagehide` covers an actual navigation or close.
 * `doc`/`win` default to the real `document`/`window` but are parameters
 * precisely so a test can hand in a recording fake instead.
 *
 * Returns a teardown that undoes all of it (both listeners, the timer) -
 * for a signed-out session ending before the tab does, so one person's
 * queue is not still wired to `document` after `configureEventLogging`
 * moves on to nobody, or to someone else.
 */
export function attachLifecycleFlush(
  queue: EventQueue,
  doc: VisibilityDocumentLike = document,
  win: ListenerTarget = window,
): () => void {
  const onVisibilityChange = () => {
    if (doc.visibilityState === "hidden") {
      void queue.flush();
    }
  };
  const onPageHide = () => void queue.flush();
  doc.addEventListener("visibilitychange", onVisibilityChange);
  win.addEventListener("pagehide", onPageHide);
  queue.startTimer();
  return () => {
    doc.removeEventListener("visibilitychange", onVisibilityChange);
    win.removeEventListener("pagehide", onPageHide);
    queue.stopTimer();
  };
}

/**
 * The one POST this whole module makes. Deliberately not routed through
 * `KeptApi.request` (api.ts): that method calls `onUnauthorized()` on every
 * 401, which is the right behaviour for a person's own action but wrong
 * here - a background flush discovering an expired token must never be
 * what silently signs someone out. A non-ok response (the strict 400 rule
 * 2 names, a 401, anything else) just throws, for `EventQueue.flush`'s own
 * catch to swallow; this function never touches the session.
 */
async function postEvents(token: string, events: UserEvent[]): Promise<void> {
  const response = await fetch(`${API_ORIGIN}/api/events`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ events } satisfies PostEventsRequest),
  });
  if (!response.ok) {
    throw new Error(`POST /api/events answered ${response.status}`);
  }
}

/**
 * `appVersion` for every event this client sends - the git short SHA (or a
 * build-date fallback), baked in at build time by vite.config.ts's
 * `define`. See env.d.ts for why this identifier is not a runtime lookup.
 */
const APP_VERSION = __APP_VERSION__;

let activeQueue: EventQueue | null = null;
let detachLifecycle: (() => void) | null = null;
/** `undefined` means "never configured" - distinct from `null` ("configured
 * for signed-out"), so the very first call after a page load always runs
 * the (idempotent) setup, even though `null` is also `token`'s initial
 * App.tsx state. */
let configuredToken: string | null | undefined;

/**
 * (Re)point the module's one active queue at a session. Called from
 * App.tsx whenever `token` changes - on sign-in, on sign-out, and once on
 * mount for a session restored from storage - and idempotent, so calling it
 * again with the token it is already configured for is a cheap no-op
 * rather than a state a caller has to avoid re-triggering.
 *
 * The outgoing queue is flushed (fire-and-forget) before it is torn down,
 * so an event enqueued moments before a sign-out - the `sign_out` row
 * itself, most often - still goes out rather than being dropped by the
 * teardown that follows it.
 */
export function configureEventLogging(token: string | null): void {
  if (token === configuredToken) {
    return;
  }
  configuredToken = token;
  if (activeQueue !== null) {
    void activeQueue.flush();
  }
  detachLifecycle?.();
  detachLifecycle = null;
  activeQueue = null;
  if (token === null) {
    return;
  }
  const queue = new EventQueue((batch) => postEvents(token, batch));
  activeQueue = queue;
  detachLifecycle = attachLifecycleFlush(queue);
}

/**
 * Enqueue one behavioural event. `occurredAt`, `client` and `appVersion`
 * are filled in here so no call site has to know the wire format or repeat
 * it - callers name the action and whatever field-scoped detail applies.
 * A no-op before the first `configureEventLogging` call or while signed
 * out: there is no session to attribute the event to, and rule 1 makes
 * "silently drop it" the correct behaviour rather than an error to handle.
 */
export function logEvent(
  event: Omit<UserEvent, "occurredAt" | "client" | "appVersion">,
): void {
  activeQueue?.enqueue({
    ...event,
    occurredAt: new Date().toISOString(),
    client: "web",
    appVersion: APP_VERSION,
  });
}
