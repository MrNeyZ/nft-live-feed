# nft-live-feed

Solana-wide live NFT sales feed with a Next.js UI layered on top.

## What this is

A backend that ingests NFT sale events across ME v2, MMM, Tensor TComp, and
Tensor TAMM, normalizes them into a single schema, persists them to PostgreSQL,
and streams them to clients via SSE. A Next.js frontend consumes that stream as
a live feed and includes a per-collection drill-down page.

## NFT types tracked

| Type | Notes |
|---|---|
| `legacy` | Standard Metaplex token-metadata NFTs |
| `metaplex_core` | MPL Core standard (newer) |
| `cnft` | Compressed NFTs via Bubblegum; **hard minimum 0.002 SOL filter** |

## Marketplaces tracked

| Marketplace | Notes |
|---|---|
| `magic_eden` | Magic Eden marketplace |
| `magic_eden_amm` | Magic Eden AMM pool trades |
| `tensor` | Tensor marketplace |
| `tensor_amm` | Tensor AMM/CLMM pool trades |

## Current Runtime Flow

`src/index.ts` starts, in order:
1. DB connectivity check (`SELECT 1`)
2. Express app (`createApp` from `src/server/app.ts`)
3. `startListener()` — WebSocket-based live ingestion
4. `startAmmPoller()` — light gap-healer for AMM programs

The Helius webhook route (`POST /webhooks/helius`) is still registered but
labeled "standby" at startup and is **not** the primary ingestion path.
`startPoller()` (Helius enhanced poller) and `startRawPoller()`
(`getSignaturesForAddress`-based) exist in the tree but are **disabled** at the
`import` site in `src/index.ts` and must not be treated as active paths.

## Primary Ingestion Paths

### Live: `src/ingestion/listener.ts` (primary)
- Standard Solana RPC `logsSubscribe`, one WebSocket per program
- Subscribes to four programs:
  - Magic Eden v2  (`M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K`)
  - MMM (ME AMM)   (`mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc`)
  - Tensor TComp   (`TCMPhJdwDryooaGtiocG1u3xcYbRpiJzb283XfCZsDp`)
  - Tensor TAMM    (`TAMM6ub33ij1mbetoMyVBLeKY5iP41i4UPUJQGkhfsg`)
- On each confirmed signature: fetch raw tx, decode via
  `me-raw/` or `tensor-raw/` parsers, then `insertSaleEvent`
- Auto-reconnect with backoff, slot heartbeat + watchdog + forced periodic restart

### Gap-healer: `src/ingestion/amm-poller.ts` (fallback, AMM-only)
- Polls the same four programs via `getSignaturesForAddress`
- Purpose: catch signatures the WebSocket may have missed during reconnects
- Cursor stored in `poller_state`, survives process restarts
- Feeds into the **same** `ingestMeRaw` / `ingestTensorRaw` entry points —
  `ON CONFLICT (signature) DO NOTHING` makes re-ingest safe

### Insert flow (`src/db/insert.ts`)
For each parsed `SaleEvent`:
1. **Insert fast** — write to `sale_events` with metadata nulls
2. **Emit SSE** — `saleEventBus.emitSale(...)` fires immediately so clients render at once
3. **Enqueue enrichment** — background `enrich(event)` (ME/DAS/metadata lookups); never awaited
4. **Follow-up events** (any of):
   - `rawpatch` — raw-parser corrections applied via `patchSaleEventRaw`
   - `metaUpdate` — name/image/collection populated after enrichment completes
   - `remove` — row deleted post-enrichment (blacklisted collection, or cNFT below min floor detected late)

## Real-time output

**SSE endpoint: `GET /events/stream`**
- Each inserted sale fires `saleEventBus.emitSale()` in `src/events/emitter.ts`
- SSE handler fans that event out to all connected clients immediately
- 25-second heartbeat keeps connections alive through proxies
- Single-process only; upgrade to Redis pub/sub when multi-process is needed

**Browser usage:**
```js
const es = new EventSource('https://your-host/events/stream');
es.addEventListener('sale', e => console.log(JSON.parse(e.data)));
```

## cNFT price filter

cNFT sales with `price_lamports <= 2_000_000` (0.002 SOL) are **discarded at parse time**.
Rationale: cNFTs are often used for spam/dust; very low-value sales are noise.

## Storage

`sale_events` (PostgreSQL) is the single source of truth for persisted sales.
All ingestion paths — listener, AMM gap-healer, and (if ever re-enabled) the
disabled pollers/webhook — converge on `insertSaleEvent` and this table.
`ON CONFLICT (signature) DO NOTHING` makes duplicate inserts safe.

Migrations in `src/db/migrations/`:
`001_initial.sql`, `002_poller_state.sql`, `003_enrichment_columns.sql`,
`004_sale_type.sql`, `005_me_collection_slug.sql`.

## Key files

| File | Purpose |
|---|---|
| `src/models/sale-event.ts` | Canonical `SaleEvent` type + constants |
| `src/db/insert.ts` | `insertSaleEvent()` + `patchSaleEventRaw()` — write path & SSE fan-out triggers |
| `src/db/poller-state.ts` | Read/write polling cursors |
| `src/events/emitter.ts` | In-process `SaleEventBus` (sale / metaUpdate / rawpatch / remove) |
| `src/ingestion/listener.ts` | **Primary live path** — logsSubscribe WebSocket per program |
| `src/ingestion/amm-poller.ts` | Gap-healer — `getSignaturesForAddress` for ME/MMM/TComp/TAMM |
| `src/ingestion/me-raw/`, `src/ingestion/tensor-raw/` | Raw tx → SaleEvent decoders |
| `src/ingestion/helius/webhook.ts` | Webhook route (registered, **standby**, not primary) |
| `src/ingestion/poller.ts`, `src/ingestion/raw-poller.ts` | **Disabled** — kept for rollback |
| `src/server/sse.ts` | SSE endpoint, heartbeat, fan-out |

## Setup

```bash
cp .env.example .env
# fill in DATABASE_URL, HELIUS_API_KEY, HELIUS_WEBHOOK_AUTH

npm install
npm run migrate   # runs both 001 and 002 migrations
npm run dev
```

The listener and AMM gap-healer both start automatically. No webhook
registration is required for the current runtime (the route exists for
rollback only).

## Frontend

A Next.js frontend lives in `frontend/`. It currently behaves as a **live feed
page** backed by `/events/stream` (SSE) plus a collection page that surfaces
per-slug listings/trades/stats via backend proxy endpoints
(`src/server/collection-*.ts`, `src/server/events-router.ts`). It is **not** a
finished collection-level aggregator — it's a feed UI with a collection drill-down.

## Known Current Scope

- Live NFT sale ingestion for ME v2, MMM, Tensor TComp, Tensor TAMM via WebSocket
- AMM program gap-healing via `getSignaturesForAddress`
- Persistence to `sale_events` with background enrichment (name, image, collection)
- SSE fan-out of `sale` / `metaUpdate` / `rawpatch` / `remove` events
- cNFT floor filter (0.002 SOL) enforced at parse time and defensively at insert
- Collection page data sources: ME direct listings + MMM sell-side pool listings +
  (optional, requires `TENSOR_API_KEY`) Tensor listings; ME/MMM bids; 7d rollups
  computed from `sale_events`
- ME buy flow via `/api/buy/me` (standard auction-house `buy_now`)

## Not Yet Built / Not Primary

- Helius webhook path (`POST /webhooks/helius`) — registered but **standby**, not active
- Helius enhanced poller (`src/ingestion/poller.ts`) — **disabled** at import site
- Raw `getSignaturesForAddress` poller (`src/ingestion/raw-poller.ts`) — **disabled**
- Tensor listings — code path exists in `src/server/collection-listings.ts` but is a
  no-op unless `TENSOR_API_KEY` is set
- MMM buy execution — MMM pool listings surface in the LISTINGS column but
  `/api/buy/me` targets the auction-house path only; pool buys (`fulfill_sell`)
  are not wired
- TAMM-specific listings endpoint — Tensor path covers TAMM only implicitly
  via Tensor's `active_listings_v2` when a key is present
- Multi-process SSE fanout via Redis pub/sub
