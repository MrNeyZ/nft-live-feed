/**
 * trait-extractor-cli - entry point wrapper.
 *
 * Raises the two JOB-WIDE download-budget ceilings before
 * `trait-extraction-core` is ever loaded. `TE_MAX_TOTAL_DOWNLOAD_BYTES`
 * (default 500MB) and `TE_MAX_UNIQUE_IMAGE_DOWNLOADS` (default 800) exist
 * in te-limits.ts to bound the WEBSITE's shared, credit-constrained,
 * bounded-preview jobs - they are NOT per-image safety limits (those -
 * width/height/pixel/byte caps, SSRF guarding - stay untouched and apply
 * identically here). The whole point of this CLI is full-collection runs
 * the website deliberately doesn't attempt, so it needs a much larger
 * allowance for the same two constants.
 *
 * Found via a real run: a second, heavier-art collection (>500KB/image
 * average vs the first fixture's <100KB) hit the 500MB default mid-job.
 * The core correctly reported a truncated `status: 'completed'` (with
 * `zipPath: null`, `error: total_size_exceeded`) rather than crashing -
 * but it revealed the CLI was silently inheriting a website-sized budget
 * for a job class the website was never meant to run.
 *
 * te-limits.ts reads these via `envInt(name, fallback)` at module
 * top-level - a plain constant, read ONCE at first import - so they MUST
 * be set before anything imports `trait-extraction-core`, including
 * transitively. A regular `import` of `./cli` at the top of this file
 * would be hoisted by TypeScript's commonjs output ahead of any other
 * statement, defeating the ordering - so `./cli` is loaded via a runtime
 * `require()` instead, after the env vars are set.
 *
 * Respects any value the user already set (e.g. to lower it back down,
 * or raise it further) - only fills in a default when unset.
 */
if (!process.env.TE_MAX_TOTAL_DOWNLOAD_BYTES) process.env.TE_MAX_TOTAL_DOWNLOAD_BYTES = String(20 * 1024 * 1024 * 1024); // 20GB
if (!process.env.TE_MAX_UNIQUE_IMAGE_DOWNLOADS) process.env.TE_MAX_UNIQUE_IMAGE_DOWNLOADS = String(50_000);

require('./cli');
