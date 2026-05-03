import { EventEmitter } from 'events';
import { SaleEvent } from '../models/sale-event';

export interface RawPatch {
  signature:   string;
  seller:      string;
  buyer:       string;
  marketplace: string;
  nftType:     string;
  saleType:    string;
  priceSol:    number;
}

export interface MetaUpdate {
  mintAddress:       string;
  signature:         string;
  nftName:           string | null;
  imageUrl:          string | null;
  collectionName:    string | null;
  collectionAddress: string | null;
  meCollectionSlug:  string | null;
  /** (salePrice − floor) / floor. Null when floor unavailable. */
  floorDelta:        number | null;
  /** salePrice (SOL) − topOffer (SOL). Null when no active offer. */
  offerDelta:        number | null;
}

// ─── Listings deltas ─────────────────────────────────────────────────────────
//
// Frontend listings state is maintained by applying these deltas to the
// initial snapshot from GET /api/collections/listings. The backend
// listings-store is authoritative; these events carry its per-slug mutations
// to any SSE client viewing that slug.
//
//   listing_remove   — a single mint was removed (sale/fill, cancel/delist
//                      once ingestion supports it, or reconciliation diff)
//   listing_snapshot — full replacement of a slug's listings after a
//                      snapshot refresh / reconciliation. Frontend replaces
//                      its local array for this slug.

export interface ListingOutWire {
  /** Source-aware unique id: `ME:{mint}:{seller}` / `MMM:{poolKey}:{mint}` /
   *  `TENSOR:{mint}:{seller}`. Clients track listings by id so deltas can
   *  target a specific source/route row without mint-wide removal. */
  id:           string;
  mint:         string;
  seller:       string;
  auctionHouse: string;
  priceSol:     number;
  tokenAta:     string;
  rank:         number | null;
  marketplace:  'me' | 'tensor';
  /** Epoch ms when the listing was created on-chain. Null when unavailable
   *  (MMM pool entries, Tensor without an observed listing tx, or ME
   *  listings older than our activities-fetch window). */
  listedAt:     number | null;
  /** NFT item name from upstream metadata when available (ME `token.name`).
   *  Often just `"#4101"` — combine with collection-derived stem at render
   *  time. Null for MMM pool entries. */
  nftName:      string | null;
  /** NFT thumbnail URL (ME `extra.img` / `token.image`). Null when
   *  unavailable; frontend falls back to the abbr/color placeholder. */
  imageUrl:     string | null;
}

/**
 * Per-id removal delta. One event fires per removed row — sales that remove
 * every listing for a mint produce N events (one per source/route). Cancels
 * and pool-withdraws (when eventually wired) remove one specific id at a time.
 */
export interface ListingRemoveDelta {
  slug: string;
  id:   string;
}

export interface ListingSnapshotDelta {
  slug:     string;
  listings: ListingOutWire[];
}

/**
 * Emitted by ingestion after parsing a program tx that was NOT a sale.
 * The listings-store uses this to flag potentially-affected collections for
 * debounced reconciliation — covers new listings, cancels/delists, and
 * pool deposit/withdraw/updates without requiring a dedicated parser for
 * each instruction type.
 */
export interface TxMintsTouched {
  mints: string[];
}

/**
 * Precise delist signal — emitted when ingestion sees a verified
 * delist/cancel instruction (TCOMP delist_core / delist_compressed /
 * delist_legacy / delist). Store reacts identically to a sale: look up
 * every id for `mint` in byMint, remove them, emit id-based
 * `listing_remove` SSE deltas. No external fetch, no debounce.
 */
export interface ListingConfirmedDelist {
  mint: string;
}

/**
 * Immediate-refresh hint — emitted when ingestion sees a verified list /
 * reprice / pool-update instruction (TCOMP list_* / edit, ME v2 sell
 * variants, MMM update_pool). Store bypasses the 10 s dirty debounce and
 * calls `ensureFresh(slug, 2_000)` to pull the new/updated price from the
 * upstream snapshot within the snapshot-concurrency bound.
 *
 * `mint` is the primary resolution path. `poolKeys` is a fallback for
 * instructions that don't move an NFT (MMM `update_pool` — pool reprice —
 * has no token-balance delta so the mint extractor returns empty). In that
 * case ingestion passes every account key in the tx and the store checks
 * them against its MMM poolKey→slug index.
 */
export interface ListingRefreshHint {
  mint?:     string;
  poolKeys?: string[];
}

/** Per-marketplace data-source health flip. Emitted by source-health.ts
 *  when a source transitions ok ↔ stale. Forwarded over SSE as `status`. */
export interface SourceStatusWire {
  source: 'magiceden' | 'tensor';
  state:  'ok' | 'stale';
}

// ─── Mint tracker ────────────────────────────────────────────────────────────

export type MintProgramSource = 'mpl_token_metadata' | 'mpl_core' | 'bubblegum';
export type MintType          = 'free' | 'paid' | 'unknown';
export type MintDisplayState  = 'incubating' | 'shown' | 'cooled';

/** Best-effort launchpad / source label. Detection is conservative: a
 *  curated allowlist of known launchpad program IDs maps to specific
 *  labels; everything else falls back to a friendly programSource
 *  string. Operator can extend the allowlist over time. */
export type MintSourceLabel =
  | 'LaunchMyNFT'
  | 'VVV'
  | 'ME'
  | 'Metaplex Candy Machine'
  | 'Metaplex Core'
  | 'Metaplex'
  | 'Bubblegum'
  | 'Unknown';

/** Per-mint event, fired once on detection. */
export interface MintEventWire {
  signature:         string;
  blockTime:         string;
  programSource:     MintProgramSource;
  mintAddress:       string | null;
  collectionAddress: string | null;
  groupingKey:       string;
  groupingKind:      'collection' | 'updateAuthority' | 'creator' | 'mintAuthority' | 'merkleTree' | 'programSource';
  mintType:          MintType;
  priceLamports:     number | null;
  minter:            string | null;
  sourceLabel:       MintSourceLabel;
}

/** Per-collection rollup snapshot, fired every time the accumulator
 *  recomputes a collection's stats. Frontend keeps a rolling map keyed
 *  by `groupingKey` and re-renders the trending table on each tick. */
export interface MintStatusWire {
  groupingKey:       string;
  groupingKind:      MintEventWire['groupingKind'];
  programSource:     MintProgramSource;
  collectionAddress: string | null;
  /** Last accepted MintEventWire.mintAddress for this group. Used by the
   *  frontend as the only safe Solscan link target — never link to
   *  collectionAddress / groupingKey, which can be a collection account,
   *  update authority, or merkle tree (not a viewable NFT). May be null
   *  for cNFT groups whose first sample didn't carry a leaf address. */
  lastMintAddress:   string | null;
  /** Max planned supply for the launchpad collection (e.g. LMNFT
   *  `max_items`, MPL Core master-edition `maxSupply`). Distinct from
   *  `observedMints`, which is "how many of these we've seen ingested".
   *  Null until a supply resolver populates it; frontend renders "—". */
  maxSupply?:        number | null;
  /** LaunchMyNFT-specific deep-link fields. Populated by the
   *  `lmnft` enrichment lookup once the collection is found in the
   *  homepage's featured set. Frontend uses both to build:
   *    https://www.launchmynft.io/collections/{lmntfOwner}/{lmntfCollectionId}
   *  Either being null falls back to a plain-text source pill. */
  lmntfOwner?:        string | null;
  lmntfCollectionId?: string | null;
  displayState:      MintDisplayState;
  shownReason?:      'threshold' | 'burst';
  observedMints:     number;
  /** Mints in the last 60 s window. */
  v60:               number;
  /** Average mints/min over the last 5 min window. */
  v5m:               number;
  lastMintAt:        number;
  mintType:          MintType | 'mixed';
  priceLamports:     number | null;
  sourceLabel:       MintSourceLabel;
  /** Soft metadata, populated lazily (may be undefined for many ticks). */
  name?:             string;
  imageUrl?:         string;
}

/**
 * In-process event bus. insertSaleEvent emits 'sale' here;
 * the SSE endpoint subscribes and fans out to connected clients.
 *
 * Single-process only. If multi-process deployment is needed later,
 * replace with Redis pub/sub.
 */
class SaleEventBus extends EventEmitter {
  emitSale(event: SaleEvent): void {
    this.emit('sale', event);
  }
  onSale(listener: (event: SaleEvent) => void): this {
    return this.on('sale', listener);
  }
  offSale(listener: (event: SaleEvent) => void): this {
    return this.off('sale', listener);
  }

  emitMetaUpdate(update: MetaUpdate): void {
    this.emit('meta', update);
  }
  onMetaUpdate(listener: (update: MetaUpdate) => void): this {
    return this.on('meta', listener);
  }
  offMetaUpdate(listener: (update: MetaUpdate) => void): this {
    return this.off('meta', listener);
  }

  /**
   * Emitted when a blacklisted event is detected after enrichment.
   * The SSE endpoint forwards this to all clients so they can drop the card.
   */
  emitRemove(signature: string): void {
    this.emit('remove', signature);
  }
  onRemove(listener: (signature: string) => void): this {
    return this.on('remove', listener);
  }
  offRemove(listener: (signature: string) => void): this {
    return this.off('remove', listener);
  }

  /**
   * Emitted when a fast-path (Helius data) event is later corrected by the
   * raw RPC parser. Lets the frontend update saleType / marketplace / parties
   * without removing and re-adding the card.
   */
  emitRawPatch(patch: RawPatch): void {
    this.emit('rawpatch', patch);
  }
  onRawPatch(listener: (patch: RawPatch) => void): this {
    return this.on('rawpatch', listener);
  }
  offRawPatch(listener: (patch: RawPatch) => void): this {
    return this.off('rawpatch', listener);
  }

  /** Per-mint removal delta, emitted by listings-store when a mint is
   *  removed from any active collection (sale-triggered today; cancel/delist
   *  when listings ingestion lands). */
  emitListingRemove(delta: ListingRemoveDelta): void {
    this.emit('listing_remove', delta);
  }
  onListingRemove(listener: (delta: ListingRemoveDelta) => void): this {
    return this.on('listing_remove', listener);
  }
  offListingRemove(listener: (delta: ListingRemoveDelta) => void): this {
    return this.off('listing_remove', listener);
  }

  /** Full per-slug replacement, emitted by listings-store after a snapshot
   *  refresh or a dirty-triggered reconciliation. */
  emitListingSnapshot(delta: ListingSnapshotDelta): void {
    this.emit('listing_snapshot', delta);
  }
  onListingSnapshot(listener: (delta: ListingSnapshotDelta) => void): this {
    return this.on('listing_snapshot', listener);
  }
  offListingSnapshot(listener: (delta: ListingSnapshotDelta) => void): this {
    return this.off('listing_snapshot', listener);
  }

  /** Ingestion → listings-store signal: a program tx touched these NFT-like
   *  mints but was NOT a sale. Listings-store maps those mints back to slugs
   *  via its byMint index and markDirty()s them. No-op for mints we don't
   *  currently track. */
  emitTxMintsTouched(evt: TxMintsTouched): void {
    this.emit('tx_mints_touched', evt);
  }
  onTxMintsTouched(listener: (evt: TxMintsTouched) => void): this {
    return this.on('tx_mints_touched', listener);
  }
  offTxMintsTouched(listener: (evt: TxMintsTouched) => void): this {
    return this.off('tx_mints_touched', listener);
  }

  /** Precise delist — store removes all ids for `mint`. */
  emitListingConfirmedDelist(evt: ListingConfirmedDelist): void {
    this.emit('listing_confirmed_delist', evt);
  }
  onListingConfirmedDelist(listener: (evt: ListingConfirmedDelist) => void): this {
    return this.on('listing_confirmed_delist', listener);
  }
  offListingConfirmedDelist(listener: (evt: ListingConfirmedDelist) => void): this {
    return this.off('listing_confirmed_delist', listener);
  }

  /** Immediate-refresh hint — store calls ensureFresh(slug, 2_000). */
  emitListingRefreshHint(evt: ListingRefreshHint): void {
    this.emit('listing_refresh_hint', evt);
  }
  onListingRefreshHint(listener: (evt: ListingRefreshHint) => void): this {
    return this.on('listing_refresh_hint', listener);
  }
  offListingRefreshHint(listener: (evt: ListingRefreshHint) => void): this {
    return this.off('listing_refresh_hint', listener);
  }

  /** Per-marketplace data-source health flip (ok ↔ stale). Forwarded by
   *  the SSE layer as a `status` event so connected clients can render a
   *  degraded-state indicator. */
  emitSourceStatus(s: SourceStatusWire): void {
    this.emit('source_status', s);
  }
  onSourceStatus(listener: (s: SourceStatusWire) => void): this {
    return this.on('source_status', listener);
  }
  offSourceStatus(listener: (s: SourceStatusWire) => void): this {
    return this.off('source_status', listener);
  }

  /** Per-NFT mint event (fired once per detected mint tx). */
  emitMint(m: MintEventWire): void { this.emit('mint', m); }
  onMint(listener: (m: MintEventWire) => void): this { return this.on('mint', listener); }
  offMint(listener: (m: MintEventWire) => void): this { return this.off('mint', listener); }

  /** Per-collection rollup, fired on every accumulator recompute. */
  emitMintStatus(s: MintStatusWire): void { this.emit('mint_status', s); }
  onMintStatus(listener: (s: MintStatusWire) => void): this { return this.on('mint_status', listener); }
  offMintStatus(listener: (s: MintStatusWire) => void): this { return this.off('mint_status', listener); }
}

export const saleEventBus = new SaleEventBus();
// Prevent Node warning when many SSE clients connect simultaneously
saleEventBus.setMaxListeners(500);
