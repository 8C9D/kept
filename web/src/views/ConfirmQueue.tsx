import { useCallback, useEffect, useRef, useState } from "react";
import type { KeptApi } from "../api.js";
import { findNextPending } from "../confirmQueue.js";
import { logEvent } from "../events.js";
import type { ReceiptOptionsHandle } from "../options.js";
import type { ReceiptDetail } from "../types.js";
import { useGuardedAction } from "../useGuardedAction.js";
import { ReceiptImage } from "./ReceiptDetail.js";
import {
  DraftError,
  ReceiptFieldsForm,
  draftFromPending,
  logFieldEditTelemetry,
  patchForConfirm,
  patchForSaveForLater,
  type ReceiptDraft,
  type SuggestibleField,
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
  onOpenReceipt,
  onDone,
}: {
  api: KeptApi;
  options: ReceiptOptionsHandle;
  /** Proposal #8: "open the matching receipt" leaves the queue for that
   * receipt's own detail screen - App.tsx owns the view state this drives. */
  onOpenReceipt: (id: string) => void;
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
  // Same accumulator as ReceiptDetailView's `clientAppliedRef` - which
  // fields carried a derived-amount fill or vendor default this session,
  // read out at Confirm alongside `editsRef` so those two sources are
  // scored accepted/overridden the same save-time way (2026-08-28 ruling).
  const clientAppliedRef = useRef<Set<SuggestibleField>>(new Set());
  // Which fields this session has REVIEWED - typed in, or chosen from an
  // amount chip (2026-09-01, ReceiptForm's `onFieldReviewed`). Read out at
  // Confirm and at Save for later, where `reviewedFieldsForSave` unions it
  // with whatever the receipt already carried.
  const reviewedRef = useRef<Set<keyof ReceiptDraft>>(new Set());
  // ⚠ Constraint 2 rests on this one (2026-10). Confirm is PATCH + list +
  // detail, and on a slow connection that is seconds in which the button
  // looked live: a re-click landed after the screen had moved on, and
  // confirmed the NEXT receipt with OCR values nobody had read. Every action
  // here goes through `run`, which refuses a second one outright, and `busy`
  // holds the form and all three buttons disabled until the commit that puts
  // the next receipt on screen.
  const { busy, run } = useGuardedAction();

  const loadNext = useCallback(
    async (skip: string[]) => {
      setError(null);
      try {
        // Pending receipts, newest first as the server sorts; skipped ones
        // stay pending, so they are filtered out client-side until the queue
        // is left and re-entered - as many pages as that takes.
        const { next, pendingCount } = await findNextPending(
          (cursor) => api.listReceipts({ status: "pending" }, cursor),
          skip,
        );
        setRemaining(pendingCount);
        if (next === null) {
          setCurrent(null);
          setDraft(null);
          setExhausted(true);
          return;
        }
        const detail = await api.receipt(next.id);
        setCurrent(detail);
        setDraft(draftFromPending(detail));
        editsRef.current = [];
        clientAppliedRef.current = new Set();
        reviewedRef.current = new Set();
        logEvent({ action: "confirm_opened", receiptId: detail.id });
      } catch (caught) {
        // The receipt on screen, if any, is one this queue has finished with
        // - confirmed, saved or skipped - so it is not left there live to be
        // confirmed a second time. The empty state below offers a retry.
        setCurrent(null);
        setDraft(null);
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [api],
  );

  useEffect(() => {
    run(() => loadNext([]));
  }, [loadNext, run]);

  async function confirm() {
    if (current === null || draft === null) {
      return;
    }
    setError(null);
    let patch;
    try {
      patch = patchForConfirm(current, draft, reviewedRef.current);
    } catch (caught) {
      if (caught instanceof DraftError) {
        setError(caught.message);
        return;
      }
      throw caught;
    }
    try {
      const confirmed = await api.updateReceipt(current.id, patch);
      options.noteSaved(confirmed);
      logEvent({ action: "confirm_saved", receiptId: current.id });
      logFieldEditTelemetry(current, editsRef.current, clientAppliedRef.current);
      await loadNext(skippedIds);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  /**
   * "Save for later" (2026-09-01): keep what is on screen, stay pending,
   * move on. The PATCH carries no `status`, so the receipt keeps its place
   * in the queue and in the pending count - and carries `reviewedFields`,
   * so the boxes just filled stop being re-suggested next time it opens.
   *
   * It then advances like Skip does, and adds this receipt to `skippedIds`
   * for the same reason Skip does: the receipt is STILL PENDING, so
   * `loadNext` would hand back the very same one and the save would look
   * like it did nothing. Leaving the queue and re-entering it brings the
   * half-finished receipt back, now prefilled with what was typed.
   */
  async function saveForLater() {
    if (current === null || draft === null) {
      return;
    }
    setError(null);
    let patch;
    try {
      patch = patchForSaveForLater(current, draft, reviewedRef.current);
    } catch (caught) {
      if (caught instanceof DraftError) {
        setError(caught.message);
        return;
      }
      throw caught;
    }
    try {
      const saved = await api.updateReceipt(current.id, patch);
      options.noteSaved(saved);
      // The same word iOS's confirm screen uses for its "Later"
      // (ConfirmReceiptView.logDeferralIfConfirming): a pending receipt
      // left unconfirmed on purpose. That this one also saved its fields
      // does not change what was deferred.
      logEvent({ action: "confirm_deferred", receiptId: current.id });
      logFieldEditTelemetry(current, editsRef.current, clientAppliedRef.current);
      const skip = [...skippedIds, current.id];
      setSkippedIds(skip);
      await loadNext(skip);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  async function skip() {
    if (current === null) {
      return;
    }
    const skip = [...skippedIds, current.id];
    setSkippedIds(skip);
    await loadNext(skip);
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
        {error !== null && (
          <button disabled={busy} onClick={() => run(() => loadNext(skippedIds))}>
            Try again
          </button>
        )}
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
            api={api}
            onOpenReceipt={onOpenReceipt}
            disabled={busy}
            onFieldEdited={(field) => editsRef.current.push(field)}
            onFieldReviewed={(field) => reviewedRef.current.add(field)}
            onSuggestionApplied={(field) => clientAppliedRef.current.add(field)}
          />
          {error !== null && <p className="error">{error}</p>}
          <div className="detail-actions">
            <button className="primary" disabled={busy} onClick={() => run(confirm)}>
              Confirm
            </button>
            {/* Between Confirm and Skip in both position and meaning:
                Skip loses what is typed, Save for later keeps it, and
                neither confirms anything. */}
            <button disabled={busy} onClick={() => run(saveForLater)}>
              Save for later
            </button>
            <button disabled={busy} onClick={() => run(skip)}>
              Skip for now
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
