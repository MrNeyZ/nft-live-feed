/**
 * TRADING status sweep — log-only Commit 1.
 *
 * Periodically checks recently-active collections for genuine early
 * secondary-market activity (NOT profitability, NOT price-related). Fully
 * separate from accumulator.ts / MintStatusWire / SSE for this commit —
 * `buildMintStatusFrame` (src/server/sse.ts) serializes the whole
 * MintStatusWire via `JSON.stringify`, with no per-field allow-list the way
 * `buildSaleFrame` has for sale_events — so anything added to that wire goes
 * out immediately. This commit deliberately stops short of that: it only
 * logs detected collections so the formula's real-world hit rate can be
 * observed before anything becomes visible to a connected client.
 *
 * Candidate selection is free (no DB query): `currentMintStatuses()` is the
 * live in-memory Mint Tracker state already used to drive /mints. One
 * grouped, window-function query against `sale_events` per tick covers the
 * (bounded) candidate list.
 */
import { getPool } from '../db/client';
import { currentMintStatuses } from './accumulator';
import {
  VVVSO_PLATFORM_SIGNER,
  VVVSO_PLATFORM_TREASURY,
  GRAVEMINT_PLATFORM_SIGNER,
  GRAVEMINT_PLATFORM_TREASURY,
  MINTX_PLATFORM_SIGNER_PRIMARY,
  MINTX_PLATFORM_SIGNER_SECONDARY,
} from '../ingestion/mint-raw/launchpad-detector';

const SWEEP_INTERVAL_MS   = 3 * 60 * 1000; // 3 minutes
const CANDIDATE_WINDOW_MS = 48 * 60 * 60 * 1000; // 48h — matches the age gate itself
const MAX_CANDIDATES      = 200;

const AGE_MAX_MS               = 48 * 60 * 60 * 1000; // 48h
const FIRST_SALE_MAX_MS        = 3  * 60 * 60 * 1000; // 3h
const FIFTH_SALE_MAX_MS        = 6  * 60 * 60 * 1000; // 6h
const MIN_SALE_COUNT           = 5;
const MIN_UNIQUE_BUYERS        = 4;
const MIN_UNIQUE_SELLERS       = 2;
const MIN_VOLUME_SOL           = 0.75;

/** Known launchpad/platform signer + treasury wallets, excluded from the
 *  distinct buyer/seller counts so a platform's own settlement wallet can't
 *  count as one of the "unique" participants. Reused from the single
 *  source of truth in launchpad-detector.ts — not re-hardcoded. */
const EXCLUDED_WALLETS: string[] = [
  VVVSO_PLATFORM_SIGNER,
  VVVSO_PLATFORM_TREASURY,
  GRAVEMINT_PLATFORM_SIGNER,
  GRAVEMINT_PLATFORM_TREASURY,
  MINTX_PLATFORM_SIGNER_PRIMARY,
  MINTX_PLATFORM_SIGNER_SECONDARY,
];

export interface TradingStatusSignal {
  detected: boolean;
  saleCount: number;
  uniqueBuyers: number;
  uniqueSellers: number;
  volumeSol: number;
  firstSaleAfterMintMs: number;
  timeToFifthSaleMs: number | null;
}

interface EvaluateInput {
  firstMintAtMs: number;
  firstSaleAtMs: number | null;
  fifthSaleAtMs: number | null;
  saleCount: number;
  uniqueBuyers: number;
  uniqueSellers: number;
  volumeSol: number;
  nowMs: number;
}

/**
 * Pure formula — no DB, no RPC, fully unit-testable with synthetic inputs.
 *
 * Eligible only when ALL of:
 *   - collection age <= 48h
 *   - first secondary sale <= 3h after first mint
 *   - time to 5th sale <= 6h after first mint
 *   - sale_count >= 5, unique_buyers >= 4, unique_sellers >= 2
 *   - volume_sol >= 0.75 (anti-spam cost floor only — NOT a profitability signal)
 */
export function evaluateTradingStatus(input: EvaluateInput): TradingStatusSignal | null {
  const {
    firstMintAtMs, firstSaleAtMs, fifthSaleAtMs,
    saleCount, uniqueBuyers, uniqueSellers, volumeSol, nowMs,
  } = input;

  if (!Number.isFinite(firstMintAtMs) || firstMintAtMs <= 0) return null;
  if (nowMs - firstMintAtMs > AGE_MAX_MS) return null;
  if (firstSaleAtMs == null) return null;

  const firstSaleAfterMintMs = firstSaleAtMs - firstMintAtMs;
  if (firstSaleAfterMintMs < 0 || firstSaleAfterMintMs > FIRST_SALE_MAX_MS) return null;

  if (saleCount < MIN_SALE_COUNT) return null;

  const timeToFifthSaleMs = fifthSaleAtMs != null ? fifthSaleAtMs - firstMintAtMs : null;
  if (timeToFifthSaleMs == null || timeToFifthSaleMs < 0 || timeToFifthSaleMs > FIFTH_SALE_MAX_MS) return null;

  if (uniqueBuyers  < MIN_UNIQUE_BUYERS)  return null;
  if (uniqueSellers < MIN_UNIQUE_SELLERS) return null;
  if (volumeSol < MIN_VOLUME_SOL) return null;

  return {
    detected: true,
    saleCount,
    uniqueBuyers,
    uniqueSellers,
    volumeSol,
    firstSaleAfterMintMs,
    timeToFifthSaleMs,
  };
}

interface CandidateInfo {
  collectionAddress: string;
  firstMintAtMs: number;
  name: string | null;
}

/** Live in-memory candidate list — no DB query. Collections observed within
 *  the last 48h, deduped by collectionAddress, capped defensively. */
function getCandidates(): CandidateInfo[] {
  const now = Date.now();
  const seen = new Set<string>();
  const out: CandidateInfo[] = [];
  for (const row of currentMintStatuses()) {
    const addr = row.collectionAddress;
    if (!addr || seen.has(addr)) continue;
    const firstMintAtMs = row.collectionCreatedAt ?? row.firstSeenAt;
    if (firstMintAtMs == null) continue;
    if (now - firstMintAtMs > CANDIDATE_WINDOW_MS) continue;
    seen.add(addr);
    out.push({ collectionAddress: addr, firstMintAtMs, name: row.name ?? null });
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

interface QueryRow {
  collection_address: string;
  sale_count: string;
  first_sale_at: string | null;
  fifth_sale_at: string | null;
  unique_buyers: string;
  unique_sellers: string;
  volume_sol: number | null;
}

const QUERY = `
  WITH ranked AS (
    SELECT
      collection_address, buyer, seller, price_sol, block_time,
      ROW_NUMBER() OVER (PARTITION BY collection_address ORDER BY block_time ASC) AS rn
    FROM sale_events
    WHERE collection_address = ANY($1::text[])
      AND marketplace IN ('magic_eden', 'tensor')
      AND block_time >= now() - interval '48 hours'
  )
  SELECT
    collection_address,
    COUNT(*)                                                              AS sale_count,
    MIN(block_time)                                                       AS first_sale_at,
    MAX(block_time) FILTER (WHERE rn <= 5)                                AS fifth_sale_at,
    COUNT(DISTINCT buyer)  FILTER (WHERE NOT (buyer  = ANY($2::text[])))  AS unique_buyers,
    COUNT(DISTINCT seller) FILTER (WHERE NOT (seller = ANY($2::text[])))  AS unique_sellers,
    SUM(price_sol)::float8                                                AS volume_sol
  FROM ranked
  GROUP BY collection_address
`;

/** One sweep tick: candidates -> one grouped query -> evaluate -> log
 *  detected collections only. Never throws — logs and returns on error so a
 *  transient DB blip doesn't kill the interval. */
export async function runTradingStatusSweep(): Promise<void> {
  const candidates = getCandidates();
  if (candidates.length === 0) return;

  const byAddress = new Map<string, CandidateInfo>();
  for (const c of candidates) byAddress.set(c.collectionAddress, c);

  let rows: QueryRow[];
  try {
    const result = await getPool().query<QueryRow>(QUERY, [
      candidates.map((c) => c.collectionAddress),
      EXCLUDED_WALLETS,
    ]);
    rows = result.rows;
  } catch (err) {
    console.warn(`[trading-status] sweep query failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const now = Date.now();
  for (const r of rows) {
    const candidate = byAddress.get(r.collection_address);
    if (!candidate) continue;

    const signal = evaluateTradingStatus({
      firstMintAtMs: candidate.firstMintAtMs,
      firstSaleAtMs: r.first_sale_at ? new Date(r.first_sale_at).getTime() : null,
      fifthSaleAtMs: r.fifth_sale_at ? new Date(r.fifth_sale_at).getTime() : null,
      saleCount:     parseInt(r.sale_count, 10),
      uniqueBuyers:  parseInt(r.unique_buyers, 10),
      uniqueSellers: parseInt(r.unique_sellers, 10),
      volumeSol:     r.volume_sol ?? 0,
      nowMs: now,
    });

    if (signal) {
      console.log(
        `[trading-status] DETECTED collection=${candidate.name ?? candidate.collectionAddress.slice(0, 8)}... ` +
        `addr=${candidate.collectionAddress.slice(0, 8)}... ` +
        `saleCount=${signal.saleCount} uniqueBuyers=${signal.uniqueBuyers} uniqueSellers=${signal.uniqueSellers} ` +
        `volumeSol=${signal.volumeSol.toFixed(3)} ` +
        `firstSaleAfterMint=${(signal.firstSaleAfterMintMs / 60_000).toFixed(1)}min ` +
        `timeToFifthSale=${(signal.timeToFifthSaleMs! / 60_000).toFixed(1)}min`,
      );
    }
  }
}

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Boot entry point: run once immediately, then every SWEEP_INTERVAL_MS.
 *  Log-only — no accumulator write, no SSE, no UI. */
export function startTradingStatusSweep(): void {
  if (sweepTimer) return;
  void runTradingStatusSweep().catch((err) => {
    console.warn(`[trading-status] initial sweep failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  sweepTimer = setInterval(() => {
    void runTradingStatusSweep().catch((err) => {
      console.warn(`[trading-status] sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, SWEEP_INTERVAL_MS);
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref();
}
