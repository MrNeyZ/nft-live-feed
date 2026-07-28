/**
 * VictoryLabs Internal Bot API v1 — `/api/internal/bots/v1/*`.
 *
 * Private, versioned, read-only API exposing existing VictoryLabs market
 * data to trading bots (consumer: `/root/vl-nft-bots`, a separate
 * process/VPS) so they never need to call Magic Eden, Tensor, or Helius
 * directly. See docs/internal-bot-api-v1.md for the full contract.
 *
 * Every route below is bot-auth-gated (`requireBotAuth`, src/server/bot-api/
 * auth.ts) and rate-limited on its OWN limiter — separate budget from every
 * public route in this codebase.
 *
 * No trading-strategy logic, no transaction building, no wallet/private-key
 * handling anywhere in this file or its imports.
 */

import { Router, Request, Response } from 'express';
import { rateLimit, isValidSlug } from '../rate-limit';
import { requireBotAuth } from './auth';
import { sendBotApiJson } from './json-safe';
import { buildCollectionSnapshot, defaultSnapshotDeps, type SnapshotDeps } from './snapshot';
import {
  wireBotEventSources,
  subscribeBotEvents,
  subscriberCount,
  replaySince,
  buildResyncFrame,
} from './events';
import { currentStatuses } from '../../health/source-health';
import { BOT_API_VERSION } from '../../domain/bot-api-types';
import type {
  BotApiHealthResponse,
  BotApiCollectionSnapshotResponse,
} from '../../domain/bot-api-types';

const BOOT_TIME_MS = Date.now();

/** Same client-IP resolution priority as `rate-limit.ts`'s `clientIp` /
 *  `sse.ts`'s `clientIpForCap` / `auth.ts`'s `clientIp` — kept as a local
 *  copy (not imported) since none of those files export their version. */
function normalizeIp(ip: string): string {
  const t = ip.trim();
  return t.startsWith('::ffff:') ? t.slice(7) : t;
}
function clientIp(req: Request): string {
  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && cf.trim()) return normalizeIp(cf);
  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.trim()) {
    const first = xff.split(',')[0];
    if (first && first.trim()) return normalizeIp(first);
  }
  return normalizeIp(req.ip || req.socket.remoteAddress || 'unknown');
}

// ── SSE connection bound ─────────────────────────────────────────────────
// This API has exactly one intended consumer class (the bot fleet behind
// BOT_API_KEY), so a flat process-wide cap — not a per-IP cap like the
// public /events/stream — is the right shape: it bounds worst-case memory
// from a misbehaving/reconnect-storming bot without penalizing a fleet that
// legitimately runs several bot processes from the same egress IP.
function envInt(name: string, fallback: number): number {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
const MAX_CONSECUTIVE_BACKPRESSURE = 8; // same threshold sse.ts uses for the public stream

/** `snapshotDeps` is an injectable seam for route-level tests only
 *  (mirrors `FloorDepthDeps` in collection-floor-depth.ts) — production
 *  callers always use the real listings-store/DB functions via the
 *  default parameter below. */
export function createBotApiV1Router(snapshotDeps: SnapshotDeps = defaultSnapshotDeps): Router {
  wireBotEventSources();

  const router = Router();

  // Auth first (so an unauthenticated caller never reaches the rate
  // limiter or any handler), then a rate limiter with its OWN bucket Map
  // — mounting `rateLimit({...})` here creates a fresh instance, so this
  // budget is entirely independent of every public-route limiter.
  router.use(requireBotAuth);
  const botLimit = rateLimit({ limit: 120, windowMs: 60_000, label: 'internal/bots/v1' });
  router.use(botLimit);

  router.get('/health', (_req: Request, res: Response) => {
    const body: BotApiHealthResponse = {
      apiVersion:  BOT_API_VERSION,
      status:      'ok',
      serverTime:  new Date().toISOString(),
      uptimeSec:   Math.round((Date.now() - BOOT_TIME_MS) / 1000),
      sources:     currentStatuses(),
      eventStreamClients: subscriberCount(),
    };
    sendBotApiJson(res, 200, body);
  });

  router.get('/collections/:slug/snapshot', async (req: Request, res: Response) => {
    const slug = String(req.params.slug ?? '').trim();
    if (!isValidSlug(slug)) {
      sendBotApiJson(res, 400, { error: 'invalid_slug' });
      return;
    }

    const receivedAt = new Date().toISOString();
    try {
      const { collection, warnings, stale } = await buildCollectionSnapshot(slug, snapshotDeps);
      const generatedAt = new Date().toISOString();
      const body: BotApiCollectionSnapshotResponse = {
        apiVersion:  BOT_API_VERSION,
        generatedAt,
        receivedAt,
        dataVersion: generatedAt,
        stale,
        collection,
        warnings,
      };
      sendBotApiJson(res, 200, body);
    } catch (err) {
      // buildCollectionSnapshot is designed to never throw (every internal
      // call is try/caught) — this is a last-resort guard against a truly
      // unexpected failure, never a partial-upstream-failure path (that's
      // handled via `stale`/`warnings` above, still a 200).
      console.error(`[bot-api/v1] unexpected snapshot error slug=${slug}`, err);
      sendBotApiJson(res, 500, { error: 'internal' });
    }
  });

  router.get('/events', (req: Request, res: Response) => {
    // Read per-connection (not module-load-time) so tests can tune both
    // via `process.env` without needing a fresh router instance, and so an
    // operator's env edit + restart always takes effect immediately.
    const maxClients  = envInt('BOT_API_MAX_SSE_CLIENTS', 50);
    const heartbeatMs = envInt('BOT_API_HEARTBEAT_MS', 25_000);
    if (subscriberCount() >= maxClients) {
      res.setHeader('Retry-After', '30');
      sendBotApiJson(res, 429, { error: 'sse_capacity' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    res.write(': connected\n\n');

    const ip = clientIp(req);
    const connectedAt = Date.now();

    // EventSource sets this header automatically on reconnect; a
    // non-browser bot client that doesn't speak full EventSource semantics
    // can pass the same value via `?lastEventId=` instead.
    const lastEventId = (req.header('last-event-id') ?? String(req.query.lastEventId ?? '')).trim();
    let replayOutcome = 'none';
    if (lastEventId) {
      const replay = replaySince(lastEventId);
      if (replay.ok) {
        replayOutcome = `replayed=${replay.frames.length}`;
        for (const frame of replay.frames) {
          try { res.write(frame); } catch { break; }
        }
      } else {
        replayOutcome = 'resync_required';
        try { res.write(buildResyncFrame(lastEventId)); } catch { /* client already gone */ }
      }
    }
    console.log(`[bot-api/v1] connect ip=${ip} lastEventId=${lastEventId || 'none'} replay=${replayOutcome} clients=${subscriberCount() + 1}`);

    let consecutiveBackpressure = 0;
    let cleaned = false;

    const unsubscribe = subscribeBotEvents((frame) => {
      try {
        const ok = res.write(frame);
        if (ok) {
          consecutiveBackpressure = 0;
        } else {
          consecutiveBackpressure++;
          if (consecutiveBackpressure >= MAX_CONSECUTIVE_BACKPRESSURE) cleanup('slow_client');
        }
      } catch {
        cleanup('write_error');
      }
    });

    const heartbeat = setInterval(() => {
      try {
        const ok = res.write(`event: heartbeat\ndata: {"t":${Date.now()}}\n\n`);
        if (!ok) {
          consecutiveBackpressure++;
          if (consecutiveBackpressure >= MAX_CONSECUTIVE_BACKPRESSURE) cleanup('slow_client');
        }
      } catch {
        cleanup('heartbeat_error');
      }
    }, heartbeatMs);
    if (typeof heartbeat.unref === 'function') heartbeat.unref();

    function cleanup(reason: string): void {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      unsubscribe();
      const durationSec = ((Date.now() - connectedAt) / 1000).toFixed(1);
      console.log(`[bot-api/v1] disconnect ip=${ip} reason=${reason} durationSec=${durationSec} clients=${subscriberCount()}`);
      try { res.end(); } catch { /* already closed */ }
    }

    req.on('close',   () => cleanup('req_close'));
    req.on('error',   () => cleanup('req_error'));
    req.on('aborted', () => cleanup('req_aborted'));
    res.on('close',   () => cleanup('res_close'));
    res.on('error',   () => cleanup('res_error'));
  });

  return router;
}
