# Kept - operations runbook

Written for someone who was not in the session that wrote it, including the owner in six months.

This covers the deployed system: how to deploy, how to run a migration, how to roll back, and how to take and restore a backup.
The one-time setup that created the accounts and secrets is not here: it ran once, in August 2026, from a checklist that left the repo on 2026-09-04 (`docs/gates/wave-6.md` wherever this file still cites it).

**The shape of the thing.**
An iPhone app and a web client talk to one Node process on an Azure VM behind a Cloudflare Tunnel, which talks to Postgres on Neon and object storage on Cloudflare R2.
Cloudflare sits in front of the origin and carries the rate limiter.
Spec §4.2 has the reasoning; this file has the commands.

---

## 0 · What holds what

| Thing | Where it lives | Who can see it |
|---|---|---|
| Application secrets | `/etc/kept/kept.env` on the production VM, mode 0600 (`server/ops/prod/kept.env.example` lists the names) | The owner |
| The origin itself | One Ubuntu VM on the owner's Azure subscription, SSH only, reachable over HTTP only through Cloudflare Tunnel `kept-api` *(since 2026-10-02; Fly `keptapp-api` before that, kept at zero machines as the fallback)* | The owner |
| Local development config | `server/.env.local`, gitignored | The owner |
| Database | Neon | The owner |
| Receipt images and export zips | Cloudflare R2, bucket `kept` | The owner |
| DNS, proxy, rate limiter, tunnel | Cloudflare, zone `keptapp.net`; the tunnel under Zero Trust → Networks → Connectors | The owner |

No secret value appears in this repository, in this file, or in any log.

On a fresh clone, run `git config core.hooksPath .githooks` once to enable the gitleaks pre-commit hook that keeps it that way (`brew install gitleaks` if missing; the hook refuses to commit without it).

### Environment variables the server reads

All are read in `server/src/index.ts` and nowhere else.
A missing one stops the process at startup with the name in the message, rather than failing at the first request that needed it.

| Name | Required | What it is |
|---|---|---|
| `DATABASE_URL` | yes | Neon connection string, pooled endpoint |
| `SESSION_JWT_SECRET` | yes | Signs session tokens. At least 32 characters in production |
| `APPLE_CLIENT_ID` | yes | `com.arthurzhang.kept` |
| `ANTHROPIC_API_KEY` | yes in production | The server-side LLM parse sweep (spec §7.3). Unset in development the sweep disables itself, stated at boot; unset in production the server refuses to start, because the alternative is silent feature loss |
| `RECEIPT_PARSE_MODEL` | no | Overrides the model the parse sweep uses; defaults to `claude-sonnet-5`. Added 2026-08-28, when the move off Haiku 4.5 was made on the owner's field report rather than on the accuracy table, so the model can be moved against real traffic without a deploy and `npm run parse-accuracy` can compare the two populations afterwards. Every stored `llm_suggestions` record stamps the model that actually produced it, so changing this never rewrites history. Empty or whitespace falls back to the default; the resolved id is printed at boot, which is where a typo shows up. ⚠ **Whatever model this names, the request disables extended thinking** (`thinking: {type: "disabled"}`, 2026-09-01). That is not a tuning preference: Sonnet 5 runs *adaptive* thinking when the parameter is omitted, thinking tokens count against `max_tokens`, and the request's 1024 was spent entirely on thinking - `stop_reason: max_tokens`, no text block, three attempts, one permanent failure record on a real receipt. If you point this variable at a model whose defaults differ again, check that the parse still returns text before assuming a quiet failure is a bad receipt |
| `STORAGE_ENDPOINT` | yes in production | R2 S3 API endpoint, `https://<account-id>.r2.cloudflarestorage.com` |
| `STORAGE_BUCKET` | yes in production | `kept` |
| `STORAGE_ACCESS_KEY_ID` | yes in production | R2 API token access key |
| `STORAGE_SECRET_ACCESS_KEY` | yes in production | R2 API token secret |
| `STORAGE_REGION` | no | Defaults to `auto`, which is right for R2 |
| `EDGE_SHARED_SECRET` | no, but see below | Any random string. When set, the origin serves only requests carrying it in `x-kept-edge-secret`, which Cloudflare adds. Unset, the origin answers anyone who reaches it around the edge - behind the tunnel nobody can, but the Fly fallback's `fly.dev` hostname is public (§5) |
| `APPLE_WEB_CLIENT_ID` | no; required for web sign-in | The Apple Services ID the web client's Sign in with Apple mints tokens against (`com.arthurzhang.kept.web`). Unset, the verifier accepts exactly the iOS audience - the pre-wave-7 behaviour |
| `WEB_ORIGIN` | no; required for the web client | Comma-separated browser origins granted CORS (`https://keptapp.net` once web/ is deployed). Unset in production nothing is granted; unset in development the Vite origin `http://localhost:5173` is the default |
| `APPLE_TEAM_ID` | no; **all three or none**, and see below | The 10-character Team ID, the client secret's issuer |
| `APPLE_SIGN_IN_KEY_ID` | no; all three or none | The 10-character Key ID of a *Sign in with Apple* key in the developer portal |
| `APPLE_SIGN_IN_PRIVATE_KEY` | no; all three or none | The PKCS#8 PEM contents of that key's `.p8` file (Apple lets you download it once). Literal `\n` sequences are accepted in place of newlines |
| `PORT` | no | Defaults to 3000 |
| `NODE_ENV` | set by the Dockerfile | `production` turns on the deployed-shape checks in `src/productionEnv.ts` |

**The three `APPLE_SIGN_IN_*` / `APPLE_TEAM_ID` variables together enable Sign in with Apple token revocation** on account deletion (`DELETE /api/me`, spec §6 and §10B).
Set **all three or none**: a partial set throws at startup naming what is missing, because "revocation is off" and "revocation is misconfigured" look identical from outside and only one of them is a decision.
Unset, the process prints `Sign in with Apple token revocation is DISABLED - ...` at boot and every account deletion logs the same fact at error level; **the account is still deleted**, which is Apple's own instruction for the case where nothing revocable is in hand.
Deliberately **not** boot-blocking in production, unlike `ANTHROPIC_API_KEY`: this key exists only if Apple's portal has issued it, and round 2's lesson is that a boot-blocking requirement on something a third party grants trades a P1 for a P0.
To set them:

```bash
# in /etc/kept/kept.env on the VM (§0, "Change a secret"); the key's newlines become \n in the one-line value
APPLE_TEAM_ID=XXXXXXXXXX
APPLE_SIGN_IN_KEY_ID=YYYYYYYYYY
APPLE_SIGN_IN_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----
```

`client_id` is not among them: the revoker uses `APPLE_CLIENT_ID`, because native iOS authorization uses the **bundle id** as its client identifier and a Services ID there earns `invalid_client` from Apple.
Confirm it took by watching the boot log for the absence of the DISABLED line after `docker compose up -d`.

**Under `NODE_ENV=production` the server additionally refuses to start** if storage is unconfigured (there is no MinIO to fall back to), if `STORAGE_ENDPOINT` is not https (presigned URLs inherit it, so plain http would send receipt images in the clear), if `DATABASE_URL` is a loopback address, if the session secret is under 32 characters, or if `ANTHROPIC_API_KEY` is unset.

**And in every environment the server refuses to start unless both backing services answer.** Added 2026-08-11; before that, every check above asked whether a value was *present and well-shaped*, and none asked whether the service it named was *there*.
A wrong `DATABASE_URL` password produced a process that printed `Kept API listening on port 3000`, answered the `curl .../api/me` → 401 check in §1 (that path never opens a database connection), and returned 500 to every authenticated request.

- **The database** is probed with `select 1`, retried up to five times a second apart with a 5-second cap on each attempt, so a Neon compute waking from autosuspend is waited for rather than crashed on. If it never answers, the process prints `Database at <host>:<port> did not answer, so this process is refusing to serve` and exits 1. The host and port are named; the URL is not, because it carries the password.
- **Object storage** is probed read-only with a 10-second cap: one `GetObject` on `.startup-probe/reachability`, a key that cannot exist, treating "no such key" as success - never a `HeadBucket` (bucket metadata is a permission the R2 token is not known to carry) and never a create. If it does not answer, the process names the endpoint and bucket and exits 1. *(This sentence said `HeadBucket` until 2026-08-15; the probe moved off it on 2026-08-11 and the code's own refusal message was corrected in round 3, but this line was missed.)*

Both refusals happen **before the port is bound**, so a machine in this state is not listening at all, rather than listening and failing.
⚠ Neither of these is an "environment variable is missing" refusal, so when §7 step 2 sends you to the container log, expect one of these two sentences as well as the variable-name ones.

---

## 1 · Deploy

From the laptop, with the VM's ssh alias and the commit to ship:

```sh
server/ops/prod/deploy.sh <ssh-host> <commit-ish>            # add --migrate when the commit carries one (§2)
```

On the VM that fetches and checks out the commit under `/opt/kept`, builds `server/Dockerfile` tagged with the short sha, and `docker compose up -d`s it under `server/ops/prod/docker-compose.prod.yml`, which replaces the running container and leaves the old image on disk for §3.
The image runs the same entrypoint local development runs (`node --import tsx src/index.ts`) - deliberately, so the deployed process is not a second code shape that only exists in production.
Ship the commit that is on `main`; the VM builds from the repository, not from the laptop's working tree.

**Migrations do not run on deploy** unless you pass `--migrate`, and then they run from the image being deployed, before the swap. See §2.

⚠ **The 2026-10-31 batch had an order too.** No migration. Server first, then Pages, then a TestFlight build. Until the phones update, a swipe on a withheld row answers 409 `amounts_need_review` with its message, which is the guard working.

*Until 2026-10-02 this section read `fly deploy` from `server/`; the Fly app still exists at zero machines and `server/fly.toml` still describes it, so that command still works as the fallback (§5) and nowhere else.*

⚠ **The 2026-09-01 batch had an order, and it was not the default one.** Executed in full the same afternoon (`docs/DECISIONS.md`, 2026-09-01, last entry) - kept here because the next batch that pairs a migration with code that reads it will need the same sequence. In sequence:

1. **A fresh verified dump** (§4) — the two taken on 2026-09-01 are point-in-time artifacts, not a licence to skip this.
2. **Migration `0009_reviewed-fields-and-options.sql`, BEFORE the deploy** — see §2 for why an additive migration goes first this time.
3. **`fly deploy`**, then the §1 confirmation checks below.
4. **The Cloudflare Pages redeploy**, in the same session.
5. **Then, and only then, TestFlight build 1.0 (5).**

⚠ **Step 2 cannot run through `fly ssh console`, ever, in this order.** That command runs `drizzle-kit migrate` inside the *deployed* image, and the deployed image is by definition the one from before this deploy - it does not ship the migration that has to precede it. On 2026-09-01 it printed `migrations applied successfully!` against v8 and applied nothing; production was read back to find out. A before-deploy migration runs from the laptop (§2's fallback), and its effect is verified in the database, never from the migrate command's output.

⚠ **Step 5 cannot move ahead of step 3.** The deployed build's create and update schemas are **strict**, so a phone running 1.0 (5) against today's production would have **every save answered 400** on the unknown `ocrSource` and `reviewedFields` keys — surfacing in the app as outbox items needing attention, which is the honest failure and still a broken app in someone's hand. The reverse is safe: 1.0 (4) sends neither key and the new columns default.

### Confirm the deploy is real

An exit code is not evidence, and neither is a health check that proves only that a process is listening.

```sh
ssh <ssh-host> docker compose -f /opt/kept/server/ops/prod/docker-compose.prod.yml ps          # api "healthy"
ssh <ssh-host> docker compose -f /opt/kept/server/ops/prod/docker-compose.prod.yml logs --tail 50 api   # expect: Kept API listening on port 3000
curl -i https://api.keptapp.net/api/me
```

The compose healthcheck is `GET /health` (added 2026-08-15, carried over).
It proves only that the process is up and answering HTTP - deliberately, so it never keeps Neon's autosuspending compute awake (docs/DECISIONS.md, 2026-08-15).
The `curl` below stays the real proof that routing, TLS, the tunnel and the app all ran.

The last one must answer **401** with a JSON body `{"error":{"code":"unauthorized",...}}` and a `Cache-Control: no-store` header.
A 401 is the correct answer - it proves routing, TLS, the app, and the auth middleware all ran.
A 403 with `{"error":{"code":"forbidden"}}` means `EDGE_SHARED_SECRET` is set on the origin but Cloudflare is not adding the header; fix the transform rule (§5) rather than unsetting the secret.
A 502 or a Cloudflare error page means the origin is down - check the container log for a startup refusal, which names what is missing. A **530** is the tunnel with no connector behind it (`systemctl status cloudflared` on the VM); a **404** with no JSON body is the tunnel answering a hostname it has no published route for (§5).

### First deploy only: the operator checklist *(added 2026-08-15)*

Three things code cannot do for itself, each with what to verify.
The ordered account-and-secret setup is `docs/gates/wave-6.md` §3; these are the confirmations that belong to the person running it.
The first deploy happened 2026-08-16, completing wave-6 §3 steps 1-13; items 1 and 3 below are done, and item 2's scheduling and restore verification are the one piece still open.

**1. Confirm the R2 token can actually read from its bucket.**
The server refuses to boot unless the storage probe passes, and the probe reads: one `GetObject` on `.startup-probe/reachability`, a key that cannot exist, with `NoSuchKey` treated as success (§0).
No call of any kind has ever been made from this repository to R2, so the first deploy is the first time that assumption meets the real token.
What to observe, in `fly logs`:

- Pass: `Object storage: checking https://... for bucket "kept"` followed by the boot continuing to `Kept API listening on port 3000`. That sequence *is* the confirmation - a token that cannot read would have stopped it.
- Fail: `Object storage did not answer at ...` with a cause naming `SignatureDoesNotMatch` or `AccessDenied`, and the machine restarting. Fix the token in Cloudflare (bucket-scoped, read and write); do not soften the probe.

Then run `npm run storage:probe-keys` against R2 (wave-6 §3 step 12), which exercises real `GetObject` and `PutObject` calls and settles the key-normalization question §6 records as measured-on-MinIO-only.
Delete the `probe-victim-*` and `probe-attacker-*` objects it leaves.
Done 2026-08-16: the boot probe passed on the first deploy, and `storage:probe-keys` against R2 served the control read and refused all eight traversal spellings; the probe objects were deleted the same day.

**2. Choose the scheduled `pg_dump` destination, schedule it, and verify the first dump.**
§4's dump command exists; nothing schedules it and nowhere is named, and both are account decisions code cannot make.
Pick a destination that is **not Neon and not this laptop alone**, schedule the §4 `pg_dump` (weekly is proportionate at this size; before every migration regardless), and write the destination down here once chosen.
What to verify: the first scheduled run actually produced a file at the destination, and that file restores - run the §4 drill (scratch database, `npm run db:verify-restore`) against **the scheduled dump's file**, not against a hand-run one.
Chosen 2026-08-16: a second R2 bucket, `kept-backups`, in the same Cloudflare account as the images, under no lifecycle rule.
The accepted caveat is that a Cloudflare account compromise reaches both the receipt images and the dumps; a destination at a separate provider was the stricter alternative, and it was rejected.
Still open as of 2026-08-16: the `kept-backups` bucket exists, but nothing schedules the dump yet and no dump file has been verified - this is the one first-deploy item left.
Progress 2026-08-18: the tooling now exists - `npm run db:backup` (dump, upload, size-check, sha256) and the launchd template `server/ops/net.keptapp.backup.plist` (§4, "The scheduled dump").
Executed 2026-08-20 to the token boundary: `~/.kept/backup.env` written (production direct-endpoint `DATABASE_URL`; quoting and `PATH` facts in §4), the agent installed and loaded (nightly 02:00, refusing loudly to its log until the token exists), the full dump→upload→size-check→sha256 path rehearsed end to end against the dev database and a local `kept-backups` MinIO bucket, and the §4 drill run against a manual production dump - row counts verified 1/0/0/0, the image leg refused as vacuous because production holds no images yet, which is the verifier working as designed.
*(Superseded 2026-10-31: the job no longer needs that token. §4 has the current procedure.)*

**3. Decide the Neon plan, knowing what the history window is not.**
Neon's point-in-time restore is a **history window measured in hours** (6 on Free, 7 days on Launch, 30 on Scale) - a good answer to "I ran the wrong thing twenty minutes ago" and **not any part of the six-year retention story** (§4).
PITR is never the backup plan; the scheduled dump from step 2 is.
Decide: stay on Free and rest retention entirely on the dump, or pay for a longer oops-window on top of it.
Either is sound; record the choice so the next reader knows it was made rather than defaulted.
Chosen 2026-08-16: the Free plan.
Retention rests entirely on the scheduled dump from step 2, and the 6-hour PITR window is an oops-window only.
Executed 2026-08-16: the Neon project `kept` was created on Free, on Postgres 16 to match dev's `postgres:16` so the §4 restore drill stays valid.

### Change a secret

Edit `/etc/kept/kept.env` on the VM (mode 0600, never echoed), then restart the container and watch the boot log for the same lines as a deploy:

```sh
ssh <ssh-host>
sudoedit /etc/kept/kept.env
cd /opt/kept/server/ops/prod
export KEPT_IMAGE_TAG=$(docker inspect -f '{{.Config.Image}}' "$(docker compose -f docker-compose.prod.yml ps -q api)" | sed 's/^kept-api://')
echo "$KEPT_IMAGE_TAG"   # the deployed commit's 12-char sha, never "untagged"
docker compose -f docker-compose.prod.yml up -d --no-build api
docker compose -f docker-compose.prod.yml logs --tail 30 api
```

`up -d` recreates the container when its environment changed; nothing re-reads the file without it.
⚠ Pin `KEPT_IMAGE_TAG` to the running image and pass `--no-build`. Without the tag, compose resolves the image to `kept-api:untagged` and, because the service has a `build:` section, builds one from whatever `/opt/kept` has checked out: a deploy nobody tagged, which §3 cannot roll back to. With `--no-build` a wrong tag fails instead of building.
*(On Fly this was `fly secrets set NAME=value`, which restarted the machine by itself.)*
⚠ Changing `SESSION_JWT_SECRET` invalidates every existing session; everyone signs in again.
To sign one person out without touching the secret, bump their `token_version` instead (§6).

---

## 2 · Migrations

**Migrations are run deliberately, never on boot.** A process that migrates as it starts will, on the day a migration is wrong, run it once per restart while the app is down.

```sh
server/ops/prod/deploy.sh <ssh-host> <commit-ish> --migrate
```

With `--migrate`, the script builds the new image on the VM and runs `npm run db:migrate` **from that new image**, with the VM's env file, before the running container is swapped - so the migration a deploy needs is run from the image that contains it, which is the sequence 2026-09-01 needed and the Fly machine could not provide. `drizzle-kit migrate` applies only what has not been applied and records each one. Verify by reading `drizzle.__drizzle_migrations` and the schema itself, never by the migrate command's exit line.

*Everything below this line up to "Take a backup first" is the Fly-era history that shaped the rule above. It is kept because the laptop path is still the alternative, and because the rule about which half of a deploy a migration belongs in has not changed.*

```sh
fly ssh console -C "npm run db:migrate"        # Fly era, and the trap described next
```

⚠ **This command has not worked from the owner's Mac since 2026-08-26.** The WireGuard tunnel establishes and then times out probing the internal API; `fly doctor` reports the gateway ping failing with "no response from gateway received" while authentication and the agent pass. It is *not* simply blocked UDP - WireGuard-over-websockets on TCP/443 fails identically. The diagnosis is unfinished (`docs/DECISIONS.md`, 2026-08-26).
**Update 2026-09-01: the tunnel worked again that afternoon, and it did not help.** `fly ssh console -C "npm run db:migrate"` connected, ran, and reported success - inside the **v8 image**, which shipped `0000` through `0008` and did not contain `0009`. It applied nothing. For any migration that must run *before* its deploy (§1's ordering note), the machine cannot run it whatever the tunnel does, because the file is not there; the laptop path below is the only path, not a fallback. Verify by reading `drizzle.__drizzle_migrations` and the schema itself, never by the migrate command's exit line.
Migration 0005 ran instead from the laptop, pointing `drizzle-kit` at Neon's **direct** (non-`-pooler`) endpoint - the same `DATABASE_URL` `~/.kept/backup.env` carries for `pg_dump`, and the one the backup had just proven reaches production:

```sh
# server/, with DATABASE_URL set to the direct Neon endpoint:
npm run db:migrate
```

Prefer `deploy.sh --migrate` - it runs on the VM, from the image being deployed, against the environment the app itself uses, with no production URL on the laptop's shell. Use the laptop path knowingly, and take the §4 backup first either way.

Run it **after** the deploy when a migration only adds things (a new nullable column, a new table, a new index), and **before** the deploy when new code cannot run without it - which `deploy.sh --migrate` does by construction.
Wave 6 needs neither: the schema is unchanged since `0003_one-active-export-per-user`.

⚠ **Not every migration is purely additive, and the rule above is a default, not a guarantee about what any given migration does.** Migration `0008_receipt-images-page-partial.sql` (2026-08-28, `docs/proposals/2026-08-28-ux-enhancements.md` proposal #6, built and applied to the local database only - not yet run against production) is the migration to have in mind before reading the two bullets above as if every migration were additive. It does not add anything: it `DROP CONSTRAINT`s the existing plain unique constraint on `receipt_images (receipt_id, page)` and recreates it as `CREATE UNIQUE INDEX … WHERE deleted_at IS NULL`, in the same transaction. Two things follow that a `new nullable column` does not carry. **First**, changing an existing constraint rather than adding one means it belongs in the **before-deploy** half of the rule above: the new route this migration exists for (`PUT /api/receipts/:id/images/:page`, replacing a page's image) would 23505 against its own just-soft-deleted predecessor on every single call under the old plain constraint - not misbehave at the edges, fail outright, the first time anyone used it. **Second**, `CREATE UNIQUE INDEX` without `CONCURRENTLY` takes an `ACCESS EXCLUSIVE` lock on `receipt_images` for the statement's duration, briefly blocking every read and write on that table - trivial at today's row count, but the kind of cost an `ADD COLUMN` (instant regardless of table size in modern Postgres) does not carry, and worth knowing about before assuming every future migration is as cheap as the last few have been.

⚠ **And an additive migration can still belong before the deploy, for a reason that is not about locks.** Migration `0009_reviewed-fields-and-options.sql` (2026-09-01, built and applied to the local database only) is purely additive by the letter of the rule - one new table (`receipt_field_options`), two columns on `receipts` (`reviewed_fields`, `ocr_source`), nothing dropped and no constraint tightened, both `ADD COLUMN`s metadata-only. It still goes **first**, because it **backfills** the new table from existing receipts and the new code reads that table to serve `GET /api/receipts/options`. Deploying first would not break the API; it would make it serve **an empty vocabulary, confidently**, to two people whose pick lists had just vanished - a wrong answer rather than an error, which is worse to notice. **Read the rule as "before the deploy when the new code depends on it", not as "before the deploy only when the migration is destructive."**

**Take a backup first (§4).** Every migration in this project runs against tax records under a six-year retention requirement.

### Rolling back a migration

**There is no down migration.** `drizzle-kit generate` emits forward-only SQL, and this project has never written a reverse.
So a bad migration has exactly two remedies, and choosing between them is the whole decision:

1. **Roll forward.** Write a new migration that corrects the previous one. This is right for anything additive - a column added in the wrong shape, an index that should not exist.
2. **Restore from backup** (§4). This is the only remedy when a migration destroyed or transformed data, and it costs everything written since the backup.

Because (2) is expensive, the backup in §4 is not optional ceremony before a migration.

---

## 3 · Rolling back the application

The app and the database roll back separately, and the app is the easy half.

```sh
git log --oneline -5 main                                   # find the previous commit
server/ops/prod/deploy.sh <ssh-host> <previous commit>      # no --migrate
```

The previous image is already on the VM, tagged by short sha, so the swap is immediate; `docker image ls kept-api` on the VM shows what is there to roll back to.
*(Fly era: `fly releases` then `fly releases rollback`.)*

⚠ **Rolling the app back past a migration does not roll the migration back.** Old code against a new schema is usually fine here (the migrations so far have all been additive) but is not guaranteed. If the rollback crosses a migration that removed or narrowed something, restore instead.

---

## 4 · Backup and restore

§10B: *"An untested backup is an assumption, not a backup."*
This procedure has been run end to end and verified - see `docs/gates/wave-6.md` §2.

**What the backup has to cover is two stores, not one.** Postgres holds the records; R2 holds the images those records point at. A restore that brings back rows whose images are gone has restored half a receipt, which is why the verification step below follows the rows out into storage.

### ⚠ What Neon's history window is and is not

Neon's point-in-time restore covers a **history window** - 6 hours on the Free plan, 7 days on Launch, 30 on Scale.
That is a good answer to "I ran the wrong thing twenty minutes ago" and **is not a six-year retention story**.
The dump below is what retention actually rests on. Take one on a schedule, keep the files somewhere that is not Neon and not this laptop alone.

### Take a backup

`pg_dump` must be version 16 or newer. If it is not installed locally, the Postgres container has it:

```sh
# From a local install:
pg_dump "$DATABASE_URL" -Fc -f kept-$(date +%Y%m%d).dump

# Or, with no local install, using the same version the database runs:
docker run --rm -v "$PWD:/out" postgres:16 \
  pg_dump "$DATABASE_URL" -Fc -f /out/kept-$(date +%Y%m%d).dump
```

Keep the file. It is a tax record.

### The scheduled backup *(rebuilt 2026-10-31)*

`npm run db:backup` is the whole procedure, both stores, in one run. It is what the hand-run backups before it did, and what the older dump-only script never was:

1. **Preflight.** `pg_dump`, `pg_restore`, `initdb` and `pg_ctl` at 16 or newer, plus wrangler in wrangler mode; a missing one refuses by name.
2. **Dump** to `<BACKUP_LOCAL_DIR>/pg/kept-<UTC stamp>.dump`, mode 600.
3. **Restore it, every run,** into a throwaway Postgres cluster bound to loopback, and compare `count(*)` against the source for every table plus `drizzle.__drizzle_migrations`. A difference redoes the dump once, since a client can write at 02:00, then fails. No receipts or no images restored is a failure, not a pass. The cluster is stopped and deleted however the run ends.
4. **Images.** Every `receipt_images` row is read from the *restored* database, tombstoned ones included, because a soft-deleted image is still a retained record. Each object is fetched from the source bucket once, hashed against its row's digest and kept at `<BACKUP_LOCAL_DIR>/images/<key>`. Wrong bytes never replace a good local copy. `MISSING` on a live row fails the run; on a tombstone it is a warning.
5. **Off-site.** The dump goes to `kept-backups/pg/`, new images to `images/mirror/<key>`, a manifest of every row to `manifests/`, and each is re-downloaded and compared. `offsite-ledger-<destination>.tsv` remembers what is already there, so losing it costs only a re-upload.
6. **Record.** `last-success.json` is written only when all of the above was green; `last-run.json` always, with the failures listed.

**What it needs in `~/.kept/backup.env`** (chmod 600, every value quoted: the file is sourced by zsh and a Neon URL carries `&`):

```
DATABASE_URL            # the DIRECT (non-pooler) Neon endpoint: pg_dump needs session semantics
BACKUP_LOCAL_DIR        # absolute, e.g. "$HOME/.kept/backups"
BACKUP_TRANSPORT        # wrangler
BACKUP_SOURCE_BUCKET    # kept
BACKUP_STORAGE_BUCKET   # kept-backups - NEVER the image bucket
```

`wrangler` is the transport because its OAuth login reads and writes R2 objects, which is why no R2 API token is needed; nobody can script minting one, and the job waited 72 days for it. Run `wrangler whoami` if a run reports it cannot authenticate. `BACKUP_TRANSPORT=s3` plus `BACKUP_STORAGE_ENDPOINT`, `_ACCESS_KEY_ID` and `_SECRET_ACCESS_KEY` uses one token scoped to both buckets instead.

**Is it working?**

```sh
cd server && BACKUP_LOCAL_DIR="$HOME/.kept/backups" npm run db:backup-status    # exits 1 past 48 hours
```

That reads two local files and needs no credentials. A failed run also posts a macOS notification. **A job that never runs posts nothing**: that is how this one went unnoticed from about 2026-09-25, so look at the status now and then.

**Scheduling** is a launchd agent on the Mac: `server/ops/com.arthurzhang.kept-backup.plist` is the template, with the install steps in its header, and it runs `server/ops/kept-backup.sh`, which rebuilds `PATH` after sourcing the env file so a stale line there cannot break the job. Daily 02:00; launchd runs a missed slot at next wake. ⚠ The label is **disabled in launchd's own database**, and that survives a reload, so the install needs `launchctl enable`.

**Enabled 2026-10-31.** The first run through launchd took 12 minutes (263 images, 176 MB), and the next took 18 seconds. Everything lives under `~/.kept/backups/`.

**Keeping a deleted account out of the backups.** Only `DELETE /api/me` hard-deletes, so the trigger is a user id vanishing, never rows or images vanishing. When a green run sees a mirrored user who is no longer in `users`, it records them in `pending-prune.tsv` and posts a notification. 30 days later it removes that user's off-site images and every dump and manifest taken before the deletion, off-site and local, and the local mirror; later dumps stay, so a restore point always exists. **A prune also removes every other user's history from before that date**, which is inherent in the dumps holding everyone. It refuses when the run was not green, when `users` restored empty, or when every known user vanished at once: a wiped database looks exactly like that, and the backup must not destroy itself over it. `db:backup-status` shows what is pending and when. To stop a prune, restore the user or unload the agent; deleting the line only re-adds it with a new date. **Out of its reach:** the hand-run copies (`kept-prod-*.dump` and `images-<date>/` locally, `pg/kept-*-manual-*.dump` and `images/<date>/` off-site), since wrangler cannot list a bucket, and a user who never had an image. Delete those by hand.

**The dead man's switch.** `server/ops/backup-watch/` is the Worker `kept-backup-watch`. Once a day at 12:00 UTC it lists `kept-backups` and emails if the newest dump or manifest is over 48 hours old, empty or missing. It does not depend on this laptop. Its tick is a Durable Object alarm that re-arms itself, because the account's five free cron triggers are held by other projects. `POST /check` with `x-watch-token` (the value is in `~/.kept/backup-watch.token`) checks on demand and reports the next alarm; `?test=1` also sends a test mail. ⚠ Outlook filed the first test under Junk although SPF and DKIM both passed (DMARC `bestguesspass`; the zone has no DMARC record). That is a new sender's reputation rather than authentication, so a DNS change would not be the fix. An alert in Junk is silence, so keep `alerts@keptapp.net` on the Safe senders list.

**What it does not do.** An image already mirrored is not re-read from the bucket, so an object damaged in R2 after its first backup is not noticed by this job; the good copy is safe in the mirror, and `npm run db:verify-restore` does re-hash the bucket. `kept-backups` is the same Cloudflare account as the images; the local mirror is the copy an account compromise cannot reach.

### Restore the images

```sh
cd server
BACKUP_LOCAL_DIR="$HOME/.kept/backups" BACKUP_TRANSPORT=wrangler \
BACKUP_STORAGE_BUCKET=kept-backups RESTORE_TARGET_BUCKET=<new bucket> \
RESTORE_MANIFEST=manifests/kept-<stamp>.tsv \
npm run db:restore-images
```

It uploads every image in the manifest to the target from the local mirror, falling back to off-site. It refuses the backup bucket as a target, skips an object already there with the right digest, and reports rather than overwrites one with a different digest. Then point `STORAGE_BUCKET` at it and run the §4 verification below. A test wipes a bucket and database and rebuilds them this way from the backup alone.

### Three verified backups exist for 2026-09-01, and each one is a photograph, not a policy

Both were taken by hand, both were **restored and verified** rather than merely written (§10B: an untested backup is an assumption).

- **Morning**, before anything: `~/.kept/backups/kept-prod-20260901.dump`, with its images beside it — **2 users, 136 receipts, 136 images**, every image hash-checked.
- **Afternoon**, a second dump the same day: `~/.kept/backups/kept-prod-20260901-postbackfill.dump` and `kept-backups/pg/kept-20260901-manual-164645.dump` in R2 (16:46 UTC) — **237 receipts, 237 images**.

- **Pre-`0009`**, 19:54 UTC, minutes before the migration: `~/.kept/backups/kept-prod-20260901-pre0009.dump` (142,834 B, sha256 `8ccffae3…`) and `kept-backups/pg/kept-20260901-manual-195446.dump` — **237 receipts, 237 images**, matched against production on every table by count and whole-row md5. Its image leg was verified by comparison: the restored `receipt_images` (key, sha256) set equals the afternoon image backup's 237-row manifest exactly, so `images-20260901-postbackfill/` is this dump's image backup too.

⚠ **Each is a point-in-time artifact and stops being a pre-migration backup the moment anything is written.** None of them is the backup for the *next* migration — **take a fresh dump then**, and verify it. A dump's value is entirely in how little has happened since.

⚠ **Manual backups were all there was until 2026-10-31**, the latest being the 2026-10-02 pre-cutover run. Between them, what protected the data was Neon's 6-hour history window and nothing else.

### Restore it, and verify the restore

**Never restore into the live database to check a backup.** Restore into a scratch one and compare.

```sh
# 1. A scratch database. On Neon, create a new branch or a new database in the console;
#    locally, this is one command against the dev container:
docker exec kept-db psql -U kept -d postgres -c "create database kept_restore_drill;"

# 2. Restore into it. --no-owner --no-privileges because the dump carries
#    Neon's roles (neondb_owner, neon_superuser), which do not exist in a
#    local scratch database - without the flags a production dump restores
#    its data but exits 1 under 12 ownership/privilege errors (measured
#    2026-08-20; the wave-6 drill never saw this because it restored
#    same-role, kept to kept).
docker run --rm -v "$PWD:/in" postgres:16 \
  pg_restore --no-owner --no-privileges -d "<scratch database url>" /in/kept-20260807.dump

# 3. Verify - this is the step that makes it a tested backup rather than a completed command.
cd server
SOURCE_DATABASE_URL="<the database the dump came from>" \
RESTORED_DATABASE_URL="<the scratch database>" \
STORAGE_ENDPOINT=... STORAGE_BUCKET=... STORAGE_ACCESS_KEY_ID=... STORAGE_SECRET_ACCESS_KEY=... \
npm run db:verify-restore
```

Step 3 compares row counts for every table between the two databases, then takes every live receipt image row in the **restored** database, downloads the object behind it, and checks that the bytes hash to the digest that row carries.
The digest is the part that matters: a key that resolves proves an object is there, and only the hash proves it is the right object.
Read the labels precisely: `MISSING` means storage answered and the object is not there - the backup really is short an image - while `UNREACHABLE` means storage did not answer, the object may be fine, and the run proves nothing about it either way. *(The script labelled both `MISSING` until 2026-08-21 - round 4 §4a.)*
It exits non-zero and names every problem if anything fails, and it refuses to report success if the restored database holds no images at all - a restore verified against zero images has verified nothing.

It is read-only on both databases and on storage, so it is safe to point at production.

Then drop the scratch database.

### If you actually have to restore for real

1. Stop the app so nothing writes during the restore: `docker compose -f /opt/kept/server/ops/prod/docker-compose.prod.yml stop api` on the VM.
2. Restore into a **new** database, never over the damaged one - the damaged one is evidence, and it may hold rows the backup does not.
3. Verify it with `npm run db:verify-restore` as above.
4. Point the app at it: edit `DATABASE_URL` in `/etc/kept/kept.env` (§0, "Change a secret").
5. `docker compose ... up -d api`, then re-run the §1 confirmation.

---

## 5 · Cloudflare

Cloudflare is in front of the origin for two things: **the rate limiter** §10B has asked for since the beginning, and DDoS protection.

- **DNS.** `api.keptapp.net` is a proxied (orange-cloud) CNAME to Cloudflare Tunnel `kept-api` (`<tunnel-id>.cfargotunnel.com`), created by the tunnel's own route form, not by hand. Proxied is the whole point; grey-cloud sends traffic straight to the origin and none of the below applies. *(2026-08-16 to 2026-10-02 the target was `keptapp-api.fly.dev`.)*
- **The tunnel.** Zero Trust → Networks → Connectors → `kept-api` → Published application routes: `api.keptapp.net` → `http://localhost:3000`, catch-all 404. `api-next.keptapp.net` is the rehearsal hostname with the same route and the same Transform Rule; it is removed after 30 stable days. The connector is `cloudflared` as a systemd service on the VM (`systemctl status cloudflared`); the dashboard shows its connections. ⚠ **A route cannot be added while a DNS record of that name exists**, and a hostname the tunnel has no route for answers **404** with no body - which is exactly what happened at cutover when the `api` CNAME was repointed by hand first. The order is: delete the DNS record, add the route, confirm the record the form created is proxied. The reverse order is half an hour of 404.
- **Upgrading the connector.** `cloudflared` comes from Cloudflare's apt repository, which Ubuntu's unattended-upgrades leaves out by default; `/etc/apt/apt.conf.d/51unattended-upgrades-cloudflared` (written by `bootstrap-vm.sh`) adds it, and `needrestart` restarts the service after the nightly run, so a new release drops the tunnel for a few seconds around 06:00-07:00 UTC. By hand: `sudo apt-get update && sudo apt-get install -y --only-upgrade cloudflared && sudo systemctl restart cloudflared`, then confirm every connection in the dashboard reports the new version and `curl -i https://api.keptapp.net/api/me` answers 401 (§1). *(2026-10-26: Cloudflare's advisory on eMudhra intermediates with weak keys required 2026.10.2 or later; the VM went from 2026.9.3 to 2026.10.4 by hand, and the drop-in was added the same day.)*
- **Falling back to Fly** (until the app is destroyed, no earlier than 2026-11-02): `fly scale count 1 -a keptapp-api`, wait for `fly status` to show the machine started, then in DNS delete the Tunnel CNAME `api` and add a proxied CNAME `api` → `keptapp-api.fly.dev`. The `_acme-challenge.api` CNAME and `_fly-ownership.api` TXT are what Fly's certificate for `api.keptapp.net` needs and are kept for this; do not delete them before the app.
- **Rate limiting rule.** One rule, on `api.keptapp.net`, counting by IP. The Free plan allows exactly one rate limiting rule with a 10-second window, which is enough: the endpoint worth limiting is `POST /api/auth/apple`, the only route reachable without a session.
- **The origin lock.** A Transform Rule adds a request header `x-kept-edge-secret` with the value of `EDGE_SHARED_SECRET`; its expression names both `api.keptapp.net` and `api-next.keptapp.net`. Behind the tunnel the lock is structural - the VM has no public HTTP port, so there is no second door - and the secret stays as defence in depth and as what keeps the Fly fallback (`keptapp-api.fly.dev`) from being reachable around the edge. Set the origin's secret and the transform rule together, in that order (origin first tolerates the header before it requires it; the reverse locks you out for the seconds in between).

Rotating the edge secret: set the new value in the Cloudflare transform rule first, then in `/etc/kept/kept.env` and `docker compose up -d` (§0). Requests carrying an old value are refused with 403, not 500. ⚠ The rules overview page in the dashboard prints the header's **value** in plain text; the secret's current value was displayed in one session that way on 2026-10-02 and the owner chose not to rotate (`docs/DECISIONS.md` 2026-10-02).

### The R2 lifecycle rule

One rule on bucket `kept`, prefix **`exports/`** (a literal prefix, with the trailing slash), expire objects after **30 days**.

⚠ **The prefix is exactly `exports/` and nothing else.** Receipt images live under `{userId}/...` and must be under no lifecycle rule whatsoever - they are the retained records, and an export zip is a regenerable artifact (§10B). A rule written against a prefix that varies per user is not a rule, it is a description; that is why the export key layout was changed in August 2026 to hoist `exports/` to the front.

An expired zip is not a lost export: `GET /api/export/:id` reports the job as `expired` with its period parameters intact, and the client re-runs it.

---

## 6 · Everyday operations

**Sign one person out of everything** (a lost phone). Session tokens carry a `tv` claim compared against the database on every request, so bumping the column revokes every outstanding session for that user without touching anyone else:

```sql
UPDATE users SET token_version = token_version + 1 WHERE id = '<user id>';
```

**Look at what is in there.** The Neon console, or `psql` from the laptop with the `DATABASE_URL` that `~/.kept/backup.env` carries (§4). The VM has no `psql`; read production from the laptop, not from the container.

**Parser accuracy** (§7.3's measurement, which accrues through ordinary use):

```sh
npm run parse-accuracy
```

**Re-capturing the identical file: delete first, then capture** *(N-3, recorded 2026-08-20)*. The duplicate-image constraint is scoped to live rows, so uploading **byte-identical** bytes a second time - the re-dragged PDF case, or retrying a receipt whose presigned PUT failed while the bytes are still on the device - answers 409 until the old receipt is deleted. The working order is **delete the old receipt, then capture again**; capture-then-delete is the order that fails. This matters only for identical bytes: re-photographing a paper receipt produces different bytes and collides with nothing. The export-failure message teaches the same order; this paragraph exists so the rule is findable before an export fails.

**"I deleted a receipt by accident"** *(2026-08-28, proposal #9)*. `POST /api/receipts/:id/restore` un-tombstones a receipt and its images without touching the database directly - a support path that does not need this file's backup/restore section at all, since a soft delete never left the row. On iOS this is what the Home list's swipe-to-delete undo toast calls; it is reachable the same way for a receipt deleted any other way, or after the toast's own six-second window has passed, since the route itself is **not time-limited**. It can legitimately answer **409 `restore_conflict`**: if the same image bytes (or the same page number) were re-captured onto a *different* receipt after this one was deleted and before it was restored, un-tombstoning the old image would collide with the new receipt's live one. The message names the remedy - delete or replace the other receipt's colliding image, or leave this one deleted - and the failure is atomic, so a 409 here never leaves a receipt half-restored.

**"A vendor is spelled wrong, or spelled two different ways"** *(2026-09-01)*. **This is a route now, not an in-app receipt-by-receipt edit and never a SQL `UPDATE`.**

```sh
# Rename a value everywhere the caller uses it. :field is vendor | category | paymentMethod.
curl -X PATCH https://api.keptapp.net/api/receipts/options/vendor \
  -H "authorization: Bearer $SESSION" -H 'content-type: application/json' \
  -d '{"from":"Tim Nortons.","to":"Tim Hortons"}'
# -> {"receiptsUpdated": 3}

# Remove a stale entry from the pick list, leaving every receipt's text alone.
curl -X DELETE "https://api.keptapp.net/api/receipts/options/vendor?value=Domno%27s" \
  -H "authorization: Bearer $SESSION"    # -> 204
```

The rename rewrites **every receipt of that user carrying the exact old string, in every status, soft-deleted rows included**, and merges onto an existing target value rather than colliding with it. The delete does the opposite and only that: **the list entry goes, the receipts keep their text.** Know which one you want before you type it. The real cases this exists for are the ones the 2026-09-01 review found: `Tim Nortons.`, `Domno's`, and one shop stored under both a curly and a straight apostrophe.

**"Is the parser reading this receipt correctly?"** *(2026-09-01)*. `POST /api/receipts/parse` runs the server-side LLM parse over text you supply and **writes nothing at all** — no receipt, no `llm_suggestions` row — so it is safe to point at production while diagnosing:

```sh
# Locally, mint a session first: npm run dev:session-token
curl -X POST http://localhost:3000/api/receipts/parse \
  -H "authorization: Bearer $SESSION" -H 'content-type: application/json' \
  -d '{"ocrRawText":"FOOD BASICS\nSUBTOTAL 9.86\nTOTAL 9-86\n07/19/2026","capturedAt":"2026-09-01T12:00:00Z"}'
# -> {"suggestions": {...}, "model": "claude-sonnet-5", "promptVersion": 5}
```

**503** means the server has no `ANTHROPIC_API_KEY`; **502** means the model call itself failed and carries the reason. It is also what the iOS capture screen calls for its second opinion (spec §7.2), so a 502 here and a confirm screen that never fills in the vendor are the same fault.

⚠ **`npm run db:seed` and `npm run db:claim` refuse to run against anything that is not a loopback database**, deliberately and unarguably. They rewrite tax records. Neon hostnames are remote by construction, so neither can ever touch production. Do not add an escape hatch.

**The key-normalization probe.** `npm run storage:probe-keys` measures whether an object store resolves keys that walk out of a user's prefix. Against MinIO the answer is "dot segments no, a leading slash yes" - the same class of input, opposite outcomes, which is why the API matches issued keys as whole strings rather than trusting the layer beneath. Run it once against R2 so that answer is measured rather than assumed. It leaves two small objects behind under `probe-victim-*` and `probe-attacker-*` prefixes; delete them from the bucket afterwards.

---

## 7 · When the app cannot reach the server

Symptoms come from the phone: pull-to-refresh fails within 10 seconds with a stated reason, and captured receipts queue in the on-phone outbox rather than being lost. Nothing is lost while the server is down - that is what the outbox is for.

In order:

1. `curl -i https://api.keptapp.net/api/me` - 401 means the server is fine and the problem is the phone's network.
2. On the VM, `docker compose -f /opt/kept/server/ops/prod/docker-compose.prod.yml ps` and `... logs --tail 100 api` - a startup refusal names either the environment variable that is missing or wrong, or the backing service that did not answer (§0). `systemctl status cloudflared` is the other half: the app can be healthy and unreachable if the connector is down (a **530** at the edge).
   A machine that keeps restarting with `Database at ... did not answer` or `Object storage did not answer at ...` is telling you the secret is wrong or the service is down, not that the app is broken.
   The container log also carries **one JSON line per request**: `{"msg":"request","method":...,"route":...,"status":...,"durationMs":...,"sessionPresented":...,"authenticated":...}`.
   `sessionPresented` is whether a bearer credential arrived at all; `authenticated` is whether it was accepted - "the client stopped sending a token" and "we are rejecting every token" separate on the first, not the second.
   Expect a steady `route: "/health"` line every 30 seconds: that is the compose healthcheck (§1), not traffic.
   That is how you tell "the phone is not reaching us at all" (no lines) from "we are refusing it" (401s) from "we are answering and the phone is unhappy" (200s).
   `route` is the matched pattern, never the requested path, and the line carries no receipt id, no search term, no user id and no token - so a request cannot be traced to a person from the log alone, deliberately.
   ⚠ A request refused **before** routing carries its own label since 2026-08-20: the edge-secret 403 logs `route: "refused:edge-secret"` and the 1 MiB body limit's 413 logs `route: "refused:body-limit"`, so a Cloudflare transform rule that stops adding the header shows up as a run of `refused:edge-secret` lines rather than blending into 404 noise. `route: "unmatched"` now means a genuine 404 and nothing else. *(Before this date all three shared `"unmatched"` and only the status code separated them.)*
3. Cloudflare dashboard - a 5xx page with a Cloudflare ray id means the edge is up and the origin is not.
4. Neon console - the app cannot start without a reachable database. (That sentence was aspirational until 2026-08-11 and is now literally true: see §0's startup probes.)

A shipped iOS build has **no server-settings screen**, by design: its address is fixed at `https://api.keptapp.net` and cannot be redirected from the phone. Moving the API to another host means an app update.
