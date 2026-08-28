import { useCallback, useEffect, useRef, useState } from "react";
import type { KeptApi } from "../api.js";
import { ApiError } from "../api.js";
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
  // For classifyFilterChange below - the effect that fetches on `filters`
  // also fires on a `dataVersion` bump alone (another screen changed a
  // receipt), which must not be misread as a search/filter/sort action.
  const previousFilters = useRef(filters);

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

  useEffect(() => {
    // Logged for the action itself, not the fetch's outcome - there is no
    // list_search_failed in the vocabulary (events.ts), so a search/filter/
    // sort is worth recording whether or not the page that follows loads
    // cleanly.
    const changed = classifyFilterChange(previousFilters.current, filters);
    previousFilters.current = filters;
    if (changed !== null) {
      logEvent({ action: changed });
    }
    void loadFirstPage(filters);
  }, [loadFirstPage, filters, dataVersion]);

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

      {error !== null && <p className="error">{error}</p>}
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
  onOpen,
  onSave,
}: {
  row: Receipt;
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
          <td colSpan={8}>
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
