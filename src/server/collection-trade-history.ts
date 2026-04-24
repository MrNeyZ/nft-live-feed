/**
 * Collection Terminal trade-history endpoint — canonical source for the
 * TRADES panel's initial load.
 *
 * Before: the Collection page fetched /api/events/by-collection which
 * reconstructed history from `sale_events` — a mix of live raw-parser
 * rows and detached-backfill rows (`me_v2_backfill`) whose side / type /
 * naming relied on weak inference (default `normal_sale`, default
 * `legacy`, slug-prefix fallback names). The result on the UI was BUY
 * rows with generic names.
 *
 * Now: this endpoint fetches Magic Eden's public activity feed directly
 * (`/v2/collections/{slug}/activities?type=buyNow`), normalizes each row
 * into the same `RestRow` shape the frontend already consumes via
 * `fromRow()`, and returns `{ events, count, since, source }`. Price,
 * buyer, seller, blockTime, image, and marketplace come straight from
 * ME so the page matches what magiceden.io/marketplace/<slug> shows
 * for the same collection.
 *
 * Side classification (BUY vs SELL) — critical for a trading terminal:
 *   - `type=acceptBid`                      → bid_sell (side='sell')
 *   - `type=buyNow` + source=mmm, buyer ∈ pool-set → bid_sell (user SOLD into pool)
 *   - `type=buyNow` + source=mmm, seller ∈ pool-set → pool_buy (user BOUGHT from pool)
 *   - `type=buyNow` + source=magiceden_v2 / tensor → normal_sale
 * The ME activities endpoint ignores its own `type=` query param and
 * returns the full activity mix; we therefore fetch unfiltered and
 * filter to sale types locally.  MMM pool wallets are detected by
 * frequency across the page (a pool shows up 2+ times; retail wallets
 * almost never repeat in a single collection's recent page).
 *
 * Fallback: on any ME error (network, 5xx, bad payload) we fall back to
 * the legacy `getEventsByCollection()` DB path so the page never goes
 * dark.
 *
 * Per-(slug,days,limit) TTL cache shared across concurrent dashboard
 * tabs so this doesn't become a per-request ME hammer.
 */

import { Router, Request, Response } from 'express';
import { getEventsByCollection } from '../db/queries';

const ME_API           = 'https://api-mainnet.magiceden.dev/v2';
const PAGE_SIZE        = 500;
const MAX_PAGES        = 4;          // up to ~2 000 activities per refresh
const FETCH_TIMEOUT_MS = 6_000;
const TTL_MS           = 30_000;
const HARD_LIMIT       = 5_000;
const DEFAULT_DAYS     = 7;
const MAX_DAYS         = 90;

interface MeActivity {
  signature?:        string;
  type?:             string;
  source?:           string;          // 'magiceden_v2' | 'mmm' | 'tensor_marketplace'
  tokenMint?:        string;
  collection?:       string;
  collectionSymbol?: string;
  slot?:             number;
  blockTime?:        number;          // unix seconds
  buyer?:            string;
  seller?:           string;
  price?:            number;          // SOL (rounded)
  image?:            string;
}

// Mirrors `RestRow` in frontend/src/types.ts so the frontend's `fromRow()`
// consumes the response unchanged.
interface RestRow {
  id:                 string;
  signature:          string;
  block_time:         string;
  marketplace:        string;
  nft_type:           string;
  sale_type:          string | null;
  mint_address:       string;
  collection_address: string | null;
  seller:             string;
  buyer:              string;
  price_sol:          string;
  currency:           string;
  nft_name:           string | null;
  image_url:          string | null;
  collection_name:    string | null;
  magic_eden_url:     string | null;
  me_collection_slug: string | null;
  parser_source:      string | null;
}

function marketplaceFor(source: string | undefined): string {
  if (source === 'mmm')                return 'magic_eden_amm';
  if (source === 'tensor_marketplace') return 'tensor';
  return 'magic_eden';
}

/**
 * Classify a ME activity as one of:
 *   normal_sale — standard buy-now off a direct listing
 *   pool_buy    — user bought FROM an MMM pool (side='buy')
 *   bid_sell    — user SOLD into a pool / took a bid (side='sell')
 *
 * ME's activity feed labels both directions of an MMM pool fill as
 * `type=buyNow` + `source=mmm`, so the type alone cannot distinguish a
 * pool buy from an instant sale. MMM pool wallets appear in many rows
 * of a single activity page (listings, bids, poolUpdates, multiple
 * fills) while retail wallets rarely repeat. For each buyNow+mmm row
 * the pool is the side with HIGHER overall page frequency — this is
 * robust against a retail wallet that happens to flip an NFT twice
 * (freq=2 tie) because the real pool typically appears 5-40× on the
 * same page. `acceptBid` always maps to bid_sell regardless of source.
 */
function saleTypeForRow(
  a: MeActivity,
  wfreq: Map<string, number>,
): string {
  if (a.type === 'acceptBid') return 'bid_sell';
  if (a.source === 'mmm') {
    const bf = a.buyer  ? (wfreq.get(a.buyer)  ?? 0) : 0;
    const sf = a.seller ? (wfreq.get(a.seller) ?? 0) : 0;
    // Pool = side with higher frequency. Require at least one side to be
    // a likely pool (freq >= 2); otherwise we can't tell — default to the
    // safe `pool_buy` so non-pool edge cases don't regress into false SELLs.
    if (bf >= 2 && bf > sf) return 'bid_sell';
    if (sf >= 2 && sf > bf) return 'pool_buy';
    return 'pool_buy';
  }
  return 'normal_sale';
}

// Frequency of each wallet across source=mmm rows (as buyer OR seller).
function buildMmmWalletFreq(activities: MeActivity[]): Map<string, number> {
  const freq = new Map<string, number>();
  for (const a of activities) {
    if (a.source !== 'mmm') continue;
    if (a.buyer)  freq.set(a.buyer,  (freq.get(a.buyer)  ?? 0) + 1);
    if (a.seller) freq.set(a.seller, (freq.get(a.seller) ?? 0) + 1);
  }
  return freq;
}

// Only these activity types represent actual trade fills. Everything else
// (`list`, `delist`, `bid`, `cancelBid`, `poolUpdate`) is not a sale and
// must be excluded even if it happens to have buyer+seller+price set.
const SALE_TYPES = new Set(['buyNow', 'acceptBid']);

function toRestRow(a: MeActivity, slug: string, wfreq: Map<string, number>): RestRow | null {
  if (!a.type || !SALE_TYPES.has(a.type))                    return null;
  if (!a.signature || !a.tokenMint || !a.buyer || !a.seller) return null;
  if (typeof a.price !== 'number'     || a.price     <= 0)   return null;
  if (typeof a.blockTime !== 'number' || a.blockTime <= 0)   return null;
  return {
    id:                 a.signature,
    signature:          a.signature,
    block_time:         new Date(a.blockTime * 1000).toISOString(),
    marketplace:        marketplaceFor(a.source),
    nft_type:           'legacy',                      // ME activities don't expose token standard
    sale_type:          saleTypeForRow(a, wfreq),
    mint_address:       a.tokenMint,
    collection_address: null,
    seller:             a.seller,
    buyer:              a.buyer,
    price_sol:          String(a.price),
    currency:           'SOL',
    nft_name:           null,                          // ME activities don't carry per-item name
    image_url:          a.image ?? null,
    collection_name:    null,
    magic_eden_url:     `https://magiceden.io/item-details/${a.tokenMint}`,
    me_collection_slug: slug,
    parser_source:      'me_activities',
  };
}

interface CacheEntry { events: RestRow[]; fetchedAt: number; source: 'me' | 'db' }
const cache = new Map<string, CacheEntry>();

async function fetchMeActivities(slug: string, cutoffSec: number, limit: number): Promise<RestRow[]> {
  // Use ME's `type=buyNow` filter. The previous code comment claimed ME
  // ignored `type=`, which is false for `buyNow`: it returns pure buyNow
  // pages (500/pg), so a single page reaches months back instead of hours.
  // On pool-heavy collections (gboy_badges_, degods) the unfiltered feed is
  // 95%+ list/poolUpdate/bid noise, which is why the old path surfaced only
  // a handful of sales. `acceptBid` is omitted: ME ignores `type=acceptBid`
  // (returns the unfiltered mix) and those rows are rare enough that going
  // back to the noisy path for them would cost far more than it gains.
  // MMM pool fills still arrive here — they come through as `buyNow` with
  // `source=mmm` and are classified into pool_buy / bid_sell by wallet
  // frequency, same as before.
  const allActivities: MeActivity[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    if (allActivities.length >= limit * 4) break; // soft ceiling vs. runaway pages
    const offset = page * PAGE_SIZE;
    const url = `${ME_API}/collections/${encodeURIComponent(slug)}/activities?type=buyNow&offset=${offset}&limit=${PAGE_SIZE}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`ME activities HTTP ${res.status}`);
    const json = await res.json() as MeActivity[];
    if (!Array.isArray(json) || json.length === 0) break;
    let oldestAtCutoff = false;
    for (const a of json) {
      if (typeof a.blockTime === 'number' && a.blockTime < cutoffSec) { oldestAtCutoff = true; continue; }
      allActivities.push(a);
    }
    if (oldestAtCutoff) break;
    if (json.length < PAGE_SIZE) break;
  }
  const wfreq = buildMmmWalletFreq(allActivities);
  const out: RestRow[] = [];
  for (const a of allActivities) {
    const row = toRestRow(a, slug, wfreq);
    if (row) out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

export function createCollectionTradeHistoryRouter(): Router {
  const router = Router();

  router.get('/trade-history', async (req: Request, res: Response) => {
    const slug = String(req.query.slug ?? '').trim();
    if (!slug) { res.status(400).json({ error: 'missing slug' }); return; }

    const rawDays = parseInt(String(req.query.days ?? DEFAULT_DAYS), 10);
    const days = Number.isFinite(rawDays) && rawDays > 0
      ? Math.min(rawDays, MAX_DAYS)
      : DEFAULT_DAYS;
    const rawLimit = parseInt(String(req.query.limit ?? HARD_LIMIT), 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, HARD_LIMIT)
      : HARD_LIMIT;

    const now = Date.now();
    const cacheKey = `${slug}|${days}|${limit}`;
    const hit = cache.get(cacheKey);
    if (hit && now - hit.fetchedAt < TTL_MS) {
      res.json({
        events: hit.events,
        count:  hit.events.length,
        since:  new Date(now - days * 86_400_000).toISOString(),
        source: hit.source,
      });
      return;
    }

    const since = new Date(now - days * 86_400_000);
    const cutoffSec = Math.floor((now - days * 86_400_000) / 1000);

    // DB is authoritative for slugs our pipeline has been ingesting long
    // enough to cover the whole window. For recently-discovered slugs our DB
    // may hold only a handful of sales (e.g. `sensei` at ~4 rows / 7d) while
    // ME's activities feed covers far more history. Run both in parallel and
    // pick whichever returns more rows — ME's shallow-pagination weakness on
    // high-pool-churn collections (degods etc.) is still handled because
    // those also have rich DB history that wins on count.
    let dbEvents: RestRow[] = [];
    try {
      dbEvents = await getEventsByCollection(slug, since, limit) as unknown as RestRow[];
    } catch (dbErr) {
      console.warn(`[trade-history] DB query failed slug=${slug}:`, (dbErr as Error).message);
    }

    let meEvents: RestRow[] = [];
    try {
      meEvents = await fetchMeActivities(slug, cutoffSec, limit);
    } catch (err) {
      console.warn(`[trade-history] ME fetch failed slug=${slug}:`, (err as Error).message);
    }

    if (dbEvents.length === 0 && meEvents.length === 0) {
      res.status(500).json({ error: 'internal' });
      return;
    }

    const useMe = meEvents.length > dbEvents.length;
    const events = useMe ? meEvents : dbEvents;
    const source: 'me' | 'db' = useMe ? 'me' : 'db';
    cache.set(cacheKey, { events, fetchedAt: Date.now(), source });
    res.json({
      events,
      count:  events.length,
      since:  since.toISOString(),
      source,
    });
  });

  return router;
}
