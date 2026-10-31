import { describe, expect, it } from "vitest";
import {
  LatestRequest,
  SingleFlight,
  appendPage,
  serializeByKey,
} from "../src/requests.js";

/**
 * The three ordering rules the screens lean on, pinned one step at a time
 * with promises the test resolves by hand - which is the only honest way to
 * state "this answer arrives after that one".
 */

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every already-settled promise chain run to the next real await. */
async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

describe("LatestRequest - a late answer does not land", () => {
  it("lets only the newest ticket through", () => {
    const requests = new LatestRequest();
    const co = requests.begin();
    const cos = requests.begin();
    expect(requests.isLatest(co)).toBe(false);
    expect(requests.isLatest(cos)).toBe(true);
  });

  it("a late 'co' cannot overwrite the 'cos' rows on screen", async () => {
    // The table's whole race, as the effect runs it: both searches are sent,
    // and the answer to the older one arrives last.
    const requests = new LatestRequest();
    const shown: string[] = [];
    const co = deferred<string>();
    const cos = deferred<string>();
    const search = async (answer: Promise<string>) => {
      const ticket = requests.begin();
      const rows = await answer;
      if (requests.isLatest(ticket)) {
        shown.push(rows);
      }
    };
    const first = search(co.promise);
    const second = search(cos.promise);
    cos.resolve("cos rows");
    await second;
    co.resolve("co rows");
    await first;
    expect(shown).toEqual(["cos rows"]);
  });

  it("current() names the generation without starting a new one", () => {
    // Load more: it belongs to the first page's list and must not cancel it.
    const requests = new LatestRequest();
    const page = requests.begin();
    expect(requests.current()).toBe(page);
    expect(requests.isLatest(page)).toBe(true);
    const more = requests.current();
    requests.begin();
    expect(requests.isLatest(more)).toBe(false);
  });
});

describe("SingleFlight - a second attempt is refused, not queued", () => {
  it("refuses a call while one is running, and never runs it", async () => {
    const flight = new SingleFlight();
    const gate = deferred();
    let runs = 0;
    const task = async () => {
      runs += 1;
      await gate.promise;
    };
    const first = flight.run(task);
    // The double-click: same tick, before anything has re-rendered.
    expect(await flight.run(task)).toBe(false);
    expect(runs).toBe(1);
    gate.resolve();
    expect(await first).toBe(true);
    expect(runs).toBe(1);
  });

  it("is free again once the task has finished", async () => {
    const flight = new SingleFlight();
    let runs = 0;
    await flight.run(async () => {
      runs += 1;
    });
    await flight.run(async () => {
      runs += 1;
    });
    expect(runs).toBe(2);
  });

  it("is free again after a task that throws, and the throw reaches the caller", async () => {
    const flight = new SingleFlight();
    await expect(
      flight.run(async () => {
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");
    expect(await flight.run(async () => undefined)).toBe(true);
  });
});

describe("serializeByKey - all of them run, in order, per key", () => {
  it("does not start the second task on a key until the first has settled", async () => {
    const run = serializeByKey();
    const firstGate = deferred();
    const order: string[] = [];
    const first = run("row-1", async () => {
      order.push("first started");
      await firstGate.promise;
      order.push("first finished");
    });
    const second = run("row-1", async () => {
      order.push("second started");
    });
    await flush();
    expect(order).toEqual(["first started"]);
    firstGate.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(["first started", "first finished", "second started"]);
  });

  it("the second save sees the reviewed set the first one produced", async () => {
    // The race this exists for: tabbing Total -> HST with the first PATCH
    // out. `reviewedFields` replaces the stored set, so each patch has to be
    // built from what the previous one returned, at its own turn.
    const run = serializeByKey();
    let stored: string[] = [];
    const save = (field: string) =>
      run("row-1", async () => {
        const next = [...stored, field];
        await flush();
        stored = next;
      });
    await Promise.all([save("totalCents"), save("hstCents")]);
    expect(stored).toEqual(["totalCents", "hstCents"]);
  });

  it("different keys do not wait for each other", async () => {
    const run = serializeByKey();
    const gate = deferred();
    const order: string[] = [];
    const blocked = run("row-1", async () => {
      await gate.promise;
      order.push("row-1");
    });
    await run("row-2", async () => {
      order.push("row-2");
    });
    expect(order).toEqual(["row-2"]);
    gate.resolve();
    await blocked;
  });

  it("a failed task rejects its own caller and does not stop the next", async () => {
    const run = serializeByKey();
    const failed = run("row-1", async () => {
      throw new Error("400");
    });
    const next = run("row-1", async () => "ran");
    await expect(failed).rejects.toThrow("400");
    await expect(next).resolves.toBe("ran");
  });

  it("returns each task's own result", async () => {
    const run = serializeByKey();
    await expect(run("row-1", async () => 41 + 1)).resolves.toBe(42);
  });
});

describe("appendPage", () => {
  it("drops a row an edit moved past the cursor, keeping the one on screen", () => {
    const edited = { id: "a", vendor: "edited" };
    const fromServer = { id: "a", vendor: "stale page" };
    const next = { id: "b", vendor: "next" };

    expect(appendPage([edited], [fromServer, next])).toEqual([edited, next]);
  });
});
