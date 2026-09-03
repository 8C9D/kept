import { Hono } from "hono";
import { eq } from "drizzle-orm";
import type { AppleTokenRevoker } from "../auth/appleTokenRevoker.js";
import type { SessionTokens } from "../auth/session.js";
import type { Db } from "../db/client.js";
import {
  exportJobs,
  receiptFieldOptions,
  receiptImages,
  receipts,
  userEvents,
  users,
} from "../db/schema.js";
import { ApiError } from "../http/errors.js";
import { deleteMeSchema, updateMeSchema } from "../http/schemas.js";
import {
  parseOrThrow,
  readJsonBody,
  readOptionalJsonBody,
} from "../http/validate.js";
import { sessionAuth, type AuthedEnv } from "../http/sessionAuth.js";
import { isValidFiscalYearEnd } from "../domain/fiscalPeriod.js";
import { errorSummary } from "../observability/errorSummary.js";
import {
  isIssuedExportKey,
  isIssuedObjectKey,
} from "../storage/objectKeys.js";
import type { ObjectStorage } from "../storage/objectStorage.js";

interface MeRouteDependencies {
  db: Db;
  sessionTokens: SessionTokens;
  storage: ObjectStorage;
  /**
   * Absent when the Sign in with Apple portal key is not configured (local
   * development, and any deployment before APPLE_TEAM_ID /
   * APPLE_SIGN_IN_KEY_ID / APPLE_SIGN_IN_PRIVATE_KEY are set). Deletion
   * still happens - Apple's own guidance is that the request is fulfilled
   * either way - and the gap is stated in the log rather than passed over.
   */
  appleTokenRevoker?: AppleTokenRevoker;
}

/** GET/PATCH/DELETE /api/me - own profile, fiscal year settings, and the
 * one act that destroys the account (spec §6). */
export function meRoutes(deps: MeRouteDependencies): Hono<AuthedEnv> {
  const router = new Hono<AuthedEnv>();
  router.use("*", sessionAuth(deps.sessionTokens, deps.db));

  router.get("/", async (c) => {
    const user = await loadUser(deps.db, c.get("userId"));
    return c.json(profileOf(user));
  });

  router.patch("/", async (c) => {
    const body = parseOrThrow(updateMeSchema, await readJsonBody(c));
    const user = await loadUser(deps.db, c.get("userId"));

    // Month and day may be updated independently, but the resulting pair -
    // merged with what is stored - must name a real day of a real month
    // (Feb 29 allowed; see domain). Two racing partial updates could in
    // principle each validate against stale halves; with this user count
    // that risk is accepted rather than locked against.
    const fiscalYearEnd = {
      month: body.fiscalYearEndMonth ?? user.fiscalYearEndMonth,
      day: body.fiscalYearEndDay ?? user.fiscalYearEndDay,
    };
    if (!isValidFiscalYearEnd(fiscalYearEnd)) {
      throw new ApiError(
        400,
        "invalid_request",
        `fiscal year end month ${fiscalYearEnd.month} has no day ${fiscalYearEnd.day}`,
      );
    }

    // Write only what the client asked to change.
    const changes: Partial<typeof users.$inferInsert> = {};
    if (body.fiscalYearEndMonth !== undefined)
      changes.fiscalYearEndMonth = body.fiscalYearEndMonth;
    if (body.fiscalYearEndDay !== undefined)
      changes.fiscalYearEndDay = body.fiscalYearEndDay;
    if (body.displayName !== undefined) changes.displayName = body.displayName;

    const updated = await deps.db
      .update(users)
      .set(changes)
      .where(eq(users.id, user.id))
      .returning();
    const updatedUser = updated[0];
    if (updatedUser === undefined) {
      // Same impossible-in-practice state loadUser guards: the user row
      // vanished between read and write.
      throw new ApiError(401, "unauthorized", "Session user no longer exists");
    }
    return c.json(profileOf(updatedUser));
  });

  /**
   * DELETE /api/me - destroy this account and everything in it.
   *
   * ⚠ This is a HARD delete, and it is the only one in the system. Every
   * other delete is soft, because §10B's retention rule protects the person
   * from losing a tax record by accident: `DELETE /api/receipts/:id`
   * tombstones a row and keeps the bytes. That rule is about accidents, and
   * this is not one - it is the record's own owner deliberately destroying
   * their whole account, twice-confirmed in the client, which App Store
   * Guideline 5.1.1(v) requires be possible from inside the app and which
   * Apple's own guidance says must delete "the entire account record, along
   * with associated personal data" rather than deactivate it. A tombstoned
   * account would not satisfy that and would not be honest to the person
   * who asked. The client's dialog names the consequence, and Export is the
   * way to keep a copy first.
   *
   * What this deliberately does NOT claim: that every copy is gone. The
   * nightly off-site `pg_dump` (Runbook §4) holds prior snapshots that age
   * out on their own schedule, and that is retention working as designed.
   *
   * Order, and the reasoning for it:
   *
   *   1. Revoke the Apple tokens, if the client handed over a code and a
   *      revoker is configured. FIRST, because it is the only step that can
   *      still be retried afterwards if the rest fails: revocation removes
   *      the app's authorization, and a person who signs in again simply
   *      re-authorizes. Failure here is LOUD but not fatal - Apple's own
   *      guidance is that the deletion is fulfilled regardless, and refusing
   *      to delete an account because appleid.apple.com is slow would deny
   *      the person the very thing the guideline grants them.
   *   2. Delete every row, in one transaction, children first. Either the
   *      account is gone or nothing moved; there is no half-deleted account.
   *      `user_events` (added 2026-08-28) is a child of `users` on exactly
   *      this same term even though it has no foreign key to `receipts` -
   *      it is deleted here, before `users`, because leaving a behavioural
   *      log behind would be a straightforward broken promise to the person
   *      who asked to be deleted, and the kind of thing App Store review
   *      tests.
   *   3. Delete the objects, after the commit and best-effort. Storage has
   *      no transaction to join, so one of the two orders has to lose. This
   *      way the worst outcome is unreferenced bytes whose keys begin with a
   *      user id no session can ever present again; the other way round, a
   *      failed commit would leave live rows pointing at images that are
   *      gone - a person still signed in, looking at receipts whose photos
   *      have vanished. Orphans are counted and logged, never silent.
   */
  router.delete("/", async (c) => {
    const body = parseOrThrow(deleteMeSchema, await readOptionalJsonBody(c));
    const userId = c.get("userId");
    // Proves the account exists before anything is destroyed, and answers
    // 401 rather than 204 for a session naming a user who is already gone.
    await loadUser(deps.db, userId);

    // Attempted now, reported after the commit: this line would otherwise
    // log "account deleted without revoking" moments before a transaction
    // that could still roll back, which is a sentence that has to be true.
    const notRevoked = await revokeAppleTokens(
      deps,
      body.appleAuthorizationCode,
    );

    const objectKeys = await deps.db.transaction(async (tx) => {
      // Read the keys inside the transaction that deletes the rows: they are
      // the only record of what is in storage, and once the rows are gone
      // nothing can name those objects again.
      //
      // Every row of this user's, tombstoned or not: `deleted_at` marks a
      // receipt the person removed under the retention rule, and retention
      // is exactly what this request revokes.
      const imageRows = await tx
        .select({ objectKey: receiptImages.objectKey })
        .from(receiptImages)
        .where(eq(receiptImages.userId, userId));
      const exportRows = await tx
        .select({ id: exportJobs.id, objectKey: exportJobs.objectKey })
        .from(exportJobs)
        .where(eq(exportJobs.userId, userId));

      // Children first; the foreign keys are not ON DELETE CASCADE, so the
      // order is stated here rather than left to the database - the same
      // reason the test harness's reset does it by hand.
      await tx.delete(receiptImages).where(eq(receiptImages.userId, userId));
      await tx.delete(receipts).where(eq(receipts.userId, userId));
      // The person's remembered vendors, categories and payment methods
      // (2026-09-01). Nothing in object storage and no reference to a
      // receipt - just their own vocabulary, which is theirs and goes with
      // the account.
      await tx
        .delete(receiptFieldOptions)
        .where(eq(receiptFieldOptions.userId, userId));
      await tx.delete(exportJobs).where(eq(exportJobs.userId, userId));
      // No object storage to clean up for these rows - user_events never
      // references anything outside the database (schema.ts: receipt_id is
      // a weak reference the log itself never resolves).
      await tx.delete(userEvents).where(eq(userEvents.userId, userId));
      const deletedUsers = await tx
        .delete(users)
        .where(eq(users.id, userId))
        .returning({ id: users.id });
      if (deletedUsers.length !== 1) {
        // The row was there moments ago and this transaction owns it; its
        // absence means something is genuinely broken, and rolling back is
        // the right answer - a deletion that removed the receipts and left
        // the account is the one outcome worse than a failed deletion.
        throw new Error(
          `Account deletion removed ${deletedUsers.length} user rows, expected 1`,
        );
      }

      // Validated on the way OUT of the database, for the same reason the
      // receipt detail route re-checks before presigning: write-time
      // validation says we issued every key we accepted, not that we issued
      // every key the row holds now. A key we did not issue may name another
      // user's object, and deleting it would be worse than leaving it - so
      // it is skipped and reported, never obeyed.
      const keys: string[] = [];
      let refused = 0;
      for (const row of imageRows) {
        if (isIssuedObjectKey(row.objectKey, userId)) {
          keys.push(row.objectKey);
        } else {
          refused += 1;
        }
      }
      for (const row of exportRows) {
        // A queued, running or failed job has no zip yet; there is nothing
        // to refuse and nothing to delete.
        if (row.objectKey === null) {
          continue;
        }
        if (isIssuedExportKey(row.objectKey, userId, row.id)) {
          keys.push(row.objectKey);
        } else {
          refused += 1;
        }
      }
      return { keys, refused };
    });

    if (objectKeys.refused > 0) {
      // The keys themselves are deliberately absent: one that names another
      // user's prefix IS their user id, and this line is about to be logged
      // (same reasoning as assertIssuedObjectKey).
      console.error(
        `Account deletion left ${objectKeys.refused} object(s) in place: ` +
          `their stored keys do not match the shape issued for their owner, ` +
          `so deleting them could have destroyed another account's data.`,
      );
    }
    await deleteObjects(deps.storage, objectKeys.keys);

    if (notRevoked !== null) {
      // The account really is gone by now, which is what makes this
      // sentence sayable.
      console.error(
        `Account deleted without revoking Apple tokens: ${notRevoked}`,
      );
    }

    // 204, like DELETE /api/receipts/:id: there is nothing left to describe.
    // The session token the caller holds is now dead by construction -
    // sessionAuth 401s on a token naming a user row that is not there - so
    // no token_version bump is needed and none happens.
    return c.body(null, 204);
  });

  return router;
}

/**
 * Revoke the person's Sign in with Apple tokens. Returns null when that
 * happened, and otherwise a sentence saying exactly why it did not - which
 * the caller logs once the deletion has actually committed.
 *
 * Never throws: every branch here ends with the deletion continuing, which
 * is Apple's own guidance for the case where no revocable credential is in
 * hand ("you must still fulfill the user's account deletion request").
 *
 * The failure that matters is the silent one. An app that offers Sign in
 * with Apple and quietly stops revoking is indistinguishable, from inside,
 * from one that never did - so each of the three ways this can not-happen
 * gets its own sentence rather than a shared shrug.
 */
async function revokeAppleTokens(
  deps: MeRouteDependencies,
  authorizationCode: string | undefined,
): Promise<string | null> {
  if (deps.appleTokenRevoker === undefined) {
    return (
      "no Sign in with Apple key is configured (APPLE_TEAM_ID, " +
      "APPLE_SIGN_IN_KEY_ID, APPLE_SIGN_IN_PRIVATE_KEY). The account is " +
      "gone; the person's Apple ID still lists this app until they remove " +
      "it themselves."
    );
  }
  if (authorizationCode === undefined) {
    return (
      "the client sent no appleAuthorizationCode. Expected from the web " +
      "client, which runs no native re-authorization; from the iOS client " +
      "it means the re-authorization did not complete."
    );
  }
  try {
    await deps.appleTokenRevoker.revoke(authorizationCode);
    return null;
  } catch (error) {
    // errorSummary rather than the error: a rejected exchange carries the
    // request context, and the authorization code is in it.
    return `Apple refused or could not be reached - ${errorSummary(error)}`;
  }
}

/**
 * How many object deletions are in flight at once. A year of a small
 * business's receipts is hundreds of objects, so one at a time would hold the request
 * open for minutes; all at once would open hundreds of sockets to R2 in a
 * process provisioned at 2 GB. Sixteen is a judgement between the two,
 * written down as one.
 */
const OBJECT_DELETE_CONCURRENCY = 16;

/**
 * Erase the account's objects, best-effort. Failures are counted and logged
 * rather than thrown: the rows are already gone, so there is nothing left to
 * roll back and nothing the person could do with a 500 except believe their
 * account still exists.
 *
 * The count is what the log carries, not the keys - a receipt image key
 * begins with the user id, and the point of the deletion was to stop that
 * being written down anywhere.
 */
async function deleteObjects(
  storage: ObjectStorage,
  objectKeys: readonly string[],
): Promise<void> {
  let failed = 0;
  let firstFailure: unknown;
  for (let i = 0; i < objectKeys.length; i += OBJECT_DELETE_CONCURRENCY) {
    const batch = objectKeys.slice(i, i + OBJECT_DELETE_CONCURRENCY);
    const outcomes = await Promise.allSettled(
      batch.map((key) => storage.delete(key)),
    );
    for (const outcome of outcomes) {
      if (outcome.status === "rejected") {
        failed += 1;
        firstFailure ??= outcome.reason;
      }
    }
  }
  if (failed > 0) {
    console.error(
      `Account deletion left ${failed} of ${objectKeys.length} object(s) in ` +
        `storage; the rows naming them are already gone, so these are ` +
        `unreferenced bytes under a user id no session can present again. ` +
        `First failure:`,
      errorSummary(firstFailure),
    );
  }
}

async function loadUser(db: Db, userId: string) {
  const rows = await db.select().from(users).where(eq(users.id, userId));
  const user = rows[0];
  if (user === undefined) {
    // A valid session naming a nonexistent user should be impossible;
    // treat it as an invalid session rather than a 404 on oneself.
    throw new ApiError(401, "unauthorized", "Session user no longer exists");
  }
  return user;
}

/** The API shape of a profile; apple_sub stays internal. */
function profileOf(user: typeof users.$inferSelect) {
  return {
    id: user.id,
    displayName: user.displayName,
    email: user.email,
    fiscalYearEndMonth: user.fiscalYearEndMonth,
    fiscalYearEndDay: user.fiscalYearEndDay,
  };
}
