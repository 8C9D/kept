# Kept backup watch

A dead man's switch for the backup. A backup job that never starts reports nothing,
which is how it once failed silently for weeks. This Worker runs by itself once a
day at 12:00 UTC and asks the bucket, not the job, whether anything arrived.

It runs on a Durable Object alarm that re-arms itself, because the account has no
cron trigger slots free. It is not deployed by anything in this repository, and its
only route answers 404 without the `WATCH_TOKEN` secret.

## What it checks

It lists `pg/` and `manifests/` in the `kept-backups` bucket, read only, and takes
the newest object under each by R2's upload date. A hand-run key such as
`pg/kept-20261002-manual-231052.dump` counts the same as a scheduled one.

It sends an email when:

- the newest dump or manifest is older than `MAX_AGE_HOURS` (default 48);
- there are none at all;
- the newest one is 0 bytes;
- the bucket cannot be read, or `MAX_AGE_HOURS` is not a positive number. The error
  is rethrown after the email, so the run also shows as failed in Cloudflare.

The manifest is checked as well because it is written last: a run whose dump arrived
and whose image leg failed leaves a fresh dump over a stale manifest.

The email holds ages, object keys and sizes, and the next step,
`npm run db:backup-status`. A listing holds no receipt contents. A healthy run logs
one line and sends nothing, so silence means healthy only as long as the Worker
itself is running. `POST /check` answers with the next alarm, so that is the way to
look, now and then.

## Deploy

From this directory, logged in with `wrangler login`:

```sh
npx wrangler deploy
npx wrangler secret put ALERT_TO
npx wrangler secret put WATCH_TOKEN
```

⚠ **Then arm it, once.** An alarm does nothing until the first request sets it, and
after that it re-arms itself, across deploys:

```sh
curl -X POST -H "x-watch-token: $TOKEN" https://kept-backup-watch.<subdomain>.workers.dev/check
curl -X POST -H "x-watch-token: $TOKEN" 'https://kept-backup-watch.<subdomain>.workers.dev/check?test=1'   # also sends a test mail
```

Each answers `{"nextRunAt": ...}`, the next 12:00 UTC.

`ALERT_TO` is the address to alert. It has to be a verified destination address in
Email Routing, and it is a secret because this repository is public: never put it
in `wrangler.toml`. Until it is set, every run fails on purpose. The sender is the
`ALERT_FROM` var. No DNS change is needed where Email Routing is already enabled.

Sent mail shows as "dropped" in the Email Routing summary even when it was
delivered. Cloudflare's Email Sending logs are the place to look.

## Try it locally

```sh
npx wrangler dev --local --var ALERT_TO:someone@example.com --var WATCH_TOKEN:local
curl -X POST -H 'x-watch-token: local' http://localhost:8787/check
```

This uses a local, empty R2 and a simulated send, so it reports that there are no
dumps and prints the email instead of sending it. The logic's tests are in
`server/tests/unit/backupWatch.test.ts`.
