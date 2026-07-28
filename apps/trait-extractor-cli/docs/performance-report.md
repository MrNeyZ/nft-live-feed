# Performance report (Stage 5.4)

## Status: real-collection validation complete (2026-07-28)

Ran the full validation sequence (fresh run, interrupt+resume, cache
reuse, offline replay, output equality) against two real collections.
Scope per collection was deliberately bounded to one category / a handful
of trait values (not every category) — enough to exercise every code path
meaningfully without materially burning Helius credits, per this repo's
credit-conservation rule. Two genuine runtime bugs were found and fixed
during this exercise (see "Bugs found" below); no extraction-algorithm or
threshold changes were made.

## Collections used

| | Collection A | Collection B |
|---|---|---|
| Name | Taiyo Robotics | Cets on Creck |
| Input given | `HJx4HRAT3RiFq7cy9fSrvP92usAmJ7bJgPccQTyroT2r` (collection address) | `8kQ4bsFYPbd6cycaj5SQBTM9ZMLDeJ1noJag84vYmWjv` (an individual NFT mint) |
| Resolved collection address | same (input was already the collection address) | `LouoPer39a8x9KZ4nWXmeSFetgorr82pEErhU9EmxZW` (resolved via the mint→collection path) |
| Total assets | 2,121 (3 DAS pages) | 6,968 (7 DAS pages) |
| Validation scope | `Background` category, 3 values (`Hoshi`, `Sensu`, `Gojira`) | `Enlightenment` category, all 3 values (`E1`, `E1+E2`, `E2`) |
| Art weight | Light (~50KB/image avg) | Heavy (~1.2MB/image avg) — good stress case for download-time-dominated runs |

## Results

### Collection A (Taiyo Robotics)

| Run | Wall time | Images | Bytes downloaded | Extracted | Unresolved | Peak RSS |
|---|---|---|---|---|---|---|
| 1. Fresh | 18.2s | 47 | 2,396,606 (2.3MB) | 3/3 | 0 | 1,059MB |
| 2. Interrupt (SIGINT @7s, mid-value-2) + resume | 130-exit then 12.0s resume | 31 (only the 2 remaining values) | 1,545,327 | 3/3 | 0 | 825MB |
| 3. Cache reuse (new `--output`, same cache) | 16.2s | 47 (100% cache hit) | 0 | 3/3 | 0 | 1,059MB |
| 4. Offline replay | 15.5s | 47 (100% cache hit) | 0 | 3/3 | 0 | 1,045MB |

Run 1 phase breakdown: `scanAndSetup` 1,151ms (fresh scan, no cache) /
`downloadingAndProcessing` 15,425ms / `archiving` 264ms. Cumulative
effort: `downloads` 5,011ms, `decode` 2,130ms (both legitimately less than
the wall-clock span here — Collection A's light art meant downloads
overlapped less severely).

Interrupt test: SIGINT after 7s landed while value 2/3 (`Hoshi`) was
in-flight. `Gojira` (already complete) stayed checkpointed; the log showed
"Ctrl+C received - finishing the current value and shutting down safely",
then a clean `Cancelled` exit (130). The resumed run correctly reported
"Resuming: 1/3 value(s) already complete" and only re-downloaded the 2
remaining values' images (31, not all 47).

Disk: cache root 4.0MB, one run's output 4.4MB.

### Collection B (Cets on Creck, via mint resolution)

| Run | Wall time | Images | Bytes downloaded | Extracted | Unresolved | Peak RSS |
|---|---|---|---|---|---|---|
| 1. Fresh | 46.7s | 44 | 53,940,467 (53.9MB) | 3/3 | 0 | 1,775MB |
| 2. Interrupt (SIGINT @15s, mid-value-2) + resume | 130-exit then 25.8s resume | 30 (2 remaining values) | 33,084,600 | 3/3 | 0 | 1,485MB |
| 3. Cache reuse | 23.6s | 44 (100% cache hit) | 0 | 3/3 | 0 | 1,926MB |
| 4. Offline replay (via mint — see note) | ~29s | 44 (100% cache hit) | 0 | 3/3 | 0 | 1,539MB |

Run 1 phase breakdown: `scanAndSetup` 9,432ms (real 7-page DAS walk + mint
resolution) / `downloadingAndProcessing` 34,978ms / `archiving` 564ms.
Cumulative effort: `downloads` 77,847ms, `decode` 4,715ms — the
cumulative-downloads figure *exceeding* the wall-clock span is expected
and correct here (6-way concurrent downloads of ~1.2MB images), not a bug
— see "Bugs found" below for the one time this distinction actually broke.

**Offline-replay note**: Collection B's `--collection` input was kept as
the raw mint throughout (never substituted with the resolved address), to
exercise the real, documented offline scope precisely. As predicted in
`known-limitations.md`, offline mode here still performed the one
collection-resolution network call (logged: `Resolving "8kQ4bsF...".. .
(--offline: this one step still requires network - see known
limitations)`) before falling through to 100%-cached scan/image data for
everything else. Collection A's literal-address input, by contrast,
skipped resolution entirely under `--offline` (no "Resolving..." line at
all) — the two collections together exercise both branches of the
documented offline behavior.

Disk: cache root 57MB, one run's output 23MB.

### Output equality (both collections)

`diff -rq` across every run's `traits/` directory (candidate.png, mask,
preview images) reported **zero differences** between fresh, resumed,
cache-reuse, and offline runs — fully byte-identical. Each value's
`evidence.json` differed **only** in `indexBuildTimeMs`/`searchTimeMs`
(wall-clock measurements that legitimately vary run-to-run) — every actual
extraction result (confidence status, pixel counts, consensus stats) was
identical. This mirrors the exact normalization already used in
`cli.test.ts`'s core-vs-adapter equivalence test.

### Warnings / retries

Zero warnings and zero errors logged across all 8 runs (4 per collection).

## Bugs found and fixed during this validation

Both are genuine runtime bugs in Stage 5.4's own new code (not the
extraction algorithm, not thresholds) — fixed, regression-tested, and the
affected validation step rerun to confirm.

### 1. Execution-report timing: cumulative effort miscomputed as a wall-clock phase

Collection A's first fresh-run report showed `downloads.durationMs:
23,197` against a total run duration of `19,871ms` — a downloads "phase"
longer than the entire run, which is impossible. Root cause:
`LocalImageCache.downloadTimeMs` sums per-call time across *concurrent*
downloads (bounded by `TE_MAX_CONCURRENT_DOWNLOADS`), so it routinely
exceeds real elapsed time — the same `user` vs `real` distinction `time(1)`
reports. The original code subtracted this cumulative figure from a
wall-clock span to derive a "processing" duration, which went negative
(clamped to 0), silently hiding real pair-search/diff/consensus time.

**Fix**: `execution-report.ts` now reports two separate, never-mixed
sections — `phases` (wall-clock spans: `scanAndSetup`,
`downloadingAndProcessing`, `archiving`) and `effort` (cumulative,
concurrency-summed: `downloads`, `decode`). See `docs/known-limitations.md`
for the full explanation. Regression tests added in `cli.test.ts`
("execution-report timing" section, 2 checks) — one fires real concurrent
downloads against a slow fixture route and asserts cumulative time
exceeds wall-clock time (reproducing the exact mechanism), the other locks
`buildExecutionReport`'s shape so `downloads`/`decode` can never reappear
inside `phases`. Rerun: Collection A's fresh run, confirmed sane numbers
(`downloadingAndProcessing: 15,425ms` fits within the ~18s total run).

### 2. Checkpoint-on-cancellation: an interrupt could permanently "lose" a value

Collection B's interrupt test (SIGINT while value 2/3, `Enlightenment =
E1+E2`, was in-flight) settled that value `unresolved`
(`no_usable_pairs_after_download_or_dimension_check`) — but the same value
had resolved cleanly (`medium_confidence`) in the uninterrupted fresh run.
Root cause: `trait-extraction-core`'s `processOneValue` breaks its
candidate-pair loop as soon as the abort signal fires (`run-extraction.ts`
line 357, by design, to stop promptly) — correct core behavior, not
touched. But the CLI's `onValueSettled` handler checkpointed *any* settled
result, resolved or unresolved, as permanently complete — so a resume
would never retry a value whose "unresolved" verdict was actually an
artifact of the interrupt landing mid-search, not genuine lack of evidence
in the collection.

**Fix**: `manifest.ts`'s new `shouldCheckpointSettlement(resultKind,
signalAborted)` returns `false` only for the specific combination of
`unresolved` + `signal.aborted` — every other case (resolved, or
unresolved in a normal non-cancelling run) still checkpoints exactly as
before, so genuinely-unresolved values are still never retried forever.
`cli.ts`'s `onValueSettled` now consults this before calling
`saveCheckpoint`/`markTargetCompleted`. Regression tests added
("checkpoint-on-cancellation" section, 3 checks). Rerun: Collection B's
interrupt+resume sequence from scratch — the second interrupt correctly
logged "Not checkpointing Enlightenment = E1+E2: settled unresolved while
cancelling", and the subsequent resume retried it fresh, resolving cleanly
(3/3 extracted, 0 unresolved) — matching the original uninterrupted run
exactly.

### 3. Test hardening (not a CLI bug — a test-only timing flake)

A metadata-cache test asserted `maxAgeMs=0` rejects an entry "written just
now," which raced against clock resolution on a fast filesystem
(observed failing deterministically in this environment). Hardened to
`maxAgeMs=-1`, which is unambiguous regardless of clock granularity.

## Final verification

- `tsc --noEmit`: clean.
- `cli.test.ts`: **46/46 checks pass**, 3 consecutive runs with zero
  flakes after the maxAgeMs fix.
- Zero collateral changes to `trait-extraction-core` or the website
  backend (confirmed via `git status`/`git diff --stat`, scoped entirely
  to `apps/trait-extractor-cli`).
