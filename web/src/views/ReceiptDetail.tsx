import { useEffect, useRef, useState } from "react";
import type { KeptApi } from "../api.js";
import { logEvent } from "../events.js";
import type { ReceiptOptionsHandle } from "../options.js";
import type { ReceiptDetail } from "../types.js";
import {
  DraftError,
  ReceiptFieldsForm,
  draftForDisplay,
  draftFromReceipt,
  logFieldEditTelemetry,
  patchFromDraft,
  type ReceiptDraft,
} from "./ReceiptForm.js";

/**
 * Spec §7A screen 3: the image at full size beside its fields, for
 * checking a number against the paper properly. Save is one PATCH of what
 * changed - on a confirmed receipt exactly as on a pending one, which is
 * the point of the screen and not an exception to guard; delete is soft
 * (the server keeps the row for retention) and two-step inline - never
 * window.confirm, which blocks the whole page.
 */
export function ReceiptDetailView({
  api,
  receiptId,
  options,
  onBack,
  onChanged,
}: {
  api: KeptApi;
  receiptId: string;
  options: ReceiptOptionsHandle;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [receipt, setReceipt] = useState<ReceiptDetail | null>(null);
  const [draft, setDraft] = useState<ReceiptDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Every field name `ReceiptFieldsForm.onFieldEdited` has reported since
  // this receipt loaded, once per edit - `summarizeFieldEdits` (ReceiptForm)
  // turns it into save-time counts and suggestion outcomes. A ref, not
  // state: nothing here should ever trigger a re-render on its own.
  const editsRef = useRef<(keyof ReceiptDraft)[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await api.receipt(receiptId);
        if (!cancelled) {
          setReceipt(loaded);
          setDraft(draftForDisplay(loaded));
          editsRef.current = [];
          logEvent({ action: "receipt_viewed", receiptId: loaded.id });
        }
      } catch (caught) {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : String(caught));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api, receiptId]);

  if (receipt === null || draft === null) {
    return (
      <section>
        <button className="link" onClick={onBack}>
          ← Back
        </button>
        {error !== null ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}
      </section>
    );
  }

  async function save() {
    if (receipt === null || draft === null) {
      return;
    }
    setError(null);
    setNotice(null);
    let patch;
    try {
      patch = patchFromDraft(receipt, draft);
    } catch (caught) {
      if (caught instanceof DraftError) {
        setError(caught.message);
        return;
      }
      throw caught;
    }
    if (Object.keys(patch).length === 0) {
      setNotice("Nothing changed.");
      return;
    }
    try {
      const updated = await api.updateReceipt(receipt.id, patch);
      setReceipt({ ...receipt, ...updated });
      setDraft(draftFromReceipt({ ...receipt, ...updated }));
      setNotice("Saved.");
      options.noteSaved(updated);
      onChanged();
      logEvent({ action: "receipt_edited", receiptId: receipt.id });
      logFieldEditTelemetry(receipt, editsRef.current);
      // Reset after a successful save only - a failed one leaves the
      // person still mid-edit, and the next successful save should still
      // count everything since the receipt loaded, not just since the
      // failure.
      editsRef.current = [];
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function remove() {
    if (receipt === null) {
      return;
    }
    try {
      await api.deleteReceipt(receipt.id);
      logEvent({ action: "receipt_deleted", receiptId: receipt.id });
      onChanged();
      onBack();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  return (
    <section className="detail">
      <div className="detail-header">
        <button className="link" onClick={onBack}>
          ← Back
        </button>
        <span className={`status-tag ${receipt.status}`}>{receipt.status}</span>
      </div>
      <div className="detail-body">
        <div className="detail-image">
          {receipt.images.length === 0 ? (
            <p className="muted no-image">No image behind this receipt.</p>
          ) : (
            receipt.images.map((image) => (
              <ReceiptImage key={image.page} url={image.downloadUrl} />
            ))
          )}
        </div>
        <div className="detail-fields">
          <ReceiptFieldsForm
            receipt={receipt}
            draft={draft}
            setDraft={(update) => setDraft((d) => (d === null ? d : update(d)))}
            options={options.values}
            onFieldEdited={(field) => editsRef.current.push(field)}
          />
          {error !== null && <p className="error">{error}</p>}
          {notice !== null && <p className="muted">{notice}</p>}
          <div className="detail-actions">
            <button className="primary" onClick={() => void save()}>
              Save
            </button>
            {!confirmingDelete ? (
              <button className="danger" onClick={() => setConfirmingDelete(true)}>
                Delete…
              </button>
            ) : (
              <span className="delete-confirm">
                Delete this receipt and its image from every future export?
                <button className="danger" onClick={() => void remove()}>
                  Delete receipt
                </button>
                <button onClick={() => setConfirmingDelete(false)}>Keep it</button>
              </span>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * A presigned GET renders directly; whether it is a PDF is read from the
 * object key's extension inside the URL (the key is issued with one), not
 * guessed from bytes.
 */
export function ReceiptImage({ url }: { url: string }) {
  const isPdf = new URL(url).pathname.endsWith(".pdf");
  return isPdf ? (
    <iframe className="receipt-pdf" src={url} title="Receipt PDF" />
  ) : (
    <img className="receipt-photo" src={url} alt="Receipt" />
  );
}
