/**
 * Late per-NFT name backfill sweep (additive, low-rate).
 *
 * WHY: `collection-confirm.ts` resolves the per-NFT `nftName` via a BOUNDED,
 * burst-adaptive DAS retry queue. When a fresh Core/TM/cNFT asset is not yet
 * indexed by DAS during that window (or the queue sheds it under a hot launch),
 * the retries give up and `mint_events.nft_name` stays NULL forever — even
 * though DAS indexes the asset moments later. The Live Mint Feed card then
 * falls back to `shortMint(mintAddress)` (the "no NFT name" stub).
 *
 * This sweep closes that gap: every few minutes it picks a small batch of
 * recent rows still missing a name (old enough that DAS has had time to index)
 * and runs ONE `getAsset` per row. On success it emits a `mint_meta` patch —
 * which the existing `onMintMeta -> patchMintEventMeta` wiring (event-store.ts)
 * persists to the DB via COALESCE AND fans out to live SSE clients, so the UI
 * updates without a reload. No parser/UI/layout changes; credit-bounded.
 */

import { getPool } from '../db/client';
import { getAsset } from '../enrichment/helius-das';
import { incGetAsset } from '../helius-credit-metrics';
import { saleEventBus } from '../events/emitter';
import { isMintTrackerEnabled } from '../runtime/mode';

// ── Tuning (kept conservative to protect Helius/DAS credits) ────────────────
const INITIAL_DELAY_MS = 90_000;       // let boot/ingestion settle first
const SWEEP_INTERVAL_MS = 3 * 60_000;  // every 3 min (was 5) — land fresh names sooner
const BATCH_LIMIT = 75;                // rows examined per sweep
const REQUEST_GAP_MS = 500;            // throttle between getAsset calls (matches enricher)
// DAS indexes standard NFTs (V1_NFT / mpl_core) within ~1–3 min, so a 3-min
// grace (was 7) cuts the time a fresh card shows the shortMint stub by ~4 min
// while still giving DAS time to index. MAX_ATTEMPTS raised 3→6 so the lower
// grace can't permanently give up on an asset DAS indexes a little later: at a
// 3-min sweep the retry window now spans ~3–18 min (was ~7–17). cNFTs DAS
// never indexes (Asset Not Found) still correctly retire after MAX_ATTEMPTS.
const GRACE_MINUTES = 3;
const WINDOW_HOURS = 24;             // only chase recent rows
const MAX_ATTEMPTS = 6;              // per-signature tries this process-life, then give up

// Recent-only, name-missing, NFT-shaped rows old enough for DAS to have indexed.
const SELECT_SQL = `
  SELECT signature, mint_address
    FROM mint_events
   WHERE (nft_name IS NULL OR nft_name = '')
     AND mint_address IS NOT NULL AND mint_address <> ''
     AND program_source IN ('mpl_core', 'mpl_token_metadata', 'bubblegum')
     AND created_at < now() - ($1 || ' minutes')::interval
     AND created_at > now() - ($2 || ' hours')::interval
   ORDER BY created_at DESC
   LIMIT $3
`;

let running = false;
// signature -> attempt count (bounds credits for assets DAS never names)
const attempts = new Map<string, number>();

function bumpAttempt(sig: string): void {
  attempts.set(sig, (attempts.get(sig) ?? 0) + 1);
}

async function runSweep(): Promise<void> {
  if (running) return;
  // Warm (low-power) mode → never spend per-mint DAS credits, same policy as
  // the enricher.
  if (!isMintTrackerEnabled()) return;
  running = true;
  let scanned = 0, resolved = 0, skippedNoAsset = 0, failed = 0;
  try {
    const { rows } = await getPool().query(SELECT_SQL, [GRACE_MINUTES, WINDOW_HOURS, BATCH_LIMIT]);
    for (const r of rows as Array<{ signature: string; mint_address: string }>) {
      const sig = r.signature;
      const mint = r.mint_address;
      if ((attempts.get(sig) ?? 0) >= MAX_ATTEMPTS) continue;
      scanned++;
      try {
        incGetAsset('name_backfill');
        const meta = await getAsset(mint);
        const name = typeof meta.nftName === 'string' ? meta.nftName.trim() : '';
        if (name.length > 0) {
          // Emit RAW per-asset name (not cleaned) so the frontend's
          // `hasRealNftName` guard accepts it instead of falling back to
          // shortMint. emitMintMeta -> onMintMeta -> patchMintEventMeta
          // persists to the DB (COALESCE) and fans out to live SSE clients.
          saleEventBus.emitMintMeta({
            signature:   sig,
            mintAddress: mint,
            nftName:     name,
            imageUrl:    meta.imageUrl ?? null,
          });
          attempts.delete(sig);
          resolved++;
        } else {
          // DAS still has no name (not indexed yet / nameless) — try again on a
          // later sweep, up to MAX_ATTEMPTS.
          bumpAttempt(sig);
          skippedNoAsset++;
        }
      } catch {
        // Fail soft on any DAS/network error; retry on a later sweep.
        bumpAttempt(sig);
        failed++;
      }
      await new Promise<void>((res) => setTimeout(res, REQUEST_GAP_MS));
    }
  } catch (err) {
    // Pool/query failure — single compact line, never throw out of the timer.
    console.warn(`[mints/backfill] sweep failed: ${(err as Error)?.message ?? String(err)}`);
  } finally {
    running = false;
  }
  // Only log when there was work to report (no idle spam).
  if (scanned > 0) {
    console.log(
      `[mints/backfill] scanned=${scanned} resolved=${resolved} ` +
      `skipped_no_asset=${skippedNoAsset} failed=${failed}`,
    );
  }
}

/** Start the periodic name-backfill sweep. Idempotent timers are `unref`'d so
 *  they never keep the process alive on their own. */
export function startMintNameBackfill(): void {
  setTimeout(() => {
    void runSweep();
    const t = setInterval(() => { void runSweep(); }, SWEEP_INTERVAL_MS);
    t.unref();
  }, INITIAL_DELAY_MS).unref();
  console.log(
    `[mints/backfill] enabled interval=${SWEEP_INTERVAL_MS / 1000}s batch=${BATCH_LIMIT} ` +
    `grace=${GRACE_MINUTES}m window=${WINDOW_HOURS}h`,
  );
}
