/**
 * Per-collection bid snapshot endpoint — powers the dashboard's ME BID / TNSR BID
 * columns with real data instead of placeholders.
 *
 * Sources:
 *   floor        = ME v2 `/collections/{slug}/stats`         (public)
 *   meBid        = ME v2 `/mmm/pools?collectionSymbol={slug}` top `spotPrice`
 *                  over pools with buy-side SOL and a poolType that can buy.
 *                  This is the top MMM (ME AMM) pool bid — a stable public
 *                  proxy for "best bid on ME". Individual escrowed offers are
 *                  not exposed on the public v2 API.
 *   tnsrBid      = Tensor `api.mainnet.tensordev.io` top collection bid when
 *                  `TENSOR_API_KEY` is set. Null otherwise (no public Tensor
 *                  bid endpoint exists without a key).
 *
 * Values are returned as lamports (or null). Each slug cached for BID_TTL_MS.
 * Client pings every ~60s for visible slugs — cache absorbs duplicate slugs
 * across concurrent dashboard tabs.
 */

import { Router, Request, Response } from 'express';
import { getMeStats } from '../enrichment/me-stats';

const BID_TTL_MS = 60_000;
const MAX_SLUGS_PER_REQUEST = 80;

interface CachedBids {
  floorLamports:    number | null;
  meBidLamports:    number | null;
  tnsrBidLamports:  number | null;
  listedCount:      number | null;
  volumeAllLamports: number | null;
  fetchedAt:        number;
}

const cache = new Map<string, CachedBids>();

interface MeStatsOut {
  floorLamports:     number | null;
  listedCount:       number | null;
  volumeAllLamports: number | null;
}
interface MmmPool {
  spotPrice?: number;
  poolType?: string;           // 'buy' | 'two_sided' | 'sell'
  buysidePaymentAmount?: number;
}
interface MmmPoolsResponse { results?: MmmPool[] }

async function fetchMeStats(slug: string): Promise<MeStatsOut> {
  const json = await getMeStats(slug);
  if (!json) return { floorLamports: null, listedCount: null, volumeAllLamports: null };
  return {
    floorLamports: typeof json.floorPrice === 'number' && json.floorPrice > 0 ? json.floorPrice : null,
    listedCount:   typeof json.listedCount === 'number' && json.listedCount >= 0 ? json.listedCount : null,
    volumeAllLamports: typeof json.volumeAll === 'number' && json.volumeAll >= 0 ? json.volumeAll : null,
  };
}

async function fetchMmmTopBid(slug: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://api-mainnet.magiceden.dev/v2/mmm/pools?collectionSymbol=${encodeURIComponent(slug)}&limit=50`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!res.ok) return null;
    const json = await res.json() as MmmPoolsResponse;
    const pools = json.results ?? [];
    let best = 0;
    for (const p of pools) {
      // A pool can take our NFT only if its poolType includes 'buy' and it has
      // SOL on hand. spotPrice is the current quoted bid in lamports.
      const canBuy = (p.poolType === 'buy' || p.poolType === 'two_sided')
        && (p.buysidePaymentAmount ?? 0) > 0;
      if (!canBuy) continue;
      if ((p.spotPrice ?? 0) > best) best = p.spotPrice!;
    }
    return best > 0 ? best : null;
  } catch {
    return null;
  }
}

interface TensorCollStats {
  stats?: { priceUnit?: string; buyNowPrice?: string; sellNowPrice?: string };
}

async function fetchTensorTopBid(slug: string): Promise<number | null> {
  const key = process.env.TENSOR_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch(
      `https://api.mainnet.tensordev.io/api/v1/collections?slug=${encodeURIComponent(slug)}`,
      {
        headers: { 'x-tensor-api-key': key },
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (!res.ok) return null;
    const json = await res.json() as TensorCollStats;
    // sellNowPrice = what you'd get *selling now* into the top pool bid.
    const sell = json?.stats?.sellNowPrice;
    const n = sell ? Number(sell) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

async function getBidsForSlug(slug: string): Promise<CachedBids> {
  const hit = cache.get(slug);
  const now = Date.now();
  if (hit && now - hit.fetchedAt < BID_TTL_MS) return hit;

  const [stats, meBidLamports, tnsrBidLamports] = await Promise.all([
    fetchMeStats(slug),
    fetchMmmTopBid(slug),
    fetchTensorTopBid(slug),
  ]);
  const entry: CachedBids = {
    floorLamports:    stats.floorLamports,
    listedCount:      stats.listedCount,
    volumeAllLamports: stats.volumeAllLamports,
    meBidLamports,
    tnsrBidLamports,
    fetchedAt: now,
  };
  cache.set(slug, entry);
  return entry;
}

export function createCollectionBidsRouter(): Router {
  const router = Router();

  router.get('/bids', async (req: Request, res: Response) => {
    const raw = String(req.query.slugs ?? '').trim();
    if (!raw) {
      res.json({ bids: {} });
      return;
    }
    const slugs = Array.from(new Set(
      raw.split(',').map(s => s.trim()).filter(Boolean),
    )).slice(0, MAX_SLUGS_PER_REQUEST);

    try {
      const entries = await Promise.all(slugs.map(async (slug) => {
        const b = await getBidsForSlug(slug);
        return [slug, {
          floorLamports:    b.floorLamports,
          meBidLamports:    b.meBidLamports,
          tnsrBidLamports:  b.tnsrBidLamports,
          listedCount:      b.listedCount,
          volumeAllLamports: b.volumeAllLamports,
        }] as const;
      }));
      res.json({ bids: Object.fromEntries(entries) });
    } catch (err) {
      console.error('[collection-bids] error', err);
      res.status(500).json({ error: 'internal server error' });
    }
  });

  return router;
}
