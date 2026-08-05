/**
 * Mint metadata enricher.
 *
 * Fires-and-forgets a Helius DAS getAsset for the latest mintAddress
 * seen in a freshly-tracked groupingKey, then patches the accumulator
 * with name + image. Strictly:
 *   - One in-flight worker (concurrency = 1).
 *   - 500 ms gap between requests (throttle).
 *   - Per-groupingKey lifetime dedup (each group enriched at most once).
 *   - Bounded pending queue (drop oldest when over cap).
 *   - Never blocks ingestion: enqueue is a single Map write + setTimeout
 *     ensure for the worker.
 */

import { verifyAndFetchAsset } from '../enrichment/helius-das';
import { patchAccumulatorMeta, patchAccumulatorSourceLabel, evictMintGroup } from './accumulator';
import { isMintTrackerEnabled } from '../runtime/mode';

const REQUEST_GAP_MS    = 500;
const PENDING_MAX       = 200;

interface PendingEntry { groupingKey: string; mintAddress: string; programSource?: string; }

const pending: PendingEntry[]  = [];
/** Per-MINT dedup (was per-grouping-key). Keying by mintAddress means
 *  every distinct mint gets a DAS verdict at least once, even when a
 *  fungible later joins a group whose first mint was a real NFT — the
 *  prior per-group dedup let those slip through unchallenged.
 *  Bounded FIFO (insertion-ordered Set, same pattern as
 *  `evictedNonNft`/`countedMints` in accumulator.ts): oldest
 *  mint addresses are evicted once the cap is exceeded, so this can't
 *  grow without limit across long uptime. A mint falling out of the
 *  window just means it could be re-enqueued and re-verified if it
 *  somehow mints again — harmless, since real mint addresses never
 *  repeat on-chain. */
const VERIFIED_MINTS_MAX       = 100_000;
const verifiedMints            = new Set<string>();
function rememberVerified(mintAddress: string): void {
  verifiedMints.add(mintAddress);
  if (verifiedMints.size <= VERIFIED_MINTS_MAX) return;
  const overflow = verifiedMints.size - VERIFIED_MINTS_MAX;
  const it = verifiedMints.values();
  for (let i = 0; i < overflow; i++) {
    const r = it.next();
    if (r.done) break;
    verifiedMints.delete(r.value);
  }
}
let workerScheduled            = false;

let warmEnrichSkips = 0;
export function enqueueMintEnrichment(
  groupingKey: string,
  mintAddress: string,
  programSource?: string,
): void {
  if (!mintAddress) return;
  // Warm (low-power) mode → never spend per-mint DAS (getAsset) credits.
  // Sampled log so the operator can see warm mode is shedding enrichment
  // without flooding the console under a hot launch.
  if (!isMintTrackerEnabled()) {
    if (warmEnrichSkips++ % 50 === 0) {
      console.log(`[mints/warm] skipped enrichment because warm mode (count=${warmEnrichSkips})`);
    }
    return;
  }
  if (verifiedMints.has(mintAddress)) return;       // already attempted
  rememberVerified(mintAddress);
  pending.push({ groupingKey, mintAddress, programSource });
  if (pending.length > PENDING_MAX) {
    // Drop oldest — under a hot launch the freshest entries are the
    // ones the operator wants enriched first.
    pending.splice(0, pending.length - PENDING_MAX);
  }
  scheduleWorker();
}

function scheduleWorker(): void {
  if (workerScheduled) return;
  workerScheduled = true;
  setImmediate(runWorker).unref();
}

/** Distinguishes a confirmed non-NFT verdict (DAS positively classified
 *  the asset as fungible / non-NFT) from a transient infrastructure
 *  failure (HTTP error, JSON-RPC error, rate limit, timeout, DAS
 *  not-yet-indexed). Only the former triggers an accumulator eviction;
 *  transient failures leave the row in place so a real NFT isn't
 *  dropped because Helius momentarily hiccupped — the parse-time
 *  filter in `ingestMintRaw` remains the primary NFT gate. */
function isConfirmedFungibleVerdict(reason: string | undefined): boolean {
  if (!reason) return false;
  // Confirmed fungible / non-NFT signals from `classifyDasAsset`:
  if (reason.startsWith('interface='))         return true;  // FungibleToken / FungibleAsset
  if (reason.startsWith('tokenStandard='))     return true;  // Fungible / FungibleAsset
  if (reason.startsWith('decimals='))          return true;  // decimals > 0
  if (reason.startsWith('supply='))            return true;  // supply > 1
  if (reason.startsWith('unknown_interface=')) return true;  // asset present but non-NFT shape
  // Transient (do NOT evict):
  //   no_api_key   — env missing on this deploy
  //   no_asset     — DAS hasn't indexed this mint yet (very recent mint)
  //   http_<n>     — Helius / DAS HTTP error (429 rate limit, 5xx, etc.)
  //   das_<code>   — DAS JSON-RPC error (e.g. -32000 generic server)
  //   fetch_error  — network / timeout
  return false;
}

async function runWorker(): Promise<void> {
  while (pending.length > 0) {
    // Tracker turned off mid-drain → drop the queue and stop spending DAS
    // calls. New mints can only arrive (and re-enqueue) while it's enabled.
    if (!isMintTrackerEnabled()) { pending.length = 0; break; }
    const next = pending.shift()!;
    try {
      // One DAS call per mint — returns both the NFT-vs-fungible
      // verdict and the metadata fields. Only CONFIRMED fungible
      // verdicts evict the group from the accumulator; transient
      // infrastructure failures (rate limit, JSON-RPC error, DAS
      // not-yet-indexed) leave the row in place — the parse-time
      // filter in ingestMintRaw is the primary NFT gate.
      const { verdict, meta } = await verifyAndFetchAsset(next.mintAddress, 'mint_enricher_verify');
      if (!verdict.ok) {
        if (isConfirmedFungibleVerdict(verdict.reason)) {
          evictMintGroup(next.groupingKey);
          noteFilterReject(verdict.reason ?? 'unknown', next.mintAddress);
          // Operator-facing line per the /mints filter spec — sampled
          // via the same counter map so a single noisy reason doesn't
          // flood the console under a hot launch.
          noteEvictNonNft(verdict.reason ?? 'unknown', next.groupingKey, next.mintAddress);
        } else {
          // Transient failure — keep the row, log for visibility.
          noteDasSkipTransient(verdict.reason ?? 'unknown', next.mintAddress);
        }
        continue;
      }
      noteFilterAccept(verdict.kind ?? 'unknown', next.mintAddress);
      // Patch GROUP-level fields only. Both per-NFT `nftName` AND per-NFT
      // `imageUrl` are intentionally dropped here: this DAS call resolves
      // a specific mintAddress, so `meta.imageUrl` is the asset image of
      // ONE NFT in the drop, not the collection's hero art. Writing it
      // into the accumulator's `imageUrl` made the collection row paint
      // a single child's image (Flork CG: row showed UN fallback because
      // the cached per-NFT image was then re-overwritten in flight, but
      // the symptom on other drops was "row icon = mint #1's art").
      // Only `collectionName` is collection-level here — that one we
      // can safely patch. Per-NFT identity (`nftName` + `imageUrl`)
      // is delivered to clients via the `mint_meta` SSE channel from
      // `collection-confirm.ts` where the sticky strong/weak guard
      // lives — that's the correct surface for it. Collection image
      // is supplied separately by `enrichLaunchpadCollectionMeta`
      // (CG / LMNFT-Core paths) which calls `getAsset(collectionAddress)`.
      if (meta.collectionName) {
        patchAccumulatorMeta(next.groupingKey, {
          name: meta.collectionName,
        });
      }
      // cNFT carve-out: Bubblegum drops have no separate collection
      // asset PDA — `enrichLaunchpadCollectionMeta` (which Core/TM
      // paths use to fetch the collection's hero art) cannot run.
      // For a compressed drop the per-leaf image IS the canonical
      // art (PFP collections all share it; 1/1 drops are the only
      // exception, and a single leaf's image is still the right one
      // to render). Patch only when `imageUrl` is still empty — the
      // sticky write-once guard in `patchAccumulatorMeta` is
      // permissive on first write but rejects subsequent overwrites,
      // so this can't downgrade a row that already has hero art.
      if (next.programSource === 'bubblegum' && meta.imageUrl) {
        patchAccumulatorMeta(next.groupingKey, {
          imageUrl: meta.imageUrl,
        });
      }
      // SFT: patch the source label so the frontend shows the SFT badge
      // instead of the ingest-time 'Metaplex' fallback.
      if (verdict.kind === 'sft') {
        patchAccumulatorSourceLabel(next.groupingKey, 'SFT');
      }
    } catch {
      // Best-effort; on transient failure (rate-limit, network) we don't
      // retry. The next mint in the same group will not re-enqueue
      // because `enriched` already has the key. To force a retry,
      // remove the key from `enriched` (operator-only path).
    }
    // Throttle between requests. Keeps DAS usage well under the
    // existing rate limits — each group enriched once, so total cost
    // scales with unique active collections, not with mint volume.
    await new Promise<void>(r => setTimeout(r, REQUEST_GAP_MS));
  }
  workerScheduled = false;
}

// ── Sampled DAS-verdict logs ─────────────────────────────────────────
//
// One line per (kind|reason) on the first occurrence + every 50th.
// Lets the operator confirm the filter is acting on real data and see
// reject reasons by category (fungible interface, decimals, etc.)
// without flooding the log under a hot launch.
const _filterAcceptCount = new Map<string, number>();
function noteFilterAccept(kind: string, mint: string): void {
  const n = (_filterAcceptCount.get(kind) ?? 0) + 1;
  _filterAcceptCount.set(kind, n);
  if (n === 1 || n % 50 === 0) {
    console.log(
      `[mints/filter] accept_nft type=${kind} count=${n} mint=${mint.slice(0, 8)}…`,
    );
  }
}
const _filterRejectCount = new Map<string, number>();
function noteFilterReject(reason: string, mint: string): void {
  const n = (_filterRejectCount.get(reason) ?? 0) + 1;
  _filterRejectCount.set(reason, n);
  if (n === 1 || n % 50 === 0) {
    console.log(
      `[mints/filter] reject_non_nft reason=${reason} count=${n} mint=${mint.slice(0, 8)}…`,
    );
  }
}
const _evictNonNftCount = new Map<string, number>();
function noteEvictNonNft(reason: string, groupingKey: string, mint: string): void {
  const n = (_evictNonNftCount.get(reason) ?? 0) + 1;
  _evictNonNftCount.set(reason, n);
  if (n === 1 || n % 50 === 0) {
    console.log(
      `[mints/evict-non-nft] reason=${reason} groupingKey=${groupingKey.slice(0, 32)}… mint=${mint.slice(0, 8)}…`,
    );
  }
}
const _dasSkipCount = new Map<string, number>();
function noteDasSkipTransient(reason: string, mint: string): void {
  const n = (_dasSkipCount.get(reason) ?? 0) + 1;
  _dasSkipCount.set(reason, n);
  if (n === 1 || n % 50 === 0) {
    console.log(
      `[mints/das-skip-transient] reason=${reason} count=${n} mint=${mint.slice(0, 8)}… ` +
      `(row kept; parse-time filter remains the primary gate)`,
    );
  }
}

/** Test-only affordances. Inert in production — no production code path
 *  references `__testHooks`. */
export const __testHooks = {
  verifiedMintsSize: (): number => verifiedMints.size,
  hasVerified: (mintAddress: string): boolean => verifiedMints.has(mintAddress),
  rememberVerified: (mintAddress: string): void => rememberVerified(mintAddress),
  verifiedMintsMax: VERIFIED_MINTS_MAX,
  isConfirmedFungibleVerdict: (reason: string | undefined): boolean => isConfirmedFungibleVerdict(reason),
};
