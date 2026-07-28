/**
 * trait-extractor-cli - shared job-setup engine (Stage 5.4 section 5).
 *
 * Extracts Stage 5.3's `cli.ts` setup sequence (resolve collection -> scan
 * or cache-load -> eligibility -> category selection -> target resolution
 * -> preflight -> resume-status lookup) into one function. This is the
 * shared engine behind the real run AND `--dry-run`/`--estimate`/
 * `--list-categories`/`--list-traits` - those four commands are thin
 * renderers over the same `JobPlan`, not separate logic.
 *
 * Never throws for expected failure modes - every one returns a typed
 * `JobPlanOutcome`, matching the rest of this CLI's "return null/typed
 * failure, never crash" philosophy (manifest.ts, local-image-cache.ts).
 */
import * as path from 'path';
import {
  buildCollectionIndex, buildTraitCollectionEligibility, CategoryImpactModel,
  expandComparisonSearch, presetLimitsFor, resolveTargetsInOrder,
} from 'trait-extraction-core';
import type {
  ExtractionPresetLimits, NormalizedAsset, TraitCollectionEligibility, TraitExtractionConfig, ValueTarget,
} from 'trait-extraction-core';
import { resolveInputToCollectionAddress } from '../../../src/tools-collection-analyzer/resolve-input';
import { walkFullCollection } from '../../../src/tools-collection-analyzer/scan-fetch';
import type { CliSelection } from './args';
import { imagesDir } from './cache-paths';
import type { ResolvedConfig } from './config';
import { hasCachedEntry } from './local-image-cache';
import type { Logger } from './logger';
import { computeConfigHash, loadManifest } from './manifest';
import type { JobManifest, ManifestConfig } from './manifest';
import { loadCachedScan, saveCachedScan } from './metadata-cache';
import type { CachedScanResult } from './metadata-cache';
import { runPreflightChecks } from './resource-check';
import type { PreflightResult } from './resource-check';

export interface ScanInfo {
  pagesFetched: number;
  duplicatesSkipped: number;
  warnings: string[];
  fromCache: boolean;
}

export interface JobPlan {
  outputDir: string;
  collectionAddress: string;
  assets: NormalizedAsset[];
  scan: ScanInfo;
  eligibility: TraitCollectionEligibility;
  allCategories: string[];
  skippedCategoriesNoRepeatedValue: string[];
  selections: CliSelection[];
  extractionConfig: TraitExtractionConfig;
  limits: ExtractionPresetLimits;
  targets: ValueTarget[];
  /** Reused (not rebuilt) by `--estimate`, so its accurate per-target
   *  candidate search sees the EXACT same index/model `resolveTargetsInOrder`
   *  already built - rebuilding would be deterministic too (both are pure
   *  functions of `assets`), but reuse avoids doing the work twice. */
  collectionIndex: ReturnType<typeof buildCollectionIndex>;
  impactModel: CategoryImpactModel;
  preflight: PreflightResult;
  manifestConfig: ManifestConfig;
  /** Present only when it both exists AND its config hash matches this
   *  exact job (collection+preset+selections+core version) - a stale
   *  manifest from a differently-configured previous run is never
   *  reported as resumable. */
  existingManifest: JobManifest | null;
}

export type JobPlanOutcome =
  | { ok: true; plan: JobPlan }
  | {
      ok: false;
      code: 'resolve_failed' | 'scan_cancelled' | 'scan_failed' | 'offline_missing_scan'
        | 'unsuitable' | 'unknown_categories' | 'no_targets' | 'preflight_failed';
      message: string;
      details?: unknown;
    };

/** Same "real trait category" filter cli.ts used in Stage 5.3: a category
 *  where every value's occurrence count is 1 has zero repeated evidence to
 *  compare against (per-asset metadata fields like "Rarity Rank" are
 *  shaped like an attribute but unique-per-asset) - default (no
 *  `--select`) selection skips these; an explicit `--select` always
 *  overrides and is processed as asked. */
export function categoryHasRepeatedValue(assets: NormalizedAsset[], traitType: string): boolean {
  const counts = new Map<string, number>();
  for (const asset of assets) for (const attr of asset.attributes) {
    if (attr.trait_type !== traitType) continue;
    counts.set(attr.value, (counts.get(attr.value) ?? 0) + 1);
  }
  return [...counts.values()].some((c) => c > 1);
}

export interface CategoryValueCount { value: string; occurrenceCount: number }

/** `--list-traits <Category>`'s data: every distinct value in one category
 *  + its occurrence count, sorted most-common-first (ties broken
 *  lexically for determinism). */
export function listCategoryValues(assets: NormalizedAsset[], traitType: string): CategoryValueCount[] {
  const counts = new Map<string, number>();
  for (const asset of assets) for (const attr of asset.attributes) {
    if (attr.trait_type !== traitType) continue;
    counts.set(attr.value, (counts.get(attr.value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, occurrenceCount]) => ({ value, occurrenceCount }))
    .sort((a, b) => b.occurrenceCount - a.occurrenceCount || a.value.localeCompare(b.value));
}

async function scanOrLoadCached(
  config: ResolvedConfig, collectionAddress: string, logger: Logger, signal: AbortSignal,
): Promise<{ ok: true; assets: NormalizedAsset[]; scan: ScanInfo } | { ok: false; code: 'scan_cancelled' | 'scan_failed' | 'offline_missing_scan'; message: string }> {
  const maxAgeMs = config.fresh ? 0 : config.scanCacheMaxAgeMs;
  if (!config.fresh) {
    const cached = await loadCachedScan(config.cacheDir, collectionAddress, config.offline ? Infinity : maxAgeMs);
    if (cached) {
      logger.verbose(`Scan cache hit for ${collectionAddress} (${cached.assets.length} assets) - skipping the DAS walk entirely.`);
      return { ok: true, assets: cached.assets, scan: { pagesFetched: cached.pagesFetched, duplicatesSkipped: cached.duplicatesSkipped, warnings: cached.warnings, fromCache: true } };
    }
  }
  if (config.offline || config.cacheOnly) {
    return { ok: false, code: 'offline_missing_scan', message: `no cached scan for ${collectionAddress} and ${config.offline ? '--offline' : '--cache-only'} forbids a live DAS walk.` };
  }

  logger.info('Scanning full collection via Helius DAS...');
  const scanResult = await walkFullCollection(collectionAddress, signal, {
    onProgress: (tick) => logger.verbose(
      `[scanning] page ${tick.pagesFetched} | assets ${tick.assetsDiscovered} | duplicates ${tick.duplicatesSkipped}`
      + (tick.retryState ? ` | retry page ${tick.retryState.page} attempt ${tick.retryState.attempt}` : ''),
    ),
  });
  if (scanResult.outcome === 'cancelled') return { ok: false, code: 'scan_cancelled', message: 'cancelled during scan.' };
  if (scanResult.outcome === 'error') return { ok: false, code: 'scan_failed', message: `scan failed (${scanResult.code}): ${scanResult.message}` };

  const cacheable: CachedScanResult = {
    assets: scanResult.assets, perAssetIssues: scanResult.perAssetIssues,
    pagesFetched: scanResult.pagesFetched, duplicatesSkipped: scanResult.duplicatesSkipped, warnings: scanResult.warnings,
  };
  await saveCachedScan(config.cacheDir, collectionAddress, cacheable);
  return {
    ok: true, assets: scanResult.assets,
    scan: { pagesFetched: scanResult.pagesFetched, duplicatesSkipped: scanResult.duplicatesSkipped, warnings: scanResult.warnings, fromCache: false },
  };
}

export async function buildJobPlan(config: ResolvedConfig, coreVersion: string, logger: Logger, signal: AbortSignal): Promise<JobPlanOutcome> {
  const outputDir = path.resolve(config.output);

  // Offline honest-scoping (see cache-paths.ts/docs "known limitations"):
  // resolveInputToCollectionAddress ALWAYS makes a network call, even for
  // address-shaped input (it checks whether the address is actually an
  // individual mint). Full offline support would require editing that
  // shared backend file, which is off-limits - so --offline instead
  // bypasses collection resolution entirely ONLY when a cached scan
  // already exists keyed by the raw --collection input treated directly
  // as a collection address. Any other input shape (mint/URL/slug) still
  // requires the live resolution call even under --offline.
  let collectionAddress: string;
  if (config.offline) {
    const directHit = await loadCachedScan(config.cacheDir, config.collection, Infinity);
    if (directHit) {
      collectionAddress = config.collection;
      logger.verbose(`--offline: treating "${config.collection}" directly as the collection address (cached scan found).`);
    } else {
      logger.info(`Resolving "${config.collection}"... (--offline: this one step still requires network - see known limitations)`);
      const resolved = await resolveInputToCollectionAddress(config.collection);
      if (!resolved.ok) return { ok: false, code: 'resolve_failed', message: `could not resolve collection input (${resolved.error}).` };
      collectionAddress = resolved.collectionAddress;
    }
  } else {
    logger.info(`Resolving "${config.collection}"...`);
    const resolved = await resolveInputToCollectionAddress(config.collection);
    if (!resolved.ok) return { ok: false, code: 'resolve_failed', message: `could not resolve collection input (${resolved.error}).` };
    collectionAddress = resolved.collectionAddress;
  }
  logger.info(`Collection address: ${collectionAddress}`);

  const scanOutcome = await scanOrLoadCached(config, collectionAddress, logger, signal);
  if (!scanOutcome.ok) return { ok: false, code: scanOutcome.code, message: scanOutcome.message };
  const { assets, scan } = scanOutcome;
  logger.info(`Scanned ${assets.length} assets across ${scan.pagesFetched} page(s) (${scan.duplicatesSkipped} duplicate(s) skipped)${scan.fromCache ? ' [from cache]' : ''}.`);

  const eligibility = buildTraitCollectionEligibility(assets);
  if (eligibility.classification === 'unsuitable' && !config.allowUnsuitable) {
    return { ok: false, code: 'unsuitable', message: 'collection classified "unsuitable" for trait extraction. Pass --allow-unsuitable to attempt anyway.', details: eligibility };
  }

  const allCategories = [...new Set(assets.flatMap((a) => a.attributes.map((attr) => attr.trait_type)))].sort();
  const selections: CliSelection[] = config.select.length > 0
    ? config.select.map((s) => ({ traitType: s.traitType, values: s.values }))
    : allCategories.filter((c) => categoryHasRepeatedValue(assets, c)).map((traitType) => ({ traitType, values: undefined as string[] | undefined }));
  const skippedCategoriesNoRepeatedValue = config.select.length === 0 ? allCategories.filter((c) => !categoryHasRepeatedValue(assets, c)) : [];
  if (skippedCategoriesNoRepeatedValue.length > 0) {
    logger.info(`Skipping ${skippedCategoriesNoRepeatedValue.length} category/categories with no repeated values (not real traits): ${skippedCategoriesNoRepeatedValue.join(', ')}.`);
  }

  const unknownCategories = selections.map((s) => s.traitType).filter((t) => !allCategories.includes(t));
  if (unknownCategories.length > 0) {
    return {
      ok: false, code: 'unknown_categories',
      message: `unknown categor${unknownCategories.length === 1 ? 'y' : 'ies'}: ${unknownCategories.join(', ')}. Available categories: ${allCategories.join(', ')}`,
    };
  }

  const extractionConfig: TraitExtractionConfig = { scanId: `cli-${collectionAddress}`, selections, preset: config.preset };
  const limits = presetLimitsFor(config.preset);
  const collectionIndex = buildCollectionIndex(assets);
  const impactModel = new CategoryImpactModel();
  const targets = resolveTargetsInOrder(assets, extractionConfig, collectionIndex, impactModel, limits);
  if (targets.length === 0) {
    return { ok: false, code: 'no_targets', message: 'no matching trait values found for the selected categories.' };
  }
  logger.info(`${targets.length} trait value(s) to process across ${selections.length} categor${selections.length === 1 ? 'y' : 'ies'}.`);

  const preflight = await runPreflightChecks(outputDir, targets, limits);
  for (const w of preflight.warnings) logger.warn(w);
  if (!preflight.ok) {
    return { ok: false, code: 'preflight_failed', message: preflight.errors.join(' '), details: preflight };
  }
  logger.info(`Estimated unique images: ~${preflight.estimatedUniqueImages}, estimated temp disk: ~${Math.round(preflight.estimatedTempBytes / 1024 / 1024)}MB.`);

  const manifestConfig: ManifestConfig = { collectionAddress, preset: config.preset, selections, coreVersion };
  let existingManifest: JobManifest | null = config.fresh ? null : await loadManifest(outputDir);
  if (existingManifest && computeConfigHash(manifestConfig) !== existingManifest.configHash) {
    logger.info('Config differs from the previous run in this output directory - starting fresh (previous checkpoints ignored).');
    existingManifest = null;
  }

  return {
    ok: true,
    plan: {
      outputDir, collectionAddress, assets, scan, eligibility, allCategories,
      skippedCategoriesNoRepeatedValue, selections, extractionConfig, limits, targets,
      collectionIndex, impactModel, preflight, manifestConfig, existingManifest,
    },
  };
}

export interface AccurateEstimate {
  totalUniqueUrls: number;
  cachedHits: number;
  cachedPermanentFailures: number; // would fail again without --allow-unsuitable-style override; not re-attempted
  missing: number;
  estimatedBytesToDownload: number;
}

/** `--estimate`'s accurate projection (Stage 5.4 section 5/8): runs the
 *  REAL candidate search per target (no network, no core edit -
 *  `expandComparisonSearch` is already part of the core's public barrel)
 *  and checks each unique URL against the on-disk cache, rather than
 *  `resource-check.ts`'s cheap `pairs x 2` heuristic (which stays as the
 *  fast default used during normal-run preflight, unchanged). Reuses
 *  `plan.collectionIndex`/`plan.impactModel` so results are identical to
 *  what a real run's own target resolution already computed. */
export async function computeAccurateEstimate(plan: JobPlan, cacheDir: string): Promise<AccurateEstimate> {
  const urls = new Set<string>();
  for (const target of plan.targets) {
    const { candidates } = expandComparisonSearch({
      targetTraitType: target.traitType,
      targetValue: target.traitValue,
      index: plan.collectionIndex,
      impactModel: plan.impactModel,
      limits: plan.limits,
      preset: plan.extractionConfig.preset,
    });
    for (const c of candidates) { urls.add(c.sourceImage); urls.add(c.comparisonImage); }
  }

  let cachedHits = 0;
  let cachedPermanentFailures = 0;
  let missing = 0;
  const dir = imagesDir(cacheDir);
  for (const url of urls) {
    const state = await hasCachedEntry(dir, url);
    if (state === 'hit') cachedHits++;
    else if (state === 'permanent-failure') cachedPermanentFailures++;
    else missing++;
  }

  // Same "~1-2MB average compressed source image" assumption
  // resource-check.ts's estimateUniqueImages/estimatedTempBytes already
  // documents and uses - kept identical here rather than inventing a
  // second, possibly-inconsistent number.
  const estimatedBytesToDownload = missing * 2 * 1024 * 1024;
  return { totalUniqueUrls: urls.size, cachedHits, cachedPermanentFailures, missing, estimatedBytesToDownload };
}
