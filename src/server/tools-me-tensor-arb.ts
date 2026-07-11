/**
 * ME-vs-Tensor arbitrage lookup — read-only, one collection per request.
 *
 * Reuses the existing `listings-store.ts` snapshot engine (ME direct + MMM
 * sell-side pools + Tensor active_listings, already normalized into one
 * `Listing` schema) instead of fetching anything new: `ensureFresh(slug)`
 * only re-hits upstream when that slug's TTL has expired, so repeat lookups
 * on a hot collection are cache-fast, not a fresh scan every time.
 *
 * Answers exactly one question: which ME/MMM-side listings are currently
 * priced below Tensor's own cheapest active listing for the same
 * collection. Tensor floor is computed from the FULL fetched Tensor set,
 * not the cheapest-portion-trimmed view `collection-listings.ts` serves the
 * Collection page — that trim is a UI concern for this route.
 *
 * Input accepts four shapes, auto-detected:
 *   - ME collection slug        (e.g. "solfussisters0")     — used as-is.
 *   - Tensor collection slug    — passed through as-is too; `resolveTensorMeta`
 *     (inside listings-store's fetchTensor) already tries several slug-shape
 *     candidates, so a Tensor-native slug usually resolves on the Tensor side
 *     even when it differs from ME's. The ME/MMM side simply comes back empty
 *     for a slug ME doesn't recognize — same as any collection with no ME
 *     presence.
 *   - On-chain collection address — passed through as-is; Tensor's
 *     `find_collection` filter accepts an address directly (same trick
 *     `collection-bids.ts`'s cnft-floor-by-address already relies on).
 *   - An individual NFT mint address — resolved to its ME collection slug via
 *     the public, keyless `GET /v2/tokens/:mint` (`.collection` field) before
 *     doing anything else. Falls back to treating the mint itself as a
 *     collection address if ME doesn't know it (e.g. a Tensor-only cNFT).
 */

import { Router, Request, Response } from 'express';
import { ensureFresh, getByCollection } from './listings-store';
import { rateLimit, isValidSlug, isValidMint } from './rate-limit';
import { getMeTokenData } from '../enrichment/me-token-cache';

export interface ArbListing {
  mint:      string;
  priceSol:  number;
  seller:    string;
  source:    'ME' | 'MMM';
  rank:      number | null;
  listedAt:  number | null;
  nftName:   string | null;
  imageUrl:  string | null;
  /** tensorFloorSol / priceSol — how many times cheaper than Tensor. */
  multiple:  number;
}

/** `.collection` is the ME slug when ME has indexed this mint under a
 *  collection. Delegates to the shared `getMeTokenData()` client
 *  (`../enrichment/me-token-cache`) for the actual `GET /v2/tokens/:mint`
 *  fetch — cache, in-flight dedup, timeout, and cooldown integration all
 *  live there now instead of this file's own now-removed TTL map. */
async function resolveMintToMeSlug(mint: string): Promise<string | null> {
  const data = await getMeTokenData(mint);
  return data.slug;
}

type ResolveOutcome =
  | { ok: true; slug: string; resolvedVia: 'slug' | 'me-mint-lookup' | 'address-passthrough' }
  | { ok: false };

async function resolveInput(raw: string): Promise<ResolveOutcome> {
  if (isValidSlug(raw)) {
    return { ok: true, slug: raw, resolvedVia: 'slug' };
  }
  if (isValidMint(raw)) {
    const meSlug = await resolveMintToMeSlug(raw);
    if (meSlug) return { ok: true, slug: meSlug, resolvedVia: 'me-mint-lookup' };
    // Not a known ME-indexed NFT mint — could already be a bare collection
    // address (cNFT collections without an ME slug). Pass it straight
    // through; the Tensor side resolves addresses directly, ME/MMM simply
    // returns nothing for a string it doesn't recognize as a slug.
    return { ok: true, slug: raw, resolvedVia: 'address-passthrough' };
  }
  return { ok: false };
}

export function createMeTensorArbRouter(): Router {
  const router = Router();
  const arbLimit = rateLimit({ limit: 30, windowMs: 60_000, label: 'tools/me-tensor-arb' });

  router.get('/tools/me-tensor-arb', arbLimit, async (req: Request, res: Response) => {
    const raw = String(req.query.q ?? req.query.slug ?? '').trim();
    if (!raw) {
      res.status(400).json({ error: 'invalid_input' });
      return;
    }
    const resolved = await resolveInput(raw);
    if (!resolved.ok) {
      res.status(400).json({ error: 'invalid_input', message: 'Expected a collection slug, collection address, or NFT mint address.' });
      return;
    }
    if (!process.env.TENSOR_API_KEY) {
      res.status(503).json({ error: 'tensor_api_key_missing' });
      return;
    }

    const { slug, resolvedVia } = resolved;
    try {
      await ensureFresh(slug);
      const rows = getByCollection(slug);

      const tensorPrices = rows.filter(r => r.source === 'TENSOR').map(r => r.priceSol);
      if (tensorPrices.length === 0) {
        res.json({ ok: true, resolvedSlug: slug, resolvedVia, tensorFloorSol: null, tensorListedCount: 0, listings: [] });
        return;
      }
      const tensorFloorSol = Math.min(...tensorPrices);

      const listings: ArbListing[] = rows
        .filter(r => r.source !== 'TENSOR' && r.priceSol < tensorFloorSol)
        .sort((a, b) => a.priceSol - b.priceSol)
        .map(r => ({
          mint:     r.mint,
          priceSol: r.priceSol,
          seller:   r.seller,
          source:   r.source as 'ME' | 'MMM',
          rank:     r.rank,
          listedAt: r.listedAt,
          nftName:  r.nftName,
          imageUrl: r.imageUrl,
          multiple: tensorFloorSol / r.priceSol,
        }));

      res.json({ ok: true, resolvedSlug: slug, resolvedVia, tensorFloorSol, tensorListedCount: tensorPrices.length, listings });
    } catch (err) {
      console.error('[tools/me-tensor-arb] error', err);
      res.status(500).json({ error: 'internal' });
    }
  });

  return router;
}
