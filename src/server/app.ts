import express from 'express';
import { createIngestionRouter } from '../ingestion';
import { createSseRouter } from './sse';
import { createEventsRouter } from './events-router';
import { createCollectionBidsRouter } from './collection-bids';
import { createCollectionRollupsRouter } from './collection-rollups';
import { createCollectionListingsRouter } from './collection-listings';
import { createCollectionStatsRouter } from './collection-stats';
import { createCollectionChartRouter } from './collection-chart';
import { createCollectionTradeHistoryRouter } from './collection-trade-history';
import { createListingsCheckRouter } from './listings-check';
import { createBuyMeRouter } from './buy-me';
import { createSubscribersRouter } from './subscribers';
import { createCollectionSearchRouter } from './collection-search';
import { startCatalogRefreshLoop } from './collection-catalog';
import { createCollectionIconRouter } from './collection-icon';
import { createCollectionMetaRouter } from './collection-meta';
import { createMarketRouter } from './market';
import { createRuntimeRouter } from './runtime';

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

  const bidsRouter     = createCollectionBidsRouter();
  const rollupsRouter  = createCollectionRollupsRouter();
  const listingsRouter = createCollectionListingsRouter();
  const statsRouter    = createCollectionStatsRouter();
  const chartRouter    = createCollectionChartRouter();
  const tradeHistoryRouter = createCollectionTradeHistoryRouter();
  app.use('/collections',     bidsRouter);
  app.use('/api/collections', bidsRouter);
  app.use('/collections',     rollupsRouter);
  app.use('/api/collections', rollupsRouter);
  app.use('/collections',     listingsRouter);
  app.use('/api/collections', listingsRouter);
  app.use('/collections',     statsRouter);
  app.use('/api/collections', statsRouter);
  app.use('/collections',     chartRouter);
  app.use('/api/collections', chartRouter);
  app.use('/collections',     tradeHistoryRouter);
  app.use('/api/collections', tradeHistoryRouter);

  const subscribersRouter = createSubscribersRouter();
  app.use('/collections',     subscribersRouter);
  app.use('/api/collections', subscribersRouter);

  const collectionSearchRouter = createCollectionSearchRouter();
  app.use('/collections',     collectionSearchRouter);
  app.use('/api/collections', collectionSearchRouter);

  const collectionIconRouter = createCollectionIconRouter();
  app.use('/collections',     collectionIconRouter);
  app.use('/api/collections', collectionIconRouter);

  const collectionMetaRouter = createCollectionMetaRouter();
  app.use('/collections',     collectionMetaRouter);
  app.use('/api/collections', collectionMetaRouter);

  const marketRouter = createMarketRouter();
  app.use('/market',     marketRouter);
  app.use('/api/market', marketRouter);

  const listingsCheckRouter = createListingsCheckRouter();
  app.use('/listings',     listingsCheckRouter);
  app.use('/api/listings', listingsCheckRouter);

  // Runtime control plane — auth + ingestion mode GET/POST. Mounted under
  // /api so the frontend (port 3001) hits it via the same rewrite pattern
  // as every other /api/* route.
  const runtimeRouter = createRuntimeRouter();
  app.use('/api', runtimeRouter);

  const buyMeRouter = createBuyMeRouter();
  app.use('/buy',     buyMeRouter);

  // Warm the verified-collection catalog in the background (loads persisted
  // rows from Postgres instantly, then fires a background refresh from ME).
  void startCatalogRefreshLoop();
  app.use('/api/buy', buyMeRouter);

  return app;
}
