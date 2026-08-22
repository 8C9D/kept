import { eq } from "drizzle-orm";
import { createSessionTokens } from "../auth/session.js";
import { LOCAL_DEV_DATABASE_URL, createDb } from "./client.js";
import { assertLocalDatabase } from "./databaseUrl.js";
import { users } from "./schema.js";

/**
 * `npm run dev:session-token [-- <handle>]` - a session token for the local
 * web client's dev sign-in (wave 7).
 *
 * Sign in with Apple for the web cannot run against localhost: Apple's JS
 * requires a registered Services ID with a verified domain, which is a
 * production artifact. The iOS dev loop never had this problem - a phone
 * holds a real Apple session and mints real identity tokens against any
 * server. So local web development signs in by pasting a token this script
 * prints, into an entry the web app compiles only into its dev build.
 *
 * Why this is not the bypass the verifier forbids: the token is signed with
 * SESSION_JWT_SECRET, read from `.env.local` exactly as `npm run dev` reads
 * it. Whoever runs this already holds the session-signing authority for the
 * server it targets; nothing is bypassed that the secret does not already
 * command, and the production secret is not here. Structurally on top of
 * that: the database must be local (assertLocalDatabase, same refusal as
 * db:seed), NODE_ENV=production refuses outright, and the user it creates
 * carries an `apple_sub` in a `dev:` namespace no real Apple subject uses.
 */
if (process.env.NODE_ENV === "production") {
  console.error(
    "dev:session-token is a local development tool and refuses to run with NODE_ENV=production.",
  );
  process.exit(1);
}

const secret = process.env.SESSION_JWT_SECRET;
if (secret === undefined || secret === "") {
  console.error(
    "SESSION_JWT_SECRET is not set. Add it to server/.env.local (the same value the dev server signs with), then re-run.",
  );
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL ?? LOCAL_DEV_DATABASE_URL;
assertLocalDatabase(
  databaseUrl,
  "DATABASE_URL",
  "this script writes a dev user and mints a session for it",
);

const handle = process.argv[2] ?? "dev";
if (!/^[a-z0-9-]{1,40}$/.test(handle)) {
  console.error(
    `The handle becomes part of a dev apple_sub; use 1-40 lowercase letters, digits or hyphens, got "${handle}"`,
  );
  process.exit(1);
}

const { db, pool } = createDb(databaseUrl);

const appleSub = `dev:${handle}`;
const inserted = await db
  .insert(users)
  .values({ appleSub, displayName: handle })
  .onConflictDoNothing({ target: users.appleSub })
  .returning();
const user =
  inserted[0] ??
  (await db.select().from(users).where(eq(users.appleSub, appleSub)))[0];
if (user === undefined) {
  throw new Error(`User ${appleSub} conflicted on insert but was not found`);
}

const token = await createSessionTokens(secret).issue(
  user.id,
  user.tokenVersion,
);
console.log(`Dev user ${appleSub} (${user.id})`);
console.log(`Session token (valid 30d, dev database only):\n`);
console.log(token);

await pool.end();
