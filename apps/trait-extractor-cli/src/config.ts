/**
 * trait-extractor-cli - layered configuration (Stage 5.4 section 1).
 *
 * Single source of truth for every configurable value. Precedence per
 * value: CLI flag (if explicitly passed) > env var > config.json > default.
 *
 * `args.ts` has only a TYPE-ONLY import from `trait-extraction-core`
 * (`import type { ExtractionPreset }`), which `ts-node --transpile-only`
 * (how this CLI always runs - see package.json's `start`/test scripts)
 * erases entirely at transpile time, never producing a runtime `require`.
 * That means `resolveConfig` - which calls `parseArgs` - can safely run
 * from `bootstrap.ts` BEFORE `trait-extraction-core` is ever required,
 * which is exactly the seam bootstrap.ts needs: every `te-limits.ts`
 * constant is a plain constant read ONCE at first import, so anything
 * that must reach one (TE_MAX_CONCURRENT_DOWNLOADS, TE_MAX_TOTAL_DOWNLOAD_BYTES,
 * TE_MAX_UNIQUE_IMAGE_DOWNLOADS) has to be resolved and set on
 * `process.env` before that first import happens.
 *
 * `resolveConfig` itself is pure (besides reading config.json/env/cwd) -
 * BUT `bootstrap.ts` deliberately WRITES its result back into
 * `process.env` (that's the whole point, for te-limits.ts's benefit),
 * which means calling `resolveConfig` a second time afterward (e.g. from
 * cli.ts) would see those just-written values and misattribute them as
 * `source: 'env'` instead of `'default'`/`'file'` - a real bug found via
 * manual smoke-testing, not hypothetical. `cacheResolution`/
 * `getCachedResolution` below solve it: bootstrap.ts resolves ONCE and
 * caches the full result (config + accurate sources) before touching
 * `process.env` at all; cli.ts reads that cached result instead of
 * re-resolving. A direct call to `resolveConfig` (as tests do) is still
 * fine on its own - the caching is what makes the TWO-CALL, ONE-PROCESS
 * bootstrap.ts->cli.ts handoff correct.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseArgs } from './args';
import type { CliArgs, LogLevel } from './args';
import { defaultCacheRoot } from './cache-paths';

export type ConfigSource = 'cli' | 'env' | 'file' | 'default';

export interface ResolvedConfig {
  preset: CliArgs['preset'];
  output: string;
  allowUnsuitable: boolean;
  fresh: boolean;
  json: boolean;
  command: CliArgs['command'];
  collection: string;
  select: CliArgs['select'];

  cacheDir: string;
  cacheOnly: boolean;
  offline: boolean;
  scanCacheMaxAgeMs: number;
  maxImageCacheBytes: number;
  clearCache: boolean;

  downloadConcurrency: number;
  processingConcurrency: number;
  teMaxTotalDownloadBytes: number;
  teMaxUniqueImageDownloads: number;

  logLevel: LogLevel;
  reportPath: string | null;

  heartbeatIntervalMs: number;
}

export interface ConfigFileShape {
  $schemaVersion?: number;
  job?: { preset?: string; output?: string; allowUnsuitable?: boolean; fresh?: boolean; json?: boolean };
  cache?: { cacheDir?: string; cacheOnly?: boolean; offline?: boolean; scanCacheMaxAgeMs?: number; maxImageCacheBytes?: number };
  concurrency?: { downloadConcurrency?: number; processingConcurrency?: number; teMaxTotalDownloadBytes?: number; teMaxUniqueImageDownloads?: number };
  logging?: { level?: string; reportPath?: string | null };
  resume?: { heartbeatIntervalMs?: number };
}

export interface ConfigResolution {
  config: ResolvedConfig;
  sources: Record<string, ConfigSource>;
  configFilePath: string | null; // which file (if any) was actually loaded
  parseErrors: string[]; // argv parse errors, if any (caller decides whether to abort)
}

function expandHome(p: string): string {
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

/** Loads config.json per the documented lookup order: an explicit
 *  `--config <path>` (hard error if missing - the user asked for THIS
 *  file), else `./config.json` (cwd, matching the CLI's existing
 *  `.env`-in-cwd convention), else `~/.trait-extractor-cli/config.json`,
 *  else none (fully optional - defaults apply). A malformed file at a
 *  non-explicit path is treated as "not found" (falls back to defaults),
 *  matching manifest.ts's existing corrupt-file-returns-null philosophy;
 *  an explicit `--config` path that fails to parse IS an error, since the
 *  user pointed at it directly. */
function loadConfigFile(explicitPath: string | null, cwd: string): { data: ConfigFileShape | null; path: string | null; error: string | null } {
  const candidates = explicitPath
    ? [{ p: path.resolve(cwd, explicitPath), required: true }]
    : [
        { p: path.join(cwd, 'config.json'), required: false },
        { p: path.join(os.homedir(), '.trait-extractor-cli', 'config.json'), required: false },
      ];

  for (const { p, required } of candidates) {
    if (!fs.existsSync(p)) {
      if (required) return { data: null, path: null, error: `--config "${p}" does not exist.` };
      continue;
    }
    try {
      const raw = fs.readFileSync(p, 'utf8');
      return { data: JSON.parse(raw) as ConfigFileShape, path: p, error: null };
    } catch (err) {
      if (required) return { data: null, path: null, error: `--config "${p}" is not valid JSON: ${(err as Error).message}` };
      // Non-explicit malformed config.json: skip it silently at this layer
      // (caller/logger surfaces a warning) and fall through to defaults.
      continue;
    }
  }
  return { data: null, path: null, error: null };
}

const VALID_LOG_LEVELS: LogLevel[] = ['quiet', 'normal', 'verbose', 'debug'];

export function resolveConfig(argv: string[], env: NodeJS.ProcessEnv, cwd: string): ConfigResolution {
  const parsed = parseArgs(argv);
  const sources: Record<string, ConfigSource> = {};
  const parseErrors = parsed.ok ? [] : parsed.errors;
  const args: CliArgs | null = parsed.ok ? parsed.args : null;

  const fileResult = loadConfigFile(args?.configPath ?? null, cwd);
  const file = fileResult.data ?? {};
  if (fileResult.error) parseErrors.push(fileResult.error);

  const explicit = args?.explicitFlags ?? new Set<string>();

  /** `key` must match the name the same field is registered under in
   *  args.ts's `explicitFlags` set (where one exists) - that's the only
   *  reliable "did the user actually type this flag" signal, since
   *  parseArgs always returns SOME value (its own built-in default) for
   *  every job-shape field regardless of whether a flag was given. */
  function pick<T>(key: string, cliValue: T | undefined | null, envVar: string, envParse: (raw: string) => T | null, fileValue: T | undefined, def: T): T {
    if (explicit.has(key) && cliValue !== undefined && cliValue !== null) { sources[key] = 'cli'; return cliValue; }
    const rawEnv = env[envVar];
    if (rawEnv !== undefined) {
      const parsedEnv = envParse(rawEnv);
      if (parsedEnv !== null) { sources[key] = 'env'; return parsedEnv; }
    }
    if (fileValue !== undefined) { sources[key] = 'file'; return fileValue; }
    sources[key] = 'default';
    return def;
  }

  const parseIntEnv = (raw: string): number | null => { const n = Number(raw); return Number.isFinite(n) ? n : null; };
  const parseBoolEnv = (raw: string): boolean | null => (raw === '1' || raw.toLowerCase() === 'true' ? true : raw === '0' || raw.toLowerCase() === 'false' ? false : null);
  const parseLogLevelEnv = (raw: string): LogLevel | null => (VALID_LOG_LEVELS.includes(raw as LogLevel) ? (raw as LogLevel) : null);
  const parsePresetEnv = (raw: string): CliArgs['preset'] | null => (['fast', 'balanced', 'thorough'].includes(raw) ? (raw as CliArgs['preset']) : null);

  const config: ResolvedConfig = {
    preset: pick('preset', args?.preset, 'TRAIT_EXTRACTOR_PRESET', parsePresetEnv, file.job?.preset as CliArgs['preset'] | undefined, 'balanced'),
    output: pick('output', args?.output, 'TRAIT_EXTRACTOR_OUTPUT', (r) => r, file.job?.output, './output'),
    allowUnsuitable: pick('allowUnsuitable', args?.allowUnsuitable, 'TRAIT_EXTRACTOR_ALLOW_UNSUITABLE', parseBoolEnv, file.job?.allowUnsuitable, false),
    fresh: pick('fresh', args?.fresh, 'TRAIT_EXTRACTOR_FRESH', parseBoolEnv, file.job?.fresh, false),
    json: pick('json', args?.json, 'TRAIT_EXTRACTOR_JSON', parseBoolEnv, file.job?.json, false),
    command: args?.command ?? { kind: 'run' }, // one-shot command flags are not config.json/env fields (see header comment)
    collection: args?.collection ?? '',
    select: args?.select ?? [],

    cacheDir: expandHome(pick('cacheDir', args?.cacheDir, 'TRAIT_EXTRACTOR_CACHE_DIR', (r) => r, file.cache?.cacheDir, defaultCacheRoot())),
    cacheOnly: pick('cacheOnly', args?.cacheOnly, 'TRAIT_EXTRACTOR_CACHE_ONLY', parseBoolEnv, file.cache?.cacheOnly, false),
    offline: pick('offline', args?.offline, 'TRAIT_EXTRACTOR_OFFLINE', parseBoolEnv, file.cache?.offline, false),
    scanCacheMaxAgeMs: pick('scanCacheMaxAgeMs', undefined, 'TRAIT_EXTRACTOR_SCAN_CACHE_MAX_AGE_MS', parseIntEnv, file.cache?.scanCacheMaxAgeMs, 24 * 60 * 60 * 1000),
    maxImageCacheBytes: pick('maxImageCacheBytes', undefined, 'TRAIT_EXTRACTOR_MAX_IMAGE_CACHE_BYTES', parseIntEnv, file.cache?.maxImageCacheBytes, 10 * 1024 * 1024 * 1024),
    clearCache: args?.clearCache ?? false,

    downloadConcurrency: pick('downloadConcurrency', args?.downloadConcurrency, 'TRAIT_EXTRACTOR_DOWNLOAD_CONCURRENCY', parseIntEnv, file.concurrency?.downloadConcurrency, 6),
    processingConcurrency: pick('processingConcurrency', args?.processingConcurrency, 'TRAIT_EXTRACTOR_PROCESSING_CONCURRENCY', parseIntEnv, file.concurrency?.processingConcurrency, 3),
    teMaxTotalDownloadBytes: pick('teMaxTotalDownloadBytes', undefined, 'TE_MAX_TOTAL_DOWNLOAD_BYTES', parseIntEnv, file.concurrency?.teMaxTotalDownloadBytes, 20 * 1024 * 1024 * 1024),
    teMaxUniqueImageDownloads: pick('teMaxUniqueImageDownloads', undefined, 'TE_MAX_UNIQUE_IMAGE_DOWNLOADS', parseIntEnv, file.concurrency?.teMaxUniqueImageDownloads, 50_000),

    logLevel: pick('logLevel', args?.logLevel, 'TRAIT_EXTRACTOR_LOG_LEVEL', parseLogLevelEnv, file.logging?.level as LogLevel | undefined, 'normal'),
    reportPath: pick('reportPath', undefined, 'TRAIT_EXTRACTOR_REPORT_PATH', (r) => r, file.logging?.reportPath ?? undefined, null),

    heartbeatIntervalMs: pick('heartbeatIntervalMs', undefined, 'TRAIT_EXTRACTOR_HEARTBEAT_INTERVAL_MS', parseIntEnv, file.resume?.heartbeatIntervalMs, 30_000),
  };

  return { config, sources, configFilePath: fileResult.path, parseErrors };
}

// `Symbol.for` (a global, cross-realm registry key, not a module-local
// variable) is used deliberately: bootstrap.ts and cli.ts are two
// different CommonJS modules, but ts-node's transpile-only mode and this
// project's build have, in the past (Stage 5.3's TE_MAX_* env-var seam),
// needed to reason carefully about what is and isn't shared module state
// across a require() boundary within the SAME process - a global registry
// key sidesteps any doubt about that entirely.
const RESOLUTION_CACHE_KEY = Symbol.for('trait-extractor-cli.resolvedConfig');

/** Called ONCE by bootstrap.ts, before it writes anything into
 *  `process.env` - stashes the accurate config+sources so cli.ts can read
 *  the SAME resolution back instead of calling `resolveConfig` again
 *  (which would misattribute bootstrap's own env writes as `source:'env'`
 *  - see the header comment above). */
export function cacheResolution(resolution: ConfigResolution): void {
  (globalThis as unknown as Record<symbol, ConfigResolution>)[RESOLUTION_CACHE_KEY] = resolution;
}

/** Returns bootstrap.ts's cached resolution if present, else resolves
 *  fresh (e.g. a test or tool that imports cli.ts's internals directly,
 *  without going through bootstrap.ts first - process.env hasn't been
 *  touched yet in that case, so a fresh resolve is accurate too). */
export function resolveConfigOnce(argv: string[], env: NodeJS.ProcessEnv, cwd: string): ConfigResolution {
  const cached = (globalThis as unknown as Record<symbol, ConfigResolution | undefined>)[RESOLUTION_CACHE_KEY];
  return cached ?? resolveConfig(argv, env, cwd);
}
