/**
 * trait-extractor-cli - argument parsing/validation.
 *
 * Deliberately dependency-free (no commander/yargs) - this CLI has one
 * job, and hand-rolled parsing keeps the Windows-compatibility surface
 * (no shell-specific globbing/quoting assumptions) obvious and auditable.
 */
import type { ExtractionPreset } from 'trait-extraction-core';

export interface CliSelection { traitType: string; values?: string[] }

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
  --download-concurrency <n>          Default: 6.
  --processing-concurrency <n>        Reserved for future use. Default: 3.
  --allow-unsuitable                  Attempt extraction even when
                                       eligibility classifies the collection
                                       "unsuitable".
  --fresh                             Ignore any existing checkpoint/manifest
                                       in --output and start over.
  --json                              Print ONLY the final machine-readable
                                       summary to stdout (human progress still
                                       goes to stderr). If invoking through
                                       "npm run trait-extract", add --silent
                                       (npm run --silent trait-extract -- ...)
                                       so npm's own banner lines don't land in
                                       stdout ahead of the JSON.
  --help                              Show this message.
`.trim();

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
      case '--collection': { const v = need(a, i); if (v !== null) { collection = v; i++; } break; }
      case '--preset': {
        const v = need(a, i); if (v === null) break; i++;
        if (!VALID_PRESETS.includes(v as ExtractionPreset)) { errors.push(`--preset must be one of ${VALID_PRESETS.join(', ')}, got "${v}".`); break; }
        preset = v as ExtractionPreset;
        break;
      }
      case '--output': { const v = need(a, i); if (v !== null) { output = v; i++; } break; }
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
        break;
      }
      case '--processing-concurrency': {
        const v = need(a, i); if (v === null) break; i++;
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1) { errors.push(`--processing-concurrency must be a positive integer, got "${v}".`); break; }
        processingConcurrency = n;
        break;
      }
      case '--allow-unsuitable': allowUnsuitable = true; break;
      case '--fresh': fresh = true; break;
      case '--json': json = true; break;
      default:
        errors.push(`Unknown argument "${a}".`);
    }
  }

  if (!collection) errors.push('--collection is required.');
  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    args: {
      collection: collection!, preset, output,
      select: [...selectionsByCategory.values()],
      downloadConcurrency, processingConcurrency, allowUnsuitable, fresh, json,
    },
  };
}
