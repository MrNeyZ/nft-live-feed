/**
 * Holder Count Tool — shared types.
 *
 * Read-only. Source of truth is Solana asset ownership via Helius DAS
 * (getAssetsByGroup, groupKey="collection"). Magic Eden / Tensor cached holder
 * stats are deliberately NOT used.
 */

/** One entry in the top-holders table. */
export interface HolderEntry {
  wallet:  string;
  count:   number;
  /** count / totalAssets * 100, rounded to 2 dp. 0 when totalAssets is 0. */
  percent: number;
}

/** How many DISTINCT holders fall into each ownership-size bucket. */
export interface HolderDistribution {
  holders1:     number;  // hold exactly 1
  holders2to5:  number;  // hold 2–5
  holders6to10: number;  // hold 6–10
  holders11plus:number;  // hold 11+
}

/** What the caller supplied: a raw on-chain collection address, an individual
 *  NFT mint address (resolved to its collection via DAS getAsset), a
 *  marketplace slug, or a plain collection name — each resolved to an
 *  on-chain collection address before the DAS scan (counts stay DAS-only
 *  either way). */
export type HoldersInputType = 'collection' | 'mint' | 'slug' | 'name';

/** Final analysis returned by the API ( `{ ok: true, analysis }` ). */
export interface HoldersAnalysis {
  /** Whether the request came in as a collection address or a slug. */
  inputType:         HoldersInputType;
  /** The verbatim value the caller passed (address or slug). */
  inputValue:        string;
  /** The on-chain collection address the holder count was computed against.
   *  Equals `inputValue` for address input; the resolved address for slugs. */
  resolvedCollectionAddress: string;
  /** Human-readable collection name when known (resolved from a name/slug
   *  match). Omitted for raw address input where no name was looked up. */
  resolvedName?:     string;
  /** Back-compat alias of resolvedCollectionAddress (kept for the existing
   *  address-flow frontend that read `collectionAddress`). */
  collectionAddress: string;
  totalAssets:       number;
  uniqueHolders:     number;
  /** ISO-8601 timestamp of when this count was computed (server clock). */
  updatedAt:         string;
  topHolders:        HolderEntry[];
  holderDistribution:HolderDistribution;
  /** Non-fatal caveats: excluded ownerless assets, truncated scan, DAS error. */
  warnings:          string[];
}

/** Raw owner list + scan metadata produced by the (network) fetch layer and
 *  consumed by the (pure) analyze layer. Kept as a plain data bag so analyze
 *  can be unit-tested with a mocked DAS result and zero network. */
export interface CollectionOwnerScan {
  /** ownership.owner for every asset that had one (ownerless assets excluded). */
  owners:            string[];
  /** Count of assets whose ownership.owner was missing/empty (excluded above). */
  missingOwnerCount: number;
  /** Count of assets DAS flagged `burnt` (closed on-chain). Excluded from
   *  totals/owners — DAS reports a stale pre-burn owner for them. */
  burntCount:        number;
  /** Total LIVE assets seen across all walked pages (burnt excluded). */
  totalAssets:       number;
  /** True when the scan stopped at the page/asset safety cap with more to go. */
  truncated:         boolean;
  /** Non-null when a DAS page returned an error mid-scan (partial result). */
  dasError:          string | null;
}
