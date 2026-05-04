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
import { getMagicEdenCollectionName } from '../enrichment/me-collection-name';
import { evictMintGroup, patchAccumulatorMeta, patchAccumulatorLmnft, getAccumulatorName } from './accumulator';
import { saleEventBus } from '../events/emitter';

/** "Looks like a short-address fallback" — `<6chars>…<4chars>`, the
 *  shape `shortKey()` produces on the frontend. Treat such names as
 *  weak so a stronger source (ME) is allowed to overwrite. */
const SHORT_ADDR_NAME_RE = /^[1-9A-HJ-NP-Za-km-z]{4,8}…[1-9A-HJ-NP-Za-km-z]{4,8}$/;
function nameLooksWeak(name: string | null | undefined): boolean {
  if (!name || name.length === 0) return true;
  if (SHORT_ADDR_NAME_RE.test(name)) return true;
  return false;
}

// Four increasingly-spaced DAS polls — 15s / 60s / 180s / 5min. The 4th
// retry exists specifically to chase post-reveal per-NFT images: many
// LMNFT/Core launches start with a shared placeholder and only swap to
// per-asset art a few minutes after mint. Capping at 5 min keeps the
// in-memory pending queue bounded.
const RETRY_DELAYS_MS = [15_000, 60_000, 180_000, 300_000];
const MAX_PENDING     = 500;

/** Per-collection image-frequency counter. When the same imageUrl shows
 *  up for multiple distinct mintAddresses in the same collection it's
 *  almost certainly the launchpad's pre-reveal placeholder, NOT a
 *  per-NFT asset image — we still surface it (better than abbr-only)
 *  but tag it `repeated=true` in logs and keep retrying so a late
 *  per-NFT image can replace it. */
const imageUseCount = new Map<string, Map<string, Set<string>>>();
function noteImageUse(collection: string | null, image: string, mint: string): number {
  if (!collection || !image) return 1;
  let perColl = imageUseCount.get(collection);
  if (!perColl) { perColl = new Map(); imageUseCount.set(collection, perColl); }
  let mints = perColl.get(image);
  if (!mints) { mints = new Set(); perColl.set(image, mints); }
  mints.add(mint);
  return mints.size;
}
function imageLooksRepeated(collection: string | null, image: string): boolean {
  if (!collection || !image) return false;
  const perColl = imageUseCount.get(collection);
  if (!perColl) return false;
  const mints = perColl.get(image);
  return !!mints && mints.size >= 2;
}

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
  //
  // Magic Eden collection-name resolver. We promote ME to a STRONG
  // fallback whenever DAS doesn't surface a `collectionName` —
  // including the case where DAS gave us a per-NFT name. Reason:
  // launchpad collections where every NFT has a unique name (e.g.
  // "Hipppieardo", "Schlongston", "Buttricia Bungleburst", …) used to
  // fall back to "stripped per-NFT name as collection title", which
  // produced wrong row labels — every mint's retry overwrote the row
  // with whatever stripped name landed last. ME's
  // `/v2/tokens/{mint}` returns the real collection display name
  // (e.g. "Gonad Dick Butts" for the fixture above). Single ME call
  // per mintAddress, cached 20 min in `getMagicEdenCollectionName`,
  // never blocks the row emission.
  let meCollectionName: string | null = null;
  if (!collectionName && entry.mintAddress
      && nameLooksWeak(getAccumulatorName(entry.groupingKey))) {
    const me = await getMagicEdenCollectionName(entry.mintAddress);
    if (me.collectionName) meCollectionName = me.collectionName;
  }
  if (collectionName || nftName || imageUrl || meCollectionName) {
    // Name preference, strongest → weakest:
    //   1. DAS `collectionName`     — authoritative (collection asset
    //                                  metadata, indexed by Helius).
    //   2. ME collection name       — authoritative for ME-listed
    //                                  collections, and reliably
    //                                  matches the deployer's intent.
    //   3. stripped per-NFT name    — heuristic, only safe when the
    //                                  collection follows "Project
    //                                  #N" naming. We use it only as
    //                                  a last-resort fallback.
    // The stripping ("Foo #42" → "Foo") still applies to (3) so a
    // single-mint sample with "ProjectName #1" still produces a clean
    // row title.
    const stripped = nftName ? nftName.replace(/\s*#\s*\d+\s*$/, '').trim() : null;
    const isStrong = !!collectionName || !!meCollectionName;
    const finalName = collectionName
      ?? meCollectionName
      ?? (stripped && stripped.length > 0 ? stripped : null)
      ?? undefined;
    // Sticky guard against stripped-name overwrites. Per-NFT stripped
    // names from successive retries on the same collection used to
    // ping-pong the row title (e.g. "Hipppieardo" → "Schlongston" →
    // "Buttricia Bungleburst" — for collections with unique-named
    // NFTs). Patch only when:
    //   - the new name is from a strong source (DAS collectionName /
    //     ME), OR
    //   - the accumulator is still on a weak name (short-key
    //     fallback / empty), so we DO need to seed something.
    // Once a strong name lands, no weak retry can overwrite it.
    const currentName = getAccumulatorName(entry.groupingKey);
    const shouldPatchName = isStrong || nameLooksWeak(currentName);
    // IMPORTANT: do NOT write per-NFT `imageUrl` into the collection
    // accumulator — it pollutes `group.imageUrl` with one mint's
    // specific asset image, then the frontend's
    // `cardImage = ev.nftImageUrl ?? group?.imageUrl` fallback paints
    // that one image onto every card in the same collection that
    // hasn't yet had its own DAS retry land. Collection-level image
    // is supplied separately (e.g. by the LMNFT lookup or a future
    // collection-asset getAsset call); per-NFT image fans out via
    // `mint_meta` only.
    if (shouldPatchName) {
      patchAccumulatorMeta(entry.groupingKey, { name: finalName });
    }

    // Image repetition heuristic. A LMNFT/Core launch typically uses
    // ONE placeholder image for the first wave of mints (pre-reveal),
    // then later swaps to per-asset art. If we've already seen this
    // image for another mint in the same collection, treat it as
    // unresolved-but-tolerable: emit it so the card renders something
    // plausible, but mark `repeated=true` so the next retry has a
    // chance to overwrite it with a unique per-NFT image. When all
    // retries return the same repeated image we accept it as the
    // collection's actual base art.
    let imageSource: 'nft' | 'collection' | 'placeholder' = 'placeholder';
    let repeated = false;
    if (imageUrl) {
      const usesInCollection = noteImageUse(dasCollection, imageUrl, entry.mintAddress);
      repeated = usesInCollection >= 2;
      imageSource = repeated ? 'collection' : 'nft';
    }
    console.log(
      `[mints/meta-image] mint=${entry.mintAddress} ` +
      `image=${imageUrl ?? '—'} source=${imageSource} repeated=${repeated}`,
    );

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
    // Image-only continuation. Collection is confirmed, so the row
    // is staying — but if this attempt either had no image or got the
    // shared pre-reveal placeholder (`repeated=true`), keep walking
    // the retry schedule so a later DAS hit can swap in the unique
    // per-NFT image when the launchpad reveals. When the image is
    // already unique-per-mint we stop early.
    const haveUniqueImage = !!imageUrl && !imageLooksRepeated(dasCollection, imageUrl);
    if (haveUniqueImage || entry.idx + 1 >= RETRY_DELAYS_MS.length) {
      pending.delete(entry.mintAddress);
      return;
    }
    entry.idx += 1;
    scheduleNext(entry);
    return;
  }
  entry.idx += 1;
  scheduleNext(entry);
}
