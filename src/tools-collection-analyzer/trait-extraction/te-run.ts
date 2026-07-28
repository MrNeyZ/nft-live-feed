/**
 * Trait Extraction - job orchestration. Ties together candidate selection
 * (te-comparison.ts), image acquisition (te-image-io.ts), the pixel/
 * consensus algorithm (te-pixel-diff.ts), confidence scoring
 * (te-confidence.ts), and output generation (te-png-output.ts,
 * te-contact-sheet.ts, te-zip.ts, te-readme.ts, te-generator-schema.ts).
 *
 * Values are processed SEQUENTIALLY (one "current category/value" at a
 * time, matching the progress model) - within a value, its pairs' unique
 * images download with bounded concurrency.
 */
import * as fs from 'fs';
import * as path from 'path';
import { buildTraitCollectionEligibility } from './te-eligibility';
import { selectComparisonCandidates } from './te-comparison';
import { ImageDecodeCache } from './te-image-io';
import { computeDiffMask, cleanPairMask, estimateTargetCandidate, type CleanedPair } from './te-pixel-diff';
import { computeConfidence } from './te-confidence';
import { buildCandidatePng, buildMaskOverlayPng, buildPreviewPng } from './te-png-output';
import { buildContactSheet, type ContactSheetCell } from './te-contact-sheet';
import { buildTraitZip, type TraitZipValueFiles } from './te-zip';
import { buildTraitReadmeText } from './te-readme';
import { buildGeneratorSchema } from './te-generator-schema';
import { traitValueDirKey } from './te-filenames';
import { deriveCollectionDisplayName } from '../bundle/bundle-display-name';
import {
  TE_JOB_TIMEOUT_MS, TE_MAX_CONCURRENT_DOWNLOADS, TE_MAX_TOTAL_DOWNLOAD_BYTES,
  TE_MAX_UNIQUE_IMAGE_DOWNLOADS, TE_MIN_COMPONENT_SIZE, TE_PIXEL_DIFF_THRESHOLD, presetLimitsFor,
} from './te-limits';
import { finalizeTraitExtractionJob, updateTraitExtractionProgress } from './te-state-store';
import type { AddressValidator } from '../bundle/ssrf-guard';
import type { NormalizedAsset } from '../types';
import type { ScanResultSummary } from '../scan-types';
import type {
  ConfidenceStatus, TraitExtractionErrorInfo, TraitExtractionJobRecord, TraitExtractionProgressSnapshot, TraitValueEvidence,
} from './te-types';

async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let idx = 0;
  const laneCount = Math.max(1, Math.min(limit, items.length));
  const lanes = Array.from({ length: laneCount }, async () => {
    while (idx < items.length) { await worker(items[idx++]); }
  });
  await Promise.all(lanes);
}

export interface TraitExtractionRunInputs {
  record: TraitExtractionJobRecord;
  assets: NormalizedAsset[];
  summary: ScanResultSummary;
  onProgress: (p: TraitExtractionProgressSnapshot) => void;
  isDestinationAllowedOverride?: AddressValidator;
}

interface ValueTarget { traitType: string; traitValue: string; occurrenceCount: number }

export async function executeTraitExtractionJob({ record, assets, summary, onProgress, isDestinationAllowedOverride }: TraitExtractionRunInputs): Promise<void> {
  const externalSignal = record.abortController.signal;
  const startedAt = record.createdAt;
  const jobTimeoutController = new AbortController();
  const jobTimeoutTimer = setTimeout(() => jobTimeoutController.abort(), TE_JOB_TIMEOUT_MS);
  const combinedSignal = AbortSignal.any([externalSignal, jobTimeoutController.signal]);

  const finishTerminal = (status: 'cancelled' | 'failed' | 'completed', extra: { zipPath?: string; error?: TraitExtractionErrorInfo; evidence?: TraitValueEvidence[] } = {}) => {
    finalizeTraitExtractionJob(record, status, extra);
    onProgress(record.progress);
  };

  try {
    await runBody();
  } catch (err) {
    console.error('[trait-extraction] job crashed', (err as Error)?.message ?? err);
    const cancelled = combinedSignal.aborted && !jobTimeoutController.signal.aborted;
    finishTerminal(cancelled ? 'cancelled' : 'failed', {
      error: { code: jobTimeoutController.signal.aborted ? 'job_timeout' : cancelled ? 'cancelled' : 'archive_creation_failed', message: 'Unexpected internal error during trait extraction.' },
    });
  } finally {
    clearTimeout(jobTimeoutTimer);
  }

  async function runBody(): Promise<void> {
    await fs.promises.mkdir(record.workDir, { recursive: true });
    record.collectionDisplayName = deriveCollectionDisplayName(summary.collectionAddress, assets, null);
    const eligibility = buildTraitCollectionEligibility(assets);
    const limits = presetLimitsFor(record.config.preset);

    // Resolve the concrete (traitType, value) targets from the config's
    // selections (empty `values` = every value in that category).
    const valueOccurrence = new Map<string, number>();
    for (const asset of assets) for (const attr of asset.attributes) {
      valueOccurrence.set(`${attr.trait_type} ${attr.value}`, (valueOccurrence.get(`${attr.trait_type} ${attr.value}`) ?? 0) + 1);
    }
    const targets: ValueTarget[] = [];
    for (const sel of record.config.selections) {
      const valuesInCategory = [...new Set(assets.flatMap((a) => a.attributes.filter((x) => x.trait_type === sel.traitType).map((x) => x.value)))].sort();
      const chosen = sel.values && sel.values.length > 0 ? sel.values.filter((v) => valuesInCategory.includes(v)) : valuesInCategory;
      for (const v of chosen) targets.push({ traitType: sel.traitType, traitValue: v, occurrenceCount: valueOccurrence.get(`${sel.traitType} ${v}`) ?? 0 });
    }

    updateTraitExtractionProgress(record, { status: 'downloading', phase: 'downloading', totalValues: targets.length });
    record.status = 'downloading';
    onProgress(record.progress);

    const imageCache = new ImageDecodeCache(record.workDir, combinedSignal, isDestinationAllowedOverride);
    const evidence: TraitValueEvidence[] = [];
    const zipValues: TraitZipValueFiles[] = [];
    const cellsByCategory = new Map<string, ContactSheetCell[]>();
    let comparisonsEvaluated = 0;

    for (let i = 0; i < targets.length; i++) {
      if (combinedSignal.aborted) {
        finishTerminal(jobTimeoutController.signal.aborted ? 'failed' : 'cancelled', {
          error: jobTimeoutController.signal.aborted
            ? { code: 'job_timeout', message: 'Trait extraction exceeded the time budget.' }
            : { code: 'cancelled', message: 'Trait extraction cancelled.' },
        });
        return;
      }
      if (imageCache.bytesDownloaded > TE_MAX_TOTAL_DOWNLOAD_BYTES || imageCache.uniqueImageCount > TE_MAX_UNIQUE_IMAGE_DOWNLOADS) {
        finishTerminal(evidence.length > 0 ? 'completed' : 'failed', {
          error: { code: 'total_size_exceeded', message: 'Trait extraction exceeded its configured download budget.' },
        });
        return;
      }

      const target = targets[i];
      record.status = 'processing';
      updateTraitExtractionProgress(record, { status: 'processing', phase: 'processing', currentCategory: target.traitType, currentTraitValue: target.traitValue });
      onProgress(record.progress);

      const result = await processOneValue(target, assets, limits, imageCache, combinedSignal);
      comparisonsEvaluated += result.pairsAttempted;

      if (result.kind === 'unresolved') {
        record.unresolvedValues.push({ traitType: target.traitType, traitValue: target.traitValue, reason: result.reason });
      } else {
        evidence.push(result.evidence);
        zipValues.push(result.zipFiles);
        const list = cellsByCategory.get(target.traitType) ?? [];
        list.push({ traitValue: target.traitValue, occurrenceCount: target.occurrenceCount, confidenceStatus: result.evidence.confidence.status, score: result.evidence.confidence.score, candidatePng: result.candidatePngForSheet, boundingBox: result.evidence.candidateBoundingBox });
        cellsByCategory.set(target.traitType, list);
        bumpStatusCounter(record.progress, result.evidence.confidence.status);
      }

      updateTraitExtractionProgress(record, {
        processedValues: i + 1,
        uniqueImagesDownloaded: imageCache.uniqueImageCount,
        comparisonsEvaluated,
        bytesDownloaded: imageCache.bytesDownloaded,
        elapsedMs: Date.now() - startedAt,
      });
      onProgress(record.progress);
    }

    if (evidence.length === 0) {
      finishTerminal('failed', { error: { code: 'archive_creation_failed', message: 'No trait value could be extracted from the selected categories.' } });
      return;
    }

    record.status = 'archiving';
    updateTraitExtractionProgress(record, { status: 'archiving', phase: 'archiving' });
    onProgress(record.progress);

    const contactSheets: Array<{ category: string; png: Buffer }> = [];
    for (const [category, cells] of [...cellsByCategory.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const sorted = [...cells].sort((a, b) => a.traitValue.localeCompare(b.traitValue));
      contactSheets.push({ category, png: await buildContactSheet(sorted) });
    }

    const generatedAt = new Date().toISOString();
    const readmeText = buildTraitReadmeText({
      collectionAddress: summary.collectionAddress, scanId: record.scanId, preset: record.config.preset,
      generatedAt, evidence, unresolvedCount: record.unresolvedValues.length,
    });
    const generatorSchema = buildGeneratorSchema({
      collectionAddress: summary.collectionAddress, exactScannedAssetCount: summary.exactAssetCount, assets,
      selectedCategories: [...new Set(record.config.selections.map((s) => s.traitType))],
      evidence, unresolvedValues: record.unresolvedValues, generatedAt,
    });
    const extractionSummary = {
      jobId: record.jobId, scanId: record.scanId, collectionAddress: summary.collectionAddress,
      preset: record.config.preset, generatedAt,
      totalValuesRequested: targets.length, totalValuesExtracted: evidence.length, totalValuesUnresolved: record.unresolvedValues.length,
      uniqueImagesDownloaded: imageCache.uniqueImageCount, bytesDownloaded: imageCache.bytesDownloaded,
      byStatus: statusCounts(evidence),
    };

    const zipPath = path.join(record.workDir, 'trait-collection.zip');
    try {
      const zipResult = await buildTraitZip({
        readmeText,
        eligibilityJson: JSON.stringify(eligibility, null, 2),
        extractionSummaryJson: JSON.stringify(extractionSummary, null, 2),
        unresolvedTraitsJson: JSON.stringify(record.unresolvedValues, null, 2),
        generatorSchemaJson: JSON.stringify(generatorSchema, null, 2),
        values: zipValues,
        contactSheets,
      }, zipPath, combinedSignal);
      updateTraitExtractionProgress(record, { elapsedMs: Date.now() - startedAt });
      finishTerminal('completed', { zipPath, evidence });
      void zipResult;
    } catch {
      if (combinedSignal.aborted) finishTerminal('cancelled', { error: { code: 'cancelled', message: 'Trait extraction cancelled.' } });
      else finishTerminal('failed', { error: { code: 'archive_creation_failed', message: 'Failed to create the trait-collection archive.' } });
    }
  }
}

function bumpStatusCounter(progress: TraitExtractionProgressSnapshot, status: ConfidenceStatus): void {
  if (status === 'high_confidence') progress.resolvedHigh++;
  else if (status === 'medium_confidence') progress.resolvedMedium++;
  else if (status === 'low_confidence') progress.resolvedLow++;
  else if (status === 'unresolved') progress.resolvedUnresolved++;
  else if (status === 'visually_identical') progress.resolvedVisuallyIdentical++;
}
function statusCounts(evidence: TraitValueEvidence[]): Record<ConfidenceStatus, number> {
  const out: Record<ConfidenceStatus, number> = { high_confidence: 0, medium_confidence: 0, low_confidence: 0, unresolved: 0, visually_identical: 0 };
  for (const e of evidence) out[e.confidence.status]++;
  return out;
}

type ProcessValueResult =
  | { kind: 'unresolved'; reason: string; pairsAttempted: number }
  | { kind: 'resolved'; evidence: TraitValueEvidence; zipFiles: TraitZipValueFiles; candidatePngForSheet: Buffer | null; pairsAttempted: number };

async function processOneValue(
  target: ValueTarget,
  assets: NormalizedAsset[],
  limits: ReturnType<typeof presetLimitsFor>,
  imageCache: ImageDecodeCache,
  signal: AbortSignal,
): Promise<ProcessValueResult> {
  const candidates = selectComparisonCandidates(target.traitType, target.traitValue, assets, limits);
  if (candidates.length === 0) return { kind: 'unresolved', reason: 'no_valid_comparison_pair_within_preset_level', pairsAttempted: 0 };

  const urls = [...new Set(candidates.flatMap((c) => [c.sourceImage, c.comparisonImage]))];
  await runWithConcurrency(urls, TE_MAX_CONCURRENT_DOWNLOADS, async (url) => { await imageCache.get(url); });

  const cleanedPairs: CleanedPair[] = [];
  const usedCandidates: typeof candidates = [];
  let canvasAttempted = 0;
  let canvasMatched = 0;

  for (const c of candidates) {
    if (signal.aborted) break;
    canvasAttempted++;
    const [srcOutcome, cmpOutcome] = await Promise.all([imageCache.get(c.sourceImage), imageCache.get(c.comparisonImage)]);
    if (!srcOutcome.ok || !cmpOutcome.ok) continue;
    const rawMask = computeDiffMask(srcOutcome.image, cmpOutcome.image, TE_PIXEL_DIFF_THRESHOLD);
    if (!rawMask) continue; // dimension mismatch - hard filter, spec section 7.4
    canvasMatched++;
    const cleaned = cleanPairMask(rawMask, srcOutcome.image.width, srcOutcome.image.height, TE_MIN_COMPONENT_SIZE);
    cleanedPairs.push({ sourceMint: c.sourceMint, comparisonMint: c.comparisonMint, comparisonValue: c.comparisonValue, sourceImage: srcOutcome.image, diffMask: cleaned });
    usedCandidates.push(c);
  }

  if (cleanedPairs.length === 0) return { kind: 'unresolved', reason: 'no_usable_pairs_after_download_or_dimension_check', pairsAttempted: canvasAttempted };

  const consensus = estimateTargetCandidate(cleanedPairs, limits.consensusAgreementThreshold);
  const distinctSourceMints = new Set(cleanedPairs.map((p) => p.sourceMint));
  const distinctComparisonValues = new Set(cleanedPairs.map((p) => p.comparisonValue ?? ' null'));
  const level0Count = usedCandidates.filter((c) => c.level === 0).length;
  const meanLevel = usedCandidates.reduce((s, c) => s + c.level, 0) / usedCandidates.length;

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
    expandedCandidatePixelCount: consensus.expandedCandidatePixelCount,
    changedPixelCount: consensus.changedPixelCount,
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
  };

  return {
    kind: 'resolved',
    evidence: ev,
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
