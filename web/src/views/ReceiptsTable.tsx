import { useCallback, useEffect, useState } from "react";
import type { KeptApi } from "../api.js";
import { ApiError } from "../api.js";
import { formatCents, parseMoneyInput } from "../money.js";
import type {
  ListFilters,
  Receipt,
  ReceiptPatch,
  ReceiptStatus,
} from "../types.js";

/**
 * Spec §7A screen 2: every receipt, filterable (date range, business/
 * personal, status, free-text over vendor/category/notes), inline editing,
 * row click opens the receipt. Sorted as the server sorts - newest
 * purchase first, keyset-paged - and filters reset paging, because a
 * cursor encodes the sort position of a different result set.
 */
export function ReceiptsTable({
  api,
  dataVersion,
  onOpen,
  onConfirmQueue,
  onChanged,
}: {
  api: KeptApi;
  dataVersion: number;
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
      onChanged();
      return null;
    } catch (caught) {
      if (caught instanceof ApiError) {
        return caught.message;
      }
      return caught instanceof Error ? caught.message : String(caught);
    }
  }

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
          Type
          <select
            value={
              filters.isBusiness === undefined
                ? "all"
                : filters.isBusiness
                  ? "business"
                  : "personal"
            }
            onChange={(e) =>
              setFilters((f) => ({
                ...f,
                ...(e.target.value === "all"
                  ? { isBusiness: undefined }
                  : { isBusiness: e.target.value === "business" }),
              }))
            }
          >
            <option value="all">All</option>
            <option value="business">Business</option>
            <option value="personal">Personal</option>
          </select>
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
              <th>Type</th>
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
          <select
            value={row.isBusiness === null ? "" : row.isBusiness ? "b" : "p"}
            onChange={(e) => {
              if (e.target.value !== "") {
                void save({ isBusiness: e.target.value === "b" });
              }
            }}
          >
            {/* No default (spec §5.2): an unchosen receipt shows the absence. */}
            {row.isBusiness === null && <option value="">—</option>}
            <option value="b">Business</option>
            <option value="p">Personal</option>
          </select>
        </td>
        <td>
          <button className="link" onClick={onOpen}>
            {row.status}
          </button>
        </td>
      </tr>
      {rowError !== null && (
        <tr className="row-error">
          <td colSpan={7}>
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
  onSave,
}: {
  value: string | null;
  placeholder: string;
  onSave: (value: string | null) => void;
}) {
  const [draft, setDraft] = useState(value ?? "");
  useEffect(() => setDraft(value ?? ""), [value]);
  return (
    <input
      value={draft}
      placeholder={placeholder}
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
