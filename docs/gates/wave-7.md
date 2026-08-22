# Wave-7 gate report

2026-08-21.
Scope: the web client (spec §7A, §6A's web consequences) and the two server
seams it needed - a second Apple audience and exact-origin CORS. Nothing
deployed; production untouched except reads of nothing (no production call
was made at all this wave).

**Suites:** server **365** green / 40 files (was 349/37; this session added
the verifier, CORS, restore-check and log-hygiene tests), `tsc --noEmit` clean.
Web (new): **25** green / 4 files, `tsc --noEmit` clean, production build
clean. iOS untouched and not re-run - no file under `ios/` changed.
**Guardrail 7:** `npm run dev` from the real entrypoint, `.env.local`
loaded: boot printed the storage check, the new `Web client CORS: allowing
origin ...` line, `Kept API listening on port 3000`; a real preflight
answered 204 with the exact origin echoed; `GET /api/me` → 401 with
`no-store`; SIGTERM drained to exit 0 and freed the port.

---

## 1 · What was built

### 1.1 The server seams

- **`createAppleIdentityVerifier` takes a set of client ids.** Web Sign in
  with Apple mints identity tokens against a Services ID, not the bundle
  id; one verifier accepts either, and with `APPLE_WEB_CLIENT_ID` unset -
  today's production - it verifies exactly the iOS audience, unchanged. The
  audience logic is proven against locally-generated RSA keys
  (`tests/unit/appleVerifier.test.ts`): both real audiences pass, a foreign
  audience and the web audience-when-unconfigured are refused, wrong issuer
  and wrong signature stay refused, and an empty id list refuses
  construction rather than verifying nothing.
- **Exact-origin CORS** (`webOrigins` in app deps, `WEB_ORIGIN` in the
  entrypoint): only configured origins are answered, nothing is reflected,
  no credentials are granted (the web client uses the same bearer header
  iOS does), and no configuration means no CORS surface at all - pinned by
  test, with origin reflection dying by mutation. Below the edge secret
  deliberately: a preflight must arrive through Cloudflare like any other
  request.
- **`npm run dev:session-token`** mints a local session for the web dev
  loop. Not the bypass the verifier forbids: it signs with the
  `SESSION_JWT_SECRET` the dev server itself reads from `.env.local`, so it
  wields an authority the operator already holds; it refuses
  `NODE_ENV=production` and non-local databases, and its users live in a
  `dev:` apple_sub namespace no real Apple subject occupies.

### 1.2 The client (`web/`)

Vite + React + TypeScript (strict), two runtime dependencies, built
statically for Cloudflare Pages per §7A. The five surfaces:

1. **Sign-in** - Apple's JS against the Services ID in production builds; a
   paste-the-dev-token entry in dev builds only. Checked wave-6 style
   against the artifact: the production bundle carries `Sign in with Apple`
   and Apple's script URL (the controls), and zero instances of the dev
   entry's strings or `localhost:3000`.
2. **Table** - filters (date range, business/personal, status, free text
   over vendor/category/notes), keyset "load more", inline editing per cell
   (PATCH of exactly the changed field), pending-count badge on the confirm
   queue button.
3. **Detail** - image full-size beside every field (PDF in a frame, images
   as images, decided by the issued key's extension); one-PATCH save of
   what changed; two-step inline delete, never `window.confirm`.
4. **Confirm queue** (§6A) - next-pending as a repeatable action, prefilled
   by the §7.3 display rule exactly as iOS renders it (suggestion over row
   copy; the served merge, never a client-side one), date-disagreement
   warning, skip-for-now, and the server's own refusals surfaced verbatim.
5. **Upload** (§6A) and **Export** (§8) - below, since each carries a
   ruling.

Client-side money is strings and integers end to end (`money.ts`):
formatting divides only multiples of 100, parsing is textual ("3.5" is 350
because the person wrote tenths of a dollar), and unparseable input refuses
rather than rounds. 25 unit tests over money, query assembly, the upload
outcomes, and the prefill/patch rules.

### 1.3 Upload semantics, stated

- **Business-or-personal is chosen per batch, before anything uploads**,
  with no preselected value: the drop is the §6A capture moment
  (constraint 3), and `is_business` has no default at any layer (§5.2) -
  the dropzone stays disabled until the person chooses.
- **The purchase date is the upload day**, the same capture-day fallback
  the iOS confirm screen uses when OCR reads no date, and the UI says so
  ("correct it when you confirm"). Constraint 2 guards it: the receipt is
  pending until a person confirms every field while looking at the image.
- **A 409 `duplicate_image` is reported as "already uploaded", never as
  saved** - round 4 §2.2's forward constraint, honoured and pinned by unit
  test. Observed at the gate: dropping the same PDF twice showed "3 of 4
  became receipts" with the duplicate named as itself.
- No OCR runs on web uploads, so these receipts carry no suggestions and
  the LLM sweep never sees them (it parses stored OCR text, which does not
  exist here) - the confirm queue is where their fields get typed in. This
  is §6A's "narrower than it sounds", kept narrow.

## 2 · Prediction versus reality

Predictions written to scratch before any server or browser was started
(`wave7-predictions.md`).

- **Predicted:** dev sign-in → empty table, disabled queue button.
  **Reality: exactly that.**
- **Predicted:** 3 files → 3 pending receipts; the re-dropped PDF reports
  duplicate, not a fourth receipt. **Reality: "3 of 4 became receipts",
  duplicate line verbatim.**
- **Predicted:** confirming with `isBusiness` set but no total fails with
  the server's own sentence. **Reality: "a confirmed receipt requires a
  total", rendered in the queue's error line.**
- **Predicted:** the export completes, the zip carries XLSX + CSV +
  `images/` with 3 files, every `image_filename` resolves. **Reality: all
  of it - and the three files in `images/` hash byte-identically to the
  fixture digests recorded before upload**, which is the strongest form of
  "the images arrived": browser → presigned PUT → MinIO → export zip with
  not one byte changed.
- **Predicted as the likeliest failure:** the browser's cross-origin PUT to
  presigned storage URLs stalls on CORS. **Reality: MinIO's permissive
  default allowed it - but the risk is real for R2**, which answers
  cross-origin PUTs only with an explicit bucket CORS rule. That became
  step 3 of the deploy list rather than a production incident (§4).
- **Unpredicted:** the Vite dev ports 5173 *and* 5174 were occupied by an
  unrelated project's dev server; the gate ran on 5175 with `WEB_ORIGIN`
  set explicitly - which exercised the override path the deployed
  configuration will actually use, and validated `strictPort` as the right
  call (a silently-moved port would have surfaced as a phantom CORS bug).

## 3 · The gate scenario (§9 wave 7), run in a real browser

Playwright-driven Chromium against `npm run dev` (server) and the Vite dev
server; dev database and MinIO, both starting empty.

1. Signed in with a `dev:session-token` token; empty state rendered.
2. Uploaded 2 generated receipt-shaped PNGs and 1 valid PDF as Business;
   re-dropped the PDF for the duplicate leg.
3. Confirm queue: refusal leg first (no total → the server's sentence),
   then all three confirmed with typed vendors/amounts/dates, one
   corrected to Personal at confirm.
4. Table: search `business` matched exactly the one vendor; the Personal
   filter matched exactly the one receipt; an inline vendor edit
   ("MedShop Pharmacy Inc") was read back **from Postgres**, not from the
   screen.
5. **Export from the browser:** fiscal year 2026 → job `complete` in
   seconds → the zip downloaded via its presigned URL → `receipts-2026.xlsx`
   opened (exceljs) and every row matched the confirmed values, HST its own
   column beside the GST/HST number (constraint 1) → all three
   `image_filename` cells resolve → all three image files re-hash to the
   exact digests of the fixtures. CSV byte-checked alongside.
6. All three rows clicked through to their images: two PNGs rendered as
   images (400×600 confirmed loaded), the PDF in its frame.
7. Postgres inspected directly throughout: 3 confirmed rows, integer
   cents, `is_business` t/t/f, 3 live image rows with distinct hashes.

Browser console after the whole pass: exactly three errors, each one a
deliberate leg (a favicon 404 - fixed since, inline SVG; the duplicate
409; the refusal 400). Nothing unexplained.

## 4 · What only the owner can do (production enablement, in order)

The full commands live in `web/README.md`; the list:

1. Apple Services ID `com.arthurzhang.kept.web` with domain verification
   for `keptapp.net` (portal; no credential on this machine can).
2. `fly secrets set APPLE_WEB_CLIENT_ID=... WEB_ORIGIN=https://keptapp.net`.
3. **The R2 CORS rule on bucket `kept`** (origin `https://keptapp.net`,
   PUT + GET, header Content-Type) - without it every web upload fails its
   preflight while iOS keeps working, the gap §2's prediction caught.
4. Fill the privacy page's contact address, `npm run build`, upload
   `web/dist` to Cloudflare Pages, custom domain `keptapp.net` - which is
   also wave-6 step 18's privacy-URL prerequisite, so one deploy serves
   both.
5. Sign in from the deployed page and run one real export - the production
   half of this gate, impossible before 1-4.

*Correction, 2026-08-21 (same evening, on the owner's instruction): steps 2
and 3 are done, and step 2 grew the deploy it implied. The wave-7 server
shipped to production as machine version 4 - image verified locally the
§1.2 way first (boot against dev services, 401 + `no-store`, health,
exact-origin CORS with a hostile-origin control), then `fly deploy`, then
both secrets set. Verified against production: `fly status` version 4 with
its check passing, the boot log printing `Web client CORS: allowing origin
https://keptapp.net`, a preflight through Cloudflare answering 204 with
exactly that origin, a hostile origin receiving no CORS headers, `/api/me`
still 401 + `no-store`, and the naked fly.dev origin still 403. The R2 rule
(`web-client-keptapp-net`) was written through the API, read back, and
falsified live: R2 answers the keptapp.net preflight 204 with the exact
grant and gives any other origin nothing. Steps 1, 4 and 5 remain the owner's;
step 1's domain-verification leg may additionally wait on step 4 if Apple
asks for a hosted verification file.*

*Correction, 2026-08-21 (later the same evening, via a browser session in
The owner's signed-in Apple portal): step 1 is done. The Services ID
`com.arthurzhang.kept.web` ("Kept web") exists with Sign in with Apple
enabled, grouped with primary App ID `<team-id>.com.arthurzhang.kept`,
domain `keptapp.net` and return URL `https://keptapp.net/` - verified by
re-opening the identifier fresh after the save and reading the stored
configuration back, not by trusting the flow's own confirmation screen.
Apple asked for no domain-verification file, so step 1 does not wait on
step 4. In the same session the updated Program License Agreement was
verified accepted (Agreements card: "Issued August 18, 2026. Accepted
August 21, 2026"), which clears wave-6 step 18's first gate. Remaining:
steps 4 and 5 - both behind the privacy page's contact address.*

*Correction, 2026-08-22 (ship day): step 4 is done. The owner ruled the
identity linkage acceptable, so the contact address is his own email; the
build gained `_headers` (a strict-script CSP - the pre-ship security pass,
`docs/security/pass-2026-08-22.md`, has the policy and its one deliberate
weakening) and went to Cloudflare Pages as project `keptapp-web` with the
apex CNAME (the `api` records untouched, listed before writing). Verified
live: the app and `/privacy` both serve from `https://keptapp.net`, the
Apple sign-in button loads Apple's JS under the CSP and opens the real
popup carrying `client_id=com.arthurzhang.kept.web`, and the contact
address renders through Cloudflare's email obfuscation. Step 5 - a person
signing in from the deployed page and running an export - is the one leg
left, and it needs Apple credentials nothing automated may enter.*

## 5 · What I could not verify, and what it would take

- **Sign in with Apple against real Apple, from a browser.** The Services
  ID does not exist. The verifier's audience logic is proven with local
  keys; Apple's half is decided the day step 1 above lands.
- **R2's answer to a browser's preflighted PUT.** Measured on MinIO only;
  the R2 rule is written into the deploy list precisely because the two
  differ.
- **The web client against production data shapes** - production holds
  zero receipts either way.
- **The 30-day expired and the stale export statuses** - both need time or
  a killed process; the client renders them from the same field as the
  states that were observed, and the server's computation was pinned at
  wave 2.

## 6 · Anti-pattern self-review (framework §10.2)

- **Duplication:** the detail form and confirm queue share one field grid,
  one draft→patch translation, one prefill rule (`ReceiptForm.tsx`);
  the table's inline cells stay separate deliberately - a cell that saves
  on blur and a form that saves on submit are different affordances, not
  copies.
- **Error-masking:** every catch in the client surfaces the message into
  visible state or returns a typed outcome; the three storage-layer
  try/catches in `session.ts` are the one deliberate silence (an
  unavailable localStorage degrades to signed-out, stated in a comment).
  Server-side, nothing new swallows: the CORS layer refuses by omission of
  headers, which is the mechanism, not a mask.
- **Tests written to pass:** the CORS reflection mutation was run (kills
  exactly the unconfigured-origin test); the bundle checks carry positive
  controls (the probe strings exist in source, the production affordances
  exist in the bundle) per wave 6's stub-binary lesson.
- **Speculative generality:** no router, no state library, no component
  framework beyond React itself; `webOrigins` is a list only because
  dev-plus-production is already two.

## 7 · State of the wave

Built, tested, and gated end to end against local dev: **the §9 wave-7
scenario ran in a real browser and every artifact - the zip, the XLSX, the
CSV, the image bytes, the database rows - was opened and matched
prediction.** The wave is not closed as *shipped*: §4's five steps are
The owner's, ending with the same export run against the deployed site. The
spec's deadline stands satisfied on the build side - export lives on the
web now, before the first year-end use.
