/**
 * Per-signature trace logger.
 *
 * Set TRACE_SIG=<prefix_or_full_signature> in the environment to enable.
 * Every pipeline step that handles a matching signature emits a [TRACE] line.
 *
 * The env var is matched as a prefix so you can use just the first 8–16 chars:
 *   TRACE_SIG=3giYVJSXom6D  node dist/index.js
 *
 * Steps in order:
 *   poll:fetched   — sig appeared in getSignaturesForAddress result (valid, non-failed tx)
 *   poll:unseen    — sig passed age filter + seenSigs dedup; will be dispatched
 *   poll:ingest    — target.ingest(sig) queued via pollerLimiter
 *   parse:ok       — raw parser returned result.ok=true
 *   db:inserted    — INSERT succeeded (non-duplicate); row id returned
 *   sse:emitted    — saleEventBus.emitSale() called; event on the wire to clients
 */

const TRACE_PREFIX = (process.env.TRACE_SIG ?? '').trim();

export function trace(sig: string, step: string, detail = ''): void {
  if (!TRACE_PREFIX) return;
  if (!sig.startsWith(TRACE_PREFIX)) return;
  const suffix = detail ? `  ${detail}` : '';
  console.log(`[TRACE:${step}]  sig=${sig.slice(0, 20)}…${suffix}`);
}
