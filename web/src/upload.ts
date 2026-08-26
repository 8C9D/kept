import type { KeptApi } from "./api.js";
import { ApiError } from "./api.js";

/**
 * The backlog upload path (spec §6A): each dropped file becomes its own
 * `pending` receipt through the exact create path the iOS capture uses -
 * presigned PUT straight to storage, then the create naming the object.
 * No camera, no OCR: a web-uploaded receipt carries no suggestions, and
 * the confirm queue is where its fields get typed in while the image sits
 * beside them.
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

export type UploadOutcome =
  | { state: "created"; receiptId: string }
  /**
   * The server's 409 duplicate_image. ⚠ Deliberately NOT "saved" (round 4
   * §2.2's forward constraint): on the iOS outbox a 409 reconciles a create
   * the phone already performed, but here it means the person dropped a
   * file that is already attached to one of their receipts - a user-facing
   * fact to show, not a lost 201 to smooth over.
   */
  | { state: "duplicate" }
  | { state: "unsupported"; detail: string }
  | { state: "failed"; detail: string };

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
 * One file, end to end. The purchase date is the upload day - the same
 * capture-day fallback the iOS confirm screen prefills when OCR finds no
 * date - and it is a suggestion for the confirm queue to correct, never a
 * silently-final value (constraint 2 guards it: the receipt is pending
 * until a person confirms every field).
 */
export async function uploadOne(
  api: KeptApi,
  file: UploadCandidate,
  now: Date,
): Promise<UploadOutcome> {
  const contentType = supportedContentType(file.type);
  if (contentType === null) {
    return {
      state: "unsupported",
      detail: `${file.type === "" ? "unknown type" : file.type} - use JPEG, PNG or PDF`,
    };
  }
  try {
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
        state: "failed",
        detail: `storage answered ${put.status} to the upload`,
      };
    }
    const receipt = await api.createReceipt({
      purchasedAt: isoDateToday(now),
      capturedAt: now.toISOString(),
      image: { objectKey, sha256 },
    });
    return { state: "created", receiptId: receipt.id };
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
