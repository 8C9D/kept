import type { KeptApi } from "./api.js";
import { ApiError } from "./api.js";
import type { PdfExtractedText } from "./pdfText.js";

/**
 * The backlog upload path (spec §6A): each dropped file becomes its own
 * `pending` receipt through the exact create path the iOS capture uses -
 * presigned PUT straight to storage, then the create naming the object.
 * No camera, and no OCR of a photograph: an image dropped here still
 * carries no suggestions, and the confirm queue is where its fields get
 * typed in while the picture sits beside them.
 *
 * PDFs stopped being that case on 2026-09-01. An emailed receipt usually
 * carries a real text layer - exact, noise-free, and sitting right there in
 * the file - so a dropped PDF now has that text extracted in the browser
 * BEFORE the receipt is created, and travels as `ocrRawText` with
 * `ocrSource: 'pdf-text'`. The server's LLM sweep parses it within seconds
 * and the confirm queue shows suggestions instead of ten empty boxes.
 * Nothing about constraint 2 changes: they are suggestions in an editable
 * form, and the receipt is still pending until a person confirms it.
 */

export type UploadContentType = "image/jpeg" | "image/png" | "application/pdf";

const CONTENT_TYPES: Record<string, UploadContentType> = {
  "image/jpeg": "image/jpeg",
  "image/png": "image/png",
  "application/pdf": "application/pdf",
};

/**
 * What the browser knows about a file, separated from File so the state
 * machine below is testable without DOM objects.
 */
export interface UploadCandidate {
  name: string;
  type: string;
  bytes: () => Promise<ArrayBuffer>;
}

/**
 * The two ways the presign-then-PUT step itself can come up short, before
 * either this file's `createReceipt` or receiptImages.ts's add/replace
 * routes are ever called. Factored out as its own type (not just inlined
 * into UploadOutcome) so receiptImages.ts's own outcome type can share it
 * exactly rather than redeclaring the same two shapes.
 */
export type UploadStepOutcome =
  | { state: "unsupported"; detail: string }
  | { state: "failed"; detail: string };

/**
 * What became of a dropped PDF's text layer (2026-09-01). Carried on the
 * `created` outcome rather than folded into it, because all three of these
 * are successful uploads: the receipt exists either way, and the only
 * difference is whether the confirm queue will have suggestions waiting.
 *
 * `unreadable` is deliberately not a failure of the upload. The bytes are
 * already in storage and the receipt is worth having; what is lost is the
 * head start, and the person is told so in those words rather than being
 * shown a "failed" file that in fact uploaded. It is also deliberately not
 * silent - swallowing the reason pdf.js gave would leave "no suggestions
 * appeared" indistinguishable from "this PDF is a scan".
 */
export type PdfTextOutcome =
  | { state: "extracted"; lines: number; truncated: boolean }
  | { state: "no-text-layer" }
  | { state: "unreadable"; detail: string };

/** Bytes -> the PDF's text layer. Injected so `uploadOne` is testable
 * without pdf.js and without a real PDF; the default loads pdf.js lazily. */
export type PdfTextExtractor = (bytes: ArrayBuffer) => Promise<PdfExtractedText>;

export type UploadOutcome =
  | {
      state: "created";
      receiptId: string;
      /** Null for an image - there is no text layer to have an outcome. */
      pdfText: PdfTextOutcome | null;
    }
  /**
   * The server's 409 duplicate_image. ⚠ Deliberately NOT "saved" (round 4
   * §2.2's forward constraint): on the iOS outbox a 409 reconciles a create
   * the phone already performed, but here it means the person dropped a
   * file that is already attached to one of their receipts - a user-facing
   * fact to show, not a lost 201 to smooth over.
   */
  | { state: "duplicate" }
  | UploadStepOutcome;

/** Today's date where the API expects yyyy-mm-dd, in local time. */
export function isoDateToday(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

export function supportedContentType(
  mimeType: string,
): UploadContentType | null {
  return CONTENT_TYPES[mimeType] ?? null;
}

/** Lowercase hex sha-256, the digest shape the create route requires. */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The presign -> PUT step shared by every writer that attaches bytes to a
 * receipt: this file's `uploadOne` (create) and receiptImages.ts's
 * add-a-page / replace-a-page (proposal #6, 2026-08-28). Pulled out on its
 * own so "only tell the API about bytes that actually landed" is true by
 * construction in one place rather than three - a failed PUT here returns
 * `ok: false` before any caller ever reaches its own API call, which is
 * exactly what stops a failed storage PUT from producing a receipt (or a
 * page) that points at bytes which are not there, the documented sharp
 * edge (spec §8) this whole feature exists to repair.
 */
export async function presignAndPut(
  api: KeptApi,
  file: UploadCandidate,
): Promise<
  | { ok: true; objectKey: string; sha256: string }
  | { ok: false; outcome: UploadStepOutcome }
> {
  const contentType = supportedContentType(file.type);
  if (contentType === null) {
    return {
      ok: false,
      outcome: {
        state: "unsupported",
        detail: `${file.type === "" ? "unknown type" : file.type} - use JPEG, PNG or PDF`,
      },
    };
  }
  const bytes = await file.bytes();
  const sha256 = await sha256Hex(bytes);
  const { objectKey, uploadUrl } = await api.uploadUrl(contentType);
  const put = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: bytes,
  });
  if (!put.ok) {
    return {
      ok: false,
      outcome: {
        state: "failed",
        detail: `storage answered ${put.status} to the upload`,
      },
    };
  }
  return { ok: true, objectKey, sha256 };
}

/**
 * pdf.js, loaded only when a PDF is actually dropped. A dynamic import, so
 * Vite emits it as its own chunk and an image-only upload never fetches
 * it - the whole library is larger than the rest of this client put
 * together. `pdfTextLayer.ts`'s own doc comment carries the rest.
 */
async function extractPdfTextLazily(
  bytes: ArrayBuffer,
): Promise<PdfExtractedText> {
  const { extractPdfText } = await import("./pdfTextLayer.js");
  return extractPdfText(bytes);
}

interface PdfTextAttempt {
  outcome: PdfTextOutcome;
  /** The text to send, or null when there is nothing worth sending. */
  text: string | null;
}

/**
 * The PDF's text layer, or an honest account of why there is none. Never
 * throws: an unreadable PDF still uploaded fine, and the create below has
 * to go ahead without the head start rather than losing the receipt (see
 * `PdfTextOutcome`).
 */
async function readPdfText(
  file: UploadCandidate,
  extract: PdfTextExtractor,
): Promise<PdfTextAttempt> {
  let extracted: PdfExtractedText;
  try {
    // A second read of the file rather than a shared buffer with
    // `presignAndPut` above: `File.arrayBuffer()` hands back a fresh copy
    // each call, and pdf.js DETACHES the buffer it is given (see
    // `extractPdfText`). Sharing one would trade a re-read of a
    // few hundred kilobytes for a zero-byte upload.
    extracted = await extract(await file.bytes());
  } catch (error) {
    return {
      outcome: {
        state: "unreadable",
        detail: error instanceof Error ? error.message : String(error),
      },
      text: null,
    };
  }
  if (extracted.lines === 0) {
    // A scanned receipt emailed as a PDF: real bytes, no text layer. This
    // client deliberately runs no OCR of its own (that is the iOS
    // client's Vision pass), so there is nothing to send.
    return { outcome: { state: "no-text-layer" }, text: null };
  }
  return {
    outcome: {
      state: "extracted",
      lines: extracted.lines,
      truncated: extracted.truncated,
    },
    text: extracted.text,
  };
}

/**
 * One file, end to end. The purchase date is the upload day - the same
 * capture-day fallback the iOS confirm screen prefills when OCR finds no
 * date - and it is a suggestion for the confirm queue to correct, never a
 * silently-final value (constraint 2 guards it: the receipt is pending
 * until a person confirms every field).
 *
 * Order matters: the bytes are PUT to storage FIRST, and only then is the
 * text read. A failed PUT short-circuits before pdf.js is ever loaded, and
 * "only tell the API about bytes that actually landed" (`presignAndPut`)
 * stays the first thing this function establishes.
 */
export async function uploadOne(
  api: KeptApi,
  file: UploadCandidate,
  now: Date,
  extractPdfText: PdfTextExtractor = extractPdfTextLazily,
): Promise<UploadOutcome> {
  try {
    const contentType = supportedContentType(file.type);
    const step = await presignAndPut(api, file);
    if (!step.ok) {
      return step.outcome;
    }
    const pdf =
      contentType === "application/pdf"
        ? await readPdfText(file, extractPdfText)
        : null;
    const receipt = await api.createReceipt({
      purchasedAt: isoDateToday(now),
      capturedAt: now.toISOString(),
      image: { objectKey: step.objectKey, sha256: step.sha256 },
      // The two travel together or not at all: `ocrSource` without text
      // would claim a parse that never happened, and text without a source
      // would leave the server guessing which extractor to trust it as.
      ...(pdf?.text !== null &&
        pdf?.text !== undefined && {
          ocrRawText: pdf.text,
          ocrSource: "pdf-text" as const,
        }),
    });
    return {
      state: "created",
      receiptId: receipt.id,
      pdfText: pdf?.outcome ?? null,
    };
  } catch (error) {
    if (error instanceof ApiError && error.code === "duplicate_image") {
      return { state: "duplicate" };
    }
    return {
      state: "failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
