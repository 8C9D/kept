import type { Receipt, ReceiptPatch } from "./types.js";

/**
 * Row selection and the bulk-action batch runner behind proposal #5, "bulk
 * edit on the web table" (docs/proposals/2026-08-28-ux-enhancements.md #5,
 * approved 2026-08-28). Kept free of React and of `KeptApi` on purpose:
 * `ReceiptsTable.tsx` wires this to `api.updateReceipt` and to component
 * state, and owns nothing about the loop or the selection rules themselves
 * - the part most likely to be gotten wrong (partial failure, and "select
 * all" reaching further than the screen shows) gets a test that needs
 * neither a component tree nor a network stub.
 *
 * Deliberately no bulk delete anywhere in this module, matching the
 * proposal exactly. Deletes are soft server-side (spec §10B) and
 * recoverable in principle, but there is no undelete anywhere in this app
 * - not in the API, not in either client - so a mis-clicked bulk delete
 * would be unrecoverable by any means a user actually has. The proposal
 * names this risk by itself and the choice is not an oversight: do not add
 * bulk delete here as an "obvious" missing feature without first building
 * an undelete path for it to sit behind.
 */

export type Selection = ReadonlySet<string>;

export const EMPTY_SELECTION: Selection = new Set();

/** Toggle one row in or out of the selection. */
export function toggleRow(selected: Selection, id: string): Selection {
  const next = new Set(selected);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  return next;
}

/**
 * Whether every currently-loaded row is selected - what the header
 * checkbox's checked (and, in the component, indeterminate) state reads.
 * Empty is never "all selected": a table with nothing loaded yet should
 * not show a checked header.
 */
export function allLoadedSelected(
  loadedIds: readonly string[],
  selected: Selection,
): boolean {
  return loadedIds.length > 0 && loadedIds.every((id) => selected.has(id));
}

/**
 * Header checkbox click: selects every currently-loaded row, or clears the
 * whole selection if every one of them is already selected. Scoped to
 * `loadedIds` deliberately - the brief's own warning: the table is paged,
 * and "select all" must never read as "every receipt in my account" when
 * it means "the ones on this page." This can only ever produce a subset of
 * `loadedIds`; it has no way to reach a row the table has not fetched.
 */
export function toggleSelectAll(
  loadedIds: readonly string[],
  selected: Selection,
): Selection {
  return allLoadedSelected(loadedIds, selected)
    ? EMPTY_SELECTION
    : new Set(loadedIds);
}

export interface BatchFailure {
  id: string;
  reason: string;
}

export interface BatchResult {
  succeeded: string[];
  failed: BatchFailure[];
}

/** Never more than a handful of PATCHes in flight at once (brief: "keep
 * concurrency modest... not 50 parallel requests") - there is no batch
 * route on the server, so this is the one thing standing between a bulk
 * action and looking like a burst against an API built for one row at a
 * time. */
export const DEFAULT_CONCURRENCY = 4;

/**
 * Runs `worker` once per id, `concurrency` at a time, and never lets one
 * rejection stop the rest. Partial failure is the normal case this whole
 * feature is built around, not the edge case: every id gets a result,
 * successes and failures are reported separately and by id, and nothing
 * here ever collapses a mixed outcome into a single pass/fail.
 *
 * Lane-based rather than chunked: `concurrency` workers each pull the next
 * unclaimed index off a shared cursor and keep going until none remain, so
 * a fast id does not sit idle waiting for a slow one in the same chunk to
 * finish before the next id starts.
 */
export async function runBatch(
  ids: readonly string[],
  worker: (id: string) => Promise<void>,
  concurrency: number = DEFAULT_CONCURRENCY,
): Promise<BatchResult> {
  const succeeded: string[] = [];
  const failed: BatchFailure[] = [];
  let cursor = 0;

  async function runLane(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= ids.length) {
        return;
      }
      const id = ids[index]!;
      try {
        await worker(id);
        succeeded.push(id);
      } catch (caught) {
        failed.push({
          id,
          reason: caught instanceof Error ? caught.message : String(caught),
        });
      }
    }
  }

  const laneCount = Math.max(1, Math.min(concurrency, ids.length));
  await Promise.all(Array.from({ length: laneCount }, () => runLane()));
  return { succeeded, failed };
}

/** The exact rule PATCH /api/receipts/:id enforces (server/src/routes/
 * receipts.ts: "a confirmed receipt requires a total"), restated here so a
 * bulk confirm can see it coming per row rather than only read it back off
 * a 400 after the fact. */
export const NO_TOTAL_REASON =
  "No total on file - a confirmed receipt requires one.";

/**
 * Splits the selected rows into what a bulk confirm can actually send and
 * what it must refuse before ever making a request - the brief's own
 * instruction: "the client can already see which selected rows lack a
 * total," so detect it client-side instead of only surfacing the server's
 * 400. Blocked rows are reported as failures through the identical shape a
 * real request failure would produce (`BatchFailure`), so a caller never
 * has to handle two different kinds of "this row didn't make it."
 */
export function partitionConfirmable(
  rows: readonly Pick<Receipt, "id" | "totalCents">[],
): { confirmable: string[]; blocked: BatchFailure[] } {
  const confirmable: string[] = [];
  const blocked: BatchFailure[] = [];
  for (const row of rows) {
    if (row.totalCents === null) {
      blocked.push({ id: row.id, reason: NO_TOTAL_REASON });
    } else {
      confirmable.push(row.id);
    }
  }
  return { confirmable, blocked };
}

/**
 * The patch body for a bulk "set category" action - exactly the one field
 * being set, nothing else (a bulk category set must never accidentally
 * carry payment method, status, or anything else along with it). Trimmed
 * and emptied to `null` on the identical rule `TextCell` already applies
 * per row (ReceiptsTable.tsx), so a bulk set and a manual edit normalize
 * the same free text the same way.
 */
export function categoryPatch(value: string): ReceiptPatch {
  const trimmed = value.trim();
  return { category: trimmed === "" ? null : trimmed };
}

/** Same shape and the same trim/empty-to-null rule as `categoryPatch`, for
 * payment method. */
export function paymentMethodPatch(value: string): ReceiptPatch {
  const trimmed = value.trim();
  return { paymentMethod: trimmed === "" ? null : trimmed };
}

/** The patch body for a bulk confirm - `status` alone. Never bundles a
 * total or any other field; a row missing what it needs to confirm is
 * filtered out by `partitionConfirmable` before this is ever sent. */
export const confirmPatch: ReceiptPatch = { status: "confirmed" };
