/**
 * ME Wallet/Collection Refresh Tool — read/action API.
 *
 *   POST /api/tools/me-collection-refresh?wallet=<address>&collectionAddress=<address optional>
 *
 * Scans every mint currently owned by `wallet` (optionally filtered to one
 * on-chain collection) via Helius DAS, and force-refreshes Magic Eden's own
 * per-NFT index for each one, batched, via ME's own client re-sync call
 * (`rpc/refreshNFTsByMintAddresses`) — see me-collection-refresh/refresh.ts
 * for how this was found and what it does (and does NOT) refresh.
 * Deliberately wallet-scoped: the real use case is a handful of NFTs whose
 * ME-cached state has drifted, not blanket-refreshing a whole collection.
 *
 * No wallet connect, no signing. Rate-limited — this fans out to a handful
 * of ME requests per call, cap tighter than a pure single-RPC read tool.
 */
import { Router, Request, Response } from 'express';
import { rateLimit } from './rate-limit';
import { refreshWalletNfts, getCollectionKind } from '../me-collection-refresh/refresh';
import { resolveSlugToCollection, isValidSlug } from '../tools-holders/resolve-slug';

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function createMeCollectionRefreshRouter(): Router {
  const router = Router();
  const limit = rateLimit({ limit: 10, windowMs: 60_000, label: 'tools/me-collection-refresh' });
  // Keystroke-driven (search dropdown badges) — looser cap, cached in the
  // resolver so repeat lookups for the same slug are free.
  const kindLimit = rateLimit({ limit: 60, windowMs: 60_000, label: 'tools/me-collection-refresh-kind' });

  router.get('/tools/me-collection-refresh/kind', kindLimit, async (req: Request, res: Response) => {
    const slug = String(req.query.slug ?? '').trim();
    if (!isValidSlug(slug)) {
      return res.status(400).json({ ok: false, error: 'invalid_slug' });
    }
    try {
      const kind = await getCollectionKind(slug);
      return res.json({ ok: true, slug, kind });
    } catch (err) {
      console.error('[tools/me-collection-refresh] kind error', err);
      return res.status(502).json({ ok: false, error: 'rpc_error' });
    }
  });

  router.post('/tools/me-collection-refresh', limit, async (req: Request, res: Response) => {
    const wallet = String(req.query.wallet ?? '').trim();
    const collectionAddress = String(req.query.collectionAddress ?? '').trim();
    const collectionSlug = String(req.query.collectionSlug ?? '').trim();
    if (!ADDR_RE.test(wallet)) {
      return res.status(400).json({ ok: false, error: 'invalid_wallet' });
    }
    if (collectionAddress && !ADDR_RE.test(collectionAddress)) {
      return res.status(400).json({ ok: false, error: 'invalid_collection_address' });
    }
    if (collectionSlug && !isValidSlug(collectionSlug)) {
      return res.status(400).json({ ok: false, error: 'invalid_collection_slug' });
    }

    try {
      // Name-search on the frontend resolves to a slug, not an on-chain
      // address — reuse the holders tool's existing slug→address resolver
      // (samples a live ME listing/activity for the mint, no guessing)
      // rather than re-deriving this. Explicit address input takes priority
      // when both are somehow present.
      let resolvedCollection = collectionAddress || undefined;
      if (!resolvedCollection && collectionSlug) {
        const resolution = await resolveSlugToCollection(collectionSlug);
        if (!resolution.collectionAddress) {
          return res.status(404).json({ ok: false, error: `slug_unresolved:${resolution.error ?? 'unknown'}` });
        }
        resolvedCollection = resolution.collectionAddress;
      }

      const result = await refreshWalletNfts(wallet, resolvedCollection);
      return res.json({ ok: true, resolvedCollectionAddress: resolvedCollection ?? null, ...result });
    } catch (err) {
      console.error('[tools/me-collection-refresh] error', err);
      const msg = err instanceof Error ? err.message : String(err);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  return router;
}
