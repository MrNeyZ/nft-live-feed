// VictoryLabs — Mints: a single row in the COLLECTIONS table.
// Extracted from page.tsx so the page file stays maintainable. Same
// className stack, same style objects, same column order, same nested
// IIFEs for title / MINTS / SUPPLY / PRICE / RATE. The closure surface
// is small and explicit: row + index + now + mintTf + tfStatsByKey +
// lastPriceByKey. Status pill style consts live here because they
// have no other consumer; the SOURCE pill is the existing
// `<MintsSourceBadge>`.

import { useState } from 'react';
import { ItemThumb } from '@/soloist/shared';
import { playUiSelect } from '@/soloist/use-ui-sound';
import type { MintStatus, MintTimeframe, MintsTimeframeStats, PaymentTokenInfo } from '../lib/types';
import { MINT_TF_MS } from '../lib/types';
import { colorForCollection, isSolPubkey } from '../lib/palette';
import { fmtAge, fmtSol, shortKey, thumb64 } from '../lib/format';
import { MintsSourceBadge } from './MintsSourceBadge';

/** Per-row status pill in the COLLECTION cell. ACTIVE = promoted
 *  (`displayState === 'shown'`); WATCH = incubating (pre-burst,
 *  surfaced here so the table isn't empty when traffic is sparse).
 *  Compact 9 px font + flexShrink: 0 so it never wraps off the row. */
// Enlarged ~25% vs the prior 9px/1px-5px/13px pill so the status reads as a
// premium badge, not tiny metadata. Height grows via lineHeight + vertical
// padding; font bumps modestly. Wrapper still hugs (inline-block).
const STATUS_BADGE_BASE: React.CSSProperties = {
  // Fixed-square geometry — drives a 20×20 (22×22 with 1 px border)
  // container that matches the prior badge height (16 px lineHeight +
  // 2 px paddingY + 1 px border × 2 = 22) so row alignment is
  // preserved while the horizontal stretch from padding-based sizing
  // is gone. Flex-centers the ▲/◇/■ glyph in both axes; font weight,
  // size, and border-radius are unchanged.
  display:        'inline-flex',
  alignItems:     'center',
  justifyContent: 'center',
  width:          20,
  height:         20,
  fontSize:       10,
  fontWeight:     800,
  letterSpacing:  0,
  lineHeight:     1,
  borderRadius:   4,
  flexShrink:     0,
};
const STATUS_BADGE_ACTIVE: React.CSSProperties = {
  ...STATUS_BADGE_BASE,
  color:      '#5ce0a0',
  background: 'rgba(92,224,160,0.14)',
  border:     '1px solid rgba(92,224,160,0.42)',
};
const STATUS_BADGE_WATCH: React.CSSProperties = {
  ...STATUS_BADGE_BASE,
  color:      '#F5C84B',
  background: 'rgba(245,200,75,0.10)',
  border:     '1px solid rgba(245,200,75,0.45)',
};
// Same red as the rest of the site (SELL flash / SELL feed badge —
// `rgba(239,120,120,…)`), kept consistent so a row that hits its
// max supply visually clusters with sell-side cues elsewhere.
const STATUS_BADGE_SOLD: React.CSSProperties = {
  ...STATUS_BADGE_BASE,
  color:      '#ef7878',
  background: 'rgba(239,120,120,0.12)',
  border:     '1px solid rgba(239,120,120,0.45)',
};

interface Props {
  row:          MintStatus;
  index:        number;
  now:          number;
  mintTf:       MintTimeframe;
  tfStatsByKey: Map<string, MintsTimeframeStats>;
  /** Latest observed mint priceLamports per groupingKey, derived from
   *  the live-feed event ring buffer in page.tsx. Drives the PRICE
   *  column. Map miss → row hasn't surfaced an event yet (cell
   *  renders "—"); value === null → most recent event had no price
   *  (cell renders "—"); value === 0 → confirmed free; value > 0 →
   *  paid (cell renders fmtSol). NOT an average. */
  lastPriceByKey: Map<string, number | null>;
  /** Latest custom-token payment per groupingKey. Null entry → most
   *  recent mint was SOL-priced. Map miss → no event yet. */
  lastPaymentByKey?: Map<string, { mint: string; amount: string; decimals: number } | null>;
  /** Resolved symbol/logo for known payment-token mints, keyed by mint
   *  address. Populated by the SSE `payment_token_meta` channel. */
  paymentTokens?: Map<string, PaymentTokenInfo>;
  /** Hover-scope hooks (frontend-only). Fire when the pointer enters/leaves
   *  this row so the page can temporarily scope the Live Mint Feed to this
   *  collection. Optional — omitting them leaves row behaviour unchanged. */
  onHoverEnter?: () => void;
  onHoverLeave?: () => void;
  /** Hover-pause hooks — fire when the cursor enters/leaves the row body
   *  (not empty table whitespace). Wired to the page-level zone counter
   *  so the LEFT and RIGHT panes share one `hoverPaused` state. */
  onPauseEnter?: () => void;
  onPauseLeave?: () => void;
  /** True when THIS collection is the pinned (locked) live-feed scope. */
  isPinned?: boolean;
  /** Toggle this collection's pin (SHOW button). Pin persists after the mouse
   *  leaves; clicking again unpins; pinning another row replaces the pin. */
  onTogglePin?: () => void;
}

/** Display-only collection-name truncation. Caps the visible label at ~12
 *  chars (slice 11 + ellipsis) so long names don't dominate the row; the FULL
 *  name is always kept in the cell's `title` attribute. Short names pass
 *  through unchanged ("BOBRO" → "BOBRO"). */
function shortCollectionName(name: string): string {
  const clean = name.trim();
  if (clean.length <= 12) return clean;
  return clean.slice(0, 11).trimEnd() + '…';
}

/** Format a raw u64 token amount (string) into a human display with at
 *  most 4 fractional digits, trailing zeros trimmed. Stays string-safe —
 *  no Number conversion in case the raw amount exceeds 2^53. */
function formatTokenAmount(raw: string, decimals: number): string | null {
  if (!/^\d+$/.test(raw)) return null;
  if (decimals <= 0) return raw;
  const padded = raw.padStart(decimals + 1, '0');
  const intPart  = padded.slice(0, padded.length - decimals);
  const fracPart = padded.slice(padded.length - decimals);
  // Trim to 4 frac digits then drop trailing zeros.
  const fracTrunc = fracPart.slice(0, 4).replace(/0+$/, '');
  return fracTrunc.length > 0 ? `${intPart}.${fracTrunc}` : intPart;
}

export function MintsTableRow({ row: r, index: i, now, mintTf, tfStatsByKey, lastPriceByKey, lastPaymentByKey, paymentTokens, onHoverEnter, onHoverLeave, onPauseEnter, onPauseLeave, isPinned, onTogglePin }: Props) {
  // Per-row toggle: SOL price (default) ↔ custom-token amount. Persists
  // for the lifetime of the mounted row only — short-lived UI state, no
  // localStorage. Independent across rows.
  const [showInToken, setShowInToken] = useState(false);
  // Belt-and-suspenders against whitespace-only names that pre-date
  // the backend trim (still cached in localStorage) or that slip
  // through any future enrichment path. `??` alone wouldn't catch
  // "                                " (32 spaces) — that's truthy,
  // would render as blank.
  const trimmed = r.name?.trim();
  const displayName = (trimmed && trimmed.length > 0)
    ? trimmed
    : shortKey(r.groupingKey);
  // Visible label (≤12 chars + ellipsis); full name stays in the title attr.
  const displayShort = shortCollectionName(displayName);
  const isBurst = r.shownReason === 'burst';
  // ACTIVE = promoted (`shown`), WATCH = pre-burst (`incubating`).
  // Drives the inline status pill below and a faint row dim on WATCH
  // so ACTIVE rows stay visually dominant. Threshold/burst logic in
  // the backend accumulator is unchanged.
  const isActive = r.displayState === 'shown';
  const accentColor = colorForCollection(r.collectionAddress ?? r.groupingKey);
  // Collection-thumbnail image priority, collapsed into ItemThumb's two
  // slots (primary + single fallback; each gets its own proxy→raw retry,
  // initials only after all exhaust). Sourced entirely from fields already
  // on the row — no extra fetch:
  //   1. collection hero (imageUrl)
  //   2. representative per-NFT image (first confidently-unique one seen)
  //   3. shared pre-reveal placeholder — a real, successfully-observed NFT
  //      image; better than initials when no hero/representative exists.
  // CRITICAL: ItemThumb renders initials immediately when its PRIMARY url
  // is null (it only advances to fallbackImageUrl via an <img> onError, so
  // a null primary never reaches the fallback). Earlier this passed the
  // hero straight to `imageUrl`, so a row with imageUrl=null but a valid
  // representativeImageUrl (e.g. uAPE Mini, Colony Planet) short-circuited
  // to initials. Collapse to the first non-null candidate as primary —
  // mirrors the live-feed card's first-non-null selection.
  const imgCandidates = Array.from(new Set(
    [r.imageUrl, r.representativeImageUrl, r.sharedPlaceholderImageUrl]
      .map((u) => (typeof u === 'string' && u.trim().length > 0 ? u : null))
      .filter((u): u is string => u !== null),
  ));
  const primaryImg  = imgCandidates[0] ?? null;
  const fallbackImg = imgCandidates[1] ?? null;
  // SOLD takes priority over ACTIVE / WATCH: when the launchpad's
  // planned drop has been fully minted (or exceeded due to dup
  // events), the row is a completed event, not "still cooking".
  // Clamp display via the raw comparison — even observedMints >
  // maxSupply hits this branch and renders SOLD.
  const isSoldOut = typeof r.maxSupply === 'number'
    && r.maxSupply > 0
    && r.observedMints >= r.maxSupply;
  // Row state — drives the per-state row className
  // (`.mints-tracker-row-{active,watch,sold}`) and the alpha applied
  // to the per-collection accent border on the COLLECTION cell. Same
  // priority order as the status pill below: SOLD > ACTIVE > WATCH.
  const rowState: 'active' | 'watch' | 'sold' = isSoldOut
    ? 'sold'
    : isActive ? 'active' : 'watch';
  // WATCH rows soften the per-collection accent to ~80% alpha (`cc`
  // hex) so an incubating row still reads as slightly quieter than
  // ACTIVE/SOLD (FF) but darker palette entries (green, orange, red,
  // teal) stay clearly identifiable instead of collapsing to muddy
  // on the dark row background. Palette is 6-char hex throughout
  // (see COLLECTION_PALETTE), so an 8-char hex suffix is safe.
  const accentBorderColor = rowState === 'watch'
    ? `${accentColor}cc`
    : accentColor;
  // Fresh-mint flash — same green pulse the dashboard uses for fresh
  // sales. Two parts:
  //   1. `key` includes `r.lastMintAt` so React remounts the row
  //      whenever a new mint lands in this collection — the CSS
  //      animation replays from frame 0 each time.
  //   2. `row-flash-up` class is applied when the most recent mint
  //      is < 3.6 s old (the animation's duration). After the
  //      window passes the class is dropped automatically on the
  //      next `force()` tick (5 s cadence) — well beyond animation
  //      end, so no visible cut-off.
  const isFreshMint = (now - r.lastMintAt) < 3600;
  return (
    <tr
      // Class stack:
      //   • `mints-tracker-row` — per-row background tint
      //     (globals.css) so each tracker row sits as a soft band
      //     rather than a fully transparent strip; closes the depth
      //     gap with the right-pane Live Mint Feed cards.
      //   • `mints-tracker-row-{active,watch,sold}` — state-based
      //     tint shift on top of the base row tint. ACTIVE = subtle
      //     green wash; WATCH = quieter than default; SOLD = subtle
      //     red wash. Combined with the per-state alpha on the
      //     COLLECTION cell's borderLeft, this gives WATCH/ACTIVE/
      //     SOLD a visible hierarchy without dropping row opacity
      //     (which made images / values look washed out).
      //   • `tools-offer-row` — shared hover lift system (scale
      //     1.015, inset purple ring, soft outer glow, z-index 1,
      //     200 ms ease-out). `:hover` specificity (2) beats both
      //     `.mints-tracker-row` and the state classes, so the
      //     hover state looks identical for ACTIVE/WATCH/SOLD.
      //   • `row-flash-up` — additive, animates background on
      //     fresh mints without breaking hover.
      className={`mints-tracker-row mints-tracker-row-${rowState} tools-offer-row${isFreshMint ? ' row-flash-up' : ''}`}
      // Hover-pause fires from the row body only (mouseenter/leave do not
      // bubble through children), so passing through child cells / icons
      // never produces a leave/enter flicker.
      onMouseEnter={onPauseEnter}
      onMouseLeave={onPauseLeave}
      // Row hover no longer scopes the live feed — only the SHOW button does
      // (onHoverEnter/onHoverLeave are wired to SHOW below). The CSS hover
      // lift (tools-offer-row) still applies on row hover.
      style={{
        // Slightly stronger separator alpha (0.05 vs 0.04 before)
        // so the per-row tint reads as a distinct band; still a
        // 1px hairline, never thick.
        borderBottom: '1px solid rgba(255,255,255,0.05)',
        // Full opacity across all states — the WATCH / ACTIVE /
        // SOLD distinction is already conveyed by the inline status
        // pill, so dimming the row body only made images and values
        // look washed out.
        opacity: 1,
        // Burst-promoted rows get a paint-only warm amber outline as
        // the trending cue (replaces the prior inline fire marker /
        // louder pill variant). `outline` is used rather than
        // `boxShadow` because `.tools-offer-row:hover` owns the
        // row's box-shadow for the hover ring; an inline boxShadow
        // would beat that on hover via inline-style specificity and
        // break the hover affordance. Outline is independent of
        // box-shadow, scales with the hover transform, and is gated
        // on rowState === 'active' so a burst row that has since
        // sold out (SOLD wash) doesn't carry conflicting warm + red
        // cues.
        outline:       isBurst && rowState === 'active' ? '1px solid rgba(226,144,111,0.26)' : undefined,
        outlineOffset: isBurst && rowState === 'active' ? '-1px' : undefined,
      }}
    >
      {/* COLLECTION cell — matches Dashboard rows: 12px vertical
          padding (up from /mints' previous compact 8px to align with
          /dashboard rhythm), 38 px ItemThumb, 15 px name. Left accent
          stripe (3 px, deterministic per collectionAddress) so rows
          from the same collection are visually grouped at a glance. */}
      <td style={{ padding: '14px 8px 14px 6px', verticalAlign: 'middle', borderLeft: `3px solid ${accentBorderColor}` }}>
        {/* Fixed-slot CSS grid for the identity area — children DON'T flow:
            [rank 22][image 46][status 22][name 100][icons+source + SHOW (1fr)].
            Status track was 66 px to fit the old ACTIVE/WATCH labels; after
            the A/W/S compaction the badge renders at ~22 px so the reserved
            track shrinks to match, pulling collection names left. Every row's
            name start-x remains identical because the status track stays a
            fixed pixel width (not `auto`). Other tracks and columnGap are
            untouched. */}
        <div style={{ display: 'grid', gridTemplateColumns: '22px 46px 22px 100px 1fr', alignItems: 'center', columnGap: 6 }}>
          <span style={{ width: 22, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8a8aa6', fontSize: 12, fontWeight: 500, fontFamily: "'SF Mono','Fira Code',monospace" }}>{i + 1}</span>
          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
          <ItemThumb
            // primaryImg / fallbackImg are the first two non-null of
            // [hero, representative, shared placeholder] (see above).
            // ItemThumb's onError chain swaps primary→fallback→initials;
            // a null fallback just collapses to the 2-step proxy+raw
            // behaviour for the primary URL.
            imageUrl={thumb64(primaryImg)}
            fallbackImageUrl={thumb64(fallbackImg)}
            color={colorForCollection(r.collectionAddress ?? r.groupingKey)}
            abbr={(displayName[0] ?? '?').toUpperCase() + (displayName[1] ?? '').toUpperCase()}
            size={42}
          />
          </span>
          {/* status badge — real inline badge, centered in its grid column.
              The badge element itself is width:auto (STATUS_BADGE_BASE); the
              column (56px) is what reserves the consistent slot. */}
          <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
            {/* Status pill priority: SOLD > ACTIVE > WATCH.
                SOLD (red, site-consistent) when the launchpad-known
                maxSupply is met or exceeded; ACTIVE (saturated
                green) for backend-promoted rows; WATCH (muted
                amber) for incubating rows. Inline before the name —
                no extra column, no layout shift. */}
            {isSoldOut ? (
              <span
                
                aria-label="Sold"
                style={STATUS_BADGE_SOLD}
              >■</span>
            ) : isActive ? (
              <span  aria-label="Active" style={STATUS_BADGE_ACTIVE}>▲</span>
            ) : (
              <span  aria-label="Watch" style={STATUS_BADGE_WATCH}>◇</span>
            )}
          </span>
          {/* name — fixed 180px grid column, single-line ellipsis, vertically
              centered; full name on hover. minWidth:0 lets it ellipsis rather
              than overflow the slot. */}
          <span style={{ minWidth: 0, display: 'inline-flex', alignItems: 'center', overflow: 'hidden' }}>
            {(() => {
              // Title is clickable → Solscan ONLY when we have a
              // real NFT mint address from the wire (`lastMintAddress`
              // — set by the accumulator from the most recent
              // accepted MintEvent). We deliberately do NOT fall
              // back to collectionAddress / groupingKey: those can
              // be a collection account, update authority, creator,
              // or merkle tree — none of which open a viewable NFT
              // page on Solscan. No mint address → plain text (no
              // link).
              const titleAnchor = isSolPubkey(r.lastMintAddress) ? r.lastMintAddress : null;
              const titleHref = titleAnchor
                ? `https://solscan.io/token/${titleAnchor}`
                : null;
              const titleInner = (<>{displayShort}</>);
              const titleStyle: React.CSSProperties = {
                // Hug the visible (shortened) text so the hit/hover area
                // matches the label, not the full 135px name slot. The slot
                // itself stays fixed for alignment; maxWidth:100% keeps the
                // defensive ellipsis if a name ever exceeds the slot.
                display: 'inline-block', width: 'fit-content', maxWidth: '100%',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
                fontSize: 16, fontWeight: 600, letterSpacing: '-0.2px',
                color: '#f0eef8', textDecoration: 'none', cursor: titleHref ? 'pointer' : 'default',
              };
              return titleHref ? (
                <a
                  href={titleHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  
                  style={titleStyle}
                  onClick={(e) => e.stopPropagation()}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'underline'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'none'; }}
                >{titleInner}</a>
              ) : (
                <span  style={titleStyle}>{titleInner}</span>
              );
            })()}
          </span>
          {/* trailing 1fr cell: icons + source only. SHOW lives in its
              own dedicated <td> after this cell (see below), so no
              positioning hacks are needed here — icons+source simply
              hug their content at the start of the trailing zone. */}
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, minWidth: 0 }}>
            {/* Tiny ME icon — replaces the removed LINKS column.
                Only renders when we have a stable on-chain anchor
                (collectionAddress); when null (e.g. groupingKind =
                `authority`), the icon is hidden so the row doesn't
                show a dead link. Same visual as ME icons elsewhere
                (/feed wallet rows, /tools). */}
            {/* ME `/item-details/{X}` only renders a real page when
                X is a SPECIFIC NFT mint, not a collection address.
                We use `lastMintAddress` (the most recent accepted
                mint for this row) — that lands on a viewable NFT
                page from which the user can navigate up to the
                collection. Falls back to nothing when no real mint
                address is on the wire (e.g. cNFTs without a leaf
                address) — better than a dead link to a collection
                page. */}
            {isSolPubkey(r.lastMintAddress) && (
              <a
                href={`https://magiceden.io/item-details/${r.lastMintAddress}`}
                target="_blank"
                rel="noopener noreferrer"
                
                style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 0, flexShrink: 0, opacity: 0.85, textDecoration: 'none' }}
                onClick={(e) => e.stopPropagation()}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/brand/me.png" alt="ME" width={13} height={13} draggable={false} style={{ display: 'block', borderRadius: 2 }} />
              </a>
            )}
            {/* Tensor badge — pairs with the ME icon and uses the
                same lastMintAddress anchor. `/trade/{collectionAddress}`
                was producing dead pages for unverified collections
                (Tensor only indexes verified ones in that route);
                `/item/{mint}` always loads an item page from which
                the user can navigate up to the collection. */}
            {isSolPubkey(r.lastMintAddress) && (
              <a
                href={`https://www.tensor.trade/item/${r.lastMintAddress}`}
                target="_blank"
                rel="noopener noreferrer"
                
                style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 0, flexShrink: 0, opacity: 0.85, textDecoration: 'none' }}
                onClick={(e) => e.stopPropagation()}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/brand/tensor.png" alt="Tensor" width={13} height={13} draggable={false} style={{ display: 'block', borderRadius: 2 }} />
              </a>
            )}
            {/* X (Twitter) live-search badge — links to a Live tab
                search for the collection name so the user can pivot
                from "what's minting" to "what's the chatter" in one
                click. Suppressed when we don't have a real name
                (only the shortKey fallback) — searching a base58
                prefix yields nothing useful. URL form mirrors the
                user-spec'd template; encodeURIComponent keeps
                spaces / specials safe. */}
            {trimmed && trimmed.length > 0 && (
              <a
                href={`https://x.com/search?q=${encodeURIComponent(trimmed)}&src=recent_search_click`}
                target="_blank"
                rel="noopener noreferrer"
                
                style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 0, flexShrink: 0, opacity: 0.85, textDecoration: 'none' }}
                onClick={(e) => e.stopPropagation()}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/brand/x.png" alt="X" width={13} height={13} draggable={false} style={{ display: 'block', borderRadius: 2 }} />
              </a>
            )}
            {/* source badge — in the SAME group, right after the icons.
                size="lg" matches the enlarged status badge (table-only; the
                Live Mint Feed card keeps the default small pill). */}
            <MintsSourceBadge row={r} size="lg" />
          </span>
        </div>
      </td>
      {/* ── SHOW — dedicated action column (own <td>, stable column
            width via --mints-show-col-w in the table colgroup). Button
            is centered inside the cell via td text-align/justify, with
            no dependency on COLLECTION-cell content width. */}
      <td style={{ padding: 0, verticalAlign: 'middle', textAlign: 'center', position: 'relative' }}>
        {onTogglePin && (
          <div
            role="button"
            tabIndex={0}
            data-uisnd="skip"
            
            onClick={(e) => { e.stopPropagation(); playUiSelect(); onTogglePin(); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playUiSelect(); onTogglePin(); } }}
            onMouseEnter={(e) => {
              onHoverEnter?.();
              if (!isPinned) {
                const b = e.currentTarget;
                b.style.background = 'linear-gradient(90deg, rgba(128,104,216,0) 0%, rgba(140,112,228,0.16) 28%, rgba(150,120,236,0.28) 50%, rgba(140,112,228,0.16) 72%, rgba(128,104,216,0) 100%)';
                b.style.boxShadow  = 'inset 0 0 0 1px rgba(178,152,240,0.32), inset 0 0 14px rgba(150,120,236,0.14)';
                const t = b.firstElementChild as HTMLElement | null; if (t) { t.style.color = '#ffffff'; t.style.textShadow = '0 0 8px rgba(178,152,240,0.45)'; }
              }
            }}
            onMouseLeave={(e) => {
              onHoverLeave?.();
              if (!isPinned) {
                const b = e.currentTarget;
                b.style.background = 'linear-gradient(90deg, rgba(128,104,216,0) 0%, rgba(128,104,216,0.04) 28%, rgba(128,104,216,0.06) 50%, rgba(128,104,216,0.04) 72%, rgba(128,104,216,0) 100%)';
                b.style.boxShadow  = 'none';
                const t = b.firstElementChild as HTMLElement | null; if (t) { t.style.color = '#b4a8d8'; t.style.textShadow = 'none'; }
              }
            }}
            style={{
              // Absolutely-positioned fill so the action strip spans the
              // ENTIRE row content height (td → row stretches all cells
              // to the tallest sibling's height; abs child with top/bottom
              // 0 inherits that height exactly). 6 px inset L/R is the
              // soft gutter from neighbouring columns. No padding-based
              // height calc, no minHeight guess — strip is always row-tall.
              position: 'absolute', top: 0, bottom: 0, left: 6, right: 6,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', userSelect: 'none',
              // borderRadius:0 kills the floating-rounded-button silhouette.
              // Idle = no inset outline (zone blends into the row); hover/
              // pinned bring the inset ring back so the zone reads as
              // active. Rectangular action band, never a card.
              borderRadius: 0,
              background: isPinned
                ? 'linear-gradient(90deg, rgba(128,104,216,0.06) 0%, rgba(140,112,228,0.20) 28%, rgba(155,124,240,0.34) 50%, rgba(140,112,228,0.20) 72%, rgba(128,104,216,0.06) 100%)'
                : 'linear-gradient(90deg, rgba(128,104,216,0) 0%, rgba(128,104,216,0.04) 28%, rgba(128,104,216,0.06) 50%, rgba(128,104,216,0.04) 72%, rgba(128,104,216,0) 100%)',
              boxShadow: isPinned ? 'inset 0 0 0 1px rgba(188,160,246,0.42), inset 0 0 18px rgba(155,124,240,0.18)' : 'none',
              transition: 'background 160ms ease, box-shadow 160ms ease',
            }}
          >
            <span style={{
              fontSize: 10.5, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase',
              whiteSpace: 'nowrap', transition: 'color 160ms ease, text-shadow 160ms ease',
              color: isPinned ? '#ffffff' : '#b4a8d8',
              textShadow: isPinned ? '0 0 10px rgba(188,160,246,0.55)' : 'none',
            }}>SHOW</span>
          </div>
        )}
      </td>
      {/* ── numeric columns (centered over fixed-width cells) ── */}
      {/* MINTS — count of mints for this collection seen inside the
          currently-selected timeframe window (5M / 10M / 15M / 30M /
          1H / 4H / 1D). Matches the LIVE MINT FEED scope; was
          previously the cumulative session count which made the
          timeframe pill feel non-functional. Tooltip spells out the
          timeframe + falls back to the cumulative number for context. */}
      {(() => {
        const tfCount = tfStatsByKey.get(r.groupingKey)?.count ?? 0;
        const tip = `${tfCount.toLocaleString()} mint(s) in last ${mintTf}` +
          ` · ${r.observedMints.toLocaleString()} since session start`;
        return (
          <td
            
            // Same green family as RATE (#5ce0a0) but softer — keeps
            // MINTS in the same family visually while leaving RATE
            // the brightest value. fontWeight 800 stays unchanged so
            // the column still reads heavy / structural.
            style={{ padding: 'var(--table-row-pad, 14px 10px)', textAlign: 'center', verticalAlign: 'middle', fontSize: 14, fontWeight: 800, color: '#7ed9a8', letterSpacing: '-0.2px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
          >
            {tfCount.toLocaleString()}
          </td>
        );
      })()}
      {/* SUPPLY — planned cap when known (LMNFT path, from the
          homepage scraper / on-chain decoder); otherwise the running
          on-chain `num_minted` count for MPL Core collections (Core /
          VVV / GRAVE rows), which the backend pulls from each
          collection's CollectionV1 account on a 30 s cadence and
          seeds with the optimistic session-local count between
          refreshes. Unverified (optimistic) values render slightly
          muted so they read as "still resolving". Bright row colour
          matches the MINTS column so the table reads as a single
          tier of values rather than a ladder of fade levels. */}
      {(() => {
        const cap = typeof r.maxSupply === 'number' && r.maxSupply > 0 ? r.maxSupply : null;
        // Prefer `supplyMinted` (on-chain CollectionV1.num_minted via the
        // core-supply refresher, or items_redeemed from the CMv3 state
        // decoder — both authoritative). Fall back to `mintedCount`
        // (DAS searchAssets resolved count on the LMNFT path) when the
        // primary is null — covers the case where a quiet LMNFT-Core
        // row has neither an observed mint this process lifetime nor
        // a fresh 30s refresher tick yet, but its DAS-resolved count
        // is already on the wire. Same field is preserved in MintStatus
        // (types.ts: `mintedCount?: number | null`), no backend change.
        const minted = (typeof r.supplyMinted === 'number' && r.supplyMinted >= 0) ? r.supplyMinted
                     : (typeof r.mintedCount  === 'number' && r.mintedCount  >= 0) ? r.mintedCount
                     : null;
        const mintedFromFallback = minted !== null
          && !(typeof r.supplyMinted === 'number' && r.supplyMinted >= 0);
        const verified = r.supplyVerified === true && !mintedFromFallback;
        let display: string;
        let title: string;
        // SUPPLY sits below MINTS + RATE in the visual hierarchy:
        // muted by default, even quieter when the value is still
        // optimistic (not yet refreshed from on-chain). Verified /
        // cap-known cases use the same secondary-tier gray;
        // unverified drops another step so the "still resolving"
        // state reads as in-flight without being unreadable.
        let color = '#a8a6c4';
        const mintedLabel = mintedFromFallback ? 'DAS-resolved' : (verified ? 'verified on-chain' : 'optimistic — awaiting on-chain refresh');
        if (minted !== null && cap !== null) {
          // Both known — visible cell shows ONLY the current minted
          // count; the "minted / max (pct)" detail moves into the
          // tooltip. The previous "2 222 / 5 533" form crowded the
          // column at glance; the value users actually need is the
          // current count, with the cap available on hover.
          // Percent: integer when >= 10%, one decimal below that, so a
          // sub-1% drop reads as "0.4%" not "0%". cap is guaranteed
          // > 0 here (typed check above), so no divide-by-zero.
          const pct = (minted / cap) * 100;
          const pctText = !Number.isFinite(pct)
            ? '—'
            : pct >= 10 ? `${Math.round(pct)}%`
            : `${pct.toFixed(1)}%`;
          display = minted.toLocaleString();
          title   = `Minted: ${minted.toLocaleString()} / ${cap.toLocaleString()} (${pctText}) — ${mintedLabel}`;
          if (!verified) color = '#7c7a98';
        } else if (cap !== null) {
          display = cap.toLocaleString();
          title   = 'Max supply for this collection';
        } else if (minted !== null) {
          display = minted.toLocaleString();
          title   = mintedFromFallback
            ? `DAS-resolved minted count for this collection`
            : (verified
                ? `On-chain num_minted from CollectionV1 (verified)`
                : `Minted so far (optimistic — awaiting on-chain refresh)`);
          if (!verified) color = '#7c7a98';
        } else {
          display = '—';
          title   = `Supply unavailable — observed ${r.observedMints.toLocaleString()} mint(s)`;
        }
        return (
          <td
            
            style={{ padding: 'var(--table-row-pad, 14px 10px)', textAlign: 'center', verticalAlign: 'middle', fontSize: 13, color, fontWeight: 700, fontFamily: "'SF Mono','Fira Code',monospace", fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
          >
            {display}
          </td>
        );
      })()}
      <td style={{ padding: 'var(--table-row-pad, 14px 10px)', textAlign: 'center', verticalAlign: 'middle', fontSize: 12.5, color: '#f0eef8', fontWeight: 600, whiteSpace: 'nowrap' }}>
        {fmtAge(r.lastMintAt)}
      </td>
      {/* PRICE — latest observed mint price for this collection.
          Source is the most recent event for the groupingKey from
          the live-feed ring buffer (newest-first), surfaced via
          `lastPriceByKey`. NOT an average — launchpads run phased
          pricing (OG / WL / Public) and an average would mix
          stages. The cell updates the moment a new event with a
          different price arrives. Display tiers:
            null / map miss → "—" (muted, dim — no mint observed yet)
            0 lamports      → "FREE" (green family)
            > 0 lamports    → fmtSol value (default muted-bright,
                              mirrors SUPPLY column tone) */}
      {(() => {
        const price     = lastPriceByKey.get(r.groupingKey);
        const solDisplay = (typeof price === 'number') ? fmtSol(price) : '—';
        const isUnknown = solDisplay === '—';
        const isFree    = solDisplay === 'FREE';
        const payment   = lastPaymentByKey?.get(r.groupingKey) ?? null;
        const tokenInfo = payment ? paymentTokens?.get(payment.mint) ?? null : null;
        // Format the token amount with the mint's decimals — keep at most
        // 4 fractional digits and trim trailing zeros so a 1000.000000
        // payment reads as "1000". Tabular-nums fixes alignment.
        const tokenAmount = payment
          ? formatTokenAmount(payment.amount, payment.decimals)
          : null;
        const tokenLabel  = tokenInfo?.symbol?.trim() || shortKey(payment?.mint ?? '');
        const display = (payment && showInToken && tokenAmount != null)
          ? `${tokenAmount} ${tokenLabel}`
          : solDisplay;
        const cellColor = isFree     ? '#5ce0a0'
                        : isUnknown  ? '#45455e'
                        : payment    ? '#c9bdf0'
                        :              '#a8a6c4';
        const tip = isUnknown
          ? `No mint price observed yet for this collection`
          : isFree
            ? `Latest observed mint: FREE`
            : payment
              ? `Mint paid in ${tokenInfo?.name ?? tokenLabel} (${tokenLabel}). SOL value shown is rent on the new asset, not the real price. Click the token icon to toggle.`
              : `Latest observed mint price: ${solDisplay} SOL · not averaged — updates when a new mint event lands at a different price`;
        return (
          <td
            
            style={{ padding: 'var(--table-row-pad, 14px 10px)', textAlign: 'center', verticalAlign: 'middle', fontSize: 13, fontWeight: 600, color: cellColor, letterSpacing: '-0.1px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
              <span>{display}</span>
              {payment && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); setShowInToken(v => !v); }}
                  
                  aria-label="Toggle price currency"
                  aria-pressed={showInToken}
                  style={{
                    // Absolute 14×14 button — fixed size keeps the row
                    // height stable regardless of toggle state. transform:
                    // scale on hover is paint-only.
                    width: 14, height: 14, padding: 0,
                    border: showInToken ? '1px solid rgba(168,144,232,0.65)' : '1px solid rgba(168,144,232,0.28)',
                    borderRadius: '50%', background: 'rgba(168,144,232,0.10)',
                    cursor: 'pointer', display: 'inline-flex',
                    alignItems: 'center', justifyContent: 'center',
                    overflow: 'hidden', flexShrink: 0,
                    transition: 'transform 120ms ease-out, border-color 120ms ease-out, background 120ms ease-out',
                  }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1.12)'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.transform = 'scale(1)'; }}
                >
                  {tokenInfo?.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={tokenInfo.image} alt="" width={12} height={12}
                      style={{ width: 12, height: 12, borderRadius: '50%', objectFit: 'cover', display: 'block' }} />
                  ) : (
                    <span style={{ fontSize: 7, fontWeight: 800, color: '#a890e8', letterSpacing: 0, lineHeight: 1 }}>
                      {tokenLabel.slice(0, 1).toUpperCase()}
                    </span>
                  )}
                </button>
              )}
            </span>
          </td>
        );
      })()}
      {/* RATE — HEAT composite (Option C):
            throughput   = count / tfMinutes
            supplyMult   = 1 + clamp(count / max(supply, 50), 0, 1) × 4   (1× … 5×)
            recencyMult  = 0.5 + (mints in last ¼ of window / count)      (0.5× … 1.5×)
            HEAT         = throughput × supplyMult × recencyMult
          Option A's throughput-only formula reduced RATE to a near-
          clone of MINTS. HEAT brings in the two dimensions trader
          intuition actually weighs: how much of the planned supply
          got consumed (small-cap drops with strong fill outrank
          stale large-caps with sparse activity) and how recent the
          activity was in the window (late-window front-loaded beats
          first-quarter-and-die). With <2 mints we surface the raw
          count (0 or 1) so the cell isn't ever empty. Primary
          activity metric — green, weight 700. */}
      {(() => {
        const stats   = tfStatsByKey.get(r.groupingKey);
        const tfCount = stats?.count ?? 0;
        const rate    = stats?.mintPerMin ?? 0;
        const display = tfCount < 2
                       ? tfCount.toString()
                       : rate >= 10 ? rate.toFixed(0)
                       : rate >= 1  ? rate.toFixed(1)
                       : rate.toFixed(2);
        // Tooltip exposes the three multipliers so a power user can
        // see why a row scored what it did. supplyMult shows 1.00
        // when maxSupply is unknown (cNFT / unresolved launchpad).
        const tfMin       = MINT_TF_MS[mintTf] / 60_000;
        const throughput  = tfCount / tfMin;
        const supply      = (typeof r.maxSupply === 'number' && r.maxSupply > 0) ? r.maxSupply : null;
        const supplyFrac  = supply !== null ? Math.min(1, tfCount / Math.max(supply, 50)) : 0;
        const supplyMult  = 1 + supplyFrac * 4;
        const recencyMult = stats && stats.count > 0
          ? 0.5 + stats.recentQ / stats.count
          : 0.5;
        const tip = tfCount < 2
          ? `${tfCount} mint(s) in last ${mintTf} — not enough data for HEAT`
          : `HEAT ${display}  =  throughput ${throughput.toFixed(2)} × supply ×${supplyMult.toFixed(2)} × recency ×${recencyMult.toFixed(2)}`
            + `\n${tfCount.toLocaleString()} mints in last ${mintTf}`
            + (supply !== null ? ` · ${(supplyFrac * 100).toFixed(1)}% of ${supply.toLocaleString()}-supply` : '')
            + ` · ${(recencyMult >= 1 ? '+' : '−') }${Math.abs((recencyMult - 1) * 100).toFixed(0)}% recency`;
        return (
          <td
            
            style={{ padding: 'var(--table-row-pad, 14px 10px)', textAlign: 'center', verticalAlign: 'middle', fontSize: 14, fontWeight: 700, color: '#5ce0a0', letterSpacing: '-0.2px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
          >
            {display}
          </td>
        );
      })()}
    </tr>
  );
}
