/**
 * Bid List — static snapshot of forgotten Solanart/SolSea bids sitting on
 * NFTs currently held by real, active (<=60d) personal wallets.
 *
 * Built offline (research/solanart-solsea-forgotten-bids/) via a full
 * on-chain scan of both dead marketplaces' bid/offer program accounts,
 * cross-checked against DAS for current ownership + live escrow funding +
 * ME floor price. Not a live scanner — this file just serves the
 * pre-built, hand-verified snapshot. Re-generate manually if it goes
 * stale (see research/ scripts).
 *
 * GET /api/tools/bid-list — read-only, no wallet, no signing.
 */
import { Router, Request, Response } from 'express';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { rateLimit } from './rate-limit';
import { requireAuth } from './runtime';

const DATA_PATH = join(__dirname, '..', '..', 'data', 'bid-list.json');
const THUMB_DIR = join(__dirname, '..', '..', 'data', 'bid-list-thumbs');
/** Base58 mint address — same shape validated everywhere else in this repo
 *  (ADDR_RE on the frontend). Guards the on-disk path lookup below. */
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface BidListRow {
  mint: string;
  name: string | null;
  image: string | null;
  collectionSymbol: string | null;
  collectionName: string | null;
  priceSol: number;
  marketplace: 'solsea' | 'solanart';
  owner: string;
  escrow: string;
  lastActive: number | null;
  floorSol: number | null;
  spreadSol: number | null;
}

let cached: { builtAt: number; rows: BidListRow[] } | null = null;

function loadRows(): { builtAt: number; rows: BidListRow[] } {
  if (cached) return cached;
  const raw = JSON.parse(readFileSync(DATA_PATH, 'utf-8')) as BidListRow[];
  cached = { builtAt: Date.now(), rows: raw };
  return cached;
}

export function createBidListRouter(): Router {
  const router = Router();
  const readLimit = rateLimit({ limit: 30, windowMs: 60_000, label: 'tools/bid-list' });

  router.get('/tools/bid-list', readLimit, requireAuth, (_req: Request, res: Response) => {
    try {
      const { builtAt, rows } = loadRows();
      res.json({ ok: true, builtAt, count: rows.length, rows });
    } catch (err) {
      res.status(500).json({ ok: false, error: String(err) });
    }
  });

  // Cached 128x128 WebP thumbnails — pinned to the mint at offline-build
  // time (see cache_thumbs.js in research/), not fetched live from the
  // original (often dead/slow 2022-era) host on every page load. No
  // requireAuth here deliberately: <img> tags can't attach the Bearer
  // token, and these are already-public, already-cropped NFT preview
  // images — same trust level as any static asset.
  const thumbLimit = rateLimit({ limit: 300, windowMs: 60_000, label: 'tools/bid-list/thumb' });
  router.get('/tools/bid-list/thumb/:file', thumbLimit, (req: Request, res: Response) => {
    const file = req.params.file;
    const mint = file.endsWith('.webp') ? file.slice(0, -'.webp'.length) : '';
    if (!MINT_RE.test(mint)) { res.status(400).end(); return; }
    const filePath = join(THUMB_DIR, `${mint}.webp`);
    if (!existsSync(filePath)) { res.status(404).end(); return; }
    res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
    res.setHeader('Content-Type', 'image/webp');
    res.sendFile(filePath);
  });

  return router;
}
