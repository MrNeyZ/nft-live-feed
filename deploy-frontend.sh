#!/usr/bin/env bash
#
# Build-and-swap deploy for nft-frontend.
#
# WHY THIS EXISTS
#   `next build` — and especially `rm -rf .next` — run on the LIVE checkout
#   leaves the running `next start` serving an empty/partial `.next` for the
#   whole ~60s build. During that window every /_next/static/*.js 404s and Next
#   returns its HTML 404 page (Content-Type: text/html). Cloudflare caches those
#   under the otherwise-immutable chunk URLs, and browsers then BLOCK the chunks
#   on MIME mismatch — the /mints "black screen + loading dots".
#
# WHAT THIS DOES
#   Builds into an ISOLATED dist dir (NEXT_DIST_DIR) while the live `.next` keeps
#   serving correct chunks, sanity-checks the output, then swaps it in with two
#   back-to-back metadata renames (microsecond gap, not the build) and restarts
#   pm2. The only downtime is the ~1s pm2 restart — a clean 502, never a poisoned
#   chunk. next.config.mjs reads NEXT_DIST_DIR at build time; at `next start` the
#   env is unset so distDir defaults to `.next`, which is exactly what we swap in.
#
# USAGE
#   /root/nft-live-feed/deploy-frontend.sh
#
set -euo pipefail

FE=/root/nft-live-feed/frontend
cd "$FE"

BUILD_DIR=".next.build"
STAMP="$(date +%s)"
OLD_DIR=".next.old.${STAMP}"

echo "[deploy] building into ${BUILD_DIR} — live .next stays up and serving…"
rm -rf "${BUILD_DIR}"
NEXT_DIST_DIR="${BUILD_DIR}" npm run build

# Sanity gate — never swap in a broken/partial build. If anything is missing the
# live .next is left completely untouched.
test -f "${BUILD_DIR}/BUILD_ID"            || { echo "[deploy] ABORT: ${BUILD_DIR}/BUILD_ID missing — live .next untouched"; exit 1; }
test -d "${BUILD_DIR}/static/chunks"       || { echo "[deploy] ABORT: ${BUILD_DIR}/static/chunks missing — live .next untouched"; exit 1; }

NEW_ID="$(cat "${BUILD_DIR}/BUILD_ID")"
echo "[deploy] build OK (BUILD_ID=${NEW_ID}); swapping in…"

# Two back-to-back renames on the same filesystem — microsecond gap.
mv .next "${OLD_DIR}"
mv "${BUILD_DIR}" .next

# `next start` uses next.config's distDir (=.next) and ignores the build-time
# distDir baked into required-server-files.json (verified), but normalise it so
# the swapped tree is fully self-consistent for any tool that does read it.
RSF=".next/required-server-files.json"
if [ -f "${RSF}" ]; then
  node -e 'const fs=require("fs"),f=process.argv[1],from=process.argv[2];fs.writeFileSync(f,fs.readFileSync(f,"utf8").split(from).join(".next"));' "${RSF}" "${BUILD_DIR}" || true
fi

echo "[deploy] restarting nft-frontend (frontend only)…"
pm2 restart nft-frontend --update-env >/dev/null

# Wait for the new server to come up, then verify a real chunk serves as JS.
sleep 2
HTML="$(curl -s http://localhost:3000/mints || true)"
CHUNK="$(printf '%s' "$HTML" | grep -oE '/_next/static/chunks/[^"\\]+\.js' | head -1)"
if [ -n "${CHUNK}" ]; then
  CT="$(curl -sI "http://localhost:3000${CHUNK}" | grep -i '^content-type' | tr -d '\r')"
  echo "[deploy] verify ${CHUNK} -> ${CT}"
  printf '%s' "${CT}" | grep -qi 'javascript' || { echo "[deploy] WARNING: chunk not served as javascript"; }
else
  echo "[deploy] WARNING: could not extract a chunk URL from /mints to verify"
fi

echo "[deploy] cleaning old release ${OLD_DIR}…"
rm -rf "${OLD_DIR}"

echo "[deploy] done. live BUILD_ID=$(cat .next/BUILD_ID)"
