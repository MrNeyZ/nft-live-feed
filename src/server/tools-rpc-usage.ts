/**
 * GET /api/tools/rpc-usage?days=N — daily Helius usage ledger (requests,
 * estimated credits, by method / source / process), merged across every
 * process that runs installRpcUsageDaily (nft-backend, retardio-sniper, …).
 * Read-only, auth-gated like the other personal tools.
 */
import { Router, Request, Response } from 'express';
import { requireAuth } from './runtime';
import { readAllRpcUsage } from '../runtime/rpc-usage-daily';

export function createRpcUsageRouter(): Router {
  const router = Router();
  router.get('/tools/rpc-usage', requireAuth, (req: Request, res: Response) => {
    const n = Math.min(60, Math.max(1, parseInt(String(req.query.days ?? '14'), 10) || 14));
    res.json({ days: readAllRpcUsage().slice(0, n) });
  });
  return router;
}
