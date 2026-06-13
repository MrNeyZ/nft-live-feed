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
import { isMintTrackerEnabled } from '../runtime/mode';
import { fetchMetaFromJsonUri } from '../enrichment/metaplex-onchain';
import { getLmnftInfoByMint } from '../enrichment/lmnft';
import { getMagicEdenCollectionName } from '../enrichment/me-collection-name';
import {
  evictMintGroup,
  patchAccumulatorMeta,
  patchAccumulatorLmnft,
  patchAccumulatorRepresentativeImage,
  patchAccumulatorSharedPlaceholderImage,
  getAccumulatorName,
} from './accumulator';
import { saleEventBus } from '../events/emitter';
import { cleanName, nameLooksPerAsset } from './clean-name';
import { isCollectionBlacklisted, noteBlacklistDrop } from './blacklist';

/** "Looks like a short-address fallback" — `<6chars>…<4chars>`, the
 *  shape `shortKey()` produces on the frontend. Treat such names as
 *  weak so a stronger source (ME) is allowed to overwrite. */
const SHORT_ADDR_NAME_RE = /^[1-9A-HJ-NP-Za-km-z]{4,8}…[1-9A-HJ-NP-Za-km-z]{4,8}$/;

/** Weak-name predicate — treated as "ok to overwrite" by sticky merge.
 *  Three buckets:
 *    1. empty / null              — no name, nothing to protect.
 *    2. short-address fallback    — `<6chars>…<4chars>` placeholder.
 *    3. per-asset shape (clean-name) — names that LOOK like they came
 *       straight from a per-NFT field on a launchpad drop ("PAGE - 2",
 *       "DASC 1/1", "Beez … #NFT #Solana"). LMNFT / cNFT / Core
 *       launches expose per-asset names BEFORE the real collection
 *       metadata is indexed in DAS, and a subsequent strong DAS
 *       `collectionName` should be allowed to replace the residue.
 *  cleanName already strips these shapes upstream, so case 3 is
 *  defense-in-depth — a code path that bypasses cleanName (or a future
 *  per-asset shape we haven't strip-encoded yet) is still caught here.
 *  Adding case 3 does NOT weaken sticky protection globally: it only
 *  matches the exact per-asset shapes, never a real collection name. */
function nameLooksWeak(name: string | null | undefined): boolean {
  if (!name || name.length === 0) return true;
  if (SHORT_ADDR_NAME_RE.test(name)) return true;
  if (nameLooksPerAsset(name))      return true;
  return false;
}

// Four increasingly-spaced DAS polls — 15s / 60s / 180s / 5min. The 4th
// retry exists specifically to chase post-reveal per-NFT images: many
// LMNFT/Core launches start with a shared placeholder and only swap to
// per-asset art a few minutes after mint. Capping at 5 min keeps the
// in-memory pending queue bounded.
const RETRY_DELAYS_MS = [15_000, 60_000, 180_000, 300_000];
const MAX_PENDING     = 500;

// ─── Helius credit budget (per-collection burst limiting) ────────────
// During a hot LMNFT mint a single collection can ship 30–60 mints/min;
// scheduling a 4-step DAS retry per mint blew our credits without
// adding meaningful UX value (after a few resolves we already know the
// collection's image template + name). The two valves below cap the
// damage without changing live-feed correctness:
//
// 1. PER-KEY ENQUEUE RATE LIMIT — sliding 60 s window of how many
//    mints we've sent into the retry queue for one groupingKey. Mints
//    over the cap are NOT enrolled (they keep their placeholder; the
//    mint_meta replay buffer / next-mint refresh fills them in
//    eventually). Counter: `metricSkippedBurst`.
//
// 2. ADAPTIVE RETRY START — once K mints in a collection have
//    successfully resolved name/image via DAS within RESOLVED_WINDOW_MS,
//    new arrivals from that same collection skip retry-1 (15 s) and
//    start at retry-2 (60 s). Originally skipped to retry-3 (180 s), but
//    that was too aggressive — Aevon mints showed up as placeholders
//    for 3 min on /mints because DAS already had data within seconds
//    but our first attempt only fired at T+180 s. Retry-2 (60 s) keeps
//    the 15 s slot's credit savings (still the noisy one — DAS often
//    hasn't indexed yet) while UX-wise capping placeholder lifetime at
//    ~60 s during a burst. Counter: `metricDelayed`.
const MAX_ENQUEUES_PER_MIN_PER_KEY     = 20;
const RESOLVE_THRESHOLD_FOR_DELAYED    = 5;
const RESOLVED_WINDOW_MS               = 5 * 60_000;
const ENQUEUE_WINDOW_MS                = 60_000;
const ADAPTIVE_RETRY_START_IDX         = 1;   // skips retry-1 (15s) only
// 2026-05-29: Once a groupingKey has FINAL_RESOLVE_THRESHOLD confirmed
// resolves inside RESOLVED_WINDOW_MS, the collection's identity is
// considered fully known; new arrivals from that key skip DAS retries
// entirely and pending entries short-circuit before their next attempt.
// Window-decayed (`recentResolveCount` already resets the counter when
// RESOLVED_WINDOW_MS passes), so a re-launch after a cooldown gets the
// full 4-retry treatment again.
const FINAL_RESOLVE_THRESHOLD          = 3;
const loggedFinalKeys = new Set<string>();

const enqueueTimesByKey:    Map<string, number[]> = new Map();
const resolvedCountByKey:   Map<string, { count: number; firstAt: number }> = new Map();

// Credit-usage counters. Reset on every emit of the [mints/credits]
// metrics line so each log row is "since last tick" — easier to spot
// regressions in pm2 logs without diffing cumulative totals.
let metricGetAsset      = 0;
let metricSkippedBurst  = 0;
let metricDelayed       = 0;
let metricSearchAssets  = 0;
let metricSkippedFinal  = 0;

/** External hook: every place that issues a `searchAssets` RPC for
 *  /mints (today: the per-collection minted-count refresh in
 *  accumulator.ts) calls this so the counter shows up in the unified
 *  [mints/credits] line. Cheap counter — no allocation, no async. */
export function noteSearchAssetsCall(): void { metricSearchAssets++; }

function trimEnqueueWindow(times: number[], now: number): number[] {
  const cutoff = now - ENQUEUE_WINDOW_MS;
  // Keep only entries inside the window. Tight loop instead of filter+
  // assign so the existing array can shrink in place during steady
  // state. On overflow this still creates a new array — fine, called
  // at most once per enqueue attempt per key.
  let i = 0;
  while (i < times.length && times[i] < cutoff) i++;
  return i === 0 ? times : times.slice(i);
}

function recentResolveCount(key: string, now: number): number {
  const r = resolvedCountByKey.get(key);
  if (!r) return 0;
  if (now - r.firstAt > RESOLVED_WINDOW_MS) {
    // Window expired — reset; the collection has cooled, treat new
    // mints as a fresh launch so they get the full 4-retry treatment.
    resolvedCountByKey.delete(key);
    return 0;
  }
  return r.count;
}

function noteResolved(key: string, now: number): void {
  const r = resolvedCountByKey.get(key);
  if (!r || now - r.firstAt > RESOLVED_WINDOW_MS) {
    resolvedCountByKey.set(key, { count: 1, firstAt: now });
  } else {
    r.count++;
  }
}

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
/** Count of distinct image URLs observed for a collection. Used as
 *  a confidence gate on `patchAccumulatorRepresentativeImage`: only
 *  promote a per-NFT image to the row's sticky representative once
 *  the launchpad has demonstrated variety (>= 2 distinct URLs) —
 *  this prevents a pre-reveal placeholder shared across every mint
 *  from being treated as a "real per-NFT image". */
function countDistinctImages(collection: string | null): number {
  if (!collection) return 0;
  const perColl = imageUseCount.get(collection);
  return perColl?.size ?? 0;
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
  // Mint tracker disabled → never queue DAS (getAsset) confirmation retries.
  if (!isMintTrackerEnabled())          return;
  if (pending.has(mintAddress))         return;
  if (pending.size >= MAX_PENDING)      return;   // bounded — drop new arrivals on overflow
  // FINAL gate — collection's identity already fully resolved within
  // the recent window; no DAS retries needed for new mints from it.
  if (recentResolveCount(groupingKey, Date.now()) >= FINAL_RESOLVE_THRESHOLD) {
    metricSkippedFinal++;
    if (!loggedFinalKeys.has(groupingKey)) {
      loggedFinalKeys.add(groupingKey);
      console.log(`[mints/cc-final] groupingKey=${groupingKey.slice(0, 32)}… resolved=>=${FINAL_RESOLVE_THRESHOLD} — skipping DAS retries`);
    }
    return;
  }

  // Per-key burst rate limit. Sliding 60 s window of enqueue
  // timestamps per groupingKey; mints over the cap don't enter the
  // retry queue at all — they keep their placeholder until the next
  // organic refresh path picks them up (mint_meta replay on reconnect,
  // or another mint in the same collection landing inside the
  // adaptive-retry threshold). Burst-shedding is preferable to running
  // 4 DAS retries × 60 mints/min for a single collection.
  const now = Date.now();
  const bucket = trimEnqueueWindow(enqueueTimesByKey.get(groupingKey) ?? [], now);
  if (bucket.length >= MAX_ENQUEUES_PER_MIN_PER_KEY) {
    enqueueTimesByKey.set(groupingKey, bucket);   // store the trimmed bucket
    metricSkippedBurst++;
    return;
  }

  // Adaptive retry start — skip the noisy 15 s + 60 s slots once we've
  // already resolved K mints in this collection's recent window. The
  // collection's image/name template is well-known by then; per-NFT
  // images can wait for the 180 s+ slots without user-visible cost.
  let startIdx = 0;
  if (recentResolveCount(groupingKey, now) >= RESOLVE_THRESHOLD_FOR_DELAYED) {
    startIdx = ADAPTIVE_RETRY_START_IDX;
    metricDelayed++;
  }

  bucket.push(now);
  enqueueTimesByKey.set(groupingKey, bucket);

  const entry: Pending = { groupingKey, mintAddress, parserCollection, signature, idx: startIdx };
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
  // Tracker turned off after this retry was scheduled → abandon it without
  // spending a getAsset call (drop the pending entry; no reschedule).
  if (!isMintTrackerEnabled()) { pending.delete(entry.mintAddress); return; }
  // Collection became fully resolved while this entry was in queue →
  // drop without DAS spend. Same window-decayed counter as the entry
  // gate above.
  if (recentResolveCount(entry.groupingKey, Date.now()) >= FINAL_RESOLVE_THRESHOLD) {
    metricSkippedFinal++;
    pending.delete(entry.mintAddress);
    return;
  }
  let dasCollection: string | null = null;
  let nftName:        string | null = null;
  let imageUrl:       string | null = null;
  let collectionName: string | null = null;
  // Raw (uncleaned) per-NFT name for the card title. Kept separate from the
  // cleaned `nftName` (which feeds the collection-row fallback): the frontend
  // treats `nftName === collectionName`/stripped-collection as "no per-NFT
  // name" and falls back to shortMint, so the card title MUST carry the real
  // per-asset name (e.g. "Micros #8881"), not the stripped "Micros".
  let rawNftName:     string | null = null;
  try {
    metricGetAsset++;
    const meta = await getAsset(entry.mintAddress);
    dasCollection  = meta.collectionAddress ?? null;
    // Trim DAS-surfaced names — fixed-width Metaplex / MPL Core name
    // buffers ship with trailing spaces, and we don't want
    // "                                " to win the strong-source check
    // below (or worse, ride the wire to /mints as the row title). See
    // src/mints/clean-name.ts for the full rationale.
    nftName        = cleanName(meta.nftName);
    rawNftName     = typeof meta.nftName === 'string' && meta.nftName.trim().length > 0
      ? meta.nftName.trim()
      : null;
    imageUrl       = meta.imageUrl           ?? null;
    collectionName = cleanName(meta.collectionName);
    // DAS often hasn't indexed a freshly-minted MPL Core asset's image OR its
    // `metadata.name` yet, but the off-chain JSON (json_uri) already carries
    // both. Fetch it once when EITHER is missing and backfill from it. The
    // raw name resolves the per-NFT card title from the SAME fetch instead of
    // waiting for DAS to backfill `metadata.name` — which often never happens
    // before this retry entry is dropped once grouping confirms (the exact
    // cause of empty nft_name on sig 4V1ESV… → "Micros #8881").
    if ((!imageUrl || !rawNftName) && meta.jsonUri) {
      const off = await fetchMetaFromJsonUri(meta.jsonUri, entry.mintAddress);
      if (!imageUrl && off.image) imageUrl = off.image;
      if (!rawNftName && off.name) {
        rawNftName = off.name;
        // Seed the cleaned name too if DAS gave us nothing, so the
        // collection-row fallback below still has something to work with.
        if (!nftName) nftName = cleanName(off.name);
      }
    }
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
    let usesInCollection = 0;
    if (imageUrl) {
      usesInCollection = noteImageUse(dasCollection, imageUrl, entry.mintAddress);
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
    //
    // Hard collection blacklist gate. recordMint already blocked the
    // mint / mint_status frames + accumulator entry; this catches the
    // out-of-band mint_meta patch that runs from the enricher AFTER
    // recordMint and would otherwise still surface on the wire (the
    // frontend keys mint_meta by signature, not collection, so it
    // would land on any tab that happened to have an older session
    // still showing the row from localStorage). Resolves to either
    // the parser-supplied address or the DAS-resolved address —
    // whichever is non-null first matches.
    const blacklistAddr = isCollectionBlacklisted(dasCollection)
      ? dasCollection
      : isCollectionBlacklisted(entry.parserCollection)
        ? entry.parserCollection
        : null;
    if (blacklistAddr) {
      noteBlacklistDrop(blacklistAddr);
    } else {
      // Image classification — two separate sticky/non-sticky writes
      // depending on what this URL is confidently shown to be:
      //
      //  * `usesInCollection >= 2` (repeated) → this URL is the
      //    launchpad's shared pre-reveal asset. Patch as
      //    `sharedPlaceholderImageUrl` (non-sticky; updated on
      //    every refresh of "what the placeholder currently is")
      //    so the frontend live-feed card can detect "ev.nftImageUrl
      //    is a shared placeholder, not per-mint identity" and skip
      //    rendering it on the card.
      //
      //  * `usesInCollection === 1 && countDistinctImages >= 2` →
      //    this URL is unique to its mint AND the launchpad has
      //    demonstrated variety (≥2 distinct URLs seen). Confident
      //    enough to lock it in as the `representativeImageUrl`
      //    (sticky), used as a 2nd-tier fallback on both the
      //    tracker table thumbnail and the live-feed card when
      //    the per-mint URL turns out to be a placeholder.
      //
      // For a pre-reveal-only drop (Flork today): distinct stays at
      // 1 forever, representative is NEVER set, the placeholder
      // is recorded. Cards skip the placeholder → initials. The
      // tracker table still gets the collection hero from
      // enrichLaunchpadCollectionMeta — separate, unaffected path.
      //
      // For a drop with mid-stream reveal: the first post-reveal
      // unique URL trips both gates and locks in as representative,
      // surfacing real art on cards whose `ev.nftImageUrl` is still
      // the now-defunct placeholder.
      if (imageUrl && repeated) {
        patchAccumulatorSharedPlaceholderImage(entry.groupingKey, imageUrl);
      } else if (imageUrl && usesInCollection === 1
                 && countDistinctImages(dasCollection) >= 2) {
        patchAccumulatorRepresentativeImage(entry.groupingKey, imageUrl);
      }
      saleEventBus.emitMintMeta({
        signature:   entry.signature,
        mintAddress: entry.mintAddress,
        // Per-NFT card title: emit the RAW per-asset name (not the cleaned
        // collection-ish name) so the frontend's `hasRealNftName` guard
        // accepts it instead of falling back to shortMint(mintAddress).
        nftName:     rawNftName ?? null,
        imageUrl:    imageUrl ?? null,
      });
      console.log(
        `[mints/meta] patched mint=${entry.mintAddress} ` +
        `name=${rawNftName ?? finalName ?? '—'} image=${imageUrl ? 'yes' : 'no'}`,
      );
    }
    // Bump the per-collection resolved counter only when this attempt
    // surfaced something the UI cares about (image OR a real name).
    // Adaptive-retry consults this counter on subsequent enqueues for
    // the same groupingKey; once we cross RESOLVE_THRESHOLD, new mints
    // start at retry idx 2 instead of 0, saving the 15 s + 60 s slots.
    if (imageUrl || nftName || collectionName) {
      noteResolved(entry.groupingKey, Date.now());
    }
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

// ─── Helius credit metrics ticker ────────────────────────────────────
// Logs once per minute with the deltas since the previous tick. Each
// counter resets after emit so a hot-collection spike shows up clearly
// in pm2 logs without having to diff cumulative totals. The
// `collections=` field counts distinct groupingKeys with at least one
// enqueue inside the current sliding window (i.e. collections actively
// burning enrichment credits right now); a quiet system reads as
// `collections=0` and a busy launch reads as `collections=1` with a
// large `getAsset` value attributable to that single launch.
const METRICS_INTERVAL_MS = 60_000;
const _metricsTimer = setInterval(() => {
  const now = Date.now();
  // Distinct active collections = those whose sliding-window bucket
  // still has any enqueue inside ENQUEUE_WINDOW_MS. Trim each bucket
  // opportunistically so we don't accumulate dead keys forever.
  let activeCollections = 0;
  for (const [key, times] of enqueueTimesByKey) {
    const trimmed = trimEnqueueWindow(times, now);
    if (trimmed.length === 0) {
      enqueueTimesByKey.delete(key);
    } else {
      enqueueTimesByKey.set(key, trimmed);
      activeCollections++;
    }
  }
  console.log(
    `[mints/credits] getAsset=${metricGetAsset} ` +
    `skippedBurst=${metricSkippedBurst} ` +
    `skippedFinal=${metricSkippedFinal} ` +
    `delayed=${metricDelayed} ` +
    `searchAssets=${metricSearchAssets} ` +
    `collections=${activeCollections}`,
  );
  metricGetAsset     = 0;
  metricSkippedBurst = 0;
  metricSkippedFinal = 0;
  metricDelayed      = 0;
  metricSearchAssets = 0;
}, METRICS_INTERVAL_MS);
if (typeof _metricsTimer.unref === 'function') _metricsTimer.unref();
