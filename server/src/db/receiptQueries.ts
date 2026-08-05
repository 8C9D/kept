import { and, asc, eq, gte, isNull, lte } from "drizzle-orm";
import type { Db } from "./client.js";
import { receipts } from "./schema.js";

/**
 * The two conditions every receipt read shares: scoped to the session user
 * (spec §3 constraint 4) and excluding soft-deleted rows. Defined once so a
 * handler cannot get one right and the other wrong.
 */
export function visibleTo(userId: string) {
  return and(eq(receipts.userId, userId), isNull(receipts.deletedAt));
}

/**
 * The rows an export may contain (spec §5.2a): the user's own, not deleted,
 * status confirmed - nothing pending ever reaches an accountant - and
 * purchased inside the requested period.
 *
 * Wave 2's export generation must build on this function rather than on its
 * own query.
 */
export async function listExportableReceipts(
  db: Db,
  userId: string,
  period: { start: string; end: string }, // ISO dates, inclusive
) {
  return db
    .select()
    .from(receipts)
    .where(
      and(
        visibleTo(userId),
        eq(receipts.status, "confirmed"),
        gte(receipts.purchasedAt, period.start),
        lte(receipts.purchasedAt, period.end),
      ),
    )
    .orderBy(asc(receipts.purchasedAt), asc(receipts.id));
}
