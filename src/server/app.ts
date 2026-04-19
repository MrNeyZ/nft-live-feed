import express from 'express';
import { createIngestionRouter } from '../ingestion';
import { createSseRouter } from './sse';
import { createEventsRouter } from './events-router';

export function createApp() {
  const app = express();

  // Allow cross-origin requests from the Next.js dev server (localhost:3001)
  // and any production frontend that connects directly to avoid proxy buffering.
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    next();
  });

  app.use(express.json({ limit: '10mb' }));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  app.use('/webhooks', createIngestionRouter());

  // Mount under both /events (for reverse-proxy / production) and /api/events
  // (for direct browser → backend connection, bypassing Next.js rewrite proxy).
  // The Next.js dev server buffers SSE responses when proxying rewrites, so the
  // frontend must connect directly when NEXT_PUBLIC_API_URL is set.
  const sseRouter    = createSseRouter();
  const eventsRouter = createEventsRouter();
  app.use('/events',     sseRouter);
  app.use('/api/events', sseRouter);
  app.use('/events',     eventsRouter);
  app.use('/api/events', eventsRouter);

  return app;
}
