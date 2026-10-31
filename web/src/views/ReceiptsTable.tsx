import { useCallback, useEffect, useRef, useState } from "react";
import type { KeptApi } from "../api.js";
import { ApiError } from "../api.js";
import {
  EMPTY_SELECTION,
  allLoadedSelected,
  categoryPatch,
  confirmPatch,
  describeBlocked,
  inlineEditPatch,
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
import { freeTextWrite } from "../freeText.js";
import {
  HOME_CURRENCY,
  foreignCurrency,
  formatCents,
  formatMoney,
  parseMoneyInput,
} from "../money.js";
import {
  CATEGORY_LIST_ID,
  PAYMENT_LIST_ID,
  ReceiptOptionsDatalists,
  VENDOR_LIST_ID,
  type ReceiptOptionsHandle,
} from "../options.js";
import { LatestRequest, appendPage, serializeByKey } from "../requests.js";
import { displayedTotalCents } from "../suggestions.js";
import type {
  ListFilters,
  Receipt,
  ReceiptCurrencySummary,
  ReceiptPatch,
  ReceiptSort,
  ReceiptStatus,
  ReceiptSummary,
  SortOrder,
} from "../types.js";
import { useGuardedAction } from "../useGuardedAction.js";

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
 *
 * A save is the opposite of a filter change, and this screen keeps the two
 * apart (2026-10). A filter replaces the result set; a save changes one row
 * of it and must leave the rest exactly where they are - the rows loaded past
 * page one, the selection, whatever is half-typed in the next cell. So a
 * save, single or bulk, updates its rows in place from the server's answer
 * and refreshes the two figures it can have moved (`refreshCounts`), and
 * never re-runs the first-page load. A consequence, accepted: a row edited
 * out of the current filter or sort stays where it is until the next load.
 */
export function ReceiptsTable({
  api,
  dataVersion,
  options,
  onOpen,
  onConfirmQueue,
}: {
  api: KeptApi;
  dataVersion: number;
  options: ReceiptOptionsHandle;
  onOpen: (id: string) => void;
  onConfirmQueue: () => void;
}) {
  const [filters, setFilters] = useState<ListFilters>({});
  const [rows, setRows] = useState<Receipt[]>([]);
  // `rows` as of the newest response rather than the newest render, for the
  // one reader that cannot wait for a render - see `saveField`.
  const latestRows = useRef<Receipt[]>([]);
  const commitRows = useCallback(
    (next: (current: Receipt[]) => Receipt[]) => {
      latestRows.current = next(latestRows.current);
      setRows(latestRows.current);
    },
    [],
  );
  const replaceRow = (updated: Receipt) =>
    commitRows((current) =>
      current.map((row) => (row.id === updated.id ? updated : row)),
    );
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
  // Also the filter a background refresh reads: an edit's PATCH can come back
  // after the filter changed, and it must refresh the figures for the filter
  // on screen, not the one in force when the cell was blurred.
  const previousFilters = useRef(filters);
  // Typing "cos" sends "c", "co" and "cos", and nothing makes the answers
  // arrive in that order - a late "co" used to overwrite the "cos" rows, the
  // cursor and the HST summary. One generation per kind of figure, since
  // each can be refreshed on its own (`requests.ts`).
  const listRequests = useRef(new LatestRequest());
  const summaryRequests = useRef(new LatestRequest());
  const pendingRequests = useRef(new LatestRequest());
  const rowSaves = useRef(serializeByKey());
  const { busy: loadingMore, run: runLoadMore } = useGuardedAction();

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
      const ticket = listRequests.current.begin();
      const pendingTicket = pendingRequests.current.begin();
      setLoading(true);
      setError(null);
      // The cursor in hand belongs to the result set being replaced; the
      // server refuses one minted under a different sort, and it would be
      // the wrong position under a different filter either way.
      setNextCursor(null);
      try {
        const page = await api.listReceipts(activeFilters, null);
        if (listRequests.current.isLatest(ticket)) {
          commitRows(() => page.receipts);
          setNextCursor(page.nextCursor);
        }
        if (pendingRequests.current.isLatest(pendingTicket)) {
          setPendingCount(page.pendingCount);
        }
      } catch (caught) {
        if (listRequests.current.isLatest(ticket)) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      } finally {
        if (listRequests.current.isLatest(ticket)) {
          setLoading(false);
        }
      }
    },
    [api, commitRows],
  );

  const loadSummary = useCallback(
    async (activeFilters: ListFilters) => {
      const ticket = summaryRequests.current.begin();
      try {
        const loaded = await api.receiptSummary(activeFilters);
        if (summaryRequests.current.isLatest(ticket)) {
          setSummary(loaded);
        }
      } catch {
        // Proposal #3's own instruction: a failed aggregate fetch must
        // never break the table sitting below it - degrade to no summary.
        // Unlike `options.ts`'s "keep the last good lists", the last good
        // summary is NOT kept here: it would be a total for a filter that
        // has since changed, which is actively misleading rather than
        // merely missing, and this row has nothing else on screen it could
        // silently disagree with the way a stale picker list would not.
        if (summaryRequests.current.isLatest(ticket)) {
          setSummary(null);
        }
      }
    },
    [api],
  );

  /**
   * The two figures a save can move, and nothing else: the summary for the
   * filter on screen, and the account-wide pending badge, which only the
   * list route can answer (§5.2a: it has to come from the server, never a
   * locally decremented guess). Both are background calls.
   */
  function refreshCounts() {
    void loadSummary(previousFilters.current);
    const ticket = pendingRequests.current.begin();
    void api.pendingCount().then(
      (count) => {
        if (pendingRequests.current.isLatest(ticket)) {
          setPendingCount(count);
        }
      },
      () => {
        // A badge over rows that are already right. The last count stays up
        // until the next list load corrects it - the save itself landed, and
        // a failed refresh of a figure beside it is not worth an error.
      },
    );
  }

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
      // set entirely - unlike a bulk action or a single-row save, which
      // update rows in place below, where the point is to keep the selection
      // (narrowed to whatever failed) so a retry has something to retry.
      setSelected(EMPTY_SELECTION);
      setBulkOutcome(null);
    }
    void loadFirstPage(filters);
    // Same trigger as the page fetch above (any filter change, or another
    // screen bumping dataVersion after a save) - the brief's own
    // instruction: "re-fetch when the filter changes, alongside the list."
    void loadSummary(filters);
  }, [loadFirstPage, loadSummary, filters, dataVersion]);

  /**
   * Run through `runLoadMore`, which is what stops a double-click fetching
   * one cursor twice and appending the same page twice. Ticketed against the
   * current list without starting a new one: this extends the result set a
   * first-page load produced, so a filter change that replaces that set
   * discards this answer too.
   */
  async function loadMore() {
    if (nextCursor === null) {
      return;
    }
    const ticket = listRequests.current.current();
    const pendingTicket = pendingRequests.current.begin();
    try {
      const page = await api.listReceipts(filters, nextCursor);
      if (listRequests.current.isLatest(ticket)) {
        commitRows((current) => appendPage(current, page.receipts));
        setNextCursor(page.nextCursor);
      }
      if (pendingRequests.current.isLatest(pendingTicket)) {
        setPendingCount(page.pendingCount);
      }
    } catch (caught) {
      if (listRequests.current.isLatest(ticket)) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    }
  }

  /**
   * One inline edit. In place, per the note on this component.
   *
   * ⚠ Saves on one row run one at a time, and the patch is built when its
   * turn comes rather than when the cell was blurred, off `latestRows`. That
   * is what makes `inlineEditPatch`'s union true: `reviewedFields` replaces
   * the stored set outright, so tabbing Total -> HST with the first PATCH
   * still out would otherwise send a set without `totalCents` in it, and the
   * second save would hand the first field back to the parser. It also puts
   * the responses in order, so an older answer cannot redraw a newer value.
   */
  function saveField(row: Receipt, patch: ReceiptPatch): Promise<string | null> {
    return rowSaves.current(row.id, async () => {
      const latest =
        latestRows.current.find((candidate) => candidate.id === row.id) ?? row;
      try {
        const updated = await api.updateReceipt(
          row.id,
          inlineEditPatch(latest, patch),
        );
        replaceRow(updated);
        options.noteSaved(updated);
        refreshCounts();
        logEvent({ action: "receipt_edited", receiptId: row.id });
        return null;
      } catch (caught) {
        if (caught instanceof ApiError) {
          return caught.message;
        }
        return caught instanceof Error ? caught.message : String(caught);
      }
    });
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
   * - `refreshCounts()` fires once, only if something actually succeeded,
   *   and only once per whole batch rather than once per row. Never a
   *   re-fetch of page one: that dropped every row past it, so a failed row
   *   on page two stayed selected with nothing on screen to act on, and the
   *   button read `Confirm (0)`.
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
      const updated = await rowSaves.current(id, () =>
        api.updateReceipt(id, patch),
      );
      replaceRow(updated);
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
      refreshCounts();
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
              title="Moves pending rows to confirmed. Rows with no total on file, or with amounts to enter from the paper, are skipped."
            >
              Confirm ({confirmPreview.confirmable.length})
            </button>
            {confirmPreview.blocked.length > 0 && (
              <span className="bulk-warning">
                {describeBlocked(confirmPreview.blocked, selected.size)}
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
                onSave={(patch) => saveField(row, patch)}
              />
            ))}
          </tbody>
        </table>
      )}
      {nextCursor !== null && (
        <button
          className="load-more"
          disabled={loadingMore}
          onClick={() => runLoadMore(loadMore)}
        >
          {loadingMore ? "Loading…" : "Load more"}
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
 * `summary.pendingCount` and never folded into the confirmed figures beside
 * it.
 *
 * ⚠ One clause per currency (2026-10), never one sum: $100 CAD and $100 USD
 * are not $200 of anything, and the same sentence that keeps pending out of
 * the money has to keep the currencies apart. The receipt COUNT does add up,
 * and is stated once.
 */
export function describeSummary(summary: ReceiptSummary): string {
  const currencies = summaryCurrencies(summary);
  const count = currencies.reduce((sum, row) => sum + row.count, 0);
  const money = currencies
    .map(
      ({ currency, totalCents, hstCents }) =>
        // HST is a Canadian tax: a USD receipt with none has no such line.
        currency !== "CAD" && hstCents === 0
          ? `${formatMoney(totalCents, currency)} spent`
          : `${formatMoney(totalCents, currency)} spent · ${formatMoney(hstCents, currency)} HST`,
    )
    .join(" · ");
  return (
    `${count} confirmed receipt${count === 1 ? "" : "s"} · ${money} - ` +
    `confirmed only, excludes ${summary.pendingCount} pending`
  );
}

/**
 * The currencies worth a clause: every `byCurrency` row that has receipts in
 * it, or the CAD figures alone when none does, so an empty filter still
 * states its $0.00 rather than a sentence with no amount in it.
 *
 * That fallback is also the whole of the compatibility with a server older
 * than `byCurrency`, whose `confirmed` sums every currency: it renders that
 * figure as it always has rather than taking this screen down, for the
 * length of a deploy, over a key that has not landed yet.
 */
export function summaryCurrencies(
  summary: ReceiptSummary,
): ReceiptCurrencySummary[] {
  const withReceipts = (summary.byCurrency ?? []).filter((row) => row.count > 0);
  return withReceipts.length > 0
    ? withReceipts
    : [{ currency: HOME_CURRENCY, ...summary.confirmed }];
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

/**
 * A row's error line, and the field it is about. `field` is null for a
 * mistyped amount: that cell reverts to the stored value, so nothing is left
 * unsaved and the line only explains what just happened.
 */
export interface RowError {
  field: string | null;
  message: string;
}

/**
 * The row's error line once a save has answered, exported for its unit test.
 *
 * ⚠ A success only clears the error it answers (2026-10). This used to be
 * one assignment, so a failed Total followed by a good HST wiped the failure
 * and left the refused amount sitting in its cell, unsaved, with nothing on
 * screen to say so. Saves on a row run in order now (`saveField`), which made
 * that sequence the normal one rather than a matter of timing.
 */
export function rowErrorAfterSave(
  current: RowError | null,
  patch: ReceiptPatch,
  failure: string | null,
): RowError | null {
  const field = Object.keys(patch)[0] ?? null;
  if (failure !== null) {
    return { field, message: failure };
  }
  return current?.field === null || current?.field === field ? null : current;
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
  const [rowError, setRowError] = useState<RowError | null>(null);
  // The boxes below hold editable text, so they stay in the "$" form that
  // parses back; this is what says so on a row that is not in dollars CAD.
  const currency = foreignCurrency(row.currency);

  const save = async (patch: ReceiptPatch) => {
    const failure = await onSave(patch);
    setRowError((current) => rowErrorAfterSave(current, patch, failure));
  };
  const badInput = (message: string) => setRowError({ field: null, message });

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
            value={displayedTotalCents(row)}
            onSave={(v) => save({ totalCents: v })}
            onBadInput={badInput}
          />
          {currency !== null && <span className="currency-tag">{currency}</span>}
        </td>
        <td className="num">
          <MoneyCell
            value={row.hstCents}
            onSave={(v) => save({ hstCents: v })}
            onBadInput={badInput}
          />
        </td>
        <td className="num">
          <MoneyCell
            value={row.tipCents}
            onSave={(v) => save({ tipCents: v })}
            onBadInput={badInput}
          />
        </td>
        <td className="num">
          <MoneyCell
            value={row.otherFeesCents}
            onSave={(v) => save({ otherFeesCents: v })}
            onBadInput={badInput}
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
            <span className="error">{rowError.message}</span>
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
        const write = freeTextWrite(draft, value);
        if (write !== undefined) {
          onSave(write);
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
