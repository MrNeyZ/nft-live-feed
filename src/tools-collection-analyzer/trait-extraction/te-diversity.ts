/**
 * Trait Extraction (Stage 5.1) - diversity-aware source-asset selection.
 *
 * Replaces the old "first N by lexical mint order" source sampling
 * (pre-5.1 te-comparison.ts), which the Retardio Cousins Eyebrows pilot
 * showed picks a lexically-clustered, low-diversity sample - contaminating
 * every downstream comparison pair with whatever OTHER categories those
 * few lexically-first assets happen to share (Shirt/Background/etc).
 *
 * Algorithm (spec section 1):
 *   1. Build each target-bearing asset's non-target signature (already
 *      indexed by te-index.ts's excludedSignatureIndexFor).
 *   2. Group by signature; take ONE representative per unique signature
 *      first (deterministic: sig-sorted, then lexical mint within a sig).
 *   3. Fill remaining preset capacity greedily by maximizing NEW
 *      (category, value) pairs introduced across every non-target
 *      category - a source that shares a rare Background+Shirt
 *      combination with an already-selected source contributes nothing
 *      new; one with a fresh combination does.
 *   4. Lexical mint order is the final tie-breaker at every step.
 *
 * No category name is ever hardcoded - diversity is derived purely from
 * whatever categories exist in the collection's own metadata.
 */
import type { NormalizedAsset } from '../types';
import type { CollectionIndex } from './te-index';
import { categoryValueKey, sortedAttrEntries } from './te-index';
import type { SourceSelectionDiagnostics } from './te-types';

export type { SourceSelectionDiagnostics };

export interface SourceSelectionResult {
  sources: NormalizedAsset[];
  diagnostics: SourceSelectionDiagnostics;
}

function emptyDiagnostics(): SourceSelectionDiagnostics {
  return { strategy: 'diversity_aware', candidatePoolSize: 0, uniqueNonTargetSignatures: 0, representativesSelected: 0, diversityFillSelected: 0, lexicalTiebreakSelected: 0 };
}

export function selectDiverseSourceAssets(
  targetTraitType: string,
  targetValue: string,
  index: CollectionIndex,
  maxSourceAssetsPerValue: number,
): SourceSelectionResult {
  const candidateMints = index.categoryValueToMints.get(categoryValueKey(targetTraitType, targetValue)) ?? [];
  const candidates = candidateMints.map((m) => index.assetsByMint.get(m)).filter((a): a is NormalizedAsset => !!a);
  if (candidates.length === 0) return { sources: [], diagnostics: emptyDiagnostics() };

  const excludedIdx = index.excludedSignatureIndexFor(targetTraitType);
  const bySig = new Map<string, NormalizedAsset[]>();
  for (const c of candidates) {
    const sig = excludedIdx.mintToSig.get(c.mint) ?? '';
    let arr = bySig.get(sig);
    if (!arr) { arr = []; bySig.set(sig, arr); }
    arr.push(c);
  }
  for (const arr of bySig.values()) arr.sort((a, b) => (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0));
  const sortedSigs = [...bySig.keys()].sort();

  const selected: NormalizedAsset[] = [];
  const selectedMints = new Set<string>();
  let representativesSelected = 0;

  for (const sig of sortedSigs) {
    if (selected.length >= maxSourceAssetsPerValue) break;
    const rep = bySig.get(sig)![0];
    selected.push(rep);
    selectedMints.add(rep.mint);
    representativesSelected++;
  }

  const seenPairs = new Set<string>();
  for (const s of selected) for (const e of sortedAttrEntries(s)) if (e.traitType !== targetTraitType) seenPairs.add(`${e.traitType}=${e.value}`);

  const remainingPool = candidates.filter((c) => !selectedMints.has(c.mint)).sort((a, b) => (a.mint < b.mint ? -1 : a.mint > b.mint ? 1 : 0));
  let diversityFillSelected = 0;
  let lexicalTiebreakSelected = 0;

  while (selected.length < maxSourceAssetsPerValue && remainingPool.length > 0) {
    let bestIdx = -1;
    let bestNewCount = -1;
    for (let i = 0; i < remainingPool.length; i++) {
      const entries = sortedAttrEntries(remainingPool[i]).filter((e) => e.traitType !== targetTraitType);
      let newCount = 0;
      for (const e of entries) if (!seenPairs.has(`${e.traitType}=${e.value}`)) newCount++;
      if (newCount > bestNewCount) { bestNewCount = newCount; bestIdx = i; }
    }
    if (bestIdx === -1) break;
    const chosen = remainingPool.splice(bestIdx, 1)[0];
    selected.push(chosen);
    selectedMints.add(chosen.mint);
    if (bestNewCount > 0) diversityFillSelected++; else lexicalTiebreakSelected++;
    for (const e of sortedAttrEntries(chosen)) if (e.traitType !== targetTraitType) seenPairs.add(`${e.traitType}=${e.value}`);
  }

  return {
    sources: selected,
    diagnostics: {
      strategy: 'diversity_aware',
      candidatePoolSize: candidates.length,
      uniqueNonTargetSignatures: bySig.size,
      representativesSelected,
      diversityFillSelected,
      lexicalTiebreakSelected,
    },
  };
}
