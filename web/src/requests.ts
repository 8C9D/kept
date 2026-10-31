/**
 * The three disciplines every asynchronous screen in this client turned out
 * to need, kept free of React and of `KeptApi` for the reason `bulkEdit.ts`
 * is: each one is a rule about ORDER, and a rule about order is exactly what
 * a test can pin one step at a time and a component tree cannot.
 *
 * They answer three different questions, and picking the wrong one is how a
 * guard ends up in the code without fixing anything:
 *
 * - `LatestRequest`: several may run, only the newest may land. A late "co"
 *   must not overwrite the "cos" rows sitting on screen.
 * - `SingleFlight`: one may run, and a second attempt is refused outright. A
 *   re-click during a slow Confirm must not act on whatever the screen has
 *   moved on to.
 * - `serializeByKey`: every one must run, one at a time per key. Two inline
 *   saves on a row must both happen, the second seeing what the first did.
 */

/**
 * Hands out tickets; only the holder of the newest one may apply its result.
 * Nothing is cancelled - the response still arrives, it is just discarded -
 * because a response that lands after its question stopped mattering is the
 * whole failure this exists for, and aborting the fetch would not stop one
 * that has already resolved.
 */
export class LatestRequest {
  private latest = 0;

  /** Starts a new generation; every ticket before this one is now stale. */
  begin(): number {
    this.latest += 1;
    return this.latest;
  }

  /**
   * The newest ticket, for work that belongs to the current generation
   * without replacing it: "Load more" appends to the list a first-page load
   * produced, and must die with that list rather than superseding it.
   */
  current(): number {
    return this.latest;
  }

  isLatest(ticket: number): boolean {
    return ticket === this.latest;
  }
}

/**
 * At most one `task` at a time; a call made while one runs is refused and
 * resolves false rather than queueing. Refused, not queued, is the point:
 * the second click of a double-click is not a second request, and running
 * it later would act on whatever the screen has become in the meantime.
 *
 * Synchronous up to the first `await`, so the guard is already up before a
 * browser can deliver the next click - which is what a React state flag
 * alone cannot promise, since state only changes on the next render.
 */
export class SingleFlight {
  private running = false;

  async run(task: () => Promise<void>): Promise<boolean> {
    if (this.running) {
      return false;
    }
    this.running = true;
    try {
      await task();
      return true;
    } finally {
      this.running = false;
    }
  }
}

export type SerialRunner = <T>(
  key: string,
  task: () => Promise<T>,
) => Promise<T>;

/**
 * Tasks sharing a key run strictly in order, each starting only once the
 * one before it has settled; different keys never wait for each other.
 *
 * A failed task does not stop the next: the caller of the failed one holds
 * its rejection and decides what it means, and the task behind it is someone
 * else's work. The `catch` on the tail is that separation rather than an
 * error being swallowed - `result`, which still rejects, is what the caller
 * got. The tail only ever exists to say "the previous one has finished".
 */
export function serializeByKey(): SerialRunner {
  const tails = new Map<string, Promise<void>>();
  return <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const previous = tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const tail: Promise<void> = result.then(
      () => undefined,
      () => undefined,
    );
    tails.set(key, tail);
    // Dropped once nothing follows it, so a long session's map holds only
    // what is genuinely in flight rather than one entry per row ever edited.
    void tail.then(() => {
      if (tails.get(key) === tail) {
        tails.delete(key);
      }
    });
    return result;
  };
}

/**
 * Appends a keyset page, dropping any row already on screen. Saves update rows
 * in place and keep the cursor (ReceiptsTable), so an edit that moves a row past
 * the cursor legitimately comes back in a later page. The row on screen wins:
 * it is the one the person just saved, and it keeps its place until the next
 * load rather than jumping mid-edit.
 */
export function appendPage<Row extends { id: string }>(
  current: readonly Row[],
  page: readonly Row[],
): Row[] {
  const onScreen = new Set(current.map((row) => row.id));
  return [...current, ...page.filter((row) => !onScreen.has(row.id))];
}
