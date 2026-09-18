/**
 * Header market stats: current SOL price (USD) + current Solana TPS.
 *
 * Single cached endpoint so the frontend TopNav doesn't hammer public APIs
 * when many tabs are open. A server-side timer refetches SOL/USD every
 * SOL_TTL_MS (10s) and TPS (Helius, metered) every TPS_TTL_MS (60s),
 * independent of client traffic; the endpoint just serves the cache. On failure, the last-known
 * value is served (with the stale `asOf`) rather than forcing the UI to a
 * placeholder; stat endpoints should be resilient.
 *
 * Sources:
 *   - SOL/USD : Coinbase public ticker (no key); Jupiter Lite price as fallback.
 *   - TPS     : Solana RPC `getRecentPerformanceSamples` via Helius; TPS is
 *               `numTransactions / samplePeriodSecs` on the newest sample.
 */

import { Router, Request, Response } from 'express';

interface HeaderStats {
  tps:    number | null;
  solUsd: number | null;
  asOf:   number;          // epoch ms when this snapshot was fetched
}

const SOL_TTL_MS         = 10_000;
const TPS_TTL_MS         = 60_000;
const FETCH_TIMEOUT_MS   = 6_000;

let cached: HeaderStats = { tps: null, solUsd: null, asOf: 0 };
let tpsAsOf = 0;
let refreshing:  Promise<void> | null = null;

async function fetchSolUsdCoinbase(): Promise<number | null> {
  try {
    const res = await fetch('https://api.coinbase.com/v2/prices/SOL-USD/spot',
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const json = await res.json() as { data?: { amount?: string } };
    const amt = Number(json.data?.amount);
    return Number.isFinite(amt) && amt > 0 ? amt : null;
  } catch { return null; }
}

// Fallback when Coinbase fails (same no-key Jupiter Lite endpoint used by
// tools-opensea-arb / wallet-quick-balance).
async function fetchSolUsdJupiter(): Promise<number | null> {
  const SOL_MINT = 'So11111111111111111111111111111111111111112';
  try {
    const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${SOL_MINT}`,
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const json = await res.json() as Record<string, { usdPrice?: number }>;
    const amt = Number(json[SOL_MINT]?.usdPrice);
    return Number.isFinite(amt) && amt > 0 ? amt : null;
  } catch { return null; }
}

async function fetchTps(): Promise<number | null> {
  const key = process.env.HELIUS_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`https://beta.helius-rpc.com/?api-key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 'header-tps',
        method: 'getRecentPerformanceSamples',
        params: [1],
      }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = await res.json() as {
      result?: Array<{ numTransactions?: number; samplePeriodSecs?: number }>;
    };
    const sample = json.result?.[0];
    if (!sample) return null;
    const n = sample.numTransactions ?? 0;
    const s = sample.samplePeriodSecs ?? 0;
    if (!(s > 0)) return null;
    return Math.round(n / s);
  } catch { return null; }
}

async function refresh(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const tpsDue = Date.now() - tpsAsOf >= TPS_TTL_MS;
    const [solUsd, tps] = await Promise.all([
      fetchSolUsdCoinbase().then(v => v ?? fetchSolUsdJupiter()),
      tpsDue ? fetchTps() : Promise.resolve(null),
    ]);
    if (tpsDue) tpsAsOf = Date.now();
    cached = {
      // Keep last-known value on transient failure — pill should never go
      // from a real number back to null just because one fetch dropped.
      tps:    tps    ?? cached.tps,
      solUsd: solUsd ?? cached.solUsd,
      // asOf = last SUCCESSFUL SOL fetch, so a dead upstream shows up as a
      // stale timestamp instead of a stale price wearing a fresh one.
      asOf:   solUsd != null ? Date.now() : cached.asOf,
    };
  })().finally(() => { refreshing = null; });
  return refreshing;
}

/** Last-known SOL/USD (Coinbase spot), or null before the first successful
 *  fetch. Read-only accessor for other server modules that need the same
 *  trusted price this file already fetches for the TopNav header pill —
 *  avoids standing up a second independent SOL/USD caller. */
export function getSolUsd(): number | null {
  return cached.solUsd;
}

export function createMarketRouter(): Router {
  const router = Router();

  // The endpoint only reads the cache; freshness is the server's job (timer
  // below), never a side effect of who happens to be visiting.
  router.get('/header', (_req: Request, res: Response) => {
    res.json(cached);
  });

  // Warm on boot, then refresh 24/7 regardless of traffic.
  void refresh();
  setInterval(() => { void refresh(); }, SOL_TTL_MS).unref();

  return router;
}
