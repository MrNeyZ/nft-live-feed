/**
 * Rare Feed rarity providers — shared plumbing.
 *
 * One bounded-concurrency gate + a per-source 429 cooldown shared by every
 * provider, so the rarity layer as a whole stays polite regardless of which
 * source(s) are active. No Helius / RPC here — providers only ever hit their
 * own public HTTP APIs.
 */

export type RaritySource = 'tensor' | 'howrare' | 'magiceden';

/** A successful rank resolution from one provider. `null` from a provider's
 *  `resolve()` means "I have no rank for this mint" — the chain moves on. */
export interface RarityFetch {
  rank:             number;
  supply:           number;
  collectionSymbol: string | null;
  traits:           unknown | null;
  raw:              unknown | null;
  source:           RaritySource;
}

export interface RarityProvider {
  readonly name: RaritySource;
  /** Cheap, synchronous: is this provider usable in the current env? */
  enabled(): boolean;
  /** Resolve rank+supply for a mint, or null when this provider can't.
   *  MUST never throw — return null on any failure so the chain continues. */
  resolve(mint: string, slug: string | null): Promise<RarityFetch | null>;
}

function envInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Shared HTTP concurrency across ALL providers. Clamped to [1,4]. */
export const CONCURRENCY = Math.min(4, Math.max(1, envInt('RARE_FEED_RARITY_CONCURRENCY', 3)));

let inFlight = 0;
const waiters: Array<() => void> = [];
export function acquire(): Promise<void> {
  if (inFlight < CONCURRENCY) { inFlight++; return Promise.resolve(); }
  return new Promise<void>((res) => waiters.push(() => { inFlight++; res(); }));
}
export function release(): void {
  inFlight--;
  const next = waiters.shift();
  if (next) next();
}

// Per-source 429 cooldown — a source that rate-limits us is skipped until the
// window passes, so we don't keep hammering it.
const cooldownUntil = new Map<string, number>();
export function inCooldown(label: string): boolean {
  return Date.now() < (cooldownUntil.get(label) ?? 0);
}
export function setCooldown(label: string, ms: number): void {
  cooldownUntil.set(label, Date.now() + ms);
}

export interface GetJsonOpts {
  label:     string;          // cooldown bucket + log tag, e.g. 'magiceden'
  timeoutMs: number;
  headers?:  Record<string, string>;
  cooldownMs?: number;        // applied on 429 (default 60s)
}

/**
 * Concurrency-gated GET → JSON. Returns null on cooldown, 429, non-2xx,
 * timeout, or parse error (and sets the source cooldown on 429). Never throws.
 */
export async function getJson<T = unknown>(url: string, opts: GetJsonOpts): Promise<T | null> {
  if (inCooldown(opts.label)) return null;
  await acquire();
  try {
    const res = await fetch(url, {
      headers: opts.headers,
      signal:  AbortSignal.timeout(opts.timeoutMs),
    });
    if (res.status === 429) {
      setCooldown(opts.label, opts.cooldownMs ?? 60_000);
      console.warn(`[rare/rarity] ${opts.label} 429 — cooling down`);
      return null;
    }
    if (!res.ok) return null;
    return await res.json() as T;
  } catch {
    return null;
  } finally {
    release();
  }
}

export function firstPositiveInt(obj: Record<string, unknown>, keys: readonly string[]): number | null {
  for (const k of keys) {
    const v = obj[k];
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return null;
}
