import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
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
 * POST /api/export - start generating an export; returns the job to poll.
 * GET /api/export/:id - job status; carries a presigned download URL once
 * complete. Both scoped to the session user like everything else.
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

    const downloadUrl =
      job.status === "complete" && job.objectKey !== null
        ? await deps.storage.presignDownload(job.objectKey)
        : null;
    return c.json(jobResponse(job, downloadUrl));
  });

  return router;
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

/** The API shape of a job; the storage key stays internal. */
function jobResponse(
  job: typeof exportJobs.$inferSelect,
  downloadUrl: string | null,
) {
  return {
    id: job.id,
    status: job.status,
    periodStart: job.periodStart,
    periodEnd: job.periodEnd,
    error: job.error,
    createdAt: job.createdAt,
    completedAt: job.completedAt,
    downloadUrl,
  };
}
