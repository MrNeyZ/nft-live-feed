'use client';

// /collection/[slug] — exact layout port of the Soloist handoff
// (`/tmp/soloist/soloist/project/collection.html`). Markup, paddings,
// colors, gradients, gridTemplateColumns, font sizes — all preserved
// verbatim from the original. Static / mock content is the only thing
// swapped: every value below comes from real backend state.
//
//   LEFT   "LISTINGS" → GET /api/collections/listings?slug=
//   MIDDLE "TRADES"   → GET /api/events/by-collection?slug= + SSE filter
//   RIGHT  Stats grid + scatter chart (real ME stats + sale_events)
//
// Buy execution is wired through the existing /api/buy/me + Phantom flow;
// the original ListingRow's static price label gains a TypeBadge that
// becomes the live Buy button.

import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { Connection } from '@solana/web3.js';
import { FeedEvent, formatSol, shortWallet, timeAgo } from '@/soloist/mock-data';
import {
  fromBackend,
  fromRow,
  type BackendEvent,
  type LatestApiResponse,
} from '@/soloist/from-backend';
import {
  feedReducer, initFeedState, orderedEvents,
  type MetaPatch, type RawPatch,
} from '@/soloist/feed-store';
import {
  CollectionIcon, ItemThumb, LiveDot, MktBadge, RankBadge, TopNav, TypeBadge,
  compressImage,
} from '@/soloist/shared';
import { useCollectionIcons } from '@/soloist/collection-icons';
import { ScatterChart, type ScatterPoint } from '@/soloist/scatter-chart';
import {
  connectPhantom,
  eagerConnectPhantom,
  getPhantom,
  signSendAndConfirm,
} from '@/wallet/phantom';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';
// Set NEXT_PUBLIC_RPC_URL in frontend/.env.local to a private RPC (e.g. Helius)
// — public mainnet-beta is rate-limited and may time out before the tx confirms.
const RPC_URL  = process.env.NEXT_PUBLIC_RPC_URL  ?? 'https://api.mainnet-beta.solana.com';

// Sized to match the backend's `BY_COLLECTION_HARD_LIMIT` so a full history
// fetch is never silently clipped by frontend eviction. Live appends add on
// top of the fetched history, evicting only the oldest rows once this cap is
// exceeded — the first-time snapshot stays intact.
const MAX_EVENTS          = 5_000;
const HISTORY_FETCH_LIMIT = 5_000;
// Collection page TRADES panel — display cap applied at render time. The
// feedReducer still retains the full 7-day history (needed for any future
// filters); we just don't draw more rows than the user can realistically
// scan in one sitting. Backend stats/chart endpoints are independent and
// unaffected by this constant.
const VISIBLE_TRADES_MAX  = 200;
const STATS_REFRESH_MS    = 60_000;
// Listings are maintained by SSE deltas after the initial snapshot.
// This interval is only the reconciliation safety net for transitions the
// backend doesn't yet observe as events (cancel/delist/pool deposits).
const LISTINGS_REFRESH_MS = 5 * 60_000;

const SPANS     = ['1H','4H','1D','7D','30D'] as const;
const INTERVALS = ['1M','5M','15M','30M','1H'] as const;
type Span     = typeof SPANS[number];
type Interval = typeof INTERVALS[number];
// SPAN_MS removed: span → window is now owned by the backend
// (/api/collections/chart?span=…); frontend just passes the label through.

interface ListingRow {
  /** Source-aware unique id provided by the backend store. Used to target
   *  id-based `listing_remove` deltas without mint-wide filtering. */
  id:           string;
  mint:         string;
  seller:       string;
  auctionHouse: string;
  priceSol:     number;
  tokenAta:     string;
  rank:         number | null;
  marketplace:  'me' | 'tensor';
  /** Epoch ms when the listing was created on-chain. Null when unavailable
   *  (MMM pool rows, Tensor listings not yet wired, or ME listings older
   *  than the 100-row activities window). */
  listedAt:     number | null;
  /** NFT name from upstream metadata (often `"#4101"`). Null for MMM pool
   *  rows / Tensor until wired. */
  nftName:      string | null;
  /** NFT thumbnail URL. Null when unavailable. */
  imageUrl:     string | null;
}

interface BidsApiResponse {
  bids: Record<string, {
    floorLamports:     number | null;
    meBidLamports:     number | null;
    tnsrBidLamports:   number | null;
    listedCount:       number | null;
    volumeAllLamports: number | null;
  }>;
}
/** Shape of GET /api/collections/stats — backend is the single source of
 *  truth for Stats rows 1+2. Keyed by slug only. */
interface StatsApiResponse {
  stats: {
    sales10m: number;
    sales1h:  number;
    sales24h: number;
    floor1h:  number | null;
    floor24h: number | null;
    vol24h:   number;
    vol7d:    number;
  };
}

type BuyStatus =
  | { kind: 'idle' }
  | { kind: 'busy';  step: 'preparing' | 'signing' }
  | { kind: 'done';  signature: string }
  | { kind: 'error'; message: string };

// ── name → abbr/color (slug fallback when COLLECTIONS_DB has no entry) ──────
function abbrOf(name: string): string {
  const w = name.split(/\s+/).filter(Boolean);
  return ((w.length >= 2 ? (w[0][0] ?? '') + (w[1][0] ?? '') : name.slice(0, 2)) || '??').toUpperCase();
}
function colorOf(name: string): string {
  let h = 0; for (let i = 0; i < name.length; i++) h = (h + name.charCodeAt(i)) | 0;
  const palette = ['#ff8c42', '#36b868', '#8068d8', '#4e8cd4', '#c9a820', '#28a878', '#d47832', '#b01d62', '#2fa8d8', '#c084fc', '#e879f9'];
  return palette[Math.abs(h) % palette.length];
}

// ── Normalized NFT presentation (Collection page only) ─────────────────────
//
// Single helper called identically for listings and trades so the same mint
// renders identically in both panels. Strict priority ladder per spec:
//
//   NAME:
//     1. explicit metadata nftName ("Fox #7443") → used as-is
//        ("#4101" → stem + "#4101"; bare number ignored — never pure "3239")
//     2. stem + #mint4       (e.g. "Retardio Cousins #E5hY")
//     3. slug + #mint4       (fallback when no stem)
//     Never: raw slug alone, plain number, or "Unknown #?".
//
//   IMAGE:
//     1. shared `imageByMint` map built from the current listings snapshot
//        (ME thumbnails — `extra.img` / `token.image`). Same map drives
//        listings AND trades so an NFT listed in the left panel and traded
//        in the middle panel shows the same thumbnail.
//     2. row's own imageUrl (trades carry ME activities' `image`, listings
//        have it already).
//     3. null → ItemThumb falls back to initials + color.
//
// The render still splits `baseName` + `num` for the existing visual style
// (bold name + dim `#NNNN`). `num` is always either the token-id digits or
// the first 4 chars of the mint.
// Thumbnail downscaling. Thumbs render at 32×32 but upstream metadata URLs
// often serve 1 000 px+ originals (NFT PFPs are commonly 2 000×2 000, ~2 MB).
//
// Route every http(s) URL through wsrv.nl — a public image proxy that
// accepts any URL and returns a resized / server-side-cached response. Not
// an npm dependency; a URL rewrite. Probed bandwidth reduction on the same
// Cloudfront-hosted 2 MB PFP: 2 163 204 B → 110 842 B (~20×).
//
// GIF handling: if the source is animated, force static first-frame output
// via wsrv.nl's `output=png` flag (PNG is non-animated by format, so wsrv
// returns only frame 0). Prevents animated thumbnails on the Collection
// page — they cause scroll jank and additional bandwidth.
//
// The naive `${url}?width=&height=` form was a placebo against ME's
// Cloudfront distribution — verified with HEAD requests: same
// content-length with and without query params. It gets routed through
// wsrv too so the perf gain lands on every collection, not just
// proxy-capable hosts.
//
// Non-http URLs (data URIs, relative paths) pass through untouched.
// When a new listings snapshot arrives, detect reprices by id-stable
// price diff and stamp `listedAt = Date.now()` so the row's timer resets
// to "just now". The server's `listedAt` comes from ME's /activities?type=list
// feed (top-100 only); reprices on secondary sources — Tensor-indexed ME
// rows, or listings older than the 100-row window — never update it, even
// though `priceSol` does. Price-diff detection catches those.
//
// MMM pool rows are excluded: their priceSol shifts with the pool's spot
// curve on every snapshot recompute, which isn't a user-visible reprice
// event; their `listedAt` stays null as the backend intends.
function mergeListingsWithRepriceTimer(prev: ListingRow[], incoming: ListingRow[]): ListingRow[] {
  const prevById = new Map(prev.map(l => [l.id, l]));
  const now = Date.now();
  return incoming.map(l => {
    if (l.id.startsWith('MMM:')) return l;
    const was = prevById.get(l.id);
    if (was && was.priceSol !== l.priceSol) return { ...l, listedAt: now };
    return l;
  });
}

function resolveNftDisplay(input: {
  nftName:  string | null | undefined;
  mint:     string | null | undefined;
  imageUrl: string | null | undefined;
  stem:     string | null;
  imageByMint: Map<string, string>;
}): { name: string; baseName: string; num: string; image: string | null } {
  const { nftName, mint, imageUrl, stem, imageByMint } = input;
  const mint4 = mint ? mint.slice(0, 4) : '';
  const cleanStem = stem && stem !== 'Unknown' ? stem : null;

  let baseName: string;
  let num: string;

  const isPlaceholder = !nftName || nftName === 'Unknown #?' || nftName === 'Unknown';
  if (!isPlaceholder && nftName) {
    // "Collection #1234" / "Collection 1234"
    const m1 = nftName.match(/^(.+?)\s*#?\s*(\d+)\s*$/);
    if (m1) {
      baseName = m1[1].trim();
      num = m1[2];
    } else {
      // "#1234" (ME listings' token.name) → prepend stem; never show a bare number
      const m2 = nftName.match(/^\s*#?\s*(\d+)\s*$/);
      if (m2) {
        baseName = cleanStem ?? 'Unknown';
        num = m2[1];
      } else {
        // Free-form name — keep it; no num split available.
        baseName = nftName;
        num = '';
      }
    }
  } else if (cleanStem && mint4) {
    baseName = cleanStem;
    num = mint4;
  } else if (mint4) {
    baseName = cleanStem ?? 'Unknown';
    num = mint4;
  } else {
    baseName = 'Unknown';
    num = '';
  }

  const name = num ? `${baseName} #${num}` : baseName;

  // IMAGE priority (explicit; treats "" as absent so broken upstream rows
  // don't render as empty <img> tags):
  //   1. shared listings snapshot map (`imageByMint[mint]`)
  //   2. row's own imageUrl — trades that aren't currently listed still
  //      carry their ME-activities `image` field end-to-end via
  //      collection-trade-history.ts → fromRow → fromBackend → FeedEvent
  //   3. null — ItemThumb renders the abbr/color placeholder
  let image: string | null = null;
  const fromMap = mint ? imageByMint.get(mint) : undefined;
  if (fromMap) image = compressImage(fromMap);
  else if (imageUrl) image = compressImage(imageUrl);

  return { name, baseName, num, image };
}

// ── ListingRow (port of original; price label becomes the live Buy button) ─
const ListingRowItem = memo(function ListingRowItem({
  listing, nameStem, imageByMint, floor, abbr, color, status, walletConnected, buyEnabled, onBuy,
}: {
  listing: ListingRow;
  nameStem: string | null;
  imageByMint: Map<string, string>;
  /** Cheapest priceSol across the currently-displayed listings. Used to
   *  classify each row as strong/good/normal deal — parent computes once. */
  floor: number | null;
  abbr: string;
  color: string;
  status: BuyStatus;
  walletConnected: boolean;
  buyEnabled: boolean | null;
  onBuy: (listing: ListingRow) => void;
}) {
  const { baseName, num, image } = resolveNftDisplay({
    nftName:  listing.nftName,
    mint:     listing.mint,
    imageUrl: listing.imageUrl,
    stem:     nameStem,
    imageByMint,
  });
  const isMe = listing.marketplace === 'me';
  const busy = status.kind === 'busy';
  const done = status.kind === 'done';
  const errored = status.kind === 'error';
  const serverDisabled = buyEnabled === false;
  const probing        = buyEnabled === null;
  // Buy execution is wired for ME only; Tensor rows render with the BUY
  // button disabled (no buy flow yet) — same affordance shape, no layout change.
  const disabled = !isMe || busy || serverDisabled || probing || !walletConnected;
  const buyLabel =
    done            ? '✓'        :
    errored         ? 'retry'    :
    busy            ? (status.step === 'preparing' ? '…' : 'sign') :
    !isMe           ? 'BUY'      :
                      'BUY';
  const buyTitle = errored
    ? `error: ${(status as { kind: 'error'; message: string }).message}`
    : !isMe             ? 'Tensor buy flow not yet implemented'
    : serverDisabled    ? 'Buy unavailable: ME_API_KEY not set on server'
    : !walletConnected  ? 'Connect Phantom to buy'
    :                     `Buy ${listing.priceSol.toFixed(3)} SOL`;
  // Deal classification — purely cosmetic. `strong` = within +5 % of floor;
  // `good` = within +10 %. Uses inset box-shadow + tinted background so
  // there's zero layout shift (no border / outline / extra DOM nodes).
  let dealLevel: 'strong' | 'good' | 'normal' = 'normal';
  if (floor !== null && floor > 0 && listing.priceSol > 0) {
    const ratio = listing.priceSol / floor;
    if      (ratio <= 1.05) dealLevel = 'strong';
    else if (ratio <= 1.10) dealLevel = 'good';
  }
  const dealStyle: React.CSSProperties =
    dealLevel === 'strong' ? {
      boxShadow:  'inset 0 0 0 1px rgba(79,209,144,0.45)',
      background: 'rgba(79,209,144,0.06)',
    }
    : dealLevel === 'good' ? {
      background: 'rgba(79,209,144,0.025)',
    }
    : {};
  return (
    <div className="listing-row"
      style={{ display:'flex', alignItems:'center', gap:8, padding:'5px 8px', cursor:'pointer', ...dealStyle }}>
      <ItemThumb imageUrl={image} color={color} abbr={abbr} size={32} />
      <div style={{ flex:1, minWidth:0, display:'flex', flexDirection:'column', gap:2 }}>
        {/* Line 1: unified `{stem} #{num}` + listedAt on the right */}
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:6 }}>
          <span style={{ fontSize:11, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', minWidth:0 }}>
            <span style={{ fontWeight:600, color:'#d4d4e8' }}>{baseName}</span>
            {num && <span style={{ color:'#56566e', marginLeft:4 }}>#{num}</span>}
          </span>
          <span style={{ fontSize:10, color:'#56566e', flexShrink:0 }}>{listing.listedAt ? timeAgo(listing.listedAt) : '—'}</span>
        </div>
        {/* Line 2: rank LEFT — price + buy + mkt RIGHT */}
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:4 }}>
          {listing.rank != null ? <RankBadge rank={listing.rank} /> : <span style={{ width: 1 }} />}
          <div style={{ display:'flex', alignItems:'center', gap:4 }}>
            {/* BEST near-floor badge temporarily removed — will return in a
             *  cleaner form. Price + BUY + marketplace badge unchanged. */}
            <span style={{ fontSize:11, fontWeight:700, color:'#f0eef8' }}>{formatSol(listing.priceSol)}</span>
            <button
              onClick={(e) => { e.stopPropagation(); if (!disabled) onBuy(listing); }}
              disabled={disabled}
              title={buyTitle}
              style={{
                display:'inline-flex', alignItems:'center', fontSize:10, fontWeight:700,
                padding:'1px 6px', borderRadius:3,
                border:`1px solid ${errored ? '#bf5f5f48' : '#36b86848'}`,
                background: errored ? '#bf5f5f20' : '#36b86820',
                color: errored ? '#e58585' : '#4fd190',
                letterSpacing:'0.3px', flexShrink:0, lineHeight:'14px',
                cursor: disabled ? 'default' : 'pointer',
                opacity: disabled && !busy ? 0.55 : 1,
              }}>{buyLabel}</button>
            <MktBadge mp={listing.marketplace} />
          </div>
        </div>
      </div>
    </div>
  );
});

/**
 * Collection-page-only trade-row marketplace link. Per product requirement:
 *   Magic Eden trades → https://magiceden.io/item-details/<mint>
 *   Tensor trades     → https://www.tensor.trade/item/<mint>
 *
 * Kept local to this file so the shared `marketplaceUrl` (which routes to
 * the collection-marketplace page for ME-with-slug) remains unchanged for
 * Live Feed and any other consumer.
 */
function tradeItemUrl(event: FeedEvent): string | null {
  if (event.marketplace === 'tensor') {
    return event.mintAddress
      ? `https://www.tensor.trade/item/${event.mintAddress}`
      : 'https://www.tensor.trade';
  }
  return event.mintAddress
    ? `https://magiceden.io/item-details/${event.mintAddress}`
    : 'https://magiceden.io';
}

// ── TradeRow (unified presentation via resolveNftDisplay + ItemThumb) ────
const TradeRowItem = memo(function TradeRowItem({
  event, tick, nameStem, imageByMint,
}: {
  event: FeedEvent;
  tick: number;
  nameStem: string | null;
  imageByMint: Map<string, string>;
}) {
  void tick;  // re-render hook: parent bumps `tick` so timeAgo refreshes
  const ago = event.ts > Date.now() - 10000 ? 'just now' : timeAgo(event.ts);
  const isNew = event.ts > Date.now() - 5000;
  // Shared presentation: same resolver as ListingRowItem. The imageByMint
  // map is built from the current listings snapshot so an NFT that's both
  // listed and trading shows the same thumbnail in both panels.
  const collName = event.collectionName && event.collectionName !== 'Unknown' ? event.collectionName : null;
  const stem = nameStem ?? collName ?? event.meCollectionSlug ?? null;
  const { baseName, num, image } = resolveNftDisplay({
    nftName:  event.nftName,
    mint:     event.mintAddress,
    imageUrl: event.imageUrl,
    stem,
    imageByMint,
  });
  return (
    <div className={`trade-row${isNew ? ' new-row-trade' : ''}`}
      style={{ display:'flex', alignItems:'center', gap:8, padding:'5px 8px', cursor:'pointer' }}>
      <ItemThumb imageUrl={image} color={event.color} abbr={event.abbr} size={32} />
      <div style={{ flex:1, minWidth:0, display:'flex', flexDirection:'column', gap:2 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', gap:6 }}>
          <span style={{ fontSize:11, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', minWidth:0 }}>
            <span style={{ fontWeight:600, color:'#d4d4e8' }}>{baseName}</span>
            {num && <span style={{ color:'#56566e', marginLeft:4 }}>#{num}</span>}
          </span>
          <span style={{ fontSize:10, color: isNew ? '#e87ab0' : '#56566e', flexShrink:0, fontWeight: isNew ? 600 : 400 }}>{ago}</span>
        </div>
        <div style={{ display:'flex', alignItems:'center', justifyContent:'space-between', gap:4 }}>
          <span style={{ fontSize:10, color:'#56566e' }}>{shortWallet(event.buyer)}</span>
          <div style={{ display:'flex', alignItems:'center', gap:4 }}>
            <span style={{ fontSize:11, fontWeight:700, color: event.side === 'buy' ? '#4fd190' : '#e58585' }}>{formatSol(event.price)}</span>
            <TypeBadge type={event.side} />
            <MktBadge mp={event.marketplace} href={tradeItemUrl(event)} />
          </div>
        </div>
      </div>
    </div>
  );
});

// ── StatItem (verbatim port; flickers when value changes) ──────────────────
function StatItem({ value, label, highlight, title }: { value: React.ReactNode; label: string; highlight?: string; title?: string }) {
  const prev = useRef(value);
  const [flick, setFlick] = useState(false);
  useEffect(() => {
    if (prev.current !== value) {
      prev.current = value;
      setFlick(true);
      const id = setTimeout(() => setFlick(false), 900);
      return () => clearTimeout(id);
    }
  }, [value]);
  return (
    <div title={title} style={{ display:'flex', flexDirection:'column', alignItems:'flex-start', gap:1, padding:'5px 10px' }}>
      <span className={flick ? 'stat-flicker' : ''} style={{ fontSize:13, fontWeight:700, color: highlight || '#aaaabf', letterSpacing:'-0.3px' }}>{value}</span>
      <span style={{ fontSize:8, fontWeight:600, color:'#2c2c44', letterSpacing:'0.5px', textTransform:'uppercase' }}>{label}</span>
    </div>
  );
}

// ── FilterBtn / DropBtn (verbatim ports; non-functional placeholders) ──────
function FilterBtn({ label }: { label: string }) {
  const [active, setActive] = useState(false);
  return (
    <button onClick={() => setActive(a => !a)} style={{
      padding:'2px 6px', fontSize:10, borderRadius:3,
      border:`1px solid ${active ? '#8068d866' : '#ffffff0d'}`,
      background: active ? '#8068d818' : '#ffffff07',
      color: active ? '#8068d8' : '#56566e',
      cursor:'pointer', transition:'all 0.12s',
    }}>{label}</button>
  );
}
function DropBtn({ label }: { label: string }) {
  return (
    <button style={{
      display:'flex', alignItems:'center', gap:3, padding:'2px 5px', fontSize:10,
      borderRadius:3, border:'1px solid #ffffff0d', background:'#ffffff07',
      color:'#56566e', cursor:'pointer',
    }}>{label} <span style={{color:'#3a3a52'}}>▼</span></button>
  );
}

// ── Header social-icon primitive ───────────────────────────────────────────
//
// Rounded-square chip shared by every marketplace / social link in the
// Collection header. Two variants:
//   - "brand":  background = brand color, glyph = white   (ME, Tensor)
//   - "social": background = subtle dark, glyph = light muted (X, Discord, Web)
// Hover lifts opacity/border so the chip lights up consistently regardless
// of which variant it is.
interface ChipStyle { bg: string; glyph: string; border: string }
function SocialIconLink({
  href, label, children, style,
}: {
  href: string;
  label: string;
  children: React.ReactNode;
  style: ChipStyle;
}) {
  const [hover, setHover] = useState(false);
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display:'inline-flex', alignItems:'center', justifyContent:'center',
        width:18, height:18, borderRadius:4,
        border:`1px solid ${style.border}`,
        background: style.bg,
        color: style.glyph,
        textDecoration:'none', cursor:'pointer',
        overflow:'hidden',  // clip brand PNGs to the chip's rounded silhouette
        transition:'transform 0.12s ease, filter 0.12s ease',
        transform: hover ? 'translateY(-1px)' : 'none',
        filter: hover ? 'brightness(1.15)' : 'none',
      }}
    >
      {children}
    </a>
  );
}

// Chip-style presets.
const BRAND_ME:      ChipStyle = { bg: '#E42575', glyph: '#ffffff', border: '#E4257544' };
const BRAND_TENSOR:  ChipStyle = { bg: '#0f0d18', glyph: '#ffffff', border: '#ffffff1a' };
const SOCIAL_CHIP:   ChipStyle = { bg: '#ffffff08', glyph: '#c4c0d6', border: '#ffffff14' };
const DISCORD_CHIP:  ChipStyle = { bg: '#ffffff08', glyph: '#8b93f0', border: '#ffffff14' };

// ── Brand + social glyphs ───────────────────────────────────────────────────
//
// All glyphs use `fill="currentColor"` so the chip's `color` prop drives the
// stroke/fill — brand chips render white; social chips render in their
// muted / tinted palette.

// Brand marks — real PNG assets from `public/brand/`. Served by Next.js as
// static files, so no import or bundler step is needed. Rendered at the
// same ~15×15 footprint the prior inline SVGs occupied, no layout shift.
// `display:block` prevents the default inline baseline gap inside the
// flex chip.
// Brand PNGs fill the smaller 18×18 chip. `objectFit:cover` + chip's
// `overflow:hidden` keeps the branded tile clipped to the rounded
// silhouette without introducing a padding ring that doesn't match the
// PNG's own brand-color exactly.
const MagicEdenGlyph = () => (
  <img src="/brand/me.png" alt=""
       draggable={false}
       style={{ display:'block', width:'100%', height:'100%', objectFit:'cover', pointerEvents:'none' }} />
);
const TensorGlyph = () => (
  <img src="/brand/tensor.png" alt=""
       draggable={false}
       style={{ display:'block', width:'100%', height:'100%', objectFit:'cover', pointerEvents:'none' }} />
);

const TwitterGlyph = () => (
  <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" aria-hidden>
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);

const DiscordGlyph = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden>
    <path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.74 19.74 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028 14.09 14.09 0 0 0 1.226-1.994.076.076 0 0 0-.041-.106 13.1 13.1 0 0 1-1.872-.892.077.077 0 0 1-.008-.128q.189-.143.372-.292a.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01q.183.149.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.06.06 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
  </svg>
);

const GlobeGlyph = () => (
  <svg viewBox="0 0 24 24" width="14" height="14"
       fill="none" stroke="currentColor" strokeWidth="1.7"
       strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <circle cx="12" cy="12" r="9" />
    <path d="M3 12h18" />
    <path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18z" />
  </svg>
);

// ── Page ───────────────────────────────────────────────────────────────────

export default function CollectionPage() {
  const params = useParams<{ slug: string }>();
  const slug = decodeURIComponent(params.slug);

  // Tab + chart selectors (verbatim from original)
  const [tab, setTab] = useState<'live' | 'summary'>('live');
  const [span, setSpan] = useState<Span>('7D');
  const [interval_, setInterval_] = useState<Interval>('5M');
  const [outliers, setOutliers] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [tradeFiltersOpen, setTradeFiltersOpen] = useState(false);

  // Cold-slug heartbeat: tells the backend "a Collection page is open on this
  // slug right now". Backend uses this to gate the listing_refresh_hint path
  // (see src/server/subscribers.ts). 20 s interval stays well below the
  // server-side 45 s TTL so a brief network hiccup doesn't flip us cold.
  useEffect(() => {
    if (!slug) return;
    const ping = () => fetch(
      `${API_BASE}/api/collections/heartbeat?slug=${encodeURIComponent(slug)}`,
    ).catch(() => { /* transient — next tick retries */ });
    ping();
    const id = setInterval(ping, 20_000);
    return () => clearInterval(id);
  }, [slug]);

  // ── Sound alerts v1 (Collection-page-only) ───────────────────────────────
  // WebAudio-synthesized blips; no external assets, no network requests. The
  // AudioContext is created lazily on the first user gesture (sound toggle
  // click) so browser autoplay policies never block us. Each alert type has
  // an independent cooldown so signals fire at most once per window and
  // never turn into continuous noise.
  const [soundOn, setSoundOn] = useState(true);
  const audioCtxRef       = useRef<AudioContext | null>(null);
  const lastAlertRef      = useRef<Record<'dump' | 'undercut' | 'buy', number>>({ dump: 0, undercut: 0, buy: 0 });
  const ALERT_COOLDOWN_MS = 12_000;

  function ensureAudioCtx(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (audioCtxRef.current) return audioCtxRef.current;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const Ctor: typeof AudioContext | undefined = (window.AudioContext ?? (window as any).webkitAudioContext);
    if (!Ctor) return null;
    try {
      audioCtxRef.current = new Ctor();
      return audioCtxRef.current;
    } catch { return null; }
  }

  function playTone(kind: 'dump' | 'undercut' | 'buy'): void {
    if (!soundOn) return;
    const now = Date.now();
    if (now - lastAlertRef.current[kind] < ALERT_COOLDOWN_MS) return;
    const ctx = ensureAudioCtx();
    if (!ctx) return;
    lastAlertRef.current[kind] = now;
    try {
      // iOS-style two-note blip: sine-only, smooth exponential attack/decay,
      // low peak gain. Notes overlap by ~0.05 s so they read as a single soft
      // chirp instead of two separate beeps. Total duration ≤ ~0.25 s.
      //
      // undercut → ascending  (opportunity)
      // buy      → ascending  (opportunity, slightly lower register)
      // dump     → descending (warning)
      const t0 = ctx.currentTime;
      const note = (freq: number, startOffset: number, duration: number, peakGain: number): void => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, t0 + startOffset);
        gain.gain.setValueAtTime(0.0001, t0 + startOffset);
        gain.gain.exponentialRampToValueAtTime(peakGain, t0 + startOffset + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001,   t0 + startOffset + duration);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t0 + startOffset);
        osc.stop( t0 + startOffset + duration + 0.02);
      };
      const [f1, f2, peak]: [number, number, number] =
        kind === 'dump'     ? [500, 350, 0.055] :
        kind === 'undercut' ? [700, 900, 0.07 ] :
                              [660, 820, 0.065];  // buy
      note(f1, 0,    0.14, peak);
      note(f2, 0.09, 0.14, peak);
    } catch { /* audio unavailable — ignore silently */ }
  }

  function toggleSound(): void {
    const next = !soundOn;
    setSoundOn(next);
    // First toggle-on is a user gesture — seed the AudioContext now so the
    // next signal plays without a delay. Safari also needs resume() after a
    // user gesture the first time.
    if (next) {
      const ctx = ensureAudioCtx();
      if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => {});
    }
  }

  // tick: bump every 2 s so timeAgo refreshes inside memoized rows
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick(n => n + 1), 2000);
    return () => clearInterval(id);
  }, []);

  // ── Slug-switch reset ──────────────────────────────────────────────────
  // Trades are held in the shared feed reducer so SSE append/meta/rawpatch/
  // remove actions merge into the fetched history (rather than overwriting
  // or replacing it). Cap is intentionally >= HISTORY_FETCH_LIMIT so the
  // snapshot never gets clipped by live-event eviction.
  const [feedState, dispatchFeed] = useReducer(feedReducer, undefined, () => initFeedState(MAX_EVENTS));
  const events = useMemo(() => orderedEvents(feedState), [feedState]);
  // `events` is already sorted newest-first by the reducer; cap the rendered
  // slice so the TRADES panel never draws a wall of rows. Full buffer stays
  // in state for counters and future filters.
  const visibleEvents = useMemo(() => events.slice(0, VISIBLE_TRADES_MAX), [events]);
  // ── Bid-dump detector ────────────────────────────────────────────────────
  // Count bid_sell trades in the last 60s. `tick` (bumped every 2s) makes this
  // auto-re-evaluate so the badge clears itself as events age out, even when
  // no new trades arrive. Reads the full `events` buffer — not `visibleEvents`
  // — so the 200-row display cap can never hide burst activity.
  // v2 aggregates: count, total SOL, and largest single sell in the same
  // 60s window. Single pass over the newest-first buffer, early-break when
  // we age out of the window. `tick` (2s) keeps the window sliding when no
  // new trades arrive so the pill clears itself on schedule.
  const bidDumpStats = useMemo(() => {
    const cutoff = Date.now() - 60_000;
    let count = 0, volume = 0, largest = 0;
    for (const e of events) {
      if (e.ts < cutoff) break;
      if (e.saleTypeRaw !== 'bid_sell') continue;
      count++;
      volume += e.price;
      if (e.price > largest) largest = e.price;
    }
    return { count, volume, largest };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, tick]);
  // Severity tiers: deterministic thresholds, strongest-wins.
  //   extreme: count>=8 OR volume>=20◎
  //   strong : count>=5 OR volume>=10◎
  //   mild   : count>=3
  //   else   : no signal
  const bidDumpSeverity: 'extreme' | 'strong' | 'mild' | null =
    (bidDumpStats.count >= 8 || bidDumpStats.volume >= 20) ? 'extreme' :
    (bidDumpStats.count >= 5 || bidDumpStats.volume >= 10) ? 'strong'  :
    (bidDumpStats.count >= 3)                              ? 'mild'    :
    null;
  // Extract the collection's item-name stem from any sibling enriched row
  // (e.g. "Fox" from "Fox #7443"). Used by TradeRowItem as the first-choice
  // fallback for backfilled rows whose own nftName is null. Memoized — stem
  // changes only when the first enriched event arrives.
  const nameStem = useMemo<string | null>(() => {
    for (const e of events) {
      if (!e.nftName || e.nftName === 'Unknown #?') continue;
      const m = e.nftName.match(/^(.+?)\s*#\s*\d+\s*$/);
      if (m && m[1]) return m[1].trim();
    }
    return null;
  }, [events]);
  const [loaded,        setLoaded]        = useState(false);
  const [resolvedName,  setResolvedName]  = useState<string | null>(null);
  const [floorSol,      setFloorSol]      = useState<number | null>(null);
  const [statsData,     setStatsData]     = useState<StatsApiResponse['stats'] | null>(null);
  const [listedCount,   setListedCount]   = useState<number | null>(null);
  const [volumeAllSol,  setVolumeAllSol]  = useState<number | null>(null);
  const [listings,      setListings]      = useState<ListingRow[]>([]);
  // Shared mint→image map built from the current listings snapshot. Same
  // lifecycle as listings (rebuilds on refresh / SSE delta). Reused by both
  // ListingRowItem and TradeRowItem via resolveNftDisplay so an NFT that's
  // both listed and trading shows the same thumbnail in both panels.
  const imageByMint = useMemo<Map<string, string>>(() => {
    const m = new Map<string, string>();
    for (const l of listings) {
      if (l.imageUrl && l.mint) m.set(l.mint, l.imageUrl);
    }
    return m;
  }, [listings]);
  // Displayed floor — the cheapest row in the listings panel. Used by
  // ListingRowItem to classify each row as strong/good/normal deal.
  const listingsFloor = useMemo<number | null>(() => {
    if (!listings.length) return null;
    let min = Infinity;
    for (const l of listings) if (l.priceSol > 0 && l.priceSol < min) min = l.priceSol;
    return Number.isFinite(min) ? min : null;
  }, [listings]);

  // ── Listing / undercut detector v2 ───────────────────────────────────────
  // Rolling window of actionable events (undercut / near-floor) emitted when
  // newly-added listing ids first appear. Each event stores the price and
  // the undercut %-vs-prior-floor at the moment it was seen. Stale entries
  // (> 60s) are pruned on every listings update AND on every `tick` so the
  // aggregates slide forward even without new arrivals.
  //
  // Bootstrap on first snapshot / slug switch seeds refs without flagging.
  type ListingSignal = {
    kind:        'undercut' | 'near_floor';
    priceSol:    number;
    undercutPct: number;     // 0 for near_floor
    ts:          number;
  };
  const NEAR_FLOOR_RATIO      = 1.03;
  const SIGNAL_WINDOW_MS      = 60_000;
  const prevIdsRef   = useRef<Set<string> | null>(null);
  const prevFloorRef = useRef<number | null>(null);
  const [listingSignals, setListingSignals] = useState<ListingSignal[]>([]);

  useEffect(() => {
    const prevIds   = prevIdsRef.current;
    const prevFloor = prevFloorRef.current;
    const nextIds   = new Set(listings.map(l => l.id));
    const nextFloor = listingsFloor;

    // Bootstrap: first snapshot or post-reset. Seed refs, don't flag.
    if (prevIds === null) {
      prevIdsRef.current   = nextIds;
      prevFloorRef.current = nextFloor;
      return;
    }

    const fresh: ListingSignal[] = [];
    if (prevFloor != null) {
      const now = Date.now();
      for (const l of listings) {
        if (prevIds.has(l.id)) continue;         // not a new id
        if (!(l.priceSol > 0)) continue;
        if (l.priceSol < prevFloor) {
          fresh.push({
            kind:        'undercut',
            priceSol:    l.priceSol,
            undercutPct: ((prevFloor - l.priceSol) / prevFloor) * 100,
            ts:          now,
          });
        } else if (l.priceSol <= prevFloor * NEAR_FLOOR_RATIO) {
          fresh.push({
            kind:        'near_floor',
            priceSol:    l.priceSol,
            undercutPct: 0,
            ts:          now,
          });
        }
      }
    }

    if (fresh.length > 0) {
      const cutoff = Date.now() - SIGNAL_WINDOW_MS;
      setListingSignals(prev => {
        const kept = prev.filter(s => s.ts >= cutoff);
        return kept.concat(fresh);
      });
    }

    prevIdsRef.current   = nextIds;
    prevFloorRef.current = nextFloor;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listings, listingsFloor]);

  // `tick` (2 s) prunes expired entries even when no new listings arrive,
  // so the pill clears itself on schedule. Derived aggregates are recomputed
  // from the pruned set in the next memo.
  useEffect(() => {
    const cutoff = Date.now() - SIGNAL_WINDOW_MS;
    setListingSignals(prev => {
      if (prev.length === 0) return prev;
      const kept = prev.filter(s => s.ts >= cutoff);
      return kept.length === prev.length ? prev : kept;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick]);

  // Rolling aggregates + severity tier.
  //   label: 'UNDERCUT' if any undercut in window, else 'NEAR FLOOR'.
  //   severity: extreme | strong | mild | null (strongest wins).
  const listingDump = useMemo(() => {
    const count = listingSignals.length;
    if (count === 0) return null;
    let strongestUndercutPct = 0;
    let cheapest = Infinity;
    let hasUndercut = false;
    for (const s of listingSignals) {
      if (s.kind === 'undercut') hasUndercut = true;
      if (s.undercutPct > strongestUndercutPct) strongestUndercutPct = s.undercutPct;
      if (s.priceSol < cheapest) cheapest = s.priceSol;
    }
    const severity: 'extreme' | 'strong' | 'mild' =
      (count >= 3 || strongestUndercutPct >= 5) ? 'extreme' :
      (count >= 2 || strongestUndercutPct >= 3) ? 'strong'  :
      'mild';
    return {
      count,
      cheapest:             Number.isFinite(cheapest) ? cheapest : 0,
      strongestUndercutPct,
      label:   (hasUndercut ? 'UNDERCUT' : 'NEAR FLOOR') as 'UNDERCUT' | 'NEAR FLOOR',
      severity,
    };
  }, [listingSignals]);

  // Reset detector on slug switch so the new collection starts clean.
  useEffect(() => {
    prevIdsRef.current   = null;
    prevFloorRef.current = null;
    setListingSignals([]);
  }, [slug]);

  // ── Combined market signal ───────────────────────────────────────────────
  // Reactive summary over the existing detectors — no new state, no timers.
  //   MIXED          : both detectors active (any severity)
  //   SELL PRESSURE  : bidDump strong/extreme, listings inactive
  //   BUY OPPORTUNITY: listingDump strong/extreme, bidDump inactive
  //   null           : weak or absent → fall back to the per-side pills
  // Transition detection: fire on null→active (bid dump) and on
  // "not-UNDERCUT" → "UNDERCUT" (listings). Cooldown is enforced inside
  // playTone() so a rapid flap doesn't become noise.
  const prevBidSeverityRef = useRef<typeof bidDumpSeverity>(null);
  useEffect(() => {
    if (prevBidSeverityRef.current === null && bidDumpSeverity !== null) {
      playTone('dump');
    }
    prevBidSeverityRef.current = bidDumpSeverity;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bidDumpSeverity]);

  const prevListingLabelRef = useRef<'UNDERCUT' | 'NEAR FLOOR' | null>(null);
  useEffect(() => {
    const label = listingDump?.label ?? null;
    if (label === 'UNDERCUT' && prevListingLabelRef.current !== 'UNDERCUT') {
      playTone('undercut');
    }
    prevListingLabelRef.current = label;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listingDump]);

  const marketSignal = useMemo<'sell' | 'buy' | 'mixed' | null>(() => {
    const bidActive     = bidDumpSeverity != null;
    const listingActive = listingDump != null;
    if (bidActive && listingActive) return 'mixed';
    const bidStrong     = bidDumpSeverity === 'strong' || bidDumpSeverity === 'extreme';
    const listingStrong = listingActive && (listingDump.severity === 'strong' || listingDump.severity === 'extreme');
    if (bidStrong)     return 'sell';
    if (listingStrong) return 'buy';
    return null;
  }, [bidDumpSeverity, listingDump]);

  // Optional alert on BUY OPPORTUNITY transitions (non-buy → buy). Cooldown
  // is independent of the UNDERCUT alert above so the two don't blur.
  const prevMarketSignalRef = useRef<typeof marketSignal>(null);
  useEffect(() => {
    if (marketSignal === 'buy' && prevMarketSignalRef.current !== 'buy') {
      playTone('buy');
    }
    prevMarketSignalRef.current = marketSignal;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marketSignal]);
  const [buyStatuses,   setBuyStatuses]   = useState<Record<string, BuyStatus>>({});
  const [chartPoints,   setChartPoints]   = useState<ScatterPoint[]>([]);
  // ── Progressive-reveal render caps ──────────────────────────────────────
  // The listings / trades state buffers are populated as before; the page
  // only paints this many rows per panel on first render, then grows in
  // GROW_STEP increments as the user scrolls near the bottom. Purely a
  // render optimization — no extra network requests, no data loss.
  const INITIAL_REVEAL = 20;
  const GROW_STEP = 20;
  const [listingsShow, setListingsShow] = useState(INITIAL_REVEAL);
  const [tradesShow,   setTradesShow]   = useState(INITIAL_REVEAL);
  useEffect(() => {
    dispatchFeed({ type: 'reset' });
    setLoaded(false); setResolvedName(null);
    setFloorSol(null); setStatsData(null);
    setListedCount(null); setVolumeAllSol(null);
    setListings([]); setBuyStatuses({});
    setChartPoints([]);
    setListingsShow(INITIAL_REVEAL);
    setTradesShow(INITIAL_REVEAL);
  }, [slug]);

  // ── Server buy capability probe ────────────────────────────────────────
  const [buyEnabled, setBuyEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    fetch(`${API_BASE}/api/buy/me/status`)
      .then(r => r.ok ? r.json() : { enabled: false })
      .then((j: { enabled?: boolean }) => setBuyEnabled(!!j.enabled))
      .catch(() => setBuyEnabled(false));
  }, []);

  // ── Wallet (Phantom) ───────────────────────────────────────────────────
  const [walletPubkey, setWalletPubkey] = useState<string | null>(null);
  const [walletErr,    setWalletErr]    = useState<string | null>(null);
  useEffect(() => {
    eagerConnectPhantom().then(pk => { if (pk) setWalletPubkey(pk); }).catch(() => {});
  }, []);
  const onConnectWallet = useCallback(async () => {
    try { setWalletErr(null); setWalletPubkey(await connectPhantom()); }
    catch (err) { setWalletErr((err as Error).message); }
  }, []);
  const onDisconnectWallet = useCallback(async () => {
    try { await getPhantom()?.disconnect(); } catch { /* ignore */ }
    setWalletPubkey(null);
  }, []);

  // ── Snapshot + live SSE for trades ─────────────────────────────────────
  // The fetched history is the source of truth for the trade list; SSE
  // frames merge into it through the reducer (live/meta/rawpatch/remove)
  // and never replace the prior rows. `days=7` caps history to the last
  // week — practical window for the Collection page; keeps the snapshot
  // fast even when auto-backfill is still populating the DB.
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

    const connectSse = () => {
      if (cancelled) return;
      es?.close();
      es = new EventSource(`${API_BASE}/api/events/stream`);
      es.addEventListener('sale', (e: MessageEvent) => {
        try {
          const b = JSON.parse(e.data) as BackendEvent;
          if (b.meCollectionSlug !== slug) return;
          dispatchFeed({ type: 'live', event: fromBackend(b) });
        } catch { /* skip */ }
      });
      es.addEventListener('meta', (e: MessageEvent) => {
        try {
          const patch = JSON.parse(e.data) as MetaPatch & { meCollectionSlug: string | null };
          if (patch.meCollectionSlug !== slug) return;
          dispatchFeed({ type: 'meta', patch });
        } catch { /* skip */ }
      });
      es.addEventListener('rawpatch', (e: MessageEvent) => {
        try {
          const patch = JSON.parse(e.data) as RawPatch;
          dispatchFeed({ type: 'rawpatch', patch });
        } catch { /* skip */ }
      });
      es.addEventListener('remove', (e: MessageEvent) => {
        try {
          const { signature } = JSON.parse(e.data) as { signature: string };
          dispatchFeed({ type: 'remove', signature });
        } catch { /* skip */ }
      });
      // Backend listings-store delta: one listing row removed from this
      // slug's state, targeted by id so a cancel on ME doesn't purge a
      // sibling MMM pool entry for the same mint.
      es.addEventListener('listing_remove', (e: MessageEvent) => {
        try {
          const d = JSON.parse(e.data) as { slug: string; id: string };
          if (d.slug !== slug) return;
          setListings(prev => prev.filter(l => l.id !== d.id));
        } catch { /* skip */ }
      });
      // Backend listings-store snapshot: full replacement for this slug,
      // emitted after a server-side refresh or dirty-triggered reconciliation.
      es.addEventListener('listing_snapshot', (e: MessageEvent) => {
        try {
          const d = JSON.parse(e.data) as { slug: string; listings: ListingRow[] };
          if (d.slug !== slug) return;
          const incoming = Array.isArray(d.listings) ? d.listings : [];
          setListings(prev => mergeListingsWithRepriceTimer(prev, incoming));
        } catch { /* skip */ }
      });
      es.addEventListener('error', () => {
        es?.close();
        if (!cancelled && !document.hidden) reconnectTimer = setTimeout(connectSse, 3000);
      });
    };

    // Primary history source: Magic Eden activities (/api/collections/trade-history).
    // Falls back to the legacy DB-backed /api/events/by-collection path only on
    // ME error — handled server-side. The legacy path is also kept available as
    // a dashboard/analytics endpoint; it is no longer the Collection page's
    // canonical source for side / type / naming.
    const loadHistory = () => fetch(
      `${API_BASE}/api/collections/trade-history?slug=${encodeURIComponent(slug)}&days=7&limit=${HISTORY_FETCH_LIMIT}`,
    )
      .then(r => r.json())
      .then((data: LatestApiResponse) => {
        if (cancelled) return;
        const events: FeedEvent[] = data.events.map(r => fromBackend(fromRow(r)));
        dispatchFeed({ type: 'snapshot', events });
      })
      .catch(() => { /* SSE may still bring live events */ });

    loadHistory().finally(() => { if (!cancelled) { setLoaded(true); connectSse(); } });

    // `/events/by-collection` triggers an async detached backfill when DB row
    // count < 50. The backfill bypasses saleEventBus (separate process, direct
    // SQL insert), so connected SSE clients never learn about its writes.
    //
    // Measured timing on cold `froganas` (0 → 226 rows, 7-day window):
    //   T+0s   first fetch → 0 rows, backfill spawns
    //   T+5s   backfill already finished → 226 rows in DB
    //   T+60s  old single-retry finally fires
    // → rows sat in the DB for 55 s before the UI picked them up.
    //
    // Replace the single 60 s retry with a short ladder (5 / 15 / 45 s).
    // First retry catches the typical 2–5 s backfill; second and third cover
    // slower / degraded cases. Reducer's `snapshot` action is merge-only, so
    // redundant retries for slugs that already have full history are cheap.
    const backfillRetryTimers: ReturnType<typeof setTimeout>[] =
      [5_000, 15_000, 45_000].map(ms =>
        setTimeout(() => { if (!cancelled) loadHistory(); }, ms)
      );

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      for (const t of backfillRetryTimers) clearTimeout(t);
      es?.close();
    };
  }, [slug]);

  // ── Resolved (sticky) collection name from first valid event ───────────
  useEffect(() => {
    if (resolvedName) return;
    for (const e of events) {
      if (e.collectionName && e.collectionName !== 'Unknown') {
        setResolvedName(e.collectionName);
        break;
      }
    }
  }, [events, resolvedName]);
  const displayName = resolvedName ?? slug;
  const headerAbbr  = abbrOf(displayName);
  const headerColor = colorOf(displayName);
  // Dashboard → Collection continuity: when the Dashboard row is clicked it
  // stashes the currently-rendered preview URL under `cp-preview:<slug>`, and
  // we pick it up here on first render so the header paints the SAME avatar
  // the user just saw — no visual jump to a different NFT or initials while
  // the hook warms up. Read once on mount; hook result takes over afterward
  // only if it differs for the same slug.
  const [handoffPreview] = useState<string | null>(() => {
    if (typeof window === 'undefined' || !slug) return null;
    try { return sessionStorage.getItem(`cp-preview:${slug}`); } catch { return null; }
  });
  const iconBySlug = useCollectionIcons(useMemo(() => slug ? [slug] : [], [slug]));
  const headerIconUrl = useMemo<string | null>(() => {
    if (!slug) return null;
    const raw = handoffPreview ?? iconBySlug[slug] ?? null;
    return compressImage(raw);
  }, [iconBySlug, slug, handoffPreview]);

  // Header socials (Twitter / Discord) come from ME's per-collection
  // endpoint via backend proxy (1h cache, so one ME hit per slug per hour
  // regardless of how many users open the page). Twitter/Discord icons
  // only render when a link actually exists; ME/Tensor icons are always
  // visible because their marketplace URLs are deterministic from the slug.
  const [socials, setSocials] = useState<{ twitter: string | null; discord: string | null; website: string | null }>({ twitter: null, discord: null, website: null });
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    fetch(`${API_BASE}/api/collections/meta?slug=${encodeURIComponent(slug)}`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { name?: string | null; twitter?: string | null; discord?: string | null; website?: string | null } | null) => {
        if (cancelled || !data) return;
        setSocials({
          twitter: typeof data.twitter === 'string' ? data.twitter : null,
          discord: typeof data.discord === 'string' ? data.discord : null,
          website: typeof data.website === 'string' ? data.website : null,
        });
        // Seed the display name from the catalog/metadata response. Without
        // this, `resolvedName` stayed null until an SSE sale event with a
        // matching collectionName arrived, and the header rendered the
        // lowercase URL slug (`loudlords`) instead of the proper brand name
        // (`Loud Lords`). Only set if we don't already have something from
        // the event stream — don't clobber a live-enriched name.
        if (typeof data.name === 'string' && data.name.length > 0) {
          setResolvedName(prev => prev ?? data.name ?? null);
        }
      })
      .catch(() => { /* silent — icons just won't render */ });
    return () => { cancelled = true; };
  }, [slug]);

  // ── Stats: floor + listed + total volume + ME bid ──────────────────────
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/collections/bids?slugs=${encodeURIComponent(slug)}`);
        if (!res.ok) return;
        const json = await res.json() as BidsApiResponse;
        if (cancelled) return;
        const v = json.bids[slug];
        setFloorSol(v?.floorLamports     == null ? null : v.floorLamports     / 1e9);
        setListedCount(v?.listedCount    ?? null);
        setVolumeAllSol(v?.volumeAllLamports == null ? null : v.volumeAllLamports / 1e9);
      } catch { /* transient */ }
    };
    load();
    const id = setInterval(load, STATS_REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [slug]);

  // ── Derived aggregates from sale_events (backend is source of truth) ────
  // Keyed by slug — independent of `resolvedName` so vol/floor figures render
  // immediately, without waiting for a trade row to populate collectionName.
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/collections/stats?slug=${encodeURIComponent(slug)}`);
        if (!res.ok) return;
        const json = await res.json() as StatsApiResponse;
        if (cancelled) return;
        setStatsData(json.stats);
      } catch { /* transient */ }
    };
    load();
    const id = setInterval(load, STATS_REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [slug]);

  // ── LEFT column: listings open + long-cadence reconciliation ───────────
  // On collection open: fetch one snapshot. After that, incremental updates
  // arrive via SSE (`listing_remove` / `listing_snapshot`). A 5-minute
  // reconciliation poll is kept as a safety net for the transitions we don't
  // yet receive as deltas (cancel / delist / pool deposit/withdraw) — not
  // the hot path.
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/collections/listings?slug=${encodeURIComponent(slug)}&limit=500`);
        if (!res.ok) return;
        const json = await res.json() as { listings: ListingRow[] };
        if (cancelled) return;
        const incoming = Array.isArray(json.listings) ? json.listings : [];
        setListings(prev => mergeListingsWithRepriceTimer(prev, incoming));
      } catch { /* transient */ }
    };
    load();
    const id = setInterval(load, LISTINGS_REFRESH_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [slug]);

  // ── Buy executor (mint-keyed status) ───────────────────────────────────
  const onBuyListing = useCallback(async (listing: ListingRow) => {
    if (!walletPubkey) return;
    const key = listing.mint;
    setBuyStatuses(prev => ({ ...prev, [key]: { kind: 'busy', step: 'preparing' } }));
    try {
      const url = `${API_BASE}/api/buy/me?mint=${encodeURIComponent(listing.mint)}&buyer=${encodeURIComponent(walletPubkey)}&price=${listing.priceSol}`;
      const res = await fetch(url);
      if (!res.ok) {
        const body = await res.json().catch(() => ({} as Record<string, unknown>));
        if (res.status === 409 && (body as { currentPriceSol?: number }).currentPriceSol != null) {
          throw new Error(`price changed to ${(body as { currentPriceSol: number }).currentPriceSol} SOL`);
        }
        throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
      }
      const { txBase64, listing: serverListing } = await res.json() as {
        txBase64: string;
        listing: { priceSol: number; seller: string; auctionHouse: string; tokenAta: string };
      };
      setBuyStatuses(prev => ({ ...prev, [key]: { kind: 'busy', step: 'signing' } }));
      const conn = new Connection(RPC_URL, 'confirmed');
      const { signature, txType } = await signSendAndConfirm(txBase64, conn);
      setBuyStatuses(prev => ({ ...prev, [key]: { kind: 'done', signature } }));
      // eslint-disable-next-line no-console
      console.log('[buy/me] confirmed', {
        mint: listing.mint, seller: serverListing.seller, auctionHouse: serverListing.auctionHouse,
        priceSol: serverListing.priceSol, tokenAta: serverListing.tokenAta,
        txType, signature, rpc: RPC_URL,
      });
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      setBuyStatuses(prev => ({ ...prev, [key]: { kind: 'error', message } }));
      // eslint-disable-next-line no-console
      console.warn('[buy/me] failed', message);
    }
  }, [walletPubkey]);

  // ── Chart points (backend-derived; decoupled from TRADES buffer) ───────
  // Fetched per (slug, span) from /api/collections/chart so chart fidelity
  // is no longer bounded by MAX_EVENTS. The `outliers` toggle stays in the
  // UI but was already a no-op in the in-memory version; backend ships all
  // points in-span (capped by MAX_POINTS server-side).
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/collections/chart?slug=${encodeURIComponent(slug)}&span=${span}`);
        if (!res.ok) return;
        const json = await res.json() as {
          points: { ts: number; price: number; side: 'buy' | 'sell' }[];
        };
        if (cancelled) return;
        setChartPoints(json.points.map(p => ({ ts: p.ts, price: p.price, type: p.side })));
      } catch { /* transient */ }
    };
    load();
    return () => { cancelled = true; };
  }, [slug, span]);
  void outliers;   // toggle retained in UI; server returns the full in-span set

  // ── Row-1/2 stat values (backend-derived; no in-memory reductions) ─────
  // `sales1dCount` label is the 24h window, matching the backend field.
  // `floor1h` falls back to the listed floor when no 1h sales exist, so an
  // otherwise-quiet collection still shows a non-zero figure.
  const sales1dCount  = statsData?.sales24h ?? 0;
  const sales1hCount  = statsData?.sales1h  ?? 0;
  const sales10mCount = statsData?.sales10m ?? 0;
  const floor1hSol    = statsData?.floor1h ?? floorSol ?? 0;
  const vol7dSol      = statsData?.vol7d  ?? null;
  const vol24hSol     = statsData?.vol24h ?? null;
  void tick;  // retained for TradeRowItem timeAgo refresh

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100%' }}>
      <TopNav active="collection" />

      {/* Collection header (verbatim layout from collection.html) */}
      <div style={{
        display:'flex', alignItems:'center', justifyContent:'space-between',
        padding:'10px 14px', margin:'10px 4px 0',
        background:'linear-gradient(180deg, #1a1530 0%, #15102a 100%)',
        border:'1px solid rgba(148,124,226,0.18)',
        borderRadius:12,
        boxShadow:'inset 0 1px 0 rgba(255,255,255,0.05), 0 8px 24px rgba(0,0,0,0.4)',
        flexShrink:0,
      }}>
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          <CollectionIcon imageUrl={headerIconUrl} color={headerColor} abbr={headerAbbr} size={44} />
          <div>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <span style={{ fontSize:14, fontWeight:600, letterSpacing:'-0.1px', color: resolvedName ? '#f0eef8' : '#aaaabf' }}>
                {displayName}
              </span>
              <span style={{ color:'#2c2c44', cursor:'pointer', fontSize:14 }}>☆</span>
              {marketSignal && (() => {
                const cfg = marketSignal === 'sell'
                  ? { label: 'SELL PRESSURE',   border: '1px solid #bf5f5f80', background: '#bf5f5f22', color: '#e58585' }
                  : marketSignal === 'buy'
                  ? { label: 'BUY OPPORTUNITY', border: '1px solid #36b86880', background: '#36b86822', color: '#4fd190' }
                  : { label: 'MIXED',           border: '1px solid #8068d880', background: '#8068d822', color: '#b8a8f0' };
                return (
                  <span
                    title="combined: BID DUMP + UNDERCUT/NEAR FLOOR"
                    style={{
                      display:'inline-flex', alignItems:'center',
                      fontSize:9.5, fontWeight:700, letterSpacing:'0.4px',
                      padding:'1px 6px', borderRadius:3, lineHeight:'14px',
                      border: cfg.border, background: cfg.background, color: cfg.color,
                    }}
                  >MARKET SIGNAL: {cfg.label}</span>
                );
              })()}
              <button
                onClick={toggleSound}
                title={soundOn ? 'Sound alerts on — click to mute' : 'Sound alerts off — click to enable'}
                style={{
                  display:'inline-flex', alignItems:'center',
                  fontSize:9.5, fontWeight:700, letterSpacing:'0.4px',
                  padding:'1px 6px', borderRadius:3, lineHeight:'14px',
                  border: soundOn ? '1px solid rgba(168,144,232,0.5)' : '1px solid rgba(255,255,255,0.08)',
                  background: soundOn ? 'rgba(168,144,232,0.18)' : 'rgba(255,255,255,0.03)',
                  color: soundOn ? '#c4b3f0' : '#8f8fa8',
                  cursor:'pointer',
                }}
              >SOUND: {soundOn ? 'ON' : 'OFF'}</button>
            </div>
            <div style={{ display:'flex', gap:6, marginTop:4 }}>
              {/* Marketplace + social chips — rounded squares to match the
                  brand aesthetic. Brand chips (ME pink, Tensor black) are
                  always rendered since their URLs derive from the slug.
                  Twitter / Discord / website come from ME metadata via the
                  backend-cached catalog and render only when present. */}
              <SocialIconLink href={`https://magiceden.io/marketplace/${slug}`} label="Magic Eden" style={BRAND_ME}>
                <MagicEdenGlyph />
              </SocialIconLink>
              <SocialIconLink href={`https://www.tensor.trade/trade/${slug}`} label="Tensor" style={BRAND_TENSOR}>
                <TensorGlyph />
              </SocialIconLink>
              {socials.twitter && (
                <SocialIconLink href={socials.twitter} label="Twitter / X" style={SOCIAL_CHIP}>
                  <TwitterGlyph />
                </SocialIconLink>
              )}
              {socials.discord && (
                <SocialIconLink href={socials.discord} label="Discord" style={DISCORD_CHIP}>
                  <DiscordGlyph />
                </SocialIconLink>
              )}
              {socials.website && (
                <SocialIconLink href={socials.website} label="Website" style={SOCIAL_CHIP}>
                  <GlobeGlyph />
                </SocialIconLink>
              )}
            </div>
          </div>
        </div>
        <div style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:6 }}>
          <div style={{ display:'flex', alignItems:'center', gap:8, fontSize:10, color:'#3a3a52' }}>
            <span>Metadata fetched</span>
            <div style={{ width:60, height:3, borderRadius:2, background:'#ffffff08', overflow:'hidden' }}>
              <div style={{ width: events.length > 0 ? '100%' : '0%', height:'100%', background:'#36b868', transition:'width 0.4s' }} />
            </div>
            <span style={{ color:'#36b868' }}>{events.length > 0 ? '100%' : '—'}</span>
            <span>Ranks variety</span>
            <div style={{ width:60, height:3, borderRadius:2, background:'#ffffff08', overflow:'hidden' }}>
              <div style={{ width: listings.length > 0 ? '99%' : '0%', height:'100%', background:'#c9a820', transition:'width 0.4s' }} />
            </div>
            <span style={{ color:'#c9a820' }}>{listings.length > 0 ? '99%' : '—'}</span>
          </div>
          <div style={{ display:'flex', gap:6, alignItems:'center' }}>
            {walletPubkey ? (
              <button onClick={onDisconnectWallet} style={{
                padding:'4px 10px', fontSize:11, borderRadius:4,
                border:'1px solid #36b86855', background:'#36b86818', color:'#4fd190', cursor:'pointer',
              }} title={walletPubkey}>{shortWallet(walletPubkey)} · disconnect</button>
            ) : (
              <button onClick={onConnectWallet} style={{
                padding:'4px 10px', fontSize:11, borderRadius:4,
                border:'1px solid #8068d855', background:'#8068d818', color:'#8068d8', cursor:'pointer',
              }}>Connect Phantom</button>
            )}
            <button style={{ padding:'4px 10px', fontSize:11, borderRadius:4, border:'1px solid #ffffff0d', background:'#ffffff07', color:'#56566e', cursor:'pointer' }}>id, name or address</button>
            <button style={{ padding:'4px 10px', fontSize:11, borderRadius:4, border:'1px solid #8068d855', background:'#8068d818', color:'#8068d8', cursor:'pointer' }}>Quick lookup</button>
          </div>
          {walletErr && (
            <span style={{ fontSize:9, color:'#9a7a7a', maxWidth:280, textAlign:'right' }}>{walletErr}</span>
          )}
        </div>
      </div>

      {/* LIVE VIEW / SUMMARY tabs (verbatim) */}
      <div style={{ display:'flex', justifyContent:'center', flexShrink:0, padding:'4px 0 0' }}>
        {(['live','summary'] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding:'4px 32px', fontSize:10, fontWeight:600, letterSpacing:'0.6px',
            textTransform:'uppercase', background:'transparent', border:'none', cursor:'pointer',
            color: tab === t ? '#8068d8' : '#3a3a52',
            borderBottom: tab === t ? '2px solid #8068d8' : '2px solid transparent',
            marginBottom:'-1px',
          }}>
            {t === 'live' ? <><LiveDot /> &nbsp;Live View</> : 'Summary'}
          </button>
        ))}
      </div>

      {/* Main 3-column grid (verbatim ratios + gap + radius) */}
      <div style={{ flex:1, display:'grid', gridTemplateColumns:'1.35fr 1.35fr 2fr', gap:10, padding:'10px 4px', minHeight:0, overflow:'hidden' }}>

        {/* LEFT: Listings */}
        <div style={{
          display:'flex', flexDirection:'column', overflow:'hidden',
          background:'linear-gradient(180deg, #201a3a 0%, #1a1530 100%)',
          border:'1px solid rgba(168,144,232,0.28)',
          borderRadius:12,
          boxShadow:'inset 0 1px 0 rgba(255,255,255,0.07), 0 16px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4), 0 0 24px rgba(128,104,216,0.08)',
          position:'relative',
        }}>
          <div style={{ padding:'5px 8px', borderBottom:'1px solid rgba(168,144,232,0.12)', flexShrink:0, display:'flex', alignItems:'center', justifyContent:'space-between', background:'rgba(168,144,232,0.04)' }}>
            <div style={{ display:'flex', alignItems:'center', gap:6 }}>
              <span style={{ fontSize:11, fontWeight:700, color:'#d4d4e8', letterSpacing:'0.5px' }}>
                LISTINGS <span
                  title="displayed (ME+MMM+Tensor snapshot) / market total (ME stats)"
                  style={{ color:'#8068d8', fontWeight:600 }}
                >({listings.length.toLocaleString()} / {listedCount != null ? listedCount.toLocaleString() : '—'})</span>
              </span>
              <LiveDot />
              {/* NEAR FLOOR / UNDERCUT live indicator temporarily removed —
               *  will return in a cleaner form. Header keeps LISTINGS count
               *  + LiveDot + filters + sort only. */}
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:6 }}>
              <button onClick={() => setFiltersOpen(o => !o)} title="Filters" style={{
                display:'flex', alignItems:'center', gap:4,
                padding:'2px 7px', fontSize:10, fontWeight:600,
                borderRadius:4,
                border: filtersOpen ? '1px solid rgba(168,144,232,0.5)' : '1px solid rgba(255,255,255,0.08)',
                background: filtersOpen ? 'rgba(168,144,232,0.18)' : 'rgba(255,255,255,0.03)',
                color: filtersOpen ? '#c4b3f0' : '#8f8fa8',
                cursor:'pointer',
              }}>
                <span style={{ fontSize:11, lineHeight:1 }}>⚙</span> Filters
              </button>
              <span style={{ fontSize:10, color:'#3a3a52' }}>Sort:</span>
              <DropBtn label="listing date" />
            </div>
          </div>

          {filtersOpen && (
            <div style={{ padding:'6px 8px', borderBottom:'1px solid rgba(255,255,255,0.05)', flexShrink:0, background:'rgba(255,255,255,0.015)' }}>
              <div style={{ display:'flex', gap:3, flexWrap:'wrap', marginBottom:4 }}>
                <span style={{ display:'flex', alignItems:'center', justifyContent:'center', width:20, height:20, borderRadius:3, border:'1px solid #d63d7c48', background:'#d63d7c20', fontSize:9, fontWeight:700, color:'#e87ab0', cursor:'pointer' }}>ME</span>
                <span style={{ display:'flex', alignItems:'center', justifyContent:'center', width:20, height:20, borderRadius:3, border:'1px solid #8068d848', background:'#8068d820', fontSize:9, fontWeight:700, color:'#a890e8', cursor:'pointer' }}>T</span>
                <FilterBtn label="Min price" />
                <FilterBtn label="Max price" />
                <FilterBtn label="Max rank" />
              </div>
              <div style={{ display:'flex', gap:3, alignItems:'center' }}>
                <span style={{ display:'flex', alignItems:'center', justifyContent:'center', width:20, height:20, borderRadius:3, border:'1px solid #36b86848', background:'#36b86820', fontSize:9, fontWeight:700, color:'#4fd190', cursor:'pointer' }}>◎</span>
                <span style={{ display:'flex', alignItems:'center', justifyContent:'center', width:20, height:20, borderRadius:3, border:'1px solid #ffffff0d', background:'#ffffff07', fontSize:9, color:'#56566e', cursor:'pointer' }}>↓</span>
                <button style={{ padding:'3px 10px', fontSize:11, borderRadius:4, border:'1px solid #ffffff0d', background:'#ffffff07', color:'#8f8fa8', cursor:'pointer', display:'flex', alignItems:'center', gap:4 }}>
                  <span style={{ color:'#4fd190' }}>+</span> Trait filter
                </button>
                <div style={{ flex:1 }} />
                <span style={{ fontSize:10, color:'#56566e', marginRight:6 }}>0/0 ACTIVE</span>
                <button style={{ padding:'2px 8px', fontSize:10, borderRadius:3, border:'1px solid #36b86830', background:'transparent', color:'#4fd190', cursor:'pointer' }}>+ Rule</button>
              </div>
            </div>
          )}

          <div
            style={{ flex:1, overflowY:'auto' }}
            className="scroll-area"
            onScroll={(e) => {
              if (listingsShow >= listings.length) return;
              const el = e.currentTarget;
              if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
                setListingsShow(s => Math.min(s + GROW_STEP, listings.length));
              }
            }}
          >
            {listings.length === 0 && (
              <div style={{ textAlign:'center', color:'#56566e', fontSize:10.5, padding:'24px 0' }}>
                {buyEnabled === false ? 'No active ME listings.' : 'Loading listings…'}
              </div>
            )}
            {listings.slice(0, listingsShow).map(l => (
              <ListingRowItem
                key={l.id}
                listing={l}
                nameStem={nameStem ?? (resolvedName ?? slug)}
                imageByMint={imageByMint}
                floor={listingsFloor}
                abbr={headerAbbr}
                color={headerColor}
                status={buyStatuses[l.mint] ?? { kind: 'idle' }}
                walletConnected={!!walletPubkey}
                buyEnabled={buyEnabled}
                onBuy={onBuyListing}
              />
            ))}
          </div>
        </div>

        {/* MIDDLE: Trades */}
        <div style={{
          display:'flex', flexDirection:'column', overflow:'hidden',
          background:'linear-gradient(180deg, #201a3a 0%, #1a1530 100%)',
          border:'1px solid rgba(168,144,232,0.28)',
          borderRadius:12,
          boxShadow:'inset 0 1px 0 rgba(255,255,255,0.07), 0 16px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4), 0 0 24px rgba(128,104,216,0.08)',
          position:'relative',
        }}>
          <div style={{ padding:'5px 8px', borderBottom:'1px solid rgba(168,144,232,0.12)', flexShrink:0, display:'flex', alignItems:'center', justifyContent:'space-between', background:'rgba(168,144,232,0.04)' }}>
            <div style={{ display:'flex', alignItems:'center', gap:6 }}>
              <span style={{ fontSize:11, fontWeight:700, color:'#d4d4e8', letterSpacing:'0.5px' }}>
                TRADES <span
                  title="displayed / buffered (last 7 days)"
                  style={{ color:'#8068d8', fontWeight:600 }}
                >({visibleEvents.length.toLocaleString()}{events.length > visibleEvents.length ? ` / ${events.length.toLocaleString()}` : ''})</span>
              </span>
              <LiveDot />
              {bidDumpSeverity && (() => {
                // Mild/strong/extreme share the red palette; brightness and
                // border weight escalate with severity. No layout change —
                // only border / background / color tokens differ.
                const palette = bidDumpSeverity === 'extreme'
                  ? { border: '1px solid #e05858a8', background: '#e0585830', color: '#ff9b9b' }
                  : bidDumpSeverity === 'strong'
                  ? { border: '1px solid #d06a6a90', background: '#d06a6a28', color: '#f08080' }
                  : { border: '1px solid #bf5f5f60', background: '#bf5f5f22', color: '#e58585' };
                const tooltip =
                  `${bidDumpStats.count} bid-sells in 60s`
                  + ` · ${formatSol(bidDumpStats.volume)} total`
                  + ` · largest ${formatSol(bidDumpStats.largest)}`;
                return (
                  <span
                    title={tooltip}
                    style={{
                      display:'inline-flex', alignItems:'center',
                      fontSize:9.5, fontWeight:700, letterSpacing:'0.4px',
                      padding:'1px 6px', borderRadius:3, lineHeight:'14px',
                      ...palette,
                    }}
                  >
                    BID DUMP ({bidDumpStats.count} / {formatSol(bidDumpStats.volume)}◎)
                  </span>
                );
              })()}
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:6 }}>
              <button onClick={() => setTradeFiltersOpen(o => !o)} title="Filters" style={{
                display:'flex', alignItems:'center', gap:4,
                padding:'2px 7px', fontSize:10, fontWeight:600,
                borderRadius:4,
                border: tradeFiltersOpen ? '1px solid rgba(168,144,232,0.5)' : '1px solid rgba(255,255,255,0.08)',
                background: tradeFiltersOpen ? 'rgba(168,144,232,0.18)' : 'rgba(255,255,255,0.03)',
                color: tradeFiltersOpen ? '#c4b3f0' : '#8f8fa8',
                cursor:'pointer',
              }}>
                <span style={{ fontSize:11, lineHeight:1 }}>⚙</span> Filters
              </button>
              <span style={{ fontSize:10, color:'#3a3a52' }}>Sort:</span>
              <DropBtn label="trade date" />
            </div>
          </div>

          {tradeFiltersOpen && (
            <div style={{ padding:'6px 8px', borderBottom:'1px solid rgba(255,255,255,0.05)', flexShrink:0, background:'rgba(255,255,255,0.015)' }}>
              <div style={{ display:'flex', gap:3, flexWrap:'wrap', marginBottom:4 }}>
                <span style={{ display:'flex', alignItems:'center', justifyContent:'center', width:20, height:20, borderRadius:3, border:'1px solid #d63d7c48', background:'#d63d7c20', fontSize:9, fontWeight:700, color:'#e87ab0', cursor:'pointer' }}>ME</span>
                <span style={{ display:'flex', alignItems:'center', justifyContent:'center', width:20, height:20, borderRadius:3, border:'1px solid #8068d848', background:'#8068d820', fontSize:9, fontWeight:700, color:'#a890e8', cursor:'pointer' }}>T</span>
                <FilterBtn label="Min price" />
                <FilterBtn label="Max price" />
                <FilterBtn label="Max rank" />
              </div>
              <div style={{ display:'flex', gap:3, alignItems:'center' }}>
                <span style={{ display:'flex', alignItems:'center', justifyContent:'center', width:20, height:20, borderRadius:3, border:'1px solid #36b86848', background:'#36b86820', fontSize:9, fontWeight:700, color:'#4fd190', cursor:'pointer' }}>◎</span>
                <span style={{ display:'flex', alignItems:'center', justifyContent:'center', width:20, height:20, borderRadius:3, border:'1px solid #ffffff0d', background:'#ffffff07', fontSize:9, color:'#56566e', cursor:'pointer' }}>↓</span>
                <button style={{ padding:'3px 10px', fontSize:11, borderRadius:4, border:'1px solid #ffffff0d', background:'#ffffff07', color:'#8f8fa8', cursor:'pointer', display:'flex', alignItems:'center', gap:4 }}>
                  <span style={{ color:'#4fd190' }}>+</span> Trait filter
                </button>
                <div style={{ flex:1 }} />
                <span style={{ fontSize:10, color:'#56566e', marginRight:6 }}>0/0 ACTIVE</span>
                <button style={{ padding:'2px 8px', fontSize:10, borderRadius:3, border:'1px solid #36b86830', background:'transparent', color:'#4fd190', cursor:'pointer' }}>+ Rule</button>
              </div>
            </div>
          )}

          <div
            style={{ flex:1, overflowY:'auto' }}
            className="scroll-area"
            onScroll={(e) => {
              if (tradesShow >= visibleEvents.length) return;
              const el = e.currentTarget;
              if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
                setTradesShow(s => Math.min(s + GROW_STEP, visibleEvents.length));
              }
            }}
          >
            {loaded && events.length === 0 && (
              <div style={{ textAlign:'center', color:'#56566e', fontSize:10.5, padding:'24px 0' }}>
                No trades yet for <code>{slug}</code>
              </div>
            )}
            {visibleEvents.slice(0, tradesShow).map(ev => <TradeRowItem key={ev.id} event={ev} tick={tick} nameStem={nameStem} imageByMint={imageByMint} />)}
          </div>
        </div>

        {/* RIGHT: Stats + Chart (verbatim layout) */}
        <div style={{
          display:'flex', flexDirection:'column', overflow:'hidden',
          background:'linear-gradient(180deg, #13102a 0%, #0f0c22 100%)',
          border:'1px solid rgba(255,255,255,0.05)',
          borderRadius:12,
          boxShadow:'inset 0 1px 0 rgba(255,255,255,0.02), 0 6px 20px rgba(0,0,0,0.4)',
          opacity:0.92,
        }}>
          {/* Stats row 1 */}
          <div style={{ display:'flex', borderBottom:'1px solid rgba(255,255,255,0.05)', flexShrink:0, background:'rgba(255,255,255,0.02)' }}>
            <StatItem value={sales1dCount.toLocaleString()}                       label="1D Sales" />
            <StatItem value={sales1hCount.toLocaleString()}                       label="1H Sales" />
            <StatItem value={sales10mCount.toLocaleString()}                      label="10M Sales" />
            <StatItem value={floor1hSol > 0 ? floor1hSol.toFixed(floor1hSol < 1 ? 3 : 2) : '—'} label="1H Floor" highlight="#aaaabf" />
            <StatItem
              value={`${listings.length.toLocaleString()} / ${listedCount != null ? listedCount.toLocaleString() : '—'}`}
              label="Listings"
              title="displayed (ME+MMM+Tensor snapshot) / market total (ME stats)"
            />
            <StatItem value={floorSol != null ? floorSol.toFixed(floorSol < 1 ? 3 : 2) : '—'} label="Floor" highlight="#36b868" />
          </div>
          {/* Stats row 2 */}
          <div style={{ display:'flex', borderBottom:'1px solid rgba(255,255,255,0.05)', flexShrink:0, background:'transparent' }}>
            <StatItem value={vol7dSol  != null ? `${vol7dSol.toFixed(1)}`  : '—'} label="7D Vol" />
            <StatItem value={vol24hSol != null ? `${vol24hSol.toFixed(2)}` : '—'} label="24H Vol" />
            <StatItem value={volumeAllSol != null ? `${(volumeAllSol/1000).toFixed(1)}K` : '—'} label="Total Volume" />
            <StatItem value={events.length.toLocaleString()} label="Buffer" />
          </div>
          {/* Info notice (verbatim) */}
          <div style={{
            padding:'3px 8px', borderBottom:'1px solid rgba(255,255,255,0.05)', flexShrink:0,
            fontSize:10, color:'#3a3a52', background:'rgba(255,255,255,0.02)',
            display:'flex', alignItems:'center', gap:6,
          }}>
            <span style={{ color:'#8068d8' }}>ⓘ</span>
            Live + historical trades. Buffer: {events.length}.
          </div>

          {/* Chart header (verbatim) */}
          <div style={{
            display:'flex', alignItems:'center', justifyContent:'space-between',
            padding:'3px 8px', flexShrink:0,
          }}>
            <span style={{ fontSize:11, fontWeight:700, color:'#aaaabf', letterSpacing:'0.5px' }}>TRADES</span>
            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
              {/* Interval: dead control — bucketing / OHLC not implemented.
                  Rendered as visually inactive so users don't mistake it for a
                  working toggle. State hook kept in place as a no-op to keep
                  the diff minimal. */}
              <span title="Not implemented yet" style={{ fontSize:11, color:'#2c2c44' }}>Interval</span>
              <div title="Not implemented yet" style={{ display:'flex', background:'rgba(255,255,255,0.02)', border:'1px solid #ffffff08', borderRadius:4, overflow:'hidden', opacity:0.5 }}>
                {INTERVALS.map(v => (
                  <button key={v} disabled style={{
                    padding:'1px 5px', fontSize:9, fontWeight:600, border:'none',
                    background:'transparent',
                    color:'#2c2c44',
                    cursor:'default', borderRight:'1px solid #ffffff08',
                  }}>{v}</button>
                ))}
              </div>
              <span style={{ fontSize:11, color:'#3a3a52' }}>Span</span>
              <div style={{ display:'flex', background:'rgba(255,255,255,0.02)', border:'1px solid #ffffff08', borderRadius:4, overflow:'hidden' }}>
                {SPANS.map(v => (
                  <button key={v} onClick={() => setSpan(v)} style={{
                    padding:'1px 5px', fontSize:9, fontWeight:600, border:'none',
                    background: span === v ? '#36b86822' : 'transparent',
                    borderRight: span === v ? '1px solid #36b86866' : '1px solid #ffffff08',
                    color: span === v ? '#36b868' : '#3a3a52',
                    cursor:'pointer',
                  }}>{v}</button>
                ))}
              </div>
              {/* Outliers: dead control — IQR / z-score filtering not
                  implemented. Rendered forced-off and non-interactive. */}
              <span title="Not implemented yet" style={{ fontSize:11, color:'#2c2c44' }}>Outliers</span>
              <div title="Not implemented yet" style={{
                width:32, height:16, borderRadius:8, cursor:'default',
                background:'#ffffff0d', position:'relative', opacity:0.5,
              }}>
                <div style={{
                  position:'absolute', top:2, left:2,
                  width:12, height:12, borderRadius:'50%', background:'#fff',
                }} />
              </div>
            </div>
          </div>

          {/* Scatter chart (verbatim wrapper) */}
          <div style={{
            flex:1, display:'flex', minHeight:0,
            margin:'4px 10px 10px',
            background:'#0a0714',
            border:'1px solid rgba(255,255,255,0.04)',
            borderRadius:8,
            overflow:'hidden',
          }}>
            {chartPoints.length >= 2
              ? <ScatterChart trades={chartPoints} span={span} interval={interval_} />
              : <div style={{ flex:1, display:'flex', alignItems:'center', justifyContent:'center', color:'#56566e', fontSize:11 }}>
                  Need at least 2 sales in this span to plot.
                </div>}
          </div>
        </div>
      </div>
    </div>
  );
}
