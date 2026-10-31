import { normalizedFreeText } from "./freeText.js";
import { unionReviewedFields, withheldAmountFields } from "./suggestions.js";
import {
  REVIEWED_FIELDS,
  type Receipt,
  type ReceiptPatch,
} from "./types.js";

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
 * The refusal for a pending row whose amounts the server withheld. It names
 * what to do, not just what is wrong: bulk confirm cannot resolve this, only
 * a person with the paper can, and the receipt's own screen is where they
 * type it.
 */
export const WITHHELD_AMOUNTS_REASON =
  "The amounts read from this receipt didn't add up - open it and enter them from the paper.";

/**
 * Splits the selected rows into what a bulk confirm can actually send and
 * what it must refuse before ever making a request - the brief's own
 * instruction: "the client can already see which selected rows lack a
 * total," so detect it client-side instead of only surfacing the server's
 * 400. Blocked rows are reported as failures through the identical shape a
 * real request failure would produce (`BatchFailure`), so a caller never
 * has to handle two different kinds of "this row didn't make it."
 *
 * ⚠ A withheld amount blocks the row even when `totalCents` looks fine, and
 * that is the case that matters (2026-10). A bulk confirm carries `status`
 * alone (`confirmPatch`), so it would promote whatever the pending row
 * holds - and a pending row's amounts are the capture-time snapshot the
 * merge just refused to serve, the $8.50 stored for a $218.94 Costco slip
 * (`draftFromPending`'s note). No human would have looked at that number,
 * which is constraint 2 in bulk. The server now refuses it with a 409
 * (`amounts_need_review`); this sees it coming per row, and a row that
 * changed since it was loaded still reaches `runBatch` and fails there,
 * in the same report, in the server's own words.
 *
 * Gated on `pending` because `suggestions` is not: the server runs the
 * withholding rule on every read, so a row confirmed months ago by someone
 * who typed the right total can still carry the flag. Blocking one of those
 * would report a failure for a receipt with nothing left to do.
 *
 * Checked before the missing total, since a withheld row with no total has
 * the same remedy and this reason is the one that says what it is.
 */
export function partitionConfirmable(
  rows: readonly Pick<Receipt, "id" | "totalCents" | "status" | "suggestions">[],
): { confirmable: string[]; blocked: BatchFailure[] } {
  const confirmable: string[] = [];
  const blocked: BatchFailure[] = [];
  for (const row of rows) {
    if (
      row.status === "pending" &&
      withheldAmountFields(row.suggestions).length > 0
    ) {
      blocked.push({ id: row.id, reason: WITHHELD_AMOUNTS_REASON });
    } else if (row.totalCents === null) {
      blocked.push({ id: row.id, reason: NO_TOTAL_REASON });
    } else {
      confirmable.push(row.id);
    }
  }
  return { confirmable, blocked };
}

/**
 * The line beside the Confirm button, while rows it will skip are selected.
 * Says how many and why, since the two reasons have different remedies: a
 * missing total can be typed into the row, and a withheld one needs opening.
 */
export function describeBlocked(
  blocked: readonly BatchFailure[],
  selectedCount: number,
): string {
  const noTotal = blocked.filter((b) => b.reason === NO_TOTAL_REASON).length;
  const withheld = blocked.length - noTotal;
  const reasons = [
    ...(noTotal > 0 ? [`${noTotal} no total`] : []),
    ...(withheld > 0 ? [`${withheld} to open - amounts withheld`] : []),
  ];
  return `${blocked.length} of ${selectedCount} selected will be skipped: ${reasons.join(", ")}`;
}

/**
 * The patch body for a bulk "set category" action - exactly the one field
 * being set, nothing else (a bulk category set must never accidentally
 * carry payment method, status, or anything else along with it). Trimmed
 * and emptied to `null` by `normalizedFreeText`, the rule `TextCell` also
 * applies per row (ReceiptsTable.tsx), so a bulk set and a manual edit
 * normalize the same free text the same way.
 */
export function categoryPatch(value: string): ReceiptPatch {
  return { category: normalizedFreeText(value) };
}

/** Same shape and the same trim/empty-to-null rule as `categoryPatch`, for
 * payment method. */
export function paymentMethodPatch(value: string): ReceiptPatch {
  return { paymentMethod: normalizedFreeText(value) };
}

/** The patch body for a bulk confirm - `status` alone. Never bundles a
 * total or any other field; a row missing what it needs to confirm is
 * filtered out by `partitionConfirmable` before this is ever sent. */
export const confirmPatch: ReceiptPatch = { status: "confirmed" };

/**
 * The patch for an inline edit in the table: on a pending row, the edit plus
 * the reviewed set with the edited field added; on a confirmed one, the edit
 * alone, because nothing is served suggestions to review away from.
 *
 * ⚠ Without this the table could not actually change a pending receipt.
 * Typing a total of 15.00 into a row wrote 1500, but the field was never
 * marked reviewed, so the merge kept serving the parser's $14.35 over it;
 * the queue showed $14.35 and Confirm PATCHed 1435 back over the value the
 * person had just typed. A typed cell is a reviewed field by the definition
 * `reviewedFieldsForSave` (ReceiptForm.tsx) uses for the form.
 *
 * Every `ReviewedField` name is also a `ReceiptPatch` key, so the fields
 * edited can be read straight off the patch. The caller passes the row as it
 * stands NOW, not as it stood when the cell rendered: the set replaces the
 * stored one outright, so a stale copy would un-review whatever the previous
 * save just reviewed (ReceiptsTable.tsx's `saveField` is what makes "now"
 * true).
 */
export function inlineEditPatch(
  row: Pick<Receipt, "status" | "reviewedFields">,
  patch: ReceiptPatch,
): ReceiptPatch {
  if (row.status !== "pending") {
    return patch;
  }
  const edited = REVIEWED_FIELDS.filter((field) => field in patch);
  return {
    ...patch,
    reviewedFields: unionReviewedFields(row.reviewedFields, edited),
  };
}
