import { useRef, useState } from "react";
import type { KeptApi } from "../api.js";
import { uploadOne, type UploadOutcome } from "../upload.js";

/**
 * Spec §6A consequence 2: the email backlog is a folder of PDFs on a
 * laptop, so the web client takes a multi-file drop and each file becomes
 * its own pending receipt - the same create path as capture, no camera
 * code. Business-or-personal is chosen for the batch BEFORE anything
 * uploads: constraint 3 sets it at capture time, and this drop is the
 * capture. There is deliberately no preselected choice (spec §5.2).
 */

interface QueuedFile {
  name: string;
  outcome: UploadOutcome | "uploading";
}

export function UploadView({
  api,
  onChanged,
}: {
  api: KeptApi;
  onChanged: () => void;
}) {
  const [isBusiness, setIsBusiness] = useState<boolean | null>(null);
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function handleFiles(files: File[]) {
    if (isBusiness === null || files.length === 0 || busy) {
      return;
    }
    setBusy(true);
    const startAt = queue.length;
    setQueue((q) => [
      ...q,
      ...files.map((file) => ({ name: file.name, outcome: "uploading" as const })),
    ]);
    // One at a time, in the order dropped: parallel uploads would race the
    // duplicate-image constraint on identical files within one drop, and a
    // backlog import is not latency-sensitive.
    for (const [index, file] of files.entries()) {
      const outcome = await uploadOne(
        api,
        { name: file.name, type: file.type, bytes: () => file.arrayBuffer() },
        isBusiness,
        new Date(),
      );
      setQueue((q) =>
        q.map((entry, i) => (i === startAt + index ? { ...entry, outcome } : entry)),
      );
      if (outcome.state === "created") {
        onChanged();
      }
    }
    setBusy(false);
  }

  const created = queue.filter((f) => isOutcome(f, "created")).length;

  return (
    <section className="upload-view">
      <h2>Upload the backlog</h2>
      <p className="muted">
        Drop emailed PDFs or photos; each becomes a pending receipt to work
        through in the confirm queue. The purchase date is set to today -
        correct it when you confirm.
      </p>

      <fieldset className="business-choice">
        <legend>These receipts are</legend>
        {/* Required, unchosen by default: the drop is disabled until one is
            picked, because business-vs-personal is set at capture time
            (constraint 3) and defaults are forbidden (spec §5.2). */}
        <label>
          <input
            type="radio"
            name="batch-business"
            checked={isBusiness === true}
            onChange={() => setIsBusiness(true)}
          />
          Business
        </label>
        <label>
          <input
            type="radio"
            name="batch-business"
            checked={isBusiness === false}
            onChange={() => setIsBusiness(false)}
          />
          Personal
        </label>
      </fieldset>

      <div
        className={`dropzone ${dragging ? "dragging" : ""} ${isBusiness === null ? "disabled" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          void handleFiles([...e.dataTransfer.files]);
        }}
      >
        {isBusiness === null ? (
          <p>Choose business or personal first.</p>
        ) : (
          <p>
            Drop JPEG, PNG or PDF files here, or{" "}
            <button
              className="link"
              onClick={() => fileInput.current?.click()}
              disabled={busy}
            >
              choose files
            </button>
            .
          </p>
        )}
        <input
          ref={fileInput}
          type="file"
          multiple
          accept="image/jpeg,image/png,application/pdf"
          hidden
          onChange={(e) => {
            void handleFiles([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
      </div>

      {queue.length > 0 && (
        <>
          <p>
            {created} of {queue.length} became receipts.
          </p>
          <ul className="upload-queue">
            {queue.map((file, index) => (
              <li key={index} className={outcomeClass(file)}>
                <span className="filename">{file.name}</span>
                <span>{outcomeText(file)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function isOutcome(file: QueuedFile, state: string): boolean {
  return file.outcome !== "uploading" && file.outcome.state === state;
}

function outcomeClass(file: QueuedFile): string {
  if (file.outcome === "uploading") {
    return "uploading";
  }
  return file.outcome.state;
}

function outcomeText(file: QueuedFile): string {
  const outcome = file.outcome;
  if (outcome === "uploading") {
    return "uploading…";
  }
  switch (outcome.state) {
    case "created":
      return "pending receipt created";
    case "duplicate":
      // Round 4 §2.2's forward constraint: a duplicate here is a fact to
      // show the person, never counted as saved.
      return "already uploaded - an identical file is attached to one of your receipts";
    case "unsupported":
      return outcome.detail;
    case "failed":
      return `failed: ${outcome.detail}`;
  }
}
