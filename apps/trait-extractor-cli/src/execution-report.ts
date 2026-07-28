/**
 * trait-extractor-cli - structured JSON execution report (Stage 5.4
 * section 6). Separate from the existing `logs/last-run-summary.json`
 * (Stage 5.3's plain machine-readable result summary, unchanged) - this is
 * the fuller diagnostic record: config resolution + source per key,
 * per-phase timings, resume info, cache hit rates, memory samples, and the
 * complete logger event log, written atomically to
 * `<output>/logs/execution-report.json` (or `--report-path`/config
 * override).
 */
import * as path from 'path';
import type { ConfigSource, ResolvedConfig } from './config';
import { writeAtomic } from './fs-atomic';
import type { LogEvent } from './logger';

export interface PhaseTiming { durationMs: number; [extra: string]: unknown }

/** Cumulative per-call time summed across CONCURRENT operations (e.g.
 *  every `downloadToFile`/sharp-decode call this run) - this is NOT a
 *  wall-clock span and routinely EXCEEDS the run's total duration when
 *  several calls overlap (the same `user` vs `real` distinction `time(1)`
 *  reports - 6 downloads at ~3s each running concurrently sum to ~18s of
 *  "effort" inside ~3s of real time). Reported separately from `phases`
 *  (which IS a wall-clock breakdown) specifically so the two are never
 *  confused - a bug caught during Stage 5.4's own real-collection
 *  validation, where subtracting this cumulative figure from wall-clock
 *  time produced a nonsensical negative-clamped-to-zero "processing"
 *  duration. */
export interface EffortTiming { cumulativeMs: number }

export interface ExecutionReport {
  reportVersion: 1;
  cliVersion: string;
  coreVersion: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  collectionAddress: string | null;
  preset: string;
  configResolved: Record<string, { value: unknown; source: ConfigSource }>;
  /** Wall-clock breakdown - these are non-overlapping spans that
   *  approximately sum to `durationMs` (see docs/known-limitations.md for
   *  why `downloadingAndProcessing` is one combined bucket, not split). */
  phases: Record<string, PhaseTiming>;
  /** Cumulative concurrent-operation effort - NOT wall-clock, NOT a
   *  subset of `phases`. See `EffortTiming`'s doc comment. */
  effort: Record<string, EffortTiming>;
  resume: { resumedFromManifest: boolean; completedTargetsAtStart: number; totalTargets: number };
  cache: { imagesCacheHitRate: number | null; scanCacheHit: boolean | null };
  memory: { peakRssBytes: number; samples: { ts: string; rssBytes: number }[] };
  result: Record<string, unknown>;
  warnings: string[];
  errors: string[];
  events: LogEvent[];
}

export interface BuildExecutionReportInput {
  cliVersion: string;
  coreVersion: string;
  startedAt: number;
  config: ResolvedConfig;
  sources: Record<string, ConfigSource>;
  collectionAddress: string | null;
  phases: Record<string, PhaseTiming>;
  effort: Record<string, EffortTiming>;
  resume: { resumedFromManifest: boolean; completedTargetsAtStart: number; totalTargets: number };
  cache: { imagesCacheHitRate: number | null; scanCacheHit: boolean | null };
  memorySamples: { ts: string; rssBytes: number }[];
  result: Record<string, unknown>;
  events: LogEvent[];
}

function redactConfigForReport(config: ResolvedConfig): Record<string, unknown> {
  // Plain object spread - every ResolvedConfig field today is a path,
  // number, boolean, or small plain object (never a secret/credential;
  // HELIUS_API_KEY etc. live in process.env, not in this config surface),
  // so no field-by-field redaction list is needed. Revisit if a
  // credential-shaped field is ever added to ResolvedConfig.
  return { ...config };
}

export function buildExecutionReport(input: BuildExecutionReportInput): ExecutionReport {
  const configPlain = redactConfigForReport(input.config);
  const configResolved: Record<string, { value: unknown; source: ConfigSource }> = {};
  for (const key of Object.keys(configPlain)) {
    configResolved[key] = { value: configPlain[key], source: input.sources[key] ?? 'default' };
  }
  const finishedAt = Date.now();
  const samples = input.memorySamples;
  return {
    reportVersion: 1,
    cliVersion: input.cliVersion,
    coreVersion: input.coreVersion,
    startedAt: new Date(input.startedAt).toISOString(),
    finishedAt: new Date(finishedAt).toISOString(),
    durationMs: finishedAt - input.startedAt,
    collectionAddress: input.collectionAddress,
    preset: input.config.preset,
    configResolved,
    phases: input.phases,
    effort: input.effort,
    resume: input.resume,
    cache: input.cache,
    memory: { peakRssBytes: samples.reduce((max, s) => Math.max(max, s.rssBytes), 0), samples },
    result: input.result,
    warnings: input.events.filter((e) => e.level === 'warn').map((e) => e.message),
    errors: input.events.filter((e) => e.level === 'error').map((e) => e.message),
    events: input.events,
  };
}

export async function writeExecutionReport(outputDir: string, reportPathOverride: string | null, report: ExecutionReport): Promise<string> {
  const dest = reportPathOverride ? path.resolve(reportPathOverride) : path.join(outputDir, 'logs', 'execution-report.json');
  await writeAtomic(dest, JSON.stringify(report, null, 2));
  return dest;
}
