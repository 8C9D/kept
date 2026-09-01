import { useEffect, useRef, useState } from "react";
import type { KeptApi } from "../api.js";
import { logEvent } from "../events.js";
import type { ReceiptOptionsHandle } from "../options.js";
import {
  addReceiptPage,
  replaceReceiptPage,
  sortedByPage,
  type ReceiptImageOutcome,
} from "../receiptImages.js";
import type {
  ReceiptDetail,
  ReceiptImage as ReceiptImageT,
} from "../types.js";
import type { UploadCandidate } from "../upload.js";
import {
  DraftError,
  ReceiptFieldsForm,
  draftForDisplay,
  draftFromReceipt,
  logFieldEditTelemetry,
  patchChangesNothing,
  patchForSaveForLater,
  patchFromDraft,
  type ReceiptDraft,
  type SuggestibleField,
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
  onOpenReceipt,
}: {
  api: KeptApi;
  receiptId: string;
  options: ReceiptOptionsHandle;
  onBack: () => void;
  onChanged: () => void;
  /** Proposal #8: "open the matching receipt" - switches this same screen
   * to a different receipt's id, App.tsx owns the view state this drives. */
  onOpenReceipt: (id: string) => void;
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
  // Every field `ReceiptFieldsForm.onSuggestionApplied` has reported since
  // this receipt loaded - a derived-amount fill or a vendor default that
  // landed on this draft. Handed to `logFieldEditTelemetry` alongside
  // `editsRef` at save, so those two client-sourced suggestion sources get
  // scored accepted/overridden by the same save-time mechanism the
  // server's own OCR suggestions use (2026-08-28 ruling - see
  // ReceiptForm.tsx's `summarizeFieldEdits`).
  const clientAppliedRef = useRef<Set<SuggestibleField>>(new Set());
  // Which fields this session has REVIEWED - typed in, or chosen from an
  // amount chip (2026-09-01, ReceiptForm's `onFieldReviewed`). Only a
  // PENDING receipt's save carries these: a confirmed receipt is served no
  // suggestions to review away from in the first place.
  const reviewedRef = useRef<Set<keyof ReceiptDraft>>(new Set());
  // Which image write is in flight, if any - "add" for the add-a-page
  // control, or the page number being replaced. Not a plain boolean: the
  // per-page Replace button needs to know whether IT is the one running,
  // and every control is disabled while anything is in flight (spec §5's
  // page-number assignment is server-side and per-receipt, so nothing here
  // needs a race guard beyond "don't let this client fire two writes at
  // once").
  const [imageBusy, setImageBusy] = useState<"add" | number | null>(null);
  // Separate from the fields form's own error/notice above: an image
  // write and a field save are independent actions on this screen, and
  // conflating their messages would show a save error next to the image
  // controls or vice versa.
  const [imageError, setImageError] = useState<string | null>(null);
  const [imageNotice, setImageNotice] = useState<string | null>(null);
  const [addPageDragging, setAddPageDragging] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const loaded = await api.receipt(receiptId);
        if (!cancelled) {
          setReceipt(loaded);
          setDraft(draftForDisplay(loaded));
          editsRef.current = [];
          clientAppliedRef.current = new Set();
          reviewedRef.current = new Set();
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

  /**
   * One PATCH of what changed.
   *
   * On a PENDING receipt this is the "save for later" write (2026-09-01):
   * no `status`, so the receipt stays pending and keeps its place in the
   * queue, plus the `reviewedFields` this session established. That is what
   * the button says in that case, because a screen whose Save leaves a
   * receipt pending should not call itself Save and let the person assume
   * otherwise - this screen has never had a Confirm, and the queue is still
   * where a receipt gets confirmed.
   *
   * On a CONFIRMED receipt it is an ordinary edit, exactly as before: the
   * reviewed set is not sent, because nothing is served suggestions to
   * review away from once a receipt is confirmed.
   */
  async function save() {
    if (receipt === null || draft === null) {
      return;
    }
    const pending = receipt.status === "pending";
    setError(null);
    setNotice(null);
    let patch;
    try {
      patch = pending
        ? patchForSaveForLater(receipt, draft, reviewedRef.current)
        : patchFromDraft(receipt, draft);
    } catch (caught) {
      if (caught instanceof DraftError) {
        setError(caught.message);
        return;
      }
      throw caught;
    }
    // `patchChangesNothing` rather than an empty-key test: a save-for-later
    // always carries a `reviewedFields` key, and re-sending the set the
    // receipt already has is the case that genuinely changes nothing.
    if (patchChangesNothing(receipt, patch)) {
      setNotice("Nothing changed.");
      return;
    }
    try {
      const updated = await api.updateReceipt(receipt.id, patch);
      setReceipt({ ...receipt, ...updated });
      setDraft(draftFromReceipt({ ...receipt, ...updated }));
      setNotice(pending ? "Saved. Still pending - confirm it in the queue." : "Saved.");
      options.noteSaved(updated);
      onChanged();
      // The same distinction iOS's confirm screen draws
      // (`logDeferralIfConfirming`): a pending receipt left unconfirmed on
      // purpose is a deferral, an already-confirmed one being corrected is
      // an edit.
      logEvent({
        action: pending ? "confirm_deferred" : "receipt_edited",
        receiptId: receipt.id,
      });
      logFieldEditTelemetry(receipt, editsRef.current, clientAppliedRef.current);
      // Reset after a successful save only - a failed one leaves the
      // person still mid-edit, and the next successful save should still
      // count everything since the receipt loaded, not just since the
      // failure.
      editsRef.current = [];
      clientAppliedRef.current = new Set();
      reviewedRef.current = new Set();
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

  /**
   * Shared tail for addPage/replacePage below: on success, refresh the
   * whole receipt from the server rather than hand-mutating `images` -
   * the server assigns the page number for an add, and the brief's own
   * warning is exactly this: this client cannot know it in advance, so it
   * must not guess.
   */
  async function finishImageWrite(
    outcome: ReceiptImageOutcome,
    successNotice: string,
  ) {
    if (outcome.state !== "ok") {
      setImageError(outcome.detail);
      setImageBusy(null);
      return;
    }
    try {
      const refreshed = await api.receipt(receiptId);
      setReceipt(refreshed);
      setImageNotice(successNotice);
      logEvent({ action: "receipt_edited", receiptId });
      onChanged();
    } catch (caught) {
      setImageError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setImageBusy(null);
    }
  }

  async function addPage(file: File) {
    if (imageBusy !== null) {
      return;
    }
    setImageError(null);
    setImageNotice(null);
    setImageBusy("add");
    const outcome = await addReceiptPage(api, receiptId, toCandidate(file));
    await finishImageWrite(outcome, "Page added.");
  }

  async function replacePage(page: number, file: File) {
    if (imageBusy !== null) {
      return;
    }
    setImageError(null);
    setImageNotice(null);
    setImageBusy(page);
    const outcome = await replaceReceiptPage(
      api,
      receiptId,
      page,
      toCandidate(file),
    );
    await finishImageWrite(
      outcome,
      // Never claim the old image is erased (spec §10B): it is
      // soft-deleted and retained for the same six years as everything
      // else, exactly like a deleted receipt's - only which bytes serve
      // this page number changed.
      "Page replaced. The old image is kept for retention - not erased.",
    );
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
            // §7A screen 3's whole purpose is checking a number against
            // the paper properly, and a multi-page receipt must not hide
            // half its evidence - every live page renders, in order, each
            // at the same full size a single page always has.
            sortedByPage(receipt.images).map((image) => (
              <DetailPageImage
                key={image.page}
                image={image}
                busy={imageBusy !== null}
                replacing={imageBusy === image.page}
                onReplace={(file) => void replacePage(image.page, file)}
              />
            ))
          )}
          {imageError !== null && <p className="error">{imageError}</p>}
          {imageNotice !== null && <p className="muted">{imageNotice}</p>}
          <div className="add-page">
            <p className="muted image-tools-hint">
              Add a page for a multi-page receipt, or use Replace on a page
              above to fix one whose image never finished uploading -
              replacing keeps this receipt&apos;s vendor, date, total and
              HST; only the picture changes, and the old image is kept for
              retention, not erased.
            </p>
            <div
              className={`dropzone add-page-dropzone ${addPageDragging ? "dragging" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setAddPageDragging(true);
              }}
              onDragLeave={() => setAddPageDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setAddPageDragging(false);
                const file = e.dataTransfer.files[0];
                if (file !== undefined) {
                  void addPage(file);
                }
              }}
            >
              <AddPagePicker busy={imageBusy === "add"} onPick={(file) => void addPage(file)} />
            </div>
          </div>
        </div>
        <div className="detail-fields">
          <ReceiptFieldsForm
            receipt={receipt}
            draft={draft}
            setDraft={(update) => setDraft((d) => (d === null ? d : update(d)))}
            options={options.values}
            api={api}
            onOpenReceipt={onOpenReceipt}
            onFieldEdited={(field) => editsRef.current.push(field)}
            onFieldReviewed={(field) => reviewedRef.current.add(field)}
            onSuggestionApplied={(field) => clientAppliedRef.current.add(field)}
          />
          {error !== null && <p className="error">{error}</p>}
          {notice !== null && <p className="muted">{notice}</p>}
          <div className="detail-actions">
            <button className="primary" onClick={() => void save()}>
              {receipt.status === "pending" ? "Save for later" : "Save"}
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

/**
 * One page: its number, a Replace control, and the image itself
 * (proposal #6). A file picker, not a dropzone - replace is a targeted fix
 * for one specific page rather than a drop target, and this is the honest
 * word for it: it repairs a page whose image never finished uploading
 * without touching this receipt's vendor, date, total or HST, which is
 * what deleting and re-capturing the whole receipt would cost.
 */
function DetailPageImage({
  image,
  busy,
  replacing,
  onReplace,
}: {
  image: ReceiptImageT;
  busy: boolean;
  replacing: boolean;
  onReplace: (file: File) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="detail-page">
      <div className="detail-page-header">
        <span className="detail-page-label">Page {image.page}</span>
        <button
          className="link"
          onClick={() => input.current?.click()}
          disabled={busy}
        >
          {replacing ? "Replacing…" : "Replace…"}
        </button>
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,application/pdf"
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file !== undefined) {
              onReplace(file);
            }
          }}
        />
      </div>
      <ReceiptImage url={image.downloadUrl} />
    </div>
  );
}

/** The add-a-page control's file-picker half; the dropzone that wraps it
 * handles the drag-and-drop half (ReceiptDetailView above). */
function AddPagePicker({
  busy,
  onPick,
}: {
  busy: boolean;
  onPick: (file: File) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <p>
      {busy ? (
        "Uploading…"
      ) : (
        <>
          Drop another page here, or{" "}
          <button className="link" onClick={() => input.current?.click()} disabled={busy}>
            choose a file
          </button>
          .
        </>
      )}
      <input
        ref={input}
        type="file"
        accept="image/jpeg,image/png,application/pdf"
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file !== undefined) {
            onPick(file);
          }
        }}
      />
    </p>
  );
}

/** File -> UploadCandidate, same shape UploadView.tsx hands `uploadOne` -
 * separated from DOM so receiptImages.ts's add/replace functions stay
 * testable without one. */
function toCandidate(file: File): UploadCandidate {
  return { name: file.name, type: file.type, bytes: () => file.arrayBuffer() };
}
