import { useCallback, useEffect, useRef, useState } from "react";
import type { KeptApi } from "../api.js";
import { ApiError } from "../api.js";
import {
  EMPTY_SELECTION,
  allLoadedSelected,
  categoryPatch,
  confirmPatch,
  partitionConfirmable,
  paymentMethodPatch,
  runBatch,
  toggleRow,
  toggleSelectAll,
  type BatchFailure,
  type BatchResult,
  type Selection,
} from "../bulkEdit.js";
import { logEvent } from "../events.js";
import { formatCents, parseMoneyInput } from "../money.js";
import {
  CATEGORY_LIST_ID,
  PAYMENT_LIST_ID,
  ReceiptOptionsDatalists,
  VENDOR_LIST_ID,
  type ReceiptOptionsHandle,
} from "../options.js";
import type {
  ListFilters,
  Receipt,
  ReceiptPatch,
  ReceiptSort,
  ReceiptStatus,
  ReceiptSummary,
  SortOrder,
} from "../types.js";

/**
 * Which of list_searched / list_filtered / list_sorted (events.ts's
 * vocabulary) one `filters` change was, by diffing the previous value
 * against the next field by field - the table has one `filters` object and
 * one effect that re-fetches on any change to it, so nothing upstream
 * already knows which control the person touched. Pure and exported so the
 * classification itself has a test independent of the effect that calls it.
 * Checked in a fixed order (search, then sort, then the rest) because a
 * single control's onChange only ever changes one field at a time in this
 * UI, so at most one of these is ever true per call - the order only
 * matters for the untested case of two fields changing in one state update.
 */
export function classifyFilterChange(
  prev: ListFilters,
  next: ListFilters,
): "list_searched" | "list_filtered" | "list_sorted" | null {
  if (prev.q !== next.q) {
    return "list_searched";
  }
  if (prev.sort !== next.sort || prev.order !== next.order) {
    return "list_sorted";
  }
  if (
    prev.from !== next.from ||
    prev.to !== next.to ||
    prev.status !== next.status ||
    prev.category !== next.category ||
    prev.paymentMethod !== next.paymentMethod
  ) {
    return "list_filtered";
  }
  return null;
}

/** The three bulk actions the brief names - "set category," "set payment
 * method," "confirm." No "delete": see bulkEdit.ts's comment for why that
 * omission is deliberate rather than missing. */
type BulkActionKind = "category" | "paymentMethod" | "confirm";

/** The result of the most recently finished bulk action, kept on screen
 * until the next one starts or the person dismisses it - the report
 * `runBulkAction` below builds, and the one place partial failure actually
 * gets said out loud. */
interface BulkOutcome {
  kind: BulkActionKind;
  result: BatchResult;
}

/**
 * Spec §7A screen 2: every receipt, filterable (date range, status,
 * category, payment, free-text over vendor/category/notes), sortable on the
 * server's four keys, inline editing, row click opens the receipt.
 * Keyset-paged, and any change to the filters or the sort restarts from
 * page one by construction - a new `filters` object re-runs the first-page
 * effect with a null cursor, because a cursor encodes a position in one
 * particular ordered result set.
 */
export function ReceiptsTable({
  api,
  dataVersion,
  options,
  onOpen,
  onConfirmQueue,
  onChanged,
}: {
  api: KeptApi;
  dataVersion: number;
  options: ReceiptOptionsHandle;
  onOpen: (id: string) => void;
  onConfirmQueue: () => void;
  onChanged: () => void;
}) {
  const [filters, setFilters] = useState<ListFilters>({});
  const [rows, setRows] = useState<Receipt[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Proposal #3's running totals for the current filter - a separate fetch
  // from the page above (GET /api/receipts/summary, not computed from
  // `rows`: the page is 50 rows and the answer is about the whole filter).
  // Null both before the first answer and after a failed one - see
  // `loadSummary` below for why a stale figure is not kept on failure the
  // way `rows` is.
  const [summary, setSummary] = useState<ReceiptSummary | null>(null);
  // For classifyFilterChange below - the effect that fetches on `filters`
  // also fires on a `dataVersion` bump alone (another screen changed a
  // receipt), which must not be misread as a search/filter/sort action.
  const previousFilters = useRef(filters);

  // Bulk edit (proposal #5): selection is a set of receipt ids, always a
  // subset of what `rows` currently holds - see bulkEdit.ts for why that
  // scoping is load-bearing rather than incidental.
  const [selected, setSelected] = useState<Selection>(EMPTY_SELECTION);
  const [bulkCategory, setBulkCategory] = useState("");
  const [bulkPayment, setBulkPayment] = useState("");
  const [bulkRunning, setBulkRunning] = useState<BulkActionKind | null>(null);
  const [bulkOutcome, setBulkOutcome] = useState<BulkOutcome | null>(null);

  const loadFirstPage = useCallback(
    async (activeFilters: ListFilters) => {
      setLoading(true);
      setError(null);
      // The cursor in hand belongs to the result set being replaced; the
      // server refuses one minted under a different sort, and it would be
      // the wrong position under a different filter either way.
      setNextCursor(null);
      try {
        const page = await api.listReceipts(activeFilters, null);
        setRows(page.receipts);
        setNextCursor(page.nextCursor);
        setPendingCount(page.pendingCount);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setLoading(false);
      }
    },
    [api],
  );

  const loadSummary = useCallback(
    async (activeFilters: ListFilters) => {
      try {
        setSummary(await api.receiptSummary(activeFilters));
      } catch {
        // Proposal #3's own instruction: a failed aggregate fetch must
        // never break the table sitting below it - degrade to no summary.
        // Unlike `options.ts`'s "keep the last good lists", the last good
        // summary is NOT kept here: it would be a total for a filter that
        // has since changed, which is actively misleading rather than
        // merely missing, and this row has nothing else on screen it could
        // silently disagree with the way a stale picker list would not.
        setSummary(null);
      }
    },
    [api],
  );

  useEffect(() => {
    // Logged for the action itself, not the fetch's outcome - there is no
    // list_search_failed in the vocabulary (events.ts), so a search/filter/
    // sort is worth recording whether or not the page that follows loads
    // cleanly.
    const changed = classifyFilterChange(previousFilters.current, filters);
    previousFilters.current = filters;
    if (changed !== null) {
      logEvent({ action: changed });
      // A new search/filter/sort replaces `rows` with a different result
      // set entirely - unlike the dataVersion-only refresh a bulk action or
      // a single-row save triggers below, where the point is to keep the
      // selection (narrowed to whatever failed) so a retry has something to
      // retry.
      setSelected(EMPTY_SELECTION);
      setBulkOutcome(null);
    }
    void loadFirstPage(filters);
    // Same trigger as the page fetch above (any filter change, or another
    // screen bumping dataVersion after a save) - the brief's own
    // instruction: "re-fetch when the filter changes, alongside the list."
    void loadSummary(filters);
  }, [loadFirstPage, loadSummary, filters, dataVersion]);

  async function loadMore() {
    if (nextCursor === null) {
      return;
    }
    try {
      const page = await api.listReceipts(filters, nextCursor);
      setRows((current) => [...current, ...page.receipts]);
      setNextCursor(page.nextCursor);
      setPendingCount(page.pendingCount);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function saveField(
    id: string,
    patch: ReceiptPatch,
  ): Promise<string | null> {
    try {
      const updated = await api.updateReceipt(id, patch);
      setRows((current) =>
        current.map((row) => (row.id === id ? updated : row)),
      );
      options.noteSaved(updated);
      onChanged();
      logEvent({ action: "receipt_edited", receiptId: id });
      return null;
    } catch (caught) {
      if (caught instanceof ApiError) {
        return caught.message;
      }
      return caught instanceof Error ? caught.message : String(caught);
    }
  }

  /**
   * Runs one bulk action over `ids`, `preBlocked` already-known failures
   * (only ever non-empty for "confirm" - the rows `partitionConfirmable`
   * refused before a request was ever sent). This is the one place that
   * turns a `BatchResult` into what the rest of this screen must do with
   * it:
   *
   * - Every succeeded PATCH's response updates its row in place, the same
   *   way `saveField` above does for a single edit - the server's own
   *   returned row, never a locally-guessed one.
   * - Selection narrows to exactly the ids that failed (blocked or
   *   rejected), so "Confirm" pressed again acts on only what still needs
   *   it - the brief's "leave the failed ones still selected."
   * - `onChanged()` fires once, only if something actually succeeded, and
   *   only once per whole batch rather than once per row - it re-fetches
   *   page one, which is the only path that refreshes `pendingCount`
   *   honestly (§5.2a: that count has to come from the server, never a
   *   locally decremented guess).
   * - `bulkOutcome` is set unconditionally, even on a clean sweep, so the
   *   screen always states a real count rather than ever implying success
   *   silently.
   */
  async function runBulkAction(
    kind: BulkActionKind,
    ids: string[],
    patch: ReceiptPatch,
    preBlocked: BatchFailure[] = [],
  ) {
    setBulkRunning(kind);
    setBulkOutcome(null);
    const result = await runBatch(ids, async (id) => {
      const updated = await api.updateReceipt(id, patch);
      setRows((current) =>
        current.map((row) => (row.id === id ? updated : row)),
      );
      options.noteSaved({
        category: updated.category,
        paymentMethod: updated.paymentMethod,
        vendor: updated.vendor,
      });
    });
    const failed = [...preBlocked, ...result.failed];
    // One receipt_edited per receipt actually changed - the vocabulary's
    // existing per-row action (events.ts), not a bulk-specific one the
    // server does not know. Fire-and-forget, per logEvent's own contract;
    // never for a blocked or rejected id, since nothing changed for those.
    for (const id of result.succeeded) {
      logEvent({ action: "receipt_edited", receiptId: id });
    }
    setSelected(new Set(failed.map((f) => f.id)));
    setBulkOutcome({ kind, result: { succeeded: result.succeeded, failed } });
    setBulkRunning(null);
    // The value just got sent - leaving it sitting in the box reads as
    // "not yet applied" and invites a confused second click. Only the box
    // for the action that actually ran; "confirm" carries no text input.
    if (kind === "category") {
      setBulkCategory("");
    } else if (kind === "paymentMethod") {
      setBulkPayment("");
    }
    if (result.succeeded.length > 0) {
      onChanged();
    }
  }

  const selectedRows = rows.filter((row) => selected.has(row.id));
  // Computed live off the current selection, not only at the moment
  // Confirm is pressed - the brief's "consider disabling or warning before
  // the request is sent." Recomputed every render is cheap at table
  // scale (at most a page's worth of rows).
  const confirmPreview = partitionConfirmable(selectedRows);

  function bulkSetCategory() {
    void runBulkAction("category", Array.from(selected), categoryPatch(bulkCategory));
  }
  function bulkSetPaymentMethod() {
    void runBulkAction(
      "paymentMethod",
      Array.from(selected),
      paymentMethodPatch(bulkPayment),
    );
  }
  function bulkConfirm() {
    void runBulkAction(
      "confirm",
      confirmPreview.confirmable,
      confirmPatch,
      confirmPreview.blocked,
    );
  }

  // What the controls show while nothing is chosen is what the server does
  // with the parameters absent: receipt date, newest first.
  const sort: ReceiptSort = filters.sort ?? "purchasedAt";
  const order: SortOrder = filters.order ?? "desc";

  return (
    <section>
      <div className="table-controls">
        <label>
          From
          <input
            type="date"
            value={filters.from ?? ""}
            onChange={(e) =>
              setFilters((f) => ({
                ...f,
                ...(e.target.value === ""
                  ? { from: undefined }
                  : { from: e.target.value }),
              }))
            }
          />
        </label>
        <label>
          To
          <input
            type="date"
            value={filters.to ?? ""}
            onChange={(e) =>
              setFilters((f) => ({
                ...f,
                ...(e.target.value === ""
                  ? { to: undefined }
                  : { to: e.target.value }),
              }))
            }
          />
        </label>
        <label>
          Status
          <select
            value={filters.status ?? "all"}
            onChange={(e) =>
              setFilters((f) => ({
                ...f,
                ...(e.target.value === "all"
                  ? { status: undefined }
                  : { status: e.target.value as ReceiptStatus }),
              }))
            }
          >
            <option value="all">All</option>
            <option value="pending">Pending</option>
            <option value="confirmed">Confirmed</option>
          </select>
        </label>
        {/* Exact-match filters over the stored free text, offering the
            user's own past values; empty means no filter. */}
        <label>
          Category
          <input
            placeholder="any"
            list={CATEGORY_LIST_ID}
            value={filters.category ?? ""}
            onChange={(e) =>
              setFilters((f) => ({
                ...f,
                ...(e.target.value === ""
                  ? { category: undefined }
                  : { category: e.target.value }),
              }))
            }
          />
        </label>
        <label>
          Payment
          <input
            placeholder="any"
            list={PAYMENT_LIST_ID}
            value={filters.paymentMethod ?? ""}
            onChange={(e) =>
              setFilters((f) => ({
                ...f,
                ...(e.target.value === ""
                  ? { paymentMethod: undefined }
                  : { paymentMethod: e.target.value }),
              }))
            }
          />
        </label>
        <ReceiptOptionsDatalists values={options.values} />
        <label>
          Sort by
          <select
            value={sort}
            onChange={(e) =>
              setFilters((f) => ({ ...f, sort: e.target.value as ReceiptSort }))
            }
          >
            <option value="purchasedAt">Receipt date</option>
            <option value="capturedAt">Capture date</option>
            <option value="total">Total</option>
            <option value="vendor">Vendor</option>
          </select>
        </label>
        <button
          className="sort-order"
          title="Reverse the order"
          onClick={() =>
            setFilters((f) => ({ ...f, order: order === "desc" ? "asc" : "desc" }))
          }
        >
          {describeOrder(sort, order)}
        </button>
        <label className="grow">
          Search
          <input
            type="search"
            placeholder="vendor, category, notes"
            value={filters.q ?? ""}
            onChange={(e) =>
              setFilters((f) => ({
                ...f,
                ...(e.target.value === ""
                  ? { q: undefined }
                  : { q: e.target.value }),
              }))
            }
          />
        </label>
        <button
          className="confirm-queue"
          disabled={pendingCount === 0}
          onClick={onConfirmQueue}
        >
          Confirm queue ({pendingCount})
        </button>
      </div>

      <SummaryLine summary={summary} />

      {error !== null && <p className="error">{error}</p>}

      {selected.size > 0 && (
        <div className="bulk-bar">
          {/* Denominator is always the loaded count, never a total-account
              figure the table has not fetched - the brief's own warning
              about what "select all" must not be misread as. */}
          <span className="bulk-count">
            {selected.size} of {rows.length} loaded selected
          </span>
          <label>
            Set category
            <input
              placeholder="category"
              list={CATEGORY_LIST_ID}
              value={bulkCategory}
              disabled={bulkRunning !== null}
              onChange={(e) => setBulkCategory(e.target.value)}
            />
          </label>
          <button
            className="primary"
            disabled={bulkRunning !== null || bulkCategory.trim() === ""}
            onClick={bulkSetCategory}
          >
            Apply
          </button>
          <label>
            Set payment
            <input
              placeholder="payment method"
              list={PAYMENT_LIST_ID}
              value={bulkPayment}
              disabled={bulkRunning !== null}
              onChange={(e) => setBulkPayment(e.target.value)}
            />
          </label>
          <button
            className="primary"
            disabled={bulkRunning !== null || bulkPayment.trim() === ""}
            onClick={bulkSetPaymentMethod}
          >
            Apply
          </button>
          <div className="bulk-confirm">
            <button
              className="primary"
              disabled={
                bulkRunning !== null || confirmPreview.confirmable.length === 0
              }
              onClick={bulkConfirm}
              title="Moves pending rows to confirmed. Rows with no total on file are skipped."
            >
              Confirm ({confirmPreview.confirmable.length})
            </button>
            {confirmPreview.blocked.length > 0 && (
              <span className="bulk-warning">
                {confirmPreview.blocked.length} of {selected.size} selected{" "}
                {confirmPreview.blocked.length === 1 ? "has" : "have"} no total
                and will be skipped
              </span>
            )}
          </div>
          <button
            className="link"
            disabled={bulkRunning !== null}
            onClick={() => {
              setSelected(EMPTY_SELECTION);
              setBulkOutcome(null);
            }}
          >
            Clear selection
          </button>
          {/* Only shown when it is actually ambiguous: every loaded row is
              selected AND the table knows more receipts exist past what it
              has fetched. This is the concrete answer to "select all must
              not read as all N receipts in my account." */}
          {nextCursor !== null && allLoadedSelected(rows.map((r) => r.id), selected) && (
            <p className="bulk-scope-note muted">
              This selects the {rows.length} loaded rows only - more receipts
              are not loaded. Load more first to include them.
            </p>
          )}
        </div>
      )}

      {bulkOutcome !== null && (
        <BulkOutcomeBanner
          outcome={bulkOutcome}
          rows={rows}
          onDismiss={() => setBulkOutcome(null)}
        />
      )}

      {loading && rows.length === 0 ? (
        <p className="muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="muted empty-state">
          No receipts match. Capture on the phone, or drop files under Upload.
        </p>
      ) : (
        <table className="receipts">
          <thead>
            <tr>
              <th className="select-col">
                <SelectAllCheckbox
                  loadedIds={rows.map((row) => row.id)}
                  selected={selected}
                  disabled={bulkRunning !== null}
                  onToggle={() =>
                    setSelected((current) =>
                      toggleSelectAll(
                        rows.map((row) => row.id),
                        current,
                      ),
                    )
                  }
                />
              </th>
              <th>Date</th>
              <th>Vendor</th>
              <th>Category</th>
              <th className="num">Total</th>
              <th className="num">HST</th>
              <th className="num">Tip</th>
              <th className="num">Other fees</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <ReceiptRow
                key={row.id}
                row={row}
                selected={selected.has(row.id)}
                selectionDisabled={bulkRunning !== null}
                onToggleSelected={() =>
                  setSelected((current) => toggleRow(current, row.id))
                }
                onOpen={() => onOpen(row.id)}
                onSave={(patch) => saveField(row.id, patch)}
              />
            ))}
          </tbody>
        </table>
      )}
      {nextCursor !== null && (
        <button className="load-more" onClick={() => void loadMore()}>
          Load more
        </button>
      )}
    </section>
  );
}

/**
 * The header checkbox. A separate component only for the indeterminate
 * state - React has no `indeterminate` prop (it is not a real HTML
 * attribute, only a DOM property), so it has to be imperatively set on the
 * element after every render that could change it.
 */
function SelectAllCheckbox({
  loadedIds,
  selected,
  disabled,
  onToggle,
}: {
  loadedIds: string[];
  selected: Selection;
  disabled: boolean;
  onToggle: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const allSelected = allLoadedSelected(loadedIds, selected);
  const someSelected = !allSelected && loadedIds.some((id) => selected.has(id));
  useEffect(() => {
    if (ref.current !== null) {
      ref.current.indeterminate = someSelected;
    }
  }, [someSelected]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={allSelected}
      disabled={disabled}
      aria-label={`Select all ${loadedIds.length} loaded receipt${loadedIds.length === 1 ? "" : "s"}`}
      onChange={onToggle}
    />
  );
}

/**
 * The result of one finished bulk action, stated in full every time -
 * never a bare "Done," because part of the batch failing is the normal
 * case here, not the edge case. A clean sweep and a partial one share this
 * one component so a partial failure cannot be styled or worded into
 * looking like success.
 */
function BulkOutcomeBanner({
  outcome,
  rows,
  onDismiss,
}: {
  outcome: BulkOutcome;
  rows: Receipt[];
  onDismiss: () => void;
}) {
  const { result } = outcome;
  const total = result.succeeded.length + result.failed.length;
  const byId = new Map(rows.map((row) => [row.id, row]));
  const label = (id: string) => {
    const row = byId.get(id);
    if (row === undefined) {
      return id;
    }
    return `${row.purchasedAt} · ${row.vendor ?? "no vendor"}`;
  };
  return (
    <div className={`bulk-outcome${result.failed.length > 0 ? " warning" : ""}`}>
      <p>
        {result.succeeded.length} of {total} updated.
        {result.failed.length > 0 &&
          ` ${result.failed.length} failed - still selected, ready to retry.`}
      </p>
      {result.failed.length > 0 && (
        <ul>
          {result.failed.map((failure) => (
            <li key={failure.id}>
              {label(failure.id)}: {failure.reason}
            </li>
          ))}
        </ul>
      )}
      <button className="link" onClick={onDismiss}>
        dismiss
      </button>
    </div>
  );
}

/**
 * Proposal #3's summary line copy, exported for its own unit test - same
 * reasoning as `describeOrder` below: the one place this screen states, in
 * words, what the figures do and do not include. The risk the proposal
 * names by name: "the number invites being read as a tax figure... a
 * summary that quietly counted pending rows would disagree with the export
 * sitting next to it." Both halves of the mitigation are in this one
 * sentence - the money is captioned "confirmed only" in the same breath it
 * is stated, and the pending count is its own clause, read off
 * `summary.pendingCount` and never folded into `summary.confirmed`'s
 * figures beside it.
 */
export function describeSummary(summary: ReceiptSummary): string {
  const { count, totalCents, hstCents } = summary.confirmed;
  return (
    `${count} confirmed receipt${count === 1 ? "" : "s"} · ` +
    `${formatCents(totalCents)} spent · ${formatCents(hstCents)} HST - ` +
    `confirmed only, excludes ${summary.pendingCount} pending`
  );
}

/**
 * Renders nothing before the first answer or after a failed one
 * (`summary === null`) - "a failure to load the summary must not break the
 * table" (the brief's own words), so this is the one piece of this screen
 * allowed to just quietly not be there.
 */
function SummaryLine({ summary }: { summary: ReceiptSummary | null }) {
  if (summary === null) {
    return null;
  }
  return <p className="summary-line">{describeSummary(summary)}</p>;
}

/**
 * The order button says what the order is, in the words of the key it
 * sorts: "newest first" means nothing about a vendor column. Exported for
 * its unit test - this mapping is the only part of the sort controls that
 * is not a straight pass-through to the server.
 */
export function describeOrder(sort: ReceiptSort, order: SortOrder): string {
  switch (sort) {
    case "purchasedAt":
    case "capturedAt":
      return order === "desc" ? "↓ newest first" : "↑ oldest first";
    case "total":
      return order === "desc" ? "↓ largest first" : "↑ smallest first";
    case "vendor":
      return order === "desc" ? "↓ Z to A" : "↑ A to Z";
  }
}

function ReceiptRow({
  row,
  selected,
  selectionDisabled,
  onToggleSelected,
  onOpen,
  onSave,
}: {
  row: Receipt;
  selected: boolean;
  selectionDisabled: boolean;
  onToggleSelected: () => void;
  onOpen: () => void;
  onSave: (patch: ReceiptPatch) => Promise<string | null>;
}) {
  const [rowError, setRowError] = useState<string | null>(null);

  const save = async (patch: ReceiptPatch) => {
    setRowError(await onSave(patch));
  };

  return (
    <>
      <tr className={row.status === "pending" ? "pending" : ""}>
        <td className="select-col">
          <input
            type="checkbox"
            checked={selected}
            disabled={selectionDisabled}
            aria-label={`Select receipt from ${row.vendor ?? "unknown vendor"} on ${row.purchasedAt}`}
            onChange={onToggleSelected}
          />
        </td>
        <td>
          <DateCell value={row.purchasedAt} onSave={(v) => save({ purchasedAt: v })} />
        </td>
        <td>
          <TextCell
            value={row.vendor}
            placeholder="vendor"
            list={VENDOR_LIST_ID}
            onSave={(v) => save({ vendor: v })}
          />
        </td>
        <td>
          <TextCell
            value={row.category}
            placeholder="category"
            list={CATEGORY_LIST_ID}
            onSave={(v) => save({ category: v })}
          />
        </td>
        <td className="num">
          <MoneyCell
            value={row.totalCents}
            onSave={(v) => save({ totalCents: v })}
            onBadInput={setRowError}
          />
        </td>
        <td className="num">
          <MoneyCell
            value={row.hstCents}
            onSave={(v) => save({ hstCents: v })}
            onBadInput={setRowError}
          />
        </td>
        <td className="num">
          <MoneyCell
            value={row.tipCents}
            onSave={(v) => save({ tipCents: v })}
            onBadInput={setRowError}
          />
        </td>
        <td className="num">
          <MoneyCell
            value={row.otherFeesCents}
            onSave={(v) => save({ otherFeesCents: v })}
            onBadInput={setRowError}
          />
        </td>
        <td>
          <button className={`link status-${row.status}`} onClick={onOpen}>
            {row.status}
          </button>
        </td>
      </tr>
      {rowError !== null && (
        <tr className="row-error">
          <td colSpan={9}>
            <span className="error">{rowError}</span>
            <button className="link" onClick={() => setRowError(null)}>
              dismiss
            </button>
          </td>
        </tr>
      )}
    </>
  );
}

function DateCell({
  value,
  onSave,
}: {
  value: string;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <input
      type="date"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== value && draft !== "") {
          onSave(draft);
        }
      }}
    />
  );
}

function TextCell({
  value,
  placeholder,
  list,
  onSave,
}: {
  value: string | null;
  placeholder: string;
  /** A datalist to offer past values from, where one exists (category). */
  list?: string;
  onSave: (value: string | null) => void;
}) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  return (
    <input
      value={draft}
      placeholder={placeholder}
      list={list}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        const next = draft.trim() === "" ? null : draft.trim();
        if (next !== value) {
          onSave(next);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function MoneyCell({
  value,
  onSave,
  onBadInput,
}: {
  value: number | null;
  onSave: (value: number | null) => void;
  onBadInput: (message: string) => void;
}) {
  const [draft, setDraft] = useState(formatCents(value));
  useEffect(() => setDraft(formatCents(value)), [value]);
  return (
    <input
      className="money"
      value={draft}
      placeholder="Not found"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        let parsed: number | null;
        try {
          parsed = parseMoneyInput(draft);
        } catch (caught) {
          onBadInput(caught instanceof Error ? caught.message : String(caught));
          setDraft(formatCents(value));
          return;
        }
        if (parsed !== value) {
          onSave(parsed);
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.currentTarget.blur();
        }
      }}
    />
  );
}
