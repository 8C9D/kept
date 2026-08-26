import { useCallback, useEffect, useState } from "react";
import type { KeptApi } from "../api.js";
import { ApiError } from "../api.js";
import { formatCents, parseMoneyInput } from "../money.js";
import {
  CATEGORY_LIST_ID,
  PAYMENT_LIST_ID,
  ReceiptOptionsDatalists,
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
        <p className="muted">
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
        <td>
          <button className="link" onClick={onOpen}>
            {row.status}
          </button>
        </td>
      </tr>
      {rowError !== null && (
        <tr className="row-error">
          <td colSpan={6}>
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
      placeholder="0.00"
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
