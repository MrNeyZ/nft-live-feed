/**
 * Minter-wallet quick balance — lazy, hover-driven, cached.
 *
 * Powers the Live Mint Feed minter-wallet hover tooltip. Read-only and
 * credit-bounded: one `getBalance` (SOL) + one `getTokenAccountsByOwner`
 * (SPL token-account count + top holdings by raw amount). USD value is NOT
 * computed — no price oracle is wired into this service — so the UI shows
 * holdings count / top raw balances and says so. A 60s in-memory TTL cache
 * plus the existing per-IP rate limit keep RPC usage bounded; the frontend
 * fetches only on hover (no polling).
 */
import { Router, type Request, type Response } from 'express';
import { rateLimit, isValidMint } from './rate-limit';

const HELIUS_URL = (): string =>
  `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY ?? ''}`;
const TOKEN_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const TTL_MS = 60_000;
const TIMEOUT_MS = 8_000;
const TOP_N = 3;

export interface QuickBalance {
  solLamports: number | null;
  tokenAccounts: number;
  topTokens: Array<{ mint: string; amount: number }>;
  fetchedAt: number;
}

const cache = new Map<string, QuickBalance>();

async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(HELIUS_URL(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { result?: unknown };
    return j.result ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function fetchQuickBalance(wallet: string): Promise<QuickBalance> {
  const [bal, tok] = await Promise.all([
    rpc('getBalance', [wallet]),
    rpc('getTokenAccountsByOwner', [wallet, { programId: TOKEN_PROGRAM }, { encoding: 'jsonParsed' }]),
  ]);
  const solLamports =
    typeof (bal as { value?: unknown })?.value === 'number'
      ? ((bal as { value: number }).value)
      : null;
  const accts = Array.isArray((tok as { value?: unknown[] })?.value)
    ? (tok as { value: unknown[] }).value
    : [];
  const holdings = accts
    .map((a) => {
      const info = (a as { account?: { data?: { parsed?: { info?: {
        mint?: string; tokenAmount?: { uiAmount?: number | null };
      } } } } })?.account?.data?.parsed?.info;
      return { mint: info?.mint ?? '', amount: Number(info?.tokenAmount?.uiAmount ?? 0) };
    })
    .filter((h) => h.mint && h.amount > 0)
    .sort((a, b) => b.amount - a.amount);
  return {
    solLamports,
    tokenAccounts: holdings.length,
    topTokens: holdings.slice(0, TOP_N),
    fetchedAt: Date.now(),
  };
}

export function createWalletQuickBalanceRouter(): Router {
  const router = Router();
  const limit = rateLimit({ limit: 90, windowMs: 60_000, label: 'wallet/quick-balance' });
  router.get('/wallet/:address/quick-balance', limit, async (req: Request, res: Response) => {
    const wallet = String(req.params.address ?? '');
    if (!isValidMint(wallet)) {
      res.status(400).json({ error: 'invalid address' });
      return;
    }
    const now = Date.now();
    const hit = cache.get(wallet);
    if (hit && now - hit.fetchedAt < TTL_MS) {
      res.json(hit);
      return;
    }
    try {
      const qb = await fetchQuickBalance(wallet);
      cache.set(wallet, qb);
      if (cache.size > 2000) {
        for (const [k, v] of cache) if (now - v.fetchedAt > TTL_MS) cache.delete(k);
      }
      res.json(qb);
    } catch {
      res.json({ solLamports: null, tokenAccounts: 0, topTokens: [], fetchedAt: now });
    }
  });
  return router;
}
