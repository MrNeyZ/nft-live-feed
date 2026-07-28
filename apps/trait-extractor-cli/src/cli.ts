#!/usr/bin/env node
/**
 * trait-extractor-cli - local full-collection trait extraction (Stage 5.3).
 *
 * Wires the same runtime-independent `trait-extraction-core` the website
 * uses, plus a persistent on-disk image cache and job manifest for
 * resumability, into a terminal-friendly worker meant for FULL collection
 * jobs that the website's bounded/preview environment doesn't attempt.
 *
 * `resolveInputToCollectionAddress` and `walkFullCollection` are reused
 * directly from the app's collection-analyzer (relative import, not moved
 * into the core) - both are already network-only/framework-agnostic (no
 * Express/DB/PM2 dependency), so duplicating them into the core would be
 * pure churn.
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildCollectionIndex, buildTraitCollectionEligibility, CategoryImpactModel,
  presetLimitsFor, resolveTargetsInOrder, runTraitExtraction,
} from 'trait-extraction-core';
import type { NormalizedAsset, ProcessValueResult, TraitExtractionConfig } from 'trait-extraction-core';
import { resolveInputToCollectionAddress } from '../../../src/tools-collection-analyzer/resolve-input';
import { walkFullCollection } from '../../../src/tools-collection-analyzer/scan-fetch';
import { parseArgs, USAGE } from './args';
import { extractZipToOutputDirs } from './extract-output';
import { LocalImageCache } from './local-image-cache';
import {
  checkpointKeyFor, computeConfigHash, initManifest, loadCheckpoint, loadManifest,
  markTargetCompleted, saveCheckpoint, saveManifest,
} from './manifest';
import { ProgressReporter } from './progress-reporter';
import { runPreflightChecks } from './resource-check';

// trait-extraction-core's own package version - part of the config hash so
// a core upgrade that changes algorithm behavior invalidates old
// checkpoints instead of silently mixing results from two versions.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const CORE_VERSION: string = require('trait-extraction-core/package.json').version;

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(USAGE);
    console.error('');
    for (const e of parsed.errors) console.error(`Error: ${e}`);
    return 2;
  }
  const args = parsed.args;
  const reporter = new ProgressReporter();
  const outputDir = path.resolve(args.output);

  if (!process.env.HELIUS_API_KEY) {
    console.error('Error: HELIUS_API_KEY is not set. Put it in a .env file in the current directory, or export it in your shell.');
    return 1;
  }

  reporter.log(`Resolving "${args.collection}"...`);
  const resolved = await resolveInputToCollectionAddress(args.collection);
  if (!resolved.ok) {
    console.error(`Error: could not resolve collection input (${resolved.error}).`);
    return 1;
  }
  const collectionAddress = resolved.collectionAddress;
  reporter.log(`Collection address: ${collectionAddress}`);

  const controller = new AbortController();
  let sigintCount = 0;
  process.on('SIGINT', () => {
    sigintCount++;
    if (sigintCount >= 2) { process.exit(130); }
    reporter.log('Ctrl+C received - finishing the current value and shutting down safely (press Ctrl+C again to force-exit).');
    controller.abort();
  });

  reporter.log('Scanning full collection via Helius DAS...');
  const scanResult = await walkFullCollection(collectionAddress, controller.signal, {
    onProgress: (tick) => reporter.line(
      `[scanning] page ${tick.pagesFetched} | assets ${tick.assetsDiscovered} | duplicates ${tick.duplicatesSkipped}`
      + (tick.retryState ? ` | retry page ${tick.retryState.page} attempt ${tick.retryState.attempt}` : ''),
    ),
  });
  reporter.done();
  if (scanResult.outcome === 'cancelled') { console.error('Cancelled during scan.'); return 130; }
  if (scanResult.outcome === 'error') { console.error(`Error: scan failed (${scanResult.code}): ${scanResult.message}`); return 1; }

  const assets: NormalizedAsset[] = scanResult.assets;
  reporter.log(`Scanned ${assets.length} assets across ${scanResult.pagesFetched} page(s) (${scanResult.duplicatesSkipped} duplicate(s) skipped).`);

  const eligibility = buildTraitCollectionEligibility(assets);
  if (eligibility.classification === 'unsuitable' && !args.allowUnsuitable) {
    console.error(`Error: collection classified "unsuitable" for trait extraction. Pass --allow-unsuitable to attempt anyway.`);
    console.error(JSON.stringify(eligibility, null, 2));
    return 1;
  }

  const allCategories = [...new Set(assets.flatMap((a) => a.attributes.map((attr) => attr.trait_type)))].sort();

  // Default (no --select) means "every real trait category", NOT every
  // attribute key. Some collections carry per-asset metadata fields (e.g.
  // "Rarity Rank") shaped like an attribute but unique-per-asset - every
  // value in such a field has occurrenceCount 1, so the extraction
  // algorithm has zero repeated evidence to compare against (same
  // "repeated value" definition te-eligibility.ts already uses). Including
  // them by default would balloon the target count with values that can
  // never resolve to anything, for no benefit - so the CLI's auto-select
  // skips a category entirely when NONE of its values repeat. An explicit
  // `--select <Category>` always overrides this and is processed as asked.
  const categoryHasRepeatedValue = (traitType: string): boolean => {
    const counts = new Map<string, number>();
    for (const asset of assets) for (const attr of asset.attributes) {
      if (attr.trait_type !== traitType) continue;
      counts.set(attr.value, (counts.get(attr.value) ?? 0) + 1);
    }
    return [...counts.values()].some((c) => c > 1);
  };

  const selections = args.select.length > 0
    ? args.select.map((s) => ({ traitType: s.traitType, values: s.values }))
    : allCategories.filter(categoryHasRepeatedValue).map((traitType) => ({ traitType, values: undefined as string[] | undefined }));

  if (args.select.length === 0) {
    const skipped = allCategories.filter((c) => !categoryHasRepeatedValue(c));
    if (skipped.length > 0) reporter.log(`Skipping ${skipped.length} category/categories with no repeated values (not real traits): ${skipped.join(', ')}.`);
  }

  const unknownCategories = selections.map((s) => s.traitType).filter((t) => !allCategories.includes(t));
  if (unknownCategories.length > 0) {
    console.error(`Error: unknown categor${unknownCategories.length === 1 ? 'y' : 'ies'}: ${unknownCategories.join(', ')}.`);
    console.error(`Available categories: ${allCategories.join(', ')}`);
    return 1;
  }

  const config: TraitExtractionConfig = { scanId: `cli-${collectionAddress}`, selections, preset: args.preset };
  const limits = presetLimitsFor(args.preset);
  const collectionIndex = buildCollectionIndex(assets);
  const impactModel = new CategoryImpactModel();
  const targets = resolveTargetsInOrder(assets, config, collectionIndex, impactModel, limits);
  if (targets.length === 0) {
    console.error('Error: no matching trait values found for the selected categories.');
    return 1;
  }
  reporter.log(`${targets.length} trait value(s) to process across ${selections.length} categor${selections.length === 1 ? 'y' : 'ies'}.`);

  const preflight = await runPreflightChecks(outputDir, targets, limits);
  for (const w of preflight.warnings) reporter.log(`Warning: ${w}`);
  if (!preflight.ok) {
    for (const e of preflight.errors) console.error(`Error: ${e}`);
    return 1;
  }
  reporter.log(`Estimated unique images: ~${preflight.estimatedUniqueImages}, estimated temp disk: ~${Math.round(preflight.estimatedTempBytes / 1024 / 1024)}MB.`);

  const manifestConfig = { collectionAddress, preset: args.preset, selections, coreVersion: CORE_VERSION };
  let manifest = args.fresh ? null : await loadManifest(outputDir);
  const skipTargets = new Set<string>();
  const resumedResults = new Map<string, ProcessValueResult>();

  if (manifest && computeConfigHash(manifestConfig) !== manifest.configHash) {
    reporter.log('Config differs from the previous run in this output directory - starting fresh (previous checkpoints ignored).');
    manifest = null;
  }
  if (manifest) {
    for (const key of manifest.completedTargetKeys) {
      const checkpoint = await loadCheckpoint(outputDir, key);
      if (checkpoint) { skipTargets.add(key); resumedResults.set(key, checkpoint); }
    }
    if (skipTargets.size > 0) reporter.log(`Resuming: ${skipTargets.size}/${targets.length} value(s) already complete from a previous run.`);
  }
  if (!manifest) manifest = await initManifest(outputDir, manifestConfig, targets.length);
  const activeManifest = manifest;

  const workDir = path.join(outputDir, '.work');
  await fs.promises.mkdir(workDir, { recursive: true });
  const imageCache = new LocalImageCache(path.join(outputDir, 'cache'), controller.signal);

  const result = await runTraitExtraction({
    jobId: activeManifest.jobId,
    scanId: config.scanId,
    assets,
    collectionAddress,
    exactScannedAssetCount: assets.length,
    config,
    workDir,
    signal: controller.signal,
    imageAcquirer: imageCache,
    onProgress: (p) => reporter.onProgress(p),
    onValueSettled: async ({ target, result: settled }) => {
      const key = checkpointKeyFor(target.traitType, target.traitValue);
      await saveCheckpoint(outputDir, key, settled);
      await markTargetCompleted(outputDir, activeManifest, key);
    },
    skipTargets,
    resumedResults,
  });
  reporter.done();

  if (result.status === 'cancelled') {
    activeManifest.status = 'cancelled';
    await saveManifest(outputDir, activeManifest);
    console.error('Cancelled. Re-run the same command to resume from the last checkpoint.');
    return 130;
  }
  if (result.status === 'failed') {
    activeManifest.status = 'failed';
    await saveManifest(outputDir, activeManifest);
    console.error(`Failed: ${result.error?.code ?? 'unknown_error'} - ${result.error?.message ?? ''}`);
    return 1;
  }

  if (result.error) {
    // The core can return status:'completed' with an error attached when a
    // job-wide safety ceiling (e.g. total_size_exceeded) is hit mid-run:
    // real evidence exists but the job did NOT process every target, and
    // no ZIP was built (found via a real run against a heavy-art
    // collection that hit the download budget at 58% through). Reporting
    // this as a plain "Done" would silently hide that most of the
    // collection was never attempted - status stays 'running' (not
    // 'completed') so a plain re-run resumes and finishes instead of
    // being mistaken for done.
    activeManifest.status = 'running';
    await saveManifest(outputDir, activeManifest);
    const attempted = result.evidence.length + result.unresolvedValues.length;
    console.error(`Warning: extraction stopped early (${result.error.code}): ${result.error.message}`);
    console.error(`${attempted}/${targets.length} value(s) were attempted (${result.evidence.length} extracted, ${result.unresolvedValues.length} unresolved) before stopping; ${targets.length - attempted} were never reached.`);
    console.error('No ZIP was produced for this run. Re-run the same command (without --fresh) to resume from these checkpoints and finish the rest.');
    const partialSummary = {
      ok: false, truncated: true, errorCode: result.error.code, errorMessage: result.error.message,
      collectionAddress, preset: args.preset,
      totalValuesRequested: targets.length, totalValuesAttempted: attempted,
      totalValuesExtracted: result.evidence.length, totalValuesUnresolved: result.unresolvedValues.length,
      uniqueImagesDownloaded: imageCache.uniqueImageCount, bytesDownloaded: imageCache.bytesDownloaded,
      outputDir, zip: null,
    };
    await fs.promises.mkdir(path.join(outputDir, 'logs'), { recursive: true });
    await fs.promises.writeFile(path.join(outputDir, 'logs', 'last-run-summary.json'), JSON.stringify(partialSummary, null, 2));
    if (args.json) console.log(JSON.stringify(partialSummary));
    return 1;
  }

  activeManifest.status = 'completed';
  await saveManifest(outputDir, activeManifest);

  const finalZipPath = path.join(outputDir, 'collection-traits.zip');
  if (result.zipPath) {
    await fs.promises.copyFile(result.zipPath, finalZipPath);
    await extractZipToOutputDirs(result.zipPath, outputDir);
  }
  await fs.promises.rm(workDir, { recursive: true, force: true });

  const summary = {
    ok: true,
    collectionAddress,
    preset: args.preset,
    totalValuesRequested: targets.length,
    totalValuesExtracted: result.evidence.length,
    totalValuesUnresolved: result.unresolvedValues.length,
    uniqueImagesDownloaded: imageCache.uniqueImageCount,
    bytesDownloaded: imageCache.bytesDownloaded,
    outputDir,
    zip: fs.existsSync(finalZipPath) ? finalZipPath : null,
    extractionSummary: result.extractionSummary ?? null,
  };
  await fs.promises.mkdir(path.join(outputDir, 'logs'), { recursive: true });
  await fs.promises.writeFile(path.join(outputDir, 'logs', 'last-run-summary.json'), JSON.stringify(summary, null, 2));

  if (args.json) {
    console.log(JSON.stringify(summary));
  } else {
    reporter.log(`Done: ${summary.totalValuesExtracted}/${summary.totalValuesRequested} extracted, ${summary.totalValuesUnresolved} unresolved.`);
    reporter.log(`Output: ${outputDir}`);
  }
  return 0;
}

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    console.error('Fatal error:', (err as Error)?.stack ?? err);
    process.exitCode = 1;
  });
