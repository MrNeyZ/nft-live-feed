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

echo "==> [1/5] git fetch + reset to origin/main"
git fetch --prune origin
git reset --hard origin/main

echo "==> [2/5] backend deps"
npm ci

echo "==> [3/5] DB migrations"
npm run migrate

echo "==> [4/5] frontend deps + production build"
(
  cd frontend
  npm ci
  npm run build
)

echo "==> [5/5] PM2 reload (picks up new .env values)"
# --update-env makes PM2 re-read both env files instead of recycling the
# startup-time snapshot. Without it, .env changes require a full restart.
pm2 reload ecosystem.config.cjs --update-env
pm2 save

echo ""
echo "==> done"
pm2 status
