/**
 * Trait Extraction - README.txt generator. Pure, deterministic.
 */
import type { ExtractionPreset, TraitValueEvidence } from './te-types';

export interface TraitReadmeInputs {
  collectionAddress: string;
  scanId: string;
  preset: ExtractionPreset;
  generatedAt: string;
  evidence: TraitValueEvidence[];
  unresolvedCount: number;
}

export function buildTraitReadmeText(inputs: TraitReadmeInputs): string {
  const byStatus = { high_confidence: 0, medium_confidence: 0, low_confidence: 0, unresolved: 0, visually_identical: 0 };
  for (const e of inputs.evidence) byStatus[e.confidence.status]++;

  return [
    'VictoryLabs Collection Analyzer - Download Trait Collection',
    '=============================================================',
    '',
    'IMPORTANT: these are RECONSTRUCTED CANDIDATES, not the original source',
    'layers. They are inferred by comparing many final rendered NFT images',
    'against each other and estimating which pixels are consistently',
    'associated with each trait value. They may not exactly match the',
    "project's original source layers - overlapping artwork, shadows,",
    'outlines, and occlusion from other traits can all affect accuracy.',
    'Never redistribute these as "original layers."',
    '',
    `Collection address:  ${inputs.collectionAddress}`,
    `Scan ID:              ${inputs.scanId}`,
    `Extraction preset:    ${inputs.preset}`,
    `Generated:             ${inputs.generatedAt}`,
    '',
    'How candidates were inferred:',
    '  For each selected trait value, the system finds NFTs carrying that',
    '  value ("source" images) and pairs each one with the closest-matching',
    '  NFT that does NOT carry it ("comparison" images - ideally identical',
    '  in every other trait). It computes a per-pixel difference for every',
    '  pair, then looks for pixels that (a) differ consistently across many',
    '  pairs AND (b) have a STABLE color across every source image. Only',
    '  pixels satisfying both conditions become the conservative candidate -',
    '  a single raw image diff is never used directly, because it would',
    '  contain both the introduced trait pixels AND the replaced/removed',
    '  alternative pixels.',
    '',
    'Meaning of each file per trait value:',
    '  candidate.png           Conservative, higher-confidence visible pixels.',
    '  candidate-expanded.png  A less conservative candidate (only present',
    '                          when evidence supports extra pixels beyond the',
    '                          conservative set).',
    '  change-mask.png         ALL regions affected by changing this trait -',
    '                          diagnostic, may include replaced/alternative',
    '                          artwork. Not a reusable asset by itself.',
    '  uncertainty-mask.png    Pixels where evidence was unstable or',
    '                          contradictory across comparison pairs.',
    '  preview.png             A cropped, checkerboard-backed preview of the',
    '                          candidate for quick visual review.',
    '  evidence.json            Full measurable evidence behind the result.',
    '',
    'Confidence statuses:',
    '  high_confidence     Strong, consistent evidence across many pairs.',
    '  medium_confidence   Reasonable evidence with some uncertainty.',
    '  low_confidence      Weak or limited evidence - review before use.',
    '  unresolved          Not enough usable evidence to isolate the trait.',
    '  visually_identical  Metadata claims a difference the images do not',
    '                      actually show.',
    '',
    `Extraction results: ${byStatus.high_confidence} high, ${byStatus.medium_confidence} medium, ` +
    `${byStatus.low_confidence} low, ${byStatus.unresolved} unresolved, ${byStatus.visually_identical} visually identical ` +
    `(${inputs.unresolvedCount} value(s) skipped entirely - see unresolved-traits.json).`,
    '',
    'Known limitations:',
    '  - Traits that are frequently OCCLUDED by other traits (e.g. a hat',
    '    trait hidden behind long hair on most samples) can only be',
    '    reconstructed from the samples where they ARE visible - missing',
    '    pixels behind an occluding layer are never fabricated.',
    '  - Traits BAKED into a single flattened piece of artwork with no',
    '    clean edge against the rest of the image may extract with visible',
    '    contamination from neighboring pixels.',
    '  - This tool never uses AI image generation, inpainting, segmentation',
    '    models, or any external vision API - every pixel decision is plain',
    '    deterministic arithmetic over the actual downloaded images.',
    '',
  ].join('\n');
}
