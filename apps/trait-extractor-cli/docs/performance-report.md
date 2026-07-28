# Performance report (Stage 5.4)

## Status: skeleton — real-collection validation (spec item 8) not yet run

Per this repo's credit-conservation rule ("Helius/RPC credits are a
constrained resource"), running the full validation sequence against real
collections was deliberately **not** bundled into implementation — it
requires actual collection addresses to be supplied and an explicit
go-ahead before it runs (see `PLAN.md`/conversation — the original spec's
"Collection A"/"Collection B" were placeholders, not real inputs).

This document will be filled in with real numbers once that step runs.
The sections below describe exactly what will be measured and how, plus
what's already been verified via zero-network smoke-testing during
implementation.

## What will be measured (once real collections are supplied)

For 1–2 small-to-medium real collections (deliberately not the largest
available, to bound credit cost):

1. **Fresh run** — full timing breakdown from `execution-report.json`:
   `scanAndSetup`, `downloads`, `decode`, `processing` (combined bucket —
   see `known-limitations.md`), `archiving`.
2. **Interrupt + resume** — SIGINT mid-run, then re-run the same command;
   confirm no re-download of already-cached images, manifest `phase`/
   `completedTargetKeys` correctly skip finished work.
3. **Cross-collection/cross-output cache reuse** — a second run from a
   *different* `--output` dir, same shared global cache dir; measure the
   resulting `imagesCacheHitRate` in the execution report.
4. **Offline replay** — `--offline` using only what's cached from run 1;
   confirm it succeeds without new network calls (or fails with the
   precise "missing resource" message documented in
   `known-limitations.md`).
5. **Output equality** — diff the fresh run's and the resumed run's output
   ZIPs/evidence for byte/structural equality (determinism check, mirrors
   the existing `cli.test.ts` core-vs-adapter equivalence test's
   philosophy).

Recorded per run: wall-clock duration, cache-hit %, peak RSS (from
`execution-report.json`'s `memory.peakRssBytes`), disk usage under
`--output` and the shared cache root.

## Already verified (zero-network, during implementation)

These don't require real collection data and were run against the CLI's
real entry point (`bootstrap.ts` → `cli.ts`) during Stage 5.4 development:

- `--version`, `--help`, `--clear-cache`, unknown-flag "did you mean"
  suggestions, missing-`--collection` validation — all correct.
- `config.json` loading + CLI/env/file precedence, verified via `--debug`
  trace against a real (non-mocked) `config.json` file and env vars.
- `--offline` against an uncached, invalid-shaped input: falls through to
  local-only `parseCollectionAnalyzerInput` rejection with **zero**
  network calls (confirmed instantaneous failure, not a timeout).
- Full Stage 5.3 + Stage 5.4 offline test matrix (`cli.test.ts`, 39
  checks): config precedence, metadata scan cache round-trip/staleness/
  corruption, cross-collection global image-cache reuse, `hasCachedEntry`/
  `cacheHitRate` correctness, manifest phase/heartbeat + version-bump
  invalidation, logger level gating, `--estimate` accuracy against a
  synthetic fixture (0% → 100% predicted hit rate before/after caching).

A real bug was found and fixed during this smoke-testing (not caught by
the offline unit tests, since it only manifests across the
`bootstrap.ts` → `cli.ts` process handoff): `bootstrap.ts` writes resolved
config values into `process.env` for `trait-extraction-core`'s benefit,
which caused a second, naive `resolveConfig` call in `cli.ts` to
misattribute those as `source: 'env'` instead of their real source. Fixed
via a `Symbol.for`-keyed resolution cache (`config.ts`'s
`cacheResolution`/`resolveConfigOnce`) so the config-source provenance in
`--debug` output and the execution report is accurate. See
`docs/configuration.md`'s "Why config resolution happens twice" section.
