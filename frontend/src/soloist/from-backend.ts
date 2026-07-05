// Pure mapper: backend SSE/REST payload → UI FeedEvent.
// No React imports, no side effects — safe to unit-test.

import type { FeedEvent as BackendEvent, LatestApiResponse, RestRow } from '@/types';
import { fromRow } from '@/types';
import { CATEGORY_LAYER, COLLECTIONS_DB, FeedEvent, Marketplace, Side } from './mock-data';

// Known collections resolve their canonical hand-picked color via
// COLLECTIONS_DB below; only UNKNOWN collections fall through to the
// generated identity layer, so the hash fallback draws from the approved
// CATEGORY_LAYER (CAT_PURPLE as the no-name sentinel).
const FALLBACK_COLOR = '#8C6CF2';
const FALLBACK_ABBR  = '??';
const FALLBACK_PALETTE = CATEGORY_LAYER;

function collectionMeta(name: string | null): { abbr: string; color: string } {
  if (!name) return { abbr: FALLBACK_ABBR, color: FALLBACK_COLOR };
  const hit = COLLECTIONS_DB.find(c => c.name === name);
  if (hit) return { abbr: hit.abbr, color: hit.color };
  const words = name.split(/\s+/).filter(Boolean);
  const abbr = (
    words.length >= 2
      ? (words[0][0] ?? '') + (words[1][0] ?? '')
      : name.slice(0, 2)
  ).toUpperCase() || FALLBACK_ABBR;
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash + name.charCodeAt(i)) | 0;
  const color = FALLBACK_PALETTE[Math.abs(hash) % FALLBACK_PALETTE.length];
  return { abbr, color };
}

function mapMarketplace(mp: string): Marketplace {
  if (mp === 'tensor' || mp === 'tensor_amm') return 'tensor';
  if (mp === 'orbis') return 'orbis';
  return 'me';
}

/**
 * Backend saleType → UI `side`:
 *   bid_sell, pool_sale, pool_sell, amm_sell → sell
 *   anything else (normal_sale, pool_buy, list_buy, amm_buy, listing) → buy
 */
function mapSide(saleType: string | null | undefined): Side {
  switch (saleType) {
    case 'bid_sell':
    case 'pool_sale':
    case 'pool_sell':
    case 'amm_sell':
      return 'sell';
    default:
      return 'buy';
  }
}

function numFromName(nftName: string | null): number {
  if (!nftName) return 0;
  const m = nftName.match(/#?(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : 0;
}

function displayNftName(nftName: string | null | undefined, collectionName: string | null | undefined): string {
  const name = nftName?.trim();
  if (name && /^\d+$/.test(name) && collectionName?.trim()) {
    return `${collectionName.trim()} #${name}`;
  }
  return nftName ?? `${collectionName ?? 'Unknown'} #?`;
}

export function fromBackend(b: BackendEvent): FeedEvent {
  const meta = collectionMeta(b.collectionName);
  const side = mapSide(b.saleType);
  const nftName = displayNftName(b.nftName, b.collectionName);
  return {
    id: b.signature,
    signature: b.signature,
    mintAddress: b.mintAddress ?? '',
    meCollectionSlug:     b.meCollectionSlug     ?? null,
    tensorCollectionSlug: b.tensorCollectionSlug ?? null,
    collectionName: b.collectionName ?? 'Unknown',
    abbr: meta.abbr,
    color: meta.color,
    nftName,
    num: numFromName(b.nftName),
    rank: b.rarityRank ?? 0,
    rarityRank:       b.rarityRank ?? null,
    totalSupply:      b.totalSupply ?? null,
    rarityPercentile: b.rarityPercentile ?? null,
    raritySource:     b.raritySource ?? null,
    oneOfOne:         b.oneOfOne ?? false,
    // Display price prefers seller-net (actual proceeds) when available,
    // gross priceSol as fallback. `grossPrice` always carries the raw
    // sale figure for consumers (chart, summaries) that need it.
    // `sellerNetPrice` is propagated separately so any UI surface can
    // render both side-by-side via tooltip / hover when desired.
    price: (b.sellerNetPriceSol ?? null) != null ? (b.sellerNetPriceSol as number) : b.priceSol,
    grossPrice: b.priceSol,
    sellerNetPrice: b.sellerNetPriceSol ?? null,
    // Pass null through when the backend couldn't compute a floor delta
    // (no slug, blacklisted collection, ME/Tensor floor lookup failed).
    // The Live Feed hides the indicator on null; rendering 0 would be
    // misleading (= "exactly at floor", a meaningful, distinct state).
    floorDelta: b.floorDelta ?? null,
    offerDelta: b.offerDelta ?? null,
    marketplace: mapMarketplace(b.marketplace),
    ts: Date.parse(b.blockTime),
    side,
    nftType: b.nftType ?? 'legacy',
    saleTypeRaw: b.saleType ?? null,
    buyer: b.buyer,
    seller: b.seller,
    imageUrl: b.imageUrl ?? null,
    collectionAddress: b.collectionAddress ?? null,
    resizeStatus:      b.resizeStatus ?? null,
    mintedAtMs:        b.mintedAtMs ?? null,
    // Server-persisted count from the REST snapshot (migration 015). Absent on
    // live SSE sale frames (b.sellerRemainingCount undefined) — those get the
    // count via the async `seller_count` patch — so this is null there and the
    // snapshot path supplies it on reload, server-authoritative across devices.
    sellerRemainingCount: b.sellerRemainingCount ?? null,
  };
}

/**
 * Normalise a collection name (or ME slug) into an Orbis marketplace slug.
 * "Mutants On Sol Crew" → "mutants-on-sol-crew"; "mosc_pre_reveal" →
 * "mosc-pre-reveal". Lowercase, & → "and", drop quotes, collapse any run of
 * non-alphanumerics to a single hyphen, trim leading/trailing hyphens.
 */
export function toOrbisSlug(nameOrSlug: string): string {
  return nameOrSlug
    .trim()
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-+/g, '-');
}

/**
 * Build the marketplace URL for an event's badge — routes by the event's
 * detected marketplace so a Tensor sale links to tensor.trade and a Magic
 * Eden sale links to magiceden.io.
 */
export function marketplaceUrl(event: FeedEvent): string | null {
  if (event.marketplace === 'tensor') {
    // Prefer the Tensor-native collection page when we have the slugDisplay.
    // Fall back to the per-NFT item page; bare tensor.trade as last resort.
    if (event.tensorCollectionSlug) return `https://www.tensor.trade/trade/${event.tensorCollectionSlug}`;
    if (event.mintAddress)          return `https://www.tensor.trade/item/${event.mintAddress}`;
    return 'https://www.tensor.trade';
  }
  // Orbis: its slug is name-derived ("Mutants On Sol Crew" →
  // "mutants-on-sol-crew"), NOT the ME slug ("mosc_pre_reveal"). Build from the
  // display collection name when we have a real one; fall back to the ME slug
  // (run through the same normaliser so underscores become hyphens) only when
  // the name is missing. No source at all → unlinked badge.
  if (event.marketplace === 'orbis') {
    const name = event.collectionName && event.collectionName !== 'Unknown'
      ? event.collectionName
      : event.meCollectionSlug;
    const orbisSlug = name ? toOrbisSlug(name) : '';
    if (orbisSlug) return `https://www.orbisonsol.io/marketplace/${orbisSlug}`;
    return null;
  }
  // Magic Eden (me / me_amm) — slug → collection page; mint → item page;
  // bare ME homepage as the last resort so the badge always links somewhere
  // on the same marketplace.
  if (event.meCollectionSlug) return `https://magiceden.io/marketplace/${event.meCollectionSlug}`;
  if (event.mintAddress)      return `https://magiceden.io/item-details/${event.mintAddress}`;
  return 'https://magiceden.io';
}

export { fromRow, collectionMeta };
export type { BackendEvent, LatestApiResponse, RestRow };
