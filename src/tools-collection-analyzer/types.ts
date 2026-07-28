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

// Stage 5.3: NormalizedAttribute/NormalizedAsset now live in
// trait-extraction-core (packages/trait-extraction-core/src/asset-types.ts)
// so the runtime-independent extraction core doesn't depend on this app's
// module tree. Re-exported here so every existing import of
// `NormalizedAsset`/`NormalizedAttribute` from './types' keeps working
// unchanged - this file is the single place that couples the app to the
// core's asset shape.
import type { NormalizedAttribute, NormalizedAsset } from 'trait-extraction-core';
export type { NormalizedAttribute, NormalizedAsset };

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
