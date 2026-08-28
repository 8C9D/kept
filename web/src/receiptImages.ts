import type { KeptApi } from "./api.js";
import { ApiError } from "./api.js";
import {
  presignAndPut,
  type UploadCandidate,
  type UploadStepOutcome,
} from "./upload.js";

/**
 * Add-a-page and replace-a-page (proposal #6, 2026-08-28, approved -
 * docs/proposals/2026-08-28-ux-enhancements.md): the receipt-detail
 * screen's own writers, pointed at POST /api/receipts/:id/images and
 * PUT /api/receipts/:id/images/:page (server/src/routes/receipts.ts)
 * instead of the create route upload.ts's `uploadOne` posts to.
 *
 * Both share upload.ts's `presignAndPut` for the presign -> PUT step
 * rather than re-implementing it - the same shape the backlog upload
 * already uses (presign, PUT the bytes, THEN tell the API), so this
 * module's one safety property - a failed PUT never reaches either route
 * below - holds by construction instead of by two more copies of the same
 * care.
 */

export type ReceiptImageOutcome =
  | { state: "ok" }
  /**
   * The server's 409 duplicate_image, carrying its OWN message rather than
   * this module inventing wording (spec §8's design principle: the
   * failure names its remedy - the delete-before-recapture ordering spec
   * §5 and Runbook §6 teach is stated, for a human to read, at the exact
   * moment it bites).
   */
  | { state: "duplicate"; detail: string }
  | UploadStepOutcome;

/**
 * POST /api/receipts/:id/images - add a page. The server assigns the page
 * number (current max LIVE page + 1); nothing here guesses one or sends
 * one.
 */
export async function addReceiptPage(
  api: KeptApi,
  receiptId: string,
  file: UploadCandidate,
): Promise<ReceiptImageOutcome> {
  // The whole flow shares one try/catch, same as upload.ts's `uploadOne`:
  // `presignAndPut` itself can throw (a rejected `fetch`, not just a
  // non-ok response), not only return `ok: false`, and that has to land
  // on the same "failed" outcome the API call's own failure does, rather
  // than escaping as an unhandled rejection this screen never explains.
  try {
    const step = await presignAndPut(api, file);
    if (!step.ok) {
      return step.outcome;
    }
    await api.addReceiptImage(receiptId, {
      objectKey: step.objectKey,
      sha256: step.sha256,
    });
    return { state: "ok" };
  } catch (error) {
    return writeFailure(error);
  }
}

/**
 * PUT /api/receipts/:id/images/:page - replace that page's bytes. The
 * server soft-deletes the old row and inserts a new one at the same page
 * (spec §10B retention, same rule as a deleted receipt): the old image is
 * kept, never erased.
 */
export async function replaceReceiptPage(
  api: KeptApi,
  receiptId: string,
  page: number,
  file: UploadCandidate,
): Promise<ReceiptImageOutcome> {
  try {
    const step = await presignAndPut(api, file);
    if (!step.ok) {
      return step.outcome;
    }
    await api.replaceReceiptImage(receiptId, page, {
      objectKey: step.objectKey,
      sha256: step.sha256,
    });
    return { state: "ok" };
  } catch (error) {
    return writeFailure(error);
  }
}

function writeFailure(error: unknown): ReceiptImageOutcome {
  if (error instanceof ApiError && error.code === "duplicate_image") {
    return { state: "duplicate", detail: error.message };
  }
  return {
    state: "failed",
    detail: error instanceof Error ? error.message : String(error),
  };
}

/**
 * Pages in ascending order for rendering. The detail route already orders
 * its `images` array by page (server/src/routes/receipts.ts's
 * `.orderBy(receiptImages.page)`), but sorting again here costs nothing
 * and means the render never silently depends on that staying true - the
 * same defensive posture as the ownership re-checks the server itself
 * repeats on every dereference site rather than trusting an earlier one.
 */
export function sortedByPage<T extends { page: number }>(images: T[]): T[] {
  return [...images].sort((a, b) => a.page - b.page);
}
