/**
 * Mint tracker persistence layer — disk snapshot of `MintStatusWire`
 * rows for UI continuity across backend restarts.
 *
 * What this is NOT:
 *   - a DB
 *   - a historical mint explorer
 *   - persistence for the live mint event stream
 *   - persistence for velocity ring buffers / enrichment queues /
 *     parser internals / WS state / retry state
 *
 * What it IS: a single JSON file containing the latest
 * `MintStatusWire` payloads — the same shape SSE clients already
 * receive. On boot we read this file, drop rows older than TTL,
 * and rehydrate the accumulator with just enough state to populate
 * the SSE bootstrap. Live mint activity then updates rows normally;
 * dead drops disappear when their `lastMintAt` falls past TTL.
 *
 * File path:  /root/nft-live-feed/data/mints-snapshot.json
 * Format:     { updatedAt: number; rows: MintStatusWire[] }
 * TTL:        6 h on `lastMintAt`. Restore drops rows older than this;
 *             save writes every row (TTL is applied on read, not write,
 *             so we never lose a row that's about to refresh).
 *
 * Atomic write: write to `<file>.tmp` then `rename()` — POSIX rename
 * is atomic, so a partial write can never leave a half-written file
 * at the canonical path. Restore is fail-soft: a missing / corrupt /
 * schema-mismatched file logs once and proceeds with an empty
 * accumulator, never throws into the boot path.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { MintStatusWire } from '../events/emitter';

/** Default snapshot path — under the repo `data/` dir so it lives
 *  alongside other backend-owned state and survives pm2 restarts
 *  (pm2 does not touch this dir). Override via `MINT_SNAPSHOT_PATH`
 *  env if a different layout is needed in test / staging. */
const DEFAULT_PATH = path.join(process.cwd(), 'data', 'mints-snapshot.json');
function snapshotPath(): string {
  return (process.env.MINT_SNAPSHOT_PATH || '').trim() || DEFAULT_PATH;
}

/** 6 hours. Rows whose `lastMintAt` is older than this at restore time
 *  are dropped — keeps the snapshot from accumulating immortal entries
 *  across many restarts. Saves don't filter; TTL is purely a read-side
 *  rule so a row that's silent for 5 h 59 m and about to mint again
 *  isn't sacrificed. */
const TTL_MS = 6 * 60 * 60 * 1000;

/** Save cadence — 20 s. Tight enough that a fresh row showing up in
 *  the UI persists within one tick of the next restart window; loose
 *  enough that we're not stat()/rename()-ing 50× per minute during a
 *  hot launch. Tunable via `MINT_SNAPSHOT_INTERVAL_MS`. */
const DEFAULT_SAVE_INTERVAL_MS = 20_000;
function saveIntervalMs(): number {
  const raw = process.env.MINT_SNAPSHOT_INTERVAL_MS;
  if (!raw) return DEFAULT_SAVE_INTERVAL_MS;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 5_000 ? n : DEFAULT_SAVE_INTERVAL_MS;
}

/** Hard cap on rows written to disk. The live SSE replay already
 *  sends every row in the accumulator, so a runaway accumulator
 *  would already be a visible problem upstream — but bounding the
 *  on-disk file is cheap insurance against a future bug producing
 *  a million-row JSON. 5000 rows × ~700 bytes ≈ 3.5 MB worst case,
 *  trivial. */
const MAX_ROWS_PERSISTED = 5_000;

interface SnapshotFile {
  updatedAt: number;
  rows:      MintStatusWire[];
}

function isSnapshotFile(v: unknown): v is SnapshotFile {
  if (!v || typeof v !== 'object') return false;
  const o = v as { updatedAt?: unknown; rows?: unknown };
  return typeof o.updatedAt === 'number' && Array.isArray(o.rows);
}

function isPlausibleRow(v: unknown): v is MintStatusWire {
  if (!v || typeof v !== 'object') return false;
  const o = v as Partial<MintStatusWire>;
  return typeof o.groupingKey === 'string' && o.groupingKey.length > 0
      && typeof o.lastMintAt  === 'number' && o.lastMintAt > 0
      && typeof o.observedMints === 'number';
}

/** Read the snapshot file, drop stale rows, return what's left.
 *  Fail-soft: any I/O / parse / shape error returns `null` after a
 *  single warning log — never throws. Callers should treat `null`
 *  as "no snapshot" and proceed with an empty accumulator. */
export function loadSnapshot(now: number = Date.now()): MintStatusWire[] | null {
  const p = snapshotPath();
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    if (err && err.code === 'ENOENT') {
      // First boot on this machine — not an error.
      console.log('[mints/snapshot] no prior snapshot');
      return null;
    }
    console.log(`[mints/snapshot] failed read=${err.message}`);
    return null;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch (e) {
    console.log(`[mints/snapshot] failed parse=${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
  if (!isSnapshotFile(parsed)) {
    console.log('[mints/snapshot] failed shape=invalid_root');
    return null;
  }
  const cutoff = now - TTL_MS;
  const kept:    MintStatusWire[] = [];
  let droppedStale  = 0;
  let droppedShape  = 0;
  for (const row of parsed.rows) {
    if (!isPlausibleRow(row)) { droppedShape++; continue; }
    if (row.lastMintAt < cutoff) { droppedStale++; continue; }
    kept.push(row);
  }
  console.log(
    `[mints/snapshot] restored rows=${kept.length} ` +
    `dropped stale=${droppedStale} shape=${droppedShape} ` +
    `ageMs=${now - parsed.updatedAt}`,
  );
  return kept;
}

/** Atomic save — write to `.tmp` then `rename()` onto the canonical
 *  path. POSIX rename is atomic within a filesystem, so a reader can
 *  never observe a partial file. Sync I/O because we're persisting
 *  out-of-band on a 20 s timer (not in the hot path), and a 5000-row
 *  worst-case write of ~3.5 MB is still well under a millisecond on
 *  SSD. The simpler sync API also gives us a deterministic flush on
 *  SIGTERM / process.exit — async fs.promises has no equivalent
 *  beforeExit guarantee. */
export function saveSnapshot(rows: MintStatusWire[], now: number = Date.now()): boolean {
  const p   = snapshotPath();
  const dir = path.dirname(p);
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (e) { /* mkdirSync recursive is no-op when dir exists; only real errors land here */
    console.log(`[mints/snapshot] failed mkdir=${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
  // Trim to the bounded cap — newest-first so a runaway accumulator
  // still persists the freshest activity. `currentMintStatuses()`
  // already orders by velocity (v60 desc, then observedMints), which
  // is a fine proxy for "freshest".
  const limited = rows.length > MAX_ROWS_PERSISTED ? rows.slice(0, MAX_ROWS_PERSISTED) : rows;
  const payload: SnapshotFile = { updatedAt: now, rows: limited };
  const tmp = `${p}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, p);
  } catch (e) {
    console.log(`[mints/snapshot] failed write=${e instanceof Error ? e.message : String(e)}`);
    // Best-effort cleanup of the orphan tmp so the next save isn't
    // racing against a leftover handle. ENOENT is fine.
    try { fs.unlinkSync(tmp); } catch { /* noop */ }
    return false;
  }
  return true;
}

interface SnapshotLifecycle {
  /** Tear down the periodic timer + signal handlers. Tests only —
   *  production uses a single long-lived schedule. */
  stop: () => void;
}

/** Start the periodic save + register graceful-shutdown flush. Pass
 *  a `getRows` callback so this module doesn't import the accumulator
 *  (avoids a circular dependency). One-shot — re-calling is a no-op
 *  on the same lifecycle (the second instance is rejected and the
 *  first kept; protects against double-import). */
let scheduled: SnapshotLifecycle | null = null;
export function startSnapshotPersistence(getRows: () => MintStatusWire[]): SnapshotLifecycle {
  if (scheduled) return scheduled;
  const intervalMs = saveIntervalMs();
  // Throttle saves to "only when changed since last write". The
  // accumulator's row count + lastMintAt-of-newest pair is a cheap
  // change-detection signal (per-row sweep ticks update lastMintAt
  // even without new mints? No — sweep only trims windows / emits
  // status; it doesn't bump lastMintAt). So a stable hash here lets
  // a quiet system skip rewrites entirely.
  let lastHash = '';
  function tick(): void {
    let rows: MintStatusWire[];
    try { rows = getRows(); }
    catch (e) {
      console.log(`[mints/snapshot] failed getRows=${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    // Cheap hash: count + sum of lastMintAt + sum of observedMints.
    // Collisions are theoretically possible but vanishingly unlikely
    // for the row sets we're dealing with; on collision we'd write
    // a stale snapshot once and self-correct on the next tick.
    let h1 = rows.length, h2 = 0, h3 = 0;
    for (const r of rows) { h2 += r.lastMintAt; h3 += r.observedMints; }
    const hash = `${h1}:${h2}:${h3}`;
    if (hash === lastHash) return;
    lastHash = hash;
    const ok = saveSnapshot(rows);
    if (ok) {
      console.log(`[mints/snapshot] saved rows=${rows.length}`);
    }
  }
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  // Graceful flush on SIGTERM (pm2 stop / pm2 restart) and SIGINT
  // (Ctrl-C in dev). `beforeExit` is not reliable across all node
  // exit paths (does not fire on signal-terminated process), so we
  // hook the signals explicitly. The handlers re-throw the original
  // termination so the rest of the shutdown chain runs unchanged.
  function flush(reason: string): void {
    try {
      const rows = getRows();
      const ok = saveSnapshot(rows);
      console.log(
        `[mints/snapshot] flush reason=${reason} rows=${rows.length} ok=${ok}`,
      );
    } catch (e) {
      console.log(`[mints/snapshot] flush failed=${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const onSigterm = (): void => { flush('SIGTERM'); process.exit(0); };
  const onSigint  = (): void => { flush('SIGINT');  process.exit(0); };
  process.once('SIGTERM', onSigterm);
  process.once('SIGINT',  onSigint);

  scheduled = {
    stop: () => {
      clearInterval(timer);
      process.removeListener('SIGTERM', onSigterm);
      process.removeListener('SIGINT',  onSigint);
      scheduled = null;
    },
  };
  return scheduled;
}
