/**
 * Critters.quest mint-timer — read-only catalog of upcoming NFT "edition"
 * mints from https://critters.quest/edition-mint, cheap enough (below a
 * configurable price threshold) to be worth watching for.
 *
 * Pure display tool: no wallet, no signing, no mint-transaction requests.
 * The actual minting/sniping bot lives in a separate project on a
 * different VPS (critters-sniper-bot) — this page never talks to
 * cqgm.critters.quest (the mint-request host), only to bump.critters.quest
 * (the read-only catalog host).
 *
 * Source (reverse-engineered 2026-08-13, verified live):
 *   POST https://bump.critters.quest/api/master-edition/get-edition-mint
 * 401s without browser-like headers from a datacenter IP (Cloudflare/WAF
 * bot filtering, not real per-caller auth) — Referer/Origin/User-Agent
 * below are required.
 *
 * mintPrice is float32-precision-noisy (e.g. 0.15000000596046448 for a
 * conceptual "0.15") — always compare/filter with an epsilon, never exact
 * equality, and round only for display.
 */
import { Router, Request, Response } from 'express';
import { rateLimit } from './rate-limit';
import { requireAuth } from './runtime';

const SOURCE_URL = 'https://bump.critters.quest/api/master-edition/get-edition-mint';
const REFRESH_INTERVAL_MS = 45_000;
const PRICE_EPSILON = 0.001;
const DEFAULT_MAX_PRICE_SOL = 0.16;

interface RawEdition {
  mint: string;
  name: string;
  mintStartDate: number;
  mintEndDate: number;
  mintPrice: number;
  supply: number;
  currentMintCount: number;
  editionMintActive: boolean;
}

export interface EditionRow {
  mint: string;
  name: string;
  mintStartDate: number;
  priceSol: number;
  supply: number;
  remaining: number;
  editionMintActive: boolean;
}

let cache: { fetchedAt: number; rows: EditionRow[] } = { fetchedAt: 0, rows: [] };
let lastError: string | null = null;

async function fetchEditions(): Promise<RawEdition[]> {
  const res = await fetch(SOURCE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Required — the endpoint 401s without these from a datacenter IP,
      // confirmed live. Not real auth, just WAF bot filtering.
      Referer: 'https://critters.quest/edition-mint',
      Origin: 'https://critters.quest',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    },
    body: JSON.stringify({
      mintType: [], amulets: [], armors: [], boots: [], eyes: [], hats: [],
      shields: [], weapons: [], critters: [], factions: [], search: '',
      sort: 'date', sortOrder: 'asc', page: 1, pageSize: 500,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`upstream_${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('unexpected_response_shape');
  return data as RawEdition[];
}

async function refresh(): Promise<void> {
  try {
    const raw = await fetchEditions();
    const rows: EditionRow[] = raw
      .filter(e => typeof e.mint === 'string' && typeof e.mintStartDate === 'number')
      .map(e => ({
        mint: e.mint,
        name: e.name ?? e.mint,
        mintStartDate: e.mintStartDate,
        priceSol: Math.round((e.mintPrice ?? 0) * 1000) / 1000,
        supply: e.supply ?? 0,
        remaining: Math.max(0, (e.supply ?? 0) - (e.currentMintCount ?? 0)),
        editionMintActive: !!e.editionMintActive,
      }));
    cache = { fetchedAt: Date.now(), rows };
    lastError = null;
  } catch (err) {
    lastError = String(err);
    console.error('[critters-mint-timer] refresh failed', err);
  }
}

export function startCrittersMintTimerRefreshLoop(): void {
  void refresh();
  setInterval(() => { void refresh(); }, REFRESH_INTERVAL_MS).unref();
}

export function createCrittersMintTimerRouter(): Router {
  const router = Router();
  const readLimit = rateLimit({ limit: 30, windowMs: 60_000, label: 'tools/critters-mint-timer' });

  router.get('/tools/critters-mint-timer', readLimit, requireAuth, (req: Request, res: Response) => {
    const maxPriceRaw = req.query.maxPrice;
    const maxPrice = maxPriceRaw != null && maxPriceRaw !== ''
      ? Number(maxPriceRaw)
      : DEFAULT_MAX_PRICE_SOL;
    if (!Number.isFinite(maxPrice) || maxPrice < 0) {
      res.status(400).json({ ok: false, error: 'invalid_maxPrice' });
      return;
    }

    const now = Date.now();
    const rows = cache.rows
      .filter(r => r.mintStartDate > now && r.priceSol <= maxPrice + PRICE_EPSILON)
      .sort((a, b) => a.mintStartDate - b.mintStartDate);

    res.json({
      ok: true,
      fetchedAt: cache.fetchedAt,
      ageMs: cache.fetchedAt > 0 ? now - cache.fetchedAt : null,
      maxPrice,
      count: rows.length,
      rows,
      ...(lastError ? { warning: `last refresh failed: ${lastError} — showing last-known-good data` } : {}),
    });
  });

  return router;
}
