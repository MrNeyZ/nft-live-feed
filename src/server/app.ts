import express from 'express';
import { createIngestionRouter } from '../ingestion';
import { createSseRouter } from './sse';
import { createEventsRouter } from './events-router';
import { createCollectionBidsRouter } from './collection-bids';
import { createCollectionRollupsRouter } from './collection-rollups';
import { createCollectionListingsRouter } from './collection-listings';
import { createCollectionFloorDepthRouter } from './collection-floor-depth';
import { createCollectionStatsRouter } from './collection-stats';
import { createCollectionChartRouter } from './collection-chart';
import { createCollectionTradeHistoryRouter } from './collection-trade-history';
import { createListingsCheckRouter } from './listings-check';
import { createBuyMeRouter } from './buy-me';
import { createSubscribersRouter } from './subscribers';
import { createWalletQuickBalanceRouter } from './wallet-quick-balance';
import { createCollectionSearchRouter } from './collection-search';
import { startCatalogRefreshLoop } from './collection-catalog';
import { createCollectionIconRouter } from './collection-icon';
import { createCollectionMetaRouter } from './collection-meta';
import { createMarketRouter } from './market';
import { createRuntimeRouter } from './runtime';
import { createRetardioOffersRouter } from './tools-retardio-offers';
import { createRareFeedRouter } from './tools-rare-feed';
import { createMintAnalyzerRouter } from './tools-mint-analyzer';
import { createTrendingCollectionsRouter } from './tools-trending-collections';
import { createSnsRouter } from './tools-sns';
import { createHoldersRouter } from './tools-holders';
import { createMmmPoolsRouter } from './tools-mmm-pools';
import { createMeTensorArbRouter } from './tools-me-tensor-arb';
import { createDotlandRouter } from './tools-dotland';
import { createMeBidsRouter } from './tools-me-bids';
import { createMmmCollectionBidsRouter } from './tools-mmm-collection-bids';
import { createDexbullAirdropRouter } from './tools-dexbull-airdrop';
import { createPixelForgeRouter } from './tools-pixel-forge';
import { createPixelForgeRasterRouter } from './tools-pixel-forge-raster';
import { createPixelForgeGenerateSourceRouter } from './tools-pixel-forge-generate-source';
import { createPixelForgeGeneratedSourcesRouter } from './tools-pixel-forge-generated-sources';
import { createPixelForgeExportRouter } from './tools-pixel-forge-export';
import { createPixelForgeCollectionFitRouter } from './tools-pixel-forge-collection-fit';
import { createPixelForgeImportTraitSheetRouter } from './tools-pixel-forge-import-trait-sheet';
import { createPixelForgeComposeTraitsRouter } from './tools-pixel-forge-compose-traits';
import { createPixelForgeValidateTraitSheetRouter } from './tools-pixel-forge-validate-trait-sheet';
import { corsMiddleware } from './cors';
import { createMintsBlockedDeployersRouter } from './mints-blocked-deployers';
import { createBotApiV1Router } from './bot-api/router';

export function createApp() {
  const app = express();

  // We sit behind exactly one reverse-proxy hop (nginx). Telling Express to
  // trust one hop makes `req.ip` resolve to the real client (the value nginx
  // appended to X-Forwarded-For), which is what every per-IP rate limiter
  // keys on. Without this, `req.ip` is always `127.0.0.1` and the first XFF
  // entry — which a hostile client controls — looks legitimate.
  app.set('trust proxy', 1);

  // Origin-allowlist CORS (UI_ALLOWED_ORIGINS, plus localhost defaults in
  // dev). Replaces the previous `Access-Control-Allow-Origin: *`. Mounted
  // first so it also handles OPTIONS preflights before any router runs.
  app.use(corsMiddleware);

  app.use(express.json({ limit: '10mb' }));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));

  // Helius webhook route is "standby" — only registered when
  // HELIUS_WEBHOOK_AUTH is configured. With the env unset the route is
  // unmounted entirely (404), so nginx forwarding `/webhooks/` to a
  // disabled backend is a no-op. When set, the router enforces a
  // constant-time bearer check on every request.
  if ((process.env.HELIUS_WEBHOOK_AUTH ?? '').trim().length > 0) {
    app.use('/webhooks', createIngestionRouter());
  }

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

  // Floor Depth / Liquidity — read-only, reuses listings-store's existing
  // ME+MMM+Tensor snapshot and the already-tested computeFloorDepth() pure
  // function (Feature Activation Stage 1 — see collection-floor-depth.ts).
  // GET /api/collections/floor-depth?slug=<collection slug>
  const floorDepthRouter = createCollectionFloorDepthRouter();
  app.use('/collections',     floorDepthRouter);
  app.use('/api/collections', floorDepthRouter);
  app.use('/collections',     statsRouter);
  app.use('/api/collections', statsRouter);
  app.use('/collections',     chartRouter);
  app.use('/api/collections', chartRouter);
  app.use('/collections',     tradeHistoryRouter);
  app.use('/api/collections', tradeHistoryRouter);

  const subscribersRouter = createSubscribersRouter();
  app.use('/collections',     subscribersRouter);
  app.use('/api/collections', subscribersRouter);

  // Minter-wallet quick balance (Live Mint Feed hover tooltip) — lazy, cached.
  const walletQuickBalanceRouter = createWalletQuickBalanceRouter();
  app.use('/',     walletQuickBalanceRouter);
  app.use('/api',  walletQuickBalanceRouter);

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

  const mintsBlockedRouter = createMintsBlockedDeployersRouter();
  app.use('/mints',     mintsBlockedRouter);
  app.use('/api/mints', mintsBlockedRouter);

  // Manual on-demand tools — Retardio personal-offer scanner.
  // POST /api/tools/retardio-me-offer-scan
  app.use('/api', createRetardioOffersRouter());

  // Rare Feed tool — read API for rarity-scored value sales.
  // GET /api/tools/rare-feed/recent
  app.use('/api', createRareFeedRouter());

  // Mint Analyzer tool — read-only tx decoder + mint verdict.
  // GET /api/tools/mint-analyzer/analyze?sig=<signature>
  app.use('/api', createMintAnalyzerRouter());

  // Trending Collections tool — read-only ME pre-aggregated stats proxy.
  // GET /api/tools/trending-collections?range=1d&sort=volume&limit=100
  app.use('/api', createTrendingCollectionsRouter());

  // SNS reverse-resolver — read-only, lazy wallet → .sol domain lookup.
  // GET /api/tools/sns/resolve?wallet=<address>
  app.use('/api', createSnsRouter());

  // Holder Count tool — read-only exact distinct-owner count via Helius DAS.
  // GET /api/tools/holders/analyze?collection=<collectionAddress>
  app.use('/api', createHoldersRouter());

  // MMM Dormant Pool Scanner — read-only on-chain escrow audit.
  // GET /api/tools/mmm-pools/scan?owner=<wallet>
  app.use('/api', createMmmPoolsRouter());

  // ME-vs-Tensor arbitrage lookup — read-only, one collection per request.
  // GET /api/tools/me-tensor-arb?slug=<collection slug>
  app.use('/api', createMeTensorArbRouter());

  // DotLand direct-mint tool — personal use, requireAuth-gated on every
  // route (see tools-dotland.ts header comment).
  app.use('/api', createDotlandRouter());

  // Magic Eden item-level bid tool — personal use, requireAuth-gated on
  // every route (see tools-me-bids.ts header comment). Never handles a
  // private key; build-only until the client signs via Phantom and submits
  // through the existing /api/tools/mmm-pools/send-tx proxy.
  app.use('/api', createMeBidsRouter());

  // DotLand x DEXBULL airdrop estimator — read-only analytics, public.
  // GET /api/tools/dexbull-airdrop/report
  app.use('/api', createDexbullAirdropRouter());

  // Pixel-forge drawing agent — personal use, requireAuth-gated on every
  // route (see tools-pixel-forge.ts header comment).
  app.use('/api', createPixelForgeRouter());

  // Pixel Forge Image-to-Traits Stage 1 (raster normalize/import) — same
  // gating, separate file (see tools-pixel-forge-raster.ts header comment
  // and docs/pixel-forge-image-to-traits-pipeline-mvp.md).
  app.use('/api', createPixelForgeRasterRouter());

  // Pixel Forge Image-to-Traits Stage 6 (OpenAI Image Source) — same
  // gating, separate file (see tools-pixel-forge-generate-source.ts header
  // comment). The only route in this whole area that spends real money.
  app.use('/api', createPixelForgeGenerateSourceRouter());

  // Pixel Forge Generated Sources Library — read/delete over the storage
  // Stage 6 already writes. Same gating, separate file (see
  // tools-pixel-forge-generated-sources.ts header comment). No OpenAI
  // call, no generation, no TraitAsset creation.
  app.use('/api', createPixelForgeGeneratedSourcesRouter());

  // Pixel Forge Image-to-Traits Stage 7 (48x48 -> 384x384 upscaled export)
  // — same gating, separate file (see tools-pixel-forge-export.ts header
  // comment). Read-only, no AI, no data mutation.
  app.use('/api', createPixelForgeExportRouter());

  // Pixel Forge Image-to-Traits Stage 8 (Collection DNA Lock / Fit Check)
  // — same gating, separate file (see
  // tools-pixel-forge-collection-fit.ts header comment). Deterministic
  // geometry/style scoring only, no AI, no TraitAsset mutation, advisory-
  // only (never blocks import).
  app.use('/api', createPixelForgeCollectionFitRouter());

  // Pixel Forge Stage 9.2 (Trait Sheet import + real PNG compose) — same
  // gating, separate files (see tools-pixel-forge-import-trait-sheet.ts /
  // tools-pixel-forge-compose-traits.ts header comments). No OpenAI call,
  // no Anthropic call, no generation — crops/normalizes/composes
  // already-supplied images only. Import creates candidate TraitAssets
  // (never auto-approved, never overwrites); compose never mutates
  // anything.
  app.use('/api', createPixelForgeImportTraitSheetRouter());
  app.use('/api', createPixelForgeComposeTraitsRouter());

  // Pixel Forge Stage 9.4 (Trait Sheet validation) — same gating, separate
  // file (see tools-pixel-forge-validate-trait-sheet.ts header comment).
  // No OpenAI call, no Anthropic call, no generation — pure read +
  // measurement over an already-generated sheet image. Never creates or
  // mutates a TraitAsset, never writes meta.json.
  app.use('/api', createPixelForgeValidateTraitSheetRouter());

  // Magic Eden MMM collection-bid tool — personal use, requireAuth-gated on
  // every route (see tools-mmm-collection-bids.ts header comment). Fully
  // isolated from tools-me-bids.ts (item-level offers) and tools-mmm-pools.ts
  // (read-only scanner) — builds raw on-chain MMM instructions, never uses
  // the item-level tool's submit path or any generic tx proxy. Never handles
  // the owner's private key; only a narrowly-scoped server-held cosigner
  // keypair that cannot move funds or act alone.
  app.use('/api', createMmmCollectionBidsRouter());

  // VictoryLabs Internal Bot API v1 — private, versioned, read-only market
  // data for the vl-nft-bots consumer. Bot-auth-gated on every route (see
  // bot-api/auth.ts); own rate-limit budget, separate from every public
  // route above. See docs/internal-bot-api-v1.md.
  app.use('/api/internal/bots/v1', createBotApiV1Router());

  const buyMeRouter = createBuyMeRouter();
  // Frontend uses `/api/buy/me` exclusively (see grep: only call site is
  // collection/[slug]/page.tsx). The legacy `/buy` mount was a duplicate
  // route with no callers — removed to shrink the route table and reduce
  // attack surface.
  app.use('/api/buy', buyMeRouter);

  // Warm the verified-collection catalog in the background (loads persisted
  // rows from Postgres instantly, then fires a background refresh from ME).
  void startCatalogRefreshLoop();

  return app;
}
