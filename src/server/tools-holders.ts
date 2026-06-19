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
import { resolveNameToCollection, isValidName } from '../tools-holders/resolve-name';
import type { HoldersInputType } from '../tools-holders/types';

export function createHoldersRouter(): Router {
  const router = Router();
  // Multi-RPC-page scan per request — cap tighter than the single-call analyzer.
  const limit = rateLimit({ limit: 15, windowMs: 60_000, label: 'tools/holders' });

  router.get('/tools/holders/analyze', limit, async (req: Request, res: Response) => {
    const collection = String(req.query.collection ?? '').trim();
    const slug       = String(req.query.slug ?? '').trim();
    const name       = String(req.query.name ?? '').trim();

    // Resolve the request to (inputType, inputValue, on-chain address). Priority
    // is address → slug → name. The address flow is unchanged; slug and name
    // resolve to an on-chain collection BEFORE any holder counting (counts stay
    // DAS-only). Name resolves name → catalog slug → address, and refuses to
    // guess: an ambiguous name returns candidates instead of a silent pick.
    let inputType: HoldersInputType;
    let inputValue: string;
    let address: string;
    let resolvedName: string | undefined;
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
    } else if (name) {
      if (!isValidName(name)) {
        return res.status(400).json({ ok: false, error: 'invalid_name' });
      }
      let resolution;
      try {
        resolution = await resolveNameToCollection(name);
      } catch (err) {
        console.error('[tools/holders] name resolve error', err);
        return res.status(502).json({ ok: false, error: 'rpc_error' });
      }
      // Never silently pick one of several — hand the candidates back so the
      // caller can disambiguate.
      if (resolution.ambiguous) {
        return res.status(409).json({ ok: false, error: 'ambiguous_name', candidates: resolution.ambiguous });
      }
      if (!resolution.collectionAddress) {
        return res.status(404).json({ ok: false, error: `name_unresolved:${resolution.error ?? 'unknown'}` });
      }
      inputType = 'name';
      inputValue = name;
      address = resolution.collectionAddress;
      resolvedName = resolution.name ?? undefined;
      extraWarnings.push(
        resolution.approximate
          ? `No exact match for "${name}" — using closest verified collection "${resolution.name}" (${resolution.slug}) → ${address}. Verify the address, or paste the exact slug/address if wrong.`
          : `Name "${name}" matched verified collection "${resolution.name}" (${resolution.slug}) → ${address}.`,
      );
    } else {
      return res.status(400).json({ ok: false, error: 'missing_collection_slug_or_name' });
    }

    try {
      const scan = await fetchCollectionOwners(address);
      const analysis = buildHoldersAnalysis({
        ...scan,
        collectionAddress: address,
        inputType,
        inputValue,
        resolvedName,
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
