/**
 * Collection Analyzer — Stage 2 full-scan normalization + analysis.
 *
 * Pure, network-free. Two layers:
 *   1. `normalizeAssetAttributesFull` — per-asset attribute normalization
 *      (numeric/boolean/null/whitespace/non-string trait_type/duplicate
 *      trait_type/malformed shapes), never silently discarding — every
 *      skip/coercion increments a counter surfaced in `QualityDiagnostics`.
 *   2. `buildFullAnalysis` — collection-wide rollup (trait stats, quality
 *      diagnostics, duplicate groups, traits-per-NFT distribution) from the
 *      complete deduplicated asset set produced by `scan-fetch.ts`.
 *
 * Deliberately separate from Stage 1's `analyze.ts` (preview-only, untouched)
 * even though the concepts overlap — Stage 1 must stay byte-for-byte
 * backward compatible.
 */
import type { NormalizedAsset, NormalizedAttribute } from './types';
import {
  DUPLICATE_GROUP_MINT_SAMPLE_CAP,
  ONE_OF_ONE_HIGHLIGHT_CAP,
} from './scan-limits';
import type {
  DuplicateGroupSummary,
  FullTraitCategorySummary,
  OneOfOneHighlight,
  QualityDiagnostics,
  TraitsPerNftBucket,
} from './scan-types';

// ── Per-asset attribute normalization ───────────────────────────────────

export type AttributeIssue =
  | 'malformed_shape'
  | 'non_string_trait_type_coerced'
  | 'null_value'
  | 'empty_value'
  | 'duplicate_identical_pair'
  | 'duplicate_conflicting_trait_type';

export interface NormalizeAttributeValueResult {
  value: string;
  issue?: 'null_value' | 'empty_value';
}

/** Normalizes one attribute VALUE deterministically. Handles numeric,
 *  boolean, null/undefined, and whitespace-differing strings — never
 *  throws, never returns undefined. */
export function normalizeTraitValue(raw: unknown): NormalizeAttributeValueResult {
  if (raw === null || raw === undefined) return { value: '(null)', issue: 'null_value' };
  if (typeof raw === 'number' || typeof raw === 'boolean') return { value: String(raw) };
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.length === 0) return { value: '(empty)', issue: 'empty_value' };
    return { value: trimmed };
  }
  // object/array value — not safely representable as a scalar trait value.
  // Caller treats this as a malformed-shape skip, not reachable via this
  // return path (see normalizeAssetAttributesFull's isPlainScalar guard).
  return { value: '(null)', issue: 'null_value' };
}

function isPlainScalar(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

export interface NormalizeAttributesResult {
  attributes: NormalizedAttribute[];
  issues: AttributeIssue[];
}

/**
 * Normalizes one asset's raw `content.metadata.attributes` array into a
 * clean `NormalizedAttribute[]`, handling every malformed shape called out
 * in the Stage 2 spec:
 *   - the attributes container itself isn't an array → malformed_shape,
 *     empty result (never throws).
 *   - non-string trait_type (number/boolean) → coerced via String(...).
 *   - trait_type that's an object/array/missing → malformed_shape, skipped.
 *   - value is object/array → malformed_shape, skipped.
 *   - null/undefined value → normalized to "(null)".
 *   - whitespace-only or blank string value → normalized to "(empty)".
 *   - duplicated trait_type within the SAME asset:
 *       - identical normalized value both times → collapsed to one.
 *       - differing values → first occurrence wins (deterministic; array
 *         order), flagged as a conflicting duplicate.
 */
export function normalizeAssetAttributesFull(rawAttributes: unknown): NormalizeAttributesResult {
  const issues: AttributeIssue[] = [];
  if (!Array.isArray(rawAttributes)) {
    if (rawAttributes !== undefined && rawAttributes !== null) issues.push('malformed_shape');
    return { attributes: [], issues };
  }

  // Preserve first-seen order; key by normalized trait_type for dup detection.
  const byTraitType = new Map<string, NormalizedAttribute>();

  for (const raw of rawAttributes) {
    if (raw === null || typeof raw !== 'object') { issues.push('malformed_shape'); continue; }
    const rec = raw as { trait_type?: unknown; value?: unknown };
    let traitType: string;
    if (typeof rec.trait_type === 'string') {
      traitType = rec.trait_type.trim();
    } else if (typeof rec.trait_type === 'number' || typeof rec.trait_type === 'boolean') {
      traitType = String(rec.trait_type);
      issues.push('non_string_trait_type_coerced');
    } else {
      issues.push('malformed_shape');
      continue;
    }
    if (traitType.length === 0) { issues.push('malformed_shape'); continue; }

    if (!isPlainScalar(rec.value) && rec.value !== null && rec.value !== undefined) {
      // object/array value — genuinely malformed, not a "null"/"empty" case.
      issues.push('malformed_shape');
      continue;
    }

    const { value, issue } = normalizeTraitValue(rec.value);
    if (issue) issues.push(issue);

    const existing = byTraitType.get(traitType);
    if (existing) {
      if (existing.value === value) {
        issues.push('duplicate_identical_pair');
      } else {
        issues.push('duplicate_conflicting_trait_type');
      }
      continue; // first occurrence wins either way
    }
    byTraitType.set(traitType, { trait_type: traitType, value });
  }

  return { attributes: [...byTraitType.values()], issues };
}

// ── Collection-wide rollup ───────────────────────────────────────────────

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Deterministic metadata signature — sorted (trait_type,value) pairs
 *  joined into one string. Two assets with identical attribute sets
 *  produce the identical signature regardless of source attribute order. */
export function metadataSignature(attributes: NormalizedAttribute[]): string {
  return attributes
    .map((a) => `${a.trait_type}=${a.value}`)
    .sort()
    .join('|');
}

function pushDuplicateGroups(byKey: Map<string, string[]>): DuplicateGroupSummary[] {
  const groups: DuplicateGroupSummary[] = [];
  for (const [key, mints] of byKey) {
    if (mints.length < 2) continue;
    groups.push({
      key,
      count: mints.length,
      mints: mints.slice(0, DUPLICATE_GROUP_MINT_SAMPLE_CAP),
      truncated: mints.length > DUPLICATE_GROUP_MINT_SAMPLE_CAP,
    });
  }
  groups.sort((a, b) => b.count - a.count);
  return groups;
}

export interface FullAnalysisInputs {
  assets: NormalizedAsset[];
  /** Per-asset attribute-normalization issue tallies, aligned to `assets`
   *  by index (produced alongside normalization during the scan). */
  perAssetIssues: AttributeIssue[][];
}

export interface FullAnalysisResult {
  quality: QualityDiagnostics;
  traitCategories: FullTraitCategorySummary[];
  duplicateMetadataGroups: DuplicateGroupSummary[];
  duplicateImageGroups: DuplicateGroupSummary[];
  traitsPerNftDistribution: TraitsPerNftBucket[];
  oneOfOneHighlights: OneOfOneHighlight[];
  oneOfOneHighlightsTruncated: boolean;
  warnings: string[];
}

export function buildFullAnalysis({ assets, perAssetIssues }: FullAnalysisInputs): FullAnalysisResult {
  const totalAssets = assets.length;

  const quality: QualityDiagnostics = {
    totalAssets,
    assetsWithValidMetadata: 0,
    assetsMissingAttributes: 0,
    assetsMissingImage: 0,
    assetsMissingName: 0,
    compressedCount: 0,
    regularCount: 0,
    malformedAttributesSkipped: 0,
    duplicateIdenticalAttributePairsCollapsed: 0,
    conflictingDuplicateTraitTypeAssets: 0,
    nullValueAttributes: 0,
    emptyStringValueAttributes: 0,
    nonStringTraitTypeCoerced: 0,
  };

  const byTraitType = new Map<string, Map<string, number>>();
  const traitsPerNft = new Map<number, number>();
  const metaSigGroups = new Map<string, string[]>();
  const imageGroups = new Map<string, string[]>();
  const oneOfOneHighlights: OneOfOneHighlight[] = [];

  for (let i = 0; i < assets.length; i++) {
    const asset = assets[i];
    const issues = perAssetIssues[i] ?? [];

    if (asset.name && asset.image) quality.assetsWithValidMetadata++;
    if (asset.attributes.length === 0) quality.assetsMissingAttributes++;
    if (!asset.image) quality.assetsMissingImage++;
    if (!asset.name) quality.assetsMissingName++;
    if (asset.compressed) quality.compressedCount++; else quality.regularCount++;

    let hadConflict = false;
    for (const issue of issues) {
      switch (issue) {
        case 'malformed_shape':                    quality.malformedAttributesSkipped++; break;
        case 'non_string_trait_type_coerced':       quality.nonStringTraitTypeCoerced++; break;
        case 'null_value':                          quality.nullValueAttributes++; break;
        case 'empty_value':                         quality.emptyStringValueAttributes++; break;
        case 'duplicate_identical_pair':            quality.duplicateIdenticalAttributePairsCollapsed++; break;
        case 'duplicate_conflicting_trait_type':     hadConflict = true; break;
        default: break;
      }
    }
    if (hadConflict) quality.conflictingDuplicateTraitTypeAssets++;

    traitsPerNft.set(asset.attributes.length, (traitsPerNft.get(asset.attributes.length) ?? 0) + 1);

    for (const attr of asset.attributes) {
      let values = byTraitType.get(attr.trait_type);
      if (!values) { values = new Map(); byTraitType.set(attr.trait_type, values); }
      values.set(attr.value, (values.get(attr.value) ?? 0) + 1);
    }

    if (asset.attributes.length > 0) {
      const sig = metadataSignature(asset.attributes);
      const arr = metaSigGroups.get(sig) ?? [];
      arr.push(asset.mint);
      metaSigGroups.set(sig, arr);
    }
    if (asset.image) {
      const arr = imageGroups.get(asset.image) ?? [];
      arr.push(asset.mint);
      imageGroups.set(asset.image, arr);
    }
  }

  const traitCategories: FullTraitCategorySummary[] = [...byTraitType.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([traitType, values]) => {
      const missingCount = totalAssets - [...values.values()].reduce((s, c) => s + c, 0);
      const valueStats = [...values.entries()]
        .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
        .map(([value, count]) => ({
          value,
          count,
          percent: totalAssets > 0 ? round2((count / totalAssets) * 100) : 0,
          oneOfOne: count === 1,
        }));
      return {
        traitType,
        values: valueStats,
        missingCount,
        missingPercent: totalAssets > 0 ? round2((missingCount / totalAssets) * 100) : 0,
      };
    });

  // one-of-one highlights — bounded convenience list built from the same
  // category pass (full counts already captured above regardless of cap).
  outer:
  for (const cat of traitCategories) {
    for (const v of cat.values) {
      if (!v.oneOfOne) continue;
      if (oneOfOneHighlights.length >= ONE_OF_ONE_HIGHLIGHT_CAP) break outer;
      // Find the one mint carrying this exact (traitType,value) pair.
      const owner = assets.find((a) => a.attributes.some((at) => at.trait_type === cat.traitType && at.value === v.value));
      if (owner) oneOfOneHighlights.push({ traitType: cat.traitType, value: v.value, mint: owner.mint });
    }
  }
  const oneOfOneTotalCount = traitCategories.reduce((s, c) => s + c.values.filter((v) => v.oneOfOne).length, 0);

  const traitsPerNftDistribution: TraitsPerNftBucket[] = [...traitsPerNft.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([traitsCount, nftCount]) => ({ traitsCount, nftCount }));

  const duplicateMetadataGroups = pushDuplicateGroups(metaSigGroups);
  const duplicateImageGroups = pushDuplicateGroups(imageGroups);

  const warnings: string[] = [];
  if (quality.malformedAttributesSkipped > 0) {
    warnings.push(`${quality.malformedAttributesSkipped} attribute(s) had a malformed shape (non-object entry, non-string/object trait_type, or object/array value) and were excluded from trait stats.`);
  }
  if (quality.nonStringTraitTypeCoerced > 0) {
    warnings.push(`${quality.nonStringTraitTypeCoerced} attribute(s) had a non-string trait_type (number/boolean) — coerced to a string.`);
  }
  if (quality.conflictingDuplicateTraitTypeAssets > 0) {
    warnings.push(`${quality.conflictingDuplicateTraitTypeAssets} asset(s) had the same trait_type repeated with DIFFERING values — first occurrence kept.`);
  }
  if (quality.duplicateIdenticalAttributePairsCollapsed > 0) {
    warnings.push(`${quality.duplicateIdenticalAttributePairsCollapsed} duplicate identical attribute pair(s) collapsed within a single asset.`);
  }
  if (quality.nullValueAttributes > 0) {
    warnings.push(`${quality.nullValueAttributes} attribute(s) had a null/undefined value — normalized to "(null)".`);
  }
  if (quality.emptyStringValueAttributes > 0) {
    warnings.push(`${quality.emptyStringValueAttributes} attribute(s) had a blank/whitespace-only value — normalized to "(empty)".`);
  }
  if (oneOfOneTotalCount > oneOfOneHighlights.length) {
    warnings.push(`${oneOfOneTotalCount} one-of-one trait value(s) found; showing the first ${oneOfOneHighlights.length} as highlights — full counts are in traitCategories.`);
  }

  return {
    quality,
    traitCategories,
    duplicateMetadataGroups,
    duplicateImageGroups,
    traitsPerNftDistribution,
    oneOfOneHighlights,
    oneOfOneHighlightsTruncated: oneOfOneTotalCount > oneOfOneHighlights.length,
    warnings,
  };
}
