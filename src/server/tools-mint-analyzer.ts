/**
 * Mint Analyzer Tool — read API.
 *
 *   GET /api/tools/mint-analyzer/analyze?sig=<signature>
 *
 * Read-only: fetches a single `getTransaction` and returns a decoded mint
 * verdict. No wallet, no signing, no transaction building, no DB writes.
 * One RPC call per request, rate-limited so a stuck tab can't burn credits.
 */
import { Router, Request, Response } from 'express';
import { rateLimit } from './rate-limit';
import { analyze } from '../mint-analyzer/analyze';
import { fetchTransaction, isValidSignature } from '../mint-analyzer/fetch-tx';

export function createMintAnalyzerRouter(): Router {
  const router = Router();
  // Manual, RPC-backed tool — cap tighter than the DB-only rare-feed read.
  const limit = rateLimit({ limit: 30, windowMs: 60_000, label: 'tools/mint-analyzer' });

  router.get('/tools/mint-analyzer/analyze', limit, async (req: Request, res: Response) => {
    const sig = String(req.query.sig ?? '').trim();
    if (!isValidSignature(sig)) {
      return res.status(400).json({ ok: false, error: 'invalid_signature' });
    }

    try {
      const tx = await fetchTransaction(sig);
      if (!tx) {
        return res.status(404).json({ ok: false, error: 'transaction_not_found' });
      }
      const analysis = analyze(tx, sig);
      return res.json({ ok: true, analysis });
    } catch (err) {
      console.error('[tools/mint-analyzer] analyze error', err);
      return res.status(502).json({ ok: false, error: 'rpc_error' });
    }
  });

  return router;
}
