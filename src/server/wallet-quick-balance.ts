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
// Jupiter Lite price API (no key) — the project has no existing per-token USD
// source, so this is the smallest addition. One batched call per wallet.
const JUP_PRICE_URL = 'https://lite-api.jup.ag/price/v3';
const TTL_MS = 60_000;
const TIMEOUT_MS = 8_000;
const TOP_N = 3;
// Cap on how many holdings (largest by raw amount) we price in one Jupiter
// call. Long-tail dust/spam — mostly unpriced — is skipped; this captures the
// dominant value for a whale check without fanning out N price requests.
const PRICE_CAP = 50;

export interface QuickBalance {
  solLamports: number | null;
  // Total USD value of priced SPL holdings (null when nothing could be priced).
  tokenUsd: number | null;
  topTokens: Array<{ mint: string; symbol: string | null; usd: number }>;
  fetchedAt: number;
}

const cache = new Map<string, QuickBalance>();

// `params` is positional (array) for standard RPC methods (getBalance,
// getTokenAccountsByOwner) and a named object for DAS methods (getAssetBatch).
async function rpc(method: string, params: unknown): Promise<unknown> {
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

// Resolve token tickers for the top mints in ONE DAS getAssetBatch call.
// Prefers content.metadata.symbol, falls back to token_info.symbol. Returns
// a mint→symbol map; missing/empty symbols are simply absent (frontend then
// falls back to the short mint).
async function resolveSymbols(mints: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (mints.length === 0) return out;
  const result = await rpc('getAssetBatch', { ids: mints });
  if (!Array.isArray(result)) return out;
  for (const a of result) {
    const asset = a as {
      id?: string;
      content?: { metadata?: { symbol?: unknown } };
      token_info?: { symbol?: unknown };
    } | null;
    const id = asset?.id;
    const raw =
      (typeof asset?.content?.metadata?.symbol === 'string' && asset.content.metadata.symbol) ||
      (typeof asset?.token_info?.symbol === 'string' && asset.token_info.symbol) ||
      '';
    // Strip zero-width / filler / control chars some tokens stuff into their
    // symbol, collapse whitespace, and cap length so the tooltip stays clean.
    const sym = raw
      .replace(/[\u0000-\u001f\u00a0\u200b-\u200f\u2060\u3164\ufeff]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 12);
    if (id && sym) out.set(id, sym);
  }
  return out;
}

// mint → USD price (per whole token), in ONE Jupiter batched call. Tokens
// without a Jupiter price are simply absent (skipped from the total).
async function fetchJupPrices(mints: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (mints.length === 0) return out;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(`${JUP_PRICE_URL}?ids=${mints.join(',')}`, {
      headers: { accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (r.ok) {
      const j = (await r.json()) as Record<string, { usdPrice?: unknown } | null>;
      for (const [mint, v] of Object.entries(j)) {
        const p = (v as { usdPrice?: unknown } | null)?.usdPrice;
        if (typeof p === 'number' && p > 0) out.set(mint, p);
      }
    }
  } catch {
    /* skip pricing on failure — total falls back to null */
  } finally {
    clearTimeout(t);
  }
  return out;
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

  // Price the largest holdings (by raw amount), convert to USD, aggregate.
  const candidates = holdings.slice(0, PRICE_CAP);
  const prices = await fetchJupPrices(candidates.map((h) => h.mint));
  const priced = candidates
    .map((h) => ({ mint: h.mint, usd: (prices.get(h.mint) ?? 0) * h.amount }))
    .filter((h) => h.usd > 0)
    .sort((a, b) => b.usd - a.usd);
  const tokenUsd = priced.length ? priced.reduce((s, h) => s + h.usd, 0) : null;

  const top = priced.slice(0, TOP_N);
  const symbols = await resolveSymbols(top.map((h) => h.mint));
  return {
    solLamports,
    tokenUsd,
    topTokens: top.map((h) => ({ mint: h.mint, symbol: symbols.get(h.mint) ?? null, usd: h.usd })),
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
      res.json({ solLamports: null, tokenUsd: null, topTokens: [], fetchedAt: now });
    }
  });
  return router;
}
