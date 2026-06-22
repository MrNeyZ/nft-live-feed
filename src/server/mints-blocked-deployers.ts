import { Router, Request, Response } from 'express';
import { getBlockedDeployersList } from '../mints/blacklist';

export function createMintsBlockedDeployersRouter(): Router {
  const router = Router();
  router.get('/blocked-deployers', (_req: Request, res: Response) => {
    res.json({ deployers: getBlockedDeployersList() });
  });
  return router;
}
