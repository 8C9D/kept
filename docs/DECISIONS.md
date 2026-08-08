# Decisions

Append-only.
One dated entry per decision: what was decided, what was rejected, and why.
Ordered newest-first by decision date: a new entry is inserted at the top, never at the bottom, and a late-reconstructed entry files under the date the decision was made, not the date it was written.

## 2026-08-08 - Pending receipts render the served merge on every screen

**On a pending receipt, the Home list row and the receipt detail screen render the §7.3 merge by the confirm screen's prefill rule: a served suggestion outranks the row's copy of the field, and the row fills only fields no suggestion covers.**
The defect (same-day device pass): one receipt read two different ways depending on the screen - the confirm form rendered the merge's "Food Basics" and corrected date while the list row and detail screen rendered the row's "Basics", the bare tax number, and a misparsed 2011 date - so the merge's corrections were invisible outside the confirm screen.
This applies the ruling the confirm screen already established (the entry below) rather than adding a new branch: a pending row's stored values are the capture-time heuristic snapshot, and the served merge supersedes them.
**A confirmed receipt renders its row everywhere; the merge never overrides a confirmed value.**
Confirmed receipts are still swept and still served suggestions - only `parse-accuracy` consumes those.
Rejected: rendering the merge on confirmed receipts too - the row holds what a human confirmed, and constraint 2 makes that the record.
The selection lives once, in a `Receipt` extension (`ReceiptDisplay.swift`) shared by both screens and pinned by unit test; fields the merge does not cover (other tax, business/personal, category, payment, notes) always render the row.
**Checked, both stay: the detail screen's "Not recorded" and the confirm form's "Not found".**
They are two components in two contexts - the detail screen states what Kept has for a field, while the form's placeholder sits exactly where typing the missing value is the remedy - but the stored-vs-parsed distinction is carried by the components' contexts, not stated by any rule in the code; recorded here so it is a decision rather than an accident.
⚠ Test honesty (§10.2): the extension's selection is pinned by unit test, but the views reading `display*` instead of the raw fields is SwiftUI body content no unit test executes - reverting a row to `receipt.vendor` would stay green.
The device pass is the real evidence, exactly as it was for the confirm screen's own rendering.

## 2026-08-08 - iOS confirm screen renders the served merge

**The confirm screen now renders the `suggestions` field the API serves - the §7.3 merge - and no longer reads the detail route's raw `ocrSuggestions`, which stays in the response for the shipped client.**
The suggestion set is the injected thing: one form serves all three routes (queue, detail, capture-time), each construction handing it the set that exists for it - the server merge for a stored receipt, the on-device parse alone for a capture-time confirm, where no server row and therefore no merge or disagreement flag can exist.
Rejected: a branch inside the view deciding which record to read - a form that knows its routes is how one screen becomes three.

**Where a served suggestion and the row's copy of a field both exist, the suggestion wins the prefill; a value only on the row prefills without amber.**
The row's field values on a pending receipt are the capture-time heuristic snapshot, and the served merge supersedes them (the LLM's "Food Basics" over the row's "Basics"); rendering the row copy would un-take the merge decision client-side.
A value only on the row was written by something other than a parser, so it is not a machine suggestion and carries no amber; rows with no suggestion set at all (neither parser ever saw them) keep the value-presence proxy.

**On a date disagreement the field keeps its amber and carries an inline note; the note gets the arithmetic warning's exact treatment.**
Same amber, inside the field, never red - a prompt to look, not a rule - and touching the field clears the tint and the note together, because touched means a human looked and decided.
Rejected: a separate dismissal or any persistence for the note - the marking's whole design is "touching clears it", and a second mechanism would make the screen noisier for a signal that only ever asks for one look.

**Provenance is not shown in the UI.**
The amber already means unverified; a source badge would ask the user to adjudicate parser internals and make a screen designed to start loud and go quiet noisier.
The client deliberately does not even decode the per-field `source` marker - provenance stays in the API for diagnostics.

**A money field the merge serves absent prefills empty, so the form's "Not found" placeholder states the absence** - checked against the served `{value: null, source: null}` shape by decode test, per §10A.1's stated-absence rule and §7.3's no-fallthrough amendment.

## 2026-08-08 - Merge correction (the owner): money fields have no fallthrough

**For the money fields - total, subtotal, HST - the heuristic is the only source the merge serves: if the heuristic has no value, the field is absent, never filled from `llm_suggestions`.**
Fallthrough is unchanged for vendor, tax number and date.
Rejected: the fallthrough semantic the wiring shipped (the entry below), under which a heuristic-absent amount was served from the LLM with `llm` provenance.
Why the original ruling did not cover this: "amounts from the heuristic" rested on both paths scoring 100% on money, which only covers cases where both produced a value and says nothing about the LLM on amounts the heuristic misses - exactly when fallthrough fires.
The first wild instance, on clean input, was a digit transposition: "SUBTOTAL 43.49" parsed as 3449 cents and served with `llm` provenance, because the heuristic found no subtotal to outrank it (the live-run evidence in the entry below).
§7.2's arithmetic check is only a partial net: it needs all three of subtotal, HST and total present, so a receipt missing two of them gets no check at all.
An absent amount is visible and costs one keystroke; a wrong amount that passes unflagged reaches an accountant.
**The LLM's money values still get stored in `llm_suggestions` - this changes what the merge serves, not what is recorded - and `parse-accuracy` keeps scoring them, since that comparison is how this ruling gets revisited on more data.**
Checked at the time of the change, data untouched: two receipts in the dev database carried an llm-sourced amount through the merge, both synthetic-user rows, one of them the soft-deleted 3449 receipt itself; no real-user receipt was affected.

## 2026-08-08 - LLM parse wired in: sweep + domain-layer merge

**The server-side parse runs as a sweep over rows, kicked at startup, after captures, and on a long interval - not inline in the create route.**
Rejected: parsing inside the create request - a restart would lose an in-flight parse, and a model outage or slow response would block or fail a capture, breaking the success test.
The row itself is the job state (`ocr_raw_text` present, `llm_suggestions` null), the same reasoning as export jobs being rows rather than process memory; the null-only guarded UPDATE makes concurrent sweeps idempotent, with the losing writer counting the row superseded.

**Confirmed receipts are swept too.**
A confirmed receipt cannot benefit from suggestions, but its parse grows the accuracy set - which is what the merge rule's n=5 caveat needs before it can be treated as settled.

**The merge is a pure function in the domain layer, served on every receipt response with per-field provenance and the date-disagreement flag; clients render, never decide.**
Rejected: merging in the client - §4.1's rule exists because a rule implemented in Swift is a rule written twice once the web client lands.
Two semantics settled beyond the ruled merge: when the ruled source found nothing for a field, the other side's value is served with its provenance stated (a rejectable suggestion beats an empty field, and constraint 2 makes that safe); on a date disagreement the heuristic's value is the prefill because it is the deterministic side - the flag, not the prefill choice, carries the signal.

**`ANTHROPIC_API_KEY` is required at production boot; a runtime model failure degrades to heuristic-only.**
A missing key in production is silent feature loss, so `productionEnv.ts` refuses to start; a missing key in dev disables the sweep with a stated line; a failing API call at runtime leaves the row null for a later sweep and never touches the capture path.

**The retry is capped: after 3 failed attempts the sweep writes an explicit failure record into `llm_suggestions` - model, promptVersion, requestedAt of the final attempt, the error, the attempt count, and `suggestions: null`.**
Rejected: unbounded retry - every attempt bills the API, and with kicks on every capture plus the interval, a receipt whose text persistently fails validation re-bills forever; fine at six receipts, a real leak once the backlog lands.
Rejected: capping in memory alone - the failure would live only in a log, invisible in the data, and the row would re-bill up to the cap again on every restart with nothing ever recording that the model cannot parse it.
The record is what stops the null-guard re-selecting the row, and it makes the failure a queryable fact; `parse-accuracy` scores it as "the LLM produced nothing" (missed / absent-right per field), deliberately distinct from a receipt the LLM was never run on, which carries no record and never enters the LLM table.
Attempts are counted per process; the backfill's single manual pass carries no counter and never abandons - it exits loudly instead.
Re-parsing an abandoned row means clearing the column by hand, a deliberate act.

**Evidence from the live verification run, recorded rather than footnoted: the model misread a printed subtotal of 43.49 as 3449 cents.**
The wiring run against the real dev server and the real API (create 201 in 63 ms, sweep record landed seconds later) included a receipt whose text printed "SUBTOTAL 43.49"; the parse returned 3449 - a plausible off-by-transposition, served with `llm` provenance because the heuristic had no subtotal to outrank it.
That is the probe's "fails plausibly where the heuristic fails visibly" caveat occurring in the wild, unprompted, on clean input - not under a deliberately degraded probe.
It is why every LLM-sourced value stays amber until touched with no trust shortcut, and it goes in this log as evidence for the next reading of the accuracy table.

**`parse-llm-backfill` stays, as a thin wrapper over the sweep core, guard intact.**
Rejected: deleting it - running one loud, exit-coded parse pass from a laptop without starting a server is still useful (a claimed or seeded local database).
Rejected: dropping its `assertLocalDatabase` guard - production's parsing is now the server's own job, so the script has even less reason to aim at production, not more.
Its old "refuse loudly when the column is already set" behaviour is retired: with two legitimate writers, a superseded row is a counted outcome, not a design breach.

## 2026-08-08 - DECISIONS ordering (the owner): newest-first by decision date

**This file is ordered newest-first by decision date: a new entry is inserted at the top, never at the bottom, and a late-reconstructed entry files under the date the decision was made, not the date it was written.**
Within a day, newer decisions sit above older ones; "append-only" continues to govern content - entries are never rewritten or removed - not position.
The rule is stated in the file header, mirrored in `CLAUDE.md` beside the doc-ownership rule, and the whole file was reordered to match (commit 9b138c0), every entry's wording preserved except the founding entry's positional cross-references, which now name the entries they point at.
Rejected: **the status quo it replaces - three regimes and no stated rule** (newest-first from the top down through the Aug 5 Wave-0 gate entry, oldest-first through the remaining Aug 5 wave entries, and the four LLM entries appended at the very bottom, out of order among themselves).
Rejected: **oldest-first throughout** - the most recent decision is the one a reader needs first, and the file is read far more often than it is written.
Why the stated home matters: a convention with no stated home means whichever end of the file you look at is the convention, which is how the four LLM entries ended up at the bottom with the Aug 7 founding entry filed after the Aug 8 merge rule it precedes.

## 2026-08-08 - Doc ownership: a DECISIONS entry and its spec amendment land in the same commit

**Standing rule, now in `CLAUDE.md`: when a decision is appended to this file, `docs/Kept-Build-Spec.md` is amended in the same commit.**
`DECISIONS.md` is the append-only log of how we got here; the spec is the current state.
Neither is optional and neither substitutes for the other.
**The failure mode it exists to prevent just happened:** the Aug 7-8 LLM-parse decisions reached this log while the spec went on describing the Textract / Document AI upgrade path - a path not taken - for three days, because the prompts said "append a DECISIONS entry" without saying "amend the spec".
A prompt that names only the log must still produce both.
The catch-up is commit 3093bd6 (§4.2, §4.3, §5, §7.2, §7.3, §10A.1 amended, update-log entry added); this entry's own spec reflection is the §10.1 bullet added alongside it.

## 2026-08-08 - LLM merge rule (the owner)

**Prompt v2: the verbatim-vendor rule lives in the vendor field's schema description, with branch and store numbers, addresses, and phone numbers excluded.**
Rejected: the first draft's placement in the shared system prompt, and its "including store numbers" wording, which folded "Store #1234" into the Food Basics vendor.
Why: scoped to the one field that transcribes, the rule went 15/15 against confirmed vendors in the n=3 reparse; the stored v1 records stay untouched and distinguishable by their absent promptVersion field.

**The merge rule, decided on the n=3 evidence.**
Amounts come from the heuristic: both paths scored 100% on the money fields, and the heuristic is free, offline, and deterministic.
Vendor and tax number come from the LLM: 15/15 vendor matches under prompt v2, and 100% against the heuristics' 80% on tax number.
Date trusts neither source alone: the heuristic is deterministically wrong on an ambiguous DateTime line, and the LLM is wrong on roughly 1 of 3 runs over the same line.
When the two disagree on date, the confirm screen keeps the field amber and marks it as needing attention - disagreement between two independent parsers over the same text is free signal, and this is the field that decides the fiscal year.
All LLM-sourced values stay amber until touched; no trust shortcut.

**Re-attribution, recorded honestly: yesterday's date regression was first read as a prompt effect, and the n=3 run shows it is nondeterminism.**
The revised prompt - with the vendor rule scoped out of the system prompt entirely - still produced 2011-07-26 on one of three runs, so the v1 backfill's correct date was partly luck, not a property of the old prompt.

⚠ All of this rests on 5 receipts from 2 vendors. Provisional; re-run parse-accuracy after weeks of real use before treating any of it as settled.

## 2026-08-07 - First real LLM parse run (the owner)

**The LLM backfill's first real Anthropic API run: 6/6 receipts parsed by claude-haiku-4-5 against the dev database, 5,281 input and 332 output tokens, $0.0069 total.**
No request errored and no parse came back all-null.
One came close: the Synthetic Vendor Two receipt returned only a total, which is consistent with its sparse synthetic text rather than a pipeline fault.

**The accuracy listing's headline is a regression, not a win: on the vendor field the LLM scored 40% against the heuristics' 80%.**
On three of the four Noodle House receipts the heuristic kept the confirmed "Noodle House (BCE)" while the LLM dropped the "(BCE)" suffix - cases where the heuristics were right and the LLM is wrong.
The LLM won every Food Basics disagreement (vendor "Basics" vs "Food Basics", the garbled date 2011-07-26 vs 2026-07-11, the missing R prefix on the tax number), and both paths were perfect on the money fields.
The provisional warning is showing: 5 receipts from 2 vendors cannot distinguish a good model from a lucky one, so the spec's §7.3 upgrade question stays open until a re-run after real use.

**`npm run parse-llm-probe` (a one-off script, deliberately not a test) showed the pipeline's output tracks the raw text and nothing else.**
A digit-rotated copy of the Food Basics receipt's ocr_raw_text moved 5 of 6 fields (date, total, subtotal, HST, tax number); vendor stayed put because the corruption touches only digits.
Rejected: making it a CI test - it costs money and is nondeterministic, so it runs once and its outcome is recorded here instead.
Limitation: this is a one-shot manual check on one receipt, not a standing guarantee; nothing re-verifies the property as the pipeline changes.
⚠ On deliberately corrupted input the model returned a plausible invented date (2022-03-18) from an invalid string rather than null, and misread a scrambled amount by one digit.
That is the honest limit of this path: on degraded input the LLM fails plausibly where the heuristic fails visibly.
Design consequence for the server-parse step: LLM-sourced values stay amber until touched, with no trust shortcut.

## 2026-08-07 - The LLM parse path (the owner) - founding entry, reconstructed 2026-08-08

Recorded a day late: this decision produced the code in commits 62699f2 and 3034356 and predates the "First real LLM parse run" and "LLM merge rule" entries, but was never logged - the gap the 2026-08-08 doc-ownership entry exists to prevent.
Sourced from that code and from the two entries that do exist; anything not recoverable from them is marked unrecorded rather than inferred.

**Decided: a second parser, server-side - Claude Haiku 4.5 over the stored `ocr_raw_text`, text only, writing an immutable `llm_suggestions` record beside `ocr_suggestions`.**
The on-device heuristics stay; the LLM augments rather than replaces, and `npm run parse-accuracy` scores the two paths separately against what the human confirmed.
**The model only ever sees `ocr_raw_text` - never a field a person typed** (the owner's ruling, stated as such in the code): the request is built by a pure function whose one input is the raw text, so a builder taking the whole receipt row would put the ruling one refactor away from silently false, and a test asserts what leaves the building.
Every schema field is required and nullable - null is the stated "not printed on this receipt", and an absent key would be indistinguishable from a forgotten one.
The reply is validated before anything stores it: structured outputs guarantee the shape, but the values still cross a trust boundary - a non-calendar date or an unstorable amount is refused loudly, never quietly corrected.
The system prompt states Canadian-receipt domain facts (HST/GST are one CRA program; cross-check multiply-printed dates; tax numbers carry letter prefixes), not step-by-step heuristics - the model's judgment over the text is the point, and the on-device heuristics already do rule-following.

Rejected: **a vision model over the receipt image.**
The recoverable reason is the standing constraint rather than a model comparison: the image never leaves the phone, so the server has only the text to parse (§4.3's resolution note states this as why the image-parsing products stayed rejected at upgrade time).
Whether a vision parse was also weighed on accuracy or cost is unrecorded.
Rejected: **an on-device LLM.**
Why is unrecorded - nothing in the code or the existing entries states the reasoning.
Rejected: **the cloud expense parsers §7.3 had named as the upgrade path (AWS Textract AnalyzeExpense, Google Document AI, Azure Document Intelligence).**
They parse the image server-side, which the same image-never-leaves-the-phone constraint rules out; §7.3's original objection also stands, because on-device Vision remains the only OCR and capture stays instant and offline.

**Why Haiku 4.5:** the task is structured extraction over roughly 30 lines of text, and the accuracy table arbitrates whether a larger model is ever warranted - not taste.
The cost estimate the code carried at decision time ("roughly a quarter of a cent per receipt") measured at about 0.12¢ on the first real run ($0.0069 across 6 receipts, entry above); the comment now carries the measured figure.
Whether other providers or model tiers were compared before settling on Haiku is unrecorded.

**Why the backfill ran before the server-side parse:** sequenced deliberately so `parse-accuracy` could score the model against already-confirmed receipts before anything ships to a client.
The backfill is local-database-only under the same guard as `db:seed` and `db:claim` - not because it deletes anything, but because it sends receipt text to an external API and writes to tax records, and pointing it at production should be a decision someone makes deliberately, not a `DATABASE_URL` that happened to be exported.
Constraint 2 is untouched by any of this: the LLM adds suggestions, never confirmations.

## 2026-08-07 - Secret-exposure audit: nothing leaked, and the ignore rule is the load-bearing control

Audited the full history for committed secrets: the repo has no git remote, no env file was ever committed on any ref including unreachable objects, and every credential-shaped value in history resolves to a test fixture, a documentation placeholder, or the by-design local dev password.
The ignore rule predates the file it protects: `.env.local` was in the Wave 0 skeleton's `.gitignore`, two hours before `server/.env.local` first existed.
Verdict: no credential in this repo is to be treated as leaked, and nothing was rotated.
**A gitleaks pre-commit hook now guards commits, tracked in `.githooks/` and wired via `git config core.hooksPath .githooks` (Runbook §0), falsified in both directions.**
⚠ Stated rather than smoothed over: gitleaks' protection is shape-based, so it covers `ANTHROPIC_API_KEY` well and opaque secrets like `SESSION_SECRET` only weakly - a fake key missing the real format's exact tail sailed through until the shape matched.
The ignore rule, not the hook, is the load-bearing control.

## 2026-08-07 - Wave 6: the deployment exists as configuration, and the backup is tested

Recorded as one entry because the pieces depend on each other: the privacy label could not be written until the deployment named where data goes, and the rate limiter could not be shaped until something sat in front of the origin.
**Nothing was deployed and nothing was submitted to Apple.** No secret was seen, generated, stored or printed.

**A shipped build reaches exactly one address, and cannot be redirected. `ServerConfig` splits into a `ServerEnvironment`: production is `https://api.keptapp.net` and does not read the stored override at all; development keeps `http://localhost:3000` and the settings sheet.**
Rejected: **keeping the settings sheet in Release** (the owner's ruling, and the reasoning generalizes now that the ATS exception is gone: an `http://` address can no longer carry cleartext, so what remains is *redirection* - a control on every installed phone that sends the session bearer token, and every request made with it, to an address of the holder's choosing, under a link anyone can install from).
Rejected: **a build setting or `.xcconfig` holding the URL** - making the production address configurable is precisely what must not be true of it.
Rejected: **`#if DEBUG` at each call site** in favour of one compile-time branch in `ServerEnvironment.current`, so both environments stay exercisable from a test build - which is always the Debug one.
Cost taken knowingly: moving the API to another host now needs an app update.
⚠ Stated rather than smoothed over: `localhost:3000` still appears twice in the Release binary, as the development case's literal and as an example inside an error message. Both are dead - nothing in Release constructs `.development`, and the message's only caller is compiled out - and fencing the enum case would spread conditional compilation through a switch to delete a string, the same trade the `INFOPLIST_PREPROCESS` ruling already rejected. **A string constant is not an affordance**, but the honest claim is "no reachable path to localhost", not "no localhost in the binary".

**The origin refuses to serve unless Cloudflare put it there: `EDGE_SHARED_SECRET` in an `x-kept-edge-secret` header, compared in constant time ahead of every route.**
Rejected: **relying on the edge alone** - Fly gives every app a public `*.fly.dev` hostname, so §10B's rate limiter at the edge would guard one door of a two-door building, and a limiter that can be walked around is the decorative-control pattern this project caught at wave 3.
Rejected: **requiring the secret** - the origin has to answer before Cloudflare can be pointed at it, so a required secret makes the first deploy impossible. Optional, with its absence a checklist step rather than a footnote.
Rejected: an IP allowlist of Cloudflare's ranges (a list that changes, maintained by nobody here).

**Production configuration is checked at startup, not at the first request that needed it (`src/productionEnv.ts`, under `NODE_ENV=production` only).**
Rejected: **letting the existing checks stand alone.** They cover missing variables; they say nothing about four configurations under which the server would happily *run* while being quietly wrong - no `STORAGE_*` at all (which silently falls back to a MinIO that does not exist on a Fly machine), a plain-http storage endpoint (presigned URLs inherit it, so receipt images cross the network in the clear - the audit's N5), a loopback `DATABASE_URL`, and a session secret too short for HS256's security argument.
Rejected: **checking everywhere** - `npm run dev` would then demand R2 credentials to serve a laptop, and the pressure to weaken the check would land on the production case. It is the mirror image of `assertLocalDatabase`: that one keeps destructive dev scripts *off* remote databases, this one keeps the server *off* local ones.
Verified by making the real Docker image refuse each one, not only by unit test.

**The Dockerfile runs `tsx` on the TypeScript, with dev dependencies installed.**
Rejected: **a compiled build step** - it produces a second code shape that exists only in production, which is framework §9.3 rule 5's exact failure and has cost this project eight times. It also keeps `drizzle-kit` on the machine, so `fly ssh console -C "npm run db:migrate"` works from where the database is reachable. At one always-on machine the startup cost is nothing.
Also decided: **`auto_stop_machines = "off"`** - a cold start on pull-to-refresh would read as the honest 10-second timeout wave 5 put in front of people; scale-to-zero saves dollars and spends the success test.

**§10B's tested backup restore has now been run, and the verifier was falsified.**
`npm run db:verify-restore` compares row counts source-vs-restored and then follows every live image row in the *restored* database out into object storage, re-hashing the bytes against the digest that row carries.
Rejected: **checking that the object key resolves** - a key that resolves proves an object is there, and only the digest proves it is the *right* object. Rejected: **restoring into the live database to check a backup**, which is a destructive test of a non-destructive property.
Run against the dev database, which holds real captured receipts and their real stored bytes: 3/9/4/0 rows, four images all re-hashing, dev database left exactly as found.
Then damaged deliberately: it reports a deleted row, a corrupted digest and a missing object, and exits 1. It also refuses when both URLs name the same database, and **refuses to report success when the restored database holds no images** - a restore verified against zero images has verified nothing, which is the vacuous-assertion shape the August audit found in the isolation suite.

**⚠ A §10B assumption that only became checkable once a provider was chosen.** §10B says "managed Postgres with point-in-time recovery", and **Neon's history window is 6 hours on the Free plan** (7 days on Launch, 30 on Scale). That answers "I ran the wrong thing twenty minutes ago"; it is **not** a six-year retention story. Retention rests on the scheduled dump, which is now a checklist item rather than an implication.

**The privacy manifest ships and the label is written out word for word.**
Six data types - other financial info, photos or videos, other user content, user ID, email address, name - **all linked to identity, none for tracking**, plus `NSPrivacyAccessedAPICategoryUserDefaults` with reason `CA92.1`.
Rejected: **declaring only the three the review named** (financial info, user content, identifiers) - the server also stores the Apple relay email and, when Apple provides it, the display name. Declaring less than is stored would be the flattering answer and the false one.

**R2's key normalization is still unmeasured, and is now one command instead of an assumption.**
`npm run storage:probe-keys` probes nine spellings against a planted victim object, with a control that proves it can observe a leak and a refusal to report anything if the control fails. Against MinIO it reproduces the audit exactly: leading slash and double leading slash serve the victim's bytes, every dot-segment spelling refused.
Rejected: **inferring R2's behaviour from MinIO's** - the audit was explicit that one normalization class already goes the opposite way, so either result would be unfounded. Nothing in the API depends on the answer: keys are matched whole on write and re-checked on read.

**A test that could not fail for the case it existed for - found by falsifying it, and the lesson is not about this test.**
`testEverySettingsScreenReferenceIsFencedOutOfReleaseBuilds` searched for `ServerSettingsView` outside a `#if DEBUG` region. Unfencing the settings *button* left it passing, because the button's line says `Button("Server settings")` and never names the type - so the falsification produced a Release build with a **visible button whose sheet is compiled out**, a dead control shipped, and the test guarding exactly that said nothing.
It now checks the user-facing label as well as the type, and its "still exists in Debug" pair does too, so neither can guard an absence.
**The general form: an assertion aimed at how a thing is *built* rather than at the thing a person *sees* tracks the author's mental model of the code - which is where the defect already is.** Second instance of the August audit's N3 in a different costume. When a test guards a user-visible property, assert the user-visible string.

**A measurement method note, on the same theme.** The first `strings` check of the Release binary read the Debug `Kept` executable as its comparison and got zero hits for a control string - that binary is a 58 KB stub, with the code in a separate `Kept.debug.dylib`. Reading the wrong file would have produced a comfortable and meaningless "nothing there". The control is what caught it, which is the same discipline the probe script now enforces on itself.

Suites: **server 214** (was 201), **iOS 194** (was 177), `tsc --noEmit` clean, zero iOS warnings; every new test falsified in both directions.
Guardrail 7 twice: the real entrypoint (no stale listener on port 3000 for the first wave in five), and the production Docker image, which answered a real 401 with `Cache-Control: no-store` and a 403 with the edge secret set and no header.

## 2026-08-07 - One live export per user, and the method note behind the memory number

**Provisioning ratified: `shared-cpu-1x` at 2 GB** (§4.2), on the measurement recorded in the previous entry.

**One live export per user, enforced by a partial unique index, and refused rather than queued.**
Rejected: **deferring it** - it was originally written up as acceptable at three users, and the owner's correction is the better reasoning: **on a fixed 2 GB ceiling the relevant number is not how many users there are, it is how many exports can overlap**, and this removes the only path that doubles peak RSS. It is also cheap right now, while the export code is loaded.
Rejected: **queueing the second request** - a queue needs a worker, a fairness rule, and a way to cancel. Refusing needs one sentence, and the client already polls the running job, so the person can press Export again when it finishes. 409 `export_already_running`.
Rejected: **a check in the handler**, which cannot be made race-free. Generation runs *after* the 202 response, so no transaction spans the thing being serialized, and Postgres takes no lock on rows that do not exist yet - two taps of Export would pass the check twice and start two generations. The invariant has to live where the state lives, so it is a partial unique index on `export_jobs (user_id) WHERE status IN ('queued','running')`, and the insert's unique violation becomes the 409 (the same `isUniqueViolation` shape wave 4 used for duplicate images). Migration `0003_one-active-export-per-user`.

**⚠ The index needed a companion, and it is not optional.**
A job whose process dies leaves its row `running` forever, and the index reads *stored* status - so on its own the constraint would convert a single crash into a permanent, silent lockout of that user's exports.
`POST /api/export` now retires jobs past the staleness windows before inserting, using the same two clocks and constants `reportedStatus` already reports `stale` with, so a client can never be told "stale, re-run it" by one rule and blocked by another.
This does write back to a row the §8 design deliberately left computed, and that is consistent rather than in tension: a job whose process died *did* fail, so the row is more truthful afterwards, not less. What changed is that the fact now has to be durable, because an index cannot read a computed status.
Both halves are tested and both were falsified: removing the reap fails the lockout test, and dropping the index makes two concurrent exports succeed.

**One pre-existing test asserted a state that is now impossible**, and was moved rather than weakened.
`reports a job stranded in running as stale on a longer clock` inserted two concurrent `running` jobs for one user to compare the two clocks. The second job now belongs to a second user: both assertions survive intact - the clock depends on a job's age and status, not on its owner - and the comparison is still needed, since a rule that called every running job stale would satisfy the first assertion alone.

**Method note, recorded because the number it produced is now sizing hardware.**
The export memory measurement could not use the project's shared `fakeObjectStorage`: it retains every uploaded object in a `Map`, so measuring against it would have counted roughly 250 MiB of the double's own retention as the export's cost and produced a figure that was mostly test harness.
It used a double that generates incompressible bytes on demand and discards uploads, which is what R2 actually does.
**This is framework §9.3 rule 5 again** - a test double diverging from production in exactly the load-bearing dimension - and the first instance where the divergence would have corrupted a *measurement* rather than a test.
That distinction is the part worth keeping: **a failing test is red, while a plausible wrong number is not**, so a double that is merely convenient becomes dangerous the moment something is provisioned from what it reports.
(Instance count: this is the eighth on Kept. The owner's note said six, which counts the five recorded before this session's two configuration assertions were added.)

## 2026-08-06 - The owner's rulings on the security review, applied

Every open finding from `docs/security/review-2026-08.md` and `docs/security/audit-2026-08.md` was ruled on and implemented.
Recorded as one entry because the rulings were made together and several depend on each other.

**Deployment target: Node on Fly.io for the origin, with Cloudflare proxying in front of it. R2 and Neon unchanged.**
Rejected: **Cloudflare Workers, which was this same day's first ruling and was reversed within the hour.**
Also rejected: a Worker origin with export generation moved to a Container or queue consumer (real work to buy a property nothing needs), and cutting the export budget to fit a 128 MB isolate (it would refuse longer periods to satisfy a platform we chose voluntarily).

**The reversal is the part worth keeping.**
The first ruling picked Workers because Hono was chosen at §4.2 partly for Workers portability, so the bet should be cashed, and because it puts the §10B rate limiter at the edge.
Writing that into the spec is what surfaced the disqualifying fact - checked against Cloudflare's documentation rather than assumed: **a Workers isolate is capped at 128 MB on both the free and paid plans, per *isolate* and shared across concurrent requests, not per request.**
`DEFAULT_EXPORT_LIMITS` is **256 MiB**, so the budget alone was double the ceiling before accounting for the zip existing twice during assembly.
**the owner's reasoning on reversing: forcing a memory-heavy export onto a 128 MB isolate was buying portability we do not need at three users.**
Cloudflare in front of a Node origin still supplies the edge rate limiter and DDoS protection that motivated the choice; only the origin's runtime changed, and `@hono/node-server`, `pg`, `archiver` and `exceljs` all stay as they are with no export rewrite.
Workers is not foreclosed - it becomes available if `buildZip` ever streams to R2 instead of buffering - but nothing needs it today.

**The export budget under a Node origin: measured, not argued.**
Predicted first, per the standing rule, and the prediction was wrong in the direction that matters, which is why it was measured.
A 250 MiB export (25 images just under the budget, against a storage double producing incompressible bytes on demand and discarding uploads, the way R2 behaves) peaked at **891 MiB RSS, 693 MiB above baseline - about 2.8x the payload**, against a prediction of roughly 2x.
The multiplier is structural: `buildZip` accumulates the archive's output chunks and then `Buffer.concat`s them, so a fully-assembled incompressible zip exists twice, alongside the image buffer in flight.
**Conclusion: the budget is sound but it sizes the machine.** Roughly 1 GB carries a single export with little margin, so **2 GB is the provision** - within `shared-cpu-1x`, since Fly's ceiling is 2 GB per shared CPU.
⚠ Nothing serializes concurrent exports, so two at once doubles this. Acceptable at three users; the first thing to revisit if that changes.
The measurement was a one-off (a 250 MiB allocation has no business in `npm test`) and is reproducible from this description.

**The Debug and Release `Info.plist` are separate files, and a test asserts it.**
Rejected: one plist with `INFOPLIST_PREPROCESS` conditionals (obscure, and a preprocessor in a plist is a worse thing to inherit than a duplicated key); and shipping the exception on the argument that `NSAllowsLocalNetworking` only relaxes local and link-local hosts (true, and still wrong - `ServerConfig` accepts any `http://` host, so a Release build would carry bearer-token traffic in cleartext to any LAN address typed into the settings sheet).
Why the test matters more than the split: this defect lived **entirely in a build setting** and no runtime test could ever have caught it.
`InfoPlistConfigurationTests` reads the source tree and `project.pbxproj` and asserts the shipping plist has no ATS keys, that Debug still has them (deleting the affordance would also make the first assertion pass), that the two files agree on every other key, and that the two configurations point at different files.
Verified by restoring the pre-fix state: all four assertions fail.
The cost taken knowingly: two files that must agree, which is what the third assertion is for.

**Outbox files write with `.completeFileProtection`, and a locked read is no longer mistaken for a lost receipt.**
Rejected: leaving the iOS default (`completeUntilFirstUserAuthentication`, which stops protecting after the first unlock following a boot - in practice, always) on files holding the vendor, tax number, every amount, the payment method, the notes, the full OCR text and the receipt image itself.
**⚠ The ruling was safe on its stated reasoning and unsafe as a literal edit, which is worth recording.**
The drain constraint is indeed unchanged - the keychain is already `WhenUnlocked`, so the drain cannot run locked.
But `FileOutboxStore.imageData` mapped *any* read failure to `OutboxMissingImageError`, which the controller treats as **permanent** and reports to the person as "the saved image could not be read back from this phone".
With complete protection, a locked read raises exactly that failure, so the edit as stated would have converted a healthy receipt on a locked phone into an unrecoverable one.
A locked read now throws `OutboxLockedError` and classifies as `.retryLater`, next to the keychain case that already had this shape.
`loadAll` fails the whole load rather than counting healthy items as unreadable, which keeps `hasLoadedOnce` false so the next foreground retries.
Tested with a scripted locked read asserting `waitingToRetry`.
Unverifiable, stated as a limit: the simulator does not enforce data protection, so the protection class is asserted as configuration (framework §9.3 rule 5, sixth instance).

**`renderError` strips database detail unconditionally, and so does anything that stores an error message.**
Rejected: keeping the raw log for diagnostic power now that the int4 bound removed the trigger.
Why: the bound removed *a* trigger, not the class - any future failed query prints the same way, and the error monitor §10B plans is what turns a terminal on the owner's Mac into an exfiltration path.
**⚠ The review's own recommended fix would not have worked, which is the useful part.**
It proposed logging `error.message` and the constructor name instead of the object.
But `DrizzleQueryError`'s constructor builds its message as `` `Failed query: ${query}\nparams: ${params}` `` - the bound parameters are **inside `error.message`**, not merely on a side property, and they are in `error.stack` too, whose first line is name + message.
So redaction had to be structural rather than textual: an error carrying any database-error marker is described by its schema-identifying fields alone (`code`, `constraint`, `table`, ...), never its message, stack or properties.
Our own errors keep their message and frames, because that text is ours.
**Found while implementing, and fixed under the same ruling:** `runExportJob` stored `error.message` in `export_jobs.error`, which `GET /api/export/:id` **returns to the client** and the export screen renders.
A failed query there would have handed a client the SQL and its bound parameters.
That column is now redacted too, with the over-redaction direction tested - the size-limit message, which is written to be read by the person who hit it, still passes through.

**`db:seed` and `db:claim` refuse any database that is not on this machine.**
Rejected: guarding only `db:seed` (both rewrite tax records, and `db:claim` was already being edited); and comparing against a known dev URL rather than requiring loopback (the deployment target is Neon, whose hostnames are remote by construction, so loopback-only cannot be argued with in the moment someone exports a `DATABASE_URL` to try something).
A `.local` mDNS name is refused too: it names *a* machine on the network, not necessarily this one.
The URL-identity helpers moved to `src/db/databaseUrl.ts` and wave 4's `assertSeparateTestDatabase` now shares them rather than keeping a second copy of the same parsing.
Verified on the real script, not only in unit tests: `DATABASE_URL=<neon-shaped> npm run db:seed` throws at module load, before the pool is constructed, and exits 1.

**`db:claim` refuses receipts that carry image rows.**
Rejected: rewriting `object_key` to the new owner's prefix - the bytes in storage stay at the old key, so the row would point at an object that does not exist, which is a quiet wrong answer in place of a loud refusal.
Why refusing costs nothing: seed data creates no image rows at all, so this refuses nothing the script is used for.
It closes the state the audit reached by hand - a receipt owned by one user whose image key names another.

**`cents()` is narrowed to the int4 range; the test that asserted otherwise is replaced, not deleted.**
Rejected: leaving the domain wider than its storage on the principle that the domain should not know about storage.
Why: a value the type calls valid money and the database cannot store is not a storage detail, it is a contradiction, and where it surfaced was a 500 that logged the whole receipt.
The bounds now live in `domain/money.ts` and `schemas.ts` imports them, so the HTTP boundary cannot stop short of what the column accepts.
The superseded assertion (`cents(MAX_SAFE_INTEGER)` is accepted) encoded deliberate intent, so its replacement says so in place rather than vanishing.

**Export zips move to `exports/{userId}/{jobId}/...`.**
Rejected: one lifecycle rule per user (three today, and silently one more at every sign-up, remembered by nobody) and object tags at upload.
Why: S3 and R2 lifecycle rules match a **literal** prefix, so `{userId}/exports/...` cannot express §10B's rule at all - no single prefix selects every user's exports without also selecting their receipt images, which must never expire.
Pre-existing zips keep the old layout and fall outside the rule; there are none outside dev.
**The general lesson: a retention rule written against a path that varies per user is not a rule, it is a description**, and this one survived two gate reviews because nobody wrote it out as the bucket would receive it.

**Stored object keys are re-validated on read, in both places one is dereferenced.**
Rejected: write-time validation alone.
Why: it says "we issued every key we accepted", which is not the same as "we issued every key we are about to hand out" - rows change by paths that are not the create route.
`assertIssuedObjectKey` now runs in the detail route before presigning and in `generateExport` before downloading, and throws (a 500, correctly - no client caused it) rather than returning false.
The key shapes moved to `src/storage/objectKeys.ts` so the layout an isolation rule and a retention rule are both written against is stated in one place.
Falsified: removing the check makes the new isolation test return **200 with a presigned URL naming another user's namespace**, which is exactly what the audit produced by hand.

**`npm run dev` names a stale listener on port 3000.**
Rejected: leaving `EADDRINUSE`, which reports the wrong fact.
Found four times across waves 3-6, and the risk was never the failed start - it is that **a stale server serves the code it was started with**, so a measurement taken against it looks exactly like a passing one.
The message names the pid, when it started, and the full argv, and says plainly what that means for anything measured against the port.
Verified by starting two servers.

**Deferred, recorded as open rather than closed.**
The **orphaned-object policy**: an image uploaded whose create never completed, inert today - unguessable keys under the uploader's own prefix, no endpoint lists them, no lifecycle rule touches them - but it should be a written policy rather than an absence.
And **per-request token pinning**: `OutboxController` re-checks ownership, then `APIClient` re-reads the token from the keychain, and the window between them requires a full Apple sign-in to complete in microseconds.
That change lands in the drain's session handling, which the wave-5 reviewer named the weakest code in the wave.

Suites after these changes: **server 195** (was 169), **iOS 177** (was 170), `tsc --noEmit` clean, zero iOS warnings.
Every new test was falsified in both directions.
Guardrail 7 re-run: `npm run dev` from the real entrypoint, one real `GET /api/me` answering 401 with `Cache-Control: no-store`.

## 2026-08-06 - Adversarial audit of the security review: money is bounded at the storable range, not the safe-integer one

**`centsSchema` bounds every money field to the Postgres `int4` range (-2 147 483 648 to 2 147 483 647), so an unstorable amount is a 400 naming the field instead of a 500.**
Rejected: the status quo (`Number.isSafeInteger` only - it accepts up to 2^53 while every money column is `integer`, so `totalCents: 2147483648` passed validation, failed inside the insert, and became an unhandled error); widening the columns to `bigint` (a migration on tax data to permit amounts above $21 million, which no receipt in this project will ever carry); and catching the range error in the create handler (it would fix one call site of a boundary defect that belongs at the boundary - PATCH had it too).
Why this outranked everything else the audit found: the unhandled error is what makes `renderError` print a raw `DrizzleQueryError`, and **drizzle attaches a `params` array carrying every bound parameter of the statement**. A single ordinary authenticated request with a large number in it dumped vendor, tax number, category, payment method, private notes and the full OCR text into the log in plaintext, measured against the running server.
**This breaks the prior review's finding 5 in two ways, both recorded because the reasoning is the useful part.** It had ranked the log exposure low on "no reachable trigger", having checked that "every text column is `text` with no length ceiling to violate" - which examined the string columns and never looked at the integer ones. And it hunted Postgres's `detail: 'Failing row contains (...)'`, which is `undefined` in this error; the leak rides drizzle's wrapper instead, which fires on *any* failed query rather than only on constraint violations. A fix aimed at `detail` would have missed it entirely.
**Left for a ruling:** `domain/money.ts`'s `cents()` still accepts any safe integer and `money.test.ts:15-17` asserts that it does, so the domain contract and the storage column genuinely disagree. The HTTP boundary is fixed because an API that 500s on input it just validated is unambiguously a bug; narrowing the domain means changing a test that encodes deliberate intent, which is a finding to report rather than something to rewrite in passing.

**The `Cache-Control` middleware moves outermost, ahead of `bodyLimit`.**
Rejected: the ordering from the previous entry (`bodyLimit` first). Its `onError` answers 413 without calling the next handler, so the cache middleware never ran and the 413 went out with no `no-store` - verified against the running server, where the 401 carried the header and the 413 did not. "Every API response" has to include the ones no route ever saw. The existing tests asserted a 200 and a 401, both of which pass through a route; the new one asserts the 413 and fails if the order is restored.

**The isolation suite's cross-user download assertion is rewritten against a response that can actually carry a leak.**
Rejected: `expect(ownList.text()).not.toContain(bObjectKey)` - it passed for two reasons that were not isolation (A owned no receipts, and the list projection carries no object keys at all), so the headline assertion of the cross-user-object test could not fail. A now creates its own receipt and the assertion moved to its detail response, the one place presigned URLs appear. Falsified by removing the receipt-id and user-id scoping from the detail route's image query.

**Three claims narrowed rather than broken.** (1) The object-key whole-string match is a **write-time gate only** - reads presign whatever `object_key` the row holds with no re-check, and `db:claim` moves receipts between users without touching `object_key`, so a claimed receipt carries a key under the original user's prefix. Inert today (seed rows have no stored bytes, no API route can move a receipt) and it needs database access, so it ranks below a hostile authenticated user - but "we issued every key in the system" is currently enforceable on writes alone. (2) The 1 MiB limit clears every legitimate body - re-derived independently at ~623 KiB - but it is **not** "derived from the schemas" as stated: `identityToken` carries no maximum, so on the one unauthenticated route the cap is the only bound. (3) MinIO refuses every dot-segment traversal, as the review found - **but a leading-slash key normalizes and serves the victim's bytes (200)**. The review's "latent, not live" rested on the storage layer collapsing dot segments; that is a property of the spellings tested, not of the layer, and a different spelling class resolves. Unreachable through the API, and it says nothing about R2 either way.

**Upheld under attack:** no auth-middleware bypass across 22 request targets, 10 methods, 10 `Authorization` variants, absolute-form, HTTP/1.0 and CL.TE/TE.TE smuggling; the object-key predicate against 21 crafted keys; soft-delete exclusion on all 9 read sites (the review said 12, having counted writes); no hard delete anywhere in the API, and `ObjectStorage` has no delete operation at all; and all five iOS claims, with the ATS-ships-in-Release blocker confirmed from `project.pbxproj` lines 278-279 and 301-302 directly.
**The body limit is real, not theatre** - the specific suspicion. Chunked bodies with no `Content-Length` take hono's streaming branch and abort at the cap: six concurrent 50 MB posts moved RSS 55 → 83 MB and stopped. 1 500 stalled connections left memory flat and legitimate requests answering in 1-6 ms; the consumable resource is file descriptors, not memory.
**Reported, not fixed:** `db:seed` issues three unconditional deletes against whatever `DATABASE_URL` names, with no equivalent of wave 4's `assertSeparateTestDatabase` guard - an operator footgun on the one thing §10B calls non-deferrable. **The wave-6 no-go stands, on its stated reasons.**

## 2026-08-06 - Security review, second pass: request bodies are bounded, and the first pass's blind spot named

**Every request body is capped at 1 MiB by `bodyLimit` (from hono itself - no new dependency), mounted app-wide ahead of all routes, answering 413 in the app's own error envelope.**
Rejected: no limit (the status quo - `POST /api/auth/apple` is the one route reachable without a session, so anyone holding the unlisted install link could make the server buffer arbitrary bytes before verification could reject them; measured against the real server, six concurrent 50 MB posts took resident memory from 285 MB to 654 MB and left it there, each request dutifully returning a correct 401); a limit on the auth route alone (the same buffering exists on every route, and one rule is one thing to reason about); a *chosen* round number (the value must not be able to refuse a request the schemas accept); and streaming the body (real work for a case a cap solves, the same reasoning §8's export budget already settled).
Why 1 MiB specifically: images never transit the API, so every body is JSON the schemas already bound - `ocrRawText` at 100 000 characters, `notes` at 5 000, all other strings under 1 400 together. zod counts characters and JSON can spend six bytes on one (`\uXXXX`), putting the worst legitimate case near 640 KB. **The limit is derived, not picked**, and a test sends a create at exactly that worst case to prove the cap cannot reject a real request - it fails if the limit is ever tightened below what the schemas allow.
Verified after the fix against the real entrypoint: the same six concurrent 50 MB posts leave memory flat at 265 MB, and a 5 MB body is refused in 9 ms.

**Rate limiting is re-ranked from low to moderate, and still not built.**
The first pass called it low priority because the auth endpoint is not brute-forceable - which answered a question about credentials and never asked the adjacent one about resources. The body cap bounds what one request costs; nothing bounds how many arrive, and each well-formed attempt still buys a signature verification. Still not built for the reason already recorded: the limiter's shape needs a deployment to name what identifies a client, and there is no deployment. It should land *with* the deployment, at the edge if the API ends up behind Cloudflare.

**The lesson, recorded because it generalizes.** A review that only *reads* finds only the defects visible in a line of code. The absence of a control has no source line to inspect, so availability and resource-consumption defects are invisible to reading by construction - this one took sending 50 MB and watching a memory number move. Operational form: for every externally reachable entry point, ask not only "is what it does correct" but "what does it cost, who can make it cost that, and what bounds it", and answer the second by measuring. Offered as a framework §9.3 candidate, tagged `Kept` only, on one observation.
Also cleared on this pass, by probe rather than by reading: no auth-middleware bypass across 17 path spellings and 8 methods; `web/` is genuinely empty (one `.gitkeep`), so wave 7 has no surface yet; CORS is unconfigured, which is fail-safe for native clients today and becomes a wave-7 decision - an explicit origin allowlist, never `*`, since `*` plus a bearer token is how a hostile page reads someone's receipts.

## 2026-08-06 - Consolidated security review: object keys are matched whole, not by prefix

**`POST /api/receipts` accepts an `image.objectKey` only if it matches the entire shape the upload-url route issues - `{userId}/yyyy/mm/{uuid}.{ext}` - and the issuing route asserts its own output against the same predicate.**
Rejected: the prefix test it replaces (`startsWith(userId + "/")`, from wave 1 - it admits dot segments, so `{userIdA}/../{userIdB}/2026/03/theirs.jpg` passes while naming B's namespace, and the detail route would then presign a download for it); rejecting only keys containing `..` (a denylist against a normalization behaviour nobody here controls, and it would still admit every other unissued shape); and normalizing the key server-side before storing it (silently rewriting what a client sent is the quiet-wrong-answer pattern - refusing states the fact).
Why: verified in both directions. Reverting the fix makes the new regression test fail with a 201, so the API genuinely accepted such keys. But five traversal spellings probed against the real MinIO all failed - three on `SignatureDoesNotMatch`, two on `NoSuchKey` - because the AWS SDK collapses dot segments when building the URL while signing the uncollapsed key, so **nothing leaked and this was latent, not live**. It is fixed anyway because the only thing between a prefix check and a cross-user read was normalization behaviour in the layer beneath, which is the exact trust that produced the wave-5 CFNetwork cache diagnostic and the `URL.path()` encoding defect - and R2's behaviour here is untested, since no R2 credentials exist.
The extension list in the validator is read from the same map the issuing route uses, so the pair cannot drift; the whole-string match is what makes "we issued every key in the system" an enforceable statement rather than a description.

**Algorithm pinning on the session JWT is load-bearing, and now proven so.**
Recorded because the falsification was more informative than the assertion: removing `algorithms: ["HS256"]` does not admit a forged token - jose's key-type check still refuses an RS256 token against a symmetric key - but it refuses it by raising a `TypeError` rather than a `JOSEError`, which `verify` deliberately rethrows, turning an algorithm-substitution attempt into a 500 instead of a clean 401. The pin is what keeps the rejection quiet and correct.
Also added: `alg: none`, and five malformed `tv` claims (`"0"`, `1.5`, `null`, `true`, an object) that differ from a valid token in that claim alone.

**Issuer and audience are deliberately absent from the session token.**
Rejected: adding `iss`/`aud` to satisfy the checklist. Why: they exist to stop a token minted for one party being replayed at another, and this secret signs exactly one token type for exactly one verifier - the claims would assert something already true by construction. The trigger to revisit is a second token type sharing the secret (a download token, a web session with a different lifetime), not distribution. The Apple identity token, which does cross a trust boundary, checks both.

**Wave 6 is no-go, on distribution work rather than on a breach.**
The isolation core holds and is now proven by test, including cross-user object access. What blocks the wave: there is no deployed server (the app defaults to `http://localhost:3000`), the single `Info.plist` serves both Debug and Release so `NSAllowsLocalNetworking` and `NSLocalNetworkUsageDescription` would ship, and there is no privacy manifest and no honest privacy label - which cannot be written until the deployment exists, because where the data goes is what the label declares.
Seven findings are recorded and left for a ruling rather than decided unilaterally: the outbox files' data-protection class (the only finding whose subject is the receipt data itself, and one that changes the `beginBackgroundTask` drain path the wave-5 gate closed without running), the rate limiter's shape (undecidable before a deployment names what identifies a client), whether database `detail` is stripped from error logs, the export key layout (§10B's `{userId}/exports/...` lifecycle rule is not expressible - S3 and R2 match literal prefixes, and that one varies per user), the orphaned-object policy, and per-request token pinning.
Full record: `docs/security/review-2026-08.md`.

## 2026-08-06 - Wave-5 offline pass (the owner): a 10-second request timeout, and the USB confound on the record

**The API session's `timeoutIntervalForRequest` is 10 seconds (asserted by the transport-configuration test).**
Rejected: the 60-second default (on the genuinely-offline device run it read as a hang - a person pulling to refresh in a store must get a fast honest failure, not a minute of spinner), an even shorter value (a slow cellular handshake can legitimately take several seconds; 10 answers while someone is still looking without failing marginal-signal requests that would have succeeded), and a separate longer-timeout session for the outbox's image PUT (unnecessary: this is an idle timer that resets whenever bytes move, so a slow-but-progressing upload is never cut by it - only a genuine stall is, and a stalled background upload *should* fail fast into backoff).
The outbox question answered in the same stroke: its upload-url, PUT, and create all ride the same `URLSessionTransport`, so its first attempt had the identical 60-second hang and the same one-line fix covers it.

**The USB confound, recorded as a correction.** Every earlier "offline" run was invalid: a phone tethered by the dev cable can reach the Mac's server with both radios off, so no offline failure could ever surface - unplugging was the missing variable, found by the owner. This partially re-attributes the offline diagnostic one entry down: the cached responses were real, the missing `Cache-Control` contract was real, and the cache-free transport is what made today's honest timeout possible - but the decisive mechanism behind that day's "no error" was most likely USB reachability, not a cache hit, and the two produced identical observations. Fifth instance of framework §9.3 candidate rule 5, and the most expensive kind: the environment divergence didn't just hide a defect, it invalidated the *test itself* while every observable looked like a pass.

**Verified on the genuinely-offline device run:** honest refresh failure with retry and a stated-unavailable pending count; capture-confirm-save returning to Home with live outbox status; automatic retry with backoff, unprompted; queue survival across force-quit while offline; automatic drain and list arrival on reconnect. **Stated gap: one receipt only - multi-item queue drain and cross-item ordering remain device-unverified** (covered by unit tests, not by the §6 gate's three-receipt run, which still stands ahead).

## 2026-08-06 - Wave-5 offline diagnostic (the owner): the API transport carries no HTTP cache, and the server says so

**Client: `URLSessionTransport` uses a session with `urlCache = nil` and `requestCachePolicy = .reloadIgnoringLocalCacheData` (either alone suffices; both are set so neither is load-bearing). Server: every API response carries `Cache-Control: no-store`, applied as app-wide middleware. Tests on both sides: the iOS suite asserts the transport's configuration (the configuration IS the behaviour - no request-level simulator test can see CFNetwork's cache), and the server suite asserts the header on a 200 and a 401.**
Rejected: client-only (the very next client would re-discover this the same way; the header states the contract at the source), server-only (a client's explicit cache policy should not depend on every server being configured right), and `.ephemeral` session configuration (discards cookies and credentials storage too - broader than the defect, and the two explicit settings say precisely what is meant).
Why: with both radios off, pull-to-refresh in the app showed no error and a current-looking empty list. The device's own cache database (`Library/Caches/…/Cache.db`) held the post-wipe list response verbatim; CFNetwork had heuristically cached it - Hono sent no cache directive - and served it offline as a fresh 200. Stale receipt-detail responses with expired presigned image URLs and a stale pending badge ride the same mechanism.
**The lesson, per the owner, is not about error handling.** The app's own error path was verified correct at the same time: a network failure drops the rows and shows the failure view with the reason and a Retry, and an empty list does not suppress it. The masking lived **below** the app - the transport reported success because, as far as it knew, the request succeeded. The trap is trusting the layer beneath to behave as the code above assumes: URLSession's default is a component with its own policy, and an unconfigured default is still a decision. Fourth instance of the framework's §9.3 candidate rule 5 - a production-environment behaviour (CFNetwork cache heuristics) that no simulator unit test exercised, alongside the fabricated Vision geometry, the unloaded `.env.local`, and the space-free test path.

## 2026-08-06 - Wave-5 airplane-mode run (the owner): the outbox store checks paths unencoded, and store tests walk a space-bearing path

**Both `fileExists` checks in FileOutboxStore use `path(percentEncoded: false)`, and the store test suite's temporary directory deliberately contains a space.**
Rejected: `URL.path()` bare (the defect: it percent-encodes by default, production lives under "Application Support", and the encoded string names a path that does not exist - so remove's idempotency guard answered "already gone" and returned success without ever removing, and loadAll's commit-file check misfiled every healthy item as unreadable at launch; three uploaded-and-created receipts left three undeleted directories and a false "2 saved receipts could not be read" on Home); the deprecated `.path` property (works, but the modern API with the explicit argument states the intent); and keeping the space-free test directory (the suite was green through the whole failure - reverting the fix now fails all 8 store tests, verified both ways).
Why: diagnosed entirely from the device evidence before any code moved (the owner's instruction): all three "unreadable" item.json files pulled off the phone decoded perfectly, each at `uploaded` with a matching server row - nothing was lost and nothing was unreadable; the cleanup and the visibility check were lying about the same paths.
**The masking casualty, named:** items invisible to loadAll never re-entered the queue, so their retried creates never ran - and the 409 duplicate-image self-heal, built precisely to absorb replayed uploads, could not reach the very items it existed for. A masked read defeated the recovery machinery downstream of it; the "N could not be read" note was the only symptom that survived, and it pointed away from the truth.
**The general lesson (third instance; recorded in the framework, §9.3 candidate rule 5):** the test environment differed from production in exactly the dimension that mattered - fabricated Vision geometry (wave 4), `.env.local` never loaded by the real entry point (wave 3), and now a test path without the space production paths carry.

## 2026-08-06 - Wave-5 device re-test (the owner): column de-skew in row assembly

**The row assembler estimates the receipt-wide vertical skew of the amount column (median of each amount fragment's delta to its nearest other-column neighbour, zero under 3 samples) and removes it before band-merging; emitted rows keep the measured geometry.**
Rejected: any pairing rule change without geometry in hand (the owner's instruction, and the wave-4 fabricated-fixture lesson - the diagnosis came from `vision-dump` over the exact uploaded bytes); tightening or loosening the band threshold (the Food Court dump proves no threshold works - the amount column measured ~0.013 above its labels against a ~0.022 row pitch, so each amount's *nearest* label was genuinely the wrong one, and the tax block "GST $0.00 / HST $2.05 / Total $17.84" assembled as "GST $2.05 / HST $17.84" with both ends orphaned); nearest-center or stable matching (same defeat - proximity itself lies under skew); and full sequence-alignment assignment (correct in principle, heavyweight against §7.3's humble-heuristic doctrine, and unnecessary once the skew - which is one coherent camera/curl artifact, not per-row noise - is removed).
Why: both real receipts to date show a coherent column offset (Food Court +0.013, Noodle House -0.008 - opposite signs, so the fixture pair covers both), and the median-of-nearest-deltas estimator is robust because most nearest pairings are true pairings even when the tax block's are not. Three different wrong HST suggestions from one paper (0.00, then 17.84 - the total - into the input tax credit field) were all this one structural misread.
Stated limits: a skew at or beyond a full row pitch shifts every pairing by one row and is undetectable by any local geometry - the human confirming each value (constraint 2) remains the real floor. The total heuristic was re-checked for the reverse mispairing per the owner: it survived even the broken assembly here because "largest across total-labelled lines" plus the receipt's redundant contiguous `TOTAL: $ 17.84` line made it insensitive to losing one pairing; its residual exposure is an *inflating* mispair (a larger neighbour amount attaching to a Total label), which the de-skew now covers in the partial-pitch case and full-pitch skew still could defeat - accepted under the same constraint-2 floor.

## 2026-08-06 - Wave-5 device step 1 (the owner): HST/GST label priority

**Tax labels are ranked, never lumped: non-zero HST > non-zero GST > non-zero TAX > zero HST > zero GST > zero TAX; topmost within a tier; total-mentioning TAX lines stay excluded.**
Rejected: the wave-4 shape (one `HST|GST` pattern, first match - The owner's Food Court receipt printed "GST: $0.00" above "HST: $2.05" and the GST zero landed in the HST field, the input tax credit, where a wrong-but-plausible 0.00 gets ticked past while an absence demands attention); summing HST and GST rows (invents a number no row printed); and pure label priority without the zero demotion (its mirror image - "HST $0.00" above a charged GST row in a non-harmonized province - reproduces the identical bug the other way around).
Why: HST is the more specific label and the harmonized amount already contains the federal part, so when both are non-zero - a receipt charging the tax twice - the HST row wins and the arithmetic warning surfaces the mess. A lone GST row still suggests into the field: GST and HST are one CRA program, claimed on the same return line. An explicit zero beside a non-zero sibling label is a shadow of the sibling program; an all-zero tax block is a genuinely exempt receipt, whose zero is the honest suggestion.

**The same audit ran over every heuristic that could face several labelled candidates.** Subtotal moved from first to **bottom-most** matching row (section subtotals print above the summary block; the summary subtotal is what the arithmetic check compares; single-subtotal receipts unaffected; flagged as evidence-free until a real multi-subtotal receipt lands in the accuracy table). Left deliberate as-is, now with the reasoning recorded: total (largest across all total-labelled lines - "largest" already resolves multiplicity), date (first parseable, top-third preferred - wave-4 tested), vendor (topmost-of-near-tallest band - wave-4 second pass), tax number (topmost match - the supplier prints its own number in the header block, above any other party's).

**The fixture debt is stated, not papered over.** The Food Court scan was never queued (the step-1 session ended without a completed Save, by design losing only the in-memory scan), so its bytes exist nowhere to re-run Vision over - the wave-4 rule demands real geometry, and there is none to be had. The fix carries rule tests over synthetic rows, explicitly labelled as such, and the real-dump fixture lands when the re-test uploads the receipt. `ios/Tools/vision-dump.swift` is now a committed tool (smoke-tested against the stored wave-4 receipt) so that dump is one command.

## 2026-08-06 - Wave-5 gate ratification (the owner)

**Ratified: §7.4's worker is app-lifecycle-driven, with no OS background execution.**
Rejected: adding `BGTaskScheduler` for literal background upload.
Why: real background execution buys latency nobody perceives; the foreground-driven drain plus the ~30-second backgrounding grant covers the actual usage pattern, and the keychain posture stays `WhenUnlocked` as a direct consequence.

**Rejected: capture returning to Home without the confirm screen. A single capture goes scan → confirm again; the confirm screen is now local-backed and its Save is a durable outbox write.**
Rejected on the owner's reading of his own kickoff: "return to Home immediately" meant *don't block on the network*, never *don't show the screen*. Online is the common case, and charging every receipt a badge tap to serve the rare offline one adds friction to the common path while manufacturing a pending queue that §1's success test exists to avoid.
The implementation honors both halves: after scanning one page, on-device OCR prefills the §7.2 form from local data (image included - no server row exists yet), and **Save writes the confirmed receipt into the outbox** - a disk-only, immediately-returning operation; the drain later uploads it and creates the row already `confirmed`, so it never joins the pending queue. "Later" queues it pending instead, so leaving the screen never costs the scan. **Batch mode keeps the wave-5 shape** - many pages queue pending immediately and are worked down through the confirm queue afterwards, which is correct for a stack and wrong for one receipt.
Also rejected: waiting for the upload before showing the confirm screen (a network wait on the capture path is what §7.4 abolishes; offline it becomes an indefinite spinner), and confirming against the server row post-upload as wave 4 did (re-introduces connectivity into the moment of capture).
Supersedes, in part, the wave-4 "single capture is a batch of one" decision: the *enqueue path* stays one path (everything goes through the outbox), but the *confirm timing* now splits by page count - which is the distinction that decision's "one path" argument actually cared about.
Stated cost: a scan is in memory only while the confirm screen is up; the app dying right then loses it, and the paper is still in the person's hand. The §7.4 guarantee anchors at Save, not at scan - same as the paper-based reality it replaces.

## 2026-08-06 - Wave 5

**The keychain stays `WhenUnlocked`; the outbox drains only while the app runs in the foreground (plus the ~30-second `beginBackgroundTask` tail after backgrounding).**
Rejected: widening accessibility to `AfterFirstUnlock` for background upload (the wave-3 reversal would have been re-reversed for nothing: no code path reads the token while the device is locked, because none runs then), `BGTaskScheduler` processing tasks, and a background `URLSession` (both add the app's most complex machinery - state restoration across process death by the session daemon - to save latency nobody is waiting on).
Why: the kickoff's own usage analysis holds - a person scans, pockets the phone, and the app has minutes to hours. With signal, the upload finishes in the foreground seconds or the backgrounding tail; without signal, background execution could not upload either. The receipt's safety never depends on upload timing - that is what the durable queue is for. A drain overtaken by the device locking fails the keychain read as a retryable error and the next foreground finishes the job. If a later wave adds real background upload, the accessibility question reopens with an actual requirement attached, and the save path still re-asserts accessibility so installs migrate on the next save.

**Strict concurrency checking is on (`SWIFT_STRICT_CONCURRENCY = complete`) in Swift 5 language mode, whole target.**
Rejected: full Swift 6 language mode (its remaining changes are annotation ceremony against §10's legibility mandate - the data-race checking is the part with three waves of defect evidence behind it), a separate Swift-6 module for the outbox alone (a hand-written framework target in the pbxproj to isolate what a build setting already isolates), and staying at minimal checking (the wave-3 deferral, now outweighed: the interleave class recurred in waves 3 AND 4, found by review each time, never by the compiler or the suite).
Why: in Swift 5 mode `complete` emits the full Swift 6 data-race diagnostics as warnings, and the project's zero-warnings discipline makes warnings blocking - so the compiler now catches the recurring defect class while the code keeps its Swift 5 shape. The pre-existing codebase surfaced ~30 diagnostics, fixed structurally (Sendable protocols, a Sendable APIClient, value-typed Vision output) except six cached `Regex` statics marked `nonisolated(unsafe)` with the immutability argument stated inline.

**Saving a capture writes image bytes and a minimal record to disk; OCR runs in the drain, not on the save path.**
Rejected: OCR at enqueue (a sixty-page backlog scan would hold the person for a minute of recognition against §7.4's "return to Home immediately"), and never persisting the parse (re-running OCR on every retry burns battery for identical output).
Why: the save path's only job is durability, and disk writes are milliseconds. The drain runs OCR once per receipt, persists the result on the item, and every later attempt reuses it.

**The outbox is a per-item directory under Application Support: image first, `item.json` written atomically last as the commit point.**
Rejected: Core Data/SQLite (a database for a queue of a dozen items whose payload is a JPEG is machinery without a reader), UserDefaults (wrong for blobs, wrong durability story), and a single queue file (every item update rewrites every item; one corruption loses the whole queue).
Why: the commit point makes partial enqueues detectable, items fail independently, and `item.json` stays human-readable for diagnosing a stuck queue by hand. Application Support is in device backups, which tax records want. A directory without `item.json` - the process died between the two writes, a save the person was never told failed - is counted into the "could not be read" note and kept, never deleted (the first draft swept these silently; the reviewer called it a second deletion path, and it was).

**Each item persists a step machine - captured → parsed → uploaded(objectKey) - re-written after every completed step.**
Rejected: restarting items from scratch on relaunch (re-uploads bytes already in storage and re-runs OCR), and persisting nothing mid-item (a kill between the PUT and the create repeats the PUT; between create and cleanup it double-creates).
Why: a kill at any boundary resumes instead of repeats. The one unavoidable replay - create succeeded, cleanup did not - lands on the server's 409 `duplicate_image`, which the drain counts as saved: the wave-4 ruling extended to the queue, for the same reason (the receipt exists; punishing recovery would fail the batch).

**Failures classify four ways, in one place: 409 → saved; 401 → wait for sign-in; network/5xx/408/429/locked-keychain → retry with backoff; any other 4xx and a missing image file → block for a human.**
Rejected: retrying everything (a permanent 400 would head-block the FIFO queue forever - kickoff §3 forbids exactly this), failing anything permanently on its own (a queued receipt silently dying is the one unforgivable outcome), and per-call-site error handling (the drain is where a swallowed failure is invisible by construction, so classification is a single audited function).
Why: blocked items surface on Home with the server's reason and two human actions - retry and discard (discard confirms first and is the only deletion path in the whole outbox). A connectivity-shaped failure stops the pass, since it is almost always queue-wide; an OCR failure defers only its own item, because it never is (reviewer finding - one unreadable page must not stall a backlog behind it). Backoff doubles 2s → 5min, reset by any trigger: foreground, connectivity restored, fresh capture, sign-in, manual retry, or a completed upload.

**Outbox items carry the capturing user's id, read from the session JWT's `sub` claim; the drain uploads only the signed-in user's items.**
Rejected: a separate stored user id (a second source of truth beside the token, with a migration for the existing install), asking `/api/me` at enqueue (capture must work offline), and no scoping (user A's queued receipts would upload into user B's account after an account switch - a constraint-4 violation the server cannot detect, since the create is authenticated as B).
Why: the client's own token already names its user; decoding the payload locally makes no trust decision (the server verifies every request cryptographically regardless). Items from another account are held and stated on Home, never dropped, never uploaded.

**After a capture the app returns straight to Home; the wave-4 auto-transition into the confirm queue is removed.**
Rejected: keeping the immediate confirm flow by waiting for the outbox to land the fresh captures (a network wait on the capture path is what §7.4 exists to abolish; offline it becomes an indefinite spinner or a two-mode UX), and a hybrid online-fast-path (two code paths through capture was rejected in wave 4 and is no better now).
Why: the kickoff is explicit - "on save, write to a local queue and return to Home immediately". Confirmation is one tap away (the pending badge, or the receipt's own detail screen) once the upload lands, seconds later when there is signal. Cost stated honestly: the everyday connected capture now takes one more tap to reach the confirm screen than wave 4's device-verified flow. Flagged for ratification at the gate.

**OCR failures retry up to 3 attempts (persisted on the item), then the receipt uploads with empty suggestions.**
Rejected: blocking the receipt on OCR (its safety outranks its prefill; the confirm screen already handles empty suggestions), and unlimited OCR retries (a genuinely corrupt image would head-block the queue forever).
Why: Vision failing can be transient (memory pressure) or permanent (broken bytes); a bounded retry distinguishes them cheaply, and the count persists so relaunches do not reset the meter. The fallback date is the capture day - recorded at enqueue - not the upload day, which after an offline weekend can differ.

## 2026-08-06 - Wave-4 gate review, second pass (the owner)

**Vendor is the topmost line within 15% of the tallest letter-bearing line in the top quarter, not the single tallest.**
Rejected: keeping single-tallest (the winner between same-size header lines is Vision height jitter - the same paper flipped between name and street address across two scans), running the vendor heuristic on pre-assembly fragments (the attributed cause, disproven against the artifact: the assembler had left both header lines untouched, and fragments would truncate a split name), and position-only rules (a genuinely logo-sized name below a tagline should win, and under the band rule it still does).
Why: same-size print makes "largest" a measurement artifact; "the name prints above the address" is the signal that survives jitter. Diagnosed by dumping Vision's real geometry from the stored image rather than guessing.

**Labels also match against a despaced copy of the row, fenced by letters rather than word boundaries.**
Rejected: word-boundary matching on despaced text (digits are word characters, so "Total15.25" never matches \btotal\b - found when the first attempt's test failed), and loosening the raw-text rules (despacing alone would misread "SUB TOTAL" and "TOTAL SAVINGS"; the raw word-boundary match still governs deliberate spacing).
Why: Vision split "Total" into "Tot al" on the real receipt, and a mid-word split is invisible to any within-word match; the despaced pass recovers exactly those.

**The parser fixture is Vision's real measurements verbatim, not invented geometry.**
Rejected: patching the invented fixture (it had passed while the device regressed - fabricated heights hid what Vision actually reports, which is what let the vendor regression through a fixture that did assert vendor).
Why: the fixture's job is to reproduce reality; the real dump carries all three parser lessons at once (wide-gap columns, jittered heights, a mid-word split).

**A pending receipt's detail screen carries a "Confirm this receipt" button opening the same confirm form.**
Rejected: leaving the header-badge queue as the only route (the owner's finding: tapping a pending receipt was a dead end), and a sixth screen or inline editing on detail (the confirm form already exists and §7.1's five-screen rule stands).
Why: the receipt in front of you should be confirmable where you are; the queue remains the batch route, and both paths run through the identical tested model.

## 2026-08-06 - Wave-4 gate review (the owner)

**The parser assembles printed rows from Vision fragments before any heuristic runs; `ocr_raw_text` stores the assembled rows.**
Rejected: per-heuristic cross-observation matching (the same band-pairing logic duplicated six times), and shipping raw fragments in `ocr_raw_text` (a future re-parse would inherit the unpairable-columns problem the fix exists to solve).
Why: on the first real thermal receipt, "Subtotal"/"13.50" and "HST"/"1.76" were separate observations across a wide gap - unmatchable by any within-one-string heuristic - while every contiguous field parsed; merging fragments whose vertical centers sit within half the taller fragment's height, ordered left to right, makes the §7.3 heuristics see what the paper shows. Stated limit: validated against one sample; the accuracy table re-checks it (spec §7.3 note).

**The queue's done screen appears only when the sitting handled more than one receipt or set one aside; a single confirm returns straight to Home.**
Rejected: the wave-4 shape (a "Queue clear" screen after every queue run - a success modal on the everyday single-capture path, which §10A.1 forbids; the owner's finding), and dropping the summary entirely (a worked-down batch and set-asides genuinely have something to say).
Why: the recap earns a screen only when there is something to recap.

**Confirm-screen and Home layout: the business/personal row keeps default list insets; the capture button's label is an explicit HStack.**
Rejected: zero row insets under the choice buttons (put their rounded strokes on the row's clip bounds, cutting them flat - The owner's finding), and `Label` for the capture button (inside a `List`, `Label` reserves a leading icon column and renders left-shifted).
Why: both were found on device; the full-bleed zero-inset treatment remains only on the image row, which has no strokes to clip.

**The ten-receipt accuracy session is waived; the per-field table accrues through real use.**
Rejected: blocking the gate on a staged capture session.
Why: the owner's call at the gate - `parse-accuracy` reads every confirmed receipt with a suggestion record, so ordinary use produces the same table with better variety; the number remains the §7.3 trigger data either way.

## 2026-08-06 - Wave 4

**Integration tests run against `kept_test` (TEST_DATABASE_URL), and the setup refuses a config that resolves to the dev database.**
Rejected: the shared dev database (the wave-3 "known tradeoff", corrected by the wave-4 kickoff), and comparing raw URL strings.
Why: `npm test` emptied every table, destroying the signed-in device user before each hand-tested wave; the guard compares host, port, and database name so differing credentials cannot disguise the same database, and a unit test proves the refusal.

**`total_cents` and `is_business` are nullable while `pending`; a CHECK constraint plus route validation make confirmed rows complete.**
Rejected: local drafts confirmed before any create (loses a sixty-receipt backlog scan to an app kill, contradicts §6A's "each becomes its own pending receipt"), and fabricated fallbacks (a guessed total is tax-data corruption; a defaulted `is_business` is the exact thing §5.2 forbids).
Why: batch mode's pending rows must be able to state what the parser could not read and what no human has chosen; constraints 2 and 3 hold through `status` - pending rows never export, confirming still requires the explicit choice - and `is_business` still has no default at any layer.

**When no date parses, the client sends the capture day as the date suggestion; `purchased_at` stays NOT NULL.**
Rejected: a nullable `purchased_at` (NULLs poison the keyset row-comparison cursor, silently dropping rows from pages), and refusing to create the receipt (blocks the whole batch on its worst page).
Why: most single captures happen the day of purchase, the confirm screen presents the date amber like every suggestion, and a wrong-looking date on a backlog receipt is exactly what the queue exists to fix. Wave 7's PDF upload path has no capture-day story and needs its own answer.

**`ocr_suggestions` jsonb records the parser's output verbatim at create and is immutable; `npm run parse-accuracy` compares it with confirmed fields.**
Rejected: a hand-maintained spreadsheet (the kickoff explicitly bars it), an in-app accuracy screen (a sixth screen for a one-wave measurement), and re-running the parser over stored raw text (the heuristics need line positions, which raw text does not keep).
Why: confirming receipts is the recording - the report reads suggestions against what the human went on to save, prints per-field accuracy plus every correction, and refuses when the real user is missing or ambiguous, in the db:claim mould. Stated limit: a wrong suggestion the human accepted counts as correct, because the confirmed value is the only truth available.

**Scanned pages are created as pending receipts immediately, then confirmed via a queue over server-side pending rows; single capture is a batch of one.**
Rejected: two code paths (immediate confirm for single capture, queue for batches).
Why: one path means the scan is durable server-side the moment it lands - abandoning the confirm queue loses nothing - and a batch scanned now and a backlog pending from last week are worked down by the same queue (§6A.3). Until the wave-5 outbox, a mid-batch network failure stops at the failing page with retry; pages already saved stay saved.

**A 409 `duplicate_image` during batch save counts as saved and the batch continues.**
Rejected: surfacing it as a failure.
Why: byte-identical bytes already attached to one of the user's receipts means the receipt exists - the common cause is a retry after a create whose response was lost, and failing the batch for it would punish recovery.

**Amber marks prefilled suggestions only; focusing or editing a field clears it permanently; the date is always amber initially.**
Rejected: marking absent fields amber (an absence is a stated fact, not a suggestion to review), and clearing only on edit (a correct suggestion would never clear).
Why: §10A.1's design - the screen starts loud and goes quiet as the person works down it; the date is always prefilled (parsed or capture-day fallback), so it always starts amber.

**The confirm queue's "Later" sets a receipt aside client-side for the sitting; nothing is written server-side.**
Rejected: a server-side snooze state.
Why: the receipt simply stays pending - the §5.2a badge keeps nagging, which is the design - and the queue just stops re-offering it until reopened.

## 2026-08-05 - Wave-3 gate review (the owner)

**`GET /api/receipts` returns `pendingCount`; the iOS 200-row probe is deleted.**
Rejected: a dedicated count endpoint (more API surface for one integer), and keeping the probe (honest but heavy, and it saturates at "200+" exactly when the backlog is largest).
Why: the badge's number rides the response both clients already fetch; it is user-wide and filter-independent because the badge means "receipts awaiting confirmation", not "pending rows on this page".

**Local object storage is MinIO in docker-compose, behind the real S3-compatible adapter.**
Rejected: a filesystem stub (does not exercise the presigned path, which is the part that will actually break), and deferring storage to deployment (wave 4's capture flow cannot run against a server that cannot store).
Why: one adapter serves MinIO locally and R2 in deployment; the dev default auto-creates its bucket so a clean checkout serves images with no ceremony, and `STORAGE_*` env repoints it (`npm run storage:init` creates the bucket for custom endpoints, e.g. the Mac's .local name so a phone can reach presigned URLs).

**Presigned PUT URLs sign the content-type header.**
Rejected: the SDK default (only `host` is signed), under which the upload-url schema's jpeg/png/pdf restriction was decorative - any bytes under any declared type would store.
Why: found by the integration test asserting a mismatched PUT fails; the signature now binds the PUT to the type the client declared and the server validated.

**The device-test reassignment SQL became `npm run db:claim`.**
Rejected: leaving it as a documented psql snippet in the gate report.
Why: it is dev tooling that will run every time a fresh device user needs data; the script refuses loudly when the real user is missing or ambiguous, and moves receipts and their denormalized image rows in one transaction.

**iOS: ReceiptListModel reaches the API only through GuardedReceiptLoader.**
Rejected: the wave-3 shape - a generation counter captured and re-checked by convention at every await (my own gate report named it the weakest code: nothing enforced the discipline on future awaits).
Why: the model holds no raw API reference, so a bare unguarded await is unrepresentable; every response arrives as an Outcome whose `.superseded` case the compiler forces callers to handle, and waves 4-5 add more async to exactly this class.

**`npm run dev` loads `.env.local` via node --env-file, creating the file if absent.**
Rejected: relying on shell-sourced environment (the wave-0 status quo; nothing loaded the file the docs told the owner to fill).
Why: found during device verification when the server died mid-run - 110 tests were green while the real entry point was unrunnable from a clean checkout, because tests inject config and never execute src/index.ts.

**Standing rule (framework guardrail 7, mirrored in CLAUDE.md): every gate starts the real server the real way and lands one real request.**
Rejected: treating a green dependency-injected suite as evidence the system starts.
Why: injection discipline makes the entry point structurally untested - the better the tests, the bigger the blind spot - so gate closure now requires the production start command, from a clean checkout, and one real response, recorded in the gate report.

## 2026-08-05 - Wave 3

**The Xcode project file is hand-written using filesystem-synchronized groups (Xcode 16+ format).**
Rejected: XcodeGen or Tuist (a new tool dependency, and the kickoff bars global installs), and the classic pbxproj that lists every file (rots on every file add, a standing merge hazard).
Why: synchronized root groups make the on-disk folders the source of truth, so adding a Swift file never touches the project file again.

**Swift 5 language mode, not Swift 6 strict concurrency.**
Rejected: SWIFT_VERSION = 6.
Why: the codebase is a teaching text (§10.1) and strict concurrency's annotation ceremony would obscure the code it decorates; async/await and @MainActor isolation are still used throughout, so the migration later is additive, not corrective.

**Models depend on a KeptAPI protocol; APIClient is its one production implementation.**
Rejected: view models on the concrete APIClient (every model test would build HTTP responses), and a client with per-endpoint request/decode logic (the kickoff's call-site-per-endpoint ban).
Why: transport-level behaviour (token attachment, error mapping, decoding) is proven once in APIClientTests against a stubbed transport; model tests script the protocol and stay about model decisions.

**Session state is one enum (signedOut / signingIn / signedIn); a 401 on any authenticated call and a missing keychain token both funnel into the same rejected-session path.**
Rejected: boolean flags, and treating sign-in's own 401 (a rejected Apple identity token) as a session death.
Why: the two flavours of 401 mean different things - one ends a session, the other fails a sign-in attempt - and conflating them would tear down nothing on a failed sign-in yet show the wrong message.

**Session token in the keychain as a generic password with kSecAttrAccessibleWhenUnlocked.**
Rejected: UserDefaults (barred by the kickoff - a plaintext plist in unencrypted backups), and AfterFirstUnlock accessibility (my first choice, reversed by the reviewer pass: loosening a security posture for the wave-5 background outbox before it exists is speculative generality applied to security).
Why: WhenUnlocked is the strictest class the app's current foreground-only reads allow; the save path re-asserts accessibility on update, so wave 5 can widen it with one constant and existing installs migrate on their next save.

**Pending count comes from a probe query (status=pending, limit 200) and is typed exact / atLeast / unknown.**
Rejected: counting pending rows in loaded pages only (a silent undercount, the error-masking pattern), adding a server count endpoint this wave (server changes are out of wave-3 scope; flagged in the gate report instead), and coupling the probe to the list fetch (my first shape, reversed by the reviewer pass: a failed badge count was taking down a successfully loaded list).
Why: the server has no count endpoint; one maximum-size page gives an exact count up to 200, an honest "200+" beyond, and a stated "unavailable" when the probe fails - never a quiet zero.

**purchasedAt stays a yyyy-mm-dd String in the model, formatted by one UTC-pinned formatter.**
Rejected: decoding it as Date (invents a midnight and a timezone the receipt never had, and shifts a day west of Greenwich), and a custom CalendarDate type (weight without a second consumer; reconsider when the wave-4 confirm form edits dates).
Why: the API's calendar date survives round trips untouched, and display formatting pins UTC on both parse and render.

**Server address is UserDefaults-configurable in-app, defaulting to http://localhost:3000.**
Rejected: a build-setting-only base URL (repointing a device build means rebuilding), and .env-style config (no such mechanism on iOS).
Why: the simulator reaches a local server with zero setup, and a device on the same network is a settings-sheet edit away; ATS is relaxed for local networking only, revisited at distribution.

## 2026-08-05 - Wave-2 gate review, second pass (the owner)

**`stale` also covers `running` jobs older than 30 minutes.**
Rejected: the first pass's queued-only rule (the owner's own, revised on my flag).
Why: a crash mid-run strands a poller identically to a crash before the claim; both clocks run from `created_at` since the claim follows creation within milliseconds, and 30 minutes is far above anything the byte budget permits.

**The export byte budget stands alone; `maxReceipts` removed.**
Rejected: keeping a row-count limit alongside the byte cap.
Why: row count is a worse-measured proxy for the same memory bound - ten thousand small receipts and two thousand large ones are the same problem, and only bytes see that - and it could refuse an export that would have fit, the wrong failure for the one artifact the accountant needs.

## 2026-08-05 - Cross-wave observation

**Runtime predictions have been consistently pessimistic; the real friction has landed at dependency seams every wave.**
Evidence: wave 1 predicted drizzle error-wrapping and zod message failures - all passed; the one failure was a jose API misuse in my own test.
Wave 2 predicted CSV assertion and archiver behavioral failures - all 105 tests passed first run; the two stumbles were compile-time dependency changes (archiver 8 dropping its factory API, exceljs typings predating Node's generic Buffer).
How to apply: spend prediction effort on dependency upgrade notes and API surfaces at the seams (read the changelog of a newly added or majored dependency before writing against it), and trust the tested-runtime paths more.

## 2026-08-05 - Wave-2 gate review (the owner)

**`whose` is documented as existing for accountant-side merging.**
Rejected: leaving the column's purpose unstated (it read as redundant and would eventually be "cleaned up").
Why: constancy within a file is the design - it is what makes a combined workbook of two people's exports unambiguous.

**Export zips are artifacts, not records; the exports storage prefix gets a 30-day lifecycle expiry.**
Rejected: keeping zips forever as records.
Why: receipts and images are the retained records and a zip is regenerable from them; the job row keeps its period, and past the window a job reports `expired` - re-runnable, not downloadable.

**`GET /api/export` (own jobs, newest first) added now.**
Rejected: deferring the job list to wave 7.
Why: cheapest while the export code is loaded; the web export screen needs a history list regardless.

**In-memory zip assembly is guarded by row-count and byte budgets (10 000 receipts / 256 MiB defaults) that fail the job with an actionable reason.**
Rejected: building streaming assembly.
Why: with the backlog and six-year retention a year's zip can reach gigabytes; an explicit "export a shorter period" refusal is a far better outcome than an OOM crash, and streaming is real complexity for a case a shorter period solves.

**A job stranded in `queued` past five minutes reports a computed `stale` status.**
Rejected: a background sweeper process and any new state.
Why: the only problem was a client polling forever; a computed status solves exactly that, and nothing is written back - the row stays the truthful history.

## 2026-08-05 - Wave 2

**Export jobs persist in an `export_jobs` table, not process memory.**
Rejected: an in-memory job map.
Why: a restart must not lose a running year-end export; rows also give the polling endpoint failure reasons for free.

**The export request is `{fiscalYearEndingIn}` XOR `{periodStart, periodEnd}`.**
Rejected: fiscal-only (blocks the §12 quarterly affordance) and range-only (pushes the fiscal derivation to clients, against §5.1's derive-at-request-time rule).
Why: both spec statements are satisfied, and the range shape is the seam a quarterly picker plugs into.

**Zip label: the calendar year when the period is exactly Jan 1 to Dec 31, otherwise the explicit range.**
Rejected: always labelling with the period's end year.
Why: calling a Mar-31 fiscal year "Receipts-2026" would mislabel nine months of 2025; a range names itself honestly.

**XLSX money cells are numeric with a `0.00` format; CSV money is a decimal string; both derive from integer cents via string assembly.**
Rejected: string money in the XLSX (does not sum in Excel) and cents÷100 floating-point division.
Why: the accountant gets cells that behave like money while no value in the pipeline ever passes through a float.

**A missing image fails the export loudly; the reason is recorded on the job.**
Rejected: skipping the row or shipping the zip without the file.
Why: a silent gap in an accountant's zip is the error-masking failure mode §10 exists to prevent.

**Zip assembly is in-memory.**
Rejected: streaming to storage.
Why: legibility wins at this scale; the seam to change it is one function (`buildZip`), noted in place.

**Dependencies: archiver 8 (class API) and exceljs at runtime; adm-zip as a test-only dependency for zip inspection.**
Rejected: hand-rolling zip reading in tests.
Why: the suite must open the artifact it produced; adm-zip stays out of the runtime dependency tree.

## 2026-08-05 - Wave-1 gate review (the owner)

**Create and update handlers use explicit field maps, not spreads of the parsed body.**
Rejected: spreading the strict-schema output into the insert/update (my wave-1 shape).
Why: the spread silently drops a schema key with no matching column - an invisible failure - whereas a forgotten line in an explicit map is at least visible in review; §10's rule is explicit beats concise.

**`noUncheckedIndexedAccess` enabled.**
Rejected: leaving it off with per-site care.
Why: every `rows[0]` was typed as always-present; enabling it now, while the codebase is small, converts a class of latent 500s into compile errors.

**`GET /api/receipts` is paged: keyset cursor on `(purchased_at, created_at, id)` descending, limit default 50 / max 200.**
Rejected: unbounded lists ("fine at three users") and offset pagination.
Why: the §6A backlog import makes lists large on day one, and keyset cursors stay stable under concurrent inserts, which is exactly the backlog-import condition.

**`users.token_version`, carried as the JWT `tv` claim, checked on every verify.**
Rejected: unrevocable 30-day JWTs.
Why: bumping the integer revokes all of a user's sessions at the cost of one indexed read per request; tokens without the claim are invalid by construction.

## 2026-08-05 - Wave 1

**`users.display_name` becomes nullable.**
Rejected: NOT NULL with an empty-string default at sign-in.
Why: Apple provides the person's name only on first authorization, only client-side, and possibly not at all; an empty-string default is exactly the silently-defaulted-value anti-pattern the quality rules ban.

**`receipt_images` gains `deleted_at`; the `(user_id, sha256)` unique becomes partial (`WHERE deleted_at IS NULL`); DELETE stamps image rows with the receipt in one transaction.**
Rejected: hard-deleting image rows on receipt delete (breaks retention), and keeping the full unique (delete-then-recapture of the same file would 409 forever against an invisible row).
Why: surfaced by the wave-1 reviewer pass; the partial index keeps rows for CRA retention while freeing the duplicate slot.

**Validation with zod, JWTs with jose; no other new runtime dependencies.**
Rejected: hand-rolled validators (verbose, and a second validation style would inevitably appear) and hand-rolled JWT handling (signature verification is not code to write oneself).
Why: both are the boring standard choices; jose's remote JWK set also handles Apple's key rotation, which the kickoff explicitly required.

**The Apple test bypass is injection-only.**
Rejected: an env var or config flag selecting a fake verifier.
Why: the kickoff demands the bypass be structurally impossible in production; `createApp` takes a verifier as a value, the production entrypoint always constructs the real one, and no configuration value can swap them - tests build their own app with a fake.

**Export routes answer 501 until wave 2.**
Rejected: an in-memory job store now.
Why: §6 specifies job id + polling but §5 defines no job store; that design decision belongs to wave 2 (an `export_jobs` table is the likely answer, since losing job state on restart mid-year-end-export is the wrong failure mode), and an honest 501 keeps the auth surface final without pretending.

**`GET /api/receipts` gained a `status` filter beyond §6's list.**
Rejected: leaving the confirm queue to client-side filtering of full lists.
Why: §6A's "next unconfirmed receipt" queue on both clients needs the server to answer "pending only" directly.

**Object keys are prefixed `{userId}/` and creates reject keys outside the session user's prefix.**
Rejected: accepting any object key (would let a receipt point at, and later presign a download for, another user's stored object).
Why: closes the one path where client-supplied input could cross the isolation boundary.

## 2026-08-05 - Wave-0 gate decisions (applied at start of wave 1)

**`receipts.deleted_at timestamptz NULL` added for soft delete.**
Rejected: hard delete, and a `deleted` enum status.
Why: §6 specifies a soft-delete endpoint and §10B makes retention (CRA six years) non-deferrable, but the wave-0 schema had no column to express it; a nullable timestamp records when, keeps `status` about the confirm workflow, and non-null rows are excluded from every list, count, and export.

**`receipt_images.user_id uuid NOT NULL` (FK to users) denormalized; unique `(user_id, sha256)` replaces `(receipt_id, sha256)`.**
Rejected: the original per-receipt unique, and enforcing user-scoped uniqueness through a join or application code.
Why: the per-receipt constraint only prevented the same image twice on one receipt, which is nobody's failure mode; a constraint that needs a join is not a constraint.
Scope honesty (recorded in the spec): the hash catches re-uploaded identical files, never a re-scanned paper receipt; near-duplicate detection on date+vendor+total is v2.

**`receipts.status` gains `DEFAULT 'pending'`.**
Rejected: no default (the wave-0 as-written reading).
Why: unlike `is_business`, status is a system state rather than a concealed human choice, and defaulting to `pending` is fail-closed because pending rows never export.

**`updated_at` is maintained by a Postgres trigger.**
Rejected: handler code and ORM hooks (`$onUpdate`).
Why: a field whose freshness depends on every future handler remembering it silently rots.

**`receipts.vendor` becomes nullable.**
Rejected: NOT NULL with a placeholder string.
Why: an illegible vendor is a real outcome; a forced placeholder corrupts the field for everyone reading it later.
