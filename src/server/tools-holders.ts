/**
 * Holder Count Tool — read API.
 *
 *   GET /api/tools/holders/analyze?collection=<collectionAddress>
 *
 * Read-only: paginates Helius DAS getAssetsByGroup over a verified collection
 * group and returns an EXACT distinct-owner holder count plus distribution.
 * Source of truth is on-chain asset ownership — NOT Magic Eden / Tensor cached
 * holder stats. No wallet, no signing, no tx building, no DB writes.
 * Rate-limited so a stuck tab can't burn RPC credits.
 */
import { Router, Request, Response } from 'express';
import { rateLimit } from './rate-limit';
import { buildHoldersAnalysis } from '../tools-holders/analyze';
import { fetchCollectionOwners, isValidCollectionAddress } from '../tools-holders/fetch-assets';

export function createHoldersRouter(): Router {
  const router = Router();
  // Multi-RPC-page scan per request — cap tighter than the single-call analyzer.
  const limit = rateLimit({ limit: 15, windowMs: 60_000, label: 'tools/holders' });

  router.get('/tools/holders/analyze', limit, async (req: Request, res: Response) => {
    const collection = String(req.query.collection ?? '').trim();
    if (!isValidCollectionAddress(collection)) {
      return res.status(400).json({ ok: false, error: 'invalid_collection_address' });
    }

    try {
      const scan = await fetchCollectionOwners(collection);
      const analysis = buildHoldersAnalysis({
        ...scan,
        collectionAddress: collection,
        nowIso: new Date().toISOString(),
      });
      return res.json({ ok: true, analysis });
    } catch (err) {
      console.error('[tools/holders] analyze error', err);
      return res.status(502).json({ ok: false, error: 'rpc_error' });
    }
  });

  return router;
}
