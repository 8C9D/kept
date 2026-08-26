import { useCallback, useEffect, useState } from "react";
import type { KeptApi } from "../api.js";
import type { ReceiptOptionsHandle } from "../options.js";
import type { ReceiptDetail } from "../types.js";
import { ReceiptImage } from "./ReceiptDetail.js";
import {
  DraftError,
  ReceiptFieldsForm,
  draftFromPending,
  patchFromDraft,
  type ReceiptDraft,
} from "./ReceiptForm.js";

/**
 * Spec §6A consequence 3: "next unconfirmed receipt" as a repeatable
 * action, so a backlog is worked down in a sitting rather than hunted
 * through a list. The form prefills the served merge exactly as the iOS
 * confirm screen does (suggestion over row copy - constraint 2: these are
 * suggestions in an editable form, and nothing saves without the person
 * pressing Confirm). Confirm is one PATCH carrying the edited fields and
 * status=confirmed; the server refuses it without a total, and this screen
 * surfaces that refusal in the server's own words.
 */
export function ConfirmQueue({
  api,
  options,
  onDone,
}: {
  api: KeptApi;
  options: ReceiptOptionsHandle;
  onDone: () => void;
}) {
  const [current, setCurrent] = useState<ReceiptDetail | null>(null);
  const [draft, setDraft] = useState<ReceiptDraft | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [skippedIds, setSkippedIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [exhausted, setExhausted] = useState(false);

  const loadNext = useCallback(
    async (skip: string[]) => {
      setError(null);
      try {
        // A page of pending receipts, newest first as the server sorts;
        // skipped ones stay pending, so they are filtered out client-side
        // until the queue is left and re-entered.
        const page = await api.listReceipts({ status: "pending" }, null);
        setRemaining(page.pendingCount);
        const next = page.receipts.find((r) => !skip.includes(r.id));
        if (next === undefined) {
          setCurrent(null);
          setDraft(null);
          setExhausted(true);
          return;
        }
        const detail = await api.receipt(next.id);
        setCurrent(detail);
        setDraft(draftFromPending(detail));
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [api],
  );

  useEffect(() => {
    void loadNext([]);
  }, [loadNext]);

  async function confirm() {
    if (current === null || draft === null) {
      return;
    }
    setError(null);
    let patch;
    try {
      patch = patchFromDraft(current, draft);
    } catch (caught) {
      if (caught instanceof DraftError) {
        setError(caught.message);
        return;
      }
      throw caught;
    }
    try {
      const confirmed = await api.updateReceipt(current.id, {
        ...patch,
        status: "confirmed",
      });
      options.noteSaved(confirmed);
      await loadNext(skippedIds);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function skip() {
    if (current === null) {
      return;
    }
    const skip = [...skippedIds, current.id];
    setSkippedIds(skip);
    void loadNext(skip);
  }

  if (exhausted) {
    return (
      <section className="confirm-queue-view">
        <p>
          {skippedIds.length === 0
            ? "Nothing left to confirm."
            : `Nothing left except the ${skippedIds.length} you skipped.`}
        </p>
        <button onClick={onDone}>Back to receipts</button>
      </section>
    );
  }

  if (current === null || draft === null) {
    return (
      <section className="confirm-queue-view">
        {error !== null ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}
        <button className="link" onClick={onDone}>
          Leave the queue
        </button>
      </section>
    );
  }

  const suggestions = current.suggestions;
  return (
    <section className="confirm-queue-view">
      <div className="detail-header">
        <button className="link" onClick={onDone}>
          ← Leave the queue
        </button>
        <span className="muted">
          {remaining === null ? "" : `${remaining} pending`}
        </span>
      </div>
      {suggestions?.purchasedAt.disagreement === true && (
        <p className="warning">
          The two parsers read different dates from this receipt - check the
          paper before confirming.
        </p>
      )}
      <div className="detail-body">
        <div className="detail-image">
          {current.images.length === 0 ? (
            <p className="muted">No image behind this receipt.</p>
          ) : (
            current.images.map((image) => (
              <ReceiptImage key={image.page} url={image.downloadUrl} />
            ))
          )}
        </div>
        <div className="detail-fields">
          <ReceiptFieldsForm
            draft={draft}
            setDraft={(update) => setDraft((d) => (d === null ? d : update(d)))}
            options={options.values}
          />
          {error !== null && <p className="error">{error}</p>}
          <div className="detail-actions">
            <button onClick={() => void confirm()}>Confirm</button>
            <button onClick={skip}>Skip for now</button>
          </div>
        </div>
      </div>
    </section>
  );
}
