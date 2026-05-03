'use client';

// Soloist — Live Feed (design port of feed.html)
// Snapshot via REST + live updates via SSE; mapped through `fromBackend`.

import { memo, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  FeedEvent, Side,
  formatSol, shortWallet, timeAgo,
} from '@/soloist/mock-data';
import { fromBackend, fromRow, marketplaceUrl } from '@/soloist/from-backend';
import type { BackendEvent, LatestApiResponse } from '@/soloist/from-backend';
import { ItemThumb, LiveDot, MktIconBadge, Pill, TopNav, compressImage, EVENTS_COUNT_EVENT } from '@/soloist/shared';
import { displayPrice, useInclusiveFees } from '@/soloist/price-mode';
import {
  feedReducer, initFeedState, orderedEvents,
  type MetaPatch, type FeedAction,
} from '@/soloist/feed-store';
import { isCnftDust, CNFT_FLOOR_MIN_SOL } from '@/soloist/cnft-filter';
import { playDeepDiscountAlert } from '@/soloist/use-ui-sound';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';
const MAX_EVENTS = 200;
const SNAPSHOT_LIMIT = 100;

// ── Persisted seller-remaining counts ──────────────────────────────────────
// Map of `${seller}-${collection}` → count, JSON-encoded into localStorage.
// Backend emits the count asynchronously over SSE (event: seller_count)
// keyed by the same composite. Storing by seller+collection — instead of
// the prior signature key — means one resolved value lights up every row
// from the same wallet+collection (mid-dump or post-reload), and old
// signature-keyed entries from prior versions are simply ignored on
// hydration since they don't match the new key shape.
const SELLER_COUNT_STORAGE_KEY = 'vl.feed.sellerCount.v2';
const SELLER_COUNT_MAX_ENTRIES = 500;

function sellerCountKey(seller: string | null | undefined, collection: string | null | undefined): string | null {
  if (!seller || !collection) return null;
  return `${seller}-${collection}`;
}

function loadSellerCounts(): Map<string, number> {
  if (typeof window === 'undefined') return new Map();
  try {
    const raw = window.localStorage.getItem(SELLER_COUNT_STORAGE_KEY);
    if (!raw) return new Map();
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (!obj || typeof obj !== 'object') return new Map();
    const m = new Map<string, number>();
    for (const [k, v] of Object.entries(obj)) {
      if (typeof k === 'string' && typeof v === 'number' && Number.isFinite(v)) m.set(k, v);
    }
    return m;
  } catch { return new Map(); }
}

function persistSellerCounts(map: Map<string, number>): void {
  if (typeof window === 'undefined') return;
  try {
    if (map.size > SELLER_COUNT_MAX_ENTRIES) {
      const overflow = map.size - SELLER_COUNT_MAX_ENTRIES;
      const it = map.keys();
      for (let i = 0; i < overflow; i++) {
        const k = it.next().value;
        if (k != null) map.delete(k);
      }
    }
    window.localStorage.setItem(SELLER_COUNT_STORAGE_KEY, JSON.stringify(Object.fromEntries(map)));
  } catch { /* quota / serialize error — fail silent */ }
}
/** Scroll tolerance (px) for treating the user as "at top". */
const AT_TOP_THRESHOLD = 4;
/** Lowercased collection-name blacklist; mirrors src/db/blacklist.ts NAME_BLACKLIST. */
const FEED_NAME_BLACKLIST = new Set<string>([
  'collector crypt',
]);
/** Frontend-only slug blacklist — hide specific collections from the Live
 *  Feed without touching ingestion. Collection page for these slugs still
 *  renders normally if visited directly. */
const FEED_SLUG_BLACKLIST = new Set<string>([
  'staratlascrew',
]);

// ── Time-ago leaf ────────────────────────────────────────────────────────────
// Self-ticking time label. 1 s interval gives smooth seconds in the
// 5–15 s pink window (per UX spec); the work per tick is one Date.now()
// + a small <span> rerender, comfortably cheap even with 200 cards.
// Each instance owns its own interval so React.memo on FeedCard isn't
// invalidated every tick.
//
// Color tiers (per spec):
//   1–5 s:        pink + "just now"
//   6–15 s:       pink + "Xs ago"        (still in the "hot" window)
//   16 s – 3 min: yellow                 (recent but cooling)
//   > 3 min:      muted                  (background/historical)
function TimeAgo({ ts }: { ts: number }) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force(n => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  // Defensive: invalid timestamp renders an em-dash so a malformed /
  // missing blockTime can't surface as "NaNd ago". Future-leaning and
  // negative ages already collapse into the `ageMs < 5000` branch
  // below ("just now") since `<` evaluates true for any negative.
  if (!Number.isFinite(ts)) {
    return <span style={{ fontSize: 11, color: '#877496', fontWeight: 500 }}>—</span>;
  }
  const ageMs = Date.now() - ts;
  let color: string;
  let weight: 500 | 600 = 500;
  if (ageMs < 15000) {
    color  = '#e87ab0'; // pink — covers both "just now" (<5s) and 6-15s
    weight = 600;
  } else if (ageMs < 180000) {
    color  = '#c7b479'; // yellow — 16s to 3min
  } else {
    color  = '#877496'; // muted — older than 3min
  }
  const text = ageMs < 5000 ? 'just now' : timeAgo(ts);
  return <span style={{ fontSize: 11, color, fontWeight: weight }}>{text}</span>;
}

// ── Wallet links + "YOU" badge ──────────────────────────────────────────────
//
// Operator's own wallet — sales involving this address render "YOU" in a
// small cyan pill instead of the truncated address. Stays clickable to
// Solscan (same as any other wallet); the tiny ME icon next to it links
// to the wallet's Magic Eden profile. Hard-coded for v1 — promote to a
// per-user setting via localStorage when multi-wallet support lands.
const MY_WALLET = 'F7BDq8YsYs69JsMxJJhARTTTZNcKu5h2GohLbe8cYQwE';

/** Inline wallet link: address (or "YOU" badge) → Solscan, plus a tiny
 *  ME icon → magiceden.io/u/<wallet>. The 11×11 icon matches the seller/
 *  buyer text height (11 px line) so the row's vertical metric is
 *  unchanged — no layout shift when the icon image arrives.
 *  `flexShrink: 0` on the icon keeps it inline-aligned even when the
 *  parent row gets squeezed on narrow viewports. */
function WalletLink({ wallet }: { wallet: string | null }) {
  if (!wallet) {
    return <span style={{ color: '#7a7a94', fontWeight: 500, fontFamily: "'SF Mono','Fira Code',monospace" }}>N/A</span>;
  }
  const isMe = wallet === MY_WALLET;
  const solscanUrl = `https://solscan.io/account/${wallet}`;
  const meUrl      = `https://magiceden.io/u/${wallet}`;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
      <a
        href={solscanUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={`Solscan · ${wallet}`}
        style={isMe ? YOU_BADGE_STYLE : WALLET_LINK_STYLE}
        // Match the NFT-name link's hover treatment: no underline by
        // default, solid underline on hover. Skip the YOU badge — that
        // pill already has its own visual affordance and an underline
        // would clash with the rounded background.
        onMouseEnter={(e) => { if (!isMe) (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'underline'; }}
        onMouseLeave={(e) => { if (!isMe) (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'none'; }}
      >
        {isMe ? 'YOU' : shortWallet(wallet)}
      </a>
      <a
        href={meUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={`Magic Eden · ${wallet}`}
        style={ME_ICON_LINK_STYLE}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/me.png" alt="ME" width={11} height={11} draggable={false} style={{ display: 'block', borderRadius: 2 }} />
      </a>
    </span>
  );
}

const WALLET_LINK_STYLE: React.CSSProperties = {
  color: '#7a7a94', fontWeight: 500,
  fontFamily: "'SF Mono','Fira Code',monospace",
  // No persistent decoration — matches the NFT-name link's behavior.
  // Hover handlers on the anchor toggle `textDecoration: 'underline'`.
  textDecoration: 'none',
};
/** "YOU" pill — cyan/blue, distinct from the buy/sell badge palette so
 *  it doesn't conflict visually with the existing kind tokens. */
const YOU_BADGE_STYLE: React.CSSProperties = {
  display: 'inline-block',
  padding: '0px 6px',
  fontSize: 9.5,
  fontWeight: 800,
  letterSpacing: '0.5px',
  borderRadius: 3,
  background: 'rgba(95,168,230,0.18)',
  color: '#5fa8e6',
  border: '1px solid rgba(95,168,230,0.45)',
  textDecoration: 'none',
  lineHeight: '14px',
};
const ME_ICON_LINK_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  lineHeight: 0,
  flexShrink: 0,
  opacity: 0.85,
  textDecoration: 'none',
};

// ── Floor delta chip ────────────────────────────────────────────────────────
//
// Shows sale price vs. collection floor as a percentage next to the
// time + marketplace icon in the right column's top row, so no extra
// row is added to the card (cards stay the same height). Backend
// `floorDelta` is a fractional ratio (+0.12 = +12%).
//
// Two-tier palette so the eye locks onto outliers:
//   • |Δ| <  25 %  → MUTED  (dim grey-tinted text/border, no fill).
//                    Routine sales near floor blend into the row.
//   • |Δ| >= 25 %  → BRIGHT (saturated green / red, faint fill).
//                    Big-mover sales stand out at a glance.
/** Display-time guard against NaN / Infinity / non-numeric inputs from
 *  malformed wire frames. Returns the value when it's a usable finite
 *  number, else null so render sites can substitute a placeholder. */
function safeFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const FLOOR_BRIGHT_THRESHOLD = 0.25;
function FloorChip({ delta }: { delta: number }) {
  if (!Number.isFinite(delta)) return null;
  const above  = delta >= 0;
  const pct    = delta * 100;
  const sign   = above ? '+' : '';
  const bright = Math.abs(delta) >= FLOOR_BRIGHT_THRESHOLD;
  // Bright tier: original saturated palette.
  // Muted tier: same hue family but ~40 % the saturation so the chip
  // still reads as green-or-red (preserves directional cue) without
  // competing with the price/badge for attention.
  const fg = bright
    ? (above ? '#5ce0a0' : '#ef7878')
    : (above ? '#7a9a85' : '#9a7878');
  const bg = bright
    ? (above ? 'rgba(92,224,160,0.10)' : 'rgba(239,120,120,0.10)')
    : 'transparent';
  const bd = bright
    ? (above ? 'rgba(92,224,160,0.32)' : 'rgba(239,120,120,0.32)')
    : (above ? 'rgba(122,154,133,0.22)' : 'rgba(154,120,120,0.22)');
  return (
    <span
      title={`${sign}${pct.toFixed(1)}% vs collection floor`}
      style={{
        fontSize: 10, fontWeight: bright ? 700 : 600,
        color: fg, background: bg, border: `1px solid ${bd}`,
        padding: '1px 5px', borderRadius: 3, letterSpacing: '0.2px',
        lineHeight: 1.1, fontFamily: "'SF Mono','Fira Code',monospace",
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {sign}{pct.toFixed(0)}%
    </span>
  );
}

// ── Feed Card ────────────────────────────────────────────────────────────────
// Memoized: existing cards skip render when new events are prepended.
// Re-renders only when `event` changes — the time label has been hoisted
// into the <TimeAgo> leaf above, so card bodies are stable after first paint.

interface FeedCardProps {
  event: FeedEvent;
  /** LMB on avatar → open a small centered image preview. */
  onPreview: (url: string) => void;
  /** Current "Inclusive fees" toggle state from BottomStatusBar. Only
   *  AMM_SELL rows actually branch on this; passed down to every card
   *  so the price re-renders the moment the toggle flips. */
  inclusiveFees: boolean;
  /** Frontend fallback floor (SOL) for this card's slug. Used only
   *  when `event.floorDelta` is missing — backend's value always wins
   *  when present. Sourced from the existing `floorBySlug` cache (the
   *  cNFT-dust resolver), so the fallback fires for slugs that cache
   *  has already populated; no new fetches are added on this path. */
  slugFloor?: number | null;
  /** Number of sell-side rows this seller+collection has in the
   *  currently visible feed. Drives the noise-cut on the
   *  seller-remaining badge: a single sell from a seller with high
   *  inventory is quieter than two-in-a-row, which is when the
   *  "active dumping" signal becomes meaningful. */
  sellerSellCountInFeed: number;
  /** True when this row is the most-recent sell in the feed for its
   *  seller+collection pair. The badge only renders on the newest row
   *  so older sibling rows don't repeat the same number. */
  isNewestSellForSellerColl: boolean;
}

// Static FeedCard inline styles hoisted to module scope. These objects
// are byte-identical across every render and every card instance, so
// referencing the same object lets React.memo bail out on shallow
// equality checks without recreating the literals each render. Keep
// dynamic styles (thumb cursor, NFT-type border, BUY/SELL bg+fg)
// inline at the call site since they depend on event/runtime state.
const FC_THUMB_INNER_STYLE: React.CSSProperties = {
  pointerEvents: 'none', userSelect: 'none',
};
const FC_MIDDLE_COL_STYLE: React.CSSProperties = {
  flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column',
  justifyContent: 'space-between', paddingTop: 1, paddingBottom: 1,
};
const FC_NAME_ROW_STYLE: React.CSSProperties = {
  display: 'flex', alignItems: 'baseline', gap: 8, overflow: 'hidden',
};
const FC_NAME_LINK_STYLE: React.CSSProperties = {
  fontSize: 14, fontWeight: 700, color: '#f0eef8', letterSpacing: '-0.2px',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  textDecoration: 'none', cursor: 'pointer',
};
const FC_NAME_SPAN_STYLE: React.CSSProperties = {
  fontSize: 14, fontWeight: 700, color: '#f0eef8', letterSpacing: '-0.2px',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const FC_NAME_NUM_STYLE: React.CSSProperties = { color: '#e8e6f2' };
const FC_PARTIES_COL_STYLE: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: 1, marginTop: 3,
};
const FC_PARTY_ROW_STYLE: React.CSSProperties = {
  fontSize: 10.5, color: '#55556e', display: 'flex', alignItems: 'center', gap: 6,
};
const FC_RIGHT_COL_STYLE: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
  alignItems: 'flex-end', gap: 6, flexShrink: 0, paddingTop: 1,
};
const FC_TOP_RIGHT_CLUSTER_STYLE: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 5,
};
const FC_PRICE_ROW_STYLE: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8,
};
const FC_PRICE_TEXT_STYLE: React.CSSProperties = {
  minWidth: 80, textAlign: 'right',
  fontSize: 16, fontWeight: 800, color: '#f0eef8', letterSpacing: '-0.3px',
  fontFamily: "'SF Mono','Fira Code',monospace",
  fontVariantNumeric: 'tabular-nums',
};
const FC_PRICE_SUFFIX_STYLE: React.CSSProperties = {
  color: '#8a8aa6', fontWeight: 600, fontSize: 11,
};
// Inline seller-remaining badge — sits next to the seller wallet on the
// FeedCard. Sized to the 11×11 ME-icon metric used in the same row so it
// doesn't expand the row height. Soft yellow on near-black for a readable
// micro-pill look (no thick border, no glow).
const SELLER_REMAINING_BADGE_STYLE: React.CSSProperties = {
  display:        'inline-flex',
  alignItems:     'center',
  justifyContent: 'center',
  flexShrink:     0,
  marginLeft:     4,
  minWidth:       16,
  height:         16,
  padding:        '0 4px',
  borderRadius:   999,
  // Color matches the TimeAgo "16s–3min" timestamp tint (#c7b479) so
  // the badge reads as ambient context — same visual weight as the
  // time label, not an alert. Background is a very soft same-hue
  // wash for shape definition without the prior neon look.
  background:     'rgba(199, 180, 121, 0.12)',
  color:          '#c7b479',
  fontSize:       10,
  fontWeight:     700,
  lineHeight:     1,
  letterSpacing:  '0.2px',
  fontFamily:     "'SF Mono','Fira Code',monospace",
  fontVariantNumeric: 'tabular-nums',
  userSelect:     'none',
};

const FeedCard = memo(function FeedCard({
  event,
  onPreview,
  inclusiveFees,
  slugFloor,
  sellerSellCountInFeed,
  isNewestSellForSellerColl,
}: FeedCardProps) {
  const renderPrice = displayPrice(event, inclusiveFees);
  // Display-only guard — keeps the formatter from producing "NaN" /
  // "Infinity" text if a malformed event slips past upstream validation.
  // Backend remains the source of truth for valid prices; this is the
  // last-mile defensive rendering path.
  const safePrice   = safeFiniteNumber(renderPrice);
  // Effective floor delta: prefer the backend value when present; fall
  // back to a locally-derived delta from `slugFloor` only when the
  // backend left it null AND we have a cached floor + a finite price.
  // Same fractional shape (price/floor − 1) the backend produces, so
  // `FloorChip` renders identically.
  let effectiveFloorDelta: number | null | undefined = event.floorDelta;
  if (effectiveFloorDelta == null && slugFloor != null && slugFloor > 0 && safePrice != null) {
    effectiveFloorDelta = (safePrice - slugFloor) / slugFloor;
  }
  // Row-flash class lasts 6 s from event.ts. Computed once at mount with a
  // one-shot setTimeout to flip false — no per-tick recompute needed since
  // every card mounts at most once per event.
  const [isNew, setIsNew] = useState(() => event.ts > Date.now() - 6000);
  useEffect(() => {
    if (!isNew) return;
    const remaining = 6000 - (Date.now() - event.ts);
    if (remaining <= 0) { setIsNew(false); return; }
    const t = setTimeout(() => setIsNew(false), remaining);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const kind  = saleKind(event.saleTypeRaw);
  const sellerCount = event.sellerRemainingCount;
  const style = KIND_STYLES[kind];
  // Border tint: buy/buyAmm → green border, sell/sellAmm → red border.
  // Falls back to the existing buy-card class for unknown so neutral rows
  // still look familiar.
  const borderClass =
    style.borderTone === 'sell' ? 'sell-card' :
    style.borderTone === 'buy'  ? 'buy-card'  : 'buy-card';
  const cardClass = `feed-card ${borderClass}`;
  const m = event.nftName?.match(/^(.*?)\s*#?(\d+)$/);
  const baseName = m ? m[1] : (event.nftName ?? '');
  const num = m ? m[2] : '';
  // Cap the displayed title length (collection name + " #<num>") so very
  // long names don't crowd the right column. The cap is checked against
  // the full visible string so the number counts toward the budget;
  // when truncated we fall back to a single string (loses the styled
  // `#…` color) and append an ellipsis.
  const NAME_MAX_LEN = 18;
  const fullName     = (baseName + (num ? ` #${num}` : '')).trim();
  const isTruncated  = fullName.length > NAME_MAX_LEN;
  const shortName    = isTruncated
    ? fullName.slice(0, NAME_MAX_LEN).trim() + '...'
    : null;

  // Avatar click routing, local to the Live Feed card:
  //   LMB  → centered image preview (onPreview callback).
  //   MMB  → open /collection/<slug> in a new tab.
  //   RMB  → default (browser context menu) — no handler.
  //
  // The inner <ItemThumb> is wrapped in a `pointer-events: none` shell so
  // the <img> never becomes the event target. That removes every
  // image-native default (open-image-in-new-tab, drag-to-tab, extension
  // middle-click-open-URL) without an absolute overlay. Parent handlers
  // still fire because events fall through to `.feed-thumb`.
  const thumbImg       = compressImage(event.imageUrl);
  const thumbSlug      = event.meCollectionSlug;
  const nftBorderColor = getNftBorderColor(event.nftType);
  const handleThumbClick = () => { if (thumbImg) onPreview(thumbImg); };
  const handleThumbMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1) { e.preventDefault(); e.stopPropagation(); }
  };
  const handleThumbAuxClick = (e: React.MouseEvent) => {
    if (e.button !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    if (thumbSlug) {
      window.open(`/collection/${encodeURIComponent(thumbSlug)}`, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <div className={`feed-row-wrap${isNew ? ' new-' + event.side : ''}`}>
      <div className={cardClass}>
        <div
          className="feed-thumb"
          onClick={handleThumbClick}
          onMouseDown={handleThumbMouseDown}
          onAuxClick={handleThumbAuxClick}
          style={{ cursor: thumbImg ? 'pointer' : 'default', position: 'relative' }}
        >
          <div draggable={false} style={FC_THUMB_INNER_STYLE}>
            <ItemThumb imageUrl={thumbImg} color={event.color} abbr={event.abbr} size={56} />
          </div>
          {nftBorderColor && (
            <span
              aria-hidden
              style={{
                position: 'absolute', inset: 0,
                borderRadius: 6,
                // Layered border — colored hairline (1px) for type identity
                // plus a faint dark inset line just inside it. The dark
                // ring cuts through bright pixels on light/colorful NFTs;
                // the colored line keeps full opacity so it stays visible
                // against dark NFTs and the dark feed background. Total
                // visual band = 2 px, but only 1 px of it is colored, so
                // the rim doesn't read as "thick".
                border: `1px solid ${nftBorderColor}`,
                boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.45)',
                pointerEvents: 'none',
              }}
            />
          )}
        </div>

        {/* Middle column */}
        <div style={FC_MIDDLE_COL_STYLE}>
          <div style={FC_NAME_ROW_STYLE}>
            {thumbSlug ? (
              <a
                href={`/collection/${encodeURIComponent(thumbSlug)}`}
                onClick={(e) => e.stopPropagation()}
                style={FC_NAME_LINK_STYLE}
                title={isTruncated ? fullName : undefined}
                onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'underline'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'none'; }}
              >
                {isTruncated
                  ? shortName
                  : <>{baseName}{num && <span style={FC_NAME_NUM_STYLE}> #{num}</span>}</>}
              </a>
            ) : (
              <span style={FC_NAME_SPAN_STYLE} title={isTruncated ? fullName : undefined}>
                {isTruncated
                  ? shortName
                  : <>{baseName}{num && <span style={FC_NAME_NUM_STYLE}> #{num}</span>}</>}
              </span>
            )}
            {event.saleTypeRaw === 'lucky_buy' && (
              // Lucky Buy marker — small inline emoji after the NFT
              // name, no extra column or layout shift. Tooltip explains
              // what the icon means for operators unfamiliar with the
              // raffle product. Negative `marginLeft` cancels the
              // parent flex container's `gap: 8` so the emoji sits
              // flush against the name rather than spaced 8 px apart.
              <span
                title="Magic Eden Lucky Buy — winner received this NFT via raffle settlement"
                aria-label="Lucky Buy"
                style={{ flexShrink: 0, fontSize: 12, lineHeight: 1, userSelect: 'none', marginLeft: -8 }}
              >🍀</span>
            )}
          </div>

          {/* Seller/buyer rows — wallets clickable to Solscan; tiny ME
              icon next to each links to the wallet's Magic Eden profile.
              Operator's own wallet renders as a "YOU" pill instead of the
              shortened address (still clickable to Solscan + ME). Row
              height stays at 11 px (lineHeight: '14px' on the YOU pill +
              11×11 ME icon match the underlying text metric). */}
          <div style={FC_PARTIES_COL_STYLE}>
            <div style={FC_PARTY_ROW_STYLE}>
              <span>seller:</span>
              <WalletLink wallet={event.seller} />
              {/* Seller-remaining badge — small, inline next to the
                  seller wallet. Renders only on sell-type events when
                  backend has resolved a finite count (0 is a valid
                  value). Soft yellow circle on dark text, sized to
                  the wallet line metric so it doesn't bump row height. */}
              {/* Seller-remaining badge — two render paths:
                    A. Exact count (≥3) — same dump-gate as before
                       (newest row for seller+collection in the feed
                       AND either 2+ visible sells OR sellerCount≥10).
                    B. 🔥 multi-sell signal — backend-determined
                       (sells10m≥2 with weak/null DAS count). Renders
                       only on the newest row to avoid repetition. */}
              {(kind === 'sell' || kind === 'sellAmm') &&
                isNewestSellForSellerColl &&
                typeof sellerCount === 'number' &&
                Number.isFinite(sellerCount) &&
                sellerCount >= 3 &&
                (sellerSellCountInFeed >= 2 || sellerCount >= 10) && (
                <span
                  key={event.id}
                  className="seller-remaining-badge"
                  title={
                    `Seller has ${sellerCount} NFTs left; ` +
                    `${sellerSellCountInFeed} recent sell${sellerSellCountInFeed === 1 ? '' : 's'} from this wallet`
                  }
                  style={SELLER_REMAINING_BADGE_STYLE}
                >
                  <span key={sellerCount} className="seller-remaining-badge-num">
                    {Math.min(99, sellerCount)}
                  </span>
                </span>
              )}
              {(kind === 'sell' || kind === 'sellAmm') &&
                isNewestSellForSellerColl &&
                event.sellerSignal === 'multi' &&
                !(typeof sellerCount === 'number' && Number.isFinite(sellerCount) && sellerCount >= 3) && (
                <span
                  key={`multi-${event.id}`}
                  className="seller-remaining-badge"
                  title={
                    `Wallet is dumping — ${event.sellerSells10m ?? 2}+ sells from this collection in the last 10 min ` +
                    `(exact remaining count unavailable)`
                  }
                  style={SELLER_REMAINING_BADGE_STYLE}
                >
                  <span className="seller-remaining-badge-num">🔥</span>
                </span>
              )}
            </div>
            <div style={FC_PARTY_ROW_STYLE}>
              <span>buyer:</span>
              <WalletLink wallet={event.buyer} />
            </div>
          </div>
        </div>

        {/* Right column */}
        <div style={FC_RIGHT_COL_STYLE}>
          {/* Top-right cluster: post-sale "X ago" counter + marketplace
              icon. Stays in its original position. Floor chip moved out
              of this row (now lives next to the BUY/SELL/AMM badge so
              the discount reads alongside the action it modifies). */}
          <div style={FC_TOP_RIGHT_CLUSTER_STYLE}>
            <TimeAgo ts={event.ts} />
            <MktIconBadge mp={event.marketplace} href={marketplaceUrl(event)} />
          </div>
          {/* price-row: fixed badge slot + min-width tabular-num price keeps
              badges vertically aligned across rows and prices anchored to a
              shared right column. tabular-nums prevents digit-width jitter
              between values like "0.40" / "0.085".
              FloorChip sits IMMEDIATELY before the BUY/SELL/AMM badge so
              the % discount/premium reads next to the action it qualifies.
              The previous `marginLeft: 14` on the badge (which simulated
              the removed "for" spacing) is dropped — the chip + 8 px gap
              now provide that visual spacing when present; when absent
              the badge sits closer to the price, which is the cleaner
              look anyway since the chip was the dominant left-side
              element in this row. */}
          <div style={FC_PRICE_ROW_STYLE}>
            {effectiveFloorDelta != null && <FloorChip delta={effectiveFloorDelta} />}
            <span style={{
              width: 56, boxSizing: 'border-box', textAlign: 'center', flexShrink: 0,
              padding: '3px 0', fontSize: 11, fontWeight: 700, borderRadius: 4,
              background: style.bg, color: style.fg, letterSpacing: '0.2px',
            }}>{style.label}</span>
            <span style={FC_PRICE_TEXT_STYLE}>
              {safePrice == null ? '—' : formatSol(safePrice)}{' '}
              <span style={FC_PRICE_SUFFIX_STYLE}>SOL</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
});

// ── Feed App ─────────────────────────────────────────────────────────────────

type FilterKey = 'all' | Side | 'buyAmm' | 'sellAmm' | 'listing';

const FILTERS: { key: FilterKey; label: string; color: string }[] = [
  { key: 'all',     label: 'All',        color: '#a890e8' },
  { key: 'buy',     label: 'Buy',        color: '#5ce0a0' },
  { key: 'sell',    label: 'Sell',       color: '#ef7878' },
  { key: 'buyAmm',  label: 'Buy AMM',    color: '#5ce0a0' },
  { key: 'sellAmm', label: 'Sell AMM',   color: '#ef7878' },
  { key: 'listing', label: 'Listings',   color: '#a890e8' },
];

/** Canonical backend `sale_type` values, derived in src/domain/sale-type.ts.
 *  Listings is intentionally absent — the backend does not yet emit listing
 *  events, so the Listings filter is wired but renders empty. */
const SALE_TYPE_BUY      = 'normal_sale'; // default buy / list buy
const SALE_TYPE_SELL     = 'bid_sell';    // sell into bid
const SALE_TYPE_BUY_AMM  = 'pool_buy';    // buy from AMM/pool
const SALE_TYPE_SELL_AMM = 'pool_sale';   // sell into AMM/pool
const SALE_TYPE_LUCKY    = 'lucky_buy';   // ME Lucky Buy raffle settlement

type SaleKind = 'buy' | 'sell' | 'buyAmm' | 'sellAmm' | 'unknown';

interface KindStyle {
  label: string;
  /** Foreground / accent color for the badge text + border tint. */
  fg: string;
  /** Translucent background tint for the badge. */
  bg: string;
  /** 'buy' tone or 'sell' tone — drives the card's left/right border color. */
  borderTone: 'buy' | 'sell' | 'neutral';
}

// Two colors only — reuse the exact card-border tones from globals.css
// (.feed-card.buy-card uses rgba(79,200,142,0.78); .feed-card.sell-card
// uses rgba(250,100,105,1)). AMM trades reuse the same side color and
// say "AMM" instead of BUY/SELL so the eye distinguishes by label, not
// by an extra hue. No yellow, no blue.
//   buy / buyAmm   → GREEN (border-green)   labels: "BUY" / "AMM"
//   sell / sellAmm → RED   (border-red)     labels: "SELL" / "AMM"
const KIND_STYLES: Record<SaleKind, KindStyle> = {
  buy:     { label: 'BUY',  fg: 'rgb(79,200,142)',  bg: 'rgba(79,200,142,0.18)',  borderTone: 'buy'  },
  sell:    { label: 'SELL', fg: 'rgb(250,100,105)', bg: 'rgba(250,100,105,0.18)', borderTone: 'sell' },
  buyAmm:  { label: 'AMM',  fg: 'rgb(79,200,142)',  bg: 'rgba(79,200,142,0.18)',  borderTone: 'buy'  },
  sellAmm: { label: 'AMM',  fg: 'rgb(250,100,105)', bg: 'rgba(250,100,105,0.18)', borderTone: 'sell' },
  unknown: { label: '—',    fg: '#8f8fa8',          bg: 'rgba(255,255,255,0.05)', borderTone: 'neutral' },
};

function saleKind(saleTypeRaw: string | null): SaleKind {
  switch (saleTypeRaw) {
    case SALE_TYPE_BUY:      return 'buy';
    case SALE_TYPE_SELL:     return 'sell';
    case SALE_TYPE_BUY_AMM:  return 'buyAmm';
    case SALE_TYPE_SELL_AMM: return 'sellAmm';
    // Lucky Buy is still a buy from the seller's perspective; the
    // 🍀 marker rendered next to the NFT name communicates the
    // raffle origin separately.
    case SALE_TYPE_LUCKY:    return 'buy';
    default:                 return 'unknown';
  }
}

/**
 * NFT-type → thin border color for the card thumbnail. Backend values:
 *   legacy / pnft        → pale yellow
 *   metaplex_core / core → pale pink
 *   cnft                 → pale purple (visibly distinct from pink)
 *   anything else        → null (no border)
 */
function getNftBorderColor(nftType: string): string | null {
  // Full-opacity colors — the inset dark ring (applied at the call site)
  // gives contrast against light NFTs, so we don't need translucency to
  // soften the colored line; full saturation keeps it readable on dark
  // NFTs and against the feed background.
  switch (nftType) {
    case 'legacy':
    case 'pnft':          return '#ffe082';  // pale yellow
    case 'metaplex_core':
    case 'core':          return '#ff9eb8';  // pale pink
    case 'cnft':          return '#ba8aff';  // pale purple — clearly cooler than pink
    default:              return null;
  }
}

export default function FeedPage() {
  // Read query directly off window.location to stay compatible with
  // Next's static prerender (useSearchParams would force a Suspense
  // boundary). Defaults to false on server, hydrates to the real value.
  const [embedded, setEmbedded] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setEmbedded(new URLSearchParams(window.location.search).get('embed') === '1');
  }, []);
  useEffect(() => { document.title = 'VictoryLabs — Live Feed'; }, []);
  const [filter, setFilter] = useState<FilterKey>('all');
  // Price-tier quick filter. Independent of `filter` (Type) — both can
  // be active at once. Only one price tier can be selected at a time;
  // clicking the active tier flips back to 'all'.
  const [priceFilter, setPriceFilter] = useState<'all' | 'p001' | 'p01'>('all');
  const [collFilter, setCollFilter] = useState<string | null>(null);
  const [collInput, setCollInput] = useState('');
  const [paused, setPaused] = useState(false);
  // Per-source data health (defaults to 'ok' before the backend's first
  // `status` frame lands so a brand-new mount doesn't show a false alert).
  const [sourceState, setSourceState] = useState<{ magiceden: 'ok' | 'stale'; tensor: 'ok' | 'stale' }>(
    { magiceden: 'ok', tensor: 'ok' },
  );
  // SSE socket-level status — distinct from `sourceState` (which reflects
  // backend-reported upstream API freshness). Surfaced via console only;
  // no UI slot exists for connection state and the existing meStale chip
  // is reserved for source health, not connection. Held in a ref instead
  // of useState so transitions don't trigger re-renders nobody reads.
  const sseStatusRef = useRef<'connecting' | 'open' | 'error'>('connecting');
  const meStale = sourceState.magiceden === 'stale';
  // Avatar-preview overlay state. One modal per page; clicking another thumb
  // just replaces the URL. Cleared on backdrop click or Escape key.
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPreview(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [preview]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Inclusive-fees toggle (bottom bar). Affects only AMM_SELL price display
  // — see `displayPrice()` in src/soloist/price-mode.ts. Persisted in
  // localStorage; updates here propagate via the 'vl:priceMode' event.
  const [inclusiveFees] = useInclusiveFees();

  // Normalized feed state: dedup + ordering + patching live inside the reducer,
  // so every SSE/REST path below just dispatches a typed action instead of
  // splicing a flat array by hand.
  const [feedState, dispatch] = useReducer(feedReducer, undefined, () => initFeedState(MAX_EVENTS));
  const events = useMemo(() => orderedEvents(feedState), [feedState]);
  // Mirror of `feedState` for the SSE listeners (which can't depend on
  // a state value without re-installing the EventSource on every tick).
  // Used by the seller_count listener to detect orphan patches.
  const feedStateRef = useRef(feedState);
  useEffect(() => { feedStateRef.current = feedState; }, [feedState]);
  // Persistent seller-remaining counts keyed by signature. Backend
  // emits `seller_count` SSE patches asynchronously after each sell-
  // type sale; without persistence the badge would vanish on every
  // page reload (the REST snapshot doesn't carry the count). Hydrated
  // once on mount and updated on every patch — the map is also used
  // to inject counts into late-arriving snapshot/live events that
  // already had their patch processed in a prior session.
  const sellerCountRef = useRef<Map<string, number>>(new Map());
  useEffect(() => { sellerCountRef.current = loadSellerCounts(); }, []);
  // Push the live event count to the persistent BottomStatusBar in
  // Gate. Window-event channel — the bar is no longer this page's
  // child, so prop drilling isn't possible. Consumer ignores stale
  // values when this page unmounts; the last dispatched count remains
  // visible until the next /feed visit refreshes it.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent<number>(EVENTS_COUNT_EVENT, { detail: events.length }));
  }, [events.length]);

  // Scrollable list element + scroll snapshot captured before list-expanding
  // dispatches. Layout effect consumes the snapshot post-commit and either
  // pins the user to the top (if they were already there) or compensates
  // scrollTop by the added height so their viewport doesn't jump. First-wins:
  // when many events are batched, only the earliest snapshot is used.
  const listRef = useRef<HTMLDivElement>(null);
  const scrollSnapshotRef = useRef<{ height: number; top: number; wasAtTop: boolean } | null>(null);

  function captureScroll() {
    if (scrollSnapshotRef.current !== null) return;
    const el = listRef.current;
    scrollSnapshotRef.current = {
      height:   el?.scrollHeight ?? 0,
      top:      el?.scrollTop    ?? 0,
      wasAtTop: !el || el.scrollTop <= AT_TOP_THRESHOLD,
    };
  }

  useLayoutEffect(() => {
    const snap = scrollSnapshotRef.current;
    if (!snap) return;
    scrollSnapshotRef.current = null;
    const el = listRef.current;
    if (!el) return;
    if (snap.wasAtTop) {
      el.scrollTop = 0;
    } else {
      const delta = el.scrollHeight - snap.height;
      if (delta !== 0) el.scrollTop = snap.top + delta;
    }
  }, [feedState]);

  // Time labels self-tick inside <TimeAgo>; no parent-level tick state needed.

  // Pause without disconnecting: while `paused` is true, incoming SSE
  // events are buffered in `pausedBuffer` instead of dispatched. On resume
  // the buffer drains in order through the reducer (dedup is a property of
  // the reducer's byId Map, so any overlap with snapshot is harmless).
  // Capped at PAUSE_BUFFER_MAX so a long pause can't blow up memory; the
  // oldest entries are dropped first.
  const pausedRef    = useRef(paused);
  const pausedBuffer = useRef<FeedAction[]>([]);
  const PAUSE_BUFFER_MAX = 500;

  // Keep the ref in sync with state. Read from the ref inside the SSE
  // handlers so the long-lived useEffect closure does not need to remount
  // when `paused` toggles — the EventSource stays connected.
  useEffect(() => { pausedRef.current = paused; }, [paused]);

  // Drain on resume. captureScroll once before the batch so a user who
  // scrolled mid-pause keeps their viewport.
  useEffect(() => {
    if (paused) return;
    const buf = pausedBuffer.current;
    if (buf.length === 0) return;
    pausedBuffer.current = [];
    captureScroll();
    for (const action of buf) dispatch(action);
  }, [paused]);

  // Snapshot on mount + live SSE. The connection is opened ONCE per mount
  // and stays open across pause toggles. Pause is implemented inside the
  // event handlers via the `pausedRef` lookup below.
  //
  // Currently subscribed: `sale` (live append), `meta` (enrichment patch),
  // `remove` (post-enrichment blacklist / cNFT floor-gate). `rawpatch`
  // exists in the reducer but is not yet wired here.
  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    // Exponential backoff with jitter on reconnect — caps the herd-thunder
    // pattern when the backend restarts (every connected tab would
    // otherwise hammer the just-rebooted backend on a 3 s grid).
    let attempt = 0;
    const scheduleReconnect = () => {
      if (cancelled || document.hidden) return;
      const base = Math.min(30_000, 1_000 * 2 ** attempt);
      const jitter = Math.random() * 1_000;
      reconnectTimer = setTimeout(connect, base + jitter);
      attempt++;
    };

    /** Buffer-or-dispatch. Read the pause flag from a ref so the effect
     *  closure does not need to reinstall on toggle. captureScroll only
     *  fires for the list-expanding 'live' action; meta/remove never grow
     *  the list. */
    const enqueue = (action: FeedAction) => {
      if (pausedRef.current) {
        const b = pausedBuffer.current;
        b.push(action);
        if (b.length > PAUSE_BUFFER_MAX) {
          // Drop oldest in one splice — keeps the buffer at the cap.
          b.splice(0, b.length - PAUSE_BUFFER_MAX);
        }
        return;
      }
      if (action.type === 'live') captureScroll();
      dispatch(action);
    };

    const connect = () => {
      if (cancelled) return;
      es?.close();
      sseStatusRef.current = 'connecting';
      es = new EventSource(`${API_BASE}/api/events/stream`);
      // Reset backoff once the connection lands so the next disconnect
      // starts from 1 s again instead of inheriting the prior cap.
      es.addEventListener('open', () => {
        attempt = 0;
        sseStatusRef.current = 'open';
        console.debug('[sse/feed] connected');
      });
      es.addEventListener('sale', (e: MessageEvent) => {
        try {
          const raw = fromBackend(JSON.parse(e.data) as BackendEvent);
          // Inject any persisted seller-remaining count we already
          // resolved in a prior session — keyed by seller+collection
          // so the same wallet+collection lights up all matching rows
          // immediately, including ones that arrive after a reload.
          const k = sellerCountKey(raw.seller, raw.collectionAddress);
          const persisted = k ? sellerCountRef.current.get(k) : undefined;
          const ev = typeof persisted === 'number'
            ? { ...raw, sellerRemainingCount: persisted }
            : raw;
          // Deep-discount alert: only fires from the LIVE SSE path
          // (never from REST snapshot / persisted hydration). Backend
          // floorDelta = (price - floor) / floor, so price <= floor*0.5
          // ↔ floorDelta <= -0.5. When backend's floorDelta is null
          // (floor not yet resolved at sale time) we recompute from the
          // local `floorBySlug` cache — same fallback FeedCard already
          // uses for the FloorChip, just lifted into the alert path so
          // bid_sells with a known cached floor don't silently miss.
          let alertDelta: number | null = typeof ev.floorDelta === 'number' ? ev.floorDelta : null;
          if (alertDelta == null && ev.meCollectionSlug) {
            const f = floorBySlugRef.current[ev.meCollectionSlug];
            const safePrice = Number.isFinite(ev.price) ? ev.price : ev.grossPrice;
            if (typeof f === 'number' && f > 0 && Number.isFinite(safePrice) && safePrice > 0) {
              alertDelta = (safePrice - f) / f;
            }
          }
          if (alertDelta != null && alertDelta <= -0.5) {
            playDeepDiscountAlert(ev.signature);
          }
          enqueue({ type: 'live', event: ev });
        } catch { /* malformed frame — skip */ }
      });
      // Enrichment patches: fill in nftName / collectionName / meCollectionSlug
      // for events previously rendered as "Unknown #?". Matches by signature
      // and by mintAddress (same mint in multiple sales benefits from one fetch).
      es.addEventListener('meta', (e: MessageEvent) => {
        try {
          const patch = JSON.parse(e.data) as MetaPatch;
          enqueue({ type: 'meta', patch });
        } catch { /* malformed frame — skip */ }
      });
      // Backend fires `remove` for rows deleted after enrichment (blacklisted
      // collections, late cNFT floor-gate). Without this listener the card
      // painted from the earlier `sale` frame would linger forever because
      // `collectionName` is null at sale time and never gets patched (no
      // `meta` frame is emitted for blacklisted rows).
      es.addEventListener('seller_count', (e: MessageEvent) => {
        try {
          const { signature, seller, collection, count, sells10m, signal } = JSON.parse(e.data) as {
            signature?: string;
            seller:     string;
            collection: string;
            count:      number | null;
            sells10m?:  number;
            signal?:    'multi';
          };
          console.log(
            `[seller-count-ui] signature=${signature ?? '—'} ` +
            `seller=${seller} collection=${collection} count=${count ?? 'null'} ` +
            `sells10m=${sells10m ?? '—'} signal=${signal ?? '—'}`,
          );
          if (!seller || !collection) {
            console.log('[seller-count-ui-miss] reason=invalid_payload');
            return;
          }
          // Persist by seller+collection so reloads / future rows from
          // the same wallet+collection can re-attach the count. We
          // only store finite counts; the 🔥 multi-sell signal is
          // ephemeral (re-derived by backend on next sale) so it
          // doesn't survive reload — which is fine, it's a real-time
          // dumping indicator, not historical state.
          if (typeof count === 'number' && Number.isFinite(count)) {
            const k = sellerCountKey(seller, collection)!;
            sellerCountRef.current.set(k, count);
            persistSellerCounts(sellerCountRef.current);
          }
          // UNSAMPLED orphan check — counts how many feed rows the
          // patch will actually update. 0 means the sale frame either
          // hasn't arrived yet OR the row was evicted (MAX_EVENTS cap).
          // Persistence still keeps the value for any future matching
          // arrival, but a chronic stream of zero-match patches points
          // at a key-mismatch upstream.
          let matches = 0;
          for (const ev of feedStateRef.current.byId.values()) {
            if ((signature && ev.signature === signature) ||
                (ev.seller === seller && ev.collectionAddress === collection)) matches++;
          }
          if (matches === 0) {
            console.log(
              `[seller-count-ui-miss] reason=no_matching_row signature=${signature ?? '—'} ` +
              `seller=${seller} collection=${collection}`,
            );
          }
          enqueue({
            type: 'seller_count',
            patch: { signature, seller, collection, count: count ?? null, sells10m, signal },
          });
        } catch { /* malformed frame — skip */ }
      });
      es.addEventListener('remove', (e: MessageEvent) => {
        try {
          const { signature } = JSON.parse(e.data) as { signature: string };
          if (signature) enqueue({ type: 'remove', signature });
        } catch { /* malformed frame — skip */ }
      });
      // Per-source health: backend emits one `status` frame on connect for
      // each known source plus a fresh frame on every state flip. Bypass
      // the pause buffer — operator status info should always be live.
      es.addEventListener('status', (e: MessageEvent) => {
        try {
          const { source, state } = JSON.parse(e.data) as {
            source: 'magiceden' | 'tensor';
            state:  'ok' | 'stale';
          };
          setSourceState(prev => ({ ...prev, [source]: state }));
        } catch { /* malformed frame — skip */ }
      });
      es.addEventListener('error', () => {
        sseStatusRef.current = 'error';
        console.warn('[sse/feed] connection error — scheduling reconnect');
        es?.close();
        scheduleReconnect();
      });
    };

    // Pull latest snapshot (newest-first) and dispatch as a single `snapshot`
    // action — the reducer handles dedup against any live events that might
    // have already arrived for the same signatures. The snapshot is mount-
    // time only and bypasses the pause buffer.
    fetch(`${API_BASE}/api/events/latest?limit=${SNAPSHOT_LIMIT}`)
      .then(r => r.json())
      .then((data: LatestApiResponse) => {
        if (cancelled) return;
        const events: FeedEvent[] = data.events.map(r => {
          const ev = fromBackend(fromRow(r));
          // REST snapshot doesn't carry sellerRemainingCount — re-attach
          // any value we resolved in a prior session, keyed by
          // seller+collection so the badge survives reloads.
          const k = sellerCountKey(ev.seller, ev.collectionAddress);
          const persisted = k ? sellerCountRef.current.get(k) : undefined;
          return typeof persisted === 'number'
            ? { ...ev, sellerRemainingCount: persisted }
            : ev;
        });
        captureScroll();
        dispatch({ type: 'snapshot', events });
      })
      .catch(() => { /* snapshot failed — live stream still attempts to connect */ })
      .finally(() => { if (!cancelled) connect(); });

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
      // Drop any buffered actions on unmount — they belong to the closed
      // EventSource session and will be replaced by a fresh snapshot the
      // next time this page mounts.
      pausedBuffer.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Collection-floor lookup ─────────────────────────────────────────────
  // Dual-purpose cache populated from /api/collections/bids:
  //   1. cNFT dust filter — hide cNFT collections whose CURRENT FLOOR is
  //      below 0.002 SOL via the shared `isCnftDust` predicate (Dashboard
  //      uses the same predicate so the two surfaces stay in lockstep).
  //   2. % floor fallback — when the backend didn't compute `floorDelta`
  //      for an event but its slug landed in this cache, FeedCard derives
  //      the chip locally from price/floor.
  // Floor is fetched once per newly-seen slug, batched with a small
  // debounce so bursts don't turn into 1-per-event calls. Backend caches
  // per slug for 60 s, frontend bounds with a 500-entry cap and a 5-min
  // per-slug request TTL.
  const [floorBySlug, setFloorBySlug] = useState<Record<string, number | null>>({});
  // Mirror of `floorBySlug` for the SSE listeners — they install once
  // (deps `[]`) and would otherwise capture an empty initial map.
  // Used by the deep-discount alert path so a sale whose backend
  // `floorDelta` is null can still trip the alert when we have a
  // cached floor for the slug.
  const floorBySlugRef = useRef(floorBySlug);
  useEffect(() => { floorBySlugRef.current = floorBySlug; }, [floorBySlug]);
  // Slug → timestamp of last request. After FLOOR_REQUEST_TTL_MS the slug is
  // eligible for a refresh so a long-running tab doesn't keep stale floors.
  const requestedFloorRef = useRef<Map<string, number>>(new Map());
  const pendingFloorRef   = useRef<Set<string>>(new Set());
  const floorFetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Keep the cNFT floor map bounded — avoids unbounded growth across long
   *  sessions without changing filter behavior. Insertion-order eviction. */
  const FLOOR_BY_SLUG_MAX = 500;
  /** How long a fetched floor is considered fresh enough to skip a refresh. */
  const FLOOR_REQUEST_TTL_MS = 5 * 60_000;

  useEffect(() => {
    const now = Date.now();
    for (const e of events) {
      if (!e.meCollectionSlug) continue;
      const last = requestedFloorRef.current.get(e.meCollectionSlug);
      if (last != null && now - last < FLOOR_REQUEST_TTL_MS) continue;
      pendingFloorRef.current.add(e.meCollectionSlug);
    }
    if (pendingFloorRef.current.size === 0 || floorFetchTimerRef.current) return;
    floorFetchTimerRef.current = setTimeout(async () => {
      floorFetchTimerRef.current = null;
      const batch = Array.from(pendingFloorRef.current).slice(0, 80);
      pendingFloorRef.current.clear();
      const fetchedAt = Date.now();
      for (const s of batch) requestedFloorRef.current.set(s, fetchedAt);
      try {
        const res = await fetch(
          `${API_BASE}/api/collections/bids?slugs=${encodeURIComponent(batch.join(','))}`,
        );
        if (!res.ok) return;
        const data = await res.json() as {
          bids?: Record<string, { floorLamports: number | null }>;
        };
        if (!data.bids) return;
        setFloorBySlug(prev => {
          const next = { ...prev };
          for (const [slug, v] of Object.entries(data.bids!)) {
            next[slug] = typeof v.floorLamports === 'number' ? v.floorLamports / 1e9 : null;
          }
          // Bound the map. Object iteration is insertion-order in modern
          // engines; drop the oldest keys until under the cap. Cheap because
          // it only runs when we've genuinely overflowed.
          const keys = Object.keys(next);
          if (keys.length > FLOOR_BY_SLUG_MAX) {
            const drop = keys.length - FLOOR_BY_SLUG_MAX;
            for (let i = 0; i < drop; i++) delete next[keys[i]];
          }
          return next;
        });
      } catch { /* transient — retry path is the next unseen cNFT slug */ }
    }, 500);
  }, [events]);
  useEffect(() => () => {
    if (floorFetchTimerRef.current) clearTimeout(floorFetchTimerRef.current);
  }, []);

  const filtered = useMemo(() => events.filter(e => {
    // Collection-floor gate for cNFTs (replaces the old sale-price guard):
    // shared predicate — see `@/soloist/cnft-filter`.
    if (isCnftDust(e, s => floorBySlug[s])) return false;
    // Defensive blacklist — backend deletes blacklisted rows after enrichment,
    // but if a card was already painted via the immediate `sale` SSE frame we
    // also drop it here once enrichment / meta fills in the collection name.
    // Lowercase comparison matches NAME_BLACKLIST in src/db/blacklist.ts.
    if (e.collectionName && FEED_NAME_BLACKLIST.has(e.collectionName.toLowerCase())) return false;
    if (e.meCollectionSlug && FEED_SLUG_BLACKLIST.has(e.meCollectionSlug)) return false;
    if (collFilter) {
      const target = collFilter.toLowerCase();
      const slug = e.meCollectionSlug?.toLowerCase() ?? '';
      const name = e.collectionName?.toLowerCase() ?? '';
      if (slug !== target && name !== target) return false;
    }
    // Price-tier gate (independent of Type). When active, drop events
    // whose price is missing/invalid OR below the threshold. Display
    // `price` is the seller-net-preferred figure already in SOL; fall
    // back to gross when the display value isn't finite (paranoia —
    // shouldn't happen for normal sales).
    if (priceFilter !== 'all') {
      const candidate = Number.isFinite(e.price) ? e.price : e.grossPrice;
      if (!Number.isFinite(candidate) || candidate <= 0) return false;
      if (priceFilter === 'p001' && candidate < 0.01) return false;
      if (priceFilter === 'p01'  && candidate < 0.1)  return false;
    }
    const t = e.saleTypeRaw;
    if (filter === 'buy')     return t === SALE_TYPE_BUY;
    if (filter === 'sell')    return t === SALE_TYPE_SELL;
    if (filter === 'buyAmm')  return t === SALE_TYPE_BUY_AMM;
    if (filter === 'sellAmm') return t === SALE_TYPE_SELL_AMM;
    if (filter === 'listing') return false; // backend does not emit listings in v1
    return true;
  }), [events, filter, priceFilter, collFilter, floorBySlug]);

  // Per seller+collection sell-side aggregator over the visible feed.
  // Drives the noise-cut on the seller-remaining badge: only the most
  // recent row in each (seller, collection) bucket carries the badge,
  // and only when there's either real activity (2+ visible sells) or
  // the remaining count itself crosses the higher 10-NFT threshold.
  // Computed on `filtered` so price/type/collection filters narrow the
  // window the same way the rendered list does.
  interface SellerDumpInfo { count: number; newestId: string; newestTs: number; }
  const sellerDumpMap = useMemo(() => {
    const m = new Map<string, SellerDumpInfo>();
    for (const ev of filtered) {
      const t = ev.saleTypeRaw;
      const isSell = t === SALE_TYPE_SELL || t === SALE_TYPE_SELL_AMM;
      if (!isSell) continue;
      if (!ev.seller || !ev.collectionAddress) continue;
      const k = `${ev.seller}-${ev.collectionAddress}`;
      const prev = m.get(k);
      if (!prev) {
        m.set(k, { count: 1, newestId: ev.id, newestTs: ev.ts });
      } else {
        prev.count += 1;
        if (ev.ts > prev.newestTs) {
          prev.newestId = ev.id;
          prev.newestTs = ev.ts;
        }
      }
    }
    return m;
  }, [filtered]);

  // Page-level wheel forwarding: when the user scrolls anywhere on the
  // page (including the empty "black" margins outside the centered 640 px
  // column), forward the wheel delta to the feed list. Skipped when the
  // event already targets an element inside `listRef` so the native scroll
  // chain isn't double-stepped, and skipped when the target is a
  // genuinely-scrollable inner element (search dropdown, etc.) so we
  // don't hijack their natural scroll.
  const handleRootWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const list = listRef.current;
    if (!list) return;
    const target = e.target as Node | null;
    if (target && list.contains(target)) return;            // native chain handles it
    if (e.deltaY === 0) return;
    list.scrollTop += e.deltaY;
  };

  return (
    <div className="feed-root page-transition" data-embedded={embedded ? '1' : undefined} onWheel={handleRootWheel}>
      {!embedded && <TopNav active="feed" />}

      {/* Centered column stage */}
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center', minHeight: 0, padding: '0 0 10px' }}>
        <div style={{ width: '100%', maxWidth: embedded ? 'none' : 'var(--feed-column-max, 640px)', display: 'flex', flexDirection: 'column', minHeight: 0, transition: 'max-width 0.28s ease' }}>

          {/* Promoted feed card. In embed mode (multi-tab pane) the
              top margin is dropped so the embedded card top aligns
              flush with the embedded /dashboard table card top. */}
          <div style={{
            flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden',
            background: 'linear-gradient(180deg, #201a3a 0%, #1a1530 100%)',
            border: '1px solid rgba(168,144,232,0.65)',
            borderRadius: 12,
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4), 0 0 28px rgba(128,104,216,0.15)',
            margin: embedded ? 0 : '14px 0 3px',
            minHeight: 0,
          }}>

            {/* Card header */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 14px', flexShrink: 0,
              borderBottom: '1px solid rgba(168,144,232,0.12)',
              background: 'rgba(168,144,232,0.04)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <h1 style={{ fontSize: 15, fontWeight: 700, color: '#f0eef8', letterSpacing: '-0.2px' }}>Live events</h1>
                <LiveDot />
                <span style={{ fontSize: 11, fontWeight: 600, color: '#8068d8', marginLeft: 4 }}>
                  ({filtered.length.toLocaleString()})
                </span>
                {/* Source-health indicator. Green = both sources fresh.
                    Red = Magic Eden stale (most common: ME API stalls
                    while Tensor keeps producing events). */}
                <span
                  title={meStale
                    ? 'Magic Eden API appears stale — no events received recently. Tensor data still flowing.'
                    : 'All data sources flowing normally.'}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    marginLeft: 4, padding: '2px 6px', borderRadius: 4,
                    fontSize: 10, fontWeight: 700, letterSpacing: '0.3px',
                    border: meStale ? '1px solid #ef787866' : '1px solid rgba(92,224,160,0.4)',
                    background: meStale ? 'rgba(239,120,120,0.14)' : 'rgba(92,224,160,0.10)',
                    color: meStale ? '#ef7878' : '#5ce0a0',
                    cursor: 'help',
                  }}
                >
                  <span style={{
                    display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
                    background: meStale ? '#ef7878' : '#5ce0a0',
                    boxShadow: meStale ? '0 0 6px #ef787880' : '0 0 6px #5ce0a080',
                  }} />
                  ME {meStale ? 'STALE' : 'OK'}
                </span>
                {(filter !== 'all' || collFilter) && (
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    marginLeft: 6, padding: '2px 8px', fontSize: 10, fontWeight: 600,
                    borderRadius: 4, letterSpacing: '0.2px',
                    border: '1px solid rgba(168,144,232,0.28)',
                    background: 'rgba(168,144,232,0.08)',
                    color: '#a890e8',
                  }}>
                    {filter !== 'all' && (FILTERS.find(f => f.key === filter)?.label ?? filter)}
                    {filter !== 'all' && collFilter && (
                      <span style={{ color: '#56566e' }}>•</span>
                    )}
                    {collFilter && (
                      <span style={{
                        fontFamily: "'SF Mono','Fira Code',monospace",
                        maxWidth: 200, overflow: 'hidden',
                        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>{collFilter}</span>
                    )}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Pill
                  active={filtersOpen}
                  onClick={() => setFiltersOpen(o => !o)}
                  title="Filters"
                  icon={<span style={{ fontSize: 11, lineHeight: 1 }}>⚙</span>}
                  label="Filters"
                />
                <Pill
                  active
                  color={paused ? '#c9a820' : '#5ce0a0'}
                  onClick={() => setPaused(p => !p)}
                  label={paused ? '▶ Resume' : '⏸ Pause'}
                />
              </div>
            </div>

            {/* Feed surface */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
              {filtersOpen && (
                <div style={{ padding: '10px 4px 12px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 10, color: '#56566e', marginRight: 2 }}>Type:</span>
                    {FILTERS.map(f => {
                      const isActive = filter === f.key;
                      return (
                        <Pill
                          key={f.key}
                          active={isActive}
                          color={f.color}
                          onClick={() => setFilter(f.key)}
                          label={f.label}
                          size="sm"
                          // Stronger highlight on the active filter — bumped
                          // background opacity, full-color border, subtle glow
                          // — so the current selection reads at a glance.
                          style={isActive ? {
                            background:  `${f.color}38`,
                            border:      `1px solid ${f.color}`,
                            boxShadow:   `0 0 0 1px ${f.color}33, 0 0 8px ${f.color}40`,
                            fontWeight:  700,
                          } : undefined}
                        />
                      );
                    })}
                  </div>
                  <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 10, color: '#56566e', marginRight: 2 }}>Price:</span>
                    {([
                      { key: 'p001', label: '0.01+' },
                      { key: 'p01',  label: '0.1+'  },
                    ] as const).map(p => {
                      const isActive = priceFilter === p.key;
                      const color = '#a890e8';
                      return (
                        <Pill
                          key={p.key}
                          active={isActive}
                          color={color}
                          onClick={() => setPriceFilter(prev => prev === p.key ? 'all' : p.key)}
                          label={p.label}
                          size="sm"
                          style={isActive ? {
                            background:  `${color}38`,
                            border:      `1px solid ${color}`,
                            boxShadow:   `0 0 0 1px ${color}33, 0 0 8px ${color}40`,
                            fontWeight:  700,
                          } : undefined}
                        />
                      );
                    })}
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 10, color: '#56566e', marginRight: 2 }}>Collection:</span>
                    <input
                      value={collInput}
                      onChange={(e) => setCollInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          const v = collInput.trim();
                          if (v) { setCollFilter(v); setCollInput(''); }
                        }
                      }}
                      placeholder="collection slug…"
                      spellCheck={false}
                      autoComplete="off"
                      style={{
                        padding: '3px 8px', fontSize: 10.5, borderRadius: 4,
                        border: '1px solid rgba(255,255,255,0.08)',
                        background: 'rgba(255,255,255,0.03)',
                        color: '#e8e6f2', outline: 'none',
                        minWidth: 180, fontFamily: "'SF Mono','Fira Code',monospace",
                        letterSpacing: '0.2px',
                      }}
                    />
                    <Pill
                      active
                      color="#a890e8"
                      onClick={() => {
                        const v = collInput.trim();
                        if (v) { setCollFilter(v); setCollInput(''); }
                      }}
                      label="Add"
                      size="sm"
                    />
                    {collFilter && (
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        padding: '2px 4px 2px 8px', fontSize: 10.5, fontWeight: 600,
                        borderRadius: 4, letterSpacing: '0.2px',
                        border: '1px solid #a890e866',
                        background: '#a890e822',
                        color: '#a890e8',
                        fontFamily: "'SF Mono','Fira Code',monospace",
                        maxWidth: 240, overflow: 'hidden',
                      }}>
                        <span style={{
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>{collFilter}</span>
                        <button
                          type="button"
                          onClick={() => setCollFilter(null)}
                          title="Clear collection filter"
                          style={{
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            width: 14, height: 14, padding: 0, borderRadius: 3,
                            border: 'none', background: 'transparent',
                            color: '#a890e8', cursor: 'pointer', fontSize: 11, lineHeight: 1,
                          }}
                        >✕</button>
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Feed list */}
              <div ref={listRef} className="feed-list" style={{ flex: 1, overflowY: 'auto', padding: '6px 10px 10px 13px' }}>
                {filtered.length === 0 && (
                  meStale ? (
                    <div style={{
                      textAlign: 'center', padding: '40px 16px', fontSize: 13,
                      color: '#ef7878',
                      border: '1px solid rgba(239,120,120,0.28)',
                      background: 'rgba(239,120,120,0.06)',
                      borderRadius: 8, margin: '24px 8px',
                    }}>
                      <div style={{ fontWeight: 700, marginBottom: 4, letterSpacing: '0.3px' }}>
                        ⚠ Magic Eden data is stale
                      </div>
                      <div style={{ fontSize: 11.5, color: '#c98787', fontWeight: 500 }}>
                        No events received from Magic Eden recently. Tensor data still flowing.
                      </div>
                    </div>
                  ) : (
                    <div style={{ textAlign: 'center', color: '#55556e', padding: '48px 0', fontSize: 13 }}>
                      No events match current filters
                    </div>
                  )
                )}
                {filtered.map(e => {
                  // Per-card slug-floor lookup. `floorBySlug` is keyed
                  // by ME slug; cards without a slug or without a
                  // cached floor pass `null` and fall back to backend
                  // floorDelta only inside the card.
                  const slugFloor = e.meCollectionSlug ? floorBySlug[e.meCollectionSlug] ?? null : null;
                  const dk = e.seller && e.collectionAddress ? `${e.seller}-${e.collectionAddress}` : null;
                  const dump = dk ? sellerDumpMap.get(dk) : undefined;
                  const sellerSellCountInFeed = dump?.count ?? 0;
                  const isNewestSellForSellerColl = !!dump && dump.newestId === e.id;
                  return (
                    <FeedCard
                      key={e.id}
                      event={e}
                      onPreview={setPreview}
                      inclusiveFees={inclusiveFees}
                      slugFloor={slugFloor}
                      sellerSellCountInFeed={sellerSellCountInFeed}
                      isNewestSellForSellerColl={isNewestSellForSellerColl}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom status — shared component. Hidden in embed mode (multi-tab)
          so the parent page can own the chrome; the full-bleed `100vw`
          would otherwise escape its grid cell. */}

      {/* Avatar preview — single overlay shared by every FeedCard. Backdrop
       *  click and Escape close it. The <img> stops propagation so clicks on
       *  the picture itself don't dismiss. Reuses the already-fetched wsrv
       *  URL from `compressImage`, so no extra network request. */}
      {preview && (
        <div
          onClick={() => setPreview(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(0,0,0,0.75)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'zoom-out',
          }}
          role="dialog"
          aria-label="Preview"
        >
          <img
            src={preview}
            alt=""
            loading="lazy"
            decoding="async"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 200, height: 200, objectFit: 'contain',
              borderRadius: 8, background: '#0e0b22',
              boxShadow: '0 16px 40px rgba(0,0,0,0.6)',
              cursor: 'default',
            }}
          />
        </div>
      )}
    </div>
  );
}
