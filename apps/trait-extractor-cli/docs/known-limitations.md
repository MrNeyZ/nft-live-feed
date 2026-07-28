# Known limitations (Stage 5.4)

Every item below is a deliberate, constraint-driven scope decision — Stage
5.4 does not modify `trait-extraction-core`'s algorithm/thresholds or the
website backend files this CLI also imports
(`resolve-input.ts`/`scan-fetch.ts`). Each limitation exists specifically
*because* of that boundary, not from an oversight.

## `--processing-concurrency` does not parallelize the extraction algorithm

`trait-extraction-core`'s `run-extraction.ts` processes trait values
strictly sequentially, and within one value, comparison pairs are also
processed sequentially (only the two images *within* one pair are fetched
concurrently). `TE_MAX_CONCURRENT_PROCESSING` exists in `te-limits.ts` but
is never consumed anywhere in the core — it was already dead in Stage 5.3.

Making it real would mean restructuring the core's sequential loop, which
risks correctness regressions: the category-impact model's learning and
the job-wide search-time-budget accounting both depend on strict
sequential per-value ordering (per `run-extraction.ts`'s own comments).
That's an extraction-algorithm change, out of scope.

Instead, `--processing-concurrency` sizes Node's libuv threadpool
(`UV_THREADPOOL_SIZE`, set by `bootstrap.ts` before any async I/O). This is
genuinely useful, not a placebo: the existing download prefetch pass
already issues up to `TE_MAX_CONCURRENT_DOWNLOADS` concurrent sharp decode
calls, but libuv's default threadpool size (4) queues some of that
already-bounded concurrency instead of running it in parallel. Raising the
threadpool size removes that artificial queueing without adding any new
concurrency beyond what `TE_MAX_CONCURRENT_DOWNLOADS` already bounds — no
memory increase, no algorithm change.

## Resume stays at per-value granularity

The spec asked about resuming "completed comparisons" (finer than one
whole trait value). The only externally-observable resumability hook is
`onValueSettled`, fired once per whole target — going finer requires a new
hook inside `processOneValue` itself, i.e. editing
`trait-extraction-core`.

The bounded cost of not having it: a crash mid-value loses at most a few
seconds of in-memory search/diff/consensus work
(`TE_MAX_SEARCH_MS_PER_VALUE` ≈ 4s), and any images that value already
fetched remain safely in the (now-shared) image cache — a resumed retry
re-downloads nothing, it only redoes cheap in-memory math.

What Stage 5.4 adds instead: a manifest `phase` field + heartbeat, and —
the practically-equivalent win for the spec's own example ("a crash
mid-scan re-scans the whole collection from scratch") — the metadata scan
cache means a **completed** scan is never re-walked on any subsequent run,
regardless of where a later crash happens.

## Mid-scan crash still re-walks the whole collection

`walkFullCollection` (backend, shared with the website, not modified) has
no page-cursor persistence. A crash *during* an in-progress scan has
nothing to resume from — the next run re-walks from page 1. Only a scan
that reaches `outcome: 'completed'` gets cached. True mid-scan resume would
require adding cursor persistence to that shared backend file, out of
scope.

## `--offline` requires every input to have been resolved online at least once

`resolveInputToCollectionAddress` (backend, shared with the website, not
modified) makes a network call for **every** input shape, including
address-shaped input — it checks whether the given address is actually an
individual NFT mint rather than the collection itself
(`resolveMintToCollectionAddress`).

**Closed**: `resolution-cache.ts` persists the full resolution result
(`collectionAddress` + `inputKind` + `extraWarnings`) keyed by the raw
`--collection` input string — a mint, a marketplace URL, a slug, or a
literal address, uniformly, no special-casing by shape. Once any online
run has resolved a given raw input once, every later run using that
**exact same raw input string** — online or offline — skips the live
resolution call entirely, whatever kind of input it is.

**What remains true**: the very *first* time a given raw input is seen,
resolving it still requires one live network call — there is no way
around this (you cannot learn what a never-before-seen mint's collection
is without asking somewhere), and `--offline` correctly refuses to attempt
it, failing clearly (`offline_missing_resolution`) rather than silently
making the call. A *different* raw input string for the same underlying
collection (e.g. a different mint from the same collection, or a
marketplace URL vs. the bare address) is, by design, a cache miss too —
the cache key is the literal input text, not the resolved identity, so
offline replay only works for an input string that has itself been seen
online before.

## Timing buckets: "downloadingAndProcessing" is one combined wall-clock number

Downloads, pair-search, diff-generation, and consensus-scoring all happen
inside one un-hooked core function call (`processOneValue`), sequentially
per value. Splitting them into separate WALL-CLOCK phases needs a
core-internal timing hook — out of scope. The execution report's `phases`
section reports `downloadingAndProcessing` as one combined span (from the
first `'downloading'` progress tick to the first `'archiving'` tick),
rather than fabricating boundaries that aren't actually observable from
outside the core.

`effort.downloads`/`effort.decode` (separate from `phases` entirely) report
**cumulative** time summed across every download/decode call this run —
useful as a relative measure of I/O-vs-everything-else effort, but NOT a
wall-clock span: since downloads run with bounded concurrency
(`TE_MAX_CONCURRENT_DOWNLOADS`, default 6), several overlapping ~3s
downloads can sum to well over the run's total real duration, the same
`user` vs `real` distinction `time(1)` reports. An earlier version of this
report subtracted `effort.downloads`/`effort.decode` from the wall-clock
span to derive a "processing" number — found during Stage 5.4's own
real-collection validation to go negative (clamped to 0, silently hiding
real processing time) whenever cumulative download effort exceeded the
span's wall-clock length, which is common under concurrency. Fixed by
keeping the two concepts (wall-clock `phases` vs. cumulative `effort`)
strictly separate and never arithmetically mixing them.

## No automatic migration of Stage 5.3 per-output caches

Stage 5.3's `--output/cache/` directories are not automatically migrated
into Stage 5.4's shared global cache root
(`~/.trait-extractor-cli/cache/`). Upgrading re-downloads images once into
the new location — every existing corruption/permanent-failure safeguard
in `local-image-cache.ts` still applies to that re-fetch, so this is a
one-time time cost, not a correctness risk. An automatic read-through
migration path is buildable later if it turns out to matter in practice;
it was left out to avoid permanently maintaining two on-disk cache-location
code paths for a one-time transition cost.

## Full in-memory asset list

`assets: NormalizedAsset[]` is held fully in memory for the whole job, in
both this CLI and inside `trait-extraction-core` itself — an existing
core-level design, not something Stage 5.4 changes. Sizing (a few hundred
bytes per asset, no image bytes held alongside it) makes even a
50,000–100,000-asset collection a non-scaling-risk memory cost; the
execution report's memory samples exist to verify this empirically during
real-collection validation, not to add new streaming machinery pre-emptively.
