// VictoryLabs — Mints: shared wire / sort types.
// Extracted verbatim from page.tsx so newly-introduced helper modules
// (palette / format / source) and per-row sub-components can import a
// canonical definition instead of redeclaring or `import type`-ing from
// the page file (which would create a render-time cycle). No fields
// added or removed vs. the original inline definitions.

/** Timeframe pills above the COLLECTIONS table. Used as the filter
 *  window for the RECENT tab and as the divisor in the MINTS / RATE
 *  / COEF cells. Externalised so the row component, the page, and
 *  any future intelligence-overlay code can share a single canonical
 *  list — the literal `as const` tuple keeps the type narrow. */
export const MINT_TIMEFRAMES = ['5M', '10M', '15M', '30M', '1H', '4H', '1D'] as const;
export type MintTimeframe = typeof MINT_TIMEFRAMES[number];
export const MINT_TF_MS: Record<MintTimeframe, number> = {
  '5M':   5 * 60_000,
  '10M': 10 * 60_000,
  '15M': 15 * 60_000,
  '30M': 30 * 60_000,
  '1H':  60 * 60_000,
  '4H':  4  * 60 * 60_000,
  '1D':  24 * 60 * 60_000,
};
/** Per-timeframe tooltips for the pills in the tracker header. Same
 *  phrasing across pills so users learn the rule once and don't have
 *  to interpret each label — the window scopes WHICH rows appear and
 *  the active-window math behind RATE / COEF. */
export const MINT_TF_DESC: Record<MintTimeframe, string> = {
  '5M':  'Show collections active in the last 5 minutes',
  '10M': 'Show collections active in the last 10 minutes',
  '15M': 'Show collections active in the last 15 minutes',
  '30M': 'Show collections active in the last 30 minutes',
  '1H':  'Show collections active in the last hour',
  '4H':  'Show collections active in the last 4 hours',
  '1D':  'Show collections active in the last 24 hours',
};

export type ProgramSource = 'mpl_token_metadata' | 'mpl_core' | 'bubblegum';
export type MintRollupType = 'free' | 'paid' | 'unknown' | 'mixed';
export type SourceLabel =
  | 'LaunchMyNFT' | 'VVV' | 'GRAVE' | 'ME'
  | 'Metaplex Candy Machine' | 'Metaplex Core' | 'Metaplex'
  | 'Bubblegum' | 'nfts.gay' | 'Unknown';

export interface MintStatus {
  groupingKey:       string;
  groupingKind:      string;
  programSource:     ProgramSource;
  collectionAddress: string | null;
  /** Latest mintAddress seen for this group — the only safe Solscan
   *  link target. May be null until the first event arrives or for
   *  cNFT groups whose first sample didn't carry a leaf address. */
  lastMintAddress?:  string | null;
  /** Max planned supply for the collection (e.g. LMNFT `max_items`,
   *  MPL Core master-edition `maxSupply`). Distinct from
   *  `observedMints` — this is "how big the drop will be", not "how
   *  many we've seen". Optional — backend may not populate it until a
   *  launchpad-specific resolver decodes the relevant config account.
   *  UI falls back to "—" when null/undefined per spec. */
  maxSupply?:        number | null;
  /** Total assets DAS has indexed for this collection — backend's
   *  proxy for "how many minted so far". Refreshed on a 30 s per-row
   *  cadence. UI shows it as the MINTED column; falls back to
   *  `observedMints` when null so the cell isn't ever empty. */
  mintedCount?:      number | null;
  /** LaunchMyNFT URL fragments. Backend populates them via the LMNFT
   *  homepage scraper (`src/enrichment/lmnft.ts`). Both required to
   *  build the deep-link; either null falls back to a plain pill. */
  lmntfOwner?:        string | null;
  lmntfCollectionId?: string | null;
  /** Total NFTs minted in this drop so far. Backend populates from
   *  on-chain MPL Core `CollectionV1.num_minted` (Core/VVV/GRAVE
   *  rows); until the core-supply refresher has visited the row this
   *  mirrors the running session-local count. Used as the SUPPLY
   *  column fallback when `maxSupply` (planned cap) is unknown. */
  supplyMinted?:     number | null;
  /** True iff `supplyMinted` came from a successful on-chain decode
   *  rather than the optimistic local counter. UI mutes unverified
   *  values slightly so the operator can tell at a glance. */
  supplyVerified?:   boolean;
  displayState:      'incubating' | 'shown' | 'cooled';
  shownReason?:      'threshold' | 'burst' | 'launchpad';
  observedMints:     number;
  /** Live Mint Feed cards emitted for this collection (session-local, same
   *  scope as observedMints). observedMints − emittedCards = sampled-out cards.
   *  Optional/back-compat: undefined when the backend hasn't sent it. */
  emittedCards?:     number | null;
  v60:               number;
  v5m:               number;
  lastMintAt:        number;
  /** Earliest mint this backend process observed for the collection
   *  (accumulator's `firstObservedAt`, surfaced on the wire). Backend
   *  proxy for "collection first seen" — not an on-chain creation
   *  timestamp. Drives the CREATED column. May be missing on rows that
   *  predate the field on the backend. */
  firstSeenAt?:      number;
  /** On-chain collection creation timestamp (ms). Resolved by the
   *  backend's `collection-created-resolver` via earliest gSFA
   *  blockTime; cached in `collection_created`. Preferred over
   *  `firstSeenAt` for the CREATED column when present (real creation
   *  date, not just "first observed by our tracker"). */
  collectionCreatedAt?: number;
  mintType:          MintRollupType;
  priceLamports:     number | null;
  sourceLabel:       SourceLabel;
  /** Visual subtype: Core Candy Machine v3 launchpad collection. Renders the
   *  CORE badge in the CANDY pink palette. Semantics stay CORE. */
  coreLaunchpad?:    boolean;
  name?:             string;
  /** Collection-level hero art. Tracker table's PRIMARY thumbnail
   *  source. Live-feed cards do NOT use this as a default fallback. */
  imageUrl?:         string;
  /** Confidently-unique per-NFT image observed in this drop —
   *  sticky, backend-side. Only set after the launchpad has been
   *  observed serving variety (≥2 distinct URLs) so a pre-reveal
   *  placeholder shared across every mint is NOT promoted to this
   *  slot. Used as 2nd-tier fallback by the tracker table thumbnail
   *  AND by the live-feed card (when `ev.nftImageUrl` turns out to
   *  match the shared placeholder URL below). */
  representativeImageUrl?: string;
  /** Shared-placeholder image URL detected in this drop — set
   *  backend-side once the same URL is observed on ≥2 distinct
   *  mints. Live-feed card compares `ev.nftImageUrl` against this
   *  and falls through to representative / initials when they
   *  match — keeps cards from painting the same pre-reveal asset
   *  on every mint. Tracker table ignores this field; a shared
   *  placeholder is fine as a collection-row image. */
  sharedPlaceholderImageUrl?: string;
}

/** Per-collection rollup of mint events that fell inside the user's
 *  selected timeframe window. Computed in `useMemo` from the live
 *  event stream + the current `mintTf` selection; consumed by both
 *  the table-row JSX (RATE / COEF / MINTS cells) and the sorted-rows
 *  memo. Externalised here so the row component and the page share a
 *  single source of truth for the shape — previously the shape was
 *  declared inline twice (once in the useMemo, once implicitly in
 *  the IIFE that read it). */
export interface MintsTimeframeStats {
  count:      number;
  firstTs:    number;
  lastTs:     number;
  /** Mints that landed in the last quarter of the timeframe window.
   *  Used by the HEAT-score render to compute the recency multiplier
   *  (`recencyMult = 0.5 + recentQ / count`) alongside the page-side
   *  HEAT calculation. Counted in the same useMemo so the two
   *  formulas can never drift. */
  recentQ:    number;
  /** HEAT composite — throughput × supplyMult × recencyMult.
   *  Field name kept as `mintPerMin` for cross-module backwards
   *  compatibility with the prior "mints/min" semantic; the value
   *  is no longer a raw rate. See the comment block above
   *  `tfStatsByKey` in page.tsx for the formula and tunings. */
  mintPerMin: number;
}

/** Individual mint event — one fired per detected mint, before
 *  aggregation. Backend broadcasts these on the existing `event: mint`
 *  SSE channel (see src/events/emitter.ts MintEventWire); we mirror
 *  the shape here. Per-mint `nftName` / `imageUrl` are intentionally
 *  not on the wire — those are resolved per-`groupingKey` by the
 *  backend enricher and arrive via `mint_status`. The live feed
 *  uses the group-level imageUrl (looked up from `rows`) as the
 *  row thumbnail, with a placeholder when not yet resolved. */
export interface MintEvent {
  signature:         string;
  blockTime:         string;          // ISO 8601
  programSource:     ProgramSource;
  mintAddress:       string | null;
  collectionAddress: string | null;
  groupingKey:       string;
  groupingKind:      string;
  mintType:          'free' | 'paid' | 'unknown';
  /** SOL paid by the signer. For SPL-token-priced mints this is the rent
   *  paid for the new asset, NOT the real price — see paymentMint below. */
  priceLamports:     number | null;
  /** SPL / Token-2022 mint paid when the mint was priced in a custom
   *  token. Symbol/logo come from the SSE `payment_token_meta` channel. */
  paymentMint?:      string | null;
  paymentAmount?:    string | null;     // raw u64 as string
  paymentDecimals?:  number | null;
  minter:            string | null;
  sourceLabel:       SourceLabel;
  /** Visual subtype: Core Candy Machine v3 launchpad mint → pink CORE badge. */
  coreLaunchpad?:    boolean;
  /** Timestamp anchor (ms). Anchored to on-chain blockTime (see the
   *  live SSE handler) so the "Xs ago" column + ordering stay truthful
   *  across reconnect replays. NOTE: this is NOT wall-clock arrival —
   *  for the fresh-arrival flash gate use `clientArrivedAt` instead. */
  receivedAt:        number;
  /** Wall-clock time (ms) the event actually arrived on the LIVE SSE
   *  path in this tab. Undefined for snapshot / replay / restored rows
   *  so they never replay the fresh-arrival flash. The flash predicate
   *  keys off this, not `receivedAt` (which is blockTime and is already
   *  older than the flash window by the time the row paints). */
  clientArrivedAt?:  number;
  /** Per-mint metadata, lazily filled by the SSE `mint_meta` patch
   *  once DAS surfaces them. Live Mint Feed cards swap a
   *  shortMint(mintAddress) placeholder for the real NFT name + image
   *  the moment these arrive. */
  nftName?:          string | null;
  nftImageUrl?:      string | null;
  /** Number of NFTs minted by this tx. >1 → bulk mint (card appends
   *  " (N)" after the name). Absent/1 → single mint, no suffix. */
  nftCount?:         number;
}

/** Resolved metadata for a custom-token mint payment. Streamed once per
 *  unique paymentMint via the SSE `payment_token_meta` channel; backend
 *  replays the snapshot on connect. */
export interface PaymentTokenInfo {
  mint:     string;
  symbol:   string | null;
  name:     string | null;
  image:    string | null;
  decimals: number | null;
}
