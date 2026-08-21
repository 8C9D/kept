import { inArray, notLike, like, sql } from "drizzle-orm";
import { LOCAL_DEV_DATABASE_URL, createDb } from "./client.js";
import { assertLocalDatabase } from "./databaseUrl.js";
import { receiptImages, receipts, users } from "./schema.js";

/**
 * `npm run db:claim` - hand every synthetic-seed receipt (and its image
 * rows) to the one real signed-in user, so a device test has data to
 * scroll. Dev-only, like the seed; it refuses to guess when the real user
 * is missing or ambiguous. (Wave-3 gate review: this was a documented SQL
 * snippet run by hand during device verification.)
 */
const databaseUrl = process.env.DATABASE_URL ?? LOCAL_DEV_DATABASE_URL;

// Dev-only, like the seed: this rewrites who owns a set of tax records, so
// it gets the same refusal to run anywhere but this machine.
assertLocalDatabase(
  databaseUrl,
  "DATABASE_URL",
  "db:claim rewrites the owner of every synthetic receipt",
);

const { db, pool } = createDb(databaseUrl);

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

  // ⚠ Refusing rather than moving. Changing `user_id` on an image row does
  // not change its `object_key`, which begins with the *synthetic* user's
  // id - so a claimed receipt would be owned by the real user while its
  // image lives under someone else's prefix. That is precisely the state
  // the create route's whole-key match exists to make impossible, and it
  // would defeat the read-time check in the detail route (the August 2026
  // audit reached it by hand-editing a row and got back a presigned URL
  // naming another user's namespace).
  //
  // Rewriting the key was the alternative and is worse: the bytes in
  // storage stay at the old key, so the row would point at an object that
  // does not exist - a quiet wrong answer in place of a loud refusal.
  // Seed data carries no image rows at all, so this refuses nothing the
  // script is actually used for.
  const imageRows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(receiptImages)
    .where(inArray(receiptImages.userId, syntheticIds));
  const imageCount = imageRows[0]?.count ?? 0;
  if (imageCount > 0) {
    throw new Error(
      `Refusing to claim: ${imageCount} synthetic image row(s) carry object keys ` +
        `under the synthetic user's prefix, which claiming cannot move. ` +
        `Re-run db:seed (it creates no image rows) or delete those rows first.`,
    );
  }

  const moved = await db
    .update(receipts)
    .set({ userId: realUser.id })
    .where(inArray(receipts.userId, syntheticIds))
    .returning({ id: receipts.id });

  console.log(
    `Moved ${moved.length} receipts to ${realUser.displayName ?? realUser.id}.`,
  );
  await pool.end();
}

claim().catch((err) => {
  console.error(err);
  process.exit(1);
});
