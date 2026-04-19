import { Router } from 'express';
import { createHeliusRouter } from './helius/webhook';

export function createIngestionRouter(): Router {
  const router = Router();
  router.use('/helius', createHeliusRouter());
  return router;
}
