/**
 * Holder Count Tool — read API.
 *
 *   GET /api/tools/holders/analyze?collection=<collectionAddress>
 *
 * Read-only: paginates Helius DAS getAssetsByGroup over a verified collection
 * group and returns an EXACT distinct-owner holder count plus distribution.
 * Source of truth is on-chain asset ownership — NOT Magic Eden / Tensor cached
 * holder stats. No wallet, no signing, no tx building, no DB writes.
 * Rate-limited so a stuck tab can't burn RPC credits.
 */
import { Router, Request, Response } from 'express';
import { rateLimit } from './rate-limit';
import { buildHoldersAnalysis } from '../tools-holders/analyze';
import { fetchCollectionOwners, isValidCollectionAddress } from '../tools-holders/fetch-assets';
import { resolveSlugToCollection, isValidSlug } from '../tools-holders/resolve-slug';
import type { HoldersInputType } from '../tools-holders/types';

export function createHoldersRouter(): Router {
  const router = Router();
  // Multi-RPC-page scan per request — cap tighter than the single-call analyzer.
  const limit = rateLimit({ limit: 15, windowMs: 60_000, label: 'tools/holders' });

  router.get('/tools/holders/analyze', limit, async (req: Request, res: Response) => {
    const collection = String(req.query.collection ?? '').trim();
    const slug       = String(req.query.slug ?? '').trim();

    // Resolve the request to (inputType, inputValue, on-chain address). The
    // address flow is unchanged; the slug flow resolves via marketplace →
    // sample mint → DAS group BEFORE any holder counting (counts stay DAS-only).
    let inputType: HoldersInputType;
    let inputValue: string;
    let address: string;
    const extraWarnings: string[] = [];

    if (collection) {
      if (!isValidCollectionAddress(collection)) {
        return res.status(400).json({ ok: false, error: 'invalid_collection_address' });
      }
      inputType = 'collection';
      inputValue = collection;
      address = collection;
    } else if (slug) {
      if (!isValidSlug(slug)) {
        return res.status(400).json({ ok: false, error: 'invalid_slug' });
      }
      let resolution;
      try {
        resolution = await resolveSlugToCollection(slug);
      } catch (err) {
        console.error('[tools/holders] slug resolve error', err);
        return res.status(502).json({ ok: false, error: 'rpc_error' });
      }
      if (!resolution.collectionAddress) {
        return res.status(404).json({ ok: false, error: `slug_unresolved:${resolution.error ?? 'unknown'}` });
      }
      inputType = 'slug';
      inputValue = slug;
      address = resolution.collectionAddress;
      extraWarnings.push(`Slug "${slug}" resolved to collection ${address} via a sample Magic Eden listing — verify the address if it looks wrong.`);
    } else {
      return res.status(400).json({ ok: false, error: 'missing_collection_or_slug' });
    }

    try {
      const scan = await fetchCollectionOwners(address);
      const analysis = buildHoldersAnalysis({
        ...scan,
        collectionAddress: address,
        inputType,
        inputValue,
        extraWarnings,
        nowIso: new Date().toISOString(),
      });
      return res.json({ ok: true, analysis });
    } catch (err) {
      console.error('[tools/holders] analyze error', err);
      return res.status(502).json({ ok: false, error: 'rpc_error' });
    }
  });

  return router;
}
