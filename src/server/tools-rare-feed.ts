/**
 * Rare Feed Tool — read API.
 *
 *   GET /api/tools/rare-feed/recent?limit=100&minScore=55
 *
 * Returns the newest accepted rare-sale events. Pure DB read (no ME / RPC) —
 * all enrichment happened upstream in the evaluator, so this endpoint is cheap
 * and safe to poll from the frontend every ~20 s.
 */
import { Router, Request, Response } from 'express';
import { rateLimit } from './rate-limit';
import { loadRecentRareEvents } from '../rare-feed/store';

const LIMIT_MAX     = 200;
const LIMIT_DEFAULT = 100;

function envNum(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
const DEFAULT_MIN_SCORE = envNum('RARE_FEED_MIN_SCORE', 40);

export function createRareFeedRouter(): Router {
  const router = Router();
  // Cheap read, but cap polling so a stuck tab can't hammer the DB.
  const limit = rateLimit({ limit: 60, windowMs: 60_000, label: 'tools/rare-feed' });

  router.get('/tools/rare-feed/recent', limit, async (req: Request, res: Response) => {
    const lim = Math.min(LIMIT_MAX, Math.max(1, Math.floor(Number(req.query.limit ?? LIMIT_DEFAULT)) || LIMIT_DEFAULT));
    const minScoreRaw = req.query.minScore;
    const minScore = minScoreRaw != null && Number.isFinite(Number(minScoreRaw))
      ? Math.max(0, Math.min(100, Number(minScoreRaw)))
      : DEFAULT_MIN_SCORE;

    try {
      const rows = await loadRecentRareEvents(lim, minScore);
      return res.json({
        ok:       true,
        minScore,
        count:    rows.length,
        events:   rows.map(r => ({
          saleSignature:    r.saleSignature,
          mintAddress:      r.mintAddress,
          collectionSlug:   r.collectionSlug,
          collectionName:   r.collectionName,
          nftName:          r.nftName,
          imageUrl:         r.imageUrl,
          source:           r.source,
          seller:           r.seller,
          buyer:            r.buyer,
          salePriceSol:     r.salePriceSol,
          floorPriceSol:    r.floorPriceSol,
          floorDeltaPct:    r.floorDeltaPct,
          rarityRank:       r.rarityRank,
          totalSupply:      r.totalSupply,
          rarityPercentile: r.rarityPercentile,
          raritySource:     r.raritySource,
          rareScore:        r.rareScore,
          reasonTags:       r.reasonTags,
          saleTime:         r.saleTime ? r.saleTime.toISOString() : null,
          createdAt:        r.createdAt.toISOString(),
          meUrl:            `https://magiceden.io/item-details/${r.mintAddress}`,
          tensorUrl:        `https://www.tensor.trade/item/${r.mintAddress}`,
        })),
      });
    } catch (err) {
      console.error('[tools/rare-feed] recent error', err);
      return res.status(500).json({ ok: false, error: 'failed to load rare feed' });
    }
  });

  return router;
}
