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
