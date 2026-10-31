import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { exportJobs } from "../db/schema.js";
import { redactedMessage } from "../observability/errorSummary.js";
import type { ObjectStorage } from "../storage/objectStorage.js";
import { generateExport, type ExportLimits } from "./generateExport.js";

interface RunExportJobDependencies {
  db: Db;
  storage: ObjectStorage;
}

/**
 * Drive one export job through its lifecycle: queued → running →
 * complete | failed. Every outcome, including failure, is written to the
 * job row - the client polling GET /api/export/:id must always learn what
 * happened, never wait forever on a job that died silently.
 *
 * ⚠ Both terminal writes are guarded on `status = 'running'`, like the claim
 * below. `failAbandonedJobs` retires a job past the stale clock on the next
 * export request, and it cannot tell a dead process from a slow one - so a job
 * can still be working when it is written off. Once it has been told "failed,
 * run it again", and a replacement may already be running, it must not flip to
 * complete minutes later, or overwrite the reason the client was shown. Its
 * zip, if it finishes, is an artifact no row names; the 30-day lifecycle on
 * `exports/` takes it, and account deletion lists that prefix.
 *
 * `limits` is for tests. Nothing in the app passes it.
 */
export async function runExportJob(
  deps: RunExportJobDependencies,
  jobId: string,
  limits?: Partial<ExportLimits>,
): Promise<void> {
  // Claim the job: only a queued job may start running. The guard makes a
  // double-invocation a no-op instead of a double generation.
  const claimed = await deps.db
    .update(exportJobs)
    .set({ status: "running" })
    .where(and(eq(exportJobs.id, jobId), eq(exportJobs.status, "queued")))
    .returning();
  const job = claimed[0];
  if (job === undefined) {
    return;
  }

  try {
    const result = await generateExport(
      deps,
      {
        jobId: job.id,
        userId: job.userId,
        period: { start: job.periodStart, end: job.periodEnd },
      },
      limits,
    );
    const completed = await deps.db
      .update(exportJobs)
      .set({
        status: "complete",
        objectKey: result.objectKey,
        completedAt: new Date(),
      })
      .where(and(eq(exportJobs.id, job.id), eq(exportJobs.status, "running")))
      .returning({ id: exportJobs.id });
    if (completed.length === 0) {
      // Not an error to rethrow - there is no one left to tell - but not
      // nothing either: it means a job outlived the stale clock, which is
      // what the size budget exists to prevent.
      console.error(
        `Export job ${job.id} finished after it had been retired as stale; ` +
          `its zip is left to the exports lifecycle rule`,
      );
    }
  } catch (error) {
    // The error is recorded on the job AND rethrown to the caller's
    // handler: recording is for the polling client, rethrowing keeps the
    // failure loud server-side.
    //
    // Redacted, because this column is not internal: GET /api/export/:id
    // returns it and the export screen renders it. A failed query's message
    // carries the statement and its bound parameters, so storing it raw
    // would hand a client the SQL and the row values behind it.
    const message = redactedMessage(error);
    await deps.db
      .update(exportJobs)
      .set({ status: "failed", error: message, completedAt: new Date() })
      .where(and(eq(exportJobs.id, job.id), eq(exportJobs.status, "running")));
    throw error;
  }
}
