import { useCallback, useEffect, useRef, useState } from "react";
import type { KeptApi } from "../api.js";
import { logEvent } from "../events.js";
import type { ReceiptOptionsHandle } from "../options.js";
import type { ReceiptDetail } from "../types.js";
import { ReceiptImage } from "./ReceiptDetail.js";
import {
  DraftError,
  ReceiptFieldsForm,
  draftFromPending,
  logFieldEditTelemetry,
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
  // Same accumulator as ReceiptDetailView's, reset per receipt and read out
  // at Confirm - see ReceiptForm.tsx's `summarizeFieldEdits`.
  const editsRef = useRef<(keyof ReceiptDraft)[]>([]);

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
        editsRef.current = [];
        logEvent({ action: "confirm_opened", receiptId: detail.id });
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
      logEvent({ action: "confirm_saved", receiptId: current.id });
      logFieldEditTelemetry(current, editsRef.current);
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
      {/* The date-disagreement note is rendered inside ReceiptFieldsForm
          now (§10A.1: same treatment as the arithmetic warning, "inside
          the field"), off the same receipt.suggestions this screen already
          hands the form - nothing left to read here. */}
      <div className="detail-body">
        <div className="detail-image">
          {current.images.length === 0 ? (
            <p className="muted no-image">No image behind this receipt.</p>
          ) : (
            current.images.map((image) => (
              <ReceiptImage key={image.page} url={image.downloadUrl} />
            ))
          )}
        </div>
        <div className="detail-fields">
          <ReceiptFieldsForm
            receipt={current}
            draft={draft}
            setDraft={(update) => setDraft((d) => (d === null ? d : update(d)))}
            options={options.values}
            onFieldEdited={(field) => editsRef.current.push(field)}
          />
          {error !== null && <p className="error">{error}</p>}
          <div className="detail-actions">
            <button className="primary" onClick={() => void confirm()}>
              Confirm
            </button>
            <button onClick={skip}>Skip for now</button>
          </div>
        </div>
      </div>
    </section>
  );
}
