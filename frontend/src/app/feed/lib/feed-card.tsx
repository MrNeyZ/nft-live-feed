'use client';

// VictoryLabs — Feed: FeedCard (+ its private leaves) extracted verbatim
// from feed/page.tsx so a second card-based feed (Rare Feed) can reuse
// the EXACT Live Feed Sales card chrome. No layout/typography/color
// changes vs. the prior inline component. Two optional props were added
// for the Rare Feed context only — `pillOverride` (neutral SALE pill,
// since rare sales carry no buy/sell side) and `nameChip` (a compact
// rarity chip). /feed never passes either, so its render is identical.

import { createContext, memo, useContext, useEffect, useState } from 'react';
import { shortWallet, timeAgo } from '@/soloist/mock-data';
import { useSnsDomain } from './use-sns-domain';
import { marketplaceUrl } from '@/soloist/from-backend';
import { ItemThumb, MktIconBadge, compressImage } from '@/soloist/shared';
import { displayPrice } from '@/soloist/price-mode';
import { formatFeedPrice, safeFiniteNumber } from './format';
import { RarityRankBadge } from './rarity-rank-badge';
import { shortenNftName } from './nft-name';
import { KIND_STYLES, saleKind, getNftBorderColor } from './sale-kind';
import type { FeedCardProps } from './types';
import { useSharedNow } from './shared-now';

// ── Time-ago leaf ────────────────────────────────────────────────────────────
// Reads from the shared ticker. 1 s cadence gives smooth seconds in the
// 5–15 s pink window (per UX spec). React.memo on FeedCard remains
// invalidation-safe because TimeAgo is the only thing that rerenders per
// tick — its parent's props don't change.
//
// Color tiers (per spec):
//   1–5 s:        pink + "just now"
//   6–15 s:       pink + "Xs ago"        (still in the "hot" window)
//   16 s – 3 min: yellow                 (recent but cooling)
//   > 3 min:      muted                  (background/historical)
/** When true, TimeAgo leaves under this provider tick on the slow (10 s)
 *  ticker instead of 1 s. The /multi native panels set it (≈80 cards on one
 *  page); standalone /feed leaves it false → unchanged 1 s cadence. */
export const SlowTimeTickContext = createContext(false);

function TimeAgo({ ts }: { ts: number }) {
  const now = useSharedNow(useContext(SlowTimeTickContext));
  // Defensive: invalid timestamp renders an em-dash so a malformed /
  // missing blockTime can't surface as "NaNd ago". Future-leaning and
  // negative ages already collapse into the `ageMs < 5000` branch
  // below ("just now") since `<` evaluates true for any negative.
  if (!Number.isFinite(ts)) {
    return <span style={{ fontSize: 11, color: '#9a9ab4', fontWeight: 500 }}>—</span>;
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
    color  = '#e87ab0'; // bright pink — freshest tier: "just now" (<5s) + 6-15s hot window (pre-migration color, restored)
    weight = 600;
  } else if (ageMs < 180000) {
    color  = '#c7b479'; // yellow — 16s to 3min
  } else {
    // Stale tier — bumped #a094c0 → #9a9ab4 (text-clarity pass).
    // Fresh pink + yellow tiers stay loud; this lifts the quiet
    // floor so old timestamps still scan instead of dissolving.
    color  = '#9a9ab4';
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
  // Lazy SNS resolution — fires only for this (visible) card's wallet; cached
  // module-wide so repeats don't re-hit the backend. Hook is always called
  // (Rules of Hooks); it no-ops on a null wallet.
  const snsDomain = useSnsDomain(wallet);
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
      {/* Wallet action-icon cluster. Tight inner gap (2px) groups ME + SNS as
          one unit; it's a single child of the outer span so the wallet-text→
          cluster spacing stays at the outer gap (4px) — wallet text spacing
          unchanged. Both icons render at the same 11×11 box (no layout shift). */}
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 1 }}>
        <a
          href={meUrl}
          target="_blank"
          rel="noopener noreferrer"

          style={ME_ICON_LINK_STYLE}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/me.png" alt="ME" width={13} height={13} draggable={false} style={{ display: 'block', borderRadius: 2 }} />
        </a>
        {/* SNS logo — renders ONLY once a .sol domain resolves; sits immediately
            next to the ME icon at the same 11×11 box (asset padding trimmed so it
            fills the box like ME), so its appearance causes no layout shift.
            Native title is the hover tooltip ("name.sol"); click opens the SNS
            profile. */}
        {snsDomain && (
          <a
            href={`https://www.sns.id/domain?domain=${encodeURIComponent(snsDomain.replace(/\.sol$/, ''))}`}
            target="_blank"
            rel="noopener noreferrer"
            title={snsDomain}
            onClick={(e) => e.stopPropagation()}
            style={ME_ICON_LINK_STYLE}
          >
            {/* Original uploaded SNS logo, rendered at the ME icon's 11×11 box.
                Spaced 6px from ME (cluster gap) so the two read as separate
                action icons rather than one merged badge. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            {/* CSS-only ~1px hairline outline (darker green) to crisp the logo
                edge on bright/high-DPI screens. Single 0.5px drop-shadow, no
                offset/glow — asset untouched. Remove this filter line to revert. */}
            <img src="/brand/sns.png?v=3" alt="SNS" width={13} height={13} draggable={false} style={{ display: 'block', borderRadius: 2, filter: 'drop-shadow(0 0 0.65px #2f6b3d)' }} />
          </a>
        )}
      </span>
    </span>
  );
}

const WALLET_LINK_STYLE: React.CSSProperties = {
  // Wallet text sits one tier above the seller:/buyer: label and
  // one tier below the title. Text-clarity pass lifted #7e7e9c →
  // #9a9ab4 so short wallet addresses stop reading as low-contrast
  // mush against the bumped card bg. Still clearly below the title
  // (#f0eef8) — same hierarchy, just a higher readability floor.
  color: '#9a9ab4', fontWeight: 500,
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
  // Canonical marketplace-icon opacity, unified to 0.85 to match /mints and
  // /tools/trending (was 0.65 here — the only divergent value).
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
    ? (above ? '#43b984' : '#d96867')
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
const FC_NAME_NUM_STYLE: React.CSSProperties = { color: '#f0eef8' };
const FC_PARTIES_COL_STYLE: React.CSSProperties = {
  // Tighten the seller/buyer stack — gap dropped from 1 → 0 (rows
  // are already 14 px tall via lineHeight) and marginTop trimmed
  // from 3 → 2 so the two lines sit immediately under the title
  // as a single identity block, not three separate lanes.
  display: 'flex', flexDirection: 'column', gap: 0, marginTop: 2,
};
const FC_PARTY_ROW_STYLE: React.CSSProperties = {
  // Text-clarity pass: label tone lifted #241f3b → #9a9ab4 so
  // `seller:` / `buyer:` is legible at idle. Wallet text is still
  // brighter (#9a9ab4), so the three-tier title → wallet → label
  // hierarchy is preserved — labels just stop dissolving into bg.
  fontSize: 10.5, color: '#9a9ab4', display: 'flex', alignItems: 'center', gap: 6,
};
/** Fixed-width column for the `seller:` / `buyer:` labels so both rows align:
 *  the wallet (and the ME/SNS badges after it) start at the same X on every
 *  row instead of stair-stepping with the label's natural width. Width holds
 *  the wider "seller:" label at 10.5px; flexShrink:0 keeps it from collapsing. */
const FC_PARTY_LABEL_STYLE: React.CSSProperties = {
  flexShrink: 0,
  width: 44,
  whiteSpace: 'nowrap',
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
  // SOL unit suffix — text-clarity pass lifted #9a9ab4 → #8585a0
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
// Bound the set so a long-lived tab (esp. /multi) can't grow it without
// limit. FIFO: a Set preserves insertion order, so the first entry is the
// oldest — drop it past the cap. Cosmetic only: an evicted id can replay its
// one-shot slideDown entrance animation if it ever remounts (rare).
const SEEN_IDS_MAX = 2000;
function rememberSeenEventId(id: string): void {
  if (seenFeedEventIds.has(id)) return;
  seenFeedEventIds.add(id);
  if (seenFeedEventIds.size > SEEN_IDS_MAX) {
    const oldest = seenFeedEventIds.values().next().value;
    if (oldest !== undefined) seenFeedEventIds.delete(oldest);
  }
}

export const FeedCard = memo(function FeedCard({
  event,
  onPreview,
  inclusiveFees,
  slugFloor,
  sellerSellCountInFeed,
  isNewestSellForSellerColl,
  density,
  pillOverride,
  nameChip,
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
  // Row-flash class lasts 6 s from the wall-clock LIVE arrival
  // (`clientArrivedAt`), NOT `event.ts` — `ts` is the on-chain blockTime
  // and is routinely already >6 s old by the time the row paints (block
  // finality + ingest + SSE + render), so gating on it made the flash
  // never fire. Snapshot / persisted rows have no `clientArrivedAt` and
  // so never flash. Computed once at mount with a one-shot setTimeout to
  // flip false — every card mounts at most once per event.
  const arrivedAt = event.clientArrivedAt;
  const [isNew, setIsNew] = useState(() => arrivedAt != null && arrivedAt > Date.now() - 6000);
  useEffect(() => {
    if (!isNew || arrivedAt == null) return;
    const remaining = 6000 - (Date.now() - arrivedAt);
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
  useEffect(() => { rememberSeenEventId(event.id); }, [event.id]);
  const kind  = saleKind(event.saleTypeRaw);
  const sellerCount = event.sellerRemainingCount;
  const style = KIND_STYLES[kind];
  // Pill appearance: Rare Feed passes an explicit `pillOverride` (a
  // neutral SALE pill — rare sales carry no buy/sell side); /feed never
  // does, so it keeps the direction-coloured KIND_STYLES pill.
  const pill = pillOverride ?? style;
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
  // Shared shortener (also used by the /multi compact Rare strip) — caps the
  // visible title at 18 chars; when truncated we fall back to a single string
  // (loses the styled `#…` color) and append an ellipsis.
  const { baseName, num, shortName } = shortenNftName(event.nftName);
  const isTruncated = shortName != null;

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
            {/* Rare Feed only — compact rarity chip after the NFT name.
                /feed never passes `nameChip`, so this renders nothing
                there and the name row is byte-identical to before. */}
            {nameChip}
            {/* Live Feed: best-effort Tensor-style rarity badge from
                event.rarityRank (backend mint_rarity_cache). Shows EPIC+ only;
                null otherwise. Rare Feed sets no rarityRank field, so this
                never double-renders alongside nameChip. */}
            {!nameChip && (
              <RarityRankBadge rarityRank={event.rarityRank} totalSupply={event.totalSupply} />
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
              <span style={FC_PARTY_LABEL_STYLE}>seller:</span>
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
              <span style={FC_PARTY_LABEL_STYLE}>buyer:</span>
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
                  color: '#9a9ab4', background: 'transparent',
                  border: '1px solid rgba(168,144,232,0.32)',
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
                  background: pill.bg, color: pill.fg, letterSpacing: '0.2px',
                  boxShadow: insetChrome + ammHalo,
                }}>{pill.label}</span>
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
