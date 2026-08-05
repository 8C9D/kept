import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import type { SessionTokens } from "../auth/session.js";
import type { Db } from "../db/client.js";
import { exportJobs, users } from "../db/schema.js";
import { toIsoDate } from "../domain/calendarDate.js";
import { fiscalPeriodEndingIn } from "../domain/fiscalPeriod.js";
import { ApiError, notFoundError } from "../http/errors.js";
import { exportRequestSchema } from "../http/schemas.js";
import {
  parseOrThrow,
  readJsonBody,
  uuidParamOrNotFound,
} from "../http/validate.js";
import { sessionAuth, type AuthedEnv } from "../http/sessionAuth.js";
import { runExportJob } from "../export/runExportJob.js";
import type { ObjectStorage } from "../storage/objectStorage.js";

interface ExportRouteDependencies {
  db: Db;
  sessionTokens: SessionTokens;
  storage: ObjectStorage;
}

/**
 * Export zips are artifacts, not records (spec §10B): the receipts and
 * images are what is retained, a zip is regenerable from them, and the
 * exports/ storage prefix carries a 30-day lifecycle expiry. After that
 * window a completed job reports "expired" - still carrying its period, so
 * the client re-runs it rather than downloading.
 */
const DOWNLOAD_LIFETIME_DAYS = 30;

/**
 * A job that has sat queued this long was lost - the process died between
 * the insert and the claim. Reporting it as "stale" (computed, never
 * stored) tells the client to stop polling and re-run; no sweeper process,
 * no extra state.
 */
const STALE_QUEUED_AFTER_MINUTES = 5;

/**
 * A crash mid-run strands a poller identically, so running jobs go stale
 * too - on a far longer clock, since generation legitimately takes time.
 * Thirty minutes is well above anything the size budget permits.
 */
const STALE_RUNNING_AFTER_MINUTES = 30;

/**
 * What a client sees: the stored lifecycle states plus the two computed
 * ones. "expired" and "stale" both mean "re-run this period", not "wait".
 */
type ReportedStatus =
  | (typeof exportJobs.$inferSelect)["status"]
  | "expired"
  | "stale";

/**
 * POST /api/export - start generating an export; returns the job to poll.
 * GET /api/export - the caller's own jobs, newest first.
 * GET /api/export/:id - job status; carries a presigned download URL while
 * complete and unexpired. All scoped to the session user like everything
 * else.
 */
export function exportRoutes(deps: ExportRouteDependencies): Hono<AuthedEnv> {
  const router = new Hono<AuthedEnv>();
  router.use("*", sessionAuth(deps.sessionTokens, deps.db));

  router.post("/", async (c) => {
    const body = parseOrThrow(exportRequestSchema, await readJsonBody(c));
    const userId = c.get("userId");
    const period = await resolvePeriod(deps.db, userId, body);

    const inserted = await deps.db
      .insert(exportJobs)
      .values({ userId, periodStart: period.start, periodEnd: period.end })
      .returning();
    const job = inserted[0];
    if (job === undefined) {
      throw new Error("Export job insert returned no row");
    }

    // Generation runs after this response; the client polls. runExportJob
    // records success or failure on the job row itself, so this catch only
    // fires if even that recording failed - which must stay loud in the log.
    void runExportJob({ db: deps.db, storage: deps.storage }, job.id).catch(
      (error) => {
        console.error(`Export job ${job.id} failed:`, error);
      },
    );

    return c.json(jobResponse(job, null), 202);
  });

  /** The caller's recent jobs, for the web export screen's history list. */
  router.get("/", async (c) => {
    const rows = await deps.db
      .select()
      .from(exportJobs)
      .where(eq(exportJobs.userId, c.get("userId")))
      .orderBy(desc(exportJobs.createdAt))
      .limit(50);
    const jobs = await Promise.all(
      rows.map(async (job) => jobResponse(job, await downloadUrlFor(job))),
    );
    return c.json({ jobs });
  });

  router.get("/:id", async (c) => {
    const id = uuidParamOrNotFound(c.req.param("id"));
    const rows = await deps.db
      .select()
      .from(exportJobs)
      .where(and(eq(exportJobs.id, id), eq(exportJobs.userId, c.get("userId"))));
    const job = rows[0];
    if (job === undefined) {
      throw notFoundError();
    }
    return c.json(jobResponse(job, await downloadUrlFor(job)));
  });

  return router;

  async function downloadUrlFor(
    job: typeof exportJobs.$inferSelect,
  ): Promise<string | null> {
    if (reportedStatus(job, new Date()) !== "complete" || job.objectKey === null) {
      return null;
    }
    return deps.storage.presignDownload(job.objectKey);
  }
}

/**
 * The status a client should act on. Stored states pass through except
 * where time has changed their meaning: a completed job past the storage
 * lifecycle is "expired"; a queued job nothing ever claimed, or a running
 * job whose process died mid-run, is "stale". Nothing is written back -
 * the row stays the truthful history.
 *
 * Both stale clocks run from createdAt: there is no started_at column, and
 * the claim follows creation within milliseconds, so createdAt is an
 * honest proxy for when running began.
 */
function reportedStatus(
  job: typeof exportJobs.$inferSelect,
  now: Date,
): ReportedStatus {
  if (job.status === "complete" && job.completedAt !== null) {
    const expiresAt =
      job.completedAt.getTime() + DOWNLOAD_LIFETIME_DAYS * 24 * 60 * 60 * 1000;
    if (now.getTime() > expiresAt) {
      return "expired";
    }
  }
  const staleAfterMinutes =
    job.status === "queued"
      ? STALE_QUEUED_AFTER_MINUTES
      : job.status === "running"
        ? STALE_RUNNING_AFTER_MINUTES
        : null;
  if (staleAfterMinutes !== null) {
    const staleAt = job.createdAt.getTime() + staleAfterMinutes * 60 * 1000;
    if (now.getTime() > staleAt) {
      return "stale";
    }
  }
  return job.status;
}

async function resolvePeriod(
  db: Db,
  userId: string,
  body:
    | { fiscalYearEndingIn: number }
    | { periodStart: string; periodEnd: string },
): Promise<{ start: string; end: string }> {
  if ("periodStart" in body) {
    return { start: body.periodStart, end: body.periodEnd };
  }
  // Fiscal period derived from the user's settings at request time
  // (spec §5.1) - never baked into storage.
  const rows = await db
    .select({
      month: users.fiscalYearEndMonth,
      day: users.fiscalYearEndDay,
    })
    .from(users)
    .where(eq(users.id, userId));
  const settings = rows[0];
  if (settings === undefined) {
    throw new ApiError(401, "unauthorized", "Session user no longer exists");
  }
  const period = fiscalPeriodEndingIn(body.fiscalYearEndingIn, {
    month: settings.month,
    day: settings.day,
  });
  return { start: toIsoDate(period.start), end: toIsoDate(period.end) };
}

/**
 * The API shape of a job; the storage key stays internal. The period is
 * always present so an expired or stale job is re-runnable from the
 * response alone.
 */
function jobResponse(
  job: typeof exportJobs.$inferSelect,
  downloadUrl: string | null,
) {
  return {
    id: job.id,
    status: reportedStatus(job, new Date()),
    periodStart: job.periodStart,
    periodEnd: job.periodEnd,
    error: job.error,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    downloadUrl,
  };
}
