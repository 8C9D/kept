import { useRef, useState } from "react";
import type { KeptApi } from "../api.js";
import { uploadOne, type UploadOutcome } from "../upload.js";

/**
 * Spec §6A consequence 2: the email backlog is a folder of PDFs on a
 * laptop, so the web client takes a multi-file drop and each file becomes
 * its own pending receipt - the same create path as capture, no camera
 * code. Nothing is asked before the drop: the receipts land pending and
 * every field is confirmed in the confirm queue, with the image beside it.
 *
 * 2026-09-01: a dropped PDF now has its text layer read in the browser
 * first, so the receipts it creates arrive with suggestions rather than ten
 * empty boxes (upload.ts). That is why the outcome line below says what
 * happened to the text as well as to the receipt - "created" alone would
 * leave "the parsers had nothing to work with" indistinguishable from
 * "they did", which is the difference between a confirm that takes five
 * seconds and one that takes a minute.
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
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function handleFiles(files: File[]) {
    if (files.length === 0 || busy) {
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
        through in the confirm queue. A PDF with a text layer is read here
        in the browser, so its vendor, date and amounts are usually
        suggested for you by the time you get to it - they are still
        suggestions, and nothing is saved until you confirm. The purchase
        date is set to today - correct it when you confirm.
      </p>

      <div
        className={`dropzone ${dragging ? "dragging" : ""}`}
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
      return `pending receipt created${pdfTextText(outcome.pdfText)}`;
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

/**
 * The PDF half of a created file's outcome (2026-09-01). Every branch here
 * describes a receipt that EXISTS - the difference is only what the confirm
 * queue will have to work with - so none of them reads as a failure, and
 * the two that leave the fields empty say so in the words a person can act
 * on: type them.
 */
function pdfTextText(pdfText: Extract<UploadOutcome, { state: "created" }>["pdfText"]): string {
  if (pdfText === null) {
    // An image: this client runs no OCR of its own, so there was never
    // text to have an outcome about.
    return "";
  }
  switch (pdfText.state) {
    case "extracted":
      return ` - text extracted, ${pdfText.lines} ${
        pdfText.lines === 1 ? "line" : "lines"
      }${pdfText.truncated ? " (truncated at the size limit)" : ""}`;
    case "no-text-layer":
      return " - no text layer, type the fields";
    case "unreadable":
      return ` - couldn't read the PDF text (${pdfText.detail}), type the fields`;
  }
}
