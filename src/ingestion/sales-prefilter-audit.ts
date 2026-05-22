/**
 * Sales WS instruction-usefulness audit (OBSERVE-ONLY).
 *
 * Stage-1 evidence gathering before any new WS deny-list. For every WS
 * logsNotification on a sales target (me_v2 / mmm / tcomp / tamm) that PASSES
 * the current prefilters and is dispatched into getTransaction, we:
 *
 *   1. extract the stable instruction strings from the notification logs
 *      ("Program log: Instruction: <name>" / "Instruction: <name>") at WS time,
 *   2. record the dispatch keyed by signature,
 *   3. once the parser result is known, classify the outcome
 *      (accepted_sale / parser_drop / null_tx / error) and attribute it back
 *      to every instruction name seen on that tx.
 *
 * Aggregated per (target, instructionName): seen / accepted_sale / parser_drop
 * / null_tx, plus a useful% = accepted_sale / seen. Every 60s we log only the
 * TOP 10 WORST OFFENDERS (high seen, low useful ratio) — never per-tx, never to
 * a database, and with zero new Helius calls.
 *
 * IMPORTANT: this module changes NO ingestion behavior. It only reads logs that
 * are already in hand and counts outcomes the ingest path already computes. No
 * tx is skipped, no coverage is reduced. The deny-list it informs is a separate,
 * later step.
 */

/** Sales targets in scope for the audit. me_cnft and all mint targets are out. */
export const SALES_AUDIT_TARGETS: ReadonlySet<string> = new Set([
  'me_v2', 'mmm', 'tcomp', 'tamm',
]);

export type AuditOutcome = 'accepted_sale' | 'parser_drop' | 'null_tx' | 'error';

interface Counter {
  seen:     number;
  accepted: number; // accepted_sale
  dropped:  number; // parser_drop
  nullTx:   number; // null_tx
  error:    number;
}

function newCounter(): Counter {
  return { seen: 0, accepted: 0, dropped: 0, nullTx: 0, error: 0 };
}

/** key = `${target}|${instructionName}` → cumulative counts since process start. */
const counters = new Map<string, Counter>();

/** sig → { target, instruction names seen at WS time, dispatch ts }. */
interface Pending { target: string; ixs: string[]; ts: number; }
const pending = new Map<string, Pending>();

// Pending entries are cleared on outcome; this TTL only sweeps sigs whose
// outcome never arrives (rare — dedup-skip before the ingest terminal, etc.)
// so the map can't grow unbounded.
const PENDING_TTL_MS = 5 * 60_000;

const LOG_IX_RE = /(?:Program log: )?Instruction: (.+)/;

/** Extract distinct, lowercased Anchor instruction names from WS logs. */
function extractIxNames(logs: unknown): string[] {
  if (!Array.isArray(logs) || logs.length === 0) return [];
  const out = new Set<string>();
  for (const line of logs as string[]) {
    const m = LOG_IX_RE.exec(line ?? '');
    if (m && m[1]) out.add(m[1].trim().toLowerCase());
  }
  return [...out];
}

function counterFor(target: string, ix: string): Counter {
  const key = `${target}|${ix}`;
  let c = counters.get(key);
  if (!c) { c = newCounter(); counters.set(key, c); }
  return c;
}

/**
 * Record a WS dispatch that is about to trigger getTransaction. Call AFTER all
 * current prefilters have passed and immediately before the ingest call. Only
 * sales targets in `SALES_AUDIT_TARGETS` are tracked. No-op for everything else
 * so mint / me_cnft paths are untouched.
 */
export function recordDispatch(sig: string, target: string, logs: unknown): void {
  if (!SALES_AUDIT_TARGETS.has(target)) return;
  const ixs = extractIxNames(logs);
  // Even a tx with no recognizable Instruction line is worth tracking under a
  // synthetic bucket so its getTransaction spend is visible.
  const tracked = ixs.length ? ixs : ['<none>'];
  pending.set(sig, { target, ixs: tracked, ts: Date.now() });
  for (const ix of tracked) counterFor(target, ix).seen++;
}

/**
 * Record the parser outcome for a previously-dispatched sig. No-op if the sig
 * was never dispatched via `recordDispatch` (poller-only fetches, mint targets),
 * which is exactly what scopes the audit to the WS sales path. First call wins —
 * the pending entry is consumed.
 */
export function recordOutcome(sig: string, outcome: AuditOutcome): void {
  const p = pending.get(sig);
  if (!p) return;
  pending.delete(sig);
  for (const ix of p.ixs) {
    const c = counterFor(p.target, ix);
    if      (outcome === 'accepted_sale') c.accepted++;
    else if (outcome === 'parser_drop')   c.dropped++;
    else if (outcome === 'null_tx')        c.nullTx++;
    else                                   c.error++;
  }
}

function usefulPct(c: Counter): number {
  return c.seen > 0 ? (c.accepted / c.seen) * 100 : 0;
}

// Only entries with at least this many observations are eligible to be flagged
// as an offender — keeps single-occurrence noise out of the top-10.
const MIN_SEEN_TO_FLAG = 5;

/**
 * Log the top-10 worst offenders: high `seen`, low useful ratio. Sorted by a
 * waste score (seen weighted by how non-useful it is) so a high-volume zero-sale
 * instruction floats to the top. Cumulative since process start — the window is
 * not reset, so a read after 5-10 min reflects the full observation.
 */
export function logAudit(): void {
  const rows = [...counters.entries()]
    .map(([key, c]) => {
      const [target, ix] = key.split('|');
      return { target, ix, c, useful: usefulPct(c) };
    })
    .filter((r) => r.c.seen >= MIN_SEEN_TO_FLAG)
    // waste score: how many fetches produced no sale. Ties broken by raw seen.
    .sort((a, b) => {
      const wa = a.c.seen * (1 - a.useful / 100);
      const wb = b.c.seen * (1 - b.useful / 100);
      if (wb !== wa) return wb - wa;
      return b.c.seen - a.c.seen;
    })
    .slice(0, 10);

  if (rows.length === 0) return;
  for (const r of rows) {
    console.log(
      `[sales/prefilter-audit] target=${r.target} ix=${r.ix}` +
      ` seen=${r.c.seen} accepted=${r.c.accepted} dropped=${r.c.dropped}` +
      ` nullTx=${r.c.nullTx} err=${r.c.error} useful=${r.useful.toFixed(1)}%`,
    );
  }
}

let auditTimer: NodeJS.Timeout | null = null;

/** Start the 60s aggregated logger + pending-map TTL sweep. Idempotent. */
export function startSalesPrefilterAudit(): void {
  if (auditTimer) return;
  auditTimer = setInterval(() => {
    const now = Date.now();
    for (const [sig, p] of pending) {
      if (now - p.ts > PENDING_TTL_MS) pending.delete(sig);
    }
    logAudit();
  }, 60_000);
  auditTimer.unref();
  console.log('[sales/prefilter-audit] OBSERVE-only audit started (60s cadence)');
}
