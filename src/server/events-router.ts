import { Router, Request, Response } from 'express';
import { getLatestEvents } from '../db/queries';

const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export function createEventsRouter(): Router {
  const router = Router();

  router.get('/latest', async (req: Request, res: Response) => {
    const raw = parseInt(String(req.query.limit ?? DEFAULT_LIMIT), 10);
    const limit = Number.isNaN(raw) || raw < 1 ? DEFAULT_LIMIT : Math.min(raw, MAX_LIMIT);

    try {
      const events = await getLatestEvents(limit);
      res.json({ events, count: events.length });
    } catch (err) {
      console.error('[events] query error', err);
      res.status(500).json({ error: 'internal server error' });
    }
  });

  return router;
}
