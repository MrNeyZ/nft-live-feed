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
import { shortenNftName, applyCollectionNameOverride } from './nft-name';
import { KIND_STYLES, saleKind, getNftBorderColor } from './sale-kind';
import { VL, VLText, rgb, alpha, ALPHA } from '@/lib/palette';
import type { FeedCardProps } from './types';
import { useSharedNow } from './shared-now';

// AMM badge glyph — a subtle wave (pool/flow) mark shown BEFORE the "AMM"
// label (∿ AMM) to restore at-a-glance identity without making AMM louder
// than a direct BUY/SELL. Same colour as the label, a touch smaller. The
// glyph is the ONLY differentiator now — AMM's capsule (including its solid
// border) is otherwise identical to BUY/SELL. Fallback candidate: '⊚'.
const AMM_SYMBOL = '∿';

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

// Single source of truth for the sale-age timer's "freshest tier" pink —
// VL.gold / VLText.muted below are already shared palette tokens; this is
// the one color that previously only existed as an inline literal inside
// TimeAgo. Hoisted here so the FRESH badge can reuse the exact same value
// instead of a second copy of the hex string.
const TIMER_FRESH_PINK = '#e87ab0';

function TimeAgo({ ts }: { ts: number }) {
  const now = useSharedNow(useContext(SlowTimeTickContext));
  // Defensive: invalid timestamp renders an em-dash so a malformed /
  // missing blockTime can't surface as "NaNd ago". Future-leaning and
  // negative ages already collapse into the `ageMs < 5000` branch
  // below ("just now") since `<` evaluates true for any negative.
  if (!Number.isFinite(ts)) {
    return <span style={{ fontSize: 11, color: VLText.muted, fontWeight: 500 }}>—</span>;
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
    color  = TIMER_FRESH_PINK; // bright pink — freshest tier: "just now" (<5s) + 6-15s hot window (pre-migration color, restored)
    weight = 600;
  } else if (ageMs < 180000) {
    color  = rgb(VL.gold); // yellow — 16s to 3min
  } else {
    // Stale tier — bumped #a094c0 → muted (text-clarity pass).
    // Fresh pink + yellow tiers stay loud; this lifts the quiet
    // floor so old timestamps still scan instead of dissolving.
    color  = VLText.muted;
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

// ── FRESH MINT badge ─────────────────────────────────────────────────────────
// NFT-level join only: true when this sale's mint_address matched a
// mint_events row observed within the last 4h (src/mints/fresh-mint-cache.ts).
// No collection slug, no mint price, no floor/volume/median — a missed badge
// (unknown mint, cold cache, or a cNFT sale from ME/MMM whose parser stores
// the merkle tree instead of the real per-asset ID in mint_address) is
// acceptable; a false positive is not. Same shared ticker as TimeAgo above so
// the age keeps counting without a per-card timer.
const FRESH_WINDOW_MS = 4 * 60 * 60 * 1000;

function formatFreshAge(ageMs: number): string {
  const mins = Math.floor(ageMs / 60000);
  if (mins < 60) return `${Math.max(mins, 0)}m`;
  return `${Math.floor(mins / 60)}h`;
}

// Same age-progression language as the TimeAgo timer above, reusing its
// exact color tokens (TIMER_FRESH_PINK / VL.gold / VLText.muted) — just a
// different set of thresholds tuned to the FRESH badge's own (much longer)
// 4h window instead of TimeAgo's 15s/3min tiers.
const FRESH_PINK_MAX_MS = 30 * 60 * 1000;      // 0–30 min
const FRESH_GOLD_MAX_MS = 2 * 60 * 60 * 1000;  // 31 min–2h

function freshBadgeColor(ageMs: number): string {
  if (ageMs <= FRESH_PINK_MAX_MS) return TIMER_FRESH_PINK;
  if (ageMs <= FRESH_GOLD_MAX_MS) return rgb(VL.gold);
  return VLText.muted; // 2h–4h
}

function FreshBadge({ mintedAtMs }: { mintedAtMs: number | null | undefined }) {
  const now = useSharedNow(useContext(SlowTimeTickContext));
  if (mintedAtMs == null) return null;
  const liveNow = now > 0 ? now : mintedAtMs; // SSR-safe, mirrors TimeAgo above
  const ageMs = liveNow - mintedAtMs;
  if (ageMs < 0 || ageMs > FRESH_WINDOW_MS) return null;
  return (
    <span
      aria-label="Minted recently, now trading on secondary"
      style={{
        fontSize: 9, fontWeight: 700, letterSpacing: '0.4px',
        color: freshBadgeColor(ageMs), background: 'transparent',
        border: `1px solid ${alpha(VL.purpleTint, ALPHA.borderStrong)}`,
        padding: '0 4px', borderRadius: 3, lineHeight: 1.25,
        fontFamily: "'SF Mono','Fira Code',monospace",
        textTransform: 'uppercase', flexShrink: 0,
      }}
    >NEW {formatFreshAge(ageMs)}</span>
  );
}

// ── OFFER badge ──────────────────────────────────────────────────────────────
// Surfaces the existing `offerDelta` field as-is — no new fetch, no new
// backend logic. Backend already computes this on every sale
// (enrichment/enrich.ts computeOfferDelta, ME collection-level top offer)
// and already uses it to fire the console-only ABOVE_OFFER alert
// (alerts/alerts.ts); this just renders the same number that was silently
// available on the wire all along.
// offerDelta = salePriceSol − topOfferSol (models/sale-event.ts), so a
// higher available ME offer than the sale price is offerDelta < 0.
// Deliberately worded as a plain fact, not a verdict: this is a
// COLLECTION-level top offer, not verified against this exact NFT's
// traits/eligibility — no "missed"/"best exit" language, no implied
// certainty the NFT could have actually filled that offer.
function OfferBadge({ offerDelta }: { offerDelta: number | null | undefined }) {
  const delta = safeFiniteNumber(offerDelta);
  if (delta == null || delta >= 0) return null;
  const magnitude = -delta;
  return (
    <span
      aria-label="A higher Magic Eden collection offer existed at sale time"
      style={{
        fontSize: 9, fontWeight: 700, letterSpacing: '0.4px',
        color: VLText.muted, background: 'transparent',
        border: `1px solid ${alpha(VL.purpleTint, ALPHA.borderStrong)}`,
        padding: '0 4px', borderRadius: 3, lineHeight: 1.25,
        fontFamily: "'SF Mono','Fira Code',monospace",
        textTransform: 'uppercase', flexShrink: 0,
      }}
    >OFFER +{formatFeedPrice(magnitude)}</span>
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
 *  ME icon → magiceden.io/u/<wallet>, plus SNS badge when a .sol domain
 *  resolves. `snsDomainAuto` makes the domain replace the address text
 *  automatically; when false, clicking the SNS badge toggles it. The
 *  Solscan link always targets the raw wallet address regardless. */
function WalletLink({ wallet, snsDomainAuto }: { wallet: string | null; snsDomainAuto: boolean }) {
  const snsDomain = useSnsDomain(wallet);
  // When auto is OFF: badge click toggles domain display. When auto is ON:
  // domain is always shown and the state is irrelevant (never shown otherwise).
  const [domainClicked, setDomainClicked] = useState(false);
  // Sync local click-state when the global setting flips so that turning ON
  // doesn't require a click, and turning OFF immediately hides any opened domain.
  useEffect(() => { setDomainClicked(false); }, [snsDomainAuto]);

  if (!wallet) {
    return <span style={{ color: '#9494b0', fontWeight: 500, fontFamily: "'SF Mono','Fira Code',monospace" }}>N/A</span>;
  }
  const isMe        = wallet === MY_WALLET;
  const solscanUrl  = `https://solscan.io/account/${wallet}`;
  const meUrl       = `https://magiceden.io/u/${wallet}`;
  const showDomain  = !!snsDomain && (snsDomainAuto || domainClicked);

  return (
    // UX audit C1: minWidth:0 lets this span actually shrink inside the
    // (already minWidth:0) party row instead of forcing the row wider than
    // its allotted space — the missing link in the truncation chain at
    // squeezed widths (e.g. the /multi tablet column). See WALLET_LINK_STYLE
    // for the matching overflow/ellipsis half of the fix.
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
      <a
        href={solscanUrl}
        target="_blank"
        rel="noopener noreferrer"
        style={showDomain ? SNS_DOMAIN_LINK_STYLE : isMe ? YOU_BADGE_STYLE : WALLET_LINK_STYLE}
        onMouseEnter={(e) => { if (!isMe) (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'underline'; }}
        onMouseLeave={(e) => { if (!isMe) (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'none'; }}
      >
        {isMe ? 'YOU' : showDomain ? snsDomain : shortWallet(wallet)}
      </a>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <a href={meUrl} target="_blank" rel="noopener noreferrer" style={ME_ICON_LINK_STYLE}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/me.png" alt="ME" width={13} height={13} draggable={false} style={{ display: 'block', borderRadius: 2 }} />
        </a>
        {/* SNS badge — appears once a .sol domain resolves.
            Auto ON:  decorative / links to sns.id profile.
            Auto OFF: click toggles domain text on/off (preventDefault). */}
        {snsDomain && (
          <a
            href={`https://www.sns.id/domain?domain=${encodeURIComponent(snsDomain.replace(/\.sol$/, ''))}`}
            target="_blank"
            rel="noopener noreferrer"
            title={snsDomain}
            onClick={(e) => {
              e.stopPropagation();
              if (!snsDomainAuto) {
                e.preventDefault();
                setDomainClicked(v => !v);
              }
            }}
            style={ME_ICON_LINK_STYLE}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/sns.png?v=3" alt="SNS" width={10} height={10} draggable={false} style={{ display: 'block', borderRadius: 2, filter: 'drop-shadow(0 0 0.65px #2f6b3d)' }} />
          </a>
        )}
      </span>
    </span>
  );
}

// UX audit C1: overflow/ellipsis added (mirrors FC_NAME_LINK_STYLE's
// existing truncation, just never applied here before) — inert at normal
// card widths since the shortened address already fits; only kicks in once
// the party row is squeezed narrower than the address text.
const WALLET_LINK_STYLE: React.CSSProperties = {
  color: '#b9b7cb', fontWeight: 600,
  fontFamily: "'SF Mono','Fira Code',monospace",
  textDecoration: 'none',
  minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
/** Wallet link style when showing a resolved SNS domain. VL.green (#43B984)
 *  matches the SNS logo's brand green within the VL palette. */
const SNS_DOMAIN_LINK_STYLE: React.CSSProperties = {
  color: '#43B984', fontWeight: 600,
  fontFamily: "'SF Mono','Fira Code',monospace",
  textDecoration: 'none',
  minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
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
// Floor-delta Soft Pill (live-feed-final.html reference). A quiet,
// rounded qualifier sitting beside the action capsule — signed percent
// only, NO ▲/▼/• glyph. Sign drives the hue (pos green / neg red /
// neutral muted-purple) but the fill/border/text are deliberately faint
// (~7 % bg, ~15 % border, text mixed 50 % toward #cfcad8) so the chip
// reads as the price's 3rd-priority qualifier, never a second button.
// Colors are the color-mix() results from the reference, precomputed so
// the inline style stays dependency-free:
//   pos  c=#43b984  ·  neg  c=#d96867  ·  neu  c=#8f86c2
// Floor delta = quiet metadata. Tokenized onto the palette: pos/neg use
// the brand green/red text-accent (clearly readable but a tier below the
// action tag's green-strong/red-strong), with a faint tint + border off
// the same hue. Neutral (0 %) carries no direction, so it reads as a
// plain white-alpha gray. Drawn from VL.* — no one-off floor shades.
const FLOOR_TONES = {
  pos: { fg: rgb(VL.green), bg: alpha(VL.green, ALPHA.tintWeak), bd: alpha(VL.green, ALPHA.border) },
  neg: { fg: rgb(VL.red),   bg: alpha(VL.red, ALPHA.tintWeak),   bd: alpha(VL.red, ALPHA.border) },
  neu: { fg: VLText.muted,  bg: 'rgba(255,255,255,0.04)',        bd: 'rgba(255,255,255,0.12)' },
} as const;
function FloorChip({ delta }: { delta: number }) {
  if (!Number.isFinite(delta)) return null;
  // Round first, then derive sign + label off the rounded value so a
  // sub-0.5 % move reads as a neutral "0%" rather than "+0%".
  const rounded = Math.round(delta * 100);
  const tone = rounded > 0 ? FLOOR_TONES.pos : rounded < 0 ? FLOOR_TONES.neg : FLOOR_TONES.neu;
  const txt  = rounded > 0 ? `+${rounded}%` : rounded < 0 ? `${rounded}%` : '0%';
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        height: 18, padding: '0 5px', borderRadius: 9, flexShrink: 0,
        fontSize: 9.5, fontWeight: 600, lineHeight: 1, letterSpacing: '0.2px',
        color: tone.fg, background: tone.bg, border: `1px solid ${tone.bd}`,
        fontFamily: "'SF Mono','Fira Code',monospace",
        fontVariantNumeric: 'tabular-nums', opacity: 0.95,
      }}
    >
      {txt}
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
  fontSize: 15, fontWeight: 700, color: VLText.primary, letterSpacing: '-0.3px',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  textDecoration: 'none', cursor: 'pointer',
};
const FC_NAME_SPAN_STYLE: React.CSSProperties = {
  fontSize: 15, fontWeight: 700, color: VLText.primary, letterSpacing: '-0.3px',
  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
};
const FC_NAME_NUM_STYLE: React.CSSProperties = { color: VLText.primary };
const FC_PARTIES_COL_STYLE: React.CSSProperties = {
  // Tighten the seller/buyer stack — gap dropped from 1 → 0 (rows
  // are already 14 px tall via lineHeight) and marginTop trimmed
  // from 3 → 2 so the two lines sit immediately under the title
  // as a single identity block, not three separate lanes.
  display: 'flex', flexDirection: 'column', gap: 0, marginTop: 2,
};
const FC_PARTY_ROW_STYLE: React.CSSProperties = {
  // Label-vs-wallet separation pass: the `seller:` / `buyer:` label is
  // dropped to a muted #63637a so it reads as clearly secondary, while
  // the wallet keeps a brighter tone (WALLET_LINK_STYLE) as the value
  // to read. Row gap set to 2 px between label and wallet address.
  // (Was #9a9ab4 — identical to the wallet, which made the two blur
  // together.)
  fontSize: 10.5, color: VLText.faint, display: 'flex', alignItems: 'center', gap: 2,
  // UX audit C1: minWidth:0 + overflow:hidden let this row actually shrink
  // and clip instead of visually overflowing onto the card's right column
  // (badge/price) once the card is squeezed — e.g. the /multi tablet
  // column. Mirrors FC_NAME_ROW_STYLE's existing overflow:hidden above.
  minWidth: 0, overflow: 'hidden',
};
/** Fixed-width column for the `seller:` / `buyer:` labels so both rows align:
 *  the wallet (and the ME/SNS badges after it) start at the same X on every
 *  row instead of stair-stepping with the label's natural width. Width holds
 *  the wider "seller:" label at 10.5px; flexShrink:0 keeps it from collapsing. */
const FC_PARTY_LABEL_STYLE: React.CSSProperties = {
  flexShrink: 0,
  // Trimmed 44 → 38: the column held ~7 px of dead space past the
  // "seller:" glyphs, pushing the wallet away from its label. 38 fits
  // the wider "seller:" at 10.5 px while pulling the address in close.
  width: 38,
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
  // Final-polish pass: 16 → 17.5 px (~+10 %) so the price is even more
  // decisively the #1 read above the now-quiet action capsule. Weight
  // and color unchanged (already 800 / pure white).
  fontSize: 17.5, fontWeight: 800, color: '#ffffff', letterSpacing: '-0.3px',
  fontFamily: "'SF Mono','Fira Code',monospace",
  fontVariantNumeric: 'tabular-nums',
};
const FC_PRICE_SUFFIX_STYLE: React.CSSProperties = {
  // SOL unit suffix — text-clarity pass lifted #9a9ab4 → #8585a0
  // and opacity 0.7 → 0.85 so the unit reads clearly at scroll
  // speed without crowding the digits (still well below pure-white
  // price text). Digits remain dominant, suffix is now legible.
  color: '#8585a0', fontWeight: 600, fontSize: 10.5, opacity: 0.72,
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
  // Cluster↔badge gap = parent row gap (6px) + this margin. Trimmed
  // further (0.5→-1) to tighten ONLY the ME/SNS-cluster ↔ count-badge
  // space (6.5→5px). A negative margin pulls the badge toward the
  // cluster without changing the row gap — so the `seller:`↔wallet
  // spacing and wallet text position stay put. Badge
  // size/typography/row height unchanged.
  marginLeft:     -1,
  minWidth:       16,
  height:         16,
  padding:        '0 4px',
  borderRadius:   999,
  // Color matches the TimeAgo "16s–3min" timestamp tint (#c7b479) so
  // the badge reads as ambient context — same visual weight as the
  // time label, not an alert. Background is a very soft same-hue
  // wash for shape definition without the prior neon look.
  background:     alpha(VL.gold, ALPHA.tint),
  color:          rgb(VL.gold),
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
  snsDomainAuto = false,
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
  const kind  = saleKind(event.saleTypeRaw, event.isPoolMarketplace);
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
  const { baseName, num, shortName } = shortenNftName(
    applyCollectionNameOverride(event.nftName, event.collectionAddress),
  );
  const isTruncated = shortName != null;

  // Avatar click routing, local to the Live Feed card:
  //   LMB  → centered image preview (onPreview callback).
  //   MMB  → page-wide autoscroll (see FeedRoot) — no per-thumb handler,
  //          so it isn't swallowed here.
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
  const nftBorderColor = getNftBorderColor(event.nftType);
  const handleThumbClick = () => { if (previewImg) onPreview(previewImg); };

  return (
    <div className={`feed-row-wrap${isCached ? ' feed-row-wrap-cached' : ''}${isNew ? ' new-' + event.side : ''}`}>
      <div className={cardClass} data-event-ts={event.ts} data-age-bucket={initialAgeBucket}>
        <div
          className="feed-thumb"
          onClick={handleThumbClick}
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
              <RarityRankBadge rarityRank={event.rarityRank} totalSupply={event.totalSupply} reasonTags={event.oneOfOne ? ['ONE_OF_ONE'] : undefined} />
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
              <WalletLink wallet={event.seller} snsDomainAuto={snsDomainAuto} />
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
              <WalletLink wallet={event.buyer} snsDomainAuto={snsDomainAuto} />
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
          <div className="feed-price-row" style={FC_PRICE_ROW_STYLE}>
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
                  color: VLText.muted, background: 'transparent',
                  border: `1px solid ${alpha(VL.purpleTint, ALPHA.borderStrong)}`,
                  padding: '0 4px', borderRadius: 3, lineHeight: 1.25,
                  fontFamily: "'SF Mono','Fira Code',monospace",
                  textTransform: 'uppercase', flexShrink: 0,
                }}
              >RESIZE</span>
            )}
            <FreshBadge mintedAtMs={event.mintedAtMs} />
            <OfferBadge offerDelta={event.offerDelta} />
            {effectiveFloorDelta != null && <FloorChip delta={effectiveFloorDelta} />}
            {(() => {
              // Solid action capsule (live-feed-final.html reference),
              // tuned as a LABEL, not a button. BUY / SELL / AMM share
              // ONE footprint — 52 × 20 (≈ 1:2.5), radius 6, 10 px / 500
              // / caps, no extra tracking. Direction is the gradient fill
              // + dark text from KIND_STYLES (green buy/buyAmm, red sell/
              // sellAmm), now at ~81 % intensity.
              //
              // Prominence pass (3rd): the capsule still competed with
              // the price. Shrunk 60×24 → 52×20, weight 600 → 500, font
              // 11 → 10, fill de-intensified another 10 %, and the chrome
              // reduced to a barely-there top inset highlight (no drop
              // shadow, no glow) so it reads as a flat Bloomberg-terminal
              // tag. The pure-white 16 px price is unambiguously #1 — the
              // eye lands on "0.20 SOL" before BUY/SELL/AMM; the capsule
              // is a calm, instantly-readable #2.
              //
              // AMM is a normal BUY/SELL, just routed through a pool — NOT
              // a special event type, never visually heavier. It is the
              // exact same capsule as its direction sibling (same size,
              // typography, fill, radius, colors); the ONLY differentiator
              // is its border: AMM is dashed, person-to-person BUY/SELL is
              // solid. No triangles, icons, glyphs, glow, or decorations.
              const isAmm = kind === 'buyAmm' || kind === 'sellAmm';
              // Thin direction-tinted edge for the tag. Driven by
              // borderTone (the KIND_STYLES axis), so Rare Feed's neutral
              // override gets a neutral edge.
              const tagBorder =
                style.borderTone === 'sell' ? alpha(VL.redStrong, ALPHA.borderStrong) :
                style.borderTone === 'buy'  ? alpha(VL.greenStrong, ALPHA.borderStrong) :
                                              'rgba(255,255,255,0.12)';
              return (
                <span style={{
                  display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: isAmm ? 2.75 : 0,
                  width: 52, height: 20, boxSizing: 'border-box', flexShrink: 0,
                  // Quiet tint container + LOUD label. The fill is just a
                  // faint direction tint (KIND_STYLES, α 0.13) with a thin
                  // tinted border, so the tag no longer reads as a colour
                  // block. The text does the work: 10 px / 800 / caps in a
                  // bright direction colour (pill.fg) — heavy enough that
                  // BUY/SELL/AMM are instantly legible (SELL included),
                  // while the container stays the calm #3 behind the price
                  // and the action text.
                  borderRadius: 5, fontSize: 10, fontWeight: 800, lineHeight: 1,
                  letterSpacing: '0.2px', textTransform: 'uppercase',
                  background: pill.bg, color: pill.fg,
                  border: `1px solid ${tagBorder}`,
                  boxShadow: 'none',
                }}>
                  {/* AMM = subtle wave glyph + "AMM" label (∿ AMM); BUY/SELL
                      keep just their word label. */}
                  {isAmm && <span aria-hidden="true" style={{ fontSize: 9, lineHeight: 1, transform: 'translateY(-1px)' }}>{AMM_SYMBOL}</span>}
                  {pill.label}
                </span>
              );
            })()}
            {(() => {
              // Length-adaptive price size: short prices ("2.3", "0.55"
              // — ≤4 chars) keep the full 17.5 px; longer strings
              // ("0.014" = 5, "0.0014" = 6+) step down so a long price
              // doesn't blow out the right column. Suffix " SOL" is not
              // counted — only the number itself drives the step.
              const priceStr = safePrice == null ? '—' : formatFeedPrice(safePrice);
              const priceFontSize = priceStr.length <= 4 ? 17.5 : priceStr.length === 5 ? 15 : 13.5;
              return (
                <span style={{ ...FC_PRICE_TEXT_STYLE, fontSize: priceFontSize }}>
                  {priceStr}{' '}
                  <span style={FC_PRICE_SUFFIX_STYLE}>SOL</span>
                </span>
              );
            })()}
          </div>
        </div>
      </div>
    </div>
  );
});
