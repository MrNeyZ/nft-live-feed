# nft-live-feed — VictoryLabs engineering notes

Solana-wide NFT sales + mints feed. Express/TS backend, Postgres, Next.js
frontend. Backend owns truth; UI is a presentation layer over SSE.

---

## GLOBAL RULES

- **Backend is the source of truth.** Fix parsers, blacklists, detectors —
  not UI defenses.
- **Existing pattern first.** Before any new UI/logic, grep `soloist/`,
  `mints/`, `server/`, `globals.css`. If an existing system covers ~80–90 %
  of the problem, adapt it. Do not build a cleaner parallel architecture.
- **One source of truth per concept.** No parallel reducers / stores /
  feature flags. Extend `feedReducer`, `events` + `rows` state, soloist
  primitives — don't shadow them.
- **Surgical diffs.** One focused change at a time. Never `git add .` over
  mixed WIP — snapshot → reset → re-apply → commit → restore.
- **Preserve UX/layout.** Do not redesign working UI without an explicit ask.

---

## LOW TOKEN MODE

- Default tone: terse, action-only, ~15 lines.
- Output shape: **root cause → files changed → verification → result.**
  Nothing else.
- No proactive screenshots, Playwright runs, isolated builds, audits.
- **No deep audits / wide scans / architecture archaeology unless asked.**
- Read surgically: target file, target line range. Don't re-read large
  files. Don't project-wide-grep when the path is already known.
- No giant reasoning chains unless actively debugging.

---

## WORKFLOW

- Plan only when non-trivial.
- Find existing pattern (grep shared systems) before inventing.
- Frontend build: `npm run build` inside `frontend/`.
- **Visual verification = real browser.** HTTP / bundle / `pm2 list`
  checks are deploy verification, not visual verification.
- Surgical commit; never bundle WIP from unrelated files.
- **Batch related small fixes** before deploying. Avoid restart/deploy loops.
- **Frontend auto-deploy:** after a clean frontend commit, build +
  `pm2 restart nft-frontend`. No "say when to deploy" gating.
- Push only with explicit confirmation, except the auto-deploy path above.

---

## UI/UX PHILOSOPHY

- **Visual consistency > novelty.** Match existing spacing, density, hover,
  glow, chip, and animation language.
- **Do not redesign working UI uninvited.**
- Soloist kit is shared — `LiveDot`, `TopNav`, `Pill`, `SettingsToggle`,
  `SETTINGS_PILL_INACTIVE`, `settingsPillActive`, `ItemThumb`. Copy, don't fork.
- **Hover-pause** is the shared contract for any continuously-moving list.
- Per-card hover lift: `translateY(-1px) scale(1.005)` + inset ring + soft
  glow. Lives on `.feed-card` and `.mints-feed-row`.
- `PAUSED` chip pattern: amber, 10 px, in-header, only while paused.

---

## RESPONSIVE SYSTEM

- Source of truth: `frontend/src/lib/breakpoints.ts`. CSS mirrors via
  `globals.css`. Ranges: mobile ≤480 / tablet ≤768 / small_laptop ≤1024 /
  laptop ≤1600 / desktop_large 1601+.
- Tokens: `--page-x`, `--feed-card-pad`, `--feed-card-gap`,
  `--feed-root-padding-x`, `--hover-ring-alpha`, `--hover-glow-blur`,
  `--hover-glow-alpha`.
- **No monitor-specific magic offsets. No one-device fixes.**
- Manual layout-mode (`vl.layoutMode`: pc / laptop / phone) is a user
  toggle — never auto-set.
- Verify across the full breakpoint matrix.

---

## FRONTEND ARCHITECTURE

- Routes: `/`, `/feed`, `/dashboard`, `/mints`, `/multi`, `/tools`,
  `/tools/rare-feed`, `/collection/[slug]`, `/access`, `/thumb`.
- `Gate` (`frontend/src/runtime/Gate.tsx`) wraps everything and owns the
  `BottomStatusBar`. Access is gated by `UI_ALLOWED_WALLETS`.
- **Embed contract** (`/multi` → iframes):
  `?embed=1` → suppress `TopNav`, set `data-embedded="1"` on the root so
  layout-mode zoom doesn't double-apply.
- `/thumb` is the image proxy route — must be routed to the **frontend**
  (port 3000), never the backend.
- localStorage keys are namespaced `vl.*` — reuse, don't shadow.
- Feed state lives in `feedReducer` (sales) and the `events` + `rows`
  state pair (mints). No parallel store.

---

## BACKEND / INGESTION ARCHITECTURE

- Boot order (`src/index.ts`): DB ping → Express (`createApp`) →
  `startListener()` → `startAmmPoller()`.
- **Primary live path:** `src/ingestion/listener.ts` — one
  `logsSubscribe` WebSocket per program (ME v2, MMM, Tensor TComp,
  Tensor TAMM). Auto-reconnect, slot heartbeat, watchdog, periodic
  forced restart.
- **AMM gap-healer:** `src/ingestion/amm-poller.ts` —
  `getSignaturesForAddress`, cursor in `poller_state`.
- **Disabled at import:** `poller.ts`, `raw-poller.ts`. **Standby:**
  `helius/webhook.ts`.
- **Mint subsystem:** `src/mints/` — `accumulator`, `detector`,
  `enricher`, `blacklist`, `collection-confirm`, `core-supply-refresher`,
  `event-store`, `snapshot`, `clean-name`.
- **Storage:** Postgres `sale_events` (single source of truth).
  `ON CONFLICT (signature) DO NOTHING` makes re-ingest safe.
- Migrations 001 – 010 in `src/db/migrations/`. Run `npm run migrate`.
- Single-process SSE (no Redis fanout).

---

## LIVE FEED RULES

- SSE channels: `sale`, `metaUpdate`, `rawpatch`, `remove`.
- Hover-pause buffers events in `pausedBuffer`; manual Pause coexists;
  effective pause = `manual || hover`. Buffer caps at 500.
- Density modes: `comfy` / `compact` / `tape` (`vl.feed.density`).
- Filtering / dedupe / ordering live in the reducer. UI dispatches
  typed actions only.

---

## MINT TRACKER RULES

- SSE channels: `mint`, `mint_status`, `mint_meta`. `mint_meta` has a
  server-side replay buffer for late-connecting tabs.
- `isRenderableMintStatus` + `isClearlyNonNftMintEvent` are **last-line
  defenses**, not the place for new rules. Fix the detector / blacklist
  in `src/mints/` instead.
- Live Mint Feed (right pane on `/mints`) uses the same hover-pause
  contract as `/feed` (buffer + drain on mouse-leave). Left collections
  table keeps updating during hover.
- cNFT floor: `price_lamports ≤ 2_000_000` (0.002 SOL) discarded at parse
  time.
- Blacklist: `src/mints/blacklist.ts` + DB-loaded blocked-mints preload
  on startup. Adding entries → hard-code in `BLACKLISTED_COLLECTIONS`
  with a comment.

---

## CREDIT OPTIMIZATION

- **Helius / RPC credits are a constrained resource.**
- Prefer filtering, dedupe, batching, pre-classification **before** adding
  any RPC call.
- MMM prefilter (`src/ingestion/mmm-prefilter.ts`) sheds noise before RPC:
  `MMM_DEFER_MS = 5_000`, `MMM_NOISE_TTL_MS = 30_000`,
  `MMM_NOISE_MAX = 5_000`. Don't widen MMM ingestion without re-reading
  these thresholds.
- Background enrichment is fire-and-forget; never await on the hot path.
- `ON CONFLICT (signature) DO NOTHING` → re-ingest is cheap. Over-fetch
  is expensive.

---

## SECURITY RULES

- `X-Frame-Options: SAMEORIGIN` in nginx — required for `/multi`. DENY
  breaks all iframes.
- `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: strict-origin-when-cross-origin`,
  `Permissions-Policy: camera=(), microphone=(), geolocation=()` —
  set in nginx, not Next.
- CSP intentionally omitted (inline boot scripts / inline styles).
- `UI_ALLOWED_WALLETS` lives in `/root/nft-live-feed/.env`. Restart
  backend for changes to take effect.

---

## DEPLOYMENT / PM2 / NGINX

- pm2 processes: **`nft-frontend`** (port 3000), **`nft-backend`**
  (port 3001). Restart via `pm2 restart <name>`.
- nginx site: **`/etc/nginx/sites-enabled/nft-live-feed`**.
  Routes:
    `/api/` → 3001 ·
    `/events/` → 3001 (SSE-tuned: `proxy_buffering off`, 3600 s read) ·
    `/webhooks/` → 3001 ·
    `/` → 3000.
- `/api/image-proxy` → **frontend (3000)**. Routing to backend breaks
  every Burner thumbnail.
- **Prod = live checkout.** Building in-place on a feature branch
  contaminates `.next` and a `pm2 restart` ships it. For experimental
  branches, build in an isolated temp dir; restore via
  `git checkout main → rebuild → pm2 restart`.
- Frontend auto-deploys per WORKFLOW; backend deploys are explicit.

---

## KNOWN PITFALLS

- In-place build on a feature branch contaminates `.next` / `dist`.
- `mint_meta` arrives after `mint` — UI must keep events live during the
  patch, never replace.
- Tensor listings are a no-op without `TENSOR_API_KEY`.
- MMM pool buys not wired — `/api/buy/me` is auction-house only.
- Single-process SSE; no Redis pub/sub.
- nft.storage / w3s IPFS art is permanently dead — labelled fallback is
  intended, not a regression.
- Rare Feed (`feat/rare-feed-mvp`) is **not merged**; HowRare is the
  current working rarity source.

---

## VERIFIED EXISTING PATTERNS

- **Hover-pause:** `frontend/src/app/feed/page.tsx`,
  `frontend/src/app/mints/page.tsx` (`pausedRef` + `pausedBuffer` +
  drain effect on mouseleave).
- **Hover lift:** `.feed-card:hover` / `.mints-feed-row:hover` in
  `globals.css`.
- **Embed contract:** `dashboard/page.tsx`, `feed/page.tsx`,
  `mints/page.tsx` — `?embed=1` → no `TopNav`, `data-embedded="1"`.
- **Soloist primitives:** `frontend/src/soloist/shared.tsx`.
- **Persisted-store debounce:** `schedulePersistedCollections` /
  `schedulePersistedFeed` in `mints/page.tsx` (1.5 s coalesce + flush
  on `pagehide`).
- **SSE reconnect with backoff + jitter:** identical pattern in
  `feed/page.tsx` and `mints/page.tsx`.

---

## DO NOTS

- Don't add UI-side filters to mask backend bugs.
- Don't fork shared soloist primitives.
- Don't widen MMM ingestion without re-reading `mmm-prefilter.ts`.
- Don't introduce monitor-specific offsets or device-only fixes.
- Don't claim visual behavior from HTTP / bundle / `pm2 list` alone.
- Don't redesign working UI uninvited.
- Don't commit unrelated WIP in the same change.
- Don't push without confirmation (frontend auto-deploy excepted).
- Don't set `X-Frame-Options: DENY`, add CSP, or route `/api/image-proxy`
  to the backend.
- Don't build experimental branches in the live checkout.

---

## PROJECT STRUCTURE

```
src/                       backend (TS / Node)
  index.ts                 boot: DB → Express → listener → amm-poller
  ingestion/
    listener.ts            primary live (logsSubscribe per program)
    amm-poller.ts          AMM gap-healer
    mmm-prefilter.ts       MMM noise shed (RPC saver)
    me-raw/, tensor-raw/   raw tx → SaleEvent decoders
    mint-raw/              raw tx → MintEvent decoders
    helius/webhook.ts      standby (not active)
    poller.ts, raw-poller.ts  disabled at import (rollback only)
  mints/
    accumulator.ts         per-collection rollups + mint_status frames
    detector.ts            NFT-shape gate
    enricher.ts            name/image/collection DAS lookups
    blacklist.ts           BLACKLISTED_COLLECTIONS + DB blocked mints
    collection-confirm.ts  late name/image patch path
    event-store.ts         in-memory recent-mint buffer
    snapshot.ts            SSE replay on connect
  events/emitter.ts        SaleEventBus (sale/meta/rawpatch/remove)
                           + mint / mint_status / mint_meta
  server/
    app.ts                 Express composition
    sse.ts                 /events/stream, heartbeat, fan-out
    events-router.ts       collection drill-down endpoints
    collection-*.ts        listings / bids / rollups / stats / chart / …
    market.ts, buy-me.ts   ME buy flow (auction-house only)
  db/
    insert.ts              insertSaleEvent + patchSaleEventRaw
    poller-state.ts        cursor read/write
    migrations/            001 … 010

frontend/src/
  app/
    feed/                  /feed — Live Feed (sales)
    dashboard/             /dashboard — analytics
    mints/                 /mints — collections table + Live Mint Feed
    multi/                 /multi — iframes dashboard/feed/mints
    tools/                 /tools, /tools/rare-feed
    collection/[slug]/     drill-down
    access/                login
    thumb/                 image proxy route
  soloist/                 shared UI kit, layout-mode, price-mode,
                           feed-store, sounds, mock-data, shared.tsx
  runtime/Gate.tsx         auth gate + BottomStatusBar
  lib/breakpoints.ts       responsive source of truth
```

---

## MINT ANALYZER

Read-only Solana mint-transaction analyzer. Paste a tx signature → decode
programs / instructions / signers → reconstruction verdict. Separate from
the live-feed ingestion path; shares no state with it.

**Current production state**
- Live at `/tools/mint-analyzer`.
- Commit introducing tool: `e6dd781`.
- UI polish: `f31fd5f`.
- Fixture coverage expansion: `80209f8`.

**Purpose**
- Read-only Solana mint transaction analyzer.
- Input: transaction signature.
- Output: likely mint primitive · wrapper detection · signer classification ·
  launchpad detection · reconstruction verdict.
- No wallet connect. No signing. No tx building. No tx sending. No DB writes.

**Backend architecture**
- Route: `GET /api/tools/mint-analyzer/analyze?sig=<signature>`
  (`tools-mint-analyzer.ts`, mounted in `app.ts` under `/api`, rate-limited
  30/min). No auth middleware; pure read path.
- Files:
    - `src/mint-analyzer/analyze.ts`        — pure decode + classification
    - `src/mint-analyzer/programs.ts`       — program registry + discriminators
    - `src/mint-analyzer/fetch-tx.ts`        — read-only getTransaction wrapper
    - `src/mint-analyzer/types.ts`           — shared interfaces
    - `src/server/tools-mint-analyzer.ts`    — Express router
- Program IDs + platform signers are **imported** from
  `src/ingestion/mint-raw/launchpad-detector.ts` (single source of truth) —
  do not re-hardcode them in the analyzer.

**Data source**
- Helius `getTransaction`. `encoding=json`. `maxSupportedTransactionVersion=0`.

**Classification outputs**
- `MintPrimitive`: `candy_machine_v3_mintv2` · `mpl_core_create_v2` ·
  `token_metadata_mint` · `bubblegum_mint` · `unknown`.
- `Verdict`: `direct_mint_likely_reconstructable` ·
  `possible_requires_extra_inputs` · `blocked_server_captcha_signature` ·
  `custom_program_manual_re_required`.

**Verdict meaning (UI label ⇢ verdict)**
- `YES`       = `direct_mint_likely_reconstructable`
- `MAYBE`     = `possible_requires_extra_inputs`
- `NO`        = `blocked_server_captcha_signature`
- `MANUAL RE` = `custom_program_manual_re_required`

**Verdict trigger order** (`analyze.ts`): backend/platform co-signer → `NO`;
else opaque custom wrapper fronting a primitive → `MANUAL RE`; else known
launchpad entry program (LaunchMyNFT / Gravemint) → `MAYBE`; else recognised
primitive → `YES`. NB: a Candy-Guard allowlist mint scores `YES` (guard is a
primitive, not a launchpad) — `MAYBE` requires a known launchpad entry
program; `NO` requires a known platform signer (vvv.so / gravemint.io).

**Known examples**
- `YES`       — `5wkbhQ3QHti69S3dqo4F1Y8PtTKofLSRWzeNW5foMrBCXkz7ntNDGTJMCHi7S21ChHghwUC8UZRHSmTLwKR6ujYr`
- `MAYBE`     — `3qjW71UQFuq9X65Fk4bKVmGyPs6XVGc8rtHF1UiqzBJ7AfQ9ZA1RVX1PpKYFGJfG93vwcCcuTR5edV2zXNtDDUeQ`
- `NO`        — `4nvMBRxq7L7eY7spzMWggj1QjenbcZ5uUMEKb49Fy8vCMRUvSKc62gWtdxWRz7EEQtKFyrgPC72EfG2FvCjCxv4Q`
- `MANUAL RE` — `2ZshWXyj47naARpnWBDUKtg1AH1ZAWF2YRhg9gFd44zKEVYJMPkA8zJBs8yJQpy4sY5AJ9Rq6k9iyKuihjYXqvLA`

**Test coverage**
- Offline fixtures in `src/mint-analyzer/__tests__/fixtures/`: `tx1.json`,
  `tx2.json`, `tx3.json`, `tx_maybe.json`, `tx_no.json`.
- Runner: `npm run test:mint-analyzer` (ts-node + Node `assert`, no network).
- **Requirement: all four verdict states must remain covered by offline
  fixture tests.**

**Frontend**
- Route: `/tools/mint-analyzer`. TOOLS menu label: **MINTX**
  (Rare Feed label is **RARE**). Routes unchanged.
- UI features: RECONSTRUCTABLE badge · CONFIDENCE badge · WRAPPER section ·
  COPY JSON button (clipboard-only).

**Do-nots**
- Don't add wallet connect, signing, or tx building — v1 is read-only.
- Don't re-hardcode program IDs / platform signers — import from the
  launchpad detector.
- Don't drop offline coverage of any of the four verdict states.
