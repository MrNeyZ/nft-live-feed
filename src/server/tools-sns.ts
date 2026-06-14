/**
 * SNS (Solana Name Service) reverse-resolver — read API.
 *
 *   GET /api/tools/sns/resolve?wallet=<address>
 *     → 200 { ok:true, wallet, domain: "name.sol" | null, cached:boolean }
 *     → 400 { ok:false, error:'invalid_wallet' }
 *
 * Lazy / on-demand only — the frontend calls this when a wallet first appears
 * in a visible feed card (so the tiny .sol icon can render) and never for
 * buffered/off-screen events. Resolves a wallet's primary/favorite .sol
 * domain, falling back to its first owned domain.
 *
 * Resolution uses Bonfida's public HTTP proxy. We deliberately do NOT add an
 * SNS library dependency (@bonfida/spl-name-service) or issue on-chain RPC —
 * the audit found neither already wired, and the HTTP proxy covers the
 * reverse-lookup without either. Read-only: no DB writes.
 *
 * Cache: 24h in-memory per wallet, INCLUDING negative results (domain=null),
 * so the same wallet repeated across many feed cards resolves at most once a
 * day. Per-wallet in-flight dedup collapses concurrent first-time lookups.
 * Transient upstream failures are NOT cached (so they retry on the next ask).
 */
import { Router, Request, Response } from 'express';
import { rateLimit } from './rate-limit';

const SNS_PROXY  = 'https://sns-sdk-proxy.bonfida.workers.dev';
const TIMEOUT_MS = 5_000;
const TTL_MS     = 24 * 60 * 60_000;   // 24h
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Base58, 32–44 chars — same shape used elsewhere for Solana pubkeys. */
const WALLET_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

interface CacheEntry { domain: string | null; fetchedAt: number }
const cache    = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<string | null | undefined>>();

interface ProxyEnvelope {
  s?: string;
  result?: unknown;
}

/** GET a proxy path → parsed JSON, or null on any network/non-2xx/parse error
 *  (so the caller can distinguish "upstream down" from "no domain"). */
async function proxyGet(path: string): Promise<ProxyEnvelope | null> {
  try {
    const r = await fetch(`${SNS_PROXY}${path}`, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) return null;
    return await r.json() as ProxyEnvelope;
  } catch {
    return null;
  }
}

/**
 * Resolve a wallet's display .sol domain.
 *   string     → domain (with `.sol` suffix)
 *   null       → confirmed: wallet has no usable domain
 *   undefined  → upstream lookup failed (do not cache; retry later)
 */
async function lookupDomain(wallet: string): Promise<string | null | undefined> {
  // 1. Primary/favorite domain — `result.reverse` is the human name. Skip when
  //    `stale` (favorite was transferred away and no longer owned).
  const fav = await proxyGet(`/favorite-domain/${wallet}`);
  if (fav === null) return undefined;
  if (fav.s === 'ok' && fav.result && typeof fav.result === 'object') {
    const r = fav.result as { reverse?: unknown; stale?: unknown };
    if (typeof r.reverse === 'string' && r.reverse.length > 0 && r.stale !== true) {
      return `${r.reverse}.sol`;
    }
  }

  // 2. Fallback — first owned domain. Empty array = confirmed no domain.
  const list = await proxyGet(`/domains/${wallet}`);
  if (list === null) return undefined;
  if (list.s === 'ok' && Array.isArray(list.result)) {
    if (list.result.length === 0) return null;
    const first = list.result[0] as { domain?: unknown };
    if (first && typeof first.domain === 'string' && first.domain.length > 0) {
      return `${first.domain}.sol`;
    }
  }
  return null;
}

export function createSnsRouter(): Router {
  const router = Router();
  // Lazy lookups can fan out across many distinct wallets; the frontend caches
  // + dedupes, but cap here too so a misbehaving client can't spray upstream.
  const limit = rateLimit({ limit: 240, windowMs: 60_000, label: 'tools/sns/resolve' });

  router.get('/tools/sns/resolve', limit, async (req: Request, res: Response) => {
    const wallet = String(req.query.wallet ?? '').trim();
    if (!WALLET_RE.test(wallet)) {
      return res.status(400).json({ ok: false, error: 'invalid_wallet' });
    }

    const now = Date.now();
    const hit = cache.get(wallet);
    if (hit && now - hit.fetchedAt < TTL_MS) {
      return res.json({ ok: true, wallet, domain: hit.domain, cached: true });
    }

    try {
      let task = inFlight.get(wallet);
      if (!task) {
        task = lookupDomain(wallet);
        inFlight.set(wallet, task);
        task.finally(() => inFlight.delete(wallet));
      }
      const domain = await task;

      // Upstream failure → respond null but DON'T cache, so a later hover retries.
      if (domain === undefined) {
        return res.json({ ok: true, wallet, domain: null, cached: false, stale: true });
      }
      cache.set(wallet, { domain, fetchedAt: Date.now() });
      return res.json({ ok: true, wallet, domain, cached: false });
    } catch (err) {
      console.error(`[tools/sns/resolve] wallet=${wallet} error`, err);
      return res.status(502).json({ ok: false, error: 'resolve_failed' });
    }
  });

  return router;
}
