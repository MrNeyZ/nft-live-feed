/**
 * Tensor Low-Floor Scanner — read API.
 *
 *   GET /api/tools/tensor-floor-scan/scan-stream?force=0
 *
 * SSE, same event contract as tools-spl20.ts's scan-stream (progress /
 * result / error). Full-market sweep of every Tensor-indexed collection
 * (~38.6k, paginated 100/page via GET /collections) for legacy / pNFT
 * collections whose real cheapest active listing is under
 * SCAN_CUTOFF_LAMPORTS. Excludes MPL Core, cNFT, SPL-20, inscriptions,
 * Token-2022, and SFT (FUNGIBLE_ASSET) — legacy + pNFT only.
 *
 * Collection-level flags (`compressed`, `tokenProgram`, cached
 * `stats.buyNowPrice`) are NOT trustworthy for small/old collections —
 * confirmed live 2026-08-10: several collections flagged
 * `compressed: false` had an actually-compressed cheapest mint (old
 * DRiP-airdrop collections), and one collection's cached `buyNowPrice` was
 * stale by ~2x versus its real cheapest active listing. So the collection-
 * level pass is only a cheap PRE-filter — every survivor is re-verified
 * against its real cheapest active listing (`/mint/active_listings`,
 * per-mint tokenStandard / tokenProgram / compressed / inscription) before
 * being returned. The pre-filter narrows ~38.6k down to a couple dozen; the
 * per-mint check is the actual source of truth.
 *
 * Runs its own bounded-concurrency retry client, NOT the shared
 * `tensorFetch` chain in listings-store.ts — that chain is a strict
 * 1 req/sec throttle shared with live sales enrichment across the whole
 * site, and this scan is ~450-500 Tensor calls; serializing it through the
 * shared chain would stall Tensor-derived data sitewide for the run.
 *
 * NOTE on `[rare/rarity] tensor 429 — cooling down` (rare-feed's own
 * Tensor client, src/rare-feed/providers/tensor.ts): checked live
 * 2026-08-10 — this fires on its own baseline cadence (every few minutes,
 * confirmed present in logs hours before this scanner ever ran), so it's a
 * pre-existing condition in that provider, not something this scanner
 * causes. Still, Tensor's rate limit is per-API-key, and a ~450-900-call
 * scan is a heavy burst against a key other features share — `tensorGet`
 * treats a 429 specially (hard backoff, respects `Retry-After`) rather
 * than retrying at the same rate, as reasonable citizenship even though it
 * isn't fixing an observed regression.
 *
 * Read-only. No wallet, no signing, no tx building.
 */
import { Router, Request, Response } from 'express';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { rateLimit } from './rate-limit';

const TENSOR_BASE = 'https://api.mainnet.tensordev.io/api/v1';
const PAGE_LIMIT = 100;
// Wider than any UI-facing threshold so lowering the on-page filter never
// needs a rescan — the UI filters this cached set client-side.
// Confirmed live 2026-08-10: 10M (0.01 SOL) pulled 809 pre-filter hits —
// verification (one Tensor call per hit) became impractically slow. 8M
// keeps real headroom over the UI's 0.0075 default without ballooning the
// verification phase.
const SCAN_CUTOFF_LAMPORTS = 8_000_000; // 0.008 SOL
const SCAN_CACHE_TTL_MS = 20 * 60 * 1000; // matches tools-spl20.ts / tools-mmm-pools.ts convention
const CONCURRENCY = 4;

const EXCLUDE_TOKEN_PROGRAM = new Set(['MPL_CORE', 'SPL_TOKEN_2022']);
const EXCLUDE_TOKEN_STANDARD = new Set(['FUNGIBLE_ASSET']);

interface RawRow {
  name: string;
  slugDisplay: string;
  collId: string;
  tokenStandard: string | null;
  numListed: number;
  royaltyBps: number | null;
}

export interface FloorCandidate {
  name: string;
  slugDisplay: string;
  collId: string;
  tokenStandard: 'NON_FUNGIBLE' | 'PROGRAMMABLE_NON_FUNGIBLE' | string | null;
  listingPriceLamports: number;
  numListed: number;
  royaltyBps: number | null;
  tensorUrl: string;
}

interface ScanCacheShape {
  builtAt: number;
  candidates: FloorCandidate[];
  totalCollections: number;
}

type Emit = (type: string, data: Record<string, unknown>) => void;

async function tensorGet(path: string, retries = 4): Promise<any | null> {
  const key = process.env.TENSOR_API_KEY;
  if (!key) return null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(`${TENSOR_BASE}${path}`, {
        headers: { 'x-tensor-api-key': key, Accept: 'application/json' },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) return await res.json();
      if (res.status === 429) {
        // Back off much harder than a normal retry — this is the shared
        // per-key limit, not a transient blip. Respect Retry-After when
        // Tensor sends one; otherwise a fixed 10s cooldown.
        const retryAfterSec = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfterSec) && retryAfterSec > 0 ? retryAfterSec * 1000 : 10_000;
        await new Promise(r => setTimeout(r, waitMs));
        continue;
      }
    } catch { /* retry below */ }
    await new Promise(r => setTimeout(r, Math.min(2 ** attempt * 500, 8_000)));
  }
  return null;
}

/** Runs `worker` over `items` with at most `concurrency` in flight. */
async function forEachConcurrent<T>(items: T[], concurrency: number, worker: (item: T, idx: number) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const idx = next++;
      if (idx >= items.length) return;
      await worker(items[idx], idx);
    }
  }));
}

function passesCollectionPrefilter(c: any): boolean {
  const bnp = Number(c?.stats?.buyNowPrice);
  if (!Number.isFinite(bnp) || bnp <= 0 || bnp >= SCAN_CUTOFF_LAMPORTS) return false;
  if (c.compressed) return false;
  if (c.spl20) return false;
  if (c.inscription || c.inscriptionMetaplex) return false;
  if (EXCLUDE_TOKEN_PROGRAM.has(c.tokenProgram)) return false;
  if (EXCLUDE_TOKEN_STANDARD.has(c.tokenStandard)) return false;
  return true;
}

async function scanAllPages(emit: Emit): Promise<{ rows: RawRow[]; total: number }> {
  const first = await tensorGet(`/collections?sortBy=createdAt:asc&limit=${PAGE_LIMIT}&page=1`);
  if (!first || typeof first.total !== 'number') throw new Error('tensor_unreachable');
  const total = first.total as number;
  const totalPages = Math.ceil(total / PAGE_LIMIT);
  const rows: RawRow[] = [];

  const collect = (data: any) => {
    for (const c of data?.collections ?? []) {
      if (!passesCollectionPrefilter(c)) continue;
      rows.push({
        name: c.name ?? c.slugDisplay ?? 'unknown',
        slugDisplay: c.slugDisplay,
        collId: c.collId,
        tokenStandard: c.tokenStandard ?? null,
        numListed: c.stats?.numListed ?? 0,
        royaltyBps: typeof c.sellRoyaltyFeeBPS === 'number' ? c.sellRoyaltyFeeBPS : null,
      });
    }
  };
  collect(first);
  emit('progress', { msg: `Page 1/${totalPages} — ${total} collections total` });

  let done = 1;
  const pages = Array.from({ length: totalPages - 1 }, (_, i) => i + 2);
  await forEachConcurrent(pages, CONCURRENCY, async (page) => {
    const data = await tensorGet(`/collections?sortBy=createdAt:asc&limit=${PAGE_LIMIT}&page=${page}`);
    if (data) collect(data);
    done++;
    if (done % 20 === 0 || done === totalPages) {
      emit('progress', { msg: `Scanned ${done}/${totalPages} pages — ${rows.length} pre-filter hits so far` });
    }
  });

  return { rows, total };
}

async function verifyCandidates(rows: RawRow[], emit: Emit): Promise<FloorCandidate[]> {
  const out: FloorCandidate[] = [];
  let checked = 0;
  await forEachConcurrent(rows, CONCURRENCY, async (row) => {
    const data = await tensorGet(`/mint/active_listings?collId=${row.collId}&sortBy=ListingPriceAsc&limit=1`);
    checked++;
    const mint = data?.mints?.[0];
    const price = Number(mint?.listing?.price);
    if (!mint || !Number.isFinite(price) || price <= 0 || price >= SCAN_CUTOFF_LAMPORTS) return;
    if (mint.compressed) return;
    if (mint.inscription) return;
    if (EXCLUDE_TOKEN_PROGRAM.has(mint.tokenProgram)) return;
    out.push({
      name: row.name,
      slugDisplay: row.slugDisplay,
      collId: row.collId,
      tokenStandard: mint.tokenStandard ?? row.tokenStandard ?? null,
      listingPriceLamports: price,
      numListed: row.numListed,
      royaltyBps: row.royaltyBps,
      tensorUrl: `https://www.tensor.trade/trade/${row.slugDisplay}`,
    });
  });
  emit('progress', { msg: `Verified ${checked} pre-filter hits against their real cheapest listing — ${out.length} confirmed` });
  return out.sort((a, b) => a.listingPriceLamports - b.listingPriceLamports);
}

async function runFullScan(emit: Emit): Promise<ScanCacheShape> {
  emit('progress', { msg: 'Fetching Tensor collection catalog — this is a ~450-request scan, expect a couple minutes…' });
  const { rows, total } = await scanAllPages(emit);
  emit('progress', { msg: `Pre-filter found ${rows.length} candidates — verifying each against its real cheapest listing…` });
  const candidates = await verifyCandidates(rows, emit);
  return { builtAt: Date.now(), candidates, totalCollections: total };
}

const SCAN_CACHE_FILE = join(__dirname, '..', '..', 'data', 'tensor-floor-scan-cache.json');

function loadScanCacheFromDisk(): ScanCacheShape | null {
  try {
    const parsed = JSON.parse(readFileSync(SCAN_CACHE_FILE, 'utf-8')) as Partial<ScanCacheShape>;
    if (parsed && Array.isArray(parsed.candidates) && typeof parsed.builtAt === 'number') {
      return { builtAt: parsed.builtAt, candidates: parsed.candidates as FloorCandidate[], totalCollections: parsed.totalCollections ?? 0 };
    }
  } catch { /* missing/corrupt — fine, first run will rebuild */ }
  return null;
}
function saveScanCacheToDisk(cache: ScanCacheShape): void {
  try { writeFileSync(SCAN_CACHE_FILE, JSON.stringify(cache)); } catch { /* best-effort */ }
}

let scanCache: ScanCacheShape | null = loadScanCacheFromDisk();
let scanInFlight: Promise<ScanCacheShape> | null = null;

export function createTensorFloorScanRouter(): Router {
  const router = Router();
  const scanLimit = rateLimit({ limit: 4, windowMs: 5 * 60 * 1000, label: 'tools/tensor-floor-scan' });

  router.get('/tools/tensor-floor-scan/scan-stream', scanLimit, (req: Request, res: Response) => {
    const force = req.query.force === '1';
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    const emit: Emit = (type, data) => {
      try { res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`); } catch { /* client gone */ }
    };

    void (async () => {
      try {
        if (!process.env.TENSOR_API_KEY) {
          emit('error', { msg: 'TENSOR_API_KEY not configured on the backend — this tool is a no-op without it.' });
          res.end();
          return;
        }
        if (!force && scanCache && Date.now() - scanCache.builtAt < SCAN_CACHE_TTL_MS) {
          const ageMs = Date.now() - scanCache.builtAt;
          emit('progress', { msg: `Cached (${Math.floor(ageMs / 60_000)}m ago) — ${scanCache.candidates.length} candidates` });
          emit('result', { candidates: scanCache.candidates, cached: true, cacheAgeMs: ageMs, totalCollections: scanCache.totalCollections });
          res.end();
          return;
        }
        if (scanInFlight) {
          emit('progress', { msg: 'A scan is already running — attaching to it…' });
          const c = await scanInFlight;
          emit('result', { candidates: c.candidates, cached: false, cacheAgeMs: 0, totalCollections: c.totalCollections });
          res.end();
          return;
        }
        scanInFlight = runFullScan(emit).finally(() => { scanInFlight = null; });
        const c = await scanInFlight;
        scanCache = c;
        saveScanCacheToDisk(c);
        emit('progress', { msg: `Done — ${c.candidates.length} candidates confirmed` });
        emit('result', { candidates: c.candidates, cached: false, cacheAgeMs: 0, totalCollections: c.totalCollections });
      } catch (err) {
        console.error('[tools/tensor-floor-scan] error', err);
        emit('error', { msg: String(err) });
      }
      res.end();
    })();
  });

  return router;
}
