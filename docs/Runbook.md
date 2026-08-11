# Kept - operations runbook

Written for someone who was not in the session that wrote it, including the owner in six months.

This covers the deployed system: how to deploy, how to run a migration, how to roll back, and how to take and restore a backup.
The one-time setup that creates the accounts and secrets is not here - it is the ordered checklist in `docs/gates/wave-6.md` §3, and it runs once.

**The shape of the thing.**
An iPhone app and (later) a web client talk to one Node process on Fly.io, which talks to Postgres on Neon and object storage on Cloudflare R2.
Cloudflare sits in front of the origin and carries the rate limiter.
Spec §4.2 has the reasoning; this file has the commands.

---

## 0 · What holds what

| Thing | Where it lives | Who can see it |
|---|---|---|
| Application secrets | Fly secrets (`fly secrets list` shows names, never values) | The owner |
| Local development config | `server/.env.local`, gitignored | The owner |
| Database | Neon | The owner |
| Receipt images and export zips | Cloudflare R2, bucket `kept` | The owner |
| DNS, proxy, rate limiter | Cloudflare, zone `keptapp.net` | The owner |

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
| `STORAGE_ENDPOINT` | yes in production | R2 S3 API endpoint, `https://<account-id>.r2.cloudflarestorage.com` |
| `STORAGE_BUCKET` | yes in production | `kept` |
| `STORAGE_ACCESS_KEY_ID` | yes in production | R2 API token access key |
| `STORAGE_SECRET_ACCESS_KEY` | yes in production | R2 API token secret |
| `STORAGE_REGION` | no | Defaults to `auto`, which is right for R2 |
| `EDGE_SHARED_SECRET` | no, but see below | Any random string. When set, the origin serves only requests carrying it in `x-kept-edge-secret`, which Cloudflare adds. Unset, the origin answers anyone who finds its `fly.dev` hostname |
| `PORT` | no | Defaults to 3000 |
| `NODE_ENV` | set by the Dockerfile | `production` turns on the deployed-shape checks in `src/productionEnv.ts` |

**Under `NODE_ENV=production` the server additionally refuses to start** if storage is unconfigured (there is no MinIO to fall back to), if `STORAGE_ENDPOINT` is not https (presigned URLs inherit it, so plain http would send receipt images in the clear), if `DATABASE_URL` is a loopback address, if the session secret is under 32 characters, or if `ANTHROPIC_API_KEY` is unset.

**And in every environment the server refuses to start unless both backing services answer.** Added 2026-08-11; before that, every check above asked whether a value was *present and well-shaped*, and none asked whether the service it named was *there*.
A wrong `DATABASE_URL` password produced a process that printed `Kept API listening on port 3000`, answered the `curl .../api/me` → 401 check in §1 (that path never opens a database connection), and returned 500 to every authenticated request.

- **The database** is probed with `select 1`, retried up to five times a second apart with a 5-second cap on each attempt, so a Neon compute waking from autosuspend is waited for rather than crashed on. If it never answers, the process prints `Database at <host>:<port> did not answer, so this process is refusing to serve` and exits 1. The host and port are named; the URL is not, because it carries the password.
- **Object storage** is probed with a read-only `HeadBucket` - it never creates a bucket - with a 10-second cap. If it does not answer, the process names the endpoint and bucket and exits 1.

Both refusals happen **before the port is bound**, so a machine in this state is not listening at all, rather than listening and failing.
⚠ Neither of these is an "environment variable is missing" refusal, so when §7 step 2 sends you to `fly logs`, expect one of these two sentences as well as the variable-name ones.

---

## 1 · Deploy

From `server/`:

```sh
fly deploy
```

That builds `Dockerfile`, ships it, and rolls the machine.
The image runs the same entrypoint local development runs (`node --import tsx src/index.ts`) - deliberately, so the deployed process is not a second code shape that only exists in production.

**Migrations do not run on deploy.** See §2.

### Confirm the deploy is real

An exit code is not evidence, and neither is a health check that proves only that a process is listening.

```sh
fly status                       # one machine, state "started"
fly logs                         # expect: Kept API listening on port 3000
curl -i https://api.keptapp.net/api/me
```

The last one must answer **401** with a JSON body `{"error":{"code":"unauthorized",...}}` and a `Cache-Control: no-store` header.
A 401 is the correct answer - it proves routing, TLS, the app, and the auth middleware all ran.
A 403 with `{"error":{"code":"forbidden"}}` means `EDGE_SHARED_SECRET` is set on the origin but Cloudflare is not adding the header; fix the transform rule (§5) rather than unsetting the secret.
A 502 or a Cloudflare error page means the origin is down - check `fly logs` for a startup refusal, which names what is missing.

### Change a secret

```sh
fly secrets set SESSION_JWT_SECRET="$(openssl rand -base64 48)"
```

`fly secrets set` restarts the machine by itself.
⚠ Changing `SESSION_JWT_SECRET` invalidates every existing session; everyone signs in again.
To sign one person out without touching the secret, bump their `token_version` instead (§6).

---

## 2 · Migrations

**Migrations are run deliberately, never on boot.** A process that migrates as it starts will, on the day a migration is wrong, run it once per restart while the app is down.

```sh
fly ssh console -C "npm run db:migrate"
```

`drizzle-kit migrate` reads `DATABASE_URL` from the machine's environment, applies only what has not been applied, and records each one.

Run it **after** `fly deploy` when a migration only adds things (a new nullable column, a new table, a new index), and **before** the deploy when new code cannot run without it.
Wave 6 needs neither: the schema is unchanged since `0003_one-active-export-per-user`.

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
fly releases                     # find the previous version
fly releases rollback            # or: fly deploy --image <previous image ref>
```

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

### Restore it, and verify the restore

**Never restore into the live database to check a backup.** Restore into a scratch one and compare.

```sh
# 1. A scratch database. On Neon, create a new branch or a new database in the console;
#    locally, this is one command against the dev container:
docker exec kept-db psql -U kept -d postgres -c "create database kept_restore_drill;"

# 2. Restore into it.
docker run --rm -v "$PWD:/in" postgres:16 \
  pg_restore -d "<scratch database url>" /in/kept-20260807.dump

# 3. Verify - this is the step that makes it a tested backup rather than a completed command.
cd server
SOURCE_DATABASE_URL="<the database the dump came from>" \
RESTORED_DATABASE_URL="<the scratch database>" \
STORAGE_ENDPOINT=... STORAGE_BUCKET=... STORAGE_ACCESS_KEY_ID=... STORAGE_SECRET_ACCESS_KEY=... \
npm run db:verify-restore
```

Step 3 compares row counts per table between the two databases, then takes every live receipt image row in the **restored** database, downloads the object behind it, and checks that the bytes hash to the digest that row carries.
The digest is the part that matters: a key that resolves proves an object is there, and only the hash proves it is the right object.
It exits non-zero and names every problem if anything fails, and it refuses to report success if the restored database holds no images at all - a restore verified against zero images has verified nothing.

It is read-only on both databases and on storage, so it is safe to point at production.

Then drop the scratch database.

### If you actually have to restore for real

1. Stop the app so nothing writes during the restore: `fly scale count 0`.
2. Restore into a **new** database, never over the damaged one - the damaged one is evidence, and it may hold rows the backup does not.
3. Verify it with `npm run db:verify-restore` as above.
4. Point the app at it: `fly secrets set DATABASE_URL="<new url>"`.
5. `fly scale count 1`, then re-run the §1 confirmation.

---

## 5 · Cloudflare

Cloudflare is in front of the origin for two things: **the rate limiter** §10B has asked for since the beginning, and DDoS protection.

- **DNS.** `api.keptapp.net` is a proxied (orange-cloud) CNAME to the Fly app hostname. Proxied is the whole point; grey-cloud sends traffic straight to the origin and none of the below applies.
- **Rate limiting rule.** One rule, on `api.keptapp.net`, counting by IP. The Free plan allows exactly one rate limiting rule with a 10-second window, which is enough: the endpoint worth limiting is `POST /api/auth/apple`, the only route reachable without a session.
- **The origin lock.** A Transform Rule adds a request header `x-kept-edge-secret` with the value of `EDGE_SHARED_SECRET`. Without this, `kept-api.fly.dev` remains reachable directly and the rate limiter guards one door of a two-door building. Set the Fly secret and the transform rule together, in that order (origin first tolerates the header before it requires it; the reverse locks you out for the seconds in between).

Rotating the edge secret: set the new value in the Cloudflare transform rule first, then `fly secrets set EDGE_SHARED_SECRET=...`. Requests carrying an old value are refused with 403, not 500.

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

**Look at what is in there.** `fly ssh console` then `psql "$DATABASE_URL"`, or the Neon console.

**Parser accuracy** (§7.3's measurement, which accrues through ordinary use):

```sh
npm run parse-accuracy
```

⚠ **`npm run db:seed` and `npm run db:claim` refuse to run against anything that is not a loopback database**, deliberately and unarguably. They rewrite tax records. Neon hostnames are remote by construction, so neither can ever touch production. Do not add an escape hatch.

**The key-normalization probe.** `npm run storage:probe-keys` measures whether an object store resolves keys that walk out of a user's prefix. Against MinIO the answer is "dot segments no, a leading slash yes" - the same class of input, opposite outcomes, which is why the API matches issued keys as whole strings rather than trusting the layer beneath. Run it once against R2 so that answer is measured rather than assumed. It leaves two small objects behind under `probe-victim-*` and `probe-attacker-*` prefixes; delete them from the bucket afterwards.

---

## 7 · When the app cannot reach the server

Symptoms come from the phone: pull-to-refresh fails within 10 seconds with a stated reason, and captured receipts queue in the on-phone outbox rather than being lost. Nothing is lost while the server is down - that is what the outbox is for.

In order:

1. `curl -i https://api.keptapp.net/api/me` - 401 means the server is fine and the problem is the phone's network.
2. `fly status` and `fly logs` - a startup refusal names either the environment variable that is missing or wrong, or the backing service that did not answer (§0).
   A machine that keeps restarting with `Database at ... did not answer` or `Object storage did not answer at ...` is telling you the secret is wrong or the service is down, not that the app is broken.
   `fly logs` also carries **one JSON line per request**: `{"msg":"request","method":...,"route":...,"status":...,"durationMs":...,"authenticated":...}`.
   That is how you tell "the phone is not reaching us at all" (no lines) from "we are refusing it" (401s) from "we are answering and the phone is unhappy" (200s).
   `route` is the matched pattern, never the requested path, and the line carries no receipt id, no search term, no user id and no token - so a request cannot be traced to a person from the log alone, deliberately.
   ⚠ A request refused **before** routing - the edge-secret 403 and the 1 MiB body limit's 413 - reports `route: "unmatched"`, the same as a 404. The status code is what separates them.
3. Cloudflare dashboard - a 5xx page with a Cloudflare ray id means the edge is up and the origin is not.
4. Neon console - the app cannot start without a reachable database. (That sentence was aspirational until 2026-08-11 and is now literally true: see §0's startup probes.)

A shipped iOS build has **no server-settings screen**, by design: its address is fixed at `https://api.keptapp.net` and cannot be redirected from the phone. Moving the API to another host means an app update.
