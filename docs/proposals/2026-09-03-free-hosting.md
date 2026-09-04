# Moving the API origin off Fly to free hosting — assessed 2026-09-03, not yet migrated

**Status, 2026-09-03:** assessment only. The owner asked for a recommendation, not a migration, and chose the preferred path the same day: **Oracle Cloud Always Free Arm VM, container unchanged, reached through a Cloudflare Tunnel**, with the Oracle account upgraded to Pay As You Go so idle reclamation cannot stop the machine, and a cutover rehearsed on a temporary hostname before the CNAME moves. **Nothing has been deployed, no DNS has changed, no secret has moved.** When the migration is actually run it gets a `docs/DECISIONS.md` entry and the spec §4.2 deployment row is amended in the same commit, per the doc-ownership rule; this file is the reasoning that entry will point at.

**Why now.** The Fly machine `keptapp-api` (`server/fly.toml`: `shared-cpu-1x`, 2 GB, never scaled to zero) costs about $14/month at list price, for an API serving two people. Fly no longer offers a free allowance.

---

## 1 · What the deployment actually needs

Read off `server/fly.toml`, `server/Dockerfile`, `server/src/index.ts`, `server/CLAUDE.md` and `docs/Runbook.md`. These are the properties any replacement has to keep, and they are what rules most free tiers out.

- **One long-lived Node 24 process** built from `server/Dockerfile`, running the same entrypoint development runs (`node --import tsx src/index.ts`), listening on `PORT` (default 3000). Nothing in the image is Fly-specific; `fly.toml` is not even copied into it.
- **Outbound HTTPS to Neon and R2 at boot.** The process refuses to bind the port until both answer: five database attempts a second apart with a 5 s cap each, then a 10 s storage cap. Worst case is about 25 s while a Neon compute wakes, which is why `fly.toml` gives the health check a 60 s grace period. Any host's startup probe needs the same.
- **CPU after the response has been sent.** Export generation runs *after* the 202 (`src/routes/exports.ts`), and the LLM parse sweep is kicked fire-and-forget after each capture (`src/routes/receipts.ts`) and on a six-hour `setInterval`. A host that throttles CPU between requests stalls both.
- **Memory sized to the export budget.** Spec §4.2: a 250 MiB export peaked at **891 MiB RSS**, roughly 2.8× the payload, and the ratified provision is 2 GB. Every 512 MB free tier is out on this alone.
- **Never scale to zero.** `fly.toml` records why: a cold start on pull-to-refresh reads as the iOS client's 10 s honest-failure timeout, and captured receipts queue in the outbox as if the server were down.
- **A liveness route** (`GET /health`, constant 200, registered above the edge-secret middleware) and a shutdown that drains in-flight requests inside the platform's kill window (3 s drain + 1 s pool close against Fly's 5 s default).
- **Twelve secret names** set once on the platform (Runbook §0), never in the repo.
- **The hostname cannot move.** `https://api.keptapp.net` is compiled into the iOS build (`ios/Kept/Config/ServerConfig.swift`) and the web client (`web/src/api.ts`). It is a proxied Cloudflare CNAME; Cloudflare carries the rate limiter and a Transform Rule that adds `x-kept-edge-secret`. Only what the record points at can change.
- **Migrations already run from the laptop** against Neon's direct endpoint (Runbook §2): the in-machine `fly ssh console` path failed both ways recorded there. **Backups already run from the laptop** too (§4). Neither Neon nor R2 is touched by moving the origin.

## 2 · Options weighed

| Host | Memory | Always on | CPU after response | `api.keptapp.net` through the Cloudflare proxy | Verdict |
|---|---|---|---|---|---|
| **Oracle Cloud Always Free, `VM.Standard.A1.Flex`** | 2 OCPU / 12 GB (cut from 4 / 24 on 2026-06-15) | yes | yes | Cloudflare Tunnel, native | **preferred** |
| **Google Cloud Run** | configurable to 2 GiB | only with `min-instances ≥ 1`, which is paid | throttled under request-based billing; instance-based billing fixes it and bills idle time | domain mapping's certificate provisioning and renewal fail while the record is proxied; needs a Worker in front | fallback |
| Render free | 512 MB, 0.1 CPU | sleeps after 15 min idle, ~1 min to wake | while awake | fine | blocked: memory, wake time |
| Koyeb free | 512 MB, 0.1 CPU | sleeps after 1 h idle, cannot be disabled | while awake | fine | blocked: same |
| Cloudflare Workers | 128 MB per isolate | n/a | n/a | native | rejected already, spec §4.2 (export memory) |

Cheaper-but-not-free, for completeness: stay on Fly at 1 GB (about $5/month), the size the spec calls "little margin" for a single export.

## 3 · Preferred: Oracle A1 + Docker + Cloudflare Tunnel

**Why this one.** It is the only free option that keeps every property in §1 without a code change: always on, six times the memory the export budget needs, real CPU for the post-response work, the same Dockerfile and the same entrypoint. Cloudflare Tunnel (free, no limits on the plan) means the origin has **no public port at all** — the "two-door building" problem spec §4.2 solved with the edge secret goes away structurally, and the rate limiter and Transform Rule keep working unchanged because Cloudflare is still the only way in.

### What changes in the repo

- **`server/Dockerfile`, `src/index.ts`: nothing.** The image is multi-arch (`node:24-slim` has an arm64 build), so it runs on A1 as-is.
- **`server/fly.toml` retires.** The comments it carries (why never scale to zero, why the health check is liveness-only, why 2 GB) move to the compose file so the reasoning survives the file.
- **New `server/ops/prod/`:**
  - `docker-compose.prod.yml` — builds the image from the Dockerfile; `env_file: /etc/kept/kept.env` (mode 600, root-owned, the same twelve names Fly secrets held); `restart: unless-stopped` (Fly's restart-on-exit, which `src/storage/s3ObjectStorage.ts` notes the boot probes rely on); `mem_limit: 2g`; the port bound to `127.0.0.1:3000` only; a healthcheck that curls `/health` on the same cadence as today; and a second service running `cloudflared` with the tunnel token, pointing at `api:3000`.
  - `deploy.sh` — from the laptop: ssh in, check out a pinned commit, build an image tagged by commit sha, optionally run `npm run db:migrate` **from that new image** (see the Runbook change below), then `docker compose up -d`, then the Runbook §1 confirmation `curl`.
- **One operator-facing string:** `src/db/drizzleDatabaseUrl.ts`'s refusal tells the reader to check `fly secrets list`; it should name the env file instead. The other Fly mentions are comments and test prose (`index.ts`, `app.ts`, `productionEnv.ts`, `observability/requestLog.ts`, `storage/s3ObjectStorage.ts`, three integration tests) and change wording only. Docker's default stop timeout is 10 s against Fly's 5 s, so the existing drain fits with room.

### What changes in the Runbook

Every `fly` command in §0–§7 becomes ssh + compose. The substantive changes:

- **§0** — secrets live in `/etc/kept/kept.env` on the VM; "change a secret" is edit the file, `docker compose up -d`, watch the boot log for the same lines as today.
- **§1 deploy** — `deploy.sh` replaces `fly deploy`; the confirmation stays the same `curl … /api/me → 401`, with `docker compose ps` and `docker compose logs` replacing `fly status` and `fly logs`.
- **§2 migrations** — gains a real in-machine path for the first time: **build the new image, run `db:migrate` from it, then swap.** That is exactly the sequence 2026-09-01 needed and could not have, because the deployed image by definition lacked the migration it was asked to run. The laptop-against-direct-endpoint path stays as the alternative; the verification rule ("read `drizzle.__drizzle_migrations` and the schema, never the migrate command's exit line") is unchanged.
- **§3 rollback** — images are tagged by commit sha, so rollback is `docker compose up -d` against the previous tag.
- **§4 restore for real** — step 1 `fly scale count 0` becomes `docker compose stop api`; step 4 edits `DATABASE_URL` in the env file.
- **§5 Cloudflare** — the CNAME target changes (below); the origin-lock paragraph gets a sentence saying the tunnel makes the lock structural and the secret stays as defence in depth.
- **§7** — `fly logs` becomes `docker compose logs`; the JSON request lines are unchanged.

Outside the Runbook, in the same commit as the DECISIONS entry: root `CLAUDE.md`'s "Production topology" paragraph, the three README lines naming Fly, and the spec §4.2 deployment row.

### What changes in DNS

**One record.** The proxied CNAME for `api.keptapp.net` moves from `keptapp-api.fly.dev` to the tunnel's `<tunnel-id>.cfargotunnel.com`. It stays orange-cloud. The rate limiting rule and the Transform Rule are untouched. No iOS build, no web deploy.

**Cutover, as the owner chose it:**

1. VM up, tunnel up, env file in place; tunnel route for a **temporary hostname** `api-next.keptapp.net` with the same Transform Rule applied to it.
2. Runbook §1 confirmation against `api-next` (401 with the JSON body and `Cache-Control: no-store`), plus one authenticated request from a session the owner mints.
3. Flip the `api.keptapp.net` CNAME to the tunnel. Proxied records propagate at the edge immediately.
4. Watch the request log on the VM for real traffic; watch Fly for it to go quiet.
5. Destroy the Fly app, which is when the bill stops. Remove the `api-next` route.

Both origins share Neon and R2, so a short overlap is safe for exports (one-live-export-per-user is a database index, not process state). **Not verified:** that two parse sweeps overlapping are harmless. Keep the overlap to minutes.

### Tradeoffs, stated

- **No cold starts.** The Neon wake on first request after autosuspend is unchanged from today.
- **Idle reclamation is the real trap.** Oracle deems an Always Free instance idle over a 7-day window when the 95th-percentile CPU, network *and* memory utilisation are all under 20 %. A two-user API is idle by that definition every week. Oracle's documented remedy is **upgrading the account to Pay As You Go**: still $0 within the Always Free limits, exempt from reclamation, a card on file, and charges only above the limits. **the owner chose the upgrade, with a budget alert set.** Without it, expect the VM to be stopped some week, and to find out from the outbox.
- **Capacity.** "Out of host capacity" for A1 is common and the home region is fixed at signup. **Check Neon's region first** (not recorded in the docs; the Neon console has it) and pick the Oracle region nearest it — per-query latency to Postgres matters more than proximity to Toronto, which is what `yyz` bought.
- **You are the sysadmin.** OS updates (`unattended-upgrades`), Docker updates, the SSH key, the tunnel token. Fly's HTTP check is replaced by the compose healthcheck; a hung-but-alive process needs a small timer to restart an unhealthy container if parity is wanted. Fly's log retention is replaced by Docker's, which is local to the VM.
- **Backup and restore: nothing changes for the data.** Neon and R2 stay where they are; the nightly dump path and `~/.kept/backup.env` are untouched. The VM is stateless — git, the env file, the tunnel token — so the new thing to back up is **`/etc/kept/kept.env`**, into the password manager, because it now holds what Fly secrets held. The R2 `kept-backups` token remains owed regardless (Runbook §0).
- **The tier can shrink.** Oracle cut A1 from 4 OCPU / 24 GB to 2 / 12 in June 2026 and terminated over-limit instances in August. The API needs a sixth of what remains; a further cut would have to reach 2 GB before it bites.

## 4 · Fallback: Cloud Run behind a Cloudflare Worker

If Oracle blocks — signup or card verification refused, no A1 capacity in any acceptable region — Cloud Run is the free host that at least carries the memory.

- **Configuration:** 2 GiB / 1 vCPU, `min-instances 0`, startup CPU boost, startup probe timeout raised to cover the boot probes. Request-based free tier: 360,000 GiB-seconds/month, i.e. 50 hours of a 2 GiB instance actually serving; two users use minutes.
- **Custom domain:** not Cloud Run's own domain mapping — its Google-managed certificate cannot be provisioned or renewed while the record is proxied, and grey-clouding it would forfeit the rate limiter and DDoS protection that motivated Cloudflare-in-front. Instead a free **Cloudflare Worker** on the `api.keptapp.net` route proxies to the `run.app` URL and adds `x-kept-edge-secret` itself from a Worker secret. Rate limiting rules evaluate before Workers, so the limiter still applies.
- **What it costs in behaviour:** a cold start of several seconds plus the Neon wake, measured against the client's 10 s timeout, on every first request after idle; and **CPU throttled after the response**, so export generation and sweep kicks stall until the next request arrives. Instance-based billing (CPU always allocated) fixes the throttling but bills the instance for roughly 15 minutes after each burst; its free tier (450,000 GiB-seconds) makes **1 GiB** the setting that stays inside it, and 1 GiB is the "little margin" size. A keep-warm pinger makes it always on, which is paid again — the fly.toml comment applies in full.
- **Repo and Runbook:** Dockerfile unchanged; deploy is `gcloud run deploy --source server/`; secrets in Secret Manager; migrations laptop-only, or a Cloud Run Job built from the same image. The Runbook rewrite is the same size as §3's.

## 5 · Not verified in this session

- Neon's region (needed to choose the Oracle region).
- Sweep behaviour with two processes overlapping during cutover.
- Current A1 capacity in `ca-toronto-1` / `ca-montreal-1`.
- The actual Fly invoice versus the list price used above.

## Sources

Fly pricing: <https://fly.io/docs/about/pricing/>. Cloud Run pricing and domain mapping: <https://cloud.google.com/run/pricing>, <https://docs.cloud.google.com/run/docs/mapping-custom-domains>. Oracle Always Free entitlements and idle rule: <https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm>. Render: <https://render.com/docs/free>. Koyeb: <https://www.koyeb.com/docs/reference/instances>, <https://www.koyeb.com/docs/run-and-scale/scale-to-zero>. Cloudflare Tunnel: free on every plan, <https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/>.
