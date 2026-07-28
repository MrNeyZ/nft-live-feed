/**
 * Trait Extraction Core - job orchestration (Stage 5.3).
 *
 * Runtime-independent version of the website's original te-run.ts: same
 * per-value sequential loop, same algorithm calls (te-index/te-diversity/
 * te-impact/te-ranking/te-pixel-diff/te-confidence), same output
 * generation (te-png-output/te-contact-sheet/te-zip/te-readme/
 * te-generator-schema) - nothing about the ALGORITHM changed. What moved:
 * progress/cancellation/persistence are now constructor-injected instead
 * of mutating a server-specific job-registry record, so this function has
 * no Express/PM2/SSE/server-job-registry dependency and runs identically
 * from the website's thin adapter or the local CLI worker.
 *
 * Values are processed SEQUENTIALLY (one "current category/value" at a
 * time, matching the progress model) - within a value, its pairs' unique
 * images download with bounded concurrency.
 */
import * as path from 'path';
import { buildTraitCollectionEligibility } from './te-eligibility';
import { buildCollectionIndex } from './te-index';
import type { CollectionIndex } from './te-index';
import { CategoryImpactModel } from './te-impact';
import { expandComparisonSearch, computePairEvidenceWeight } from './te-ranking';
import { computeDiffMask, cleanPairMask, estimateTargetCandidate, type CleanedPair } from './te-pixel-diff';
import { computeConfidence } from './te-confidence';
import { buildCandidatePng, buildMaskOverlayPng, buildPreviewPng } from './te-png-output';
import { buildContactSheet, type ContactSheetCell } from './te-contact-sheet';
import { buildTraitZip, type TraitZipValueFiles } from './te-zip';
import { buildTraitReadmeText } from './te-readme';
import { buildGeneratorSchema } from './te-generator-schema';
import { traitValueDirKey } from './te-filenames';
import { deriveCollectionDisplayName } from './te-display-name';
import {
  TE_MAX_CONCURRENT_DOWNLOADS, TE_MAX_SEARCH_MS_PER_JOB, TE_MAX_TOTAL_DOWNLOAD_BYTES,
  TE_MAX_UNIQUE_IMAGE_DOWNLOADS, TE_MIN_COMPONENT_SIZE, TE_PIXEL_DIFF_THRESHOLD, presetLimitsFor,
} from './te-limits';
import type { ImageAcquirer } from './image-acquirer';
import type { NormalizedAsset } from './asset-types';
import type {
  ConfidenceStatus, ExtractionPreset, ExtractionPresetLimits, TraitExtractionConfig, TraitExtractionErrorInfo,
  TraitExtractionJobStatus, TraitExtractionProgressSnapshot, TraitValueEvidence, UnresolvedValueEntry, ValueSearchDiagnostics,
} from './te-types';

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let idx = 0;
  const laneCount = Math.max(1, Math.min(limit, items.length));
  const lanes = Array.from({ length: laneCount }, async () => {
    while (idx < items.length) { await worker(items[idx++]); }
  });
  await Promise.all(lanes);
}

export interface ValueTarget { traitType: string; traitValue: string; occurrenceCount: number }

/** Resolves the config's selections (empty `values` = every value in that
 *  category) into the concrete (traitType, value) targets to process, in
 *  the same most-exact-evidence-first order te-run.ts always used. Split
 *  out so the CLI can compute the target list up front (e.g. to print a
 *  workload estimate or plan checkpoints) before actually running. */
export function resolveTargetsInOrder(assets: NormalizedAsset[], config: TraitExtractionConfig, index: CollectionIndex, impactModel: CategoryImpactModel, limits: ExtractionPresetLimits): ValueTarget[] {
  const valueOccurrence = new Map<string, number>();
  for (const asset of assets) for (const attr of asset.attributes) {
    valueOccurrence.set(`${attr.trait_type} ${attr.value}`, (valueOccurrence.get(`${attr.trait_type} ${attr.value}`) ?? 0) + 1);
  }
  const targets: ValueTarget[] = [];
  for (const sel of config.selections) {
    const valuesInCategory = [...new Set(assets.flatMap((a) => a.attributes.filter((x) => x.trait_type === sel.traitType).map((x) => x.value)))].sort();
    const chosen = sel.values && sel.values.length > 0 ? sel.values.filter((v) => valuesInCategory.includes(v)) : valuesInCategory;
    for (const v of chosen) targets.push({ traitType: sel.traitType, traitValue: v, occurrenceCount: valueOccurrence.get(`${sel.traitType} ${v}`) ?? 0 });
  }

  // Within each selected category, process values with the MOST exact
  // (Level 0) evidence FIRST. Level 0 pairs are never impact-weight-
  // rejected, so this ordering is safe to compute up front and is
  // independent of the impact model's evolving state - but processing
  // exact-evidence-rich values first means the category's OWN self
  // footprint (learned from those clean Level 0 pairs, te-impact.ts) is
  // already available by the time later, harder values in the SAME
  // category are reached, instead of every value bootstrapping cold.
  const categoryOrder: string[] = [...new Set(config.selections.map((s) => s.traitType))];
  const level0CountByTarget = new Map<string, number>();
  for (const t of targets) {
    const search = expandComparisonSearch({ targetTraitType: t.traitType, targetValue: t.traitValue, index, impactModel, limits, preset: config.preset });
    level0CountByTarget.set(`${t.traitType} ${t.traitValue}`, search.diagnostics.level0CandidatesFound);
  }
  targets.sort((a, b) => {
    const catDiff = categoryOrder.indexOf(a.traitType) - categoryOrder.indexOf(b.traitType);
    if (catDiff !== 0) return catDiff;
    const l0a = level0CountByTarget.get(`${a.traitType} ${a.traitValue}`) ?? 0;
    const l0b = level0CountByTarget.get(`${b.traitType} ${b.traitValue}`) ?? 0;
    if (l0a !== l0b) return l0b - l0a;
    return a.traitValue < b.traitValue ? -1 : a.traitValue > b.traitValue ? 1 : 0;
  });
  return targets;
}

export interface RunTraitExtractionInputs {
  jobId: string;
  scanId: string;
  assets: NormalizedAsset[];
  collectionAddress: string;
  exactScannedAssetCount: number;
  config: TraitExtractionConfig;
  /** Directory the ZIP and any scratch files are written into - already
   *  created by the caller. */
  workDir: string;
  signal: AbortSignal;
  imageAcquirer: ImageAcquirer;
  onProgress: (p: TraitExtractionProgressSnapshot) => void;
  /** Resumability hook (Stage 5.3 section 5): called once per settled
   *  value (resolved OR unresolved), BEFORE the next value starts. The
   *  website adapter omits this; the CLI uses it to write an atomic
   *  checkpoint after every value so a killed/restarted process resumes
   *  instead of restarting from zero. */
  onValueSettled?: (settled: { target: ValueTarget; result: ProcessValueResult }) => Promise<void> | void;
  /** Targets to skip entirely because a PRIOR run already produced a
   *  valid, complete output for them (resumability). Keyed
   *  `${traitType} ${traitValue}`. The website adapter always passes
   *  an empty set (Stage 3/4/5 jobs are never resumed). */
  skipTargets?: Set<string>;
  /** Pre-computed results for skipped targets, spliced back into the
   *  final evidence/unresolved lists in original order so the ZIP/summary
   *  look identical to a from-scratch run. Required whenever
   *  `skipTargets` is non-empty. */
  resumedResults?: Map<string, ProcessValueResult>;
}

export interface RunTraitExtractionResult {
  status: 'completed' | 'failed' | 'cancelled';
  error?: TraitExtractionErrorInfo;
  evidence: TraitValueEvidence[];
  unresolvedValues: UnresolvedValueEntry[];
  zipPath: string | null;
  collectionDisplayName: string;
  extractionSummary?: Record<string, unknown>;
}

export async function runTraitExtraction(inputs: RunTraitExtractionInputs): Promise<RunTraitExtractionResult> {
  const {
    jobId, scanId, assets, collectionAddress, exactScannedAssetCount, config, workDir, signal, imageAcquirer,
    onProgress, onValueSettled, skipTargets, resumedResults,
  } = inputs;
  const startedAt = Date.now();
  const collectionDisplayName = deriveCollectionDisplayName(collectionAddress, assets, null);
  const eligibility = buildTraitCollectionEligibility(assets);
  const limits = presetLimitsFor(config.preset);

  const collectionIndex: CollectionIndex = buildCollectionIndex(assets);
  const impactModel = new CategoryImpactModel();
  const targets = resolveTargetsInOrder(assets, config, collectionIndex, impactModel, limits);

  let progress: TraitExtractionProgressSnapshot = {
    jobId, scanId, status: 'downloading', phase: 'downloading',
    currentCategory: null, currentTraitValue: null,
    totalValues: targets.length, processedValues: 0,
    uniqueImagesDownloaded: 0, comparisonsEvaluated: 0,
    resolvedHigh: 0, resolvedMedium: 0, resolvedLow: 0, resolvedUnresolved: 0, resolvedVisuallyIdentical: 0,
    failedImageCount: 0, bytesDownloaded: 0, elapsedMs: 0,
  };
  const tick = (partial: Partial<TraitExtractionProgressSnapshot>) => {
    progress = { ...progress, ...partial, jobId, scanId };
    onProgress(progress);
  };
  tick({});

  const unresolvedValues: UnresolvedValueEntry[] = [];
  const evidence: TraitValueEvidence[] = [];
  const zipValues: TraitZipValueFiles[] = [];
  const cellsByCategory = new Map<string, ContactSheetCell[]>();
  let comparisonsEvaluated = 0;
  let cumulativeSearchTimeMs = 0;
  let searchTimeBudgetExceeded = false;

  const bumpStatusCounter = (status: ConfidenceStatus) => {
    if (status === 'high_confidence') progress.resolvedHigh++;
    else if (status === 'medium_confidence') progress.resolvedMedium++;
    else if (status === 'low_confidence') progress.resolvedLow++;
    else if (status === 'unresolved') progress.resolvedUnresolved++;
    else if (status === 'visually_identical') progress.resolvedVisuallyIdentical++;
  };

  const recordSettled = (target: ValueTarget, result: ProcessValueResult) => {
    if (result.kind === 'unresolved') {
      unresolvedValues.push({ traitType: target.traitType, traitValue: target.traitValue, reason: result.reason });
    } else {
      evidence.push(result.evidence);
      zipValues.push(result.zipFiles);
      const list = cellsByCategory.get(target.traitType) ?? [];
      list.push({ traitValue: target.traitValue, occurrenceCount: target.occurrenceCount, confidenceStatus: result.evidence.confidence.status, score: result.evidence.confidence.score, candidatePng: result.candidatePngForSheet, boundingBox: result.evidence.candidateBoundingBox });
      cellsByCategory.set(target.traitType, list);
      bumpStatusCounter(result.evidence.confidence.status);
    }
  };

  for (let i = 0; i < targets.length; i++) {
    if (signal.aborted) {
      return { status: 'cancelled', error: { code: 'cancelled', message: 'Trait extraction cancelled.' }, evidence, unresolvedValues, zipPath: null, collectionDisplayName };
    }
    if (imageAcquirer.bytesDownloaded > TE_MAX_TOTAL_DOWNLOAD_BYTES || imageAcquirer.uniqueImageCount > TE_MAX_UNIQUE_IMAGE_DOWNLOADS) {
      return {
        status: evidence.length > 0 ? 'completed' : 'failed',
        error: { code: 'total_size_exceeded', message: 'Trait extraction exceeded its configured download budget.' },
        evidence, unresolvedValues, zipPath: null, collectionDisplayName,
      };
    }

    const target = targets[i];
    const key = `${target.traitType} ${target.traitValue}`;

    if (skipTargets?.has(key)) {
      const resumed = resumedResults?.get(key);
      if (resumed) {
        recordSettled(target, resumed);
        comparisonsEvaluated += resumed.pairsAttempted;
      }
      tick({ processedValues: i + 1 });
      continue;
    }

    tick({ status: 'processing', phase: 'processing', currentCategory: target.traitType, currentTraitValue: target.traitValue });

    if (searchTimeBudgetExceeded) {
      const result: ProcessValueResult = { kind: 'unresolved', reason: 'search_time_budget_exceeded_for_job', pairsAttempted: 0 };
      recordSettled(target, result);
      if (onValueSettled) await onValueSettled({ target, result });
      tick({ processedValues: i + 1, warning: 'Comparison-search time budget for this job was reached; remaining values were skipped.' });
      continue;
    }

    const result = await processOneValue(target, limits, config.preset, collectionIndex, impactModel, imageAcquirer, signal);
    comparisonsEvaluated += result.pairsAttempted;
    if (result.searchDiagnostics) {
      cumulativeSearchTimeMs += result.searchDiagnostics.searchTimeMs;
      if (cumulativeSearchTimeMs > TE_MAX_SEARCH_MS_PER_JOB) searchTimeBudgetExceeded = true;
    }

    recordSettled(target, result);
    if (onValueSettled) await onValueSettled({ target, result });

    tick({
      processedValues: i + 1,
      uniqueImagesDownloaded: imageAcquirer.uniqueImageCount,
      comparisonsEvaluated,
      bytesDownloaded: imageAcquirer.bytesDownloaded,
      elapsedMs: Date.now() - startedAt,
    });
  }

  if (evidence.length === 0) {
    return { status: 'failed', error: { code: 'archive_creation_failed', message: 'No trait value could be extracted from the selected categories.' }, evidence, unresolvedValues, zipPath: null, collectionDisplayName };
  }

  tick({ status: 'archiving', phase: 'archiving' });

  const contactSheets: Array<{ category: string; png: Buffer }> = [];
  for (const [category, cells] of [...cellsByCategory.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const sorted = [...cells].sort((a, b) => a.traitValue.localeCompare(b.traitValue));
    contactSheets.push({ category, png: await buildContactSheet(sorted) });
  }

  const generatedAt = new Date().toISOString();
  const readmeText = buildTraitReadmeText({
    collectionAddress, scanId, preset: config.preset, generatedAt, evidence, unresolvedCount: unresolvedValues.length,
  });
  const generatorSchema = buildGeneratorSchema({
    collectionAddress, exactScannedAssetCount, assets,
    selectedCategories: [...new Set(config.selections.map((s) => s.traitType))],
    evidence, unresolvedValues, generatedAt,
  });
  const extractionSummary = {
    jobId, scanId, collectionAddress, preset: config.preset, generatedAt,
    totalValuesRequested: targets.length, totalValuesExtracted: evidence.length, totalValuesUnresolved: unresolvedValues.length,
    uniqueImagesDownloaded: imageAcquirer.uniqueImageCount, bytesDownloaded: imageAcquirer.bytesDownloaded,
    byStatus: statusCounts(evidence),
    searchDiagnostics: aggregateSearchDiagnostics(assets.length, evidence, cumulativeSearchTimeMs, collectionIndex.buildTimeMs),
  };

  const zipPath = path.join(workDir, 'trait-collection.zip');
  try {
    await buildTraitZip({
      readmeText,
      eligibilityJson: JSON.stringify(eligibility, null, 2),
      extractionSummaryJson: JSON.stringify(extractionSummary, null, 2),
      unresolvedTraitsJson: JSON.stringify(unresolvedValues, null, 2),
      generatorSchemaJson: JSON.stringify(generatorSchema, null, 2),
      values: zipValues,
      contactSheets,
    }, zipPath, signal);
    tick({ elapsedMs: Date.now() - startedAt });
    return { status: 'completed', evidence, unresolvedValues, zipPath, collectionDisplayName, extractionSummary };
  } catch {
    if (signal.aborted) return { status: 'cancelled', error: { code: 'cancelled', message: 'Trait extraction cancelled.' }, evidence, unresolvedValues, zipPath: null, collectionDisplayName };
    return { status: 'failed', error: { code: 'archive_creation_failed', message: 'Failed to create the trait-collection archive.' }, evidence, unresolvedValues, zipPath: null, collectionDisplayName };
  }
}

function statusCounts(evidence: TraitValueEvidence[]): Record<ConfidenceStatus, number> {
  const out: Record<ConfidenceStatus, number> = { high_confidence: 0, medium_confidence: 0, low_confidence: 0, unresolved: 0, visually_identical: 0 };
  for (const e of evidence) out[e.confidence.status]++;
  return out;
}

function aggregateSearchDiagnostics(totalAssets: number, evidence: TraitValueEvidence[], cumulativeSearchTimeMs: number, indexBuildTimeMs: number) {
  const stopReasonCounts: Record<string, number> = {};
  let level0 = 0, level1 = 0, level2 = 0, rejectedHighImpact = 0, lowQuality = 0;
  for (const e of evidence) {
    const d = e.searchDiagnostics;
    level0 += d.level0CandidatesFound;
    level1 += d.level1CandidatesFound;
    level2 += d.level2CandidatesFound;
    rejectedHighImpact += d.candidatesRejectedHighImpact;
    lowQuality += d.lowQualityPairsCount;
    stopReasonCounts[d.adaptiveStopReason] = (stopReasonCounts[d.adaptiveStopReason] ?? 0) + 1;
  }
  return {
    totalAssetsSearched: totalAssets,
    indexBuildTimeMs,
    cumulativeSearchTimeMs,
    level0CandidatesFoundTotal: level0,
    level1CandidatesFoundTotal: level1,
    level2CandidatesFoundTotal: level2,
    candidatesRejectedHighImpactTotal: rejectedHighImpact,
    lowQualityPairsTotal: lowQuality,
    adaptiveStopReasonCounts: stopReasonCounts,
  };
}

export type ProcessValueResult =
  | { kind: 'unresolved'; reason: string; pairsAttempted: number; searchDiagnostics?: ValueSearchDiagnostics }
  | { kind: 'resolved'; evidence: TraitValueEvidence; zipFiles: TraitZipValueFiles; candidatePngForSheet: Buffer | null; pairsAttempted: number; searchDiagnostics: ValueSearchDiagnostics };

async function processOneValue(
  target: ValueTarget,
  limits: ExtractionPresetLimits,
  preset: ExtractionPreset,
  index: CollectionIndex,
  impactModel: CategoryImpactModel,
  imageAcquirer: ImageAcquirer,
  signal: AbortSignal,
): Promise<ProcessValueResult> {
  const searchResult = expandComparisonSearch({ targetTraitType: target.traitType, targetValue: target.traitValue, index, impactModel, limits, preset });
  const candidates = searchResult.candidates;
  const searchDiagnostics = searchResult.diagnostics;
  if (candidates.length === 0) return { kind: 'unresolved', reason: 'no_valid_comparison_pair_within_preset_level', pairsAttempted: 0, searchDiagnostics };

  const urls = [...new Set(candidates.flatMap((c) => [c.sourceImage, c.comparisonImage]))];
  await runWithConcurrency(urls, TE_MAX_CONCURRENT_DOWNLOADS, async (url) => { await imageAcquirer.get(url); });

  const cleanedPairs: CleanedPair[] = [];
  const usedCandidates: typeof candidates = [];
  let canvasAttempted = 0;
  let canvasMatched = 0;
  const seenSourceMints = new Set<string>();
  const seenComparisonValues = new Set<string>();

  for (const c of candidates) {
    if (signal.aborted) break;
    canvasAttempted++;
    const [srcOutcome, cmpOutcome] = await Promise.all([imageAcquirer.get(c.sourceImage), imageAcquirer.get(c.comparisonImage)]);
    if (!srcOutcome.ok || !cmpOutcome.ok) continue;
    const rawMask = computeDiffMask(srcOutcome.image, cmpOutcome.image, TE_PIXEL_DIFF_THRESHOLD);
    if (!rawMask) continue; // dimension mismatch - hard filter, spec section 7.4
    canvasMatched++;
    const cleaned = cleanPairMask(rawMask, srcOutcome.image.width, srcOutcome.image.height, TE_MIN_COMPONENT_SIZE);

    // A Level 0 pair's ENTIRE footprint is attributable to the target
    // category by construction (nothing else differs) - direct ground
    // truth for this job's category impact model (spec section 5).
    if (c.level === 0 && cleaned.length > 0) {
      let onePixels = 0;
      for (let i = 0; i < cleaned.length; i++) if (cleaned[i]) onePixels++;
      impactModel.recordObservation(target.traitType, (onePixels / cleaned.length) * 100);
    }

    const isNewSourceMint = !seenSourceMints.has(c.sourceMint);
    const isNewComparisonValue = !seenComparisonValues.has(c.comparisonValue ?? ' null');
    seenSourceMints.add(c.sourceMint);
    seenComparisonValues.add(c.comparisonValue ?? ' null');
    const evidenceWeight = computePairEvidenceWeight(c, isNewSourceMint, isNewComparisonValue).weight;

    cleanedPairs.push({ sourceMint: c.sourceMint, comparisonMint: c.comparisonMint, comparisonValue: c.comparisonValue, sourceImage: srcOutcome.image, diffMask: cleaned, evidenceWeight });
    usedCandidates.push(c);
  }

  if (cleanedPairs.length === 0) return { kind: 'unresolved', reason: 'no_usable_pairs_after_download_or_dimension_check', pairsAttempted: canvasAttempted, searchDiagnostics };

  const consensus = estimateTargetCandidate(cleanedPairs, limits.consensusAgreementThreshold);
  const distinctSourceMints = new Set(cleanedPairs.map((p) => p.sourceMint));
  const distinctComparisonValues = new Set(cleanedPairs.map((p) => p.comparisonValue ?? ' null'));
  const level0Count = usedCandidates.filter((c) => c.level === 0).length;
  const meanLevel = usedCandidates.reduce((s, c) => s + c.level, 0) / usedCandidates.length;

  const selfImpact = impactModel.estimate(target.traitType, index);
  const selfCategoryMedianFootprintPercent = selfImpact.sampleCount >= 2 ? selfImpact.medianChangedAreaPercent : null;

  const confidence = computeConfidence({
    level0PairCount: level0Count,
    totalPairCount: cleanedPairs.length,
    distinctSourceAssetCount: distinctSourceMints.size,
    distinctComparisonValueCount: distinctComparisonValues.size,
    meanComparisonLevel: meanLevel,
    consensusAgreementMean: consensus.consensusAgreementMean,
    sourcePixelConsistencyMean: consensus.sourcePixelConsistencyMean,
    canvasMatchedPairCount: canvasMatched,
    canvasAttemptedPairCount: canvasAttempted,
    changedPixelPercent: consensus.changedPixelPercent,
    uncertaintyPixelPercent: consensus.uncertaintyPixelPercent,
    candidatePixelCount: consensus.candidatePixelCount,
    candidatePixelPercent: consensus.width * consensus.height > 0 ? Math.round((consensus.candidatePixelCount / (consensus.width * consensus.height)) * 10000) / 100 : 0,
    expandedCandidatePixelCount: consensus.expandedCandidatePixelCount,
    changedPixelCount: consensus.changedPixelCount,
    selfCategoryMedianFootprintPercent,
  });

  const outputDirKey = traitValueDirKey(target.traitType, target.traitValue);
  const candidatePng = consensus.candidatePixelCount > 0 ? await buildCandidatePng(consensus, consensus.candidateMask) : null;
  const hasExtraExpanded = consensus.expandedCandidatePixelCount > consensus.candidatePixelCount;
  const candidateExpandedPng = hasExtraExpanded ? await buildCandidatePng(consensus, consensus.expandedMask) : null;
  const changeMaskPng = consensus.changedPixelCount > 0 ? await buildMaskOverlayPng(consensus.changeMask, consensus.width, consensus.height, [232, 161, 74]) : null;
  const uncertaintyMaskPng = consensus.uncertaintyPixelCount > 0 ? await buildMaskOverlayPng(consensus.uncertaintyMask, consensus.width, consensus.height, [217, 104, 103]) : null;
  const previewSource = candidatePng ?? candidateExpandedPng;
  const preview = previewSource ? await buildPreviewPng(previewSource, consensus.candidateBoundingBox, consensus.width, consensus.height) : null;

  const warnings: string[] = [];
  if (canvasMatched < canvasAttempted) warnings.push(`${canvasAttempted - canvasMatched} comparison pair(s) rejected for mismatched canvas dimensions.`);
  if (!candidatePng) warnings.push('No pixels passed the conservative candidate threshold - see candidate-expanded.png / change-mask.png if present.');

  const ev: TraitValueEvidence = {
    traitType: target.traitType, traitValue: target.traitValue, occurrenceCount: target.occurrenceCount,
    sourceMints: [...distinctSourceMints].sort(),
    comparisonMints: [...new Set(cleanedPairs.map((p) => p.comparisonMint))].sort(),
    comparisonLevels: usedCandidates.map((c) => c.level),
    matchingCategoriesSample: usedCandidates[0]?.differingCategories ? [] : [],
    differingCategoriesSample: usedCandidates.slice(0, 5).flatMap((c) => c.differingCategories),
    canvasWidth: consensus.width, canvasHeight: consensus.height,
    pairCount: cleanedPairs.length,
    sourceAssetCount: distinctSourceMints.size,
    comparisonValueCount: distinctComparisonValues.size,
    changedPixelCount: consensus.changedPixelCount,
    changedPixelPercent: consensus.changedPixelPercent,
    candidatePixelCount: consensus.candidatePixelCount,
    expandedCandidatePixelCount: consensus.expandedCandidatePixelCount,
    uncertaintyPixelCount: consensus.uncertaintyPixelCount,
    uncertaintyPixelPercent: consensus.uncertaintyPixelPercent,
    candidateBoundingBox: consensus.candidateBoundingBox,
    consensusAgreementMean: consensus.consensusAgreementMean,
    sourcePixelConsistencyMean: consensus.sourcePixelConsistencyMean,
    confidence,
    warnings,
    outputFiles: {
      candidate: candidatePng ? 'candidate.png' : null,
      candidateExpanded: candidateExpandedPng ? 'candidate-expanded.png' : null,
      changeMask: changeMaskPng ? 'change-mask.png' : null,
      uncertaintyMask: uncertaintyMaskPng ? 'uncertainty-mask.png' : null,
      preview: preview ? 'preview.png' : null,
      evidence: 'evidence.json',
    },
    outputDirKey,
    searchDiagnostics,
  };

  return {
    kind: 'resolved',
    evidence: ev,
    searchDiagnostics,
    zipFiles: {
      traitType: target.traitType, outputDirKey,
      candidate: candidatePng, candidateExpanded: candidateExpandedPng, changeMask: changeMaskPng, uncertaintyMask: uncertaintyMaskPng,
      preview: preview?.buffer ?? null,
      evidenceJson: JSON.stringify({ ...ev, preview: preview ? { offsetX: preview.offsetX, offsetY: preview.offsetY, width: preview.width, height: preview.height } : null }, null, 2),
    },
    candidatePngForSheet: candidatePng ?? candidateExpandedPng,
    pairsAttempted: canvasAttempted,
  };
}
