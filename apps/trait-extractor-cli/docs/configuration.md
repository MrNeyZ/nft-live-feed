# Configuration (Stage 5.4)

Every configurable value has exactly one source of truth, resolved with
this precedence, most to least specific:

```
CLI flag (explicitly passed) > env var > config.json > built-in default
```

"Explicitly passed" matters: a flag that happens to equal the built-in
default (e.g. `--download-concurrency 6`) still counts as explicit and
still beats a config.json/env value — the CLI tracks which flags were
actually typed (`args.ts`'s `explicitFlags`), not just their resolved
values, specifically so this distinction is correct.

## config.json lookup

Only one file is ever read; the first one found wins:

1. `--config <path>` — explicit path. **Hard error if missing** (you
   pointed at it directly).
2. `./config.json` — current working directory (matches this CLI's
   existing `.env`-in-cwd convention).
3. `~/.trait-extractor-cli/config.json` — a per-user default, via
   `os.homedir()` (deliberately not XDG — a single fixed dot-folder name
   behaves identically on Linux/macOS/Windows).
4. None found → defaults only. **config.json is fully optional.**

A malformed config.json at a non-explicit path (2 or 3 above) is treated
as "not found" and falls back silently to the next candidate/defaults —
consistent with the rest of this CLI's "corrupt file → safe fallback,
never crash" philosophy (`manifest.ts`, `metadata-cache.ts`). A malformed
file at an **explicit** `--config` path IS a hard error.

## Schema

```json
{
  "$schemaVersion": 1,
  "job": {
    "preset": "balanced",
    "output": "./output",
    "allowUnsuitable": false,
    "fresh": false,
    "json": false
  },
  "cache": {
    "cacheDir": "~/.trait-extractor-cli/cache",
    "cacheOnly": false,
    "offline": false,
    "scanCacheMaxAgeMs": 86400000,
    "maxImageCacheBytes": 10737418240
  },
  "concurrency": {
    "downloadConcurrency": 6,
    "processingConcurrency": 3,
    "teMaxTotalDownloadBytes": 21474836480,
    "teMaxUniqueImageDownloads": 50000
  },
  "logging": {
    "level": "normal",
    "reportPath": null
  },
  "resume": {
    "heartbeatIntervalMs": 30000
  }
}
```

One-shot command flags (`--dry-run`, `--estimate`, `--list-categories`,
`--list-traits`, `--version`, `--clear-cache`) are **not** config.json
fields — they describe a single invocation's intent, not a durable
default worth persisting.

## Environment variables

Two distinct namespaces exist — don't conflate them:

- **`TRAIT_EXTRACTOR_*`** — this CLI's own config layer (matches the
  `config.json` fields above 1:1): `TRAIT_EXTRACTOR_PRESET`,
  `TRAIT_EXTRACTOR_OUTPUT`, `TRAIT_EXTRACTOR_ALLOW_UNSUITABLE`,
  `TRAIT_EXTRACTOR_FRESH`, `TRAIT_EXTRACTOR_JSON`,
  `TRAIT_EXTRACTOR_CACHE_DIR`, `TRAIT_EXTRACTOR_CACHE_ONLY`,
  `TRAIT_EXTRACTOR_OFFLINE`, `TRAIT_EXTRACTOR_SCAN_CACHE_MAX_AGE_MS`,
  `TRAIT_EXTRACTOR_MAX_IMAGE_CACHE_BYTES`,
  `TRAIT_EXTRACTOR_DOWNLOAD_CONCURRENCY`,
  `TRAIT_EXTRACTOR_PROCESSING_CONCURRENCY`, `TRAIT_EXTRACTOR_LOG_LEVEL`,
  `TRAIT_EXTRACTOR_REPORT_PATH`, `TRAIT_EXTRACTOR_HEARTBEAT_INTERVAL_MS`.
- **`TE_*`** — `trait-extraction-core`'s OWN env vars (`te-limits.ts`),
  read once at that package's first import. This CLI's
  `downloadConcurrency`/`teMaxTotalDownloadBytes`/
  `teMaxUniqueImageDownloads` config values get *translated into*
  `TE_MAX_CONCURRENT_DOWNLOADS`/`TE_MAX_TOTAL_DOWNLOAD_BYTES`/
  `TE_MAX_UNIQUE_IMAGE_DOWNLOADS` by `bootstrap.ts`, but you can also set
  those `TE_*` vars directly yourself if you want — `bootstrap.ts` only
  fills them in when unset, it never overrides a value you already
  exported.

`HELIUS_API_KEY` is separate from all of the above — loaded via `.env` in
the current directory or your shell, same as Stage 5.3.

## Why config resolution happens twice, and why that's safe

The entry point (`bootstrap.ts`) must set several `process.env` vars
**before** `trait-extraction-core` is ever imported (every constant in
`te-limits.ts` is a plain constant read once at that module's first
import — there's no other way to override one afterward). To compute
those values, `bootstrap.ts` resolves the full layered config first.

`cli.ts`'s `main()` needs the same resolved config for everything else.
Calling `resolveConfig` a second time there would seem safe (it's a pure
function of argv/env/cwd) — but `bootstrap.ts` **writes its result back
into `process.env`** right after resolving, so a naive second call would
see its own writes and misreport `source: 'default'` values as
`source: 'env'`. Instead, `bootstrap.ts` caches the full resolution (via
`config.ts`'s `cacheResolution`/`resolveConfigOnce`, a `Symbol.for`-keyed
global) before touching `process.env` at all, and `cli.ts` reads that
cached copy back — so the config-source provenance in `--debug` output
and the execution report is always accurate. (Found and fixed via manual
smoke-testing of the real entry point — not a hypothetical.)
