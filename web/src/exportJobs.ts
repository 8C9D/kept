import { ApiError } from "./api.js";
import type { ExportJob, ExportStatus } from "./types.js";

/**
 * The export screen's rules (ExportView.tsx is the markup and the timers
 * over these), kept out of the component for the same reason
 * `manageValues.ts` is.
 */

/**
 * Still being generated, so worth polling. Everything else is terminal -
 * `failed`, `stale` and `expired` all mean "re-run this period", never
 * "wait", and `complete` has nothing further to report. The server computes
 * stale and expired itself, so a job abandoned by a dead process stops being
 * live here without this client having to time anything.
 */
export function isLiveExport(status: ExportStatus): boolean {
  return status === "queued" || status === "running";
}

/**
 * The job to resume watching, if any. The server allows one live export per
 * user (`export_jobs_one_active_per_user_uq`), so there is at most one to
 * find - and it is why a 409 from POST /api/export always means one of these
 * exists, which is the case that used to leave the screen waiting on nothing.
 */
export function liveExportJob(jobs: readonly ExportJob[]): ExportJob | undefined {
  return jobs.find((job) => isLiveExport(job.status));
}

/**
 * Consecutive failures a poll loop will sit through: a minute at the 2s
 * interval, long enough for a deploy or a dropped connection to pass.
 * Bounded so a tab left open against a dead network does not poll forever;
 * stopping is recoverable, since returning to the screen or pressing Export
 * again finds the job and resumes (`liveExportJob`).
 */
export const MAX_POLL_FAILURES = 30;

/**
 * Whether a failed poll ends the loop rather than being waited out. One bad
 * poll used to end it, which left a running export invisible until the
 * screen was reopened.
 *
 * A 4xx is an answer, not a transient: the job is gone or the session is, and
 * asking again every two seconds cannot change that. The two exceptions are
 * the 4xx statuses that mean "ask again later" - a timeout, and Cloudflare's
 * rate limiter in front of this API. Anything else - a network failure, a
 * 5xx, a body that would not parse - is what "transient" means, up to the
 * limit above.
 */
export function pollGivesUp(caught: unknown, consecutiveFailures: number): boolean {
  if (consecutiveFailures >= MAX_POLL_FAILURES) {
    return true;
  }
  return (
    caught instanceof ApiError &&
    caught.status >= 400 &&
    caught.status < 500 &&
    caught.status !== 408 &&
    caught.status !== 429
  );
}

const DOWNLOAD_FRAME_ID = "export-download-frame";

/**
 * Hands a presigned zip URL to the browser without leaving the app.
 *
 * Not `location.assign`, and not a clicked `<a>`, both of which navigate
 * THIS tab: fine for a zip, which the browser turns into a download, but if
 * the response is ever anything else - R2's error XML, most plausibly - the
 * tab is replaced by it and the SPA's state goes with it. A hidden frame
 * takes the same navigation somewhere it can do no harm, and the CSP's
 * `frame-src` already names the R2 endpoint because receipt PDFs render in
 * frames (`public/_headers`).
 *
 * On `document.body` and reused rather than rendered by the export screen:
 * a frame the view owned would unmount with it, and leaving the screen the
 * moment after clicking Download could cancel the transfer that just
 * started. The cost of a frame is that it cannot report how the transfer
 * went - nothing can, from here - which is why the caller's failure path is
 * the fetch for a fresh URL, not this.
 *
 * `doc` is injectable for the same reason `attachLifecycleFlush`'s is.
 */
export function startDownload(url: string, doc: Document = document): void {
  let frame = doc.getElementById(DOWNLOAD_FRAME_ID) as HTMLIFrameElement | null;
  if (frame === null) {
    frame = doc.createElement("iframe");
    frame.id = DOWNLOAD_FRAME_ID;
    frame.hidden = true;
    frame.title = "Export download";
    doc.body.appendChild(frame);
  }
  frame.src = url;
}
