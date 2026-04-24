/**
 * Header market stats: current SOL price (USD) + current Solana TPS.
 *
 * Single cached endpoint so the frontend TopNav doesn't hammer public APIs
 * when many tabs are open. Refetches every CACHE_TTL_MS (20 min) — both
 * values drift slowly enough for this cadence. On failure, the last-known
 * value is served (with the stale `asOf`) rather than forcing the UI to a
 * placeholder; stat endpoints should be resilient.
 *
 * Sources:
 *   - SOL/USD : Coinbase public ticker (no key).
 *   - TPS     : Solana RPC `getRecentPerformanceSamples` via Helius; TPS is
 *               `numTransactions / samplePeriodSecs` on the newest sample.
 */

import { Router, Request, Response } from 'express';

interface HeaderStats {
  tps:    number | null;
  solUsd: number | null;
  asOf:   number;          // epoch ms when this snapshot was fetched
}

const CACHE_TTL_MS       = 20 * 60_000;
const FETCH_TIMEOUT_MS   = 6_000;

let cached: HeaderStats = { tps: null, solUsd: null, asOf: 0 };
let refreshing:  Promise<void> | null = null;

async function fetchSolUsd(): Promise<number | null> {
  try {
    const res = await fetch('https://api.coinbase.com/v2/prices/SOL-USD/spot',
      { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const json = await res.json() as { data?: { amount?: string } };
    const amt = Number(json.data?.amount);
    return Number.isFinite(amt) && amt > 0 ? amt : null;
  } catch { return null; }
}

async function fetchTps(): Promise<number | null> {
  const key = process.env.HELIUS_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${key}`, {
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
    const [solUsd, tps] = await Promise.all([fetchSolUsd(), fetchTps()]);
    cached = {
      // Keep last-known value on transient failure — pill should never go
      // from a real number back to null just because one fetch dropped.
      tps:    tps    ?? cached.tps,
      solUsd: solUsd ?? cached.solUsd,
      asOf:   Date.now(),
    };
  })().finally(() => { refreshing = null; });
  return refreshing;
}

export function createMarketRouter(): Router {
  const router = Router();

  router.get('/header', async (_req: Request, res: Response) => {
    const now = Date.now();
    if (now - cached.asOf >= CACHE_TTL_MS) {
      // Don't await if we already have a value — serve stale-while-revalidate.
      if (cached.asOf === 0) await refresh();
      else void refresh();
    }
    res.json(cached);
  });

  // Warm cache on boot so the first request returns real values.
  void refresh();

  return router;
}
