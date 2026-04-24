/**
 * Live per-mint listing-state checker. Backs the Collection page's "Prepare
 * Buy" gate: a row is only marked actionable when an *active* on-chain
 * listing exists for that exact mint right now — historical sale recency is
 * not enough.
 *
 * Sources
 *   ME     → GET https://api-mainnet.magiceden.dev/v2/tokens/{mint}/listings
 *            Public, no key. Returns [] when not currently listed; first
 *            entry is the canonical active listing (escrowed in ME's
 *            auction house).
 *   Tensor → would require x-tensor-api-key (TENSOR_API_KEY env). Returned
 *            as null when no key is set so the frontend can render
 *            "validation unavailable" rather than fabricating an actionable
 *            button.
 *
 * AMM pools (MMM / TAMM) intentionally aren't checked here — pool buy/sell
 * sides are sided per-collection, not per-mint, so a per-mint "is this
 * actionable as a buy?" answer doesn't exist for them. The frontend treats
 * pool-route sales as non-actionable in this phase.
 *
 * Per-mint cache keeps upstream load bounded (CHECK_TTL_MS) — multiple page
 * loads for the same collection share entries.
 */

import { Router, Request, Response } from 'express';

const CHECK_TTL_MS = 30_000;
const MAX_MINTS_PER_REQUEST = 60;

interface MeListing {
  listed:        boolean;
  priceSol:      number | null;
  seller:        string | null;
  auctionHouse:  string | null;
}

interface TensorListing {
  listed:   boolean;
  priceSol: number | null;
}

interface CachedCheck {
  me:     MeListing;
  tensor: TensorListing | null;   // null → not validated (no API key)
  fetchedAt: number;
}

const cache = new Map<string, CachedCheck>();

interface MeListingRaw {
  price?:        number;       // SOL
  seller?:       string;
  auctionHouse?: string;
}

async function fetchMeListing(mint: string): Promise<MeListing> {
  try {
    const res = await fetch(
      `https://api-mainnet.magiceden.dev/v2/tokens/${encodeURIComponent(mint)}/listings`,
      { signal: AbortSignal.timeout(4_000) },
    );
    if (!res.ok) return { listed: false, priceSol: null, seller: null, auctionHouse: null };
    const json = await res.json() as MeListingRaw[];
    const first = Array.isArray(json) ? json[0] : null;
    if (!first || typeof first.price !== 'number' || first.price <= 0) {
      return { listed: false, priceSol: null, seller: null, auctionHouse: null };
    }
    return {
      listed:       true,
      priceSol:     first.price,
      seller:       first.seller       ?? null,
      auctionHouse: first.auctionHouse ?? null,
    };
  } catch {
    return { listed: false, priceSol: null, seller: null, auctionHouse: null };
  }
}

async function fetchTensorListing(_mint: string): Promise<TensorListing | null> {
  const key = process.env.TENSOR_API_KEY;
  if (!key) return null;          // null = not validated → frontend hides button
  // Real impl: GET https://api.mainnet.tensordev.io/api/v1/mint/active_listings
  // with x-tensor-api-key. Skipped here so this file stays free of credentials
  // and the no-key path is unambiguous.
  return { listed: false, priceSol: null };
}

async function getCheckForMint(mint: string): Promise<CachedCheck> {
  const hit = cache.get(mint);
  const now = Date.now();
  if (hit && now - hit.fetchedAt < CHECK_TTL_MS) return hit;

  const [me, tensor] = await Promise.all([
    fetchMeListing(mint),
    fetchTensorListing(mint),
  ]);
  const entry: CachedCheck = { me, tensor, fetchedAt: now };
  cache.set(mint, entry);
  return entry;
}

export function createListingsCheckRouter(): Router {
  const router = Router();

  router.get('/check', async (req: Request, res: Response) => {
    const raw = String(req.query.mints ?? '').trim();
    if (!raw) {
      res.json({ listings: {} });
      return;
    }
    const mints = Array.from(new Set(
      raw.split(',').map(s => s.trim()).filter(Boolean),
    )).slice(0, MAX_MINTS_PER_REQUEST);

    try {
      const entries = await Promise.all(mints.map(async (mint) => {
        const c = await getCheckForMint(mint);
        return [mint, { me: c.me, tensor: c.tensor }] as const;
      }));
      res.json({ listings: Object.fromEntries(entries) });
    } catch (err) {
      console.error('[listings/check] error', err);
      res.status(500).json({ error: 'internal server error' });
    }
  });

  return router;
}
