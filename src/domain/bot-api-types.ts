/**
 * VictoryLabs Internal Bot API v1 — shared contract types.
 *
 * Consumed by `/root/vl-nft-bots` (a separate VPS/process) over
 * `/api/internal/bots/v1/*`. These types are the wire contract — additive
 * and backward-compatible within v1: existing fields never change meaning
 * or get removed; new fields are always optional. A breaking change gets a
 * new `apiVersion` ('2'), not a mutation of these shapes.
 *
 * No trading-strategy, transaction-building, or wallet/signing logic lives
 * here or anywhere in this API — see docs/internal-bot-api-v1.md for the
 * explicit contract bots must follow (revalidate before acting, treat
 * events as hints not proof, final execution checks stay local to the bot).
 */

import type { FloorDepthResult } from '../analytics/floor-depth';
import type { CrossMarketResult } from '../analytics/cross-market';
import type { CollectionBidPair } from '../analytics/normalized-collection-bid';

export const BOT_API_VERSION = '1';

// ─── Envelope ────────────────────────────────────────────────────────────

export interface BotApiWarning {
  /** Short machine-readable code, e.g. 'listings_refresh_failed'. */
  code:    string;
  message: string;
}

/** Fields common to every v1 response envelope. */
export interface BotApiEnvelopeMeta {
  apiVersion: string;
  /** When this response's data was finished being assembled (ISO 8601). */
  generatedAt: string;
  /** When the backend received the request that produced this response
   *  (ISO 8601). Distinct from `generatedAt` — the gap between the two is
   *  how long this response took to assemble server-side. */
  receivedAt: string;
  /** Opaque, monotonically-non-decreasing marker for this data snapshot.
   *  Bots should treat it as opaque (do not parse); a changed value means
   *  "something in this payload may differ from the last time you saw
   *  this dataVersion". Currently a timestamp string — see docs for the
   *  documented limitation (not a content hash). */
  dataVersion: string;
  /** True when any upstream/cached-data source failed and this response
   *  is serving partial or last-known-good data. Bots MUST NOT treat a
   *  stale response as executable market truth without revalidating. */
  stale: boolean;
  warnings: BotApiWarning[];
}

// ─── Health ──────────────────────────────────────────────────────────────

export interface BotApiSourceHealth {
  source: 'magiceden' | 'tensor';
  state:  'ok' | 'stale';
}

export interface BotApiHealthResponse {
  apiVersion:  string;
  status:      'ok';
  serverTime:  string;
  uptimeSec:   number;
  sources:     BotApiSourceHealth[];
  /** Count of currently-connected bot SSE clients (this process only). */
  eventStreamClients: number;
}

// ─── Collection snapshot ────────────────────────────────────────────────

/** Minimal recent-sale summary — see docs for field provenance
 *  (`getEventsByCollection`, the same indexed query `/trade-history`
 *  already uses). `priceSol` stays a decimal string (as returned by
 *  Postgres NUMERIC) rather than a JS `number`, avoiding float rounding
 *  for a figure a bot may do exact arithmetic on. */
export interface BotApiSaleSummary {
  signature:   string;
  blockTime:   string; // ISO 8601
  marketplace: string;
  saleType:    string;
  priceSol:    string;
  mint:        string;
}

export interface BotApiCollectionSnapshot {
  slug:          string;
  /** Pure reuse of `computeFloorDepth()` (src/analytics/floor-depth.ts) —
   *  no reimplementation. Null only if the underlying store threw AND the
   *  slug has zero cached rows (see `stale` for the accompanying warning). */
  floorDepth:    FloorDepthResult;
  /** Pure reuse of `computeCrossMarketGap()` (src/analytics/cross-market.ts). */
  crossMarket:   CrossMarketResult;
  /** Pure reuse of `getBestCollectionBids()`
   *  (src/analytics/normalized-collection-bid.ts). Null when the bid
   *  lookup itself failed (see warnings) — distinct from "no bids exist",
   *  which is a normal `{bestContextBid: null, bestUsableForValueBid: null}`. */
  bids:          CollectionBidPair | null;
  /** Small, recent, indexed-query-cheap sale history. Empty array (never
   *  null) when the lookup failed or there simply were no recent sales —
   *  see warnings to distinguish the two. */
  recentSales:   BotApiSaleSummary[];
}

export interface BotApiCollectionSnapshotResponse extends BotApiEnvelopeMeta {
  collection: BotApiCollectionSnapshot;
}

// ─── Event stream ────────────────────────────────────────────────────────

/**
 * Event types actually wired in Stage 1:
 *   - 'sale'            — a confirmed on-chain sale (mirrors the public
 *                          Live Feed `sale` SSE channel, field-mapped down
 *                          to an explicit allowlist).
 *   - 'listing_change'  — a coarse "this slug's listings may have changed"
 *                          hint (listings-store `listing_snapshot` /
 *                          `listing_remove`). NOT a full listing payload —
 *                          bots must refetch the snapshot endpoint.
 *   - 'resync_required'  — sent to one reconnecting client when its
 *                          Last-Event-ID could not be satisfied from the
 *                          replay buffer; the bot must fetch a fresh
 *                          snapshot rather than assume continuity.
 *   - 'sale_patch'       — a late-arriving, authoritative correction to a
 *                          PRIOR `sale` event's identity fields, correlated
 *                          by `signature`. Fired when async enrichment
 *                          (collection identity) or the fast seller-count
 *                          lookup resolves AFTER the initial `sale` event
 *                          already went out — see docs/internal-bot-api-v1.md
 *                          "Collection enrichment timing". `payload.patch`
 *                          carries ONLY the fields that newly resolved
 *                          (never a full re-send) — a bot should merge it
 *                          onto its stored copy of the matching `sale`
 *                          event by `signature`, keeping any field the
 *                          patch omits unchanged.
 *   - 'signal_reserved'  — NEVER emitted today. Reserved placeholder so
 *                          bots can build a forward-compatible switch/case
 *                          ahead of a future validated signal (e.g. a
 *                          whale-liquidation detector) landing. Do not
 *                          build logic that expects this to arrive.
 */
export type BotEventType =
  | 'sale'
  | 'listing_change'
  | 'resync_required'
  | 'sale_patch'
  | 'signal_reserved';

export interface BotEventEnvelope<T = unknown> {
  apiVersion:  string;
  /** Unique within this process's lifetime (`bot-<sequence>`). */
  eventId:     string;
  eventType:   BotEventType;
  /** Monotonically increasing, process-local. Resets to 1 on backend
   *  restart — bots must treat a lower sequence than last-seen as a
   *  signal the process restarted and fall back to a snapshot fetch. */
  sequence:    number;
  generatedAt: string;
  dataVersion: string;
  payload:     T;
}

export interface BotEventSalePayload {
  signature:   string;
  mint:        string;
  slug:        string | null;
  priceSol:    number;
  marketplace: string;
  saleType:    string;
  blockTime:   string; // ISO 8601

  // ── v1-additive: whale-liquidation-bot identity fields ──────────────────
  // All added below are purely additive — an old client reading only the
  // 7 original fields above is unaffected. See docs/internal-bot-api-v1.md
  // "Stable collection identity" / "Seller identity" sections for full
  // provenance, precedence, and the known-null cases.

  /** Seller wallet, straight from the parser (see `SaleEvent.seller`).
   *  Non-null for every wired marketplace/saleType — a sale whose seller
   *  can't be confidently resolved is dropped upstream (never reaches this
   *  event) rather than shipped with a guessed/wrong wallet. Kept nullable
   *  on the wire only for forward-compatibility, not because a known gap
   *  exists today. */
  seller: string | null;
  /** Buyer wallet — same provenance/guarantee as `seller`. */
  buyer:  string | null;

  /** Precedence-resolved stable collection identifier — verified on-chain
   *  collection address, else the Magic Eden collection slug, else the
   *  Tensor collection slug. Null until one of those resolves (collection
   *  identity requires async enrichment for every marketplace — see
   *  `collectionIdentitySource`). Never a Bubblegum merkle tree — see
   *  `isMerkleTreeCollectionAddress` in src/domain/sale-event-adapters.ts. */
  collectionId: string | null;
  /** Magic Eden collection slug. Duplicate of the legacy `slug` field above
   *  (kept for backward compat) exposed under the new-model name too. */
  collectionSlug: string | null;
  /** Verified on-chain collection-group address (Helius DAS grouping).
   *  Null until async enrichment resolves it, or for a source that never
   *  will (see docs for the per-marketplace coverage table). Never a
   *  merkle tree. */
  collectionAddress: string | null;
  /** Which tier of `resolveCollectionIdentity` produced `collectionId`.
   *  Null when nothing has resolved yet. */
  collectionIdentitySource: 'onchain_collection_address' | 'me_slug' | 'tensor_slug' | null;

  /** Tri-state AMM-fill signal, synchronous (available on this SAME event —
   *  never patched later): `true` = confirmed pool-inventory fill,
   *  `false` = confirmed ordinary bid acceptance, `null` = no on-chain
   *  evidence either way (non-MMM sale, MMM fulfillSell direction, an
   *  unverified instruction variant, or cNFT — MMM never emits an lp_fee
   *  log for cNFT fulfillBuy). See `ammFillFromEvent` in
   *  src/domain/sale-event-adapters.ts. */
  ammFill: boolean | null;

  /** Seller's remaining holdings in the same collection after this sale.
   *  ALWAYS null on the initial `sale` event — this is resolved by an
   *  async DAS lookup that only runs for "sell kind" saleTypes
   *  (bid_sell/pool_sale) with a known seller+collection, so it can never
   *  be ready in time for the synchronous first frame. Watch for a
   *  `sale_patch` event with the same `signature` to receive it. */
  sellerRemainingCount: number | null;

  // ── v1-additive: MMM pool sniper support (added 2026-07-16) ─────────────
  // All fields below are pure additions — an old client reading only the
  // fields above is unaffected. See docs/internal-bot-api-v1.md's "MMM pool
  // sniper fields" section for full provenance and the per-instruction
  // nullability table.

  /** MMM pool state PDA (the account ME's own `/mmm/pools` API keys by
   *  `poolKey`) — straight from `SaleEvent.poolAddress`, itself captured
   *  directly from the confirmed instruction-accounts index at parse time
   *  (`programs.ts`'s `poolAcctIdx`). Non-null ONLY for MMM sales whose
   *  exact instruction variant has an independently-verified pool-account
   *  position. Null for every non-MMM sale AND for any MMM variant whose
   *  layout isn't verified (e.g. `coreFulfillBuyV2`) — fails closed, never
   *  guessed, and is NEVER derived from `buyer` (the pool OWNER wallet is a
   *  different account from the pool account itself — one owner can run
   *  multiple pools). */
  poolAddress: string | null;
  /** Exact gross sale price in lamports, as a decimal string (straight
   *  `SaleEvent.priceLamports.toString()` — a bigint, so this is exact even
   *  for values beyond `Number.MAX_SAFE_INTEGER`; `priceSol` above is a
   *  lossy float derived from the same source and kept only for backward
   *  compatibility). */
  priceLamports: string;
  /** Direct passthrough of `SaleEvent.nftType`: `'legacy' | 'pnft' | 'core'
   *  | 'metaplex_core' | 'cnft'`. Always one of these five today (the model
   *  field is non-optional) — typed nullable here only for the same
   *  forward-compatibility reason as `seller`/`buyer` above, not because a
   *  gap exists. Note the exact casing: `'pnft'` and `'core'`, not
   *  `'pNFT'`/`'Core'`. MMM's Core `fulfillBuy` variants (the ones the pool
   *  sniper watches) always report `'core'`, never `'metaplex_core'` — that
   *  value is only ever produced by the separate ME v2 direct-sale /
   *  Helius-parser code paths. */
  nftType: string | null;
  /** Direct passthrough of `SaleEvent.resizeStatus`. CAN be non-null on
   *  this very first frame (a synchronous, no-I/O cache-hit lookup — see
   *  `insert.ts`'s `getCachedResizeStatus`, covers the "second sale of the
   *  same mint" case) — it is not structurally delayed the way
   *  `sellerRemainingCount`/collection identity are. When the lookup hasn't
   *  resolved yet this is null on the first frame and, if it resolves
   *  later, arrives via `sale_patch` (see below) — never re-fetched or
   *  awaited, so the first frame is never delayed waiting for it. */
  resizeStatus: string | null;
  /** ISO 8601 timestamp of `SaleEvent.parserReceivedAt` — when the me-raw
   *  parser received the raw transaction, captured once synchronously
   *  before any instruction-specific parsing. Null for any sale that didn't
   *  go through `me-raw/parser.ts` (tensor-raw, mint-raw). NOT block time —
   *  measures this pipeline's own ingestion latency (WS/poll notification →
   *  `getTransaction` → parse), independent of on-chain confirmation time. */
  parserReceivedAt: string | null;
  /** ISO 8601 timestamp generated by the Bot API mapper immediately before
   *  this payload is handed to `publish()` for envelope/frame
   *  serialization — i.e. "when this specific event left the building,"
   *  distinct from the envelope-level `generatedAt` (which stamps the whole
   *  envelope, common to every event type). Always present. */
  emittedAt: string;
}

/**
 * `sale_patch` payload — see `BotEventType`'s doc comment above.
 * `patch` is intentionally Partial: only fields that newly resolved are
 * present. A field absent from `patch` means "still unknown", NOT "cleared
 * back to null" — never overwrite a previously-patched value with an
 * absent key.
 */
export interface BotEventSalePatchPayload {
  signature: string;
  patch: {
    collectionId?:             string | null;
    collectionSlug?:           string | null;
    collectionAddress?:        string | null;
    collectionIdentitySource?: 'onchain_collection_address' | 'me_slug' | 'tensor_slug' | null;
    sellerRemainingCount?:     number | null;
    /** Async resolution of `resizeStatus` when it wasn't already cached at
     *  `sale` time — see `BotEventSalePayload.resizeStatus`'s doc comment.
     *  Sourced from the same signature-correlated `ResizeStatusPatch` bus
     *  event the public `resize_status` SSE channel already uses. */
    resizeStatus?:              string | null;
  };
}

export interface BotEventListingChangePayload {
  slug: string;
  /** 'snapshot' — a full per-slug listings refresh landed (existing
   *  `listing_snapshot` bus event); 'remove' — one listing id was
   *  removed (existing `listing_remove` bus event, e.g. a sale/delist). */
  kind: 'snapshot' | 'remove';
  /** Present only for kind:'remove'. */
  id?:  string;
}

export interface BotEventResyncRequiredPayload {
  reason: 'replay_unavailable';
  /** The Last-Event-ID the client presented that could not be satisfied. */
  requestedLastEventId: string | null;
}
