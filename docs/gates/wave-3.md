# Wave-3 gate report

2026-08-05.
Scope built: the iOS shell - Xcode project at `ios/`, Sign in with Apple against the wave-1 backend, keychain session storage, Home with the capture placeholder and the paged receipt list, read-only receipt detail, a single networking layer, and a configurable server address.
Also: spec §10A amended with the settled confirm-screen design (§10A.1) before any code was written, per the kickoff.
Suite: 6 XCTest suites, 53 tests, all green on the iPhone 17 Pro simulator (iOS 26.3); the app target builds with zero warnings.

## 1 · Prediction versus reality

Predicted before the first build: the hand-written `project.pbxproj` (filesystem-synchronized groups, written without Xcode) was the likeliest failure, followed by small SwiftUI API mismatches; the Swift itself and the tests would mostly work.

Reality: the project file parsed, built, and signed on the first attempt, with zero warnings, and all 49 initial tests passed on the first run.
The cross-wave observation holds a third time - my runtime predictions are consistently pessimistic - but with a new corollary: this wave the seams were quiet too, and the only real defects were found by the reviewer pass, not the compiler or the suite.
The genuine defect of the wave was my own concurrency design in `ReceiptListModel` (a refresh racing an in-flight page fetch could splice a stale page into a fresh list), which I did not predict and my own tests did not catch, because every test awaited one thing at a time.
Same lesson as wave 1: I predict where I already suspect weakness, and the reviewer finds the weakness I do not suspect.

One verification wrinkle worth recording: `codesign -d --entitlements` on a simulator build prints an empty dict, which looks exactly like a missing entitlement.
The Sign in with Apple entitlement is in fact present - simulator builds carry it in the `-Simulated.xcent` (verified: `application-identifier <team-id>.com.arthurzhang.kept`, `com.apple.developer.applesignin [Default]`); the signature-level check only means something on a device build.

## 2 · What was verified, and what was not

Verified here, per §10.2's asymmetry:

- `xcodebuild` builds the app for the simulator with zero warnings; `xcodebuild test` runs 53 tests green.
- The networking layer against a stubbed transport: the session token is attached in exactly one place, all five error shapes map in exactly one place, the server's real JSON (including `null` fields, opaque cursors, and both ISO-8601 timestamp forms) decodes into the typed models.
- Token storage against the real simulator keychain: round trip, overwrite, clear, idempotent clear, service isolation.
- The session-expiry path: a 401 on any authenticated call clears the keychain and returns state to signed-out; a 401 at sign-in (rejected identity token) is a plain failure that also lands at signed-out - never a hang in `.signingIn`. Both by test.
- Pagination decisions: cursor threading, last-row triggering, exhaustion, retry after a failed page, and the refresh-versus-paging interleave (a dedicated regression test parks a page fetch on a gate, refreshes, and asserts the stale page is discarded).
- The built artifact, not just the build: bundle id `com.arthurzhang.kept`, ATS local-networking exception, launch-screen and orientation keys, the entitlement above.
- The app installs, launches, and renders the sign-in screen on the simulator (screenshot inspected, twice - once again after the review fixes, since the composition root changed).

Not verifiable here - this is the owner's half (§5 of the kickoff):

- The real Sign in with Apple sheet, the token exchange against Apple, and Xcode's automatic creation of the App ID.
- Session persistence across a cold launch on a device, and the list loading and paging against a live server.
- Where I expect the device run to fail, most likely first: **the local-network pair** - iOS will show a Local Network permission prompt on the first request (deny it and everything times out), and a raw `http://192.168.x.x` URL may or may not clear ATS, so use `http://<mac-name>.local:3000`, which `NSAllowsLocalNetworking` covers cleanly. Second: sign-in 401s if the server's `.env.local` has `APPLE_CLIENT_ID` set to anything other than `com.arthurzhang.kept`. Third: first signed build may stall until Xcode (signed into the developer account) registers the App ID and capability.

## 3 · Judgment calls the spec did not settle

- **The pending count is a probe, typed honestly.** §5.2a demands a visible pending count and the API has no count endpoint, so the model fetches up to one maximum-size page (200) of pending receipts and reports `exact(n)`, `atLeast(n)` ("200+"), or `unknown` ("Pending count unavailable") when the probe fails. Never a silent zero.
- **A sign-out menu item exists** though §7.1's screen list has none. Without it the only way out of a session is 30-day expiry, and repeated device sign-in testing (and wave 6's second user) needs an exit. It lives behind the toolbar ellipsis, deliberately out of the way.
- **Server settings are an in-app sheet** (sign-in footer and Home menu). The kickoff required a configurable base URL; the affordance shape was mine. Default is `http://localhost:3000` for the simulator; a device points at the Mac by name.
- **`token_version` needs no client-side handling beyond storage.** The claim lives inside the JWT and is the server's to check; the client stores the token opaquely, and revocation surfaces as the tested 401-to-signed-out path. Nothing to parse on the phone.
- **A failed refresh drops the stale list** in favour of the failure message and Retry - stale rows rendering as current data felt like the quiet-wrong-answer pattern. Offline-friendliness is deliberately deferred to wave 5, where the outbox makes offline a designed state instead of an accident.
- **`purchasedAt` stays a `yyyy-mm-dd` string** end to end, formatted for display by one UTC-pinned formatter; a `Date` would invent a midnight and a timezone and shift a day west of Greenwich.
- **Swift 5 language mode**, not Swift 6 strict concurrency, for legibility of the teaching text; isolation is still explicit (`@MainActor` models, one `nonisolated` seam).
- **Sign-in's `SessionUser` is decoded but not persisted** - only the token is kept. Nothing in the five screens displays profile data yet; persisting it now would be speculative.

## 4 · Things I believe are wrong or missing in the spec

1. **No count endpoint, but §5.2a requires a count.** The 200-receipt probe is honest but heavy (it fetches full rows to display an integer) and saturates at "200+" exactly when the backlog - the reason the badge exists - is largest. The server should answer pending counts; wave 7's web banner will want the same thing. One cheap shape: a `pendingCount` field on the list response.
2. **Local dev cannot serve images, and wave 4 will hit this wall.** `unconfiguredObjectStorage` throws on `presignDownload`, so any receipt *with* an image row 500s the detail endpoint against a local server. It is invisible today only because the seed creates no image rows (the detail screen states "No image stored for this receipt"). Wave 4's capture-confirm loop cannot be exercised at all without a dev storage adapter (local filesystem or MinIO) - that is pre-wave-4 server work and should be scheduled as such.
3. **Device verification needs data the seed cannot give.** Sign in with Apple creates a fresh user with zero receipts; the seeded receipts belong to synthetic users nobody can sign in as. The gate's "list loads and pages" therefore needs the reassignment and volume SQL in §6 below - worth folding into the seed story eventually.
4. **§7.1's "recent receipts" is unspecified.** Home lists all receipts, newest purchase first, paged - "recent" as ordering, not as a cutoff. If it meant a cutoff, that is a wave-4-or-later conversation.
5. **Housekeeping for wave 6:** the ATS local-networking exception and `NSLocalNetworkUsageDescription` are development affordances and are commented as revisit-before-distribution in `Info.plist`.

## 5 · Self-review against the anti-pattern list

A read-only reviewer pass ran over the wave with the §10 rubric and returned 11 findings: 3 medium, 1 medium-low, 7 low.
It also verified the API contract clean against the server route by route - field names, optionality, query params, error envelope, the omitted-not-null `displayName` - and found no force unwrap, no `try!`, no logging, and the token nowhere but the keychain and the Authorization header.
The correction catalog, by category:

- **Concurrency design (medium, fixed):** `loadFirstPage` neither guarded re-entry nor invalidated an in-flight `loadMore`, so a pull-to-refresh during a page fetch could append a stale-cursor page to the fresh list and corrupt the cursor chain. Fixed with a generation counter captured before and checked after every await, plus a gate-based regression test that reproduces the exact interleave.
- **Data race in a test double (medium, fixed):** the model's `async let` means two tasks hit the stub API concurrently, and its call log was a plain array - undefined behaviour that could flake the suite. Lock-guarded now. The same `async let` passes the non-Sendable `APIClient` across child tasks in production; accepted as-is because the client is stateless per request, and recorded as a thing the Swift 6 migration will make explicit.
- **Duplication (medium, fixed):** the failure-plus-Retry fragment was hand-rolled three slightly divergent times, the centered spinner row three more; both are now single components (`LoadFailureView`, `CenteredProgressRow`), siblings of the already-extracted `PendingBadge` and `FieldRow`.
- **Error coupling (medium-low, fixed):** the pending probe and the list fetch failed as one, so a broken badge count destroyed a successfully loaded list; and after a failed refresh the stale badge kept rendering. The probe now degrades to a stated `unknown` without touching the list, and a failed refresh resets the badge too. Both under test.
- **Security posture (low, fixed, decision reversed):** I had set keychain accessibility to `AfterFirstUnlock` for the wave-5 outbox - loosening security for a feature that does not exist. Now `WhenUnlocked`, with the update path re-asserting accessibility so wave 5 can widen it in one line and existing installs migrate on their next save. DECISIONS corrected.
- **Silent fallback (low, fixed):** an unparseable stored server override silently reverted to the default; it now surfaces a note in the settings sheet.
- **Composition-root pitfall (low, fixed):** dependencies were loose `let`s in `App.init`, which SwiftUI may re-run while keeping only the first `@StateObject` - a fresh `APIClient` would then report 401s to a controller no view observes. The whole graph now lives in one `@StateObject`-held `AppEnvironment`.
- **Performance (low, fixed):** `NumberFormatter`/`DateFormatter` were built per call, per row, per render pass; rendering now uses `FormatStyle`. This also deleted `plainAmount`, whose only production caller was a fallback for a nil the adjacent comment argued could never occur - the reviewer's unreachable-path finding dissolved rather than patched.
- **Test coverage (low, fixed):** the decoder's non-fractional ISO-8601 branch - written explicitly to survive a server serialization change - had no test and could have regressed silently; and two keychain-failure tests asserted only "some message exists". All three tightened.

**Weakest code, named:** `ReceiptListModel`, still, after its fix.
The generation counter is a manual discipline: every future await added to that class must remember to capture and re-check it, and nothing structural enforces that - a forgotten guard reintroduces the interleave without failing any existing test except the one that happens to cover that path.
It is the only class managing multi-request state over time, and it does so by convention rather than by construction.
Second weakest: the hand-written `project.pbxproj` and scheme have never been opened by Xcode itself; the first time the owner opens the project, Xcode may rewrite both, and that diff will need reading rather than assuming.
Third: `HomeView` is the largest view file in the app; it renders only, but it is the file nearest the massive-view line and the one to watch when wave 4 adds capture.

## 6 · Device test script - what to tap, and what passing looks like

Setup (once, on the Mac):

1. `cd ~/dev/kept/server && docker compose up -d`, then `npm run db:migrate && npm run db:seed`.
2. `.env.local` must contain `DATABASE_URL=postgres://kept:kept@localhost:5432/kept`, a `SESSION_JWT_SECRET` of 32+ characters, and - this one matters for the phone - `APPLE_CLIENT_ID=com.arthurzhang.kept`.
3. `npm run dev` (listens on 3000, all interfaces).
4. Open `ios/Kept.xcodeproj` in Xcode signed into the developer account, select your iPhone, run. First build should auto-register the App ID with the Sign in with Apple capability - do not create it in the portal. If Xcode rewrites the project file on open, that is expected; glance at the diff.
5. Mac's local name: `scutil --get LocalHostName` → the server URL is `http://<that-name>.local:3000`.

The script - in order, each step states what passing looks like:

1. **Cold launch.** Sign-in screen: scanner glyph, "Kept", one black Sign in with Apple button, "Server settings" underneath. Tap **Server settings**, enter `http://<mac-name>.local:3000`, Save.
2. **Sign in.** Tap the button → Apple's native sheet with your Apple ID → Face ID. Allow the Local Network prompt if iOS raises one. **Pass:** Home appears - "Kept" title, a disabled Capture button captioned "Scanning arrives in a later build.", and "No receipts yet" (your account is brand new). **Fail reads:** red text under the logo; "Apple identity token failed verification" means the server's `APPLE_CLIENT_ID`, "Could not reach the server" means the URL or the network prompt.
3. **Give yourself the seed data.** On the Mac: `docker exec -it kept-db psql -U kept -d kept` then:
   ```sql
   UPDATE receipts SET user_id = (SELECT id FROM users WHERE apple_sub NOT LIKE 'synthetic-%')
   WHERE user_id IN (SELECT id FROM users WHERE apple_sub LIKE 'synthetic-%');
   ```
   Pull to refresh. **Pass:** five receipts, newest purchase (Apr 1) first; an amber "2 pending" badge on the header; amber "Pending" badges on Vendors Two and Five; Vendor Four shows US$9.99 (a USD receipt must not render like a CAD one).
4. **Paging.** Still in psql:
   ```sql
   INSERT INTO receipts (user_id, purchased_at, captured_at, total_cents, vendor, is_business, status)
   SELECT u.id, DATE '2025-01-01' + n, now(), 1000 + n, 'Backlog vendor ' || n, true,
          CASE WHEN n % 5 = 0 THEN 'pending' ELSE 'confirmed' END::receipt_status
   FROM generate_series(1, 60) AS n,
        (SELECT id FROM users WHERE apple_sub NOT LIKE 'synthetic-%') AS u;
   ```
   Pull to refresh, scroll to the bottom. **Pass:** the header badge now reads "14 pending"; around fifty rows in, a brief spinner appears at the bottom and the remaining rows arrive; the full list reaches "Backlog vendor 1" with no duplicates. Also pull-to-refresh mid-scroll once - the list must come back clean, not doubled.
5. **Detail.** Tap "Synthetic Vendor One". **Pass:** "$113.00" in large type with "Total" under it; Date Jan 14, 2026; HST $13.00; Subtotal $100.00; Tax number 000000000RT0001; Type Business; absent fields say "Not recorded" in italics, not blank; an italic "No image stored for this receipt." (real images need the storage adapter - a known pre-wave-4 gap, §4.2). Back navigates cleanly.
6. **Cold-launch persistence.** Swipe the app away, relaunch. **Pass:** straight to Home, no sign-in screen.
7. **Revocation.** In psql: `UPDATE users SET token_version = token_version + 1 WHERE apple_sub NOT LIKE 'synthetic-%';` then pull to refresh on the phone. **Pass:** the sign-in screen, with "Your session has expired. Sign in again." Signing in again works immediately.
8. **Sign out.** (After signing back in.) Ellipsis menu → Sign out. **Pass:** sign-in screen, no message; relaunching the app stays signed out.

## 7 · Device verification - PASSED (the owner, 2026-08-05)

All eight steps of §6 passed on the owner's iPhone with no deviations: real Sign in with Apple end to end (first-authorization name captured and stored), the reassigned seed data with the correct pending badge and USD rendering, 65 receipts ordering correctly with no duplicates, detail fields and stated absences, session persistence across cold launch, token_version revocation landing on the expiry message, and clean sign-out.
One observation rather than a deviation: the paging spinner never appeared, because local wifi returns the next page faster than a human can scroll to the trigger row - paging correctness held (full list reachable, no duplicates, clean list after a mid-scroll refresh).
**The wave-3 gate is closed.**

Operational notes from the assisted run, for the record:

- The build-and-install path ran entirely from the CLI: `devicectl` pairing (first attempt timed out awaiting the phone-side prompt; second succeeded), Developer Mode enablement on the phone, then `xcodebuild -allowProvisioningUpdates`, which auto-issued "iOS Team Provisioning Profile: com.arthurzhang.kept" carrying the Sign in with Apple entitlement - the App ID was registered automatically, and the developer portal was never opened. §2's predicted failure points (pairing/Developer Mode friction) were the ones that actually fired; ATS and the Local Network prompt were not.
- Mid-run, the API server on port 3000 turned out to be down at step 4 and had to be restarted - which surfaced the wave's most instructive defect, found by the owner: **`npm run dev` never loaded `.env.local`**. Every prior wave's suite (110 tests) was green while the real entry point was unrunnable from a clean checkout, because tests inject their configuration and never execute `src/index.ts`. This produced the new standing gate requirement (framework guardrail 7, CLAUDE.md): every gate starts the real server the real way and lands one real request.

## 8 · Gate-review changes accepted (the owner)

Five changes, applied immediately after the gate in the follow-up commit; decisions and rejected alternatives in `DECISIONS.md`:

1. `GET /api/receipts` now returns `pendingCount`; the iOS 200-row probe is gone.
2. MinIO joins docker-compose as local object storage, behind the real S3-compatible adapter - the presigned path wave 4 depends on is now exercisable locally.
3. The seed-reassignment SQL became `npm run db:claim`.
4. `ReceiptListModel` no longer holds a raw API reference: every request goes through `GuardedReceiptLoader`, whose result type carries `.superseded` - the generation check moved from convention to construction, per this report's own weakest-code call.
5. `npm run dev` loads `.env.local` (creating it if absent) via `node --env-file`.

Also confirmed: §7.1's "recent receipts" means ordering, not a cutoff - recorded in the spec.

Applying change 2 forced a fix the integration tests earned on their first run: the SDK's presigned PUT URLs sign only the `host` header by default, so the upload-url route's content-type restriction was decorative - a client could declare `image/jpeg` and store anything. The adapter now signs the content-type header, and the mismatched-PUT test that exposed this asserts the 403.

First execution of guardrail 7, against this change set: with no shell-sourced environment, `npm run dev` ran the production entrypoint - `predev` created/kept `.env.local`, `node --env-file` loaded it, object storage resolved to the docker-compose MinIO default and ensured its bucket, "Kept API listening on port 3000" - and a real `GET /api/me` answered `{"error":{"code":"unauthorized",...}}`, the correct envelope for a sessionless request. Suites after all changes: server 119 tests green (`tsc --noEmit` clean), iOS 51 tests green.

One operational note for future device runs: the integration tests reset the same docker-compose Postgres the dev server uses, so running `npm test` wipes any real signed-in user and claimed data - re-run `db:seed`, sign in, and `db:claim` afterwards. Known tradeoff of the shared local database, recorded rather than changed.
