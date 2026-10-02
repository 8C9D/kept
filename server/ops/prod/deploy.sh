#!/usr/bin/env bash
# Deploy a pinned commit of the Kept API to the production VM, from the laptop.
#
#   server/ops/prod/deploy.sh <ssh-host> <commit-ish> [--migrate]
#
# What it does on the VM, in order: fetch and check out the commit under
# /opt/kept; build the image from server/Dockerfile tagged with the commit's
# short sha; with --migrate, run `npm run db:migrate` FROM THAT NEW IMAGE
# before anything is swapped (Runbook §2: the migration a deploy needs is in
# the image being deployed and not in the one running, which is why the old
# `fly ssh console` path reported success having applied nothing on
# 2026-09-01); then `docker compose up -d`, which replaces the running
# container with the new image and leaves the old image on disk.
#
# Rollback is the same script with the previous commit and no --migrate: the
# image is already built, so the swap is immediate. Rolling back past a
# migration does not roll the migration back (Runbook §3).
#
# This script proves nothing on its own. After it returns, run the Runbook §1
# confirmation - `curl -i https://api.keptapp.net/api/me` must answer 401 -
# and, after --migrate, read drizzle.__drizzle_migrations and the schema.
# An exit code is not evidence.
set -euo pipefail

if [ $# -lt 2 ] || [ $# -gt 3 ]; then
  echo "usage: $0 <ssh-host> <commit-ish> [--migrate]" >&2
  exit 2
fi
HOST=$1
COMMIT=$2
MIGRATE=${3:-}
if [ -n "$MIGRATE" ] && [ "$MIGRATE" != "--migrate" ]; then
  echo "unknown option: $MIGRATE (only --migrate is accepted)" >&2
  exit 2
fi

ssh "$HOST" bash -s -- "$COMMIT" "$MIGRATE" <<'REMOTE'
set -euo pipefail
COMMIT=$1
# ssh joins its arguments into one string, so an empty second argument never
# arrives; without the default, `set -u` aborts every deploy without --migrate.
MIGRATE=${2:-}
cd /opt/kept
git fetch --quiet origin
git checkout --quiet --detach "$COMMIT"
SHA=$(git rev-parse --short=12 HEAD)
echo "Checked out $SHA"
cd server/ops/prod
export KEPT_IMAGE_TAG="$SHA"
docker compose -f docker-compose.prod.yml build --pull api
if [ "$MIGRATE" = "--migrate" ]; then
  echo "Running db:migrate from image kept-api:$SHA, before the swap"
  docker compose -f docker-compose.prod.yml run --rm --no-deps api npm run db:migrate
fi
docker compose -f docker-compose.prod.yml up -d api
docker compose -f docker-compose.prod.yml ps
REMOTE

echo
echo "Deployed $COMMIT to $HOST. Now confirm it (Runbook §1):"
echo "  curl -i https://api.keptapp.net/api/me      # expect 401 with the JSON error body"
echo "  ssh $HOST docker compose -f /opt/kept/server/ops/prod/docker-compose.prod.yml logs --tail 50 api"
