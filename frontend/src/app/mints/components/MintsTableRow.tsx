// VictoryLabs — Mints: a single row in the COLLECTIONS table.
// Extracted from page.tsx so the page file stays maintainable. Same
// className stack, same style objects, same column order, same nested
// IIFEs for title / MINTS / SUPPLY / PRICE / RATE. The closure surface
// is small and explicit: row + index + now + mintTf + tfStatsByKey +
// lastPriceByKey. Status pill style consts live here because they
// have no other consumer; the SOURCE pill is the existing
// `<MintsSourceBadge>`.

import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ItemThumb } from '@/soloist/shared';
import { playUiSelect } from '@/soloist/use-ui-sound';
import type { MintStatus, MintTimeframe, MintsTimeframeStats, PaymentTokenInfo } from '../lib/types';
import { MINT_TF_MS } from '../lib/types';
import { colorForCollection, isSolPubkey } from '../lib/palette';
import { VL, VLText, rgb, alpha } from '@/lib/palette';
import { fmtAgeShort, fmtMintPrice, shortKey, thumb64, isNewCollection } from '../lib/format';
import { MintsSourceBadge } from './MintsSourceBadge';
import { NewCollectionBadge } from './NewCollectionBadge';

// ── Shared floating-popover (glass panel) styles ────────────────────
// Tight premium stats-card shared by the MINTS + SUPPLY hover popovers:
// deep gradient body, clear purple border, soft glow + drop shadow,
// backdrop blur. Compact — no footer/helper paragraph. Values dominate
// (large, bright); labels are small + muted. Layout positions/flip
// behavior are unchanged — only the surface skin + content density.
const POPOVER_PANEL_STYLE: React.CSSProperties = {
  position:               'fixed',
  zIndex:                 9999,
  pointerEvents:          'none',
  minWidth:               160,
  background:             'linear-gradient(158deg, rgba(30,23,52,0.97) 0%, rgba(17,13,30,0.97) 100%)',
  border:                 `1px solid ${alpha(VL.purpleTint,0.46)}`,
  borderRadius:           9,
  padding:                '9px 12px 10px',
  textAlign:              'left',
  color:                  '#ece7f8',
  boxShadow:              `0 12px 30px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.32), 0 0 16px ${alpha(VL.purpleDeep,0.15)}`,
  backdropFilter:         'blur(11px)',
  WebkitBackdropFilter:   'blur(11px)',
};
const POPOVER_HEADER_STYLE: React.CSSProperties = {
  fontSize:       9.5,
  fontWeight:     700,
  letterSpacing:  '1.3px',
  textTransform:  'uppercase',
  color:          '#8a81b0',
  marginBottom:   7,
  paddingBottom:  6,
  borderBottom:   `1px solid ${alpha(VL.purpleTint,0.15)}`,
};
/** A single label-left / value-right row inside a popover panel. The value
 *  dominates (large, bright, monospace + tabular); the label is small and
 *  muted. `highlight` makes the value the brightest accent in the card. */
function PopRow({ label, value, highlight }: { label: string; value: string; highlight?: boolean }): JSX.Element {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 22, padding: '2px 0' }}>
      <span style={{ fontSize: 10.5, fontWeight: 500, letterSpacing: '0.2px', color: '#7e7799', whiteSpace: 'nowrap' }}>{label}</span>
      <span style={{
        fontSize:           highlight ? 15 : 14,
        fontWeight:         highlight ? 800 : 700,
        color:              highlight ? '#cdc2f2' : '#f2eefb',
        fontFamily:         "'SF Mono','Fira Code',monospace",
        fontVariantNumeric: 'tabular-nums',
        lineHeight:         1.15,
        whiteSpace:         'nowrap',
      }}>{value}</span>
    </div>
  );
}

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
  color:      rgb(VL.green),
  background: alpha(VL.greenGlow,0.14),
  border:     `1px solid ${alpha(VL.greenGlow,0.42)}`,
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
  color:      rgb(VL.red),
  background: alpha(VL.redGlow,0.12),
  border:     `1px solid ${alpha(VL.redGlow,0.45)}`,
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
  // Custom hover popover for the SUPPLY cell — replaces the native title
  // tooltip we stripped globally. Portaled to <body> with position:fixed
  // so the popover escapes any table / scroll-container overflow clip
  // and is never visually truncated. State carries the cell's viewport
  // rect + a flip flag (true = render below the cell when there's not
  // enough room above).
  const supplyCellRef = useRef<HTMLTableCellElement | null>(null);
  const [supplyHover, setSupplyHover] = useState<null | { x: number; y: number; flip: boolean }>(null);
  const openSupplyPopover = () => {
    const el = supplyCellRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Estimate ~150 px max popover height (header + up to 4 compact rows
    // + padding/border). If the cell's top doesn't have at least that much
    // room above the viewport, flip to render below the cell.
    const flip = r.top < 150;
    setSupplyHover({
      x: r.left + r.width / 2,
      y: flip ? r.bottom + 6 : r.top - 6,
      flip,
    });
  };
  const closeSupplyPopover = () => setSupplyHover(null);
  // MINTS-cell popover — same portaled/flip pattern as SUPPLY. Clarifies that
  // the column shows DISPLAYED (sampled) feed cards vs the true observed count,
  // so a high-velocity collection doesn't read as "mints lost".
  const mintsCellRef = useRef<HTMLTableCellElement | null>(null);
  const [mintsHover, setMintsHover] = useState<null | { x: number; y: number; flip: boolean }>(null);
  const openMintsPopover = () => {
    const el = mintsCellRef.current;
    if (!el) return;
    const r2 = el.getBoundingClientRect();
    const flip = r2.top < 150;
    setMintsHover({ x: r2.left + r2.width / 2, y: flip ? r2.bottom + 6 : r2.top - 6, flip });
  };
  const closeMintsPopover = () => setMintsHover(null);
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
      className={`mints-tracker-row mints-tracker-row-${rowState} tools-offer-row${isFreshMint ? ' row-flash-up' : ''}${isBurst && rowState === 'active' ? ' mints-tracker-row-burst' : ''}`}
      // Hover-pause fires from the row body only (mouseenter/leave do not
      // bubble through children), so passing through child cells / icons
      // never produces a leave/enter flicker.
      onMouseEnter={onPauseEnter}
      onMouseLeave={onPauseLeave}
      // Row hover no longer scopes the live feed — only the SHOW button does
      // (onHoverEnter/onHoverLeave are wired to SHOW below). The CSS hover
      // lift (tools-offer-row) still applies on row hover.
      style={{
        // Softened further (0.022 → 0.014) so the separators recede just
        // enough to let the ambient accent wash breathe and the rows feel
        // less boxed-in — still a visible 1 px hairline keeping table
        // structure intact, not removed.
        borderBottom: '1px solid rgba(255,255,255,0.022)',
        // Full opacity across all states — the WATCH / ACTIVE /
        // SOLD distinction is already conveyed by the inline status
        // pill, so dimming the row body only made images and values
        // look washed out.
        opacity: 1,
        // Burst-promoted rows ("fire/hot collection" historical marker)
        // emphasise via top + bottom 1 px warm-amber bars painted by the
        // `.mints-tracker-row-burst` class (CSS box-shadow inset). The
        // earlier `outline` approach drew all four sides as a rectangle,
        // which read as a boxed card and broke the horizontal-emphasis
        // language of every other row. Left rail/accent (in-cell, see
        // COLLECTION td) stays intact; right side now blends into the
        // table content edge like every other row.
      }}
    >
      {/* COLLECTION cell — matches Dashboard rows: 12px vertical
          padding (up from /mints' previous compact 8px to align with
          /dashboard rhythm), 38 px ItemThumb, 15 px name. Left accent
          stripe (3 px, deterministic per collectionAddress) so rows
          from the same collection are visually grouped at a glance. */}
      <td style={{ padding: '11px 8px 11px 9px', verticalAlign: 'middle', position: 'relative' }}>
        {/* Soft accent-into-row glow — a low-alpha (~0.03) horizontal fade that
            bleeds the collection accent off the left marker into the row body, so
            the strong left stripe reads as integrated with the row rather than a
            detached bar. ~150px wide, fully faded before mid-row. Behind content. */}
        <span aria-hidden="true" style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 150, background: `linear-gradient(90deg, ${accentColor}08 0%, transparent 100%)`, pointerEvents: 'none' }} />
        {/* Base rail (in-cell, faint constant track under the colored marker). */}
        <span aria-hidden="true" style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: alpha(VL.purpleTint,0.045), pointerEvents: 'none' }} />
        {/* Left status marker — PRIMARY row indicator. Strong 3px full-height
            per-state collection color (opaque / `cc` on watch). */}
        <span aria-hidden="true" style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, background: accentBorderColor, boxShadow: `0 0 5px ${accentColor}59`, pointerEvents: 'none' }} />
        {/* Fixed-slot CSS grid for the identity area — children DON'T flow:
            [rank 22][image 46][status 22][name 100][icons+source + SHOW (1fr)].
            Status track was 66 px to fit the old ACTIVE/WATCH labels; after
            the A/W/S compaction the badge renders at ~22 px so the reserved
            track shrinks to match, pulling collection names left. Every row's
            name start-x remains identical because the status track stays a
            fixed pixel width (not `auto`). Other tracks and columnGap are
            untouched. */}
        <div style={{ display: 'grid', gridTemplateColumns: '22px 46px 22px 100px 1fr', alignItems: 'center', columnGap: 6 }}>
          <span style={{ width: 22, height: 34, display: 'flex', alignItems: 'center', justifyContent: 'center', color: VLText.muted, fontSize: 12, fontWeight: 500, fontFamily: "'SF Mono','Fira Code',monospace" }}>{i + 1}</span>
          <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
          {/* NEW — circular indicator overlaid on the thumbnail (UI-only). */}
          {isNewCollection(r.collectionCreatedAt, r.firstSeenAt) && <NewCollectionBadge />}
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
                color: VLText.primary, textDecoration: 'none', cursor: titleHref ? 'pointer' : 'default',
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
                Prefer stableMintAddress (>= 3 min old, metadata already
                indexed) over lastMintAddress (brand-new, may show as
                "unknown" on ME). Falls back to lastMintAddress when
                stable isn't populated yet (collection too new). */}
            {isSolPubkey(r.stableMintAddress ?? r.lastMintAddress) && (
              <a
                href={`https://magiceden.io/item-details/${r.stableMintAddress ?? r.lastMintAddress}`}
                target="_blank"
                rel="noopener noreferrer"
                
                style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 0, flexShrink: 0, opacity: 0.85, textDecoration: 'none' }}
                onClick={(e) => e.stopPropagation()}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/brand/me.png" alt="ME" width={13} height={13} draggable={false} style={{ display: 'block', borderRadius: 2 }} />
              </a>
            )}
            {/* Tensor badge — same stable-address logic as ME above.
                `/item/{mint}` always loads an item page from which
                the user can navigate up to the collection. */}
            {isSolPubkey(r.stableMintAddress ?? r.lastMintAddress) && (
              <a
                href={`https://www.tensor.trade/item/${r.stableMintAddress ?? r.lastMintAddress}`}
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
                const t = b.firstElementChild as HTMLElement | null; if (t) { t.style.color = VLText.faint; t.style.textShadow = 'none'; }
              }
            }}
            style={{
              // Absolutely-positioned fill so the action strip spans the
              // ENTIRE row content height (td → row stretches all cells
              // to the tallest sibling's height; abs child with top/bottom
              // 0 inherits that height exactly). The container is anchored to
              // the RIGHT of the (wide, flexible) SHOW cell with left:auto +
              // right:8, and sized to its content (fit-content) so it hugs the
              // SHOW label and its right edge sits ~8 px before MINTS — instead
              // of filling the cell and letting the centered label float in the
              // mid-cell void. All the empty space falls on the COLLECTION side,
              // independent of how wide the flexible SHOW cell gets.
              position: 'absolute', top: 0, bottom: 0, left: 'auto', right: -16,
              // Right-anchored action zone that fills the gap up to a 180px cap.
              // min(calc(100% - 16px), 180px): on narrow SHOW cells it fills the
              // gap (minus the L/R insets); on wide desktop cells it stops at
              // 180px so the centered label stays gap-like instead of floating
              // mid-cell. right:-16 pushes the zone 16px past the cell edge,
              // overlapping into the MINTS column. Grows LEFT only.
              width: 'min(calc(100% - 16px), var(--mints-show-zone-max, 180px))',
              // SHOW label centered inside the action container.
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', userSelect: 'none',
              // borderRadius:0 kills the floating-rounded-button silhouette.
              // Idle = no inset outline (zone blends into the row); hover/
              // pinned bring the inset ring back so the zone reads as
              // active. Rectangular action band, never a card.
              borderRadius: 0,
              background: isPinned
                // Pinned (active) state kept distinctly purple so the
                // affordance still reads when toggled on.
                ? 'linear-gradient(90deg, rgba(128,104,216,0.06) 0%, rgba(140,112,228,0.20) 28%, rgba(155,124,240,0.34) 50%, rgba(140,112,228,0.20) 72%, rgba(128,104,216,0.06) 100%)'
                // Idle initial-render value matches the post-hover resting
                // style below (the onMouseLeave target) — three states stay:
                // idle/after-hover (this), :hover (brighter, imperative
                // above), pinned. Was dimmer (0.018/0.025) before first
                // hover; bumped to match so idle doesn't visibly jump the
                // first time the row is touched.
                : 'linear-gradient(90deg, rgba(128,104,216,0) 0%, rgba(128,104,216,0.04) 28%, rgba(128,104,216,0.06) 50%, rgba(128,104,216,0.04) 72%, rgba(128,104,216,0) 100%)',
              boxShadow: isPinned ? 'inset 0 0 0 1px rgba(188,160,246,0.42), inset 0 0 18px rgba(155,124,240,0.18)' : 'none',
              transition: 'background 160ms ease, box-shadow 160ms ease',
            }}
          >
            <span style={{
              // Dim color: VLText.faint (tertiary-label tone) — a near-exact
              // token match for the old hardcoded #6e6688. VLText.muted
              // (#9A9AB4, same tone as regular body text) made SHOW compete
              // with everything else on the row instead of receding as a
              // secondary action.
              fontSize: 9.5, fontWeight: 600, letterSpacing: '0.6px', textTransform: 'uppercase',
              whiteSpace: 'nowrap', transition: 'color 160ms ease, text-shadow 160ms ease',
              color: isPinned ? '#ffffff' : VLText.faint,
              textShadow: isPinned ? '0 0 10px rgba(188,160,246,0.55)' : 'none',
            }}>SHOW</span>
          </div>
        )}
      </td>
      {/* ── numeric columns (centered over fixed-width cells) ── */}
      {/* MINTS — count of mints for this collection seen inside the
          currently-selected timeframe window (5M / 15M / 30M /
          1H / 4H / 24H). Matches the LIVE MINT FEED scope; was
          previously the cumulative session count which made the
          timeframe pill feel non-functional. Tooltip spells out the
          timeframe + falls back to the cumulative number for context. */}
      {(() => {
        const tfStats  = tfStatsByKey.get(r.groupingKey);
        const tfCount  = tfStats?.count  ?? 0;
        const inFeed   = tfStats?.inFeed ?? null;
        // Tooltip: per-collection breakdown for this TF.
        // Detected = unsampled total (accumulator minute buckets, 0 right after restart).
        // In feed  = sampled feed cards stored in mint_events (may undercount bursts).
        // Ratio only shown when tfCount > inFeed — means memory buckets have real data
        // beyond what the DB recorded (burst mints were sampled out). When equal, either
        // cold-start or no sampling occurred — ratio would be 100% which is misleading.
        const showRatio = inFeed !== null && tfCount > inFeed;
        const ratioPct  = showRatio ? (inFeed / tfCount) * 100 : null;
        const ratioText = ratioPct === null ? null
          : ratioPct >= 10 ? `${Math.round(ratioPct)}%`
          : `${ratioPct.toFixed(1)}%`;
        return (
          <>
            <td
              ref={mintsCellRef}
              tabIndex={0}
              onMouseEnter={openMintsPopover}
              onMouseLeave={closeMintsPopover}
              onFocus={openMintsPopover}
              onBlur={closeMintsPopover}
              style={{ padding: '11px 10px', textAlign: 'center', verticalAlign: 'middle', fontSize: 14, fontWeight: 800, color: rgb(VL.green), letterSpacing: '-0.2px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
            >
              {tfCount.toLocaleString()}
            </td>
            {mintsHover && typeof document !== 'undefined' && createPortal(
              <div
                role="tooltip"
                style={{
                  ...POPOVER_PANEL_STYLE,
                  top:  mintsHover.y,
                  left: mintsHover.x,
                  transform: mintsHover.flip ? 'translateX(-50%)' : 'translate(-50%, -100%)',
                }}
              >
                {/* UX audit (H3): the metrics below are scoped to the active
                    timeframe pill (mintTf drives tfCount/inFeed upstream), but
                    the header didn't say so — a user had no way to tell
                    "Detected 745" meant "in the last 1H" vs. lifetime. */}
                <div style={POPOVER_HEADER_STYLE}>Mint stats · {mintTf}</div>
                <PopRow label="Detected" value={tfCount.toLocaleString()} />
                {inFeed   !== null && <PopRow label="In feed"  value={inFeed.toLocaleString()} />}
                {ratioText !== null && <PopRow label="Feed ratio" value={ratioText} highlight />}
              </div>,
              document.body
            )}
          </>
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
        // Popover content (replaces the old native `title` text). Built
        // as compact label/value rows — values dominate, no provenance
        // footer. Essential rows only: Minted / Cap / Progress when known,
        // otherwise just Minted.
        const popRows: { label: string; value: string; highlight?: boolean }[] = [];
        // SUPPLY sits below MINTS + RATE in the visual hierarchy:
        // muted by default, even quieter when the value is still
        // optimistic (not yet refreshed from on-chain). Verified /
        // cap-known cases use the same secondary-tier gray;
        // unverified drops another step so the "still resolving"
        // state reads as in-flight without being unreadable.
        let color: string = VLText.muted;
        if (minted !== null && cap !== null) {
          // Both known — visible cell shows ONLY the current minted
          // count; "minted / cap (pct)" lives in the hover popover.
          // Percent: integer when >= 10%, one decimal below that, so a
          // sub-1% drop reads as "0.4%" not "0%". cap is guaranteed
          // > 0 here, so no divide-by-zero.
          const pct = (minted / cap) * 100;
          const pctText = !Number.isFinite(pct)
            ? '—'
            : pct >= 10 ? `${Math.round(pct)}%`
            : `${pct.toFixed(1)}%`;
          display     = minted.toLocaleString();
          popRows.push({ label: 'Minted', value: minted.toLocaleString() });
          popRows.push({ label: 'Cap', value: cap.toLocaleString() });
          popRows.push({ label: 'Progress', value: pctText, highlight: true });
          if (!verified) color = '#7c7a98';
        } else if (cap !== null) {
          display = cap.toLocaleString();
          popRows.push({ label: 'Cap', value: cap.toLocaleString(), highlight: true });
        } else if (minted !== null) {
          display = minted.toLocaleString();
          popRows.push({ label: 'Minted', value: minted.toLocaleString(), highlight: true });
          if (!verified) color = '#7c7a98';
        } else {
          display = '—';
          popRows.push({ label: 'Supply', value: '—', highlight: true });
        }
        return (
          <>
            <td
              ref={supplyCellRef}
              tabIndex={0}
              onMouseEnter={openSupplyPopover}
              onMouseLeave={closeSupplyPopover}
              onFocus={openSupplyPopover}
              onBlur={closeSupplyPopover}
              style={{ padding: '11px 10px', textAlign: 'center', verticalAlign: 'middle', fontSize: 13, color, fontWeight: 700, fontFamily: "'SF Mono','Fira Code',monospace", fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
            >
              {display}
            </td>
            {supplyHover && typeof document !== 'undefined' && createPortal(
              <div
                role="tooltip"
                style={{
                  // Fixed-position + portaled to <body> ⇒ ignores every
                  // ancestor's overflow / transform / z-index stack.
                  ...POPOVER_PANEL_STYLE,
                  top:  supplyHover.y,
                  left: supplyHover.x,
                  // Default: above the cell (translate up by 100% of own
                  // height + center horizontally). Flip = below the cell
                  // (only translate horizontally; y is already cell.bottom+6).
                  transform: supplyHover.flip ? 'translateX(-50%)' : 'translate(-50%, -100%)',
                }}
              >
                <div style={POPOVER_HEADER_STYLE}>Supply</div>
                {popRows.map((row) => (
                  <PopRow key={row.label} label={row.label} value={row.value} highlight={row.highlight} />
                ))}
              </div>,
              document.body
            )}
          </>
        );
      })()}
      <td style={{ padding: '11px 10px', textAlign: 'center', verticalAlign: 'middle', fontSize: 12.5, color: VLText.primary, fontWeight: 600, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
        {fmtAgeShort(r.lastMintAt)}
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
        // Deploy-only collection (collection-CREATE observed, no mints yet —
        // see the matching `observedMints === 0` check in MintsSourceBadge).
        // There is no mint price to show; render the same "deploy" label the
        // Live Mint Feed card shows in its price slot for a deploy event,
        // instead of the bare unpriced "—".
        if (r.observedMints === 0) {
          return (
            <td
              title="Collection deployed — no mints yet"
              style={{ padding: '11px 10px', textAlign: 'center', verticalAlign: 'middle', fontSize: 13, fontWeight: 600, color: VLText.muted, letterSpacing: '-0.1px', whiteSpace: 'nowrap' }}
            >
              deploy
            </td>
          );
        }
        const price     = lastPriceByKey.get(r.groupingKey);
        const solDisplay = (typeof price === 'number') ? fmtMintPrice(price) : '—';
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
        const cellColor = isFree     ? rgb(VL.green)
                        : isUnknown  ? '#241f3b'
                        :              '#ffffff';
        const tip = isUnknown
          ? `No mint price observed yet for this collection`
          : isFree
            ? `Latest observed mint: FREE`
            : payment
              ? `Mint paid in ${tokenInfo?.name ?? tokenLabel} (${tokenLabel}). SOL value shown is rent on the new asset, not the real price. Click the token icon to toggle.`
              : `Latest observed mint price: ${solDisplay} SOL · not averaged — updates when a new mint event lands at a different price`;
        return (
          <td
            // UX audit (M8): `tip` was already computed with the right
            // explanatory copy ("No mint price observed yet…") but was
            // never wired to the cell, so the bare "—" for an unpriced
            // collection looked identical to missing/broken data. A
            // native title tooltip is the minimal fix — no new UI, no
            // price-logic change.
            title={tip}
            style={{ padding: '11px 10px', textAlign: 'center', verticalAlign: 'middle', fontSize: 13, fontWeight: 600, color: cellColor, letterSpacing: '-0.1px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
              <span>
                {(payment && showInToken && tokenAmount != null) ? (
                  <>
                    {tokenAmount}{' '}
                    {/* token name → Solscan token page; only the name is
                        clickable, styling inherited so no layout change. */}
                    <a
                      href={`https://solscan.io/token/${payment.mint}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      title={`View ${tokenLabel} on Solscan`}
                      style={{ color: 'inherit', textDecoration: 'none', cursor: 'pointer' }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'underline'; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'none'; }}
                    >{tokenLabel}</a>
                  </>
                ) : display}
              </span>
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
                    border: showInToken ? `1px solid ${alpha(VL.purpleTint,0.65)}` : `1px solid ${alpha(VL.purpleTint,0.32)}`,
                    borderRadius: '50%', background: alpha(VL.purpleTint,0.10),
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
                    <span style={{ fontSize: 7, fontWeight: 800, color: rgb(VL.purpleTint), letterSpacing: 0, lineHeight: 1 }}>
                      {tokenLabel.slice(0, 1).toUpperCase()}
                    </span>
                  )}
                </button>
              )}
            </span>
          </td>
        );
      })()}
      {/* CREATED — prefer the on-chain collection creation timestamp
          (resolver landed real blockTime from the earliest gSFA
          signature); fall back to firstSeenAt (= accumulator's
          firstObservedAt) for rows the resolver hasn't covered yet
          or that have no collectionAddress. Muted gray to match
          SUPPLY / PRICE tone; same right-side padding the prior RATE
          column used so the value doesn't hug the table edge. */}
      <td
        style={{ padding: '11px 18px 11px 10px', textAlign: 'center', verticalAlign: 'middle', fontSize: 12.5, color: VLText.muted, fontWeight: 600, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
      >
        {fmtAgeShort(r.collectionCreatedAt ?? r.firstSeenAt)}
      </td>
    </tr>
  );
}
