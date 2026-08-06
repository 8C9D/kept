import { inArray, notLike, like } from "drizzle-orm";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { LOCAL_DEV_DATABASE_URL } from "./client.js";
import { receiptImages, receipts, users } from "./schema.js";

/**
 * `npm run db:claim` - hand every synthetic-seed receipt (and its image
 * rows) to the one real signed-in user, so a device test has data to
 * scroll. Dev-only, like the seed; it refuses to guess when the real user
 * is missing or ambiguous. (Wave-3 gate review: this was a documented SQL
 * snippet run by hand during device verification.)
 */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL ?? LOCAL_DEV_DATABASE_URL,
});
const db = drizzle(pool);

async function claim() {
  const realUsers = await db
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .where(notLike(users.appleSub, "synthetic-%"));
  const realUser = realUsers[0];
  if (realUser === undefined) {
    throw new Error(
      "No real user found - sign in on a device first, then run db:claim",
    );
  }
  if (realUsers.length > 1) {
    throw new Error(
      `Found ${realUsers.length} real users; refusing to guess which should own the seed data`,
    );
  }

  const syntheticUsers = await db
    .select({ id: users.id })
    .from(users)
    .where(like(users.appleSub, "synthetic-%"));
  const syntheticIds = syntheticUsers.map((user) => user.id);
  if (syntheticIds.length === 0) {
    throw new Error("No synthetic users found - run db:seed first");
  }

  // Receipts and their denormalized image rows move together, in one
  // transaction, or the (user_id, sha256) uniqueness story fractures.
  const moved = await db.transaction(async (tx) => {
    const movedReceipts = await tx
      .update(receipts)
      .set({ userId: realUser.id })
      .where(inArray(receipts.userId, syntheticIds))
      .returning({ id: receipts.id });
    await tx
      .update(receiptImages)
      .set({ userId: realUser.id })
      .where(inArray(receiptImages.userId, syntheticIds));
    return movedReceipts;
  });

  console.log(
    `Moved ${moved.length} receipts to ${realUser.displayName ?? realUser.id}.`,
  );
  await pool.end();
}

claim().catch((err) => {
  console.error(err);
  process.exit(1);
});
