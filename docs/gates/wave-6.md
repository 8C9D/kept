# Wave-6 gate report

2026-08-07.
Scope: deployment and distribution - the three no-go blockers from the August 2026 security review, the §10B tested backup restore, and everything submittable that is not the owner's to do.

**Nothing was deployed and nothing was submitted.** Every step in this wave that needs an account, a payment method, a browser, or Apple's portal is in §3 as an instruction, not as an action taken. Real credentials do not exist yet; no value of any secret was seen, generated, stored, or printed, and none is in the repo.

**Suites:** server **214** green (was 201; 13 added), `tsc --noEmit` clean. iOS **194** green (was 177; 17 added), zero warnings.
**Guardrail 7:** `npm run dev` from the real entrypoint, `.env.local` loaded, "Kept API listening on port 3000", one real `GET /api/me` answering 401 with `Cache-Control: no-store`. **No stale listener on port 3000** - the first wave in five where there was not one.
**Guardrail 7, again, against the production artifact:** the Docker image was built, run, and hit with real requests (§1.2). That is the artifact that will actually serve, and it had never existed before this wave.

---

## 1 · What was built, and what proves it

### 1.1 The three blockers

**Blocker 1 - no deployed server, and the app defaults to `localhost`.**
The deployment is now expressible and reproducible: `server/Dockerfile`, `server/fly.toml` (`shared-cpu-1x`, **2 GB**, per the ratified measurement), `server/.dockerignore`, and `docs/Runbook.md`.
On the client, `ServerConfig` grew a `ServerEnvironment` with two cases: production is **`https://api.keptapp.net`, and does not read the stored override at all**; development keeps `http://localhost:3000` and the settings sheet.
The compile-time condition appears in exactly one place (`ServerEnvironment.current`), so both cases are exercisable from a test build - which is always the Debug one.

**Blocker 2 - the Info.plist split holds in a Release build.**
Already done and asserted at source level in August; this wave checked the **built artifact** rather than the files that produce it. `Kept.app/Info.plist` from a Release build has no `NSAppTransportSecurity` and no `NSLocalNetworkUsageDescription`, and `Info-Debug.plist` is not in the bundle. §1.3 has the output.

**Blocker 3 - no privacy manifest, no honest label.**
`ios/Kept/PrivacyInfo.xcprivacy` declares six collected data types - other financial info, photos or videos, other user content, user ID, email address, name - **all linked to identity, none used for tracking**, all for app functionality, plus the required-reason declaration for `UserDefaults` (`NSPrivacyAccessedAPICategoryUserDefaults`, reason `CA92.1`, which is "accessible only to the app itself" and is exactly what one key of app configuration is).
It is present in the built Release bundle. The App Store Connect label is filled in by hand and must match; the wording is in §3 step 14.

**The fourth item, outbox file protection**, was implemented in August with `OutboxLockedError` and needed nothing here. Re-checked, unchanged.

### 1.2 Deployment, verified against the image rather than the intention

The image was built and run locally. Four observations, each against the real container:

| What was checked | Result |
|---|---|
| Missing environment | `Error: Missing required environment variables: DATABASE_URL, SESSION_JWT_SECRET, APPLE_CLIENT_ID` |
| Production shape, loopback `DATABASE_URL` | Refuses at startup, naming Neon as the fix |
| Production shape, `http://` storage endpoint | Refuses, stating that presigned URLs inherit the endpoint |
| Started against the dev database and MinIO | `Kept API listening on port 3000`; `GET /api/me` → **401** with `Cache-Control: no-store` |
| `EDGE_SHARED_SECRET` set, no header | **403** `forbidden` |
| `EDGE_SHARED_SECRET` set, correct header | **401** `unauthorized` - the edge check passed and the session check answered |

`src/productionEnv.ts` is new and runs only under `NODE_ENV=production`, which the Dockerfile sets. It refuses four configurations under which the server would happily **run** while being quietly wrong: no storage configured (production has no MinIO to fall back to), a plain-http storage endpoint, a loopback database, and a session secret under 32 characters. It is the mirror image of `assertLocalDatabase`, which keeps the destructive dev scripts *off* remote databases; this keeps the server *off* local ones.

**The edge secret is the part that makes the rate limiter real.** Cloudflare in front of the origin was chosen (§4.2) to carry §10B's limiter, but Fly gives every app a public `*.fly.dev` hostname, so a limiter at the edge alone guards one door of a two-door building. When `EDGE_SHARED_SECRET` is set, the origin serves only requests carrying it in a header Cloudflare adds. It is optional so a first deploy works before Cloudflare is configured, and absent in development.

### 1.3 The Release build, inspected as an artifact

Built for the simulator with signing off, then read:

```
bundle contents:  Info.plist  Kept  PkgInfo  PrivacyInfo.xcprivacy
NSAppTransportSecurity in built Info.plist:      absent
NSLocalNetworkUsageDescription in built plist:   absent
Info-Debug.plist in bundle:                      absent
PrivacyInfo.xcprivacy collected data types:      6
strings in the Release binary:
  api.keptapp.net    2       Server settings     0
  localhost:3000     2       Reset to default    0
```

**The control matters more than the counts.** "Server settings: 0" is only evidence if the probe could have found it, so it was checked against a binary that definitely contains it: the Debug build's `Kept.debug.dylib` carries `Server settings` 1, `Reset to default` 1, `localhost:3000` 3. A first attempt read the Debug `Kept` executable and got zero for everything including a control string - that binary is a 58 KB stub, with the code in a separate debug dylib. Reading the wrong file would have produced a comfortable and meaningless "nothing there".

**`localhost:3000` still appears twice in the Release binary, and that is a real residual, stated rather than smoothed over.** Both are dead literals: the `ServerEnvironment.development` case's URL, and the example inside `InvalidBaseURL`'s message. Neither is reachable - `ServerEnvironment.current` is `.production` under a compile-time branch, nothing else constructs `.development`, and the only caller of the message (`setOverride`, from the settings screen) is compiled out. I did not fence the enum case itself: it would spread `#if DEBUG` through a switch and its callers to delete a string, and this project has already rejected that trade once (the `INFOPLIST_PREPROCESS` conditional, August 2026). **A string constant is not an affordance.** But the honest statement is "no reachable path to localhost", not "no localhost in the binary".

### 1.4 The tested backup restore - §10B's one non-deferrable item

Never run before. Run end to end against the dev database, which holds **real captured receipts and their real stored bytes**, so this was not a drill against synthetic data.

1. `pg_dump -Fc` of the dev database (16 200 bytes).
2. A scratch database created, `pg_restore` into it, exit 0.
3. `npm run db:verify-restore` (new, `src/db/verifyRestore.ts`): row counts per table source-vs-restored, then every live image row in the **restored** database followed out into object storage and its bytes re-hashed against the digest that row carries.

```
users 3 -> 3 ok · receipts 9 -> 9 ok · receipt_images 4 -> 4 ok · export_jobs 0 -> 0 ok
4 live image objects, all re-hashing to their own rows
Restore verified.
```

**Then it was falsified, because a verifier that cannot fail verifies nothing.** Against a deliberately damaged copy it reported all three failure classes and exited 1: a deleted row (count mismatch), a corrupted digest (`DIGEST`, with both hashes printed), and a key pointed at a nonexistent object (`MISSING   ... NoSuchKey`). It also refuses when both URLs name the same database, and refuses to report success when the restored database holds no images at all - a restore verified against zero images has verified nothing, which is the vacuous-assertion shape the August audit found in the isolation suite.

The dev database was left exactly as found (3 users, 9 receipts, 4 images) and the scratch database dropped. The procedure is `docs/Runbook.md` §4, parameterized so it runs identically against Neon and R2.

**⚠ A finding that came out of writing it up.** §10B says "managed Postgres with point-in-time recovery", and **Neon's history window is 6 hours on the Free plan** (7 days on Launch, 30 on Scale). That is a fine answer to "I ran the wrong thing twenty minutes ago" and **is not a six-year retention story**. The dump procedure above is what retention actually rests on, so it needs to be taken on a schedule and kept somewhere that is not Neon - §3 step 17. This is not a defect in anything built; it is an assumption in §10B that only became checkable once a provider was chosen.

### 1.5 The R2 key-normalization question, answered as far as it can be

The kickoff asks for the audit's leading-slash case to be tested against real R2. **It cannot be, because there are no R2 credentials.** What exists instead is `npm run storage:probe-keys` (`src/storage/keyNormalizationProbe.ts`): nine spellings against a planted victim object, with a control that proves the probe can observe a leak, refusing to report anything if the control fails.

Run against MinIO it reproduces the audit exactly - control 200, **leading slash and double leading slash serve the victim's bytes**, all six dot-segment spellings refused. So the probe works, and the one command in §3 step 12 turns R2's behaviour from an assumption into a measurement. Nothing in the API depends on the answer either way: `isIssuedObjectKey` matches whole strings and rejects every one of these spellings on write, and `assertIssuedObjectKey` re-checks on read.

---

## 2 · Prediction versus reality

Written to scratch before any of the above (`wave6-predictions.md`).

- **Predicted:** server suite lands 210-214. **Reality: 214.** Fine.
- **Predicted:** dev database holds 1-3 users, 5-20 receipts, images ≤ receipts, "a handful of export jobs". **Reality: 3 / 9 / 4 / zero export jobs.** The export-job guess was wrong in the direction that should have been obvious - exports are run from the web client, which does not exist yet, so of course there are none.
- **Predicted:** the MinIO probe reproduces the audit - leading slash leaks, dot segments refused. **Reality: exactly that.**
- **Predicted:** iOS lands 180-185, and the ServerConfig change forces edits to existing ServerConfig tests. **Reality: 194, and there were no existing ServerConfig tests to edit.** A file with a settings screen, a UserDefaults override, and a URL validator had no test of its own for three waves. It has eighteen now.
- **Predicted:** the Release binary would *not* contain `localhost:3000`. **Reality: it does, twice, both dead** (§1.3). The prediction assumed dead-code stripping I never checked; the useful part is that reading the artifact is what surfaced it.
- **Predicted (self-flagged as the likeliest gap):** trouble getting `PrivacyInfo.xcprivacy` into the bundle, or a Release build needing signing flags. **Reality: the manifest needed no project-file edit at all** (the `Kept` folder is a synchronized group), and `CODE_SIGNING_ALLOWED=NO` was the only flag needed. The predicted gap did not appear; a different one did, below.
- **Unpredicted, and the wave's most instructive event:** the fencing test passed while an unfenced "Server settings" button sat in `SignInView`. See §5.

---

## 3 · The checklist - what only the owner can do, in order

Nothing here can be done by an agent: each needs an account, a payment method, a browser, or Apple's portal. **Do them in this order** - later steps depend on values earlier steps produce.

**Accounts and storage**

1. **Cloudflare account, and register `keptapp.net`** (or transfer it in, if it exists elsewhere). The domain must be in your own Cloudflare account - Cloudflare can only proxy and rate-limit a zone it hosts, and `kept-api.fly.dev` is not one.
2. **Create the R2 bucket `kept`.** Note the account id; the S3 endpoint is `https://<account-id>.r2.cloudflarestorage.com`.
3. **Create an R2 API token** scoped to that bucket with read and write. It shows the access key id and secret **once**. These become `STORAGE_ACCESS_KEY_ID` and `STORAGE_SECRET_ACCESS_KEY`.
4. **Add the lifecycle rule on the bucket:** prefix exactly `exports/`, expire after **30 days**. ⚠ Only that prefix. Receipt images live under `{userId}/...` and must be under no lifecycle rule at all - they are the retained records.

**Database**

5. **Create the Neon project** and a database. Take the **pooled** connection string; it becomes `DATABASE_URL`.
6. **Decide the Neon plan now, not later.** The Free plan's 6-hour history window is not a retention story (§1.4). Either take a paid plan for a longer window or commit to the scheduled dump in step 17 - and honestly, do the dump either way.

**The origin**

*Correction, 2026-08-16: the name `kept-api` turned out to be taken by an unrelated app on the Fly platform, so the app is `keptapp-api` and `fly.toml` was updated. Read `kept-api` as `keptapp-api` in steps 7 and 10 below; the instructions are otherwise unchanged.
Also decided 2026-08-16: `ANTHROPIC_API_KEY="..."` joins the step 8 `fly secrets set` command, which omitted it - LLM parsing is on from the first deploy.*

*Correction, 2026-08-18: steps 14-16 are done. The App Store name "Kept" was taken, so the record is "Kept Receipts" (app id 6802835941); the home-screen name stays Kept via `CFBundleDisplayName`. Step 15 surfaced a gap honestly attributable to no gate: the archive had no app icon - the `AppIcon` slot was empty and `CFBundleIconName` unset - and it was **Apple's upload validator, not any check in this repository**, that refused it; an icon and the plist key now ship, along with `ITSAppUsesNonExemptEncryption=false` so later builds skip the export-compliance question. Step 16's warning about the dev database was resolved by ruling, not by migration: dev database, bucket, and phone were wiped to zero first. The end-to-end proof: the TestFlight build signed into production and the production database read back `users 1, receipts 0`. Steps 17 and 18 remain; 18 is additionally gated on the Account Holder accepting the updated Program License Agreement and on a privacy policy URL, which does not exist yet.*

7. **`fly auth login`, then from `server/`: `fly launch --no-deploy`** (it will pick up the committed `fly.toml`; keep the app name `kept-api` or update `fly.toml` if Fly assigns another).
8. **Set the secrets** - the values from steps 3 and 5, plus a fresh session secret. Generate it with `openssl rand -base64 48`; nobody needs to read it, including you:
   ```
   fly secrets set DATABASE_URL="..." SESSION_JWT_SECRET="$(openssl rand -base64 48)" \
     APPLE_CLIENT_ID="com.arthurzhang.kept" \
     STORAGE_ENDPOINT="https://<account-id>.r2.cloudflarestorage.com" \
     STORAGE_BUCKET="kept" STORAGE_ACCESS_KEY_ID="..." STORAGE_SECRET_ACCESS_KEY="..."
   ```
9. **`fly deploy`**, then **`fly ssh console -C "npm run db:migrate"`** - migrations are deliberate, never on boot.
10. **Confirm it is real:** `curl -i https://kept-api.fly.dev/api/me` must answer **401** with `Cache-Control: no-store`. Not a health check - a real route.

**Cloudflare in front**

11. **DNS:** a **proxied** (orange cloud) CNAME `api` → the Fly hostname. Then one rate limiting rule on `api.keptapp.net` counting by IP (the Free plan allows exactly one, 10-second window; `POST /api/auth/apple` is the endpoint worth it). Then a Transform Rule setting request header `x-kept-edge-secret` to a random string, and `fly secrets set EDGE_SHARED_SECRET="<same string>"` - **transform rule first, then the Fly secret.**
12. **Once R2 credentials exist, run the probe once** and paste the output back: `STORAGE_ENDPOINT=... STORAGE_BUCKET=... STORAGE_ACCESS_KEY_ID=... STORAGE_SECRET_ACCESS_KEY=... npm run storage:probe-keys`. It leaves two small objects under `probe-victim-*` and `probe-attacker-*`; delete them from the bucket afterwards.
13. **Re-run step 10 against `https://api.keptapp.net`.** A 403 means the transform rule is not adding the header.

**Apple**

14. **Fill in the App Store Connect privacy label** to match `PrivacyInfo.xcprivacy` exactly: **Financial Info → Other Financial Info**; **User Content → Photos or Videos**, and **Other User Content**; **Identifiers → User ID**; **Contact Info → Email Address**, and **Name**. Every one: **linked to the user's identity**, **not used for tracking**, purpose **App Functionality**. ⚠ "Data Not Collected" would be false.
15. **Archive and upload a build** (Xcode → Product → Archive → Distribute → TestFlight). Signing is automatic and the team is already `<team-id>`.
16. **Install from TestFlight on your own phone and sign in before anything else.** ⚠ **Your phone currently points at `http://localhost:3000` and its receipts live in the local dev database on your Mac. Production starts empty. Nothing migrates.** The nine receipts in the dev database stay there; if you want them in production they have to be re-captured, or moved deliberately as a separate piece of work that does not exist yet. Also: the TestFlight build has **no server-settings screen** - that is intended, and it means this build cannot be pointed back at your Mac.
17. **Set up the scheduled `pg_dump`** (Runbook §4) before real receipts accumulate, and keep the files off Neon and off the one laptop.
18. **Only then:** submit to App Review as though public, with a Review Notes line stating unlisted intent, and afterwards file the unlisted app request as Account Holder.

⚠ **Step 18 is the irreversible one. The unlisted conversion is permanent for that app record** - if a consumer version is ever wanted it needs its own record from the start. Do not file it until steps 10, 13 and 16 have all actually answered correctly.

---

## 4 · Judgment calls the spec did not settle

**The settings sheet is gone from Release builds.** The security review left this explicitly as a product call and the owner ruled to remove it. Recorded because the reasoning generalizes: with the ATS exception gone, an `http://` address can no longer carry cleartext, so the remaining risk is redirection - a control on every installed phone that sends the session bearer token, and every request made with it, to an address of the holder's choosing. Under an unlisted link that anyone can install from, that is a control with one legitimate use (development) and one dangerous one. Cost, stated: moving the API to another host now needs an app update.

**`api.keptapp.net` is baked into the Release binary rather than read from a build setting.** An `INFOPLIST_KEY` or an `.xcconfig` would make it configurable, which is precisely what it must not be.

**The edge shared secret is optional, not required.** A required one would make the first deploy impossible - the origin has to answer before Cloudflare can be pointed at it. The cost is that forgetting it leaves the origin publicly reachable, which is why it is step 11 and not a footnote.

**The Dockerfile runs `tsx` rather than compiled JavaScript,** and installs dev dependencies to do it. A build step would produce a second code shape that exists only in production - the exact environment divergence this project has paid for eight times (framework §9.3 rule 5). It also keeps `drizzle-kit` on the machine so migrations run from where the database is reachable. At one always-on machine, the startup cost is irrelevant.

**`auto_stop_machines = "off"`.** A cold start on pull-to-refresh would read as the honest 10-second timeout the wave-5 offline work put in front of people. Scale-to-zero saves dollars and spends the success test.

---

## 5 · What the reviewer pass found, and the one that matters

The read-only reviewer rubric (§10.3) was run over everything above. One finding is worth the whole section.

**A test that could not fail for the case it existed for.**
`testEverySettingsScreenReferenceIsFencedOutOfReleaseBuilds` searched app source for `ServerSettingsView` outside a `#if DEBUG` region. Falsifying it - unfencing the settings button in `SignInView` - **it passed.** The button's line is `Button("Server settings")`, which does not mention the type; only the `.sheet` presentation does, and that one was still fenced. So the falsification produced a Release build with a **visible settings button whose sheet is compiled out** - a dead control, shipped - and the test guarding exactly that said nothing.

The fix checks the user-facing label as well as the type, and the paired "still exists in Debug" test now asserts both too, so neither can guard an absence. Re-falsified: with the button unfenced it fails; with it fenced it passes.

**The lesson, which is not about this test.** It is the August audit's N3 in a different costume: an assertion aimed at *how a thing is built* rather than at *the thing a person sees*. The type is an implementation detail of the affordance; the label is the affordance. Written the first way, the test tracked my own mental model of the code instead of the property under review - and my mental model was where the defect was. **When a test guards a user-visible property, assert the user-visible string.**

Also found and fixed in the same pass: the initial `strings` check read the Debug stub binary and reported zero for a control string (§1.3), which would have been read as "clean" if I had not insisted on a control.

---

## 6 · Anti-pattern self-review

Against the framework's §10.2 list, honestly:

- **Duplication.** The probe script builds its own `S3Client` rather than reusing `makeClient`, which is private to `s3ObjectStorage.ts`. Six duplicated lines in a diagnostic that deliberately bypasses the `ObjectStorage` interface (it needs raw key handling the interface does not expose). Exporting `makeClient` to save six lines would widen a production module's surface for a script. Judged acceptable; recorded so it is a decision and not an oversight.
- **Error-masking.** None added. `assertProductionEnv` throws with the fix named; `verifyRestore` collects failures and exits non-zero rather than logging and continuing; the edge middleware refuses rather than passing through. The one deliberate silence is `resolveStorageConfig` returning `null` for "not configured at all" - which is pre-existing, and which `assertProductionEnv` now converts into a refusal in production, closing the one case where the quiet fallback was dangerous.
- **Tests written to pass rather than falsify.** One instance, found and fixed - §5. Every other new test was run in its failing direction: the six production-env refusals (each check stubbed to `false`), the edge middleware (removed - 4 of 6 fail; the two that survive are the "unconfigured" and "correct secret" cases, which is what they are for), the restore verifier (three damage classes), the environment tests (compile-time branch inverted, and `allowsOverride` forced true), the privacy manifest (file removed; `Linked` flipped to false).
- **Speculative generality.** `ServerEnvironment` has exactly two cases because there are exactly two. No staging case was added for a staging environment §10B explicitly defers.
- **Comment drift.** `ServerConfig`'s doc comment was rewritten rather than left describing the old behaviour - it previously said a device "overrides it in the in-app server settings", which is now false in Release.
- **Inconsistent patterns.** The new startup checks follow the entrypoint's existing shape (throw with the fix named); the new scripts follow `db:claim`'s shape (refuse loudly, name the stakes).
- **God modules / primitive obsession / untyped boundaries.** `productionEnv.ts` is one function; the environment became a type instead of a boolean pair, which is the direction the list asks for.

---

## 7 · What I could not verify, and what it would take

- **Anything against real Fly, Neon, R2, or Cloudflare.** No accounts exist. The image was verified locally against the dev database and MinIO; every deployed-shape check was verified by making the real image refuse.
- **R2's key normalization** - the kickoff asked for this specifically. It needs credentials. The probe is written, works against MinIO, and is one command (§3 step 12).
- **The privacy label's acceptance by App Review.** The manifest's strings were checked against Apple's published constants; whether the label as filed matches Apple's expectations is decided by a reviewer.
- **ATS as runtime behaviour on a device.** Still unobservable from a simulator. What improved is that the assertion is now against the built bundle rather than the source plist.
- **That `https://api.keptapp.net` resolves to anything.** The domain is not registered yet. The Release build points at an address that does not exist until step 1.
- **The app against the deployed server, at all.** Blocker 1 is closed as *configuration*; the first real end-to-end proof is the owner's step 16.
- **Whether the rate limiter's one Free-plan rule is enough.** Untestable without traffic. It bounds the one route a stranger with the link can reach, which is the threat model's concern.

---

## 8 · State of the wave

The three no-go blockers are closed as far as they can be closed without credentials: **a deployment that exists as reproducible configuration and a verified image**, **an Info.plist split confirmed in a built Release bundle**, and **a privacy manifest that ships and an honest label written out word for word**. §10B's tested backup restore, never run before, has now run and been falsified.

**Wave 6 is not finished, and the remainder is deliberately the owner's.** Everything left is in §3, in order, ending at the one irreversible step - which nothing in this session went near.
