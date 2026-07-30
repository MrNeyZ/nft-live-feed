/**
 * Bounded mint gap-healer / reconciliation.
 *
 * The WS listener + mpl_core cursor-poll can drop INDIVIDUAL log notifications
 * during burst minting, leaving a successful mint absent from `mint_events`
 * even though the parser would accept it (observed: LaunchMyNFT Core mints
 * missed inside an actively-captured window). This is an independent second
 * source for those launchpad mints: scan recent LaunchMyNFT signatures,
 * anti-join against `mint_events`, and re-dispatch the misses through the
 * EXISTING `ingestMintRaw` parser path — no parser/filter changes, no bypass.
 *
 * Safety:
 *   • bounded — recent window (≤60 min) + per-pass signature cap;
 *   • idempotent — anti-join + the parser's own `ON CONFLICT DO NOTHING`;
 *   • single-flight — overlapping passes are skipped;
 *   • cheap — 1 `getSignaturesForAddress` + 1 `getTransaction` per MISSING sig
 *     (steady state ≈ 0 missing → ~1 RPC call/pass).
 *
 * Metaplex Core itself is NOT reconciled here — it's already cursor-polled by
 * the listener; this targets the launchpad program that fed the observed gap.
 */
import { getPool } from '../../db/client';
import { ingestMintRaw } from './index';

/** LaunchMyNFT program (Core launchpad) — the source of the observed misses. */
const LAUNCHMYNFT_PROGRAM = 'F9SixdqdmEBP5kprp2gZPZNeMmfHJRCTMFjN22dx3akf';

/** Two known-missed signatures (hours old, outside any live window) — repaired
 *  once on boot via the same parser path. NOT a broad historical backfill. */
const REPAIR_SIGS: readonly string[] = [
  '3MTp98A9UWohCjerKS8ss2L1oPRuEgE5FdFqovbzBPfoXp5vZvoqd3onGeo3irvfrPBJ6bpH5AuoJ4pX13pzaJcV',
  '22fsJv4ePWLMD4sX8XkhZu5qJqvWTZmvH5QHm1HuDcKfgAffKeR63o2EE4F6JiaMxTzjwEjupjfwXbCk725pkwgm',
];

function envInt(name: string, fallback: number): number {
  const raw = parseInt((process.env[name] ?? '').trim(), 10);
  return Number.isFinite(raw) ? raw : fallback;
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

const WINDOW_MIN  = clamp(envInt('MINT_RECONCILE_WINDOW_MINUTES', 15), 0, 60);
const SIG_LIMIT   = clamp(envInt('MINT_RECONCILE_SIG_LIMIT', 200), 1, 1000);
const INTERVAL_MS = Math.max(60_000, envInt('MINT_RECONCILE_INTERVAL_MS', 5 * 60_000));
/** Pause after dispatch so the async bus→event-store insert lands before we
 *  measure accepted/rejected. */
const SETTLE_MS = 3_000;

function rpcHttpUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  if (!key) throw new Error('HELIUS_API_KEY not set');
  return `https://beta.helius-rpc.com/?api-key=${key}`;
}

interface SigRow { signature: string; blockTime: number | null; err: unknown }

async function recentSignatures(program: string): Promise<SigRow[]> {
  const res = await fetch(rpcHttpUrl(), {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'getSignaturesForAddress',
      params: [program, { limit: SIG_LIMIT, commitment: 'confirmed' }],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return [];
  const json = await res.json() as { result?: SigRow[] };
  return Array.isArray(json.result) ? json.result : [];
}

// In-memory record of signatures this reconciler has already dispatched (mint
// OR non-mint). Without it, non-mint LaunchMyNFT sigs (collection-create /
// config) — which never land in mint_events — would be re-fetched every pass,
// wasting Helius credits. Bounded FIFO.
const processedSigs = new Set<string>();
const PROCESSED_MAX = 10_000;
function markProcessed(sig: string): void {
  processedSigs.add(sig);
  if (processedSigs.size > PROCESSED_MAX) {
    let drop = PROCESSED_MAX / 10;
    for (const s of processedSigs) { processedSigs.delete(s); if (--drop <= 0) break; }
  }
}

/** Anti-join a set of signatures against mint_events; return those NOT stored. */
async function notYetStored(sigs: string[]): Promise<string[]> {
  if (sigs.length === 0) return [];
  const { rows } = await getPool().query<{ signature: string }>(
    'SELECT signature FROM mint_events WHERE signature = ANY($1)', [sigs],
  );
  const present = new Set(rows.map(r => r.signature));
  return sigs.filter(s => !present.has(s));
}

/** Dispatch missing sigs through the existing parser, then report acceptance.
 *  `scanned` is the candidate count (for the log line). */
async function dispatchMissing(candidates: string[], scanned: number, label: string): Promise<void> {
  // Anti-join mint_events, then drop anything already dispatched this process
  // (incl. previously-rejected non-mints) so we never re-fetch the same sig.
  const missing = (await notYetStored(candidates)).filter(s => !processedSigs.has(s));
  for (const sig of missing) {
    try { await ingestMintRaw(sig); } catch { /* parser is fail-soft; never throws fatally */ }
    markProcessed(sig);
  }
  let accepted = 0;
  if (missing.length > 0) {
    await new Promise(r => setTimeout(r, SETTLE_MS));
    const stillMissing = await notYetStored(missing);
    accepted = missing.length - stillMissing.length;   // now present → parser accepted + stored
  }
  console.log(
    `[mints/reconcile] program=${label} window=${WINDOW_MIN}m scanned=${scanned} ` +
    `missing=${missing.length} dispatched=${missing.length} accepted=${accepted} rejected=${missing.length - accepted}`,
  );
}

let running = false;
async function reconcileWindow(): Promise<void> {
  if (WINDOW_MIN <= 0 || running) return;   // single-flight
  running = true;
  try {
    const rows = await recentSignatures(LAUNCHMYNFT_PROGRAM);
    const cutoff = Date.now() / 1000 - WINDOW_MIN * 60;
    const candidates = rows
      .filter(r => !r.err && (r.blockTime == null || r.blockTime >= cutoff))
      .map(r => r.signature)
      .filter(Boolean);
    await dispatchMissing(candidates, candidates.length, 'launchmynft');
  } catch (err) {
    console.warn(`[mints/reconcile] error: ${(err as Error).message}`);
  } finally {
    running = false;
  }
}

/** One-time targeted repair of the two known-missed signatures (idempotent). */
async function repairKnownSigs(): Promise<void> {
  try {
    await dispatchMissing([...REPAIR_SIGS], REPAIR_SIGS.length, 'launchmynft-repair');
  } catch (err) {
    console.warn(`[mints/reconcile] repair error: ${(err as Error).message}`);
  }
}

let started = false;
/** Boot: one targeted repair + an immediate window pass, then periodic passes.
 *  Idempotent; no-op when WINDOW_MIN=0. */
export function startMintReconcile(): void {
  if (started) return;
  started = true;
  if (WINDOW_MIN <= 0) { console.log('[mints/reconcile] disabled (window=0)'); return; }
  console.log(`[mints/reconcile] attached window=${WINDOW_MIN}m limit=${SIG_LIMIT} interval=${Math.round(INTERVAL_MS / 1000)}s`);
  void repairKnownSigs();
  void reconcileWindow();
  const timer = setInterval(() => void reconcileWindow(), INTERVAL_MS);
  timer.unref?.();
}
