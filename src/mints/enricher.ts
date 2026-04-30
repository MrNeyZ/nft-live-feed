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
import { patchAccumulatorMeta, evictMintGroup } from './accumulator';

const REQUEST_GAP_MS    = 500;
const PENDING_MAX       = 200;

interface PendingEntry { groupingKey: string; mintAddress: string; }

const pending: PendingEntry[]  = [];
const enriched                 = new Set<string>();   // groupingKeys already attempted
let workerScheduled            = false;

export function enqueueMintEnrichment(groupingKey: string, mintAddress: string): void {
  if (enriched.has(groupingKey)) return;            // already attempted
  enriched.add(groupingKey);
  pending.push({ groupingKey, mintAddress });
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

async function runWorker(): Promise<void> {
  while (pending.length > 0) {
    const next = pending.shift()!;
    try {
      // One DAS call per group — returns both the NFT-vs-fungible
      // verdict and the metadata fields. Non-NFT groups are evicted
      // from the accumulator so the row never reaches /mints (or
      // disappears from the table mid-flight if the cheap parse-
      // time filter let it through).
      const { verdict, meta } = await verifyAndFetchAsset(next.mintAddress);
      if (!verdict.ok) {
        evictMintGroup(next.groupingKey);
        noteFilterReject(verdict.reason ?? 'unknown', next.mintAddress);
        continue;
      }
      noteFilterAccept(verdict.kind ?? 'unknown', next.mintAddress);
      if (meta.imageUrl || meta.nftName || meta.collectionName) {
        patchAccumulatorMeta(next.groupingKey, {
          name:     meta.collectionName ?? meta.nftName ?? undefined,
          imageUrl: meta.imageUrl       ?? undefined,
        });
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
