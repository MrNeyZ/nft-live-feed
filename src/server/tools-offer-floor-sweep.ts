/**
 * ME Offer > Floor — full market sweep.
 *
 *   GET /api/tools/offer-floor-sweep/scan-stream?force=0&minVolSol=10&maxVolSol=
 *
 * SSE, same event contract as tools-tensor-floor-scan.ts / tools-spl20.ts
 * (progress / result / error). Two-phase scan:
 *
 *   Phase 1 (discovery, cheap): Tensor's bulk `/collections` endpoint,
 *   sorted by statsV2.volume7d desc. ME's own bulk collection list has
 *   ZERO stats fields (no floor/volume/listed-count — confirmed live
 *   2026-08-11), so it cannot be used to rank 38.6k collections by
 *   activity. Tensor is used ONLY for this discovery/filter step — it
 *   supplies the candidate collection list (via each collection's
 *   `slugMe` bridge field), nothing about offers. We walk pages sorted
 *   desc and stop once every remaining page is below `minVolSol`, keeping
 *   only rows within [minVolSol, maxVolSol] (approximated as
 *   volume7d * 30/7 since Tensor has no native 30d field). Default band
 *   (min=10, no max) confirmed live 2026-08-11: ~150-250 survivors out of
 *   38.6k. The 1-9.99 SOL/30d band (confirmed live 2026-08-11): 280
 *   survivors — still one feasible run, no need to sub-band further.
 *
 *   Phase 2 (the actual answer, ME-only): for each surviving collection,
 *   reuses `runScan` from tools-retardio-offers.ts unmodified — same
 *   ME listings + offers_received fetch, same REQUEST_GAP_MS pacing, same
 *   shared IP-wide cooldown on ME 429s. Called with activityMaxPages=0
 *   (skip the unlisted-candidate activity crawl — we only care about
 *   currently-listed mints with listingPrice to spread against) and a
 *   small scanLimit (cheapest N listings only — that's what's actually
 *   buyable, not every listing in the collection).
 *
 * Filter: bestOfferStatus !== 'EXPIRED' (keeps AVAILABLE + EXPECTED —
 * EXPECTED is ME's encoding for expiry<=0/missing, i.e. an infinite-
 * lifetime personal offer, same concept as an MMM pool's expiry=0) AND
 * spreadSol > 0 (offer strictly above the listing ask).
 *
 * This is a genuinely slow scan (~150-250 collections x up to
 * PER_COLLECTION_LIMIT listings each, each listing paying
 * REQUEST_GAP_MS) — expect low tens of minutes. Cached on disk with a
 * multi-hour TTL; runs in the background, streamed via SSE like the
 * other tools/*-scan endpoints.
 *
 * Read-only. No wallet, no signing, no tx building.
 */
import { Router, Request, Response } from 'express';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { rateLimit } from './rate-limit';
import { requireAuth } from './runtime';
import {
  runScan,
  MeRateLimitError,
  MeListingsUpstreamError,
  getMeCooldownRemainingSec,
  type ScanRow,
} from './tools-retardio-offers';

const TENSOR_BASE = 'https://api.mainnet.tensordev.io/api/v1';
const PAGE_LIMIT = 100;
/** Default lower bound is 10 SOL/30d, approximated via volume7d since
 *  Tensor has no native 30d stat. Override per-request via
 *  ?minVolSol=/&maxVolSol= to sweep a different band (e.g. 1-9.99 SOL/30d
 *  once the top band has been covered). */
const VOL_30D_TO_7D = 7 / 30;
/** Cheapest-N listings checked per surviving collection. These are the
 *  only mints actually worth buying, so there's no value in walking every
 *  listing — this keeps per-collection wall time bounded. */
const PER_COLLECTION_LIMIT = 10;
const SCAN_CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4h — this is a slow scan, don't re-run casually
const TENSOR_CONCURRENCY = 4;

interface CandidateCollection {
  slugMe: string;
  name: string;
  vol7dLamports: number;
  numListed: number;
}

interface SweepHit extends ScanRow {
  collectionSlug: string;
  collectionName: string;
}

interface ScanCacheShape {
  builtAt: number;
  hits: SweepHit[];
  collectionsScanned: number;
  collectionsCandidate: number;
  totalTensorCollections: number;
  /** Candidate collections we gave up on (rate-limit retries exhausted /
   *  upstream error) — these were never actually checked, so their
   *  absence from `hits` is NOT a confirmed "no offers above ask". */
  collectionsSkipped: string[];
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

/** Walk Tensor's bulk collections list sorted by volume7d desc, stopping
 *  at the first page whose LAST row drops below threshold (sorted desc,
 *  so everything after is guaranteed lower too). Confirmed live
 *  2026-08-11: this yields ~150-250 survivors out of 38.6k in ~2-3 pages,
 *  not a full 386-page walk like tensor-floor-scan.ts does (that tool
 *  sorts by createdAt and must walk everything). */
async function discoverActiveCollections(
  emit: Emit,
  minLamports: number,
  maxLamports: number | null,
): Promise<{ candidates: CandidateCollection[]; total: number }> {
  const first = await tensorGet(`/collections?sortBy=statsV2.volume7d:desc&limit=${PAGE_LIMIT}&page=1`);
  if (!first || typeof first.total !== 'number') throw new Error('tensor_unreachable');
  const total = first.total as number;
  const candidates: CandidateCollection[] = [];

  // When maxLamports is set we must skip past every page above the band
  // before we start collecting — sorted desc, so the band we want sits
  // somewhere in the middle, not at page 1.
  const collectPage = (data: any): boolean => {
    // Returns true if this page's last row was still above minLamports
    // (i.e. caller should fetch the next page).
    let sawBelowThreshold = false;
    for (const c of data?.collections ?? []) {
      const stats = c?.stats ?? {};
      const vol7d = Number(stats.volume7d) || 0;
      if (vol7d < minLamports) { sawBelowThreshold = true; break; }
      if (maxLamports != null && vol7d > maxLamports) continue; // above band — skip, keep paging down
      const slugMe = typeof c.slugMe === 'string' ? c.slugMe : null;
      if (!slugMe) continue; // no bridge to ME — can't be scanned in phase 2
      candidates.push({
        slugMe,
        name: c.name ?? slugMe,
        vol7dLamports: vol7d,
        numListed: Number(stats.numListed) || 0,
      });
    }
    return !sawBelowThreshold;
  };

  let page = 1;
  let keepGoing = collectPage(first);
  emit('progress', { msg: `Page 1 — ${total} Tensor collections total, sorted by 7d volume desc` });

  while (keepGoing) {
    page++;
    const data = await tensorGet(`/collections?sortBy=statsV2.volume7d:desc&limit=${PAGE_LIMIT}&page=${page}`);
    if (!data) break;
    keepGoing = collectPage(data);
    emit('progress', { msg: `Page ${page} — ${candidates.length} candidates in band so far` });
    if (page > 60) break; // safety cap — should never actually reach this given the threshold
  }

  return { candidates, total };
}

async function runFullSweep(emit: Emit, minVolSol: number, maxVolSol: number | null): Promise<ScanCacheShape> {
  const minLamports = Math.round(minVolSol * 1e9 * VOL_30D_TO_7D);
  const maxLamports = maxVolSol != null ? Math.round(maxVolSol * 1e9 * VOL_30D_TO_7D) : null;
  const bandLabel = maxVolSol != null ? `${minVolSol}-${maxVolSol}` : `≥${minVolSol}`;
  emit('progress', { msg: `Phase 1/2 — discovering collections in ${bandLabel} SOL/30d band via Tensor (volume filter only, no offer data)…` });
  const { candidates, total } = await discoverActiveCollections(emit, minLamports, maxLamports);
  emit('progress', { msg: `Phase 1 done — ${candidates.length} candidate collections. Phase 2/2 — checking ME personal offers (this is the slow part, ~${Math.ceil(candidates.length * PER_COLLECTION_LIMIT * 0.6 / 60)} min)…` });

  const hits: SweepHit[] = [];
  let scanned = 0;
  const skipped: string[] = [];
  /** Max retries for a rate-limited collection before giving up on it —
   *  a real cap, not a silent single-skip. Confirmed live 2026-08-11: the
   *  original single-attempt version silently dropped ~2-6% of candidates
   *  per run on MeRateLimitError with zero retry, meaning their "0 hits"
   *  contribution was actually "never checked", not "checked, no hits". */
  const MAX_RATE_LIMIT_RETRIES = 5;

  for (const cand of candidates) {
    // Respect the shared ME cooldown before even starting this collection —
    // same guard tools-retardio-offers.ts's route handler uses.
    const cooldownLeft = getMeCooldownRemainingSec();
    if (cooldownLeft > 0) {
      emit('progress', { msg: `ME rate-limited — pausing ${cooldownLeft}s before continuing…` });
      await new Promise(r => setTimeout(r, cooldownLeft * 1000));
    }

    let attempt = 0;
    let done = false;
    while (!done) {
      try {
        const result = await runScan({
          slug: cand.slugMe,
          scanLimit: PER_COLLECTION_LIMIT,
          minOfferSol: 0,
          recentActivityDays: 0,
          activityMaxPages: 0, // skip unlisted-candidate crawl — listed-only sweep
          debugMint: null,
        });
        scanned++;
        for (const row of result.withOffers) {
          if (!row.listed) continue;
          if (row.spreadSol == null || row.spreadSol <= 0) continue;
          if (row.bestOfferStatus === 'EXPIRED') continue;
          hits.push({ ...row, collectionSlug: cand.slugMe, collectionName: cand.name });
        }
        if (scanned % 10 === 0 || scanned === candidates.length) {
          emit('progress', { msg: `Scanned ${scanned}/${candidates.length} collections — ${hits.length} hits so far` });
        }
        done = true;
      } catch (e) {
        if (e instanceof MeRateLimitError && attempt < MAX_RATE_LIMIT_RETRIES) {
          attempt++;
          const wait = e.retryAfterSec || getMeCooldownRemainingSec() || 30;
          emit('progress', { msg: `ME rate limit on ${cand.slugMe} — pausing ${wait}s, retry ${attempt}/${MAX_RATE_LIMIT_RETRIES}…` });
          await new Promise(r => setTimeout(r, wait * 1000));
          // loop retries the same candidate — NOT skipped
        } else if (e instanceof MeRateLimitError) {
          emit('progress', { msg: `Giving up on ${cand.slugMe} after ${MAX_RATE_LIMIT_RETRIES} rate-limit retries — not checked` });
          skipped.push(cand.slugMe);
          done = true;
        } else if (e instanceof MeListingsUpstreamError) {
          emit('progress', { msg: `Skipping ${cand.slugMe} — ME upstream error (${e.upstreamStatus}) — not checked` });
          skipped.push(cand.slugMe);
          done = true;
        } else {
          emit('progress', { msg: `Skipping ${cand.slugMe} — ${String(e)} — not checked` });
          skipped.push(cand.slugMe);
          done = true;
        }
      }
    }
  }

  if (skipped.length > 0) {
    emit('progress', { msg: `${skipped.length} collections never actually checked (gave up after retries): ${skipped.join(', ')}` });
  }

  hits.sort((a, b) => (b.spreadSol ?? 0) - (a.spreadSol ?? 0));

  return {
    builtAt: Date.now(),
    hits,
    collectionsScanned: scanned,
    collectionsCandidate: candidates.length,
    totalTensorCollections: total,
    collectionsSkipped: skipped,
  };
}

const SCAN_CACHE_DIR = join(__dirname, '..', '..', 'data');
function cacheFileFor(bandKey: string): string {
  const safe = bandKey.replace(/[^a-z0-9.\-]/gi, '_');
  return join(SCAN_CACHE_DIR, `offer-floor-sweep-cache${safe === 'default' ? '' : `.${safe}`}.json`);
}

function loadScanCacheFromDisk(bandKey: string): ScanCacheShape | null {
  try {
    const parsed = JSON.parse(readFileSync(cacheFileFor(bandKey), 'utf-8')) as Partial<ScanCacheShape>;
    if (parsed && Array.isArray(parsed.hits) && typeof parsed.builtAt === 'number') {
      return {
        builtAt: parsed.builtAt,
        hits: parsed.hits as SweepHit[],
        collectionsScanned: parsed.collectionsScanned ?? 0,
        collectionsCandidate: parsed.collectionsCandidate ?? 0,
        totalTensorCollections: parsed.totalTensorCollections ?? 0,
        collectionsSkipped: parsed.collectionsSkipped ?? [],
      };
    }
  } catch { /* missing/corrupt — fine, first run will rebuild */ }
  return null;
}
function saveScanCacheToDisk(bandKey: string, cache: ScanCacheShape): void {
  try { writeFileSync(cacheFileFor(bandKey), JSON.stringify(cache)); } catch { /* best-effort */ }
}

/** Keyed by band (`"${minVolSol}-${maxVolSol ?? 'inf'}"`) so different
 *  volume bands don't clobber each other's cache/in-flight state. The
 *  default band (min=10, no max) matches the original single-band tool's
 *  cache file name for backward compat with anything already cached. */
const scanCacheByBand: Map<string, ScanCacheShape | null> = new Map();
const scanInFlightByBand: Map<string, Promise<ScanCacheShape>> = new Map();

function bandKeyFor(minVolSol: number, maxVolSol: number | null): string {
  return minVolSol === 10 && maxVolSol == null ? 'default' : `${minVolSol}-${maxVolSol ?? 'inf'}`;
}

export function createOfferFloorSweepRouter(): Router {
  const router = Router();
  const scanLimit = rateLimit({ limit: 2, windowMs: 10 * 60 * 1000, label: 'tools/offer-floor-sweep' });

  router.get('/tools/offer-floor-sweep/scan-stream', scanLimit, requireAuth, (req: Request, res: Response) => {
    const force = req.query.force === '1';
    const minVolSol = Math.max(0, Number(req.query.minVolSol ?? 10) || 10);
    const maxVolSolRaw = req.query.maxVolSol;
    const maxVolSol = maxVolSolRaw != null && maxVolSolRaw !== '' ? Math.max(minVolSol, Number(maxVolSolRaw) || 0) : null;
    const bandKey = bandKeyFor(minVolSol, maxVolSol);

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
          emit('error', { msg: 'TENSOR_API_KEY not configured on the backend — Phase 1 discovery is a no-op without it.' });
          res.end();
          return;
        }
        if (!scanCacheByBand.has(bandKey)) scanCacheByBand.set(bandKey, loadScanCacheFromDisk(bandKey));
        const existingCache = scanCacheByBand.get(bandKey) ?? null;

        if (!force && existingCache && Date.now() - existingCache.builtAt < SCAN_CACHE_TTL_MS) {
          const ageMs = Date.now() - existingCache.builtAt;
          emit('progress', { msg: `Cached (${Math.floor(ageMs / 60_000)}m ago, TTL 4h) — ${existingCache.hits.length} hits` });
          emit('result', { ...existingCache, cached: true, cacheAgeMs: ageMs });
          res.end();
          return;
        }
        const inFlight = scanInFlightByBand.get(bandKey);
        if (inFlight) {
          emit('progress', { msg: 'A sweep for this band is already running — attaching to it…' });
          const c = await inFlight;
          emit('result', { ...c, cached: false, cacheAgeMs: 0 });
          res.end();
          return;
        }
        const runPromise = runFullSweep(emit, minVolSol, maxVolSol).finally(() => { scanInFlightByBand.delete(bandKey); });
        scanInFlightByBand.set(bandKey, runPromise);
        const c = await runPromise;
        scanCacheByBand.set(bandKey, c);
        saveScanCacheToDisk(bandKey, c);
        emit('progress', { msg: `Done — ${c.hits.length} hits across ${c.collectionsScanned} collections` });
        emit('result', { ...c, cached: false, cacheAgeMs: 0 });
      } catch (err) {
        console.error('[tools/offer-floor-sweep] error', err);
        emit('error', { msg: String(err) });
      }
      res.end();
    })();
  });

  return router;
}
