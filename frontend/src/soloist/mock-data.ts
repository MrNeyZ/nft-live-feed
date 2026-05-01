// Mock data + types for the design prototype.
// Shape mirrors what the real-time feed will provide; swap this module for a
// subscription to the backend SSE stream when wiring up live data.

export type Side = 'buy' | 'sell';
export type Marketplace = 'me' | 'tensor';

export interface Collection {
  name: string;
  abbr: string;
  floor: number;
  supply: number;
  royalty: string;
  trades1d: number;
  trades1h: number;
  trades10m: number;
  volume: number;
  holders: number;
  listings: number;
  color: string;
  vol7d: number[];
  floor7d: number[];
}

export interface FeedEvent {
  /** Dedup key — equals `signature` (prefix `mock-…` for mock events). */
  id: string;
  signature: string;
  mintAddress: string;
  /** ME collection slug when known; used to build marketplace link. Null until `meta` patch arrives. */
  meCollectionSlug: string | null;
  collectionName: string;
  abbr: string;
  color: string;
  nftName: string;
  num: number;
  rank: number;
  /** Display price — prefers seller-net (actual proceeds after fees +
   *  royalties) when the backend extracted it; falls back to `grossPrice`. */
  price: number;
  /** Raw gross sale price extracted from the instruction. Always set. */
  grossPrice: number;
  /** Server-computed net the seller actually received. Null when the
   *  backend couldn't extract it (e.g. cNFT, missing balance delta). */
  sellerNetPrice?: number | null;
  /** Sale price vs. collection floor as a fractional ratio
   *  (+0.12 = +12% above floor, -0.08 = 8% below floor). `null` when
   *  the backend couldn't resolve a floor for this collection — render
   *  consumers must hide the indicator in that case. */
  floorDelta: number | null;
  marketplace: Marketplace;
  ts: number;
  side: Side;
  /** Backend NFT type (e.g. 'legacy', 'pnft', 'core', 'metaplex_core', 'cnft'). Used for cNFT filtering. */
  nftType: string;
  /** Original backend sale type (e.g. 'normal_sale', 'pool_sale', 'bid_sell'). Null for mock. */
  saleTypeRaw: string | null;
  buyer: string;
  seller: string;
  /** NFT thumbnail URL. Null when backend had no image_url for the row;
   *  frontend falls back to the abbr/color placeholder. */
  imageUrl: string | null;
  /** On-chain collection group address (when known at sale time). Used
   *  as the second half of the seller-remaining-count cache key
   *  (`${seller}-${collectionAddress}`) so a patch can match every
   *  row from the same seller+collection without relying on signature. */
  collectionAddress?: string | null;
  /** Seller's remaining holdings in the same collection (post-sale).
   *  Resolved async via the `seller_count` SSE patch frame for sell-
   *  type events; undefined until that frame arrives, null when the
   *  backend lookup failed. */
  sellerRemainingCount?: number | null;
}

export const COLLECTIONS_DB: Collection[] = [
  { name: 'Mad Lads',                   abbr: 'ML', floor: 14.2,  supply: 10000, royalty: '0%',  trades1d: 5200,  trades1h: 34,  trades10m: 11, volume: 45400, holders: 3105, listings: 2061, color: '#ff8c42', vol7d: [12,18,14,22,19,28,34], floor7d: [13.1,13.8,14.0,13.5,14.2,14.8,14.2] },
  { name: 'Claynosaurz',                abbr: 'CL', floor: 5.8,   supply: 8888,  royalty: '5%',  trades1d: 1240,  trades1h: 22,  trades10m: 6,  volume: 12800, holders: 2100, listings: 890,  color: '#36b868', vol7d: [8,10,9,11,14,12,16],   floor7d: [5.2,5.4,5.6,5.5,5.7,5.9,5.8] },
  { name: 'Tensorians',                 abbr: 'TN', floor: 0.031, supply: 10000, royalty: '0%',  trades1d: 892,   trades1h: 18,  trades10m: 4,  volume: 200,   holders: 4200, listings: 1240, color: '#8068d8', vol7d: [4,3,5,4,6,5,7],        floor7d: [0.028,0.029,0.031,0.030,0.032,0.031,0.031] },
  { name: 'Okay Bears',                 abbr: 'OB', floor: 3.1,   supply: 10000, royalty: '2%',  trades1d: 630,   trades1h: 11,  trades10m: 3,  volume: 3200,  holders: 3300, listings: 560,  color: '#4e8cd4', vol7d: [5,7,6,8,7,9,10],       floor7d: [2.8,2.9,3.0,3.1,3.0,3.2,3.1] },
  { name: 'Communi3: Mad Scientists',   abbr: 'MS', floor: 35,    supply: 4918,  royalty: '10%', trades1d: 2203,  trades1h: 171, trades10m: 49, volume: 78000, holders: 1800, listings: 1163, color: '#c9a820', vol7d: [15,20,18,24,22,28,35], floor7d: [30,32,34,33,35,34,35] },
  { name: 'P2 Farmers Genesis Series',  abbr: 'P2', floor: 2.8,   supply: 6000,  royalty: '5%',  trades1d: 578,   trades1h: 45,  trades10m: 12, volume: 1600,  holders: 1200, listings: 440,  color: '#28a878', vol7d: [10,12,14,18,22,24,30], floor7d: [2.4,2.5,2.6,2.7,2.7,2.8,2.8] },
  { name: 'Owls with Attitude',         abbr: 'OA', floor: 0.03,  supply: 3333,  royalty: '3%',  trades1d: 224,   trades1h: 20,  trades10m: 8,  volume: 31.7,  holders: 800,  listings: 210,  color: '#d47832', vol7d: [2,3,2,4,3,5,8],        floor7d: [0.025,0.027,0.028,0.029,0.030,0.031,0.030] },
  { name: 'Da Creaturez',               abbr: 'DC', floor: 0.03,  supply: 5000,  royalty: '5%',  trades1d: 137,   trades1h: 12,  trades10m: 4,  volume: 4.3,   holders: 1100, listings: 320,  color: '#b01d62', vol7d: [1,2,1,3,2,2,4],        floor7d: [0.025,0.026,0.028,0.027,0.029,0.030,0.030] },
  { name: 'Taiyo Pilots',               abbr: 'TP', floor: 35.5,  supply: 4000,  royalty: '8%',  trades1d: 121,   trades1h: 10,  trades10m: 3,  volume: 4300,  holders: 920,  listings: 180,  color: '#2fa8d8', vol7d: [3,4,4,5,5,6,8],        floor7d: [33,34,34,35,35.5,35,35.5] },
  { name: 'RetroGoons',                 abbr: 'RG', floor: 5.8,   supply: 5000,  royalty: '4%',  trades1d: 104,   trades1h: 9,   trades10m: 2,  volume: 608.7, holders: 1400, listings: 390,  color: '#c084fc', vol7d: [2,2,3,3,4,4,5],        floor7d: [5.2,5.4,5.5,5.6,5.7,5.8,5.8] },
  { name: 'Immortals',                  abbr: 'IM', floor: 5.9,   supply: 8000,  royalty: '6%',  trades1d: 82,    trades1h: 7,   trades10m: 2,  volume: 483.1, holders: 2200, listings: 650,  color: '#e879f9', vol7d: [2,3,2,4,3,5,6],        floor7d: [5.5,5.6,5.7,5.7,5.8,5.9,5.9] },
  { name: 'Minute Men',                 abbr: 'MM', floor: 0.95,  supply: 6969,  royalty: '7%',  trades1d: 10141, trades1h: 504, trades10m: 74, volume: 4507.1,holders: 2400, listings: 767,  color: '#8068d8', vol7d: [20,22,24,28,30,32,40], floor7d: [0.8,0.85,0.9,0.92,0.94,0.94,0.95] },
];

export function rndFloat(min: number, max: number): number { return min + Math.random() * (max - min); }
export function rndInt(min: number, max: number): number { return Math.floor(rndFloat(min, max + 1)); }

export function shortWallet(w: string): string { return `${w.slice(0, 4)}…${w.slice(-4)}`; }

export function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 5000)     return 'just now';
  if (diff < 60000)    return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000)  return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
}

/**
 * Canonical SOL price formatter used everywhere prices render.
 * Decimal precision tiers:
 *   ≥ 1000  → 1.2K-style abbreviation
 *   ≥ 100   → 0 decimals
 *   ≥ 10    → 1 decimal
 *   ≥ 0.1   → 2 decimals  (e.g. 1.35, 0.27)
 *   < 0.1   → 3 decimals  (e.g. 0.099, 0.045) so sub-floor values stay legible
 * The 0.1 boundary is the only place this differs from "1.0 boundary"
 * — moved deliberately so 0.27 / 0.45 display as 2 decimals (cleaner)
 * while 0.099 / 0.045 keep the third digit (otherwise they'd round to
 * 0.10 / 0.05 and lose meaningful precision).
 */
export function formatSol(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  if (n >= 100)  return `${n.toFixed(0)}`;
  if (n >= 10)   return `${n.toFixed(1)}`;
  if (n >= 0.1)  return `${n.toFixed(2)}`;
  return `${n.toFixed(3)}`;
}

// ── Collection mock data ─────────────────────────────────────────────────────
// Used only by the collection page for now. When the real backend grows
// per-collection listing + trade endpoints, replace `generateTrade` /
// `generateListing` with subscriptions to those sources.

export function rnd<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }

function rndWallet(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz123456789';
  const len = rndInt(32, 44);
  let out = '';
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export interface Listing {
  id: string;
  signature: string;
  collectionName: string;
  abbr: string;
  color: string;
  nftName: string;
  num: number;
  rank: number;
  price: number;
  marketplace: Marketplace;
  ts: number;
}

/** Collection selected via the TopNav search. Falls back to Communi3. */
export function getCurrentCollection(): Collection {
  if (typeof window !== 'undefined') {
    const name = localStorage.getItem('sol-current-col');
    const hit = COLLECTIONS_DB.find(c => c.name === name);
    if (hit) return hit;
  }
  return COLLECTIONS_DB[4];
}

let _mockId = 1000;
export function generateTrade(col?: Collection): FeedEvent {
  const c = col || rnd(COLLECTIONS_DB);
  const num = rndInt(1, c.supply || 9999);
  const rank = rndInt(1, c.supply || 9999);
  const price = c.floor * rndFloat(0.88, 1.25);
  const marketplace: Marketplace = Math.random() < 0.55 ? 'me' : 'tensor';
  const sig = `mock-${_mockId++}`;
  return {
    id: sig,
    signature: sig,
    mintAddress: '',
    meCollectionSlug: null,
    collectionName: c.name,
    abbr: c.abbr,
    color: c.color,
    nftName: `${c.name} #${num}`,
    num,
    rank,
    price,
    grossPrice: price * 1.02,
    floorDelta: rndFloat(-0.25, 0.3),
    marketplace,
    ts: Date.now() - rndFloat(0, 8000),
    side: Math.random() < 0.75 ? 'buy' : 'sell',
    nftType: 'legacy',
    saleTypeRaw: null,
    buyer: rndWallet(),
    seller: rndWallet(),
    imageUrl: null,
  };
}

export function generateListing(col?: Collection): Listing {
  const c = col || rnd(COLLECTIONS_DB);
  const num = rndInt(1, c.supply || 9999);
  const rank = rndInt(1, c.supply || 9999);
  const price = c.floor * rndFloat(0.95, 2.2);
  const marketplace: Marketplace = Math.random() < 0.6 ? 'me' : 'tensor';
  const sig = `mock-L${_mockId++}`;
  return {
    id: sig,
    signature: sig,
    collectionName: c.name,
    abbr: c.abbr,
    color: c.color,
    nftName: `${c.name} #${num}`,
    num,
    rank,
    price,
    marketplace,
    ts: Date.now() - rndFloat(0, 86400000 * 2),
  };
}
