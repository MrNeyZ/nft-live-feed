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
import { getLmnftInfoByMint } from '../enrichment/lmnft';
import { evictMintGroup, patchAccumulatorMeta, patchAccumulatorLmnft } from './accumulator';
import { saleEventBus } from '../events/emitter';

// Three increasingly-spaced DAS polls. Caps total wait at ~4 min from
// mint to confirmation/eviction. Tightened from 30/120/300 to 15/60/180
// per the metadata-retry spec — fresh mints reach DAS in <30s most of
// the time, so the first retry was too late.
const RETRY_DELAYS_MS = [15_000, 60_000, 180_000];
const MAX_PENDING     = 500;

interface Pending {
  groupingKey:      string;
  mintAddress:      string;
  parserCollection: string;
  signature:        string;   // for `mint_meta` SSE patch routing
  idx:              number;
}
const pending = new Map<string, Pending>();   // key = mintAddress

export function scheduleCollectionConfirmation(
  groupingKey:      string,
  mintAddress:      string,
  parserCollection: string,
  signature:        string,
): void {
  if (!mintAddress || !parserCollection) return;
  if (pending.has(mintAddress))         return;
  if (pending.size >= MAX_PENDING)      return;   // bounded — drop new arrivals on overflow
  const entry: Pending = { groupingKey, mintAddress, parserCollection, signature, idx: 0 };
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
    // Prefer the DAS collection-asset name. When only the per-NFT
    // name is available (the collection asset hasn't been indexed
    // yet, common during a fresh launch), strip the trailing `#N`
    // pattern so we display "Pix Ape" instead of "Pix Ape #44" as
    // the row's collection name.
    const stripped = nftName ? nftName.replace(/\s*#\s*\d+\s*$/, '').trim() : null;
    const finalName = collectionName ?? (stripped && stripped.length > 0 ? stripped : null) ?? undefined;
    patchAccumulatorMeta(entry.groupingKey, {
      name:     finalName,
      imageUrl: imageUrl ?? undefined,
    });
    // Per-mint patch — fans out to the Live Mint Feed cards on the
    // frontend, swapping shortMint placeholders for the real NFT
    // name + image. Distinct from the collection-row patch above.
    saleEventBus.emitMintMeta({
      signature:   entry.signature,
      mintAddress: entry.mintAddress,
      nftName:     nftName ?? null,
      imageUrl:    imageUrl ?? null,
    });
    console.log(
      `[mints/meta] patched mint=${entry.mintAddress} ` +
      `name=${nftName ?? finalName ?? '—'} image=${imageUrl ? 'yes' : 'no'}`,
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
    // LaunchMyNFT featured-set lookup. Synchronous cache read; if the
    // map is stale a background refresh fires and the next confirmed
    // mint will pick up the URL fields. Hits surface
    // `lmntfOwner` + `lmntfCollectionId` (+ optional `maxSupply` /
    // `collectionName`) on the wire so the source pill becomes
    // clickable and SUPPLY populates with LMNFT's planned drop size.
    const lmntf = getLmnftInfoByMint(dasCollection);
    if (lmntf) {
      patchAccumulatorLmnft(entry.groupingKey, {
        owner:        lmntf.owner,
        collectionId: lmntf.collectionId,
        maxSupply:    lmntf.maxSupply,
        name:         lmntf.collectionName,
      });
    }
    pending.delete(entry.mintAddress);
    return;
  }
  entry.idx += 1;
  scheduleNext(entry);
}
