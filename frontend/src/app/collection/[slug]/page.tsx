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

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { authHeaders } from '@/runtime/auth';
import { CATEGORY_LAYER, FeedEvent, formatSol, shortWallet } from '@/soloist/mock-data';
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
  CollectionIcon, ItemThumb, LiveDot, Pill,
  compressImage, BarIconButton, ImagePreviewOverlay,
} from '@/soloist/shared';
import { useCollectionIcons } from '@/soloist/collection-icons';
import { useUiSoundEnabled, setUiSoundEnabled } from '@/soloist/use-ui-sound';
import { SalesChart, type SalePoint } from '@/soloist/sales-chart';
import { FeedCard, ListingCard, PoolGroupCard, type ListingCardBuy } from '@/app/feed/lib/feed-card';
import { useInclusiveFees } from '@/soloist/price-mode';
import {
  connectPhantom,
  eagerConnectPhantom,
  getPhantom,
  signAllMixedAndSend,
  signSendAndConfirm,
} from '@/wallet/phantom';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

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
/** Floor-sweep slider: 2 NFTs per tick, up to 20; starts at 2. */
const SWEEP_STEP = 2;
const SWEEP_MAX = 20;
const SWEEP_TICKS = Array.from({ length: SWEEP_MAX / SWEEP_STEP }, (_, i) => (i + 1) * SWEEP_STEP);
const SWEEP_BUILD_CONCURRENCY = 4;

const SPANS     = ['1H','4H','1D','7D','30D'] as const;
type Span     = typeof SPANS[number];
const SPAN_MS: Record<Span, number> = {
  '1H': 3_600_000, '4H': 14_400_000, '1D': 86_400_000,
  '7D': 604_800_000, '30D': 2_592_000_000,
};

/** Row shape of GET /api/collections/chart. */
interface ChartApiPoint {
  ts: number; price: number; side: 'buy' | 'sell';
  sig: string; mint: string; name: string | null; image: string | null;
  mp: string; buyer: string; seller: string;
  rank: number | null; supply: number | null;
}
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
  /** MMM pool address for pool-hosted NFTs (grouped into one collapsed
   *  row per pool), null for ordinary listings. */
  poolKey?:     string | null;
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
  | { kind: 'busy';    step: 'preparing' | 'signing' | 'confirming' }
  | { kind: 'pending'; signature: string } // submitted, landing not yet confirmed
  | { kind: 'done';    signature: string }
  | { kind: 'error';   message: string };

// ── name → abbr/color (slug fallback when COLLECTIONS_DB has no entry) ──────
function abbrOf(name: string): string {
  const w = name.split(/\s+/).filter(Boolean);
  return ((w.length >= 2 ? (w[0][0] ?? '') + (w[1][0] ?? '') : name.slice(0, 2)) || '??').toUpperCase();
}
function colorOf(name: string): string {
  let h = 0; for (let i = 0; i < name.length; i++) h = (h + name.charCodeAt(i)) | 0;
  // Generated collection identity (header/avatar chips) → approved CATEGORY_LAYER.
  return CATEGORY_LAYER[Math.abs(h) % CATEGORY_LAYER.length];
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

/** BUY capsule state for a listing (shared by ListingCard). */
function listingBuyProps(
  listing: ListingRow, status: BuyStatus, walletConnected: boolean,
  buyEnabled: boolean | null, onBuy: (l: ListingRow) => void,
): ListingCardBuy {
  const isMe = listing.marketplace === 'me';
  const isTensor = listing.marketplace === 'tensor';
  const isPool = !!listing.poolKey;
  const busy = status.kind === 'busy', pending = status.kind === 'pending';
  const done = status.kind === 'done', errored = status.kind === 'error';
  // Buy execution is wired for ME only; Tensor rows keep a disabled BUY.
  // buyEnabled = ME API key present; the Tensor path doesn't need it.
  const disabled = !(isMe || isTensor) || isPool || busy || pending || (isMe && buyEnabled !== true) || !walletConnected;
  const label =
    done    ? '✓'     :
    pending ? 'sent'  :
    errored ? 'retry' :
    busy    ? (status.step === 'signing' ? 'sign' : '…') : 'BUY';
  const title = errored ? `error: ${status.message}`
    : pending            ? `Submitted, confirmation pending — https://solscan.io/tx/${status.signature}`
    : isPool             ? 'Buying from AMM pools is not implemented yet'
    : isMe && buyEnabled === false ? 'Buy unavailable: ME_API_KEY not set on server'
    : !walletConnected   ? 'Connect Phantom to buy'
    :                      `Buy ${formatSol(listing.priceSol)} SOL`;
  return { label, title, disabled, busy, errored, onClick: () => onBuy(listing) };
}

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
    <div  style={{ display:'flex', flexDirection:'column', alignItems:'flex-start', gap:1, padding:'5px 10px' }}>
      <span className={flick ? 'stat-flicker' : ''} style={{ fontSize:13, fontWeight:700, color: highlight || 'var(--vl-text-muted)', letterSpacing:'-0.3px' }}>{value}</span>
      <span style={{ fontSize:8, fontWeight:600, color:'var(--stat-label-color, var(--vl-border-subtle))', letterSpacing:'0.5px', textTransform:'uppercase' }}>{label}</span>
    </div>
  );
}

// ── FilterBtn / DropBtn (verbatim ports; non-functional placeholders) ──────
function FilterBtn({ label }: { label: string }) {
  const [active, setActive] = useState(false);
  return <Pill active={active} onClick={() => setActive(a => !a)} label={label} size="sm" />;
}
function DropBtn({ label }: { label: string }) {
  return (
    <Pill
      label={<>{label} <span style={{ color: 'var(--vl-border-subtle)' }}>▼</span></>}
      size="sm"
    />
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
/** Defence-in-depth href validator. Server already drops non-https/
 *  malformed/control-char URLs before they reach this prop (see
 *  `coerceUrl` in src/server/collection-meta.ts), but a stale catalog
 *  entry, a future ingestion path, or a localStorage-cached payload
 *  could still hand us a raw string. This second gate guarantees the
 *  href we put in the DOM is an https URL that parses cleanly. */
function isSafeSocialHref(href: string): boolean {
  if (typeof href !== 'string' || !href) return false;
  if (href.length > 2048) return false;
  if (!/^https:\/\//i.test(href)) return false;
  if (/[\u0000-\u001f\u007f]/.test(href)) return false;
  try {
    const u = new URL(href);
    if (u.protocol !== 'https:') return false;
    if (u.username || u.password) return false;
  } catch {
    return false;
  }
  return true;
}

function SocialIconLink({
  href, label, children, style,
}: {
  href: string;
  label: string;
  children: React.ReactNode;
  style: ChipStyle;
}) {
  const [hover, setHover] = useState(false);
  // Render nothing if the href fails validation. This is intentional:
  // a missing chip is strictly better than rendering an unsafe link.
  if (!isSafeSocialHref(href)) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      
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
const BRAND_ME:      ChipStyle = { bg: '#E42575', glyph: 'var(--vl-white)', border: '#E4257544' };
const BRAND_TENSOR:  ChipStyle = { bg: '#0f0d18', glyph: 'var(--vl-white)', border: '#ffffff1a' };
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

  useEffect(() => {
    document.title = slug ? `${slug} | VictoryLabs` : 'Collection | VictoryLabs';
  }, [slug]);

  // Tab + chart selectors (verbatim from original)
  const [tab, setTab] = useState<'live' | 'summary'>('live');
  const [preview, setPreview] = useState<string | null>(null);
  const [inclusiveFees] = useInclusiveFees();
  const [span, setSpan] = useState<Span>('7D');
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
  // Gated by the global site sound switch (bottom bar): with site sound
  // off, these alerts stay silent regardless of the page-level toggle.
  const [soundOnLocal, setSoundOn] = useState(true);
  const siteSoundOn = useUiSoundEnabled();
  const soundOn = siteSoundOn && soundOnLocal;
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
    // Turning alerts on while site sound is muted unmutes the site too —
    // otherwise the click would appear to do nothing.
    if (next && !siteSoundOn) setUiSoundEnabled(true);
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

  // Rows listed / repriced after this slug's page opened are live arrivals
  // → ListingCard purple flash. Card key includes the price so a reprice
  // remounts (and flashes) instead of silently changing a number.
  const pageOpenedAtRef = useRef(Date.now());
  useEffect(() => { pageOpenedAtRef.current = Date.now(); }, [slug]);

  // Collection supply for rarity tiers (any trade that carried it).
  const collectionSupply = useMemo<number | null>(() => {
    for (const e of events) if (e.totalSupply) return e.totalSupply;
    return null;
  }, [events]);

  // Trades rendered with the /feed FeedCard. Thumbnails fall back to the
  // listings snapshot image when the trade row has none.
  const tradeCards = useMemo(() => visibleEvents.map(e => {
    const img = !e.imageUrl && e.mintAddress ? imageByMint.get(e.mintAddress) : undefined;
    return img ? { ...e, imageUrl: img } : e;
  }), [visibleEvents, imageByMint]);

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
  const [chartPoints,   setChartPoints]   = useState<ChartApiPoint[]>([]);
  // ── Progressive-reveal render caps ──────────────────────────────────────
  // The listings / trades state buffers are populated as before; the page
  // only paints this many rows per panel on first render, then grows in
  // GROW_STEP increments as the user scrolls near the bottom. Purely a
  // render optimization — no extra network requests, no data loss.
  const INITIAL_REVEAL = 20;
  const GROW_STEP = 20;
  const [listingsShow, setListingsShow] = useState(INITIAL_REVEAL);
  const [openPools, setOpenPools] = useState<Set<string>>(() => new Set());
  // Pool-hosted NFTs collapse into one row per pool, placed where the pool's
  // (shared) price sorts; expanding shows its NFTs right under it.
  const listingItems = useMemo(() => {
    // SSE snapshots arrive raw (unsorted, one row per source) — apply the
    // same per-mint dedupe (ME > pool > Tensor) + price sort as the REST API.
    const rank = (l: ListingRow) => l.marketplace === 'tensor' ? 2 : l.poolKey ? 1 : 0;
    const byMint = new Map<string, ListingRow>();
    for (const l of listings) {
      const cur = byMint.get(l.mint);
      if (!cur || rank(l) < rank(cur)) byMint.set(l.mint, l);
    }
    const sorted = Array.from(byMint.values()).sort((a, b) => a.priceSol - b.priceSol);
    const byPool = new Map<string, ListingRow[]>();
    for (const l of sorted) if (l.poolKey) {
      const arr = byPool.get(l.poolKey);
      if (arr) arr.push(l); else byPool.set(l.poolKey, [l]);
    }
    const out: ({ kind: 'row'; l: ListingRow } | { kind: 'pool'; poolKey: string; rows: ListingRow[] })[] = [];
    const seen = new Set<string>();
    for (const l of sorted) {
      if (!l.poolKey) { out.push({ kind: 'row', l }); continue; }
      if (seen.has(l.poolKey)) continue;
      seen.add(l.poolKey);
      out.push({ kind: 'pool', poolKey: l.poolKey, rows: byPool.get(l.poolKey)! });
    }
    return out;
  }, [listings]);
  const [tradesShow,   setTradesShow]   = useState(INITIAL_REVEAL);
  useEffect(() => {
    dispatchFeed({ type: 'reset' });
    setLoaded(false); setResolvedName(null);
    setFloorSol(null); setStatsData(null);
    setListedCount(null); setVolumeAllSol(null);
    setListings([]); setBuyStatuses({}); setSweepSel(new Set()); setSweepN(SWEEP_STEP);
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
    // Exponential backoff with jitter on reconnect — caps the herd-thunder
    // pattern when the backend restarts (every connected tab would
    // otherwise hammer the just-rebooted backend on a 3 s grid).
    let attempt = 0;
    const scheduleReconnect = () => {
      if (cancelled || document.hidden) return;
      const base = Math.min(30_000, 1_000 * 2 ** attempt);
      const jitter = Math.random() * 1_000;
      reconnectTimer = setTimeout(connectSse, base + jitter);
      attempt++;
    };

    const connectSse = () => {
      if (cancelled) return;
      es?.close();
      es = new EventSource(`${API_BASE}/api/events/stream`);
      // Reset backoff once the connection lands so the next disconnect
      // starts from 1 s again instead of inheriting the prior cap.
      es.addEventListener('open', () => { attempt = 0; });
      es.addEventListener('sale', (e: MessageEvent) => {
        try {
          const b = JSON.parse(e.data) as BackendEvent;
          if (b.meCollectionSlug !== slug) return;
          // Wall-clock arrival gates the fresh-trade flash (`ts` is blockTime).
          dispatchFeed({ type: 'live', event: { ...fromBackend(b), clientArrivedAt: Date.now() } });
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
      // Late-resolved rarity (sync-miss → async DB resolve): sticky-merge by
      // mintAddress so this slug's trade rows light up the rarity badge
      // without a reload. Reducer ignores non-finite/non-positive payloads.
      es.addEventListener('rarity', (e: MessageEvent) => {
        try {
          const patch = JSON.parse(e.data) as { mintAddress: string; rarityRank: number;
            totalSupply: number; raritySource: string | null };
          if (patch.mintAddress && patch.rarityRank > 0 && patch.totalSupply > 0) {
            dispatchFeed({ type: 'rarity', patch });
          }
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
      // Live listing stream (Helius transactionSubscribe): a new listing or
      // reprice for this slug. Newest-first list → the row moves to the top.
      es.addEventListener('listing_upsert', (e: MessageEvent) => {
        try {
          const d = JSON.parse(e.data) as { slug: string; listing: ListingRow };
          if (d.slug !== slug || !d.listing?.id) return;
          setListings(prev => {
            const was = prev.find(l => l.id === d.listing.id);
            // Metadata-only patch (image / rank arrived): update in place.
            if (was && was.priceSol === d.listing.priceSol) {
              return prev.map(l => l.id === d.listing.id ? { ...l, ...d.listing, listedAt: was.listedAt } : l);
            }
            return [d.listing, ...prev.filter(l => l.id !== d.listing.id)];
          });
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
        scheduleReconnect();
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
  // Backend enforces marketplace allowlist, collection binding, live price +
  // slippage, and on-tx checks (mint, lamports bound, signer shape). Default
  // slippage 1% — users can only buy the price we just showed them; any
  // real-world move rejects here. Tensor: our own buy_core builder (no Tensor
  // API); ME: buy_now.
  const buildBuyTx = useCallback(async (listing: ListingRow, buyer: string): Promise<string> => {
    const isTensor = listing.marketplace === 'tensor';
    const params = new URLSearchParams({
      marketplace:      isTensor ? 'tensor' : 'magic_eden',
      mint:             listing.mint,
      buyer,
      collectionSlug:   slug,
      expectedPriceSol: String(listing.priceSol),
      maxSlippagePct:   '1',
    });
    const url = `${API_BASE}/api/buy/${isTensor ? 'tensor' : 'me'}?${params.toString()}`;
    const res = await fetch(url, { headers: { ...authHeaders() } });
    if (!res.ok) {
      const body = await res.json().catch(() => ({} as Record<string, unknown>));
      if (res.status === 409 && (body as { currentPriceSol?: number }).currentPriceSol != null) {
        throw new Error(`price changed to ${(body as { currentPriceSol: number }).currentPriceSol} SOL`);
      }
      const bd = body as { error?: string; message?: string };
      throw new Error(bd.message ?? bd.error ?? `HTTP ${res.status}`);
    }
    const { txBase64 } = await res.json() as { txBase64: string };
    return txBase64;
  }, [slug]);

  // A returned signature only means the RPC accepted it, not that it landed.
  // /confirm long-polls server-side (~400 ms cadence) and answers the moment
  // the tx is confirmed or failed; two rounds ≈ 50 s, past blockhash expiry.
  const confirmBuy = useCallback(async (key: string, signature: string) => {
    setBuyStatuses(prev => ({ ...prev, [key]: { kind: 'busy', step: 'confirming' } }));
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(
          `${API_BASE}/api/buy/me/confirm?sig=${encodeURIComponent(signature)}`,
          { headers: { ...authHeaders() } },
        );
        if (!r.ok) continue;
        const d = await r.json() as { ok: boolean; status: 'confirmed' | 'failed' | 'pending'; err?: unknown };
        if (d.status === 'failed') {
          setBuyStatuses(prev => ({ ...prev, [key]: { kind: 'error', message: 'Transaction failed on-chain: ' + JSON.stringify(d.err) } }));
          return;
        }
        if (d.status === 'confirmed') {
          setBuyStatuses(prev => ({ ...prev, [key]: { kind: 'done', signature } }));
          return;
        }
      } catch (_) { /* transient — retry */ }
    }
    setBuyStatuses(prev => ({ ...prev, [key]: { kind: 'pending', signature } }));
  }, []);

  const onBuyListing = useCallback(async (listing: ListingRow) => {
    if (!walletPubkey) return;
    const key = listing.mint;
    setBuyStatuses(prev => ({ ...prev, [key]: { kind: 'busy', step: 'preparing' } }));
    try {
      const txBase64 = await buildBuyTx(listing, walletPubkey);
      setBuyStatuses(prev => ({ ...prev, [key]: { kind: 'busy', step: 'signing' } }));
      const { signature, txType } = await signSendAndConfirm(txBase64, { sendPath: `${API_BASE}/api/buy/me/send` });
      // eslint-disable-next-line no-console
      console.log('[buy/me] sent', { mint: listing.mint, seller: listing.seller, priceSol: listing.priceSol, txType, signature });
      await confirmBuy(key, signature);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      setBuyStatuses(prev => ({ ...prev, [key]: { kind: 'error', message } }));
      // eslint-disable-next-line no-console
      console.warn('[buy/me] failed', message);
    }
  }, [walletPubkey, buildBuyTx, confirmBuy]);

  // ── Sweep: click-select listings / floor slider → BUY ALL ──────────────
  // Every selected listing gets its own tx (same backend checks as a single
  // buy); all are signed with ONE Phantom approval, then broadcast and
  // confirmed individually, so one stale listing never sinks the rest.
  const [sweepSel, setSweepSel] = useState<Set<string>>(() => new Set());
  const [sweepN,   setSweepN]   = useState(SWEEP_STEP);
  const [sweepStage, setSweepStage] = useState<'idle' | 'building' | 'signing' | 'sending'>('idle');
  const isSweepable = useCallback((l: ListingRow) => {
    if (l.poolKey || (l.marketplace !== 'me' && l.marketplace !== 'tensor')) return false;
    const k = (buyStatuses[l.mint] ?? { kind: 'idle' }).kind;
    return k === 'idle' || k === 'error';
  }, [buyStatuses]);
  // Cheapest first — what the floor slider takes from.
  const sweepFloorOrder = useMemo(
    () => listings.filter(isSweepable).sort((x, y) => x.priceSol - y.priceSol),
    [listings, isSweepable],
  );
  const sweepRows = useMemo(
    () => listings.filter(l => sweepSel.has(l.mint) && isSweepable(l)),
    [listings, sweepSel, isSweepable],
  );
  const sweepTotalSol = sweepRows.reduce((acc, l) => acc + l.priceSol, 0);
  const toggleSweep = useCallback((mint: string) => {
    setSweepSel(prev => {
      const next = new Set(prev);
      if (next.has(mint)) next.delete(mint); else next.add(mint);
      return next;
    });
  }, []);
  const applyFloorSweep = (n: number) => {
    setSweepN(n);
    setSweepSel(new Set(sweepFloorOrder.slice(0, n).map(l => l.mint)));
  };

  const onBuyAll = async () => {
    if (!walletPubkey || sweepStage !== 'idle' || sweepRows.length === 0) return;
    const buyer = walletPubkey;
    const rows = sweepRows;
    setSweepStage('building');
    setBuyStatuses(prev => {
      const next = { ...prev };
      for (const l of rows) next[l.mint] = { kind: 'busy', step: 'preparing' };
      return next;
    });
    // Build with a small concurrency cap — ME/Tensor upstreams rate-limit.
    const built: { l: ListingRow; tx: string }[] = [];
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(SWEEP_BUILD_CONCURRENCY, rows.length) }, async () => {
      while (cursor < rows.length) {
        const l = rows[cursor++];
        try {
          built.push({ l, tx: await buildBuyTx(l, buyer) });
        } catch (err) {
          const message = (err as Error).message ?? String(err);
          setBuyStatuses(prev => ({ ...prev, [l.mint]: { kind: 'error', message } }));
        }
      }
    }));
    if (built.length === 0) { setSweepStage('idle'); return; }

    setSweepStage('signing');
    setBuyStatuses(prev => {
      const next = { ...prev };
      for (const b of built) next[b.l.mint] = { kind: 'busy', step: 'signing' };
      return next;
    });
    const sent = new Set<string>();
    try {
      await signAllMixedAndSend(
        built.map(b => b.tx),
        (i, signature) => {
          if (i === 0) setSweepStage('sending');
          const key = built[i].l.mint;
          sent.add(key);
          // eslint-disable-next-line no-console
          console.log('[buy/sweep] sent', { mint: key, priceSol: built[i].l.priceSol, signature });
          void confirmBuy(key, signature);
        },
        { sendPath: `${API_BASE}/api/buy/me/send`, expectWallet: buyer },
      );
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      // eslint-disable-next-line no-console
      console.warn('[buy/sweep] failed', message);
      setBuyStatuses(prev => {
        const next = { ...prev };
        for (const b of built) if (!sent.has(b.l.mint)) next[b.l.mint] = { kind: 'error', message };
        return next;
      });
    }
    setSweepSel(new Set());
    setSweepStage('idle');
  };

  // ── Chart points (backend-derived; decoupled from TRADES buffer) ───────
  // Fetched per (slug, span) from /api/collections/chart so chart fidelity
  // is no longer bounded by MAX_EVENTS. Each point carries sale detail for
  // the chart tooltip. Live SSE trades newer than the snapshot are merged
  // in below so new sales land on the chart without a refetch.
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    const load = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/collections/chart?slug=${encodeURIComponent(slug)}&span=${span}`);
        if (!res.ok) return;
        const json = await res.json() as { points: ChartApiPoint[] };
        if (cancelled) return;
        setChartPoints(json.points);
      } catch { /* transient */ }
    };
    load();
    return () => { cancelled = true; };
  }, [slug, span]);

  const salePoints = useMemo<SalePoint[]>(() => {
    const stem = nameStem ?? resolvedName ?? slug;
    const seen = new Set<string>();
    const out: SalePoint[] = [];
    for (const p of chartPoints) {
      seen.add(p.sig);
      const d = resolveNftDisplay({ nftName: p.name, mint: p.mint, imageUrl: p.image, stem, imageByMint });
      out.push({
        ts: p.ts, price: p.price, side: p.side, sig: p.sig, mint: p.mint,
        name: d.name, image: d.image, mp: p.mp, buyer: p.buyer, seller: p.seller,
        rank: p.rank, supply: p.supply,
      });
    }
    const cutoff = Date.now() - SPAN_MS[span];
    for (const ev of events) {
      if (ev.ts < cutoff || seen.has(ev.signature) || !(ev.grossPrice > 0)) continue;
      if ((ev.currency ?? 'SOL') !== 'SOL') continue;
      seen.add(ev.signature);
      const d = resolveNftDisplay({ nftName: ev.nftName, mint: ev.mintAddress, imageUrl: ev.imageUrl, stem, imageByMint });
      out.push({
        ts: ev.ts, price: ev.grossPrice, side: ev.side === 'sell' ? 'sell' : 'buy',
        sig: ev.signature, mint: ev.mintAddress, name: d.name, image: d.image,
        mp: String(ev.marketplace), buyer: ev.buyer, seller: ev.seller,
        rank: ev.rarityRank ?? null, supply: ev.totalSupply ?? null,
      });
    }
    return out;
  }, [chartPoints, events, span, nameStem, resolvedName, slug, imageByMint]);

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

  // Top offers: best live personal offer per listed mint (ME / Tensor) +
  // the collection's best executable collection bid. Polled; shown only
  // when above floor.
  type Offer = { priceSol: number; src: 'ME' | 'TENSOR' };
  const [offers, setOffers] = useState<{ byMint: Record<string, Offer>; collectionBid: Offer | null } | null>(null);
  useEffect(() => {
    if (!slug) return;
    let cancelled = false;
    setOffers(null);
    const load = async () => {
      try {
        const res = await fetch(`${API_BASE}/api/collections/offers?slug=${encodeURIComponent(slug)}`);
        if (!res.ok) return;
        const j = await res.json() as { offers: Record<string, Offer>; collectionBid: Offer | null };
        if (!cancelled) setOffers({ byMint: j.offers ?? {}, collectionBid: j.collectionBid ?? null });
      } catch { /* transient */ }
    };
    // First pull after the listings snapshot has landed server-side.
    const first = setTimeout(load, 1500);
    const id = setInterval(load, 60_000);
    return () => { cancelled = true; clearTimeout(first); clearInterval(id); };
  }, [slug]);
  const topOfferFor = (mint: string): Offer | null | undefined => {
    if (!offers) return undefined;
    const p = offers.byMint[mint], c = offers.collectionBid;
    const best = p && (!c || p.priceSol >= c.priceSol) ? p : c;
    return best && listingsFloor != null && best.priceSol > listingsFloor ? best : null;
  };

  const renderListing = (l: ListingRow, nested = false) => {
    const d = resolveNftDisplay({ nftName: l.nftName, mint: l.mint, imageUrl: l.imageUrl, stem: nameStem ?? (resolvedName ?? slug), imageByMint });
    const card = (
      <ListingCard
        key={`${l.id}:${l.priceSol}`}
        fallbackImageUrl={slug ? iconBySlug[slug] ?? null : null}
        listing={{
          id: l.id, mint: l.mint, seller: l.seller, priceSol: l.priceSol,
          marketplace: l.marketplace, listedAt: l.listedAt,
          baseName: d.baseName, num: d.num,
          imageUrl: imageByMint.get(l.mint) ?? l.imageUrl,
          rarityRank: l.rank, totalSupply: collectionSupply,
        }}
        floor={listingsFloor}
        color={headerColor}
        abbr={headerAbbr}
        buy={listingBuyProps(l, buyStatuses[l.mint] ?? { kind: 'idle' }, !!walletPubkey, buyEnabled, onBuyListing)}
        onPreview={setPreview}
        topOffer={nested ? null : topOfferFor(l.mint)}
        selected={!nested && sweepSel.has(l.mint)}
        onSelect={!nested && isSweepable(l) ? toggleSweep : undefined}
        poolMember={nested}
        isNew={l.listedAt != null && l.listedAt > pageOpenedAtRef.current}
      />
    );
    return nested ? <div key={`${l.id}:${l.priceSol}`} className="pool-member-wrap">{card}</div> : card;
  };

  return (
    <div className="page-transition" data-page="collection" style={{ display:'flex', flexDirection:'column', height:'calc(100% - var(--topnav-h, 0px))' }}>
      {/* TopNav rendered persistently by Gate (anti-flash). */}

      {/* Collection header (verbatim layout from collection.html) */}
      <div style={{
        display:'flex', alignItems:'center', justifyContent:'space-between',
        padding:'10px 14px', margin:'10px 4px 0',
        background:'linear-gradient(180deg, var(--vl-gray-surface) 0%, #15102a 100%)',
        border:'1px solid rgba(148,124,226,0.18)',
        borderRadius:12,
        boxShadow:'inset 0 1px 0 rgba(255,255,255,0.05), 0 6px 16px rgba(0,0,0,0.38)',
        flexShrink:0,
      }}>
        <div style={{ display:'flex', alignItems:'center', gap:12 }}>
          <CollectionIcon imageUrl={headerIconUrl} color={headerColor} abbr={headerAbbr} size={44} />
          <div>
            <div style={{ display:'flex', alignItems:'center', gap:8 }}>
              <span style={{ fontSize:14, fontWeight:600, letterSpacing:'-0.1px', color: resolvedName ? 'var(--vl-text-primary)' : 'var(--vl-text-muted)' }}>
                {displayName}
              </span>
              <span style={{ color:'var(--vl-border-subtle)', cursor:'pointer', fontSize:14 }}>☆</span>
              {marketSignal && (() => {
                const cfg = marketSignal === 'sell'
                  ? { label: 'SELL PRESSURE',   border: '1px solid rgb(var(--vl-red) / .5)', background: 'rgb(var(--vl-red) / .13)', color: 'var(--vl-red-primary)' }
                  : marketSignal === 'buy'
                  ? { label: 'BUY OPPORTUNITY', border: '1px solid rgb(var(--vl-green) / .5)', background: 'rgb(var(--vl-green) / .13)', color: 'var(--vl-green-primary)' }
                  : { label: 'MIXED',           border: '1px solid rgb(var(--vl-purple) / .5)', background: 'rgb(var(--vl-purple) / .13)', color: '#b8a8f0' };
                return (
                  <span
                    
                    style={{
                      display:'inline-flex', alignItems:'center',
                      fontSize:9.5, fontWeight:700, letterSpacing:'0.4px',
                      padding:'1px 6px', borderRadius:3, lineHeight:'14px',
                      border: cfg.border, background: cfg.background, color: cfg.color,
                    }}
                  >MARKET SIGNAL: {cfg.label}</span>
                );
              })()}
              {/* Alert-sound toggle — same minimal borderless icon control as
                  the HUD bottom bar (purple on / muted off). Behavior unchanged. */}
              <BarIconButton
                on={soundOn}
                onClick={toggleSound}
                
              >
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M11 5 6 9H2v6h4l5 4z" />
                  {soundOn
                    ? <path d="M15.5 8.5a5 5 0 0 1 0 7" />
                    : <line x1="22" y1="9" x2="16" y2="15" />}
                </svg>
              </BarIconButton>
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
        <div className="collection-header-right" style={{ display:'flex', flexDirection:'column', alignItems:'flex-end', gap:6 }}>
          <div style={{ display:'flex', alignItems:'center', gap:8, fontSize:10, color:'#4d4d6e' }}>
            <span>Metadata fetched</span>
            <div style={{ width:60, height:3, borderRadius:2, background:'#ffffff08', overflow:'hidden' }}>
              <div style={{ width: events.length > 0 ? '100%' : '0%', height:'100%', background:'var(--vl-green-primary)', transition:'width 0.4s' }} />
            </div>
            <span style={{ color:'var(--vl-green-primary)' }}>{events.length > 0 ? '100%' : '—'}</span>
            <span>Ranks variety</span>
            <div style={{ width:60, height:3, borderRadius:2, background:'#ffffff08', overflow:'hidden' }}>
              <div style={{ width: listings.length > 0 ? '99%' : '0%', height:'100%', background:'var(--vl-gold-primary)', transition:'width 0.4s' }} />
            </div>
            <span style={{ color:'var(--vl-gold-primary)' }}>{listings.length > 0 ? '99%' : '—'}</span>
          </div>
          {/* Utility controls — refined to the HUD language: subtle fills,
              minimal (low-alpha) outlines, accent reserved for text. */}
          <div style={{ display:'flex', gap:6, alignItems:'center' }}>
            {walletPubkey ? (
              <button onClick={onDisconnectWallet} style={{
                padding:'4px 10px', fontSize:11, borderRadius:4,
                border:'1px solid rgb(var(--vl-green-glow) / 0.20)', background:'rgb(var(--vl-green-glow) / 0.12)', color:'var(--vl-green-primary)', cursor:'pointer',
              }} >{shortWallet(walletPubkey)} · disconnect</button>
            ) : (
              <button onClick={onConnectWallet} style={{
                padding:'4px 10px', fontSize:11, borderRadius:4,
                border:'1px solid rgb(var(--vl-purple-tint) / 0.20)', background:'rgb(var(--vl-purple-tint) / 0.14)', color:'var(--vl-text-muted)', cursor:'pointer',
              }}>Connect Phantom</button>
            )}
            <button style={{ padding:'4px 10px', fontSize:11, borderRadius:4, border:'1px solid rgba(255,255,255,0.06)', background:'rgba(255,255,255,0.04)', color:'var(--vl-text-muted)', cursor:'pointer' }}>id, name or address</button>
            <button style={{ padding:'4px 10px', fontSize:11, borderRadius:4, border:'1px solid rgb(var(--vl-purple-tint) / 0.20)', background:'rgb(var(--vl-purple-tint) / 0.14)', color:'var(--vl-text-muted)', cursor:'pointer' }}>Quick lookup</button>
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
            color: tab === t ? 'var(--vl-purple-primary)' : 'var(--vl-border-subtle)',
            borderBottom: tab === t ? '2px solid var(--vl-purple-primary)' : '2px solid transparent',
            marginBottom:'-1px',
          }}>
            {t === 'live' ? <><LiveDot /> &nbsp;Live View</> : 'Summary'}
          </button>
        ))}
      </div>

      {/* Main 3-column grid (verbatim ratios + gap + radius) */}
      <div className="collection-grid" style={{ flex:1, display:'grid', gridTemplateColumns:'1.35fr 1.35fr 2fr', gap:10, padding:'10px 4px', minHeight:0, overflow:'hidden' }}>

        {/* LEFT: Listings */}
        <div className="collection-pane-listings" style={{
          display:'flex', flexDirection:'column', overflow:'hidden',
          background:'linear-gradient(180deg, var(--vl-gray-surface) 0%, var(--vl-gray-surface) 100%)',
          border:'1px solid rgb(var(--vl-purple-tint) / 0.28)',
          borderRadius:12,
          boxShadow:'inset 0 1px 0 rgba(255,255,255,0.07), 0 12px 28px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,0,0,0.4), 0 0 14px rgb(var(--vl-purple-deep) / 0.05)',
          position:'relative',
        }}>
          <div style={{ padding:'5px 8px', borderBottom:'1px solid rgb(var(--vl-purple-tint) / 0.12)', flexShrink:0, display:'flex', alignItems:'center', justifyContent:'space-between', background:'rgb(var(--vl-purple-tint) / 0.04)' }}>
            <div style={{ display:'flex', alignItems:'center', gap:6 }}>
              <span style={{ fontSize:11, fontWeight:700, color:'var(--vl-text-primary)', letterSpacing:'0.5px' }}>
                LISTINGS <span
                  
                  style={{ color:'var(--vl-purple-primary)', fontWeight:600 }}
                >({listings.length.toLocaleString()} / {listedCount != null ? listedCount.toLocaleString() : '—'})</span>
              </span>
              <LiveDot />
              {/* NEAR FLOOR / UNDERCUT live indicator temporarily removed —
               *  will return in a cleaner form. Header keeps LISTINGS count
               *  + LiveDot + filters + sort only. */}
            </div>
            <div style={{ display:'flex', alignItems:'center', gap:6 }}>
              <Pill
                active={filtersOpen}
                onClick={() => setFiltersOpen(o => !o)}
                
                icon={<span style={{ fontSize: 11, lineHeight: 1 }}>⚙</span>}
                label="Filters"
                size="sm"
              />
              <span style={{ fontSize:10, color:'var(--vl-text-muted)' }}>Sort:</span>
              <DropBtn label="listing date" />
            </div>
          </div>

          {filtersOpen && (
            <div style={{ padding:'6px 8px', borderBottom:'1px solid rgba(255,255,255,0.05)', flexShrink:0, background:'rgba(255,255,255,0.015)' }}>
              <div style={{ display:'flex', gap:3, flexWrap:'wrap', marginBottom:4 }}>
                <span style={{ display:'flex', alignItems:'center', justifyContent:'center', width:20, height:20, borderRadius:3, border:'1px solid #d63d7c48', background:'#d63d7c20', fontSize:9, fontWeight:700, color:'var(--vl-text-muted)', cursor:'pointer' }}>ME</span>
                <span style={{ display:'flex', alignItems:'center', justifyContent:'center', width:20, height:20, borderRadius:3, border:'1px solid rgb(var(--vl-purple) / .28)', background:'rgb(var(--vl-purple) / .13)', fontSize:9, fontWeight:700, color:'var(--vl-purple-tint)', cursor:'pointer' }}>T</span>
                <FilterBtn label="Min price" />
                <FilterBtn label="Max price" />
                <FilterBtn label="Max rank" />
              </div>
              <div style={{ display:'flex', gap:3, alignItems:'center' }}>
                <span style={{ display:'flex', alignItems:'center', justifyContent:'center', width:20, height:20, borderRadius:3, border:'1px solid rgb(var(--vl-green) / .28)', background:'rgb(var(--vl-green) / .13)', fontSize:9, fontWeight:700, color:'var(--vl-green-primary)', cursor:'pointer' }}>◎</span>
                <span style={{ display:'flex', alignItems:'center', justifyContent:'center', width:20, height:20, borderRadius:3, border:'1px solid #ffffff0d', background:'#ffffff07', fontSize:9, color:'var(--vl-text-muted)', cursor:'pointer' }}>↓</span>
                <button style={{ padding:'3px 10px', fontSize:11, borderRadius:4, border:'1px solid #ffffff0d', background:'#ffffff07', color:'var(--vl-text-muted)', cursor:'pointer', display:'flex', alignItems:'center', gap:4 }}>
                  <span style={{ color:'var(--vl-green-primary)' }}>+</span> Trait filter
                </button>
                <div style={{ flex:1 }} />
                <span style={{ fontSize:10, color:'var(--vl-text-muted)', marginRight:6 }}>0/0 ACTIVE</span>
                <button style={{ padding:'2px 8px', fontSize:10, borderRadius:3, border:'1px solid rgb(var(--vl-green) / .19)', background:'transparent', color:'var(--vl-green-primary)', cursor:'pointer' }}>+ Rule</button>
              </div>
            </div>
          )}

          {/* Sweep bar: floor slider (2 per tick) + BUY ALL once anything is selected. */}
          <div className="sweep-bar">
            <span className="sweep-bar-label">SWEEP</span>
            <input
              type="range"
              min={SWEEP_STEP}
              max={SWEEP_MAX}
              step={SWEEP_STEP}
              list="sweep-ticks"
              value={sweepN}
              onChange={(e) => applyFloorSweep(Number(e.target.value))}
              // Click on the resting thumb (no drag) still applies the value.
              onPointerUp={(e) => applyFloorSweep(Number((e.target as HTMLInputElement).value))}
              disabled={sweepFloorOrder.length === 0 || sweepStage !== 'idle'}
              aria-label="Select the N cheapest listings"
              title={`Select the ${Math.min(sweepN, sweepFloorOrder.length)} cheapest listings`}
              className="sweep-slider"
              style={{ '--fill': `${((sweepN - SWEEP_STEP) / (SWEEP_MAX - SWEEP_STEP)) * 100}%` } as React.CSSProperties}
            />
            <datalist id="sweep-ticks">
              {SWEEP_TICKS.map(v => <option key={v} value={v} />)}
            </datalist>
            <span className="sweep-bar-n">{Math.min(sweepN, sweepFloorOrder.length)}</span>
            <div style={{ flex: 1 }} />
            {sweepRows.length > 0 && sweepStage === 'idle' && (
              <button className="sweep-clear" onClick={() => setSweepSel(new Set())} title="Clear selection">✕</button>
            )}
            {(sweepRows.length > 0 || sweepStage !== 'idle') && (
              <button
                className="sweep-buy-all"
                onClick={onBuyAll}
                disabled={!walletPubkey || sweepStage !== 'idle' || (sweepRows.some(l => l.marketplace === 'me') && buyEnabled !== true)}
                title={!walletPubkey ? 'Connect Phantom to buy' : `Buy ${sweepRows.length} NFTs for ${formatSol(sweepTotalSol)} SOL — one Phantom approval`}>
                {sweepStage === 'building' ? 'Preparing…'
                  : sweepStage === 'signing' ? 'Sign in Phantom…'
                  : sweepStage === 'sending' ? 'Sending…'
                  : <>BUY ALL <span className="sweep-buy-all-n">{sweepRows.length}</span> · {formatSol(sweepTotalSol)} SOL</>}
              </button>
            )}
          </div>

          <div
            style={{ flex:1, overflowY:'auto' }}
            className="scroll-area"
            onScroll={(e) => {
              if (listingsShow >= listingItems.length) return;
              const el = e.currentTarget;
              if (el.scrollHeight - el.scrollTop - el.clientHeight < 200) {
                setListingsShow(s => Math.min(s + GROW_STEP, listingItems.length));
              }
            }}
          >
            {listings.length === 0 && (
              <div style={{ textAlign:'center', color:'var(--vl-text-muted)', fontSize:10.5, padding:'24px 0' }}>
                {buyEnabled === false ? 'No active ME listings.' : 'Loading listings…'}
              </div>
            )}
            <div className="feed-list feed-density-compact coll-feed">
              {listingItems.slice(0, listingsShow).map(it => {
                if (it.kind === 'row') return renderListing(it.l);
                const open = openPools.has(it.poolKey);
                return (
                  <div key={`pool:${it.poolKey}`} className={`pool-group${open ? ' is-open' : ''}`}>
                    <PoolGroupCard
                      poolKey={it.poolKey}
                      count={it.rows.length}
                      priceSol={it.rows[0].priceSol}
                      imageUrls={it.rows.slice(0, 3).map(r => imageByMint.get(r.mint) ?? r.imageUrl)}
                      color={headerColor}
                      abbr={headerAbbr}
                      expanded={open}
                      fallbackImageUrl={slug ? iconBySlug[slug] ?? null : null}
                      onToggle={() => setOpenPools(prev => {
                        const next = new Set(prev);
                        if (next.has(it.poolKey)) next.delete(it.poolKey); else next.add(it.poolKey);
                        return next;
                      })}
                    />
                    {open && it.rows.map(r => renderListing(r, true))}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* MIDDLE: Trades */}
        <div className="collection-pane-trades" style={{
          display:'flex', flexDirection:'column', overflow:'hidden',
          background:'linear-gradient(180deg, var(--vl-gray-surface) 0%, var(--vl-gray-surface) 100%)',
          border:'1px solid rgb(var(--vl-purple-tint) / 0.28)',
          borderRadius:12,
          boxShadow:'inset 0 1px 0 rgba(255,255,255,0.07), 0 12px 28px rgba(0,0,0,0.5), 0 0 0 1px rgba(0,0,0,0.4), 0 0 14px rgb(var(--vl-purple-deep) / 0.05)',
          position:'relative',
        }}>
          <div style={{ padding:'5px 8px', borderBottom:'1px solid rgb(var(--vl-purple-tint) / 0.12)', flexShrink:0, display:'flex', alignItems:'center', justifyContent:'space-between', background:'rgb(var(--vl-purple-tint) / 0.04)' }}>
            <div style={{ display:'flex', alignItems:'center', gap:6 }}>
              <span style={{ fontSize:11, fontWeight:700, color:'var(--vl-text-primary)', letterSpacing:'0.5px' }}>
                TRADES <span
                  
                  style={{ color:'var(--vl-purple-primary)', fontWeight:600 }}
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
                  : { border: '1px solid rgb(var(--vl-red) / .38)', background: 'rgb(var(--vl-red) / .13)', color: 'var(--vl-red-primary)' };
                const tooltip =
                  `${bidDumpStats.count} bid-sells in 60s`
                  + ` · ${formatSol(bidDumpStats.volume)} total`
                  + ` · largest ${formatSol(bidDumpStats.largest)}`;
                return (
                  <span
                    
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
              <Pill
                active={tradeFiltersOpen}
                onClick={() => setTradeFiltersOpen(o => !o)}
                
                icon={<span style={{ fontSize: 11, lineHeight: 1 }}>⚙</span>}
                label="Filters"
                size="sm"
              />
              <span style={{ fontSize:10, color:'var(--vl-text-muted)' }}>Sort:</span>
              <DropBtn label="trade date" />
            </div>
          </div>

          {tradeFiltersOpen && (
            <div style={{ padding:'6px 8px', borderBottom:'1px solid rgba(255,255,255,0.05)', flexShrink:0, background:'rgba(255,255,255,0.015)' }}>
              <div style={{ display:'flex', gap:3, flexWrap:'wrap', marginBottom:4 }}>
                <span style={{ display:'flex', alignItems:'center', justifyContent:'center', width:20, height:20, borderRadius:3, border:'1px solid #d63d7c48', background:'#d63d7c20', fontSize:9, fontWeight:700, color:'var(--vl-text-muted)', cursor:'pointer' }}>ME</span>
                <span style={{ display:'flex', alignItems:'center', justifyContent:'center', width:20, height:20, borderRadius:3, border:'1px solid rgb(var(--vl-purple) / .28)', background:'rgb(var(--vl-purple) / .13)', fontSize:9, fontWeight:700, color:'var(--vl-purple-tint)', cursor:'pointer' }}>T</span>
                <FilterBtn label="Min price" />
                <FilterBtn label="Max price" />
                <FilterBtn label="Max rank" />
              </div>
              <div style={{ display:'flex', gap:3, alignItems:'center' }}>
                <span style={{ display:'flex', alignItems:'center', justifyContent:'center', width:20, height:20, borderRadius:3, border:'1px solid rgb(var(--vl-green) / .28)', background:'rgb(var(--vl-green) / .13)', fontSize:9, fontWeight:700, color:'var(--vl-green-primary)', cursor:'pointer' }}>◎</span>
                <span style={{ display:'flex', alignItems:'center', justifyContent:'center', width:20, height:20, borderRadius:3, border:'1px solid #ffffff0d', background:'#ffffff07', fontSize:9, color:'var(--vl-text-muted)', cursor:'pointer' }}>↓</span>
                <button style={{ padding:'3px 10px', fontSize:11, borderRadius:4, border:'1px solid #ffffff0d', background:'#ffffff07', color:'var(--vl-text-muted)', cursor:'pointer', display:'flex', alignItems:'center', gap:4 }}>
                  <span style={{ color:'var(--vl-green-primary)' }}>+</span> Trait filter
                </button>
                <div style={{ flex:1 }} />
                <span style={{ fontSize:10, color:'var(--vl-text-muted)', marginRight:6 }}>0/0 ACTIVE</span>
                <button style={{ padding:'2px 8px', fontSize:10, borderRadius:3, border:'1px solid rgb(var(--vl-green) / .19)', background:'transparent', color:'var(--vl-green-primary)', cursor:'pointer' }}>+ Rule</button>
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
              <div style={{ textAlign:'center', color:'var(--vl-text-muted)', fontSize:10.5, padding:'24px 0' }}>
                No trades yet for <code>{slug}</code>
              </div>
            )}
            <div className="feed-list feed-density-compact coll-feed">
              {tradeCards.slice(0, tradesShow).map(ev => (
                <FeedCard
                  key={ev.id}
                  event={ev}
                  onPreview={setPreview}
                  inclusiveFees={inclusiveFees}
                  slugFloor={floorSol}
                  sellerSellCountInFeed={0}
                  isNewestSellForSellerColl={false}
                  density="compact"
                  numOnly
                  thumbBorderColor="rgb(245, 88, 102)"
                />
              ))}
            </div>
          </div>
        </div>

        {/* RIGHT: Stats + Chart (verbatim layout) */}
        <div className="collection-pane-stats" style={{
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
            <StatItem value={floor1hSol > 0 ? floor1hSol.toFixed(floor1hSol < 1 ? 3 : 2) : '—'} label="1H Floor" highlight="var(--vl-text-muted)" />
            <StatItem
              value={`${listings.length.toLocaleString()} / ${listedCount != null ? listedCount.toLocaleString() : '—'}`}
              label="Listings"
              
            />
            <StatItem value={floorSol != null ? floorSol.toFixed(floorSol < 1 ? 3 : 2) : '—'} label="Floor" highlight="var(--vl-green-primary)" />
          </div>
          {/* Stats row 2 */}
          <div style={{ display:'flex', borderBottom:'1px solid rgba(255,255,255,0.05)', flexShrink:0, background:'transparent' }}>
            <StatItem value={vol7dSol  != null ? formatSol(vol7dSol)  : '—'} label="7D Vol" />
            <StatItem value={vol24hSol != null ? formatSol(vol24hSol) : '—'} label="24H Vol" />
            <StatItem value={volumeAllSol != null ? `${(volumeAllSol/1000).toFixed(1)}K` : '—'} label="Total Volume" />
          </div>
          {/* Chart header (verbatim) */}
          <div style={{
            display:'flex', alignItems:'center', justifyContent:'space-between',
            padding:'3px 8px', flexShrink:0,
          }}>
            <span style={{ fontSize:11, fontWeight:700, color:'var(--vl-text-muted)', letterSpacing:'0.5px' }}>TRADES</span>
            <div style={{ display:'flex', alignItems:'center', gap:10 }}>
              <span style={{ fontSize:11, color:'#4d4d6e' }}>Span</span>
              <div style={{ display:'flex', background:'rgba(255,255,255,0.02)', border:'1px solid #ffffff08', borderRadius:4, overflow:'hidden' }}>
                {SPANS.map(v => (
                  <button key={v} onClick={() => setSpan(v)} style={{
                    padding:'2px 7px', fontSize:10, fontWeight:600, border:'none',
                    background: span === v ? 'rgb(var(--vl-green) / .13)' : 'transparent',
                    borderRight: '1px solid #ffffff08',
                    color: span === v ? 'var(--vl-green-primary)' : 'var(--vl-text-muted)',
                    cursor:'pointer',
                  }}>{v}</button>
                ))}
              </div>
              <button
                onClick={() => setOutliers(v => !v)}
                title={outliers ? 'Showing every sale (axis stretches to extremes)' : 'Extreme sales pinned to the chart edge'}
                style={{ display:'flex', alignItems:'center', gap:6, background:'none', border:'none', padding:0, cursor:'pointer' }}>
                <span style={{ fontSize:11, color: outliers ? 'var(--vl-text-muted)' : '#4d4d6e' }}>Outliers</span>
                <span style={{
                  width:28, height:14, borderRadius:7, position:'relative',
                  background: outliers ? 'rgb(var(--vl-green) / .35)' : '#ffffff0d',
                  transition:'background 120ms',
                }}>
                  <span style={{
                    position:'absolute', top:2, left: outliers ? 16 : 2,
                    width:10, height:10, borderRadius:'50%', background:'var(--vl-white)',
                    transition:'left 120ms',
                  }} />
                </span>
              </button>
            </div>
          </div>

          {/* Scatter chart (verbatim wrapper) */}
          <div className="collection-chart" style={{
            flex:1, display:'flex', minHeight:0,
            margin:'4px 10px 10px',
            background:'#0a0714',
            border:'1px solid rgba(255,255,255,0.04)',
            borderRadius:8,
            overflow:'hidden',
          }}>
            <SalesChart points={salePoints} spanMs={SPAN_MS[span]} floor={floorSol} showOutliers={outliers} />
          </div>
        </div>
      </div>
      <ImagePreviewOverlay src={preview} onClose={() => setPreview(null)} />
    </div>
  );
}
