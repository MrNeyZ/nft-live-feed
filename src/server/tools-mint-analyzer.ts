/**
 * Mint Analyzer Tool — read API.
 *
 *   GET /api/tools/mint-analyzer/analyze?sig=<signature>
 *
 * Read-only: fetches a single `getTransaction` and returns a decoded mint
 * verdict. No wallet, no signing, no transaction building, no DB writes.
 * Rate-limited so a stuck tab can't burn credits. Usually one RPC call; a raw
 * (non-Candy-Guard, non-wrapper) MPL Core create adds one more best-effort
 * live read of the collection's authority/delegate — see accessType below.
 */
import { Router, Request, Response } from 'express';
import { rateLimit } from './rate-limit';
import { analyze } from '../mint-analyzer/analyze';
import { fetchTransaction, isValidSignature } from '../mint-analyzer/fetch-tx';
import { checkCollectionAuthority } from '../mint-analyzer/collection-authority';

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

      // Raw MPL Core create with no candy guard/wrapper/known launchpad and no
      // backend co-signer: `verdict` correctly reads YES (structurally
      // reconstructable), but that says nothing about WHO can invoke it. The
      // Core program only lets the collection's updateAuthority (or an
      // UpdateDelegate additionalDelegate) create into it — never truly
      // public. Best-effort only; any RPC failure leaves accessType untouched.
      if (
        analysis.likelyMintPrimitive === 'mpl_core_create_v2'
        && analysis.collection
        && !analysis.backendSignerObserved
        && !analysis.guardAuth.candyGuard
        && !analysis.customWrapper
        && !analysis.knownLaunchpad
      ) {
        const check = await checkCollectionAuthority(analysis.collection);
        if (check) {
          analysis.accessType = 'authority_gated';
          analysis.accessClues = [
            ...(analysis.accessClues ?? []),
            `collection_update_authority:${check.updateAuthority}`,
            ...check.additionalDelegates.map((d) => `collection_delegate:${d}`),
          ];
        }
      }

      return res.json({ ok: true, analysis });
    } catch (err) {
      console.error('[tools/mint-analyzer] analyze error', err);
      return res.status(502).json({ ok: false, error: 'rpc_error' });
    }
  });

  return router;
}
