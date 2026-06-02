/**
 * Durable recent-counted-mint ledger.
 *
 * `countedMints` in accumulator.ts is the per-(signature, mintAddress) dedupe
 * guard that stops the same real mint being counted twice. It lives only in
 * memory, so a pm2 restart empties it while `hydrateAccumulatorFromSnapshot`
 * restores the (already-counted) observedMints totals — and the reconcile
 * gap-healer can then re-count sampled-out mints inside its ~15-minute lookback
 * window, re-inflating the counters.
 *
 * This module persists the dedupe keys to disk so they survive a restart:
 *   • boot: `loadCountedLedger()` reads the file, drops TTL-expired entries,
 *     and returns the surviving keys — index.ts hydrates `countedMints` from
 *     them BEFORE the listener / reconcile start.
 *   • runtime: `appendCountedLedger(key, groupingKey?)` records a newly-counted
 *     mint and debounce-flushes to disk (never synchronous per-mint).
 *
 * Fail-soft everywhere: a missing / corrupt / unwritable file degrades to the
 * prior in-memory-only behaviour and never throws into the hot path.
 *
 * File: data/mints-counted-ledger.json (gitignored; pm2 does not touch data/).
 * Mirrors the snapshot module's path / TTL / debounce conventions.
 */
import { promises as fsp, readFileSync, writeFileSync, renameSync, mkdirSync } from 'fs';
import * as path from 'path';

interface LedgerEntry {
  /** `${signature}:${mintAddress}` — same key the accumulator dedupes on. */
  key: string;
  /** Epoch ms when first counted; drives TTL eviction. */
  ts: number;
  /** Grouping key for debugging (optional). */
  gk?: string;
}

const DEFAULT_PATH = path.join(process.cwd(), 'data', 'mints-counted-ledger.json');
function ledgerPath(): string {
  return (process.env.MINT_COUNTED_LEDGER_PATH || '').trim() || DEFAULT_PATH;
}

/** 6 hours — comfortably covers the reconcile lookback window (~15 min) plus
 *  any restart gap, while keeping the file bounded across long uptimes. */
const TTL_MS = 6 * 60 * 60 * 1000;
/** Hard cap, mirrors COUNTED_MINTS_MAX in accumulator.ts. */
const CAP = 100_000;
/** Coalesce bursts of new mints into one disk write. */
const FLUSH_DEBOUNCE_MS = 5_000;

/** In-memory mirror of the on-disk ledger. Insertion-ordered so FIFO
 *  eviction at the cap drops the oldest first (Maps preserve insert order). */
let entries = new Map<string, LedgerEntry>();
let dirty = false;
let flushTimer: NodeJS.Timeout | null = null;

/**
 * Synchronously read the ledger at boot, drop TTL-expired keys, and return the
 * survivors. Mirrors loadSnapshot()'s sync style so it slots into the existing
 * boot sequence. Never throws — a missing / corrupt file yields [].
 */
export function loadCountedLedger(): string[] {
  const now = Date.now();
  try {
    const raw = readFileSync(ledgerPath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const arr: unknown[] = Array.isArray(parsed)
      ? parsed
      : (Array.isArray((parsed as { entries?: unknown[] })?.entries)
          ? (parsed as { entries: unknown[] }).entries
          : []);
    entries = new Map();
    for (const e of arr) {
      const le = e as LedgerEntry;
      if (!le || typeof le.key !== 'string' || typeof le.ts !== 'number') continue;
      if (now - le.ts > TTL_MS) continue;
      entries.set(le.key, le);
    }
    return [...entries.keys()];
  } catch {
    // Missing / corrupt / unreadable — degrade to in-memory-only dedupe.
    entries = new Map();
    return [];
  }
}

/**
 * Record a newly-counted mint and schedule a debounced flush. No-op if the key
 * is already present (idempotent). Never writes synchronously.
 */
export function appendCountedLedger(key: string, groupingKey?: string): void {
  if (entries.has(key)) return;
  entries.set(key, { key, ts: Date.now(), gk: groupingKey });
  if (entries.size > CAP) {
    const overflow = entries.size - CAP;
    const it = entries.keys();
    for (let i = 0; i < overflow; i++) {
      const r = it.next();
      if (r.done) break;
      entries.delete(r.value);
    }
  }
  dirty = true;
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => { flushTimer = null; void flush(); }, FLUSH_DEBOUNCE_MS);
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

/** TTL-pruned JSON payload + the surviving entry count. Shared by the async
 *  (debounced) flush and the synchronous shutdown flush. */
function serialize(): { json: string; count: number } {
  const now = Date.now();
  const arr = [...entries.values()].filter(e => now - e.ts <= TTL_MS);
  return { json: JSON.stringify(arr), count: arr.length };
}

/** Atomic write via temp-file rename. Prunes TTL-expired entries on write so
 *  the file stays bounded. Re-marks dirty on failure to retry next tick. */
async function flush(): Promise<void> {
  if (!dirty) return;
  dirty = false;
  const p = ledgerPath();
  const tmp = `${p}.tmp`;
  try {
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(tmp, serialize().json, 'utf8');
    await fsp.rename(tmp, p);
  } catch (err) {
    dirty = true;
    if (flushErrCount++ % 25 === 0) {
      console.warn(`[mints/ledger] flush failed (count=${flushErrCount}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

let flushErrCount = 0;

/**
 * Synchronous flush for the graceful-shutdown path (SIGTERM / SIGINT / exit).
 * Sync I/O is the only kind safe inside a `process.on('exit')` handler and is
 * deterministic on signal (same rationale as the snapshot module). Cancels any
 * pending debounce timer, writes pending entries atomically, and is idempotent
 * — when nothing is pending (`dirty === false`) it's a no-op, so it's safe to
 * call from several handlers. Fail-soft: warns, never throws.
 */
export function flushCountedLedgerNow(reason = 'shutdown'): void {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (!dirty) return;            // nothing pending — debounced flush already persisted
  dirty = false;
  const p = ledgerPath();
  const tmp = `${p}.tmp`;
  try {
    const { json, count } = serialize();
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(tmp, json, 'utf8');
    renameSync(tmp, p);
    console.log(`[mints/ledger] flushed reason=${reason} entries=${count}`);
  } catch (err) {
    dirty = true;
    console.warn(`[mints/ledger] shutdown flush failed reason=${reason}: ${err instanceof Error ? err.message : String(err)}`);
  }
}
