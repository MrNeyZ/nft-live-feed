/**
 * Collection Analyzer Tool — shared types.
 *
 * Read-only Solana NFT collection preview analyzer. Source of truth is
 * Helius DAS `getAssetsByGroup` (groupKey="collection") — same on-chain-only
 * principle as the Holder Count tool (no marketplace stat is ever trusted for
 * asset data; marketplace URLs are only used to resolve a slug → sample mint
 * → on-chain collection address, never scraped for asset content).
 */

/** How the caller's input was classified. Mint/address are both
 *  base58-shaped; which one it actually is gets disambiguated on-chain
 *  (a mint's DAS grouping points at a DIFFERENT collection address). */
export type CollectionAnalyzerInputKind = 'collection' | 'mint' | 'tensor_url' | 'magiceden_url';

export interface NormalizedAttribute {
  trait_type: string;
  value: string;
}

/** One NFT asset normalized from a Helius DAS `getAssetsByGroup` item. */
export interface NormalizedAsset {
  mint: string;
  name: string | null;
  image: string | null;
  jsonUri: string | null;
  collectionAddress: string | null;
  /** True for compressed (Bubblegum) assets, false for regular (Core/pNFT/legacy). */
  compressed: boolean;
  /** Coarse asset-standard bucket, distinct from `compressed`. */
  standard: 'core' | 'pnft' | 'legacy' | 'compressed' | 'unknown';
  attributes: NormalizedAttribute[];
}

/** Distinct trait values seen within the fetched preview, with counts. */
export interface TraitCategorySummary {
  traitType: string;
  values: Array<{ value: string; count: number }>;
}

export interface CollectionAnalysis {
  inputKind: CollectionAnalyzerInputKind;
  inputValue: string;
  collectionAddress: string;
  /** Exact indexed total from DAS `result.total`, when the provider returns
   *  one. Null when unavailable — never guessed. */
  totalAssets: number | null;
  /** Number of assets actually fetched into this preview (<= requested limit). */
  previewCount: number;
  assets: NormalizedAsset[];
  traitCategories: TraitCategorySummary[];
  updatedAt: string;
  warnings: string[];
}
