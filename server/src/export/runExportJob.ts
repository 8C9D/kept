import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { exportJobs } from "../db/schema.js";
import type { ObjectStorage } from "../storage/objectStorage.js";
import { generateExport } from "./generateExport.js";

interface RunExportJobDependencies {
  db: Db;
  storage: ObjectStorage;
}

/**
 * Drive one export job through its lifecycle: queued → running →
 * complete | failed. Every outcome, including failure, is written to the
 * job row - the client polling GET /api/export/:id must always learn what
 * happened, never wait forever on a job that died silently.
 */
export async function runExportJob(
  deps: RunExportJobDependencies,
  jobId: string,
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
    const result = await generateExport(deps, {
      jobId: job.id,
      userId: job.userId,
      period: { start: job.periodStart, end: job.periodEnd },
    });
    await deps.db
      .update(exportJobs)
      .set({
        status: "complete",
        objectKey: result.objectKey,
        completedAt: new Date(),
      })
      .where(eq(exportJobs.id, job.id));
  } catch (error) {
    // The error is recorded on the job AND rethrown to the caller's
    // handler: recording is for the polling client, rethrowing keeps the
    // failure loud server-side.
    const message = error instanceof Error ? error.message : String(error);
    await deps.db
      .update(exportJobs)
      .set({ status: "failed", error: message, completedAt: new Date() })
      .where(eq(exportJobs.id, job.id));
    throw error;
  }
}
