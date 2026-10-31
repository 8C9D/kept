import type { Receipt, ReceiptList } from "./types.js";

/**
 * The queue's "next unconfirmed receipt" (spec §6A consequence 3), separated
 * from ConfirmQueue.tsx so paging through skips has a test with no component
 * and no network.
 *
 * Walks the pending list page by page until it finds a receipt not in
 * `skip`, or the server says there are no more pages. It used to read page
 * one and stop, so after 50 skips (a page is 50 rows) the screen reported
 * "nothing left" over a backlog that had more in it - a queue claiming to be
 * finished is the one lie this screen must not tell.
 *
 * `skip` is the client's own list because a skipped receipt stays pending
 * server-side; the walk restarts from the top each time, which costs a page
 * per 50 skips and needs no cursor kept across a list that a confirm has
 * just changed underneath it.
 */
export async function findNextPending(
  fetchPage: (cursor: string | null) => Promise<ReceiptList>,
  skip: readonly string[],
): Promise<{ next: Receipt | null; pendingCount: number }> {
  let cursor: string | null = null;
  for (;;) {
    const page: ReceiptList = await fetchPage(cursor);
    const next = page.receipts.find((receipt) => !skip.includes(receipt.id));
    if (next !== undefined) {
      return { next, pendingCount: page.pendingCount };
    }
    if (page.nextCursor === null) {
      return { next: null, pendingCount: page.pendingCount };
    }
    cursor = page.nextCursor;
  }
}
