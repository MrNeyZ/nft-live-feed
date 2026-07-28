/**
 * trait-extractor-cli - argument parsing/validation.
 *
 * Deliberately dependency-free (no commander/yargs) - this CLI has one
 * job, and hand-rolled parsing keeps the Windows-compatibility surface
 * (no shell-specific globbing/quoting assumptions) obvious and auditable.
 */
import type { ExtractionPreset } from 'trait-extraction-core';

export interface CliSelection { traitType: string; values?: string[] }

export type LogLevel = 'quiet' | 'normal' | 'verbose' | 'debug';

/** One-shot commands that short-circuit the real run (Stage 5.4 section
 *  7) - at most one is active per invocation; `null` means "run the real
 *  extraction job" (Stage 5.3's only behavior, still the default). */
export type CliCommand =
  | { kind: 'run' }
  | { kind: 'version' }
  | { kind: 'listCategories' }
  | { kind: 'listTraits'; category: string }
  | { kind: 'dryRun' }
  | { kind: 'estimate' };

export interface CliArgs {
  collection: string;
  preset: ExtractionPreset;
  output: string;
  select: CliSelection[]; // empty = eligibility/preview only, no extraction
  downloadConcurrency: number;
  processingConcurrency: number;
  allowUnsuitable: boolean;
  fresh: boolean; // ignore any existing checkpoint/manifest, start over
  json: boolean; // machine-readable summary only on stdout, human progress on stderr
  command: CliCommand;
  logLevel: LogLevel;
  cacheDir: string | null; // null = use config/env/default (cache-paths.ts)
  clearCache: boolean;
  cacheOnly: boolean;
  offline: boolean;
  configPath: string | null; // explicit --config path override
  /** Names of fields the user actually typed a flag for, vs. ones that
   *  only hold their built-in default - config.ts's CLI>env>file>default
   *  precedence needs this distinction (a field always holding SOME value,
   *  e.g. `preset` defaulting to 'balanced', is otherwise indistinguishable
   *  from "the user typed --preset balanced"). */
  explicitFlags: ReadonlySet<string>;
}

export type ParsedArgs = { ok: true; args: CliArgs } | { ok: false; errors: string[] };

const DEFAULT_OUTPUT = './output';
const DEFAULT_PRESET: ExtractionPreset = 'balanced';
const VALID_PRESETS: ExtractionPreset[] = ['fast', 'balanced', 'thorough'];

export const USAGE = `
trait-extractor-cli - local full-collection trait extraction

Usage:
  npm run trait-extract -- --collection <address|mint|marketplace-url> [options]

Required:
  --collection <input>        Collection address, NFT mint, or a Tensor/Magic
                               Eden collection URL (same input formats the
                               website's collection analyzer accepts).

Options:
  --preset <fast|balanced|thorough>   Default: balanced.
  --output <dir>                      Output directory. Default: ./output.
  --select <Category>                 Restrict to one category (repeatable).
                                       Omit entirely to select EVERY category
                                       in the collection - unlike the website
                                       (which caps selection size for bounded
                                       preview jobs), the CLI is meant for
                                       full-collection runs and has no
                                       category/value selection cap. Download
                                       volume is still bounded by the same
                                       resource ceilings (TE_MAX_UNIQUE_IMAGE_DOWNLOADS,
                                       TE_MAX_TOTAL_DOWNLOAD_BYTES, etc).
  --values <Category=Value1,Value2>   Restrict a category to specific values
                                       (repeatable, one per category).
  --download-concurrency <n>          Real, wired core knob. Default: 6.
  --processing-concurrency <n>        Does NOT parallelize the extraction
                                       algorithm's per-value/per-pair loop
                                       (that stays sequential by design -
                                       see docs/known-limitations). Instead
                                       sizes Node's libuv threadpool
                                       (UV_THREADPOOL_SIZE), letting the
                                       already-bounded concurrent image
                                       decodes actually run in parallel
                                       instead of queueing. Default: 3.
  --allow-unsuitable                  Attempt extraction even when
                                       eligibility classifies the collection
                                       "unsuitable".
  --fresh                             Ignore any existing checkpoint/manifest
                                       in --output and start over.
  --config <path>                     Explicit config.json path (error if
                                       missing). Default lookup: ./config.json,
                                       then ~/.trait-extractor-cli/config.json.
  --cache-dir <dir>                   Override the shared cache root.
                                       Default: ~/.trait-extractor-cli/cache.
  --clear-cache                       Delete the entire cache root, then exit.
  --cache-only                        Fail fast on any resource not already
                                       cached, instead of downloading it.
  --offline                           Like --cache-only, and additionally
                                       skip collection-resolution network
                                       calls when a cached scan already
                                       covers the given --collection input.
  --quiet / --normal / --verbose / --debug
                                       Log level. Default: --normal.
  --version                           Print CLI + core package versions.
  --list-categories                   Scan, then print every trait category
                                       and whether it would be auto-selected.
  --list-traits <Category>            Scan, then print one category's
                                       distinct values + occurrence counts.
  --dry-run                           Resolve the full job plan (scan,
                                       eligibility, targets, preflight,
                                       resume status) without downloading
                                       or extracting anything.
  --estimate                          Like --dry-run, plus an accurate
                                       predicted cache-hit-rate/bytes-needed
                                       projection using the real candidate
                                       search (no network beyond the scan).
  --json                              Print ONLY the final machine-readable
                                       summary to stdout (human progress still
                                       goes to stderr). If invoking through
                                       "npm run trait-extract", add --silent
                                       (npm run --silent trait-extract -- ...)
                                       so npm's own banner lines don't land in
                                       stdout ahead of the JSON.
  --help                              Show this message.
`.trim();

const ALL_FLAGS = [
  '--help', '-h', '--collection', '--preset', '--output', '--select', '--values',
  '--download-concurrency', '--processing-concurrency', '--allow-unsuitable', '--fresh',
  '--config', '--cache-dir', '--clear-cache', '--cache-only', '--offline',
  '--quiet', '--normal', '--verbose', '--debug', '--version',
  '--list-categories', '--list-traits', '--dry-run', '--estimate', '--json',
];

/** Cheap edit distance for "did you mean" suggestions (spec section 7:
 *  "errors should suggest fixes") - no need for anything fancier than a
 *  plain Levenshtein distance against the fixed, short flag list above. */
function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}
function suggestFlag(unknown: string): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const flag of ALL_FLAGS) {
    const d = levenshtein(unknown, flag);
    if (d < bestDist) { bestDist = d; best = flag; }
  }
  return best && bestDist <= 3 ? best : null;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const errors: string[] = [];
  let collection: string | null = null;
  let preset: ExtractionPreset = DEFAULT_PRESET;
  let output = DEFAULT_OUTPUT;
  const selectionsByCategory = new Map<string, CliSelection>();
  let downloadConcurrency = 6;
  let processingConcurrency = 3;
  let allowUnsuitable = false;
  let fresh = false;
  let json = false;
  let logLevel: LogLevel = 'normal';
  let cacheDir: string | null = null;
  let clearCache = false;
  let cacheOnly = false;
  let offline = false;
  let configPath: string | null = null;
  const commands: CliCommand[] = [];
  const explicitFlags = new Set<string>();

  const need = (flag: string, i: number): string | null => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) { errors.push(`${flag} requires a value.`); return null; }
    return v;
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--help': case '-h':
        console.log(USAGE);
        process.exit(0);
        break;
      case '--version': {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const cliVersion = require('../package.json').version;
        // Plain JSON require, same non-triggering pattern cli.ts already
        // uses for CORE_VERSION - does NOT execute trait-extraction-core's
        // index.ts/te-limits.ts, so no bootstrap-ordering risk here.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const coreVersion = require('trait-extraction-core/package.json').version;
        console.log(`trait-extractor-cli ${cliVersion} (trait-extraction-core ${coreVersion})`);
        process.exit(0);
        break;
      }
      case '--collection': { const v = need(a, i); if (v !== null) { collection = v; i++; } break; }
      case '--preset': {
        const v = need(a, i); if (v === null) break; i++;
        if (!VALID_PRESETS.includes(v as ExtractionPreset)) { errors.push(`--preset must be one of ${VALID_PRESETS.join(', ')}, got "${v}".`); break; }
        preset = v as ExtractionPreset;
        explicitFlags.add('preset');
        break;
      }
      case '--output': { const v = need(a, i); if (v !== null) { output = v; explicitFlags.add('output'); i++; } break; }
      case '--select': {
        const v = need(a, i); if (v === null) break; i++;
        if (!selectionsByCategory.has(v)) selectionsByCategory.set(v, { traitType: v });
        break;
      }
      case '--values': {
        const v = need(a, i); if (v === null) break; i++;
        const eq = v.indexOf('=');
        if (eq <= 0) { errors.push(`--values expects "Category=Value1,Value2", got "${v}".`); break; }
        const cat = v.slice(0, eq);
        const values = v.slice(eq + 1).split(',').map((s) => s.trim()).filter((s) => s.length > 0);
        if (values.length === 0) { errors.push(`--values for "${cat}" has no values after "=".`); break; }
        selectionsByCategory.set(cat, { traitType: cat, values });
        break;
      }
      case '--download-concurrency': {
        const v = need(a, i); if (v === null) break; i++;
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1) { errors.push(`--download-concurrency must be a positive integer, got "${v}".`); break; }
        downloadConcurrency = n;
        explicitFlags.add('downloadConcurrency');
        break;
      }
      case '--processing-concurrency': {
        const v = need(a, i); if (v === null) break; i++;
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1) { errors.push(`--processing-concurrency must be a positive integer, got "${v}".`); break; }
        processingConcurrency = n;
        explicitFlags.add('processingConcurrency');
        break;
      }
      case '--allow-unsuitable': allowUnsuitable = true; explicitFlags.add('allowUnsuitable'); break;
      case '--fresh': fresh = true; explicitFlags.add('fresh'); break;
      case '--json': json = true; explicitFlags.add('json'); break;
      case '--quiet': logLevel = 'quiet'; explicitFlags.add('logLevel'); break;
      case '--normal': logLevel = 'normal'; explicitFlags.add('logLevel'); break;
      case '--verbose': logLevel = 'verbose'; explicitFlags.add('logLevel'); break;
      case '--debug': logLevel = 'debug'; explicitFlags.add('logLevel'); break;
      case '--cache-dir': { const v = need(a, i); if (v !== null) { cacheDir = v; explicitFlags.add('cacheDir'); i++; } break; }
      case '--clear-cache': clearCache = true; break;
      case '--cache-only': cacheOnly = true; explicitFlags.add('cacheOnly'); break;
      case '--offline': offline = true; explicitFlags.add('offline'); break;
      case '--config': { const v = need(a, i); if (v !== null) { configPath = v; i++; } break; }
      case '--list-categories': commands.push({ kind: 'listCategories' }); break;
      case '--list-traits': {
        const v = need(a, i); if (v === null) break; i++;
        commands.push({ kind: 'listTraits', category: v });
        break;
      }
      case '--dry-run': commands.push({ kind: 'dryRun' }); break;
      case '--estimate': commands.push({ kind: 'estimate' }); break;
      default: {
        const suggestion = suggestFlag(a);
        errors.push(`Unknown argument "${a}".${suggestion ? ` Did you mean "${suggestion}"?` : ''}`);
      }
    }
  }

  if (!clearCache) {
    if (!collection) errors.push('--collection is required.');
  }
  if (commands.length > 1) {
    errors.push(`Only one of --list-categories/--list-traits/--dry-run/--estimate may be given at a time (got ${commands.length}).`);
  }
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    args: {
      collection: collection ?? '', preset, output,
      select: [...selectionsByCategory.values()],
      downloadConcurrency, processingConcurrency, allowUnsuitable, fresh, json,
      command: clearCache ? { kind: 'run' } : (commands[0] ?? { kind: 'run' }),
      logLevel, cacheDir, clearCache, cacheOnly, offline, configPath,
      explicitFlags,
    },
  };
}
