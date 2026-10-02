# Moving the API origin to an Azure for Students VM — plan, 2026-10-02, nothing run

**Status, 2026-10-02:** plan only. The owner ruled Oracle out (`2026-09-03-free-hosting.md`, status note), asked for the free option that best fits the app, and is signing up for Azure for Students himself. **Nothing has been deployed, no DNS has changed, no secret has moved; Fly still serves production.** When the migration is actually run it gets a `docs/DECISIONS.md` entry and the spec §4.2 deployment row is amended in the same commit.

The requirements any host must keep are §1 of `2026-09-03-free-hosting.md` and are not repeated here.

---

## 1 · Why Azure for Students

It is the only free option left that is always on, gives CPU after the response, and needs no code change.

| Host | Why not |
|---|---|
| Google Cloud `e2-micro` | The VM is always free but its external IPv4 is billed at $0.005/h (about $3.65/month), and IPv6-only is impossible: the Neon endpoint and `appleid.apple.com` have no AAAA record (checked 2026-10-02). Cheapest permanent option, not free. |
| Google Cloud Run | Free, 2 GiB, but scales to zero and throttles CPU after the response; needs a Worker in front and code changes for exports and the sweep. |
| Render / Koyeb free | 512 MB and 0.1 CPU; Render sleeps after 15 minutes. |
| Fly at 1 GB | About $9.60/month list in `yyz`. |

**What the offer gives:** $100 credit per 12 months, no card; 750 h/month each of B1s, B2ats v2 and B2pts v2 Linux VMs (all 1 GiB); two 64 GB P6 disks; renewable each year while a student.

**What it costs in risk, stated:**

- **It lapses.** Renewal is manual every 12 months. When the year ends unrenewed, or the credit reaches zero, the subscription is disabled and the API is down. The Fly fallback in §5 exists for this.
- **It ends at graduation.** After that it is pay-as-you-go (a B1s is about $7.60/month) or another move.
- **1 GiB, not 2.** See §2.

## 2 · Is 1 GiB enough

Yes, with swap. All 238 production images total 155 MB (backup of 2026-09-01). Spec §4.2 measured peak RSS at roughly 2.8× the export payload over a ~200 MiB baseline, so an export of everything peaks near 0.6 GiB. The 2 GB provision was sized for an export at the full 256 MiB budget, which would peak near 0.9 GiB and lean on swap here.

The export byte budget is **not** lowered by this plan. An export that large would be slow on swap, not fatal. Revisit when one fiscal year's images pass roughly 200 MB.

## 3 · The VM

- **Size:** `Standard_B2ats_v2` (2 vCPU, 1 GiB, x86) if the subscription has quota for it; `Standard_B1s` (1 vCPU, 1 GiB) otherwise. Student subscriptions are reported to lack B2 v2 quota in some regions.
- **Region:** the allowed region nearest Neon (`aws-us-east-2`, Ohio): East US 2, then East US, then Central US, then Canada Central. Student subscriptions carry an allowed-regions policy; the list is visible only after signup.
- **Image:** Ubuntu Server 24.04 LTS. **Disk:** 64 GB P6 Premium SSD (the free size).
- **Network:** one Standard static public IPv4, needed for outbound traffic and SSH. It is not free: about $3.65/month, roughly $44 of the $100 yearly credit. Inbound rule: SSH (22) only, key-only. No 80/443; the Cloudflare Tunnel is the only way in to the API.
- **Budget alert** on the subscription at $60 of credit used.

## 4 · What changes in the repo

Small, and all in `server/ops/prod/`:

- `docker-compose.prod.yml`: `mem_limit: 2g` becomes `mem_limit: 900m` with `memswap_limit: 2g`, and the "2 GB, measured" comment is rewritten with §2's reasoning.
- `bootstrap-vm.sh`: create a 2 GB swapfile; drop "aarch64" and the `ubuntu` user from the header (Azure's default user is `azureuser`; the script already uses `$USER`).
- `deploy.sh`: unchanged. **To rehearse:** the image build (`npm ci` under `docker build`) on a 1 GiB machine. If it is killed or takes minutes, build on the laptop for `linux/amd64` and ship it with `docker save | ssh … docker load` instead.
- `server/fly.toml` and the test that reads it stay until Fly is destroyed.

Runbook, root `CLAUDE.md` topology, README and spec §4.2 change in the migration commit, as listed in `2026-09-03-free-hosting.md` §3 ("What changes in the Runbook" applies as written; the host is the only difference).

## 5 · Steps

Owner's steps are marked **(owner)**. Everything else can be done in a session once the owner asks for it.

1. **(owner)** Sign up for Azure for Students with the school email. This is the real eligibility check.
2. **(owner)** Create the VM per §3 with a new SSH public key (generated locally at that point), and set the budget alert. Or hand a session Azure CLI access to do it.
3. Run `bootstrap-vm.sh` over SSH; confirm Docker, compose and `cloudflared` versions and that swap is active.
4. **(owner)** Fill `/etc/kept/kept.env` on the VM with the values Fly holds (`kept.env.example` lists the names). No secret passes through a session.
5. **(owner)** `sudo cloudflared service install <token>` for the existing tunnel `kept-api`, and extend the edge-secret Transform Rule to `api-next.keptapp.net` in the dashboard.
6. `deploy.sh <host> <commit>` with the commit Fly is running. No `--migrate`: the schema is already current.
7. Verify against `https://api-next.keptapp.net`: `/health` 200; `/api/me` 401 with the JSON body and `Cache-Control: no-store`; one authenticated request from a session the owner mints; boot log shows the storage probe and `Kept API listening on port 3000`.
8. **(owner asks)** Point the `kept-api` tunnel's public hostname at `api.keptapp.net` and flip the proxied CNAME from `keptapp-api.fly.dev` to the tunnel. Keep the overlap with Fly to minutes (two parse sweeps overlapping is unverified).
9. Watch the VM's request log for real traffic, then `fly scale count 0`. **Fly is kept for 30 days, not destroyed** (ruling of 2026-09-04): pointing the CNAME back and `fly scale count 1` restores service in minutes.
10. After 30 stable days: destroy the Fly app, remove the `api-next` route, retire `fly.toml`, and land the DECISIONS entry with the doc changes.

**Rollback at any point before step 10:** CNAME back to `keptapp-api.fly.dev`, `fly scale count 1`. Neon and R2 are shared by both origins, so there is no data to move either way.

## 6 · After the move

- A calendar reminder 11 months after signup to renew the student offer, and a check of remaining credit each month for the first three.
- `/etc/kept/kept.env` goes into the password manager; it now holds what Fly secrets held.
- OS and Docker updates are the owner's (`unattended-upgrades` is enabled by the bootstrap).

## 7 · Not verified

- That this school domain passes Azure's automatic student verification.
- Which regions and VM sizes the student subscription allows.
- That the free VM hours and P6 disks reset on yearly renewal (secondary sources only). If they do not, year two costs about $91 for a B1s plus $44 for the IP, more than the $100 credit.
- Image build time and memory on a 1 GiB VM.
- Sweep behaviour with two origins overlapping at cutover.

## Sources

Azure for Students: <https://azure.microsoft.com/en-us/free/students>, <https://learn.microsoft.com/en-us/azure/education-hub/azure-dev-tools-teaching/azure-students-program>, offer terms <https://azure.microsoft.com/en-us/pricing/offers/ms-azr-0170p>. Free services list: <https://github.com/MicrosoftDocs/azure-docs/blob/main/articles/cost-management-billing/manage/create-free-services.md>. Student quota report: <https://learn.microsoft.com/en-us/answers/questions/1440468/no-b2ats-v2-and-b2pts-v2-quota-for-azure-student>. Google Cloud: <https://docs.cloud.google.com/free/docs/free-cloud-features>, <https://cloud.google.com/vpc/pricing-announce-external-ips>. Fly: <https://docs.fly.io/about/pricing>.
