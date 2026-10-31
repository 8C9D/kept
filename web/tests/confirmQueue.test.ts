import { describe, expect, it } from "vitest";
import { findNextPending } from "../src/confirmQueue.js";
import type { Receipt, ReceiptList } from "../src/types.js";

/** Only the id matters to the walk. */
const receipt = (id: string) => ({ id }) as Receipt;

/** Pending rows in pages, the shape the list route serves them. */
function pagesOf(ids: string[], pageSize: number) {
  const requested: (string | null)[] = [];
  const fetchPage = async (cursor: string | null): Promise<ReceiptList> => {
    requested.push(cursor);
    const start = cursor === null ? 0 : Number(cursor);
    const end = start + pageSize;
    return {
      receipts: ids.slice(start, end).map(receipt),
      nextCursor: end < ids.length ? String(end) : null,
      pendingCount: ids.length,
    };
  };
  return { fetchPage, requested };
}

const range = (from: number, to: number) =>
  Array.from({ length: to - from }, (_, i) => `r-${from + i}`);

describe("findNextPending - the queue's next receipt", () => {
  it("takes the first receipt nobody has skipped", async () => {
    const { fetchPage, requested } = pagesOf(range(0, 3), 50);
    const { next } = await findNextPending(fetchPage, ["r-0"]);
    expect(next?.id).toBe("r-1");
    expect(requested).toEqual([null]);
  });

  it("pages past 50 skips rather than saying nothing is left", async () => {
    // The defect: page one only, so a person who skipped their way through
    // 50 receipts was told the queue was finished with 70 still pending.
    const { fetchPage, requested } = pagesOf(range(0, 70), 50);
    const { next, pendingCount } = await findNextPending(fetchPage, range(0, 50));
    expect(next?.id).toBe("r-50");
    expect(pendingCount).toBe(70);
    expect(requested).toEqual([null, "50"]);
  });

  it("keeps paging through as many fully-skipped pages as there are", async () => {
    const { fetchPage, requested } = pagesOf(range(0, 130), 50);
    const { next } = await findNextPending(fetchPage, range(0, 120));
    expect(next?.id).toBe("r-120");
    expect(requested).toEqual([null, "50", "100"]);
  });

  it("reports exhaustion only once the server has no more pages", async () => {
    const { fetchPage, requested } = pagesOf(range(0, 60), 50);
    const { next } = await findNextPending(fetchPage, range(0, 60));
    expect(next).toBeNull();
    expect(requested).toEqual([null, "50"]);
  });

  it("reports an empty queue from one request", async () => {
    const { fetchPage, requested } = pagesOf([], 50);
    expect(await findNextPending(fetchPage, [])).toEqual({
      next: null,
      pendingCount: 0,
    });
    expect(requested).toEqual([null]);
  });

  it("lets a failed page reach the caller rather than reading it as the end", async () => {
    // "Nothing left" over a failed fetch would be the same lie by another
    // route - ConfirmQueue's catch owns saying what happened.
    const fetchPage = async () => {
      throw new Error("offline");
    };
    await expect(findNextPending(fetchPage, [])).rejects.toThrow("offline");
  });
});
