import { EventEmitter } from 'events';
import { SaleEvent } from '../models/sale-event';

/** Per-sale resize-status patch. Emitted by `resize-status-resolver`
 *  after a lookup completes for a mint whose origin sale signature was
 *  captured at enqueue time. Carries the originating `signature` so the
 *  frontend's feed reducer can target the exact row. */
export interface ResizeStatusPatch {
  signature:    string;
  mint:         string;
  resizeStatus: 'none' | 'metaplex_resized_unclaimed' | 'claimed' | 'user_resized';
}

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
  | 'GRAVE'
  | 'ME'
  | 'Metaplex Candy Machine'
  | 'Metaplex Core'
  | 'Metaplex'
  | 'Bubblegum'
  | 'nfts.gay'
  | 'Unknown';

/** Per-mint event, fired once on detection. */
/** Per-mint metadata patch — late-arriving DAS resolution surfaces
 *  the NFT-level name + image after the original `mint` event has
 *  already been broadcast. Frontend matches by signature, falls back
 *  to mintAddress for cNFTs / replays where signature isn't carried. */
export interface MintMetaPatch {
  signature:   string;
  mintAddress: string | null;
  nftName:     string | null;
  imageUrl:    string | null;
}

/** Late-arriving seller-count refresh — used when the active-dumper
 *  exact-count fallback finishes a deep `getAssetsByOwner` walk and
 *  the resolved count needs to fan out to every connected client. */
export interface SellerCountUpdate {
  seller:     string;
  collection: string;
  count:      number;
  sells10m:   number;
  /** Optional dumping-signal hint, mirrors the `signal` field on the
   *  initial onSale `seller_count` broadcast. The exact-fallback path
   *  (`seller-count-exact.ts`) does not currently compute this — it
   *  emits without `signal` so the SSE rebroadcast omits the field
   *  too, letting the frontend reducer decide whether to clear or
   *  keep any prior 🔥 state. Reserved for future producers that
   *  *do* derive a signal late. */
  signal?:    'multi';
}

/** Payment token resolved metadata broadcast on the bus once per unique
 *  paymentMint. The DAS lookup is fire-and-forget and cached forever
 *  (token metadata is immutable for the lifetime of a mint), so this
 *  fans out at most once per token. Frontend keeps a Map keyed by mint. */
export interface PaymentTokenMeta {
  mint:     string;
  symbol:   string | null;
  name:     string | null;
  image:    string | null;
  decimals: number | null;
}

export interface MintEventWire {
  signature:         string;
  blockTime:         string;
  programSource:     MintProgramSource;
  mintAddress:       string | null;
  collectionAddress: string | null;
  groupingKey:       string;
  groupingKind:      'collection' | 'updateAuthority' | 'creator' | 'mintAuthority' | 'merkleTree' | 'programSource';
  mintType:          MintType;
  /** SOL paid by the signer (preBalance[0] - postBalance[0]). For
   *  SPL-token-paid mints this is the rent paid for the new asset,
   *  NOT the actual mint price — the real price lives in
   *  paymentMint / paymentAmount / paymentDecimals. */
  priceLamports:     number | null;
  /** SPL Token / Token-2022 mint paid by the signer, when the mint was
   *  priced in a custom token. Null for SOL-priced or free mints.
   *  Detected from preTokenBalances/postTokenBalances delta on accounts
   *  owned by the signer. */
  paymentMint?:      string | null;
  /** Raw token amount paid (u64 as string to preserve precision). */
  paymentAmount?:    string | null;
  /** Decimals for paymentMint, for ui-amount conversion. */
  paymentDecimals?:  number | null;
  minter:            string | null;
  sourceLabel:       MintSourceLabel;
  /** Visual subtype marker: true for Core Candy Machine v3 / Core Candy Guard
   *  launchpad mints. Semantics stay CORE (programSource 'mpl_core', sourceLabel
   *  'Metaplex Core'); the frontend just renders the CORE badge in the CANDY
   *  pink palette so launchpad Core mints read differently from raw Core
   *  ecosystem activity. Absent/false on every other path. */
  coreLaunchpad?:    boolean;
  /** Number of NFTs minted by this transaction. 1 for a normal single
   *  mint; >1 for bulk-mint txs (counted from per-NFT mint instructions
   *  in the tx logs). Absent on hydrated legacy rows → treated as 1. */
  nftCount?:         number;
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
  /** Total assets indexed by DAS for this collection — a faithful
   *  "minted so far" proxy for launchpad drops. Refreshed on a
   *  cadence (per-row, throttled) and on every Nth observed mint.
   *  Distinct from `observedMints` (session-only) and `maxSupply`
   *  (planned cap). Null until the first DAS lookup resolves. */
  mintedCount?:      number | null;
  /** LaunchMyNFT-specific deep-link fields. Populated by the
   *  `lmnft` enrichment lookup once the collection is found in the
   *  homepage's featured set. Frontend uses both to build:
   *    https://www.launchmynft.io/collections/{lmntfOwner}/{lmntfCollectionId}
   *  Either being null falls back to a plain-text source pill. */
  lmntfOwner?:        string | null;
  lmntfCollectionId?: string | null;
  /** Total NFTs minted in this drop so far. For MPL Core collections
   *  populated from the on-chain CollectionV1 `num_minted` u32 by the
   *  core-supply refresher. Until the refresher has visited the
   *  collection, mirrors the running optimistic count (`observedMints`
   *  worth seen this session) so the SUPPLY column has something to
   *  show; `supplyVerified` distinguishes "authoritative on-chain
   *  number" from "running local count". Distinct from `maxSupply`
   *  (planned cap, currently LMNFT-only) and `mintedCount` (DAS proxy
   *  used for MINTED column on LMNFT rows). */
  supplyMinted?:     number | null;
  /** True iff `supplyMinted` came from a successful on-chain decode
   *  of the collection's CollectionV1 account. False/undefined means
   *  the value is the session-local optimistic count and may lag /
   *  miss mints from before the row was opened. */
  supplyVerified?:   boolean;
  displayState:      MintDisplayState;
  shownReason?:      'threshold' | 'burst' | 'launchpad';
  observedMints:     number;
  /** Live Mint Feed cards actually emitted for this collection (session-local,
   *  same scope as observedMints). Under velocity sampling this is
   *  < observedMints; observedMints − emittedCards = cards sampled out.
   *  Optional/back-compat: null/absent when no sampling state exists yet.
   *  Display-only — drives the MINTS-column hover tooltip. */
  emittedCards?:     number | null;
  /** Mints in the last 60 s window. */
  v60:               number;
  /** Average mints/min over the last 5 min window. */
  v5m:               number;
  lastMintAt:        number;
  /** Earliest moment the backend's accumulator opened a slot for this
   *  collection — i.e. the timestamp of the first mint we ingested
   *  for the groupingKey this process lifetime. NOT the on-chain
   *  collection creation date (which would cost an extra RPC per row);
   *  it's a defensible "first seen" proxy that the frontend renders in
   *  the CREATED column. */
  firstSeenAt?:      number;
  /** On-chain collection creation timestamp (ms). Resolved out-of-band
   *  by `collection-created-resolver.ts` via earliest gSFA signature
   *  blockTime, cached in the `collection_created` table. Far older
   *  than `firstSeenAt` in practice — collections often existed for
   *  weeks/months before our tracker first observed a mint from them.
   *  Frontend prefers this over `firstSeenAt` when present. */
  collectionCreatedAt?: number;
  mintType:          MintType | 'mixed';
  priceLamports:     number | null;
  sourceLabel:       MintSourceLabel;
  /** Visual subtype: true once a Core Candy Machine v3 / Core Candy Guard mint
   *  has been seen for this collection (sticky). Frontend renders the CORE
   *  badge in the CANDY pink palette. Semantics stay CORE. */
  coreLaunchpad?:    boolean;
  /** Soft metadata, populated lazily (may be undefined for many ticks). */
  name?:             string;
  /** Collection-level hero art. Sticky write-once — only
   *  `enrichLaunchpadCollectionMeta` populates it. Render priority on
   *  the tracker table is `imageUrl → representativeImageUrl →
   *  initials`; the live-feed card prefers per-mint `nftImageUrl` and
   *  does NOT use this as a default fallback (avoids the "every card
   *  looks identical" failure mode). */
  imageUrl?:         string;
  /** Representative per-NFT image — a confidently-unique per-mint
   *  image URL from this collection, set by `collection-confirm.ts`
   *  ONLY after the launchpad has been observed serving variety
   *  (>=2 distinct image URLs across mints in this drop) AND the
   *  URL being patched is unique to its own mint. Sticky write-once.
   *  Used by the tracker table thumbnail as a 2nd-tier fallback
   *  when the collection hero is missing/broken, and by the live-
   *  feed card as a 2nd-tier fallback when the per-mint URL turns
   *  out to be a shared placeholder. Distinct from per-mint
   *  `nftImageUrl` (sent via `mint_meta`) — this is a single sticky
   *  URL per collection, not per-mint. */
  representativeImageUrl?: string;
  /** Shared-placeholder image URL — the URL the launchpad serves
   *  pre-reveal as a single shared image for many/all mints in
   *  this collection. Set by `collection-confirm.ts` once we
   *  observe the same URL on >=2 distinct mints. NOT sticky —
   *  refreshed as new placeholders are detected (rare; one drop
   *  usually has one pre-reveal asset). Frontend live-feed card
   *  compares `ev.nftImageUrl` against this and falls through to
   *  the representative/initials chain when they match — so a
   *  pre-reveal drop doesn't paint every card with the same
   *  shared placeholder, which erases the "this NFT just minted"
   *  signal the live feed exists to convey. */
  sharedPlaceholderImageUrl?: string;
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

  /** Resize-status resolved (or refreshed) for a mint that was the
   *  subject of a recent sale. SSE forwards on the `resize_status`
   *  channel; the feed reducer applies it by `signature`. */
  emitResizeStatusPatch(patch: ResizeStatusPatch): void {
    this.emit('resize_status', patch);
  }
  onResizeStatusPatch(listener: (patch: ResizeStatusPatch) => void): this {
    return this.on('resize_status', listener);
  }
  offResizeStatusPatch(listener: (patch: ResizeStatusPatch) => void): this {
    return this.off('resize_status', listener);
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

  // Per-mint metadata patch — fired when DAS surfaces an NFT-level
  // name/image AFTER the mint event itself has already been emitted.
  // Lets the Live Mint Feed cards swap a shortMint placeholder for
  // the real NFT name without re-emitting the whole event.
  //
  // Bounded ring buffer of recent emits. New SSE clients replay this
  // on connect so a tab that loads after the meta patch already fanned
  // out can still resolve images for cards it hydrated from
  // localStorage / mint_status snapshot. Sized to comfortably cover the
  // longest DAS retry window (5 min, ~30 mints/min worst-case bursts);
  // 250 = ~8 min of headroom while keeping memory negligible (~30 KB).
  // Dedupe-by-signature on insert so repeat patches for the same mint
  // (image upgrade, name upgrade) only keep the latest copy in the
  // replay tail. No persistence — the buffer is throwaway, rebuilt as
  // soon as new mints flow.
  emitMintMeta(p: MintMetaPatch): void {
    rememberRecentMintMeta(p);
    this.emit('mint_meta', p);
  }
  onMintMeta(listener: (p: MintMetaPatch) => void): this { return this.on('mint_meta', listener); }
  offMintMeta(listener: (p: MintMetaPatch) => void): this { return this.off('mint_meta', listener); }

  // Per-payment-token metadata. Fired once per unique paymentMint when
  // the lazy DAS lookup resolves. Frontend keeps a Map<mint,info> and
  // renders the symbol/logo beside the SOL price in the Mint Tracker.
  emitPaymentTokenMeta(p: PaymentTokenMeta): void {
    rememberPaymentTokenMeta(p);
    this.emit('payment_token_meta', p);
  }
  onPaymentTokenMeta(listener: (p: PaymentTokenMeta) => void): this {
    return this.on('payment_token_meta', listener);
  }
  offPaymentTokenMeta(listener: (p: PaymentTokenMeta) => void): this {
    return this.off('payment_token_meta', listener);
  }

  // Late-arriving seller-count update from the active-dumper exact-
  // fallback path. Independent of any specific sale signature — it
  // patches every visible row that matches seller+collection.
  emitSellerCountUpdate(u: SellerCountUpdate): void { this.emit('seller_count_update', u); }
  onSellerCountUpdate(listener: (u: SellerCountUpdate) => void): this { return this.on('seller_count_update', listener); }
  offSellerCountUpdate(listener: (u: SellerCountUpdate) => void): this { return this.off('seller_count_update', listener); }
}

export const saleEventBus = new SaleEventBus();
// Prevent Node warning when many SSE clients connect simultaneously
saleEventBus.setMaxListeners(500);

// ─── Recent mint_meta replay buffer ──────────────────────────────────
// In-memory only. Holds the last ~MINT_META_REPLAY_MAX patches in
// emit order (oldest first → newest at tail). Each new SSE connection
// reads `recentMintMetaSnapshot()` and replays the array verbatim
// after the mint_status snapshot, so a tab that just loaded can fill
// in images for live-feed cards whose initial `mint_meta` already
// fanned out before the connection opened.
const MINT_META_REPLAY_MAX = 250;
const recentMintMeta: MintMetaPatch[] = [];
/** Index by signature so a follow-up patch for the same mint
 *  (image-only emit then name-resolved emit, etc.) replaces the prior
 *  entry in-place instead of pushing two copies. Mints without a
 *  signature (defensive — shouldn't happen on the current wire) skip
 *  the dedupe and just append. */
const recentMintMetaIndex = new Map<string, number>();

function rememberRecentMintMeta(p: MintMetaPatch): void {
  // Replace existing entry for this signature — keeps the buffer tail
  // pointing at the freshest version of each mint's metadata.
  if (p.signature) {
    const existing = recentMintMetaIndex.get(p.signature);
    if (existing != null && existing < recentMintMeta.length && recentMintMeta[existing]?.signature === p.signature) {
      recentMintMeta[existing] = p;
      return;
    }
  }
  recentMintMeta.push(p);
  if (p.signature) recentMintMetaIndex.set(p.signature, recentMintMeta.length - 1);
  // Bound the buffer. Drop the oldest entry; rebuild the index lazily
  // (cheap: ≤ MINT_META_REPLAY_MAX entries) so signatures still resolve
  // to their current array index after the shift.
  if (recentMintMeta.length > MINT_META_REPLAY_MAX) {
    const dropped = recentMintMeta.shift();
    if (dropped?.signature) recentMintMetaIndex.delete(dropped.signature);
    // The shift moved every remaining entry down by one — rebuild the
    // index in one pass. Cheaper than maintaining offsets across a
    // queue, and only fires once per overflow.
    recentMintMetaIndex.clear();
    for (let i = 0; i < recentMintMeta.length; i++) {
      const sig = recentMintMeta[i].signature;
      if (sig) recentMintMetaIndex.set(sig, i);
    }
  }
}

/** Snapshot for SSE handlers — returns a shallow copy in emit order so
 *  the caller can iterate without worrying about mutation if a new
 *  patch lands mid-replay. */
export function recentMintMetaSnapshot(): MintMetaPatch[] {
  return recentMintMeta.slice();
}

/** Boot-time hydration: refill the recent mint_meta replay buffer from the
 *  DB-backed store so re-opened tabs get enriched names/images for replayed
 *  events even right after a backend restart. */
export function hydrateRecentMintMeta(patches: MintMetaPatch[]): void {
  for (const p of patches) rememberRecentMintMeta(p);
}

// ─── Payment-token meta cache + replay ──────────────────────────────
// One entry per unique paymentMint. Token metadata is immutable for the
// life of the mint, so a single resolution is permanent — no eviction.
const paymentTokenMeta = new Map<string, PaymentTokenMeta>();

function rememberPaymentTokenMeta(p: PaymentTokenMeta): void {
  paymentTokenMeta.set(p.mint, p);
}

/** Snapshot for SSE replay on connect. */
export function paymentTokenMetaSnapshot(): PaymentTokenMeta[] {
  return Array.from(paymentTokenMeta.values());
}

/** Check whether a paymentMint has already been resolved (used by the
 *  enricher to skip duplicate DAS lookups). */
export function hasPaymentTokenMeta(mint: string): boolean {
  return paymentTokenMeta.has(mint);
}
