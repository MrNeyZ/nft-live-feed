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
import { ItemThumb, LiveDot, MktIconBadge, Pill, compressImage, EVENTS_COUNT_EVENT, SETTINGS_PILL_INACTIVE, settingsPillActive, SettingsToggle } from '@/soloist/shared';
import { displayPrice, useInclusiveFees } from '@/soloist/price-mode';
import {
  feedReducer, initFeedState, orderedEvents,
  type MetaPatch, type FeedAction,
} from '@/soloist/feed-store';
import { isCnftDust } from '@/soloist/cnft-filter';
import { playDeepDiscountAlert } from '@/soloist/use-ui-sound';
import type {
  Density, FilterKey, SaleKind, KindStyle, FeedCardProps,
} from './lib/types';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';
const MAX_EVENTS = 200;
const SNAPSHOT_LIMIT = 100;

// Visible-row cap on the rendered FeedCard list. MAX_EVENTS bounds the
// in-memory ring buffer that the reducer maintains; this constant bounds
// how many of those events actually mount as DOM nodes after filtering.
// During a sustained burst (mint storm, AMM repricing flood) the buffer
// can be 200 events that all pass the active filter, which means 200
// memo'd FeedCards in the DOM — each card paints a thumbnail, time-ago
// chip, FloorChip, and several flex rows. Capping render to 150 keeps
// the layout/paint budget bounded without changing the underlying data
// model: the trimmed rows are still in `events` / `filtered` / the
// seller-dump aggregate, just not in the DOM. Scrollback impact is
// limited to the most-burst-y periods; quiet operation (filtered.length
// < cap) is byte-identical to before.
const MAX_RENDERED_ROWS = 150;

import { formatFeedPrice, sellerCountKey, safeFiniteNumber } from './lib/format';

// ── Persisted seller-remaining counts ──────────────────────────────────────
// Helpers (load / persist / debounced flush) live in lib/seller-count-storage.
// The pagehide/beforeunload listener is registered here at module load so the
// page lifecycle owns the side-effect; the helpers themselves remain pure
// re: the page state.
import {
  loadSellerCounts, flushSellerCountsNow, schedulePersistSellerCounts,
} from './lib/seller-count-storage';
if (typeof window !== 'undefined') {
  // Best-effort flush on tab close. `pagehide` is the more reliable
  // mobile-safe sibling of `beforeunload`; both fire synchronously and
  // localStorage.setItem is allowed in either.
  window.addEventListener('pagehide',     flushSellerCountsNow);
  window.addEventListener('beforeunload', flushSellerCountsNow);
}
/** Scroll tolerance (px) for treating the user as "at top". */
const AT_TOP_THRESHOLD = 4;
/** Lowercased collection-name blacklist; mirrors src/db/blacklist.ts NAME_BLACKLIST. */
const FEED_NAME_BLACKLIST = new Set<string>([
  'collector crypt',
  // staratlascrew leak guard — when ME's /v2/tokens/:mint times out, the
  // backend's enrichment ships meta with meCollectionSlug=null, so the
  // FEED_SLUG_BLACKLIST gate below short-circuits. DAS still surfaces the
  // collection name reliably (verified live: "STAR ATLAS CREW"), so this
  // name-level fallback closes the bypass.
  'star atlas crew',
]);
/** Frontend-only slug blacklist — hide specific collections from the Live
 *  Feed without touching ingestion. Collection page for these slugs still
 *  renders normally if visited directly. */
const FEED_SLUG_BLACKLIST = new Set<string>([
  'staratlascrew',
]);
/** Frontend mirror of src/db/blacklist.ts NAME_SUBSTRING_BLACKLIST. Each
 *  needle is checked against BOTH `collectionName` and `meCollectionSlug`
 *  (lowercased) so collections like `paulcharlesart_drip` whose human
 *  name doesn't contain "drip" are still hidden. Lowercase + .includes
 *  only — no regex. */
const FEED_NAME_SUBSTRING_BLACKLIST: readonly string[] = ['drip'];

// ── Shared 1 s tick (powers all TimeAgo leaves) ──────────────────────────────
// Pub-sub + lazy interval lives in lib/shared-now. Page just consumes
// the hook below.
import { useSharedNow } from './lib/shared-now';

// ── Time-ago leaf ────────────────────────────────────────────────────────────
// Reads from the shared ticker above. 1 s cadence gives smooth seconds in the
// 5–15 s pink window (per UX spec). React.memo on FeedCard remains
// invalidation-safe because TimeAgo is the only thing that rerenders per
// tick — its parent's props don't change.
//
// Color tiers (per spec):
//   1–5 s:        pink + "just now"
//   6–15 s:       pink + "Xs ago"        (still in the "hot" window)
//   16 s – 3 min: yellow                 (recent but cooling)
//   > 3 min:      muted                  (background/historical)
function TimeAgo({ ts }: { ts: number }) {
  const now = useSharedNow();
  // Defensive: invalid timestamp renders an em-dash so a malformed /
  // missing blockTime can't surface as "NaNd ago". Future-leaning and
  // negative ages already collapse into the `ageMs < 5000` branch
  // below ("just now") since `<` evaluates true for any negative.
  if (!Number.isFinite(ts)) {
    return <span style={{ fontSize: 11, color: '#9d8aac', fontWeight: 500 }}>—</span>;
  }
  // SSR-safe: getTickServerSnapshot returns 0; first client paint
  // will reconcile to a real `now` on the next tick (≤1 s). Falling back
  // to Date.now() here would re-introduce a hydration mismatch on cards
  // older than the static-render boundary.
  const liveNow = now > 0 ? now : ts; // age=0 ("just now") on the SSR pass
  const ageMs = liveNow - ts;
  let color: string;
  let weight: 500 | 600 = 500;
  if (ageMs < 15000) {
    color  = '#e87ab0'; // pink — covers both "just now" (<5s) and 6-15s
    weight = 600;
  } else if (ageMs < 180000) {
    color  = '#c7b479'; // yellow — 16s to 3min
  } else {
    // Stale tier — bumped #a094c0 → #b6a8d0 (text-clarity pass).
    // Fresh pink + yellow tiers stay loud; this lifts the quiet
    // floor so old timestamps still scan instead of dissolving.
    color  = '#b6a8d0';
  }
  const text = ageMs < 5000 ? 'just now' : timeAgo(ts);
  // tabular-nums locks digit width so the right-edge timestamp lane
  // doesn't jitter as the count climbs ("9 min ago" → "10 min ago"
  // shifted ~3 px before; with tabular-nums the alpha-numeric mix
  // stays anchored). letterSpacing 0.1 px gives a subtle "tape"
  // feel without dropping the proportional font.
  return (
    <span style={{
      fontSize: 11, color, fontWeight: weight,
      fontVariantNumeric: 'tabular-nums',
      letterSpacing: '0.1px',
    }}>
      {text}
    </span>
  );
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
    return <span style={{ color: '#9494b0', fontWeight: 500, fontFamily: "'SF Mono','Fira Code',monospace" }}>N/A</span>;
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
        
        style={ME_ICON_LINK_STYLE}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/me.png" alt="ME" width={11} height={11} draggable={false} style={{ display: 'block', borderRadius: 2 }} />
      </a>
    </span>
  );
}

const WALLET_LINK_STYLE: React.CSSProperties = {
  // Wallet text sits one tier above the seller:/buyer: label and
  // one tier below the title. Text-clarity pass lifted #7e7e9c →
  // #9b9bbe so short wallet addresses stop reading as low-contrast
  // mush against the bumped card bg. Still clearly below the title
  // (#f0eef8) — same hierarchy, just a higher readability floor.
  color: '#9b9bbe', fontWeight: 500,
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
  // Lowered from 0.85 → 0.65 so the marketplace icons recede behind
  // the wallet text. They still read at a glance (the icons are
  // distinctive shapes, not text), but they no longer dominate the
  // metadata row.
  opacity: 0.65,
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
      
      style={{
        // Trimmed one tier: smaller font, lower border alpha, no bg
        // tint when not "bright" — the chip is a secondary qualifier
        // for the price, not a peer of the BUY/SELL badge, so it
        // shouldn't compete for attention. ~14 % smaller pill area.
        fontSize: 9.5, fontWeight: bright ? 700 : 600,
        color: fg, background: bg, border: `1px solid ${bd}`,
        padding: '0 4px', borderRadius: 3, letterSpacing: '0.2px',
        lineHeight: 1.25, fontFamily: "'SF Mono','Fira Code',monospace",
        fontVariantNumeric: 'tabular-nums',
        opacity: bright ? 1 : 0.85,
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

/** Density modes for the live feed surface — drives card padding,
 *  row-wrap spacing, and thumb size. Stored in localStorage as
 *  `vl.feed.density`; default is COMPACT (the current polished
 *  baseline). COMFY adds a notch of breathing room; TAPE shrinks
 *  the thumb (56 → 40) and tightens padding for an ultra-dense
 *  trading-tape look. CSS rules under `.feed-density-{comfy,
 *  compact,tape}` carry the layout deltas (globals.css). */
const DENSITIES: ReadonlyArray<Density> = ['comfy', 'compact', 'tape'];
const DENSITY_LS_KEY = 'vl.feed.density';
function isDensity(v: unknown): v is Density {
  return v === 'comfy' || v === 'compact' || v === 'tape';
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
  // Vertical paddings dropped from 1 → 0 so the title and the
  // seller/buyer rows sit a hair tighter. The thumb is 56 px tall
  // and drives card height; trimming this padding doesn't shrink
  // the card but lets the inner content breathe more cleanly
  // against the new tighter card padding (8 px vs the prior 10).
  flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column',
  justifyContent: 'space-between', paddingTop: 0, paddingBottom: 0,
};
const FC_NAME_ROW_STYLE: React.CSSProperties = {
  display: 'flex', alignItems: 'baseline', gap: 8, overflow: 'hidden',
};
// NFT title — bumped 14 → 15 px and letterSpacing nudged -0.2 → -0.3
// in the visual-polish pass: the title now reads one tier above the
// seller/buyer wallet text (color/weight unchanged) so the card has a
// clearer three-tier hierarchy (title → wallet → label). Bigger
// negative tracking compensates for the tighter optical density of a
// 15 px sans without changing line-height (the row still fits inside
// the same 56 px thumb-driven card height).
const FC_NAME_LINK_STYLE: React.CSSProperties = {
  fontSize: 15, fontWeight: 700, color: '#f0eef8', letterSpacing: '-0.3px',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  textDecoration: 'none', cursor: 'pointer',
};
const FC_NAME_SPAN_STYLE: React.CSSProperties = {
  fontSize: 15, fontWeight: 700, color: '#f0eef8', letterSpacing: '-0.3px',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const FC_NAME_NUM_STYLE: React.CSSProperties = { color: '#e8e6f2' };
const FC_PARTIES_COL_STYLE: React.CSSProperties = {
  // Tighten the seller/buyer stack — gap dropped from 1 → 0 (rows
  // are already 14 px tall via lineHeight) and marginTop trimmed
  // from 3 → 2 so the two lines sit immediately under the title
  // as a single identity block, not three separate lanes.
  display: 'flex', flexDirection: 'column', gap: 0, marginTop: 2,
};
const FC_PARTY_ROW_STYLE: React.CSSProperties = {
  // Text-clarity pass: label tone lifted #45455e → #5a5a78 so
  // `seller:` / `buyer:` is legible at idle. Wallet text is still
  // brighter (#9b9bbe), so the three-tier title → wallet → label
  // hierarchy is preserved — labels just stop dissolving into bg.
  fontSize: 10.5, color: '#5a5a78', display: 'flex', alignItems: 'center', gap: 6,
};
const FC_RIGHT_COL_STYLE: React.CSSProperties = {
  // Right-col gap tightened from 6 → 4 to match the new compact
  // card rhythm. paddingTop dropped to 0 (was 1) so the timestamp
  // cluster sits flush with the title baseline on the left.
  display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
  alignItems: 'flex-end', gap: 4, flexShrink: 0, paddingTop: 0,
};
const FC_TOP_RIGHT_CLUSTER_STYLE: React.CSSProperties = {
  // Anchor the top-right "X ago + ME icon" cluster to a fixed
  // minWidth so timestamps line up across rows like a trading
  // tape's right-edge action lane, instead of jittering with
  // text width ("just now" vs "12 min ago"). 92 px holds the
  // longest "X min ago" string + icon comfortably; right-justify
  // pins them flush to the card edge.
  display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
  gap: 5, minWidth: 92,
};
const FC_PRICE_ROW_STYLE: React.CSSProperties = {
  // Tighten the action lane: badge + price now sit 6 px apart (was
  // 8) so they read as a single trading-action group rather than
  // two separate widgets. The FloorChip (when present) keeps its
  // gap before the badge — visual order: chip · badge · price.
  display: 'flex', alignItems: 'center', gap: 6,
};
const FC_PRICE_TEXT_STYLE: React.CSSProperties = {
  // Bumped to pure white (was #f0eef8) so the price has the highest
  // luminance on the card — beats the BUY/SELL badge and the title
  // for primary attention, matching trader-terminal hierarchy
  // (price first, then action, then identity).
  minWidth: 80, textAlign: 'right',
  fontSize: 16, fontWeight: 800, color: '#ffffff', letterSpacing: '-0.3px',
  fontFamily: "'SF Mono','Fira Code',monospace",
  fontVariantNumeric: 'tabular-nums',
};
const FC_PRICE_SUFFIX_STYLE: React.CSSProperties = {
  // SOL unit suffix — text-clarity pass lifted #6a6a82 → #8585a0
  // and opacity 0.7 → 0.85 so the unit reads clearly at scroll
  // speed without crowding the digits (still well below pure-white
  // price text). Digits remain dominant, suffix is now legible.
  color: '#8585a0', fontWeight: 600, fontSize: 10.5, opacity: 0.85,
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

// Module-scoped set of event IDs already rendered in this browser tab
// during this session. Cached rows hydrated from the REST snapshot, or
// re-mounted after a route change, will be found in this set and skip
// the .feed-row-wrap slideDown entrance animation via the
// `feed-row-wrap-cached` class. Truly new SSE events (id never seen)
// still animate exactly as before; the per-card flashBuy/flashSell
// color flash keeps its own 6 s ts gate independently. The set lives in
// memory only (no storage), so a hard reload starts fresh.
const seenFeedEventIds = new Set<string>();

const FeedCard = memo(function FeedCard({
  event,
  onPreview,
  inclusiveFees,
  slugFloor,
  sellerSellCountInFeed,
  isNewestSellForSellerColl,
  density,
}: FeedCardProps) {
  // Thumb size is the only density-driven inline value — every other
  // delta lives in CSS via the `.feed-density-X` parent class. TAPE
  // mode shrinks 56 → 40 px; COMFY + COMPACT keep 56 (the current
  // polished baseline). The wrapper `.feed-thumb` width is also
  // overridden in CSS for TAPE so the inner img doesn't sit inside
  // a 56 px box with transparent margin.
  const thumbSize = density === 'tape' ? 40 : 56;
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
  // Entrance-animation gate: if we've already rendered this event id in
  // this tab session (initial snapshot, post-/mints round-trip, etc.),
  // mark the row as cached so the slideDown keyframe doesn't replay.
  // Computed once at mount; the set is updated immediately after so a
  // re-mount on a future route return sees the id and stays static.
  const isCached = useState(() => seenFeedEventIds.has(event.id))[0];
  useEffect(() => { seenFeedEventIds.add(event.id); }, [event.id]);
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
  // Age-bucket at mount: fresh (<2min) / mid (<5min) / old (≥5min).
  // A single global setInterval in FeedApp walks `.feed-card[data-event-ts]`
  // every 30 s and only updates this attribute if it changed — no React
  // re-render, no per-card timer, no broken React.memo. CSS rules under
  // `.feed-card[data-age-bucket="mid|old"]` apply a subtle opacity decay
  // (1.00 / 0.92 / 0.86) via a custom property that multiplies with the
  // hover-dim variable so both stack cleanly.
  const ageMinAtMount = (Date.now() - event.ts) / 60_000;
  const initialAgeBucket = ageMinAtMount < 2 ? 'fresh' : ageMinAtMount < 5 ? 'mid' : 'old';
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
  // Card thumb at 56 px display → request 128 px (default) for crisp
  // 2× DPI rendering. The preview overlay below upsizes to 200 px on
  // click; we request a 256 px source there so the modal stays sharp
  // without enlarging this rolling-feed card request.
  const thumbImg       = compressImage(event.imageUrl);
  const previewImg     = compressImage(event.imageUrl, 256);
  const thumbSlug      = event.meCollectionSlug;
  const nftBorderColor = getNftBorderColor(event.nftType);
  const handleThumbClick = () => { if (previewImg) onPreview(previewImg); };
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
    <div className={`feed-row-wrap${isCached ? ' feed-row-wrap-cached' : ''}${isNew ? ' new-' + event.side : ''}`}>
      <div className={cardClass} data-event-ts={event.ts} data-age-bucket={initialAgeBucket}>
        <div
          className="feed-thumb"
          onClick={handleThumbClick}
          onMouseDown={handleThumbMouseDown}
          onAuxClick={handleThumbAuxClick}
          style={{ cursor: thumbImg ? 'pointer' : 'default', position: 'relative' }}
        >
          <div draggable={false} style={FC_THUMB_INNER_STYLE}>
            <ItemThumb imageUrl={thumbImg} color={event.color} abbr={event.abbr} size={thumbSize} />
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
            {/* NFT name now links to the Solscan token page for the
                mint (was internal /collection/<slug>). Collection-route
                affordances live elsewhere (thumb click, etc.) and are
                unchanged. Fallback to <span> only when no mintAddress
                is available (cNFT placeholder rows). */}
            {event.mintAddress ? (
              <a
                href={`https://solscan.io/token/${encodeURIComponent(event.mintAddress)}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
                style={FC_NAME_LINK_STYLE}
                onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'underline'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'none'; }}
              >
                {isTruncated
                  ? shortName
                  : <>{baseName}{num && <span style={FC_NAME_NUM_STYLE}> #{num}</span>}</>}
              </a>
            ) : (
              <span style={FC_NAME_SPAN_STYLE} >
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
                
                aria-label="Lucky Buy"
                style={{ flexShrink: 0, fontSize: 12, lineHeight: 1, userSelect: 'none', marginLeft: -8 }}
              >🍀</span>
            )}
            {event.saleTypeRaw === 'pack_open' && (
              // Sale-from-Packs marker — buyer opened a Magic Eden Pack
              // and one of the contained NFTs landed in their wallet.
              // Same visual treatment as Lucky Buy but with a card
              // emoji to mirror ME's own UI. Detected via the PCKj…
              // program in the tx account universe.
              <span
                
                aria-label="Pack open"
                style={{ flexShrink: 0, fontSize: 12, lineHeight: 1, userSelect: 'none', marginLeft: -8 }}
              >🃏</span>
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
              {/* Seller-remaining badge. Renders on EVERY sell-side
                  row where the backend has resolved a finite count
                  ≥ 3 — the dumper's whole batch shows the same number
                  consistently, so the user can read at a glance how
                  much supply is still in the dumper's hands.
                  Previously gated by `sellerSellCountInFeed >= 2 OR
                  sellerCount >= 10`, which produced inconsistent
                  badges across the same dump (some rows showed the
                  count, others didn't depending on visible-row
                  state). Per the spec: "if shown, show on ALL".
                  The 🔥 multi-sell hint was removed entirely — it
                  was redundant noise next to the numeric count, and
                  on the rare path where only the multi-signal exists
                  (no exact count) one row of fire among silent
                  siblings was confusing rather than helpful. */}
              {(kind === 'sell' || kind === 'sellAmm') &&
                typeof sellerCount === 'number' &&
                Number.isFinite(sellerCount) &&
                sellerCount >= 3 && (
                <span
                  key={event.id}
                  className="seller-remaining-badge"
                  
                  style={SELLER_REMAINING_BADGE_STYLE}
                >
                  <span key={sellerCount} className="seller-remaining-badge-num">
                    {Math.min(99, sellerCount)}
                  </span>
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
            {/* Feed-scoped opacity nudge (visual-polish pass): the
                marketplace icon is supporting metadata, not a focal
                point — its pink ME mark / cyan Tensor mark were
                pulling attention away from the price + BUY/SELL pill.
                Wrapping at 0.78 keeps the icon scan-recognisable but
                drops one tier in the visual hierarchy. Implemented as
                a wrapper span so the shared `MktIconBadge` component
                stays untouched (dashboard / mints consumers see no
                change). */}
            <span style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 0, opacity: 0.78 }}>
              <MktIconBadge mp={event.marketplace} href={marketplaceUrl(event)} />
            </span>
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
            {/* RESIZE qualifier — backend resize-status-resolver (Path C)
                gates this strictly to mints with a confirmed Metaplex-
                authority resize AND no observed user claim. Heuristic
                price/type rules are NOT used here; the prefilter that
                schedules the lookup IS price+type-gated for RPC saving
                only. cNFT / Core never schedule, so never qualify. */}
            {event.resizeStatus === 'metaplex_resized_unclaimed' && (
              <span
                aria-label="Unclaimed Metaplex resize rent"
                style={{
                  fontSize: 9, fontWeight: 700, letterSpacing: '0.4px',
                  color: '#a8a6c4', background: 'transparent',
                  border: '1px solid rgba(168,166,196,0.30)',
                  padding: '0 4px', borderRadius: 3, lineHeight: 1.25,
                  fontFamily: "'SF Mono','Fira Code',monospace",
                  textTransform: 'uppercase', flexShrink: 0,
                }}
              >RESIZE</span>
            )}
            {effectiveFloorDelta != null && <FloorChip delta={effectiveFloorDelta} />}
            {(() => {
              // Unified BUY/SELL/AMM pill — every variant shares the
              // same footprint (width 50, padding 1px 0, fontSize 10.5,
              // weight 700, radius 4, letterSpacing 0.2 px) and the
              // same glassy inset chrome (top highlight + bottom
              // shadow). Direction is carried by fg + bg from
              // KIND_STYLES (green for buy/buyAmm, red for sell/
              // sellAmm). The earlier asymmetric chrome (SELL's red
              // inset ring + tighter radius, AMM's violet inset ring)
              // is removed: it made SELL feel heavier than BUY and
              // pulled AMM off the direction axis.
              //
              // AMM differentiator: OUTER halo at the direction hue,
              // built as a two-layer shadow — a brighter inner ring
              // (defines the chip's "energy") plus a softer outer
              // falloff (ambient glow that fades into the feed
              // background). Asymmetric strength by design: sellAmm
              // halo is harder than buyAmm because sell-side
              // pressure is the more actionable signal at scroll
              // speed and was getting lost on the prior single-layer
              // 5 px / α 0.30 setting.
              //
              //   buyAmm   inner 6 px  α 0.40   outer 12 px α 0.20
              //                      ~+40 % over the prior pass; slightly
              //                      wider blur so the halo reads as
              //                      "energy around the chip" rather
              //                      than a thin outline.
              //   sellAmm  inner 7 px α 0.55 + 1 px spread
              //            outer 14 px α 0.28
              //                      ~+80 % over the prior pass. The
              //                      +1 px spread on the inner layer is
              //                      what makes sellAmm pop above
              //                      adjacent BUY rows in a moving
              //                      feed; the soft outer layer keeps
              //                      it from reading as a neon stamp.
              //
              // Direct BUY / direct SELL get no halo — only the inset
              // glassy chrome. Halo is exclusively a routing cue.
              const isAmm = kind === 'buyAmm' || kind === 'sellAmm';
              const insetChrome =
                'inset 0 1px 0 rgba(255,255,255,0.06),' +
                ' inset 0 -1px 0 rgba(0,0,0,0.16)';
              const ammHalo = isAmm
                ? (kind === 'buyAmm'
                    ? ', 0 0 6px rgba(64,212,168,0.40), 0 0 12px rgba(64,212,168,0.20)'
                    : ', 0 0 7px 1px rgba(245,88,102,0.55), 0 0 14px rgba(245,88,102,0.28)')
                : '';
              return (
                <span style={{
                  width: 50, boxSizing: 'border-box', textAlign: 'center', flexShrink: 0,
                  padding: '1px 0', fontSize: 10.5, fontWeight: 700,
                  borderRadius: 4,
                  background: style.bg, color: style.fg, letterSpacing: '0.2px',
                  boxShadow: insetChrome + ammHalo,
                }}>{style.label}</span>
              );
            })()}
            <span style={FC_PRICE_TEXT_STYLE}>
              {safePrice == null ? '—' : formatFeedPrice(safePrice)}{' '}
              <span style={FC_PRICE_SUFFIX_STYLE}>SOL</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
});

// ── Feed App ─────────────────────────────────────────────────────────────────


const FILTERS: { key: FilterKey; label: string; color: string }[] = [
  { key: 'all',     label: 'All',        color: '#a890e8' },
  { key: 'buy',     label: 'Buy',        color: '#5ce0a0' },
  { key: 'sell',    label: 'Sell',       color: '#ef7878' },
  { key: 'buyAmm',  label: 'Buy AMM',    color: '#5ce0a0' },
  { key: 'sellAmm', label: 'Sell AMM',   color: '#ef7878' },
  { key: 'listing', label: 'Listings',   color: '#a890e8' },
];

/** Inactive-pill style for Type/Price utility filters inside the
 *  filters panel. Brought up to the same family as
 *  DENSITY_PILL_INACTIVE_STYLE — faint white-α 0.025 fill, white-α
 *  0.08 border, color #8e8eb0 — so the panel reads as one
 *  consistent tone instead of "Density bright / everything else
 *  ghost". Pills are still clearly inactive (no per-color
 *  highlight, no border at full lilac), but visible. Active pills
 *  retain their per-color highlight + glow at the call site, so
 *  the active selection still dominates. */
const FILTER_PILL_INACTIVE_STYLE: React.CSSProperties = {
  background: 'rgba(255, 255, 255, 0.025)',
  border: '1px solid rgba(255, 255, 255, 0.08)',
  color: '#8e8eb0',
};

/** Settings pill styling (SETTINGS_PILL_INACTIVE / settingsPillActive) and the
 *  ⚙ SettingsToggle now live in the shared VictoryLabs settings system
 *  (@/soloist/shared) so Live Feed, Mint Tracker, and future panels render one
 *  identical control language. Imported below. */

/** Density pills are the primary "feed mode" control inside the
 *  filters panel — sized noticeably larger than the Type/Price
 *  utility pills so they read as a segmented control rather than
 *  another tiny toggle, but trimmed back from the prior 4 × 14 /
 *  11.5 px sizing so they don't dominate the panel. Inactive pills
 *  are still subdued (they're not the active mode), but carry a
 *  real bg + border so the row reads as a 3-button segment, not
 *  three ghost chips. */
const DENSITY_PILL_BASE_STYLE: React.CSSProperties = {
  padding:        '3px 12px',
  fontSize:       11,
  letterSpacing:  '0.4px',
};
const DENSITY_PILL_INACTIVE_STYLE: React.CSSProperties = {
  ...DENSITY_PILL_BASE_STYLE,
  background:    'rgba(255, 255, 255, 0.025)',
  border:        '1px solid rgba(255, 255, 255, 0.08)',
  color:         '#8e8eb0',
  fontWeight:    600,
};
const DENSITY_PILL_ACTIVE_STYLE: React.CSSProperties = {
  ...DENSITY_PILL_BASE_STYLE,
  background:    'rgba(168, 144, 232, 0.26)',
  border:        '1px solid #a890e8',
  boxShadow:     '0 0 0 1px rgba(168, 144, 232, 0.36), 0 0 10px rgba(168, 144, 232, 0.42)',
  color:         '#f0eef8',
  fontWeight:    700,
};

import {
  SALE_TYPE_BUY, SALE_TYPE_SELL, SALE_TYPE_BUY_AMM, SALE_TYPE_SELL_AMM,
  KIND_STYLES, saleKind, getNftBorderColor,
} from './lib/sale-kind';

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
  // Age-bucket walker — one global setInterval that re-stamps
  // `data-age-bucket` on every `.feed-card[data-event-ts]` element every
  // 30 s. CSS rules under those selectors apply a subtle opacity decay
  // (fresh 1.00, mid 0.92, old 0.86) via a CSS custom property so the
  // age fade stacks multiplicatively with the existing hover-dim. This
  // is intentionally a direct DOM walk, not React state — passing a
  // "now tick" prop into FeedCard would break React.memo and re-render
  // ~150 rows every tick. Cost: ~1 ms/walk.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const tick = () => {
      // Skip the DOM walk on a hidden tab — age buckets aren't user-
      // visible there and the CSS decay catches up the moment the tab
      // returns to visible (next tick walks all cards).
      if (typeof document !== 'undefined' && document.hidden) return;
      const now = Date.now();
      const cards = document.querySelectorAll<HTMLElement>('.feed-card[data-event-ts]');
      for (const card of cards) {
        const tsStr = card.dataset.eventTs;
        if (!tsStr) continue;
        const ts = Number(tsStr);
        if (!Number.isFinite(ts)) continue;
        const ageMin = (now - ts) / 60_000;
        const next = ageMin < 2 ? 'fresh' : ageMin < 5 ? 'mid' : 'old';
        if (card.dataset.ageBucket !== next) card.dataset.ageBucket = next;
      }
    };
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);
  const [filter, setFilter] = useState<FilterKey>('all');
  // Price-tier quick filter. Independent of `filter` (Type) — both can
  // be active at once. Only one price tier can be selected at a time;
  // clicking the active tier flips back to 'all'.
  const [priceFilter, setPriceFilter] = useState<'all' | 'p001' | 'p01' | 'p1'>('all');
  const [collFilter, setCollFilter] = useState<string | null>(null);
  const [collInput, setCollInput] = useState('');
  // Temporary, frontend-only collection blacklist (independent of WATCH).
  // Normalized lowercased slugs/names; resets with component state (same
  // lifecycle as WATCH — never persisted, never sent to the backend).
  const [blacklistSlugs, setBlacklistSlugs] = useState<string[]>([]);
  const [blInput, setBlInput] = useState('');
  const addBlacklist = (raw: string) => {
    const v = raw.trim().toLowerCase();
    if (!v) return;
    setBlacklistSlugs((prev) => (prev.includes(v) ? prev : [...prev, v]));
    setBlInput('');
  };
  const removeBlacklist = (slug: string) =>
    setBlacklistSlugs((prev) => prev.filter((s) => s !== slug));
  const [paused, setPaused] = useState(false);   // manual Pause button
  // Hover auto-pause: freeze the stream while the cursor is over the feed
  // list so fast-scrolling cards/badges stay clickable. Independent of the
  // manual button — effective pause is the OR of the two. Auto-resume on
  // mouse-leave only clears the hover pause, never the manual one.
  const [hoverPauseEnabled, setHoverPauseEnabled] = useState(true);
  const [hoverPaused, setHoverPaused] = useState(false);
  const isPaused = paused || hoverPaused;
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
  // Two-state mount machine so the close animation has time to play
  // before React unmounts the panel. `filtersMounted` lags
  // `filtersOpen` by the close-animation duration: it flips true
  // immediately on open (so the open-animation runs on a fresh
  // mount), and waits ~180 ms after close before flipping false.
  // Re-opening mid-close cancels the unmount timer via the effect
  // cleanup, so a rapid toggle just restarts the open animation
  // without a flicker. Duration is shared with FILTERS_CLOSE_MS
  // below + the `feedFiltersOut` keyframe (globals.css).
  const FILTERS_CLOSE_MS = 180;
  const [filtersMounted, setFiltersMounted] = useState(false);
  useEffect(() => {
    if (filtersOpen) {
      setFiltersMounted(true);
      return;
    }
    if (!filtersMounted) return;
    const t = setTimeout(() => setFiltersMounted(false), FILTERS_CLOSE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersOpen]);
  // Inclusive-fees toggle (bottom bar). Affects only AMM_SELL price display
  // — see `displayPrice()` in src/soloist/price-mode.ts. Persisted in
  // localStorage; updates here propagate via the 'vl:priceMode' event.
  const [inclusiveFees] = useInclusiveFees();

  // Live-feed density mode (COMFY / COMPACT / TAPE). Lazy-init from
  // localStorage so the user's prior choice survives page reloads;
  // SSR safely returns 'compact' (current polished baseline). Bad /
  // corrupt values fall through the type guard and reset to compact
  // — never throws. Persistence side-effect lives in the useEffect
  // below so it runs only after hydration (no setItem during SSR).
  const [density, setDensity] = useState<Density>(() => {
    if (typeof window === 'undefined') return 'compact';
    try {
      const v = window.localStorage.getItem(DENSITY_LS_KEY);
      return isDensity(v) ? v : 'compact';
    } catch {
      return 'compact';
    }
  });
  useEffect(() => {
    try { window.localStorage.setItem(DENSITY_LS_KEY, density); } catch { /* noop */ }
  }, [density]);

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
  const pausedRef    = useRef(isPaused);
  const pausedBuffer = useRef<FeedAction[]>([]);
  const PAUSE_BUFFER_MAX = 500;

  // Keep the ref in sync with the EFFECTIVE pause (manual OR hover). Read
  // from the ref inside the SSE handlers so the long-lived useEffect closure
  // does not need to remount when pause toggles — the EventSource stays
  // connected.
  useEffect(() => { pausedRef.current = isPaused; }, [isPaused]);

  // Drain on resume. captureScroll once before the batch so a user who
  // scrolled mid-pause keeps their viewport.
  useEffect(() => {
    if (isPaused) return;
    const buf = pausedBuffer.current;
    if (buf.length === 0) return;
    pausedBuffer.current = [];
    captureScroll();
    for (const action of buf) dispatch(action);
  }, [isPaused]);

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
            schedulePersistSellerCounts(sellerCountRef.current);
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
      // Resize-status patch — backend resize-status-resolver emits this
      // when a prefilter-matching sale's mint completes its on-demand
      // lookup. Frontend renders the RESIZE chip ONLY when the patched
      // value is 'metaplex_resized_unclaimed' (see FeedCard).
      es.addEventListener('resize_status', (e: MessageEvent) => {
        try {
          const patch = JSON.parse(e.data) as { signature: string; mint: string;
            resizeStatus: 'none' | 'metaplex_resized_unclaimed' | 'claimed' | 'user_resized' };
          if (patch.signature && patch.resizeStatus) {
            enqueue({ type: 'resize_status', patch });
          }
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

  // Backfill sweep — runs whenever feedState changes. For any row that
  // has a seller+collection both known but `sellerRemainingCount` not
  // attached, look up the persisted count by (seller, collection) and
  // dispatch a seller_count patch. Closes the race where a prior row's
  // SSE seller_count broadcast set the cache key after this row was
  // inserted, OR where this row's collectionAddress was null at sale
  // time and only resolved later via `meta` (the reducer's `meta` case
  // updates collectionAddress but doesn't re-attempt the count lookup).
  // Idempotent: skips when count is already on the row, or no key
  // resolves, or no persisted value exists.
  useEffect(() => {
    for (const ev of feedState.byId.values()) {
      if (typeof ev.sellerRemainingCount === 'number') continue;
      const k = sellerCountKey(ev.seller, ev.collectionAddress);
      if (!k) continue;
      const persisted = sellerCountRef.current.get(k);
      if (typeof persisted !== 'number') continue;
      // Synthetic patch — re-uses the existing seller_count reducer.
      // No `signature` because we want to match by (seller+collection)
      // which is the persisted key.
      dispatch({
        type:  'seller_count',
        patch: {
          seller:     ev.seller!,
          collection: ev.collectionAddress!,
          count:      persisted,
          sells10m:   ev.sellerSells10m ?? 0,
        },
      });
      // One match per pass — patchWhere fans out to all matching rows
      // anyway, so we don't need to iterate the full set.
      break;
    }
  }, [feedState]);

  // ── Collection-floor lookup ─────────────────────────────────────────────
  // Dual-purpose cache populated from /api/collections/bids:
  //   1. cNFT dust filter — hide cNFT low-floor noise by collection floor,
  //      not sale price. Hides cNFT collections whose CURRENT FLOOR is at or
  //      below 0.005 SOL via the shared `isCnftDust` predicate (Dashboard
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
    // shared predicate — see `@/soloist/cnft-filter`. Hide cNFT low-floor
    // noise by collection floor, not sale price.
    if (isCnftDust(e, s => floorBySlug[s])) return false;
    // Defensive blacklist — backend deletes blacklisted rows after enrichment,
    // but if a card was already painted via the immediate `sale` SSE frame we
    // also drop it here once enrichment / meta fills in the collection name.
    // Lowercase comparison matches NAME_BLACKLIST in src/db/blacklist.ts.
    if (e.collectionName && FEED_NAME_BLACKLIST.has(e.collectionName.toLowerCase())) return false;
    if (e.meCollectionSlug && FEED_SLUG_BLACKLIST.has(e.meCollectionSlug)) return false;
    // User blacklist (temporary, frontend-only). Same slug field WATCH uses,
    // plus collectionName so a slug-less event can still be matched by its
    // exact collection identifier. Exact (lowercased) match — never a
    // substring — so a typed slug can't accidentally hide unrelated rows.
    if (blacklistSlugs.length > 0) {
      const slug = e.meCollectionSlug?.toLowerCase() ?? '';
      const name = e.collectionName?.toLowerCase() ?? '';
      if ((slug && blacklistSlugs.includes(slug)) ||
          (name && blacklistSlugs.includes(name))) return false;
    }
    // Substring fallback — covers slug-only matches the exact-set above
    // misses (e.g. `paulcharlesart_drip` slug, "Paul Charles Art" name).
    {
      const lowerName = e.collectionName?.toLowerCase()   ?? '';
      const lowerSlug = e.meCollectionSlug?.toLowerCase() ?? '';
      for (const needle of FEED_NAME_SUBSTRING_BLACKLIST) {
        if (lowerName.includes(needle) || lowerSlug.includes(needle)) return false;
      }
    }
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
      if (priceFilter === 'p1'   && candidate < 1)    return false;
    }
    const t = e.saleTypeRaw;
    if (filter === 'buy')     return t === SALE_TYPE_BUY;
    if (filter === 'sell')    return t === SALE_TYPE_SELL;
    if (filter === 'buyAmm')  return t === SALE_TYPE_BUY_AMM;
    if (filter === 'sellAmm') return t === SALE_TYPE_SELL_AMM;
    if (filter === 'listing') return false; // backend does not emit listings in v1
    return true;
  }), [events, filter, priceFilter, collFilter, blacklistSlugs, floorBySlug]);

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

  // Visible slice — bounds the rendered DOM to MAX_RENDERED_ROWS regardless
  // of how many events pass the filter. `filtered` is already sorted
  // newest-first by the reducer, so .slice(0, N) preserves the user's view
  // (most recent activity first) and trims only the tail. When
  // filtered.length <= MAX_RENDERED_ROWS this returns the same array
  // reference content-wise — the cap is a no-op outside burst periods.
  // sellerDumpMap stays computed over the full `filtered` set so the
  // dump-badge aggregation isn't biased by the render cap.
  const visible = useMemo(
    () => filtered.length <= MAX_RENDERED_ROWS ? filtered : filtered.slice(0, MAX_RENDERED_ROWS),
    [filtered],
  );

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
      {/* TopNav rendered persistently by Gate so it survives client-side
          route changes (kills the chrome-unmount flash on navigation). */}

      {/* Centered column stage */}
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center', minHeight: 0, padding: '0 0 10px' }}>
        <div style={{ width: '100%', maxWidth: embedded ? 'none' : 'var(--feed-max, 660px)', display: 'flex', flexDirection: 'column', minHeight: 0, transition: 'max-width 0.28s ease' }}>

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
                {/* Event count — dimmed from #8068d8 → #56566e so the
                    title "Live events" + the LiveDot stay primary; the
                    count is supplementary context (operator usually
                    reads the rows, not the number). */}
                <span style={{ fontSize: 11, fontWeight: 500, color: '#56566e', marginLeft: 4 }}>
                  ({filtered.length.toLocaleString()})
                </span>
                {/* Source-health indicator. Green = both sources fresh.
                    Red = Magic Eden stale (most common: ME API stalls
                    while Tensor keeps producing events). Resting OK
                    state is now noticeably subtler (~30 % of the prior
                    saturation) — only the STALE state remains loud,
                    which is the correct attention model: silent when
                    healthy, alarming when not. */}
                <span
                  
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 3,
                    marginLeft: 4, padding: '1px 5px', borderRadius: 3,
                    fontSize: 9.5, fontWeight: 700, letterSpacing: '0.3px',
                    border: meStale ? '1px solid #ef787866' : '1px solid rgba(92,224,160,0.22)',
                    background: meStale ? 'rgba(239,120,120,0.14)' : 'transparent',
                    color: meStale ? '#ef7878' : 'rgba(92,224,160,0.65)',
                    cursor: 'help',
                  }}
                >
                  <span style={{
                    display: 'inline-block', width: 5, height: 5, borderRadius: '50%',
                    background: meStale ? '#ef7878' : '#5ce0a0',
                    boxShadow: meStale ? '0 0 6px #ef787880' : '0 0 4px rgba(92,224,160,0.40)',
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <SettingsToggle
                  active={filtersOpen}
                  onClick={() => setFiltersOpen(o => !o)}
                />
                {/* Density + Hover-pause live inside the Settings panel below —
                    the top bar stays [Settings][Pause]. (vl.feed.density
                    persistence + pause logic unchanged.) */}
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
              {filtersMounted && (
                <div className={`feed-filters-panel ${filtersOpen ? 'feed-filters-panel-open' : 'feed-filters-panel-close'}`}>
                  {/* Settings organized into three semantic groups, each an
                      aligned label/control grid. Compact, low-weight controls
                      (see SETTINGS_PILL_* + .feed-srow). Collapses to a single
                      column on narrow widths via CSS. */}
                  <div className="feed-settings">
                    {/* GROUP 1 — CONTENT (sale-direction filter) */}
                    <div className="feed-set-group feed-set-group--content">
                      <div className="feed-set-group-hd">Content</div>
                      <div className="feed-srow">
                        <span className="feed-srow-lbl">Type</span>
                        <div className="feed-srow-ctl">
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
                                style={isActive ? settingsPillActive(f.color) : SETTINGS_PILL_INACTIVE}
                              />
                            );
                          })}
                        </div>
                      </div>
                    </div>

                    {/* GROUP 2 — DISPLAY (price · density · hover pause) */}
                    <div className="feed-set-group feed-set-group--display">
                      <div className="feed-set-group-hd">Display</div>
                      {/* PRICE — segmented min-price selector. 'Any' clears the
                          gate; thresholds match the existing filter logic. */}
                      <div className="feed-srow" role="group" aria-label="Minimum price">
                        <span className="feed-srow-lbl">Price</span>
                        <div className="feed-srow-ctl feed-seg">
                          {([
                            { key: 'all',  label: 'Any'  },
                            { key: 'p001', label: '0.01' },
                            { key: 'p01',  label: '0.1'  },
                            { key: 'p1',   label: '1.0'  },
                          ] as const).map(p => {
                            const isActive = priceFilter === p.key;
                            return (
                              <Pill
                                key={p.key}
                                active={isActive}
                                color="#a890e8"
                                onClick={() => setPriceFilter(p.key)}
                                label={p.label}
                                size="sm"
                                style={isActive ? settingsPillActive('#a890e8') : SETTINGS_PILL_INACTIVE}
                              />
                            );
                          })}
                        </div>
                      </div>
                      {/* DENSITY — feed mode (vl.feed.density persistence unchanged) */}
                      <div className="feed-srow" role="group" aria-label="Card density">
                        <span className="feed-srow-lbl">Density</span>
                        <div className="feed-srow-ctl feed-seg">
                          {DENSITIES.map(d => {
                            const isActive = density === d;
                            return (
                              <Pill
                                key={d}
                                active={isActive}
                                color="#a890e8"
                                onClick={() => setDensity(d)}
                                label={d.charAt(0).toUpperCase() + d.slice(1)}
                                
                                size="sm"
                                style={isActive ? settingsPillActive('#a890e8') : SETTINGS_PILL_INACTIVE}
                              />
                            );
                          })}
                        </div>
                      </div>
                      {/* HOVER PAUSE — iOS-style switch. Behavior unchanged:
                          On = hovering the feed list auto-pauses + leaving
                          resumes; manual Pause overrides. Turning Off clears
                          any in-effect hover pause so the stream resumes. */}
                      <div className="feed-srow" role="group" aria-label="Hover pause">
                        <span className="feed-srow-lbl">Hover</span>
                        <div className="feed-srow-ctl">
                          <button
                            type="button"
                            role="switch"
                            aria-checked={hoverPauseEnabled}
                            
                            onClick={() => setHoverPauseEnabled(prev => {
                              const next = !prev;
                              if (!next) setHoverPaused(false);
                              return next;
                            })}
                            className={`vl-switch${hoverPauseEnabled ? ' vl-switch-on' : ''}`}
                          >
                            <span className="vl-switch-thumb" />
                          </button>
                          <span className="feed-srow-hint">{hoverPauseEnabled ? 'On' : 'Off'}</span>
                        </div>
                      </div>
                    </div>

                    {/* GROUP 3 — LISTS (watch · blacklist) */}
                    <div className="feed-set-group feed-set-group--lists">
                      <div className="feed-set-group-hd">Lists</div>
                      {/* WATCH — pin the feed to one collection slug. */}
                      <div className="feed-srow">
                        <span className="feed-srow-lbl">Watch</span>
                        <div className="feed-srow-ctl">
                          <input
                            className="feed-coll-input"
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
                          />
                          <Pill
                            active
                            color="#a890e8"
                            onClick={() => {
                              const v = collInput.trim();
                              if (v) { setCollFilter(v); setCollInput(''); }
                            }}
                            label="+"
                            
                            size="sm"
                            style={settingsPillActive('#a890e8')}
                          />
                          {collFilter && (
                            <span className="feed-chip feed-chip-watch">
                              <span className="feed-chip-txt">{collFilter}</span>
                              <button
                                type="button"
                                onClick={() => setCollFilter(null)}
                                
                                className="feed-chip-x"
                              >✕</button>
                            </span>
                          )}
                        </div>
                      </div>
                      {/* BLACKLIST — temporary, frontend-only excludes (pink).
                          Multi-slug; never persisted / sent to the backend. */}
                      <div className="feed-srow">
                        <span className="feed-srow-lbl">Blacklist</span>
                        <div className="feed-srow-ctl">
                          <input
                            className="feed-coll-input"
                            value={blInput}
                            onChange={(e) => setBlInput(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') addBlacklist(blInput); }}
                            placeholder="collection slug…"
                            spellCheck={false}
                            autoComplete="off"
                          />
                          <Pill
                            active
                            color="#e58aa3"
                            onClick={() => addBlacklist(blInput)}
                            label="+"
                            
                            size="sm"
                            style={settingsPillActive('#e58aa3')}
                          />
                          {blacklistSlugs.map((slug) => (
                            <span key={slug} className="feed-chip feed-chip-bl">
                              <span className="feed-chip-txt">{slug}</span>
                              <button
                                type="button"
                                onClick={() => removeBlacklist(slug)}
                                
                                className="feed-chip-x"
                              >✕</button>
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>{/* /feed-settings */}
                </div>
              )}

              {/* Feed list */}
              <div
                ref={listRef}
                className={`feed-list feed-density-${density}`}
                /* Hover auto-pause attaches to the events container ONLY (not
                   the header/filters). mouseenter/mouseleave don't fire when
                   moving between child cards, so there's no flicker. Entering
                   arms hover-pause unless the user already manually paused;
                   leaving clears only the hover pause (manual stays). */
                onMouseEnter={() => { if (hoverPauseEnabled && !paused) setHoverPaused(true); }}
                onMouseLeave={() => { if (hoverPaused) setHoverPaused(false); }}
                style={{ flex: 1, overflowY: 'auto', padding: '6px 10px 10px 13px' }}
              >
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
                {visible.map(e => {
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
                      density={density}
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
