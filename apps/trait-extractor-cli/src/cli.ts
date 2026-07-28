#!/usr/bin/env node
/**
 * trait-extractor-cli - local full-collection trait extraction
 * (Stage 5.3 core run path; Stage 5.4 production-grade worker hardening).
 *
 * Wires the same runtime-independent `trait-extraction-core` the website
 * uses, plus a persistent shared image/scan cache and a resumable job
 * manifest, into a terminal-friendly worker meant for FULL collection jobs
 * the website's bounded/preview environment doesn't attempt.
 *
 * Stage 5.4 added: layered config (config.ts), a leveled logger
 * (logger.ts) replacing the old ProgressReporter, a shared job-setup
 * engine (job-plan.ts) behind both the real run and the new
 * list/dry-run/estimate commands, a global cross-collection cache
 * (cache-paths.ts/metadata-cache.ts), manifest phase/heartbeat fields, and
 * a structured JSON execution report - all without touching the
 * extraction algorithm itself.
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import { runTraitExtraction } from 'trait-extraction-core';
import type { ProcessValueResult, TraitExtractionJobStatus } from 'trait-extraction-core';
import { USAGE } from './args';
import { clearCache as clearCacheRoot, cleanupCache, computeCacheStats, ensureCacheDirs, imagesDir } from './cache-paths';
import { resolveConfigOnce } from './config';
import { extractZipToOutputDirs } from './extract-output';
import { buildExecutionReport, writeExecutionReport } from './execution-report';
import type { EffortTiming, PhaseTiming } from './execution-report';
import { buildJobPlan, computeAccurateEstimate, listCategoryValues } from './job-plan';
import type { JobPlan, JobPlanOutcome } from './job-plan';
import { LocalImageCache } from './local-image-cache';
import { Logger } from './logger';
import {
  checkpointKeyFor, initManifest, loadCheckpoint, markTargetCompleted,
  saveManifest, saveCheckpoint, shouldCheckpointSettlement, touchHeartbeat, updatePhase,
} from './manifest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const CORE_VERSION: string = require('trait-extraction-core/package.json').version;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const CLI_VERSION: string = require('../package.json').version;

function printPlanFailure(outcome: Extract<JobPlanOutcome, { ok: false }>, logger: Logger): number {
  if (outcome.code === 'unsuitable') {
    logger.error(outcome.message);
    console.error(JSON.stringify(outcome.details, null, 2));
    return 1;
  }
  logger.error(outcome.message);
  return outcome.code === 'scan_cancelled' ? 130 : 1;
}

function renderListCategories(plan: JobPlan): number {
  const selectedSet = new Set(plan.selections.map((s) => s.traitType));
  console.log(`Collection: ${plan.collectionAddress} (${plan.assets.length} assets)\n`);
  for (const category of plan.allCategories) {
    const autoSelected = selectedSet.has(category);
    const skipped = plan.skippedCategoriesNoRepeatedValue.includes(category);
    console.log(`  ${category}${autoSelected ? ' [selected]' : ''}${skipped ? ' [skipped: no repeated values]' : ''}`);
  }
  return 0;
}

function renderListTraits(plan: JobPlan, category: string): number {
  if (!plan.allCategories.includes(category)) {
    console.error(`Error: unknown category "${category}". Available categories: ${plan.allCategories.join(', ')}`);
    return 1;
  }
  const values = listCategoryValues(plan.assets, category);
  const targetedValues = new Set(plan.targets.filter((t) => t.traitType === category).map((t) => t.traitValue));
  console.log(`Category: ${category} (${values.length} distinct value(s))\n`);
  for (const v of values) {
    console.log(`  ${v.value}: ${v.occurrenceCount} asset(s)${targetedValues.has(v.value) ? ' [targeted]' : ''}`);
  }
  return 0;
}

async function renderDryRun(plan: JobPlan, cacheDir: string): Promise<number> {
  const stats = await computeCacheStats(cacheDir);
  console.log(`Collection: ${plan.collectionAddress} (${plan.assets.length} assets, scan ${plan.scan.fromCache ? 'from cache' : 'freshly walked'})`);
  console.log(`Categories: ${plan.selections.length} selected of ${plan.allCategories.length} total`);
  console.log(`Targets: ${plan.targets.length} trait value(s) to process`);
  console.log(`Preflight: ~${plan.preflight.estimatedUniqueImages} unique images, ~${Math.round(plan.preflight.estimatedTempBytes / 1024 / 1024)}MB estimated temp disk`);
  console.log(`Resume: ${plan.existingManifest ? `would resume (${plan.existingManifest.completedTargetKeys.length}/${plan.targets.length} already complete, last phase "${plan.existingManifest.phase}")` : 'would start fresh (no matching manifest)'}`);
  console.log(`Cache: ${stats.imagesCount} image(s) (${Math.round(stats.imagesBytes / 1024 / 1024)}MB), ${stats.scansCount} cached scan(s), at ${stats.cacheRoot}`);
  console.log('\n(--dry-run: no downloads or extraction performed.)');
  return 0;
}

async function renderEstimate(plan: JobPlan, cacheDir: string): Promise<number> {
  await renderDryRun(plan, cacheDir);
  const estimate = await computeAccurateEstimate(plan, cacheDir);
  const predictedHitRate = estimate.totalUniqueUrls > 0 ? Math.round((estimate.cachedHits / estimate.totalUniqueUrls) * 100) : 0;
  console.log(`\nAccurate projection (real candidate search, no network beyond the scan):`);
  console.log(`  Unique candidate images: ${estimate.totalUniqueUrls}`);
  console.log(`  Already cached (hit): ${estimate.cachedHits} (${predictedHitRate}% predicted hit rate)`);
  console.log(`  Cached permanent failures (will not retry): ${estimate.cachedPermanentFailures}`);
  console.log(`  Missing (would download): ${estimate.missing} (~${Math.round(estimate.estimatedBytesToDownload / 1024 / 1024)}MB estimated)`);
  return 0;
}

async function main(): Promise<number> {
  const startedAt = Date.now();
  const argv = process.argv.slice(2);
  const { config, sources, configFilePath, parseErrors } = resolveConfigOnce(argv, process.env, process.cwd());

  if (parseErrors.length > 0) {
    console.error(USAGE);
    console.error('');
    for (const e of parseErrors) console.error(`Error: ${e}`);
    return 2;
  }

  const logger = new Logger(config.logLevel);
  if (configFilePath) logger.debug(`Loaded config file: ${configFilePath}`);
  logger.debug('Resolved config', { config, sources });

  await ensureCacheDirs(config.cacheDir);

  if (config.clearCache) {
    await clearCacheRoot(config.cacheDir);
    logger.info(`Cache cleared: ${config.cacheDir}`);
    return 0;
  }

  if (!config.offline && !config.cacheOnly && !process.env.HELIUS_API_KEY) {
    logger.error('HELIUS_API_KEY is not set. Put it in a .env file in the current directory, or export it in your shell. (Not required under --offline/--cache-only when every needed resource is already cached.)');
    return 1;
  }

  if (config.processingConcurrency !== 3) {
    logger.info(`--processing-concurrency ${config.processingConcurrency}: sizes Node's libuv threadpool (UV_THREADPOOL_SIZE), NOT the extraction algorithm's per-value/per-pair loop (that stays sequential by design - see docs/known-limitations.md).`);
  }

  const controller = new AbortController();
  let sigintCount = 0;
  process.on('SIGINT', () => {
    sigintCount++;
    if (sigintCount >= 2) { process.exit(130); }
    logger.info('Ctrl+C received - finishing the current value and shutting down safely (press Ctrl+C again to force-exit).');
    controller.abort();
  });

  const scanStart = Date.now();
  const planOutcome = await buildJobPlan(config, CORE_VERSION, logger, controller.signal);
  const scanAndSetupDurationMs = Date.now() - scanStart;

  if (!planOutcome.ok) return printPlanFailure(planOutcome, logger);
  const plan = planOutcome.plan;

  switch (config.command.kind) {
    case 'listCategories': return renderListCategories(plan);
    case 'listTraits': return renderListTraits(plan, config.command.category);
    case 'dryRun': return await renderDryRun(plan, config.cacheDir);
    case 'estimate': return await renderEstimate(plan, config.cacheDir);
    case 'run': break;
  }

  // ---- Real run ------------------------------------------------------
  const manifestConfig = plan.manifestConfig;
  let manifest = plan.existingManifest;
  const skipTargets = new Set<string>();
  const resumedResults = new Map<string, ProcessValueResult>();
  const resumedFromManifest = manifest !== null;
  const completedTargetsAtStart = manifest?.completedTargetKeys.length ?? 0;

  if (manifest) {
    for (const key of manifest.completedTargetKeys) {
      const checkpoint = await loadCheckpoint(plan.outputDir, key);
      if (checkpoint) { skipTargets.add(key); resumedResults.set(key, checkpoint); }
    }
    if (skipTargets.size > 0) logger.info(`Resuming: ${skipTargets.size}/${plan.targets.length} value(s) already complete from a previous run.`);
    logger.verbose(`Resume: manifest phase was "${manifest.phase}", last heartbeat ${manifest.lastHeartbeatAt}.`);
  }
  if (!manifest) manifest = await initManifest(plan.outputDir, manifestConfig, plan.targets.length);
  const activeManifest = manifest;
  await updatePhase(plan.outputDir, activeManifest, 'processing');

  const heartbeatTimer = setInterval(() => {
    touchHeartbeat(plan.outputDir, activeManifest).catch((err) => logger.debug('heartbeat write failed', err));
  }, config.heartbeatIntervalMs);
  heartbeatTimer.unref();

  const workDir = path.join(plan.outputDir, '.work');
  await fs.promises.mkdir(workDir, { recursive: true });
  const imageCache = new LocalImageCache(imagesDir(config.cacheDir), controller.signal);

  const memorySamples: { ts: string; rssBytes: number }[] = [];
  const phaseFirstSeenAt: Partial<Record<TraitExtractionJobStatus, number>> = {};
  const runStart = Date.now();

  const result = await runTraitExtraction({
    jobId: activeManifest.jobId,
    scanId: plan.extractionConfig.scanId,
    assets: plan.assets,
    collectionAddress: plan.collectionAddress,
    exactScannedAssetCount: plan.assets.length,
    config: plan.extractionConfig,
    workDir,
    signal: controller.signal,
    imageAcquirer: imageCache,
    onProgress: (p) => {
      if (phaseFirstSeenAt[p.phase] === undefined) phaseFirstSeenAt[p.phase] = Date.now();
      memorySamples.push({ ts: new Date().toISOString(), rssBytes: process.memoryUsage().rss });
      logger.progress(p);
    },
    onValueSettled: async ({ target, result: settled }) => {
      const key = checkpointKeyFor(target.traitType, target.traitValue);
      if (!shouldCheckpointSettlement(settled.kind, controller.signal.aborted)) {
        logger.verbose(`Not checkpointing ${target.traitType} = ${target.traitValue}: settled unresolved while cancelling - a resume will retry it fresh instead of treating an interrupt artifact as final.`);
        return;
      }
      await saveCheckpoint(plan.outputDir, key, settled);
      await markTargetCompleted(plan.outputDir, activeManifest, key);
      logger.verbose(`Completed: ${target.traitType} = ${target.traitValue}`);
    },
    skipTargets,
    resumedResults,
  });
  logger.endProgress();
  clearInterval(heartbeatTimer);

  const runEnd = Date.now();
  const archivingStartedAt = phaseFirstSeenAt.archiving ?? runEnd;
  const downloadingStartedAt = phaseFirstSeenAt.downloading ?? runStart;
  // Wall-clock breakdown ONLY - `downloadingAndProcessing` is one combined
  // span (from the first 'downloading' progress tick to the first
  // 'archiving' tick) because the core interleaves per-value download and
  // processing sequentially with no externally-observable boundary
  // between them across a whole job (see docs/known-limitations.md).
  // Deliberately NOT decomposed further using imageCache's cumulative
  // download/decode timers - those sum per-call durations across
  // CONCURRENT downloads, so they can (and regularly do) exceed this
  // span's own wall-clock length; subtracting them from it previously
  // produced a nonsensical negative-clamped-to-zero "processing" number,
  // caught during Stage 5.4's real-collection validation. Cumulative
  // effort is reported separately, below, never mixed into `phases`.
  const phases: Record<string, PhaseTiming> = {
    scanAndSetup: { durationMs: scanAndSetupDurationMs, cacheHit: plan.scan.fromCache },
    downloadingAndProcessing: { durationMs: archivingStartedAt - downloadingStartedAt, note: 'combined wall-clock span: downloads + pair-search + diff-generation + consensus - see docs/known-limitations.md' },
    archiving: { durationMs: runEnd - archivingStartedAt },
  };
  const effort: Record<string, EffortTiming> = {
    downloads: { cumulativeMs: imageCache.downloadTimeMs },
    decode: { cumulativeMs: imageCache.decodeTimeMs },
  };
  const imagesCacheHitRate = imageCache.cacheHitRate;

  async function finish(exitCode: number, resultSummary: Record<string, unknown>): Promise<number> {
    await cleanupCache(config.cacheDir, { scanMaxAgeMs: config.scanCacheMaxAgeMs, maxImageBytes: config.maxImageCacheBytes }).catch((err) => logger.debug('cache cleanup failed', err));
    const report = buildExecutionReport({
      cliVersion: CLI_VERSION, coreVersion: CORE_VERSION, startedAt, config, sources,
      collectionAddress: plan.collectionAddress, phases, effort,
      resume: { resumedFromManifest, completedTargetsAtStart, totalTargets: plan.targets.length },
      cache: { imagesCacheHitRate, scanCacheHit: plan.scan.fromCache },
      memorySamples, result: resultSummary, events: [...logger.getEvents()],
    });
    const reportPath = await writeExecutionReport(plan.outputDir, config.reportPath, report);
    logger.verbose(`Execution report: ${reportPath}`);
    return exitCode;
  }

  if (result.status === 'cancelled') {
    activeManifest.status = 'cancelled';
    await saveManifest(plan.outputDir, activeManifest);
    logger.error('Cancelled. Re-run the same command to resume from the last checkpoint.');
    return finish(130, { ok: false, status: 'cancelled' });
  }
  if (result.status === 'failed') {
    activeManifest.status = 'failed';
    await saveManifest(plan.outputDir, activeManifest);
    logger.error(`Failed: ${result.error?.code ?? 'unknown_error'} - ${result.error?.message ?? ''}`);
    return finish(1, { ok: false, status: 'failed', error: result.error ?? null });
  }

  if (result.error) {
    // The core can return status:'completed' with an error attached when a
    // job-wide safety ceiling (e.g. total_size_exceeded) is hit mid-run:
    // real evidence exists but the job did NOT process every target, and
    // no ZIP was built. Reporting this as a plain "Done" would silently
    // hide that most of the collection was never attempted - status stays
    // 'running' (not 'completed') so a plain re-run resumes and finishes
    // instead of being mistaken for done.
    activeManifest.status = 'running';
    await saveManifest(plan.outputDir, activeManifest);
    const attempted = result.evidence.length + result.unresolvedValues.length;
    logger.error(`extraction stopped early (${result.error.code}): ${result.error.message}`);
    logger.info(`${attempted}/${plan.targets.length} value(s) were attempted (${result.evidence.length} extracted, ${result.unresolvedValues.length} unresolved) before stopping; ${plan.targets.length - attempted} were never reached.`);
    logger.info('No ZIP was produced for this run. Re-run the same command (without --fresh) to resume from these checkpoints and finish the rest.');
    const partialSummary = {
      ok: false, truncated: true, errorCode: result.error.code, errorMessage: result.error.message,
      collectionAddress: plan.collectionAddress, preset: config.preset,
      totalValuesRequested: plan.targets.length, totalValuesAttempted: attempted,
      totalValuesExtracted: result.evidence.length, totalValuesUnresolved: result.unresolvedValues.length,
      uniqueImagesDownloaded: imageCache.uniqueImageCount, bytesDownloaded: imageCache.bytesDownloaded,
      outputDir: plan.outputDir, zip: null,
    };
    await fs.promises.mkdir(path.join(plan.outputDir, 'logs'), { recursive: true });
    await fs.promises.writeFile(path.join(plan.outputDir, 'logs', 'last-run-summary.json'), JSON.stringify(partialSummary, null, 2));
    if (config.json) console.log(JSON.stringify(partialSummary));
    return finish(1, partialSummary);
  }

  activeManifest.status = 'completed';
  await updatePhase(plan.outputDir, activeManifest, 'completed');
  await saveManifest(plan.outputDir, activeManifest);

  const finalZipPath = path.join(plan.outputDir, 'collection-traits.zip');
  if (result.zipPath) {
    await fs.promises.copyFile(result.zipPath, finalZipPath);
    await extractZipToOutputDirs(result.zipPath, plan.outputDir);
  }
  await fs.promises.rm(workDir, { recursive: true, force: true });

  const summary = {
    ok: true,
    collectionAddress: plan.collectionAddress,
    preset: config.preset,
    totalValuesRequested: plan.targets.length,
    totalValuesExtracted: result.evidence.length,
    totalValuesUnresolved: result.unresolvedValues.length,
    uniqueImagesDownloaded: imageCache.uniqueImageCount,
    bytesDownloaded: imageCache.bytesDownloaded,
    outputDir: plan.outputDir,
    zip: fs.existsSync(finalZipPath) ? finalZipPath : null,
    extractionSummary: result.extractionSummary ?? null,
  };
  await fs.promises.mkdir(path.join(plan.outputDir, 'logs'), { recursive: true });
  await fs.promises.writeFile(path.join(plan.outputDir, 'logs', 'last-run-summary.json'), JSON.stringify(summary, null, 2));

  if (config.json) {
    console.log(JSON.stringify(summary));
  } else {
    logger.info(`Done: ${summary.totalValuesExtracted}/${summary.totalValuesRequested} extracted, ${summary.totalValuesUnresolved} unresolved.`);
    logger.info(`Output: ${plan.outputDir}`);
  }
  return finish(0, summary);
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    console.error('Fatal error:', (err as Error)?.stack ?? err);
    process.exitCode = 1;
  });
