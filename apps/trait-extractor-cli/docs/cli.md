# CLI reference (Stage 5.4)

```
npm run trait-extract -- --collection <address|mint|marketplace-url> [options]
```

Run `npm run trait-extract -- --help` at any time for the full inline
usage text (kept in sync with this document — `args.ts`'s `USAGE`).

## Required

| Flag | Description |
|---|---|
| `--collection <input>` | Collection address, NFT mint, or a Tensor/Magic Eden collection URL. Not required for `--version`, `--clear-cache`, or `--help`. |

## Job shape

| Flag | Default | Notes |
|---|---|---|
| `--preset <fast\|balanced\|thorough>` | `balanced` | Extraction quality/effort preset — unchanged from Stage 5.3, not touched by Stage 5.4. |
| `--output <dir>` | `./output` | Output directory. |
| `--select <Category>` | (all repeated-value categories) | Repeatable. Omit entirely to select every real trait category. |
| `--values <Category=Value1,Value2>` | — | Repeatable, one per category. |
| `--allow-unsuitable` | off | Attempt extraction even when eligibility classifies the collection "unsuitable". |
| `--fresh` | off | Ignore any existing checkpoint/manifest/cached scan in `--output`/cache and start over. |
| `--json` | off | Print ONLY the final machine-readable summary to stdout; human progress stays on stderr. |

## Configuration

| Flag | Notes |
|---|---|
| `--config <path>` | Explicit config.json path (hard error if missing). See `docs/configuration.md`. |
| `--cache-dir <dir>` | Override the shared cache root. Default: `~/.trait-extractor-cli/cache`. |

## Cache & offline

| Flag | Notes |
|---|---|
| `--clear-cache` | Delete the entire cache root, then exit. Does not require `--collection`. |
| `--cache-only` | Fail fast on any resource not already cached, instead of downloading it. |
| `--offline` | Like `--cache-only`, plus skips collection-resolution network calls **when a cached scan already covers the literal `--collection` input treated directly as an address**. See known-limitations.md for the exact scope — this is not full network isolation for every input shape. |

## Performance

| Flag | Default | Notes |
|---|---|---|
| `--download-concurrency <n>` | 6 | Real, wired core knob (`TE_MAX_CONCURRENT_DOWNLOADS`). |
| `--processing-concurrency <n>` | 3 | Does **not** parallelize the extraction algorithm's per-value/per-pair loop (stays sequential by design). Sizes Node's libuv threadpool (`UV_THREADPOOL_SIZE`) instead — see known-limitations.md. |

## Logging

| Flag | Notes |
|---|---|
| `--quiet` | Errors only. |
| `--normal` (default) | Errors, warnings, progress, and info lines. |
| `--verbose` | Adds timings, cache-hit/miss detail, resume events. |
| `--debug` | Adds config-resolution trace and full detail. |

Every level always writes a full structured event log to
`<output>/logs/execution-report.json` (or `--report-path`/config
override), regardless of what's shown on the terminal.

## One-shot commands

At most one of these may be given at a time; each is a thin renderer over
the same shared job-setup plan (`job-plan.ts`) the real run uses — no
separate logic, no separate scan.

| Command | What it does |
|---|---|
| `--version` | Print CLI + `trait-extraction-core` package versions. Exits immediately, no `--collection` needed. |
| `--list-categories` | Scan (or load from cache), then print every trait category, whether it has repeated values, and whether it would be auto-selected by default. |
| `--list-traits <Category>` | Scan, then print one category's distinct values + occurrence counts + whether each is targeted. |
| `--dry-run` | Resolve the full job plan (scan, eligibility, targets, preflight, resume status, cache stats) without downloading or extracting anything. |
| `--estimate` | Everything `--dry-run` does, plus an accurate predicted cache-hit-rate/bytes-needed projection using the real candidate search (`expandComparisonSearch`) checked against the on-disk cache — no network beyond the scan itself. |

## Example commands

```bash
# Quick sanity check before committing to a real run (no downloads):
npm run trait-extract -- --collection <addr> --dry-run

# Accurate resource projection before running for real:
npm run trait-extract -- --collection <addr> --estimate

# See what categories exist and which would be auto-selected:
npm run trait-extract -- --collection <addr> --list-categories

# A real run, verbose, with a specific cache location:
npm run trait-extract -- --collection <addr> --verbose --cache-dir /data/te-cache

# Resume an interrupted run (same command, no --fresh):
npm run trait-extract -- --collection <addr>

# Force a clean restart, ignoring any existing manifest/checkpoints/scan cache:
npm run trait-extract -- --collection <addr> --fresh

# Machine-readable summary only (pipe-friendly):
npm run --silent trait-extract -- --collection <addr> --json > result.json

# Wipe the shared cache entirely:
npm run trait-extract -- --clear-cache
```

## Errors

Unknown flags get a "did you mean" suggestion when a close match exists
(plain Levenshtein distance against the fixed flag list, threshold 3):

```
Error: Unknown argument "--preest". Did you mean "--preset"?
```
