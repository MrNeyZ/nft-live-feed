#!/usr/bin/env node
/**
 * trait-extractor-cli - entry point wrapper.
 *
 * Resolves the layered config (Stage 5.4 section 1) FIRST, then seeds two
 * kinds of environment state before `trait-extraction-core` is ever
 * loaded - both must happen before that first import/any async I/O, for
 * two different reasons:
 *
 * 1. `UV_THREADPOOL_SIZE` (Node/libuv's own threadpool, sized from
 *    `config.processingConcurrency`) must be set before the FIRST
 *    async I/O call in the whole process - libuv latches its threadpool
 *    size at that point, even earlier than the te-limits.ts concern below.
 *    This is what makes `--processing-concurrency` real (see
 *    docs/known-limitations for why it can't parallelize the extraction
 *    algorithm's own sequential loop instead): the existing download
 *    prefetch pass already issues up to `TE_MAX_CONCURRENT_DOWNLOADS`
 *    concurrent sharp decode calls, but libuv's default threadpool size
 *    (4) queues some of that already-bounded concurrency instead of
 *    running it in parallel - raising the threadpool size removes that
 *    artificial queueing without adding any new concurrency beyond what
 *    TE_MAX_CONCURRENT_DOWNLOADS already bounds.
 *
 * 2. `TE_MAX_TOTAL_DOWNLOAD_BYTES` / `TE_MAX_UNIQUE_IMAGE_DOWNLOADS` /
 *    `TE_MAX_CONCURRENT_DOWNLOADS` are `te-limits.ts` constants, each a
 *    plain `envInt(name, fallback)` read ONCE at that module's first
 *    import - there is no other seam to override them afterward. The
 *    first two exist to raise the WEBSITE's shared, credit-constrained,
 *    bounded-preview-job budget for this CLI's full-collection use case
 *    (found via a real run: a heavy-art collection hit the website's
 *    500MB default mid-job). The third is Stage 5.4's new seam that
 *    finally wires `--download-concurrency` through to something real
 *    (Stage 5.3 parsed the flag but never consumed it downstream).
 *
 * `config.ts`'s `resolveConfig` is safe to call here because `args.ts`
 * only has a TYPE-ONLY import from `trait-extraction-core` - erased
 * entirely by `ts-node --transpile-only` (how this CLI always runs),
 * never producing a runtime `require`. A regular top-level `import` of
 * `./cli` here would be hoisted by TypeScript's commonjs output ahead of
 * every statement below, defeating the ordering - so `./cli` is loaded via
 * a runtime `require()` instead, after every env var is set.
 *
 * Respects any value already present in `process.env` (e.g. a user
 * exporting it directly in their shell) - config resolution's own env-var
 * layer already accounts for that; this block only ever WRITES the
 * final resolved value, it doesn't second-guess resolveConfig's own
 * precedence.
 */
import { cacheResolution, resolveConfig } from './config';

const resolution = resolveConfig(process.argv.slice(2), process.env, process.cwd());
const { config } = resolution;
// Cache the FULL resolution (accurate config+sources) before writing
// anything into process.env below - cli.ts reads this cached copy instead
// of re-resolving, which would otherwise misattribute the env writes
// below as `source: 'env'` rather than their real source. See config.ts's
// header comment for the full story (found via manual smoke-testing).
cacheResolution(resolution);

if (!process.env.UV_THREADPOOL_SIZE) {
  process.env.UV_THREADPOOL_SIZE = String(Math.max(4, config.processingConcurrency));
}
if (!process.env.TE_MAX_TOTAL_DOWNLOAD_BYTES) process.env.TE_MAX_TOTAL_DOWNLOAD_BYTES = String(config.teMaxTotalDownloadBytes);
if (!process.env.TE_MAX_UNIQUE_IMAGE_DOWNLOADS) process.env.TE_MAX_UNIQUE_IMAGE_DOWNLOADS = String(config.teMaxUniqueImageDownloads);
if (!process.env.TE_MAX_CONCURRENT_DOWNLOADS) process.env.TE_MAX_CONCURRENT_DOWNLOADS = String(config.downloadConcurrency);

require('./cli');
