/**
 * Asynchronous collection-confirmation retry queue for targeted-mode
 * launchpad mints.
 *
 * Background: a freshly-minted MPL Core asset isn't in DAS's index for
 * the first few seconds (sometimes a couple of minutes) after the
 * on-chain tx confirms. Synchronously gating /mints acceptance on
 * `getAsset(mint).grouping` therefore drops every real LMNFT mint
 * during that index lag — exactly the symptom that surfaced for
 *   xtJv8g4TjtFPrcXkayEzzA4fVbgBkd8fo5qj2uYasZxxvMdMumZSTUengVwe7viKJjneaneyHG2es4nmF3g2Uke
 *
 * This module accepts the row optimistically using the parser's
 * inner-Core CPI `accounts[1]` value (the collection PARAMETER passed
 * to Core's Create ix), then verifies asynchronously via three DAS
 * polls at 30 s / 120 s / 300 s after the mint. If DAS surfaces a
 * collection grouping at any point → confirmed, row stays. If all
 * three retries return no grouping (the test/standalone case) →
 * `evictMintGroup` removes the row from /mints state and the next
 * mint_status frame tells every client to drop it.
 */
import { getAsset } from '../enrichment/helius-das';
import { evictMintGroup, patchAccumulatorMeta } from './accumulator';

// Three increasingly-spaced DAS polls. Caps total wait at ~4 min from
// mint to confirmation/eviction. Tightened from 30/120/300 to 15/60/180
// per the metadata-retry spec — fresh mints reach DAS in <30s most of
// the time, so the first retry was too late.
const RETRY_DELAYS_MS = [15_000, 60_000, 180_000];
const MAX_PENDING     = 500;

interface Pending { groupingKey: string; mintAddress: string; parserCollection: string; idx: number; }
const pending = new Map<string, Pending>();   // key = mintAddress

export function scheduleCollectionConfirmation(
  groupingKey:      string,
  mintAddress:      string,
  parserCollection: string,
): void {
  if (!mintAddress || !parserCollection) return;
  if (pending.has(mintAddress))         return;
  if (pending.size >= MAX_PENDING)      return;   // bounded — drop new arrivals on overflow
  const entry: Pending = { groupingKey, mintAddress, parserCollection, idx: 0 };
  pending.set(mintAddress, entry);
  scheduleNext(entry);
}

function scheduleNext(entry: Pending): void {
  if (entry.idx >= RETRY_DELAYS_MS.length) {
    // Exhausted — DAS never confirmed. Evict the optimistic accept.
    console.log(
      `[mints/launchpad-debug] mint=${entry.mintAddress} ` +
      `parserCollection=${entry.parserCollection} dasCollection=null ` +
      `decision=evict_after_retries`,
    );
    evictMintGroup(entry.groupingKey);
    pending.delete(entry.mintAddress);
    return;
  }
  const delay = RETRY_DELAYS_MS[entry.idx];
  const timer = setTimeout(() => { void runAttempt(entry); }, delay);
  if (typeof timer.unref === 'function') timer.unref();
}

async function runAttempt(entry: Pending): Promise<void> {
  let dasCollection: string | null = null;
  let nftName:        string | null = null;
  let imageUrl:       string | null = null;
  let collectionName: string | null = null;
  try {
    const meta = await getAsset(entry.mintAddress);
    dasCollection  = meta.collectionAddress ?? null;
    nftName        = meta.nftName            ?? null;
    imageUrl       = meta.imageUrl           ?? null;
    collectionName = meta.collectionName     ?? null;
  } catch {
    // Transient failure — treat as "no answer this round" and let
    // the next retry attempt try again.
  }
  // Side-effect on every attempt: if DAS surfaced ANY usable metadata
  // (collectionName preferred, nftName as fallback, image either way)
  // patch it into the accumulator immediately. Doing this on every
  // retry — even before collection grouping resolves — means the row
  // gets a real name + image as soon as DAS has them, instead of
  // waiting for the full collection-confirmation step.
  if (collectionName || nftName || imageUrl) {
    patchAccumulatorMeta(entry.groupingKey, {
      name:     collectionName ?? nftName ?? undefined,
      imageUrl: imageUrl ?? undefined,
    });
    console.log(
      `[mints/meta] retry=${entry.idx + 1} mint=${entry.mintAddress} ` +
      `name=${collectionName ?? nftName ?? '—'} image=${imageUrl ? 'yes' : 'no'}`,
    );
  }
  if (dasCollection) {
    console.log(
      `[mints/launchpad-debug] mint=${entry.mintAddress} ` +
      `parserCollection=${entry.parserCollection} dasCollection=${dasCollection} ` +
      `decision=confirmed (retry ${entry.idx + 1}/${RETRY_DELAYS_MS.length})`,
    );
    if (collectionName) {
      console.log(
        `[mints/meta] collection=${dasCollection} name=${collectionName}`,
      );
    }
    pending.delete(entry.mintAddress);
    return;
  }
  entry.idx += 1;
  scheduleNext(entry);
}
