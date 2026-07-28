/**
 * Trait Extraction Core - the asset shape every extraction input is
 * normalized to before it reaches this package. This is the SAME shape
 * the main app's `tools-collection-analyzer/types.ts` defines - that file
 * re-exports these two types from here (single source of truth) so
 * nothing in the wider app duplicates the asset vocabulary.
 *
 * Deliberately minimal: this package only needs to know how to read
 * attributes off an asset, never how it was fetched (Helius DAS,
 * marketplace resolution, etc - that stays entirely in the caller).
 */

export interface NormalizedAttribute {
  trait_type: string;
  value: string;
}

/** One NFT asset normalized to a collection-agnostic shape. */
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
