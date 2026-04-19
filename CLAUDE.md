# nft-live-feed

Solana-wide live NFT sales feed. Backend-first; UI comes later.

## What this is

A real-time backend that ingests NFT sale events from across all of Solana,
normalizes them into a single schema, persists them to PostgreSQL, and streams
them to clients via SSE.

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

## Ingestion architecture (dual-path, no missed events)

### Primary: Helius webhooks (`POST /webhooks/helius`)
- Helius pre-parses all transaction types in real-time
- We verify `Authorization` header, parse, filter, insert

### Fallback: Polling (`src/ingestion/poller.ts`)
- Runs every 30 seconds, independently of the webhook
- Queries Helius enhanced API per `(programAddress, transactionType)`
- Fully paginated — catches up even after long outages
- Cursor stored in `poller_state` table, survives process restarts

**Both paths feed the same `parseHeliusTransaction → insertSaleEvent` pipeline.**
**`ON CONFLICT (signature) DO NOTHING` makes double-inserts safe.**

### Replay / backfill on restart
No manual action needed. On startup the poller immediately runs and fetches
all transactions newer than the last stored cursor. Service restarts are
automatically healed within one poll interval (30s).

For manual historical backfill: query Helius API with `before=<old_sig>` and
pipe through the same insert path. No special code needed — just reset or
delete the relevant `poller_state` row and let the poller catch up.

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

## Key files

| File | Purpose |
|---|---|
| `src/models/sale-event.ts` | Canonical `SaleEvent` type + constants |
| `src/db/migrations/001_initial.sql` | `sale_events` schema |
| `src/db/migrations/002_poller_state.sql` | Polling cursors |
| `src/db/insert.ts` | `insertSaleEvent()` — emits to event bus on new insert |
| `src/db/poller-state.ts` | Read/write polling cursors |
| `src/events/emitter.ts` | In-process `SaleEventBus` |
| `src/ingestion/helius/parser.ts` | Helius tx → SaleEvent, type/marketplace detection |
| `src/ingestion/helius/webhook.ts` | Webhook router, auth, insert loop |
| `src/ingestion/poller.ts` | Polling loop, pagination, cursor management |
| `src/server/sse.ts` | SSE endpoint, heartbeat, fan-out |

## Setup

```bash
cp .env.example .env
# fill in DATABASE_URL, HELIUS_API_KEY, HELIUS_WEBHOOK_AUTH

npm install
npm run migrate   # runs both 001 and 002 migrations
npm run dev
```

Expose the server publicly (ngrok for local dev, or deploy to VPS),
then register `https://your-host/webhooks/helius` in the Helius dashboard.
Select transaction types: `NFT_SALE`, `COMPRESSED_NFT_SALE`.

The poller starts automatically and runs independently of the webhook.

## What's NOT here yet

- REST query API for stored events (pagination, filters)
- Collection metadata enrichment
- Frontend / UI (Vercel, planned later)
- Multi-process SSE fanout via Redis pub/sub
