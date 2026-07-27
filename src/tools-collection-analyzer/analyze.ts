/**
 * Collection Analyzer Tool — pure analysis.
 *
 * Deterministic, network-free: turns a preview fetch result into the
 * CollectionAnalysis response. Separated from the fetch layer so it can be
 * unit-tested against mocked/normalized assets with zero network — mirrors
 * the Holder Count tool's fetch/analyze split.
 */
import type {
  CollectionAnalysis,
  CollectionAnalyzerInputKind,
  NormalizedAsset,
  TraitCategorySummary,
} from './types';

export interface BuildArgs {
  inputKind: CollectionAnalyzerInputKind;
  inputValue: string;
  collectionAddress: string;
  totalAssets: number | null;
  assets: NormalizedAsset[];
  dasError?: string | null;
  extraWarnings?: string[];
  /** Injected so the function stays pure/deterministic for tests. */
  nowIso: string;
}

/** Trait categories + per-value counts observed within the fetched preview
 *  only — never a claim about the full collection's trait distribution. */
export function buildTraitCategories(assets: NormalizedAsset[]): TraitCategorySummary[] {
  const byType = new Map<string, Map<string, number>>();
  for (const asset of assets) {
    for (const attr of asset.attributes) {
      let values = byType.get(attr.trait_type);
      if (!values) { values = new Map(); byType.set(attr.trait_type, values); }
      values.set(attr.value, (values.get(attr.value) ?? 0) + 1);
    }
  }
  return [...byType.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([traitType, values]) => ({
      traitType,
      values: [...values.entries()]
        .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
        .map(([value, count]) => ({ value, count })),
    }));
}

export function buildCollectionAnalysis(args: BuildArgs): CollectionAnalysis {
  const { inputKind, inputValue, collectionAddress, totalAssets, assets, dasError, extraWarnings, nowIso } = args;

  const warnings: string[] = [];
  if (extraWarnings) warnings.push(...extraWarnings);
  if (assets.length === 0) {
    warnings.push('No assets found for this collection — the address may be wrong, or it is not a verified on-chain collection group.');
  }
  if (totalAssets === null && assets.length > 0) {
    warnings.push(`Exact total asset count unavailable — the preview page came back full (${assets.length}+ assets), and the DAS provider's \`total\` field only reflects the fetched page, not the whole collection. Showing preview count only.`);
  }
  if (dasError) {
    warnings.push(`DAS error during fetch (${dasError}) — preview may be incomplete.`);
  }
  warnings.push('Stage 1 preview only — shows a small sample of assets, not the full collection.');

  return {
    inputKind,
    inputValue,
    collectionAddress,
    totalAssets,
    previewCount: assets.length,
    assets,
    traitCategories: buildTraitCategories(assets),
    updatedAt: nowIso,
    warnings,
  };
}
