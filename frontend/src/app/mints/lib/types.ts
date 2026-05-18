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
  | 'Bubblegum' | 'Unknown';

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
  /** True when this row represents an MPL Core collection-creation
   *  event (the asset DAS classifies as `MplCoreCollection`) rather
   *  than a regular Core NFT mint. Backend-set: either at parse time
   *  via the `Instruction: CreateCollection` family log, or late by
   *  the enricher when DAS confirms the interface. Sticky once set.
   *  Frontend renders a small `COLL` marker alongside the source pill
   *  + a subtle lilac outline on the live-feed thumbnail. Optional —
   *  treated as false / absent for all normal Core NFT mints. */
  isCoreCollection?: boolean;
  displayState:      'incubating' | 'shown' | 'cooled';
  shownReason?:      'threshold' | 'burst';
  observedMints:     number;
  v60:               number;
  v5m:               number;
  lastMintAt:        number;
  mintType:          MintRollupType;
  priceLamports:     number | null;
  sourceLabel:       SourceLabel;
  name?:             string;
  imageUrl?:         string;
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
  priceLamports:     number | null;
  minter:            string | null;
  sourceLabel:       SourceLabel;
  /** Mirror of `MintStatus.isCoreCollection` on the per-mint event so
   *  a Live Mint Feed card rendered before the status frame arrives
   *  (or for a single-event row not yet in the table) still surfaces
   *  the distinct COLL marker. Backend-set; defaults to absent. */
  isCoreCollection?: boolean;
  /** Wall-clock receive time (ms). Drives the "Xs ago" column without
   *  re-parsing blockTime on every tick. */
  receivedAt:        number;
  /** Per-mint metadata, lazily filled by the SSE `mint_meta` patch
   *  once DAS surfaces them. Live Mint Feed cards swap a
   *  shortMint(mintAddress) placeholder for the real NFT name + image
   *  the moment these arrive. */
  nftName?:          string | null;
  nftImageUrl?:      string | null;
}
