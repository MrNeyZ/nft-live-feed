#!/usr/bin/env bash
# deploy.sh — pull latest main, rebuild, reload PM2.
#
# Run as the `nftfeed` service user from the repo root:
#
#   ./deploy.sh
#
# This is idempotent; re-running after a failed step is safe. Secrets are
# never referenced — everything sensitive lives in `.env` (backend) and
# `frontend/.env.production`, both chmod 600.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "==> [1/6] git fetch + reset to origin/main"
git fetch --prune origin
git reset --hard origin/main

echo "==> [2/6] backend deps"
npm ci

echo "==> [3/6] backend production build (emits dist/index.js)"
# PM2 launches the backend from dist/index.js (see ecosystem.config.cjs);
# without this step, a fresh deploy would error at startup. Idempotent —
# tsc no-ops when sources haven't changed.
npm run build

echo "==> [4/6] DB migrations"
npm run migrate

echo "==> [5/6] frontend deps + production build"
(
  cd frontend
  npm ci
  npm run build
)

echo "==> [6/6] PM2 reload (picks up new .env values)"
# --update-env makes PM2 re-read both env files instead of recycling the
# startup-time snapshot. Without it, .env changes require a full restart.
pm2 reload ecosystem.config.cjs --update-env
pm2 save

echo ""
echo "==> done"
pm2 status
