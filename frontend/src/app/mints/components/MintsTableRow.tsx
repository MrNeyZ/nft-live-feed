// VictoryLabs — Mints: a single row in the COLLECTIONS table.
// Extracted from page.tsx so the page file stays maintainable. JSX is
// byte-identical to the prior inline block — same className stack,
// same style objects, same column order, same nested IIFEs for title /
// MINTS / SUPPLY / COEF / RATE. The closure surface is small and
// explicit: row + index + now + mintTf + tfStatsByKey + computeCoef.
// Status pill style consts live here because they have no other
// consumer; the SOURCE pill is the existing `<MintsSourceBadge>`.

import { ItemThumb } from '@/soloist/shared';
import type { MintStatus, MintTimeframe, MintsTimeframeStats } from '../lib/types';
import { colorForCollection, isSolPubkey } from '../lib/palette';
import { fmtAge, shortKey, thumb64 } from '../lib/format';
import { MintsSourceBadge } from './MintsSourceBadge';

/** Per-row status pill in the COLLECTION cell. ACTIVE = promoted
 *  (`displayState === 'shown'`); WATCH = incubating (pre-burst,
 *  surfaced here so the table isn't empty when traffic is sparse).
 *  Compact 9 px font + flexShrink: 0 so it never wraps off the row. */
const STATUS_BADGE_BASE: React.CSSProperties = {
  display:        'inline-block',
  padding:        '1px 5px',
  fontSize:       9,
  fontWeight:     800,
  letterSpacing:  '0.5px',
  borderRadius:   3,
  textTransform:  'uppercase',
  flexShrink:     0,
  lineHeight:     '13px',
};
const STATUS_BADGE_ACTIVE: React.CSSProperties = {
  ...STATUS_BADGE_BASE,
  color:      '#5ce0a0',
  background: 'rgba(92,224,160,0.14)',
  border:     '1px solid rgba(92,224,160,0.42)',
};
const STATUS_BADGE_WATCH: React.CSSProperties = {
  ...STATUS_BADGE_BASE,
  color:      '#c9a820',
  background: 'rgba(201,168,32,0.10)',
  border:     '1px solid rgba(201,168,32,0.32)',
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
  computeCoef:  (r: MintStatus) => number;
}

export function MintsTableRow({ row: r, index: i, now, mintTf, tfStatsByKey, computeCoef }: Props) {
  // Belt-and-suspenders against whitespace-only names that pre-date
  // the backend trim (still cached in localStorage) or that slip
  // through any future enrichment path. `??` alone wouldn't catch
  // "                                " (32 spaces) — that's truthy,
  // would render as blank.
  const trimmed = r.name?.trim();
  const displayName = (trimmed && trimmed.length > 0)
    ? trimmed
    : shortKey(r.groupingKey);
  const isBurst = r.shownReason === 'burst';
  // ACTIVE = promoted (`shown`), WATCH = pre-burst (`incubating`).
  // Drives the inline status pill below and a faint row dim on WATCH
  // so ACTIVE rows stay visually dominant. Threshold/burst logic in
  // the backend accumulator is unchanged.
  const isActive = r.displayState === 'shown';
  const accentColor = colorForCollection(r.collectionAddress ?? r.groupingKey);
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
      <td style={{ padding: '14px 8px 14px 12px', verticalAlign: 'middle', borderLeft: `3px solid ${accentBorderColor}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ color: '#8a8aa6', fontSize: 12, fontWeight: 500, fontFamily: "'SF Mono','Fira Code',monospace", minWidth: 18, textAlign: 'right' }}>{i + 1}</span>
          <ItemThumb
            imageUrl={thumb64(r.imageUrl ?? null)}
            color={colorForCollection(r.collectionAddress ?? r.groupingKey)}
            abbr={(displayName[0] ?? '?').toUpperCase() + (displayName[1] ?? '').toUpperCase()}
            size={42}
          />
          <span style={{ fontSize: 16, fontWeight: 600, color: '#f0eef8', letterSpacing: '-0.2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
            {/* Status pill priority: SOLD > ACTIVE > WATCH.
                SOLD (red, site-consistent) when the launchpad-known
                maxSupply is met or exceeded; ACTIVE (saturated
                green) for backend-promoted rows; WATCH (muted
                amber) for incubating rows. Inline before the name —
                no extra column, no layout shift. */}
            {isSoldOut ? (
              <span
                title={
                  `Sold out — ${r.observedMints.toLocaleString()} of ` +
                  `${(r.maxSupply ?? 0).toLocaleString()} minted`
                }
                style={STATUS_BADGE_SOLD}
              >SOLD</span>
            ) : isActive ? (
              <span title={isBurst ? 'Promoted via burst (≥ 8 mints / 60 s)' : 'Promoted via 50-mint threshold'} style={STATUS_BADGE_ACTIVE}>ACTIVE</span>
            ) : (
              <span title="Incubating — not yet at burst / threshold" style={STATUS_BADGE_WATCH}>WATCH</span>
            )}
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
              const titleInner = (<>{displayName}</>);
              const titleStyle: React.CSSProperties = {
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
                color: '#f0eef8', textDecoration: 'none', cursor: titleHref ? 'pointer' : 'default',
              };
              return titleHref ? (
                <a
                  href={titleHref}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={`Solscan · ${titleAnchor}`}
                  style={titleStyle}
                  onClick={(e) => e.stopPropagation()}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'underline'; }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'none'; }}
                >{titleInner}</a>
              ) : (
                <span style={titleStyle}>{titleInner}</span>
              );
            })()}
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
                title={`Magic Eden · last mint ${r.lastMintAddress}`}
                style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 0, flexShrink: 0, opacity: 0.85, textDecoration: 'none' }}
                onClick={(e) => e.stopPropagation()}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/brand/me.png" alt="ME" width={12} height={12} draggable={false} style={{ display: 'block', borderRadius: 2 }} />
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
                title={`Tensor · last mint ${r.lastMintAddress}`}
                style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 0, flexShrink: 0, opacity: 0.85, textDecoration: 'none' }}
                onClick={(e) => e.stopPropagation()}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/brand/tensor.png" alt="Tensor" width={12} height={12} draggable={false} style={{ display: 'block', borderRadius: 2 }} />
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
                title={`X · live search "${trimmed}"`}
                style={{ display: 'inline-flex', alignItems: 'center', lineHeight: 0, flexShrink: 0, opacity: 0.85, textDecoration: 'none' }}
                onClick={(e) => e.stopPropagation()}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/brand/x.png" alt="X" width={12} height={12} draggable={false} style={{ display: 'block', borderRadius: 2 }} />
              </a>
            )}
            <MintsSourceBadge row={r} />
            {r.isCoreCollection && (
              // COLL marker — only fires for MPL Core CreateCollection
              // events (DAS interface `MplCoreCollection`). Sibling pill
              // alongside the regular source badge so the LMNFT / CORE
              // identity stays visible while the operator gets a clear
              // "this is a collection-setup event, not a mint" cue.
              // Lilac fg/bg inside the Core/violet family so it doesn't
              // read as alert; bg α 0.10 (lighter than CORE's 0.15) so
              // the marker reads as annotation rather than primary
              // identity.
              <span
                title="Core collection-creation event — not a regular mint"
                style={{
                  display: 'inline-block', padding: '1px 6px', fontSize: 9, fontWeight: 700,
                  borderRadius: 3, background: 'rgba(168,144,232,0.10)', color: '#a890e8',
                  border: '1px solid rgba(168,144,232,0.32)', letterSpacing: '0.4px',
                  flexShrink: 0, lineHeight: '13px', textTransform: 'uppercase',
                }}
              >COLL</span>
            )}
          </span>
        </div>
      </td>
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
            title={tip}
            // Same green family as RATE (#5ce0a0) but softer — keeps
            // MINTS in the same family visually while leaving RATE
            // the brightest value. fontWeight 800 stays unchanged so
            // the column still reads heavy / structural.
            style={{ padding: 'var(--table-row-pad, 14px 10px)', textAlign: 'right', verticalAlign: 'middle', fontSize: 14, fontWeight: 800, color: '#7ed9a8', letterSpacing: '-0.2px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
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
        const minted = typeof r.supplyMinted === 'number' && r.supplyMinted >= 0 ? r.supplyMinted : null;
        const verified = r.supplyVerified === true;
        let display: string;
        let title: string;
        // SUPPLY sits below MINTS + RATE in the visual hierarchy:
        // muted by default, even quieter when the value is still
        // optimistic (not yet refreshed from on-chain). Verified /
        // cap-known cases use the same secondary-tier gray;
        // unverified drops another step so the "still resolving"
        // state reads as in-flight without being unreadable.
        let color = '#a8a6c4';
        if (cap !== null) {
          display = cap.toLocaleString();
          title   = 'Max supply for this collection';
        } else if (minted !== null) {
          display = minted.toLocaleString();
          title   = verified
            ? `On-chain num_minted from CollectionV1 (verified)`
            : `Minted so far (optimistic — awaiting on-chain refresh)`;
          if (!verified) color = '#7c7a98';
        } else {
          display = '—';
          title   = `Supply unavailable — observed ${r.observedMints.toLocaleString()} mint(s)`;
        }
        return (
          <td
            title={title}
            style={{ padding: 'var(--table-row-pad, 14px 10px)', textAlign: 'right', verticalAlign: 'middle', fontSize: 13, color, fontWeight: 700, fontFamily: "'SF Mono','Fira Code',monospace", fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
          >
            {display}
          </td>
        );
      })()}
      <td style={{ padding: 'var(--table-row-pad, 14px 10px)', textAlign: 'right', verticalAlign: 'middle', fontSize: 12.5, color: '#f0eef8', fontWeight: 600, whiteSpace: 'nowrap' }}>
        {fmtAge(r.lastMintAt)}
      </td>
      {/* COEF — burstiness: RATE ÷ baseline (count over full selected
          timeframe), floor 0.01. With <2 mints there's no two-point
          span, so we render "—". Rendered MUTED (gray-lilac, weight
          500) so it reads as secondary to the RATE column to its
          right — RATE is the primary activity metric. */}
      {(() => {
        const stats   = tfStatsByKey.get(r.groupingKey);
        const tfCount = stats?.count ?? 0;
        const coef    = computeCoef(r);
        const hasValue = tfCount >= 2;
        const display = hasValue
          ? (coef >= 10 ? coef.toFixed(0) : coef.toFixed(1))
          : '—';
        const tip = hasValue
          ? `RATE ÷ baseline (count / ${mintTf}) ≈ ${display}` +
            ` · higher = bursty, ~1 = steady`
          : `Need ≥ 2 mints in last ${mintTf} to compute COEF`;
        // Phase 1 polish: when the cell renders the em-dash placeholder
        // (count<2), drop the colour an extra tier (#8a82b0 → #45455e)
        // so a column of mostly-empty rows recedes into the row tint
        // instead of stacking into a vertical wall of em-dashes. The
        // resolved-value branch keeps the existing #8a82b0 so present
        // values still read as "secondary to RATE". Tooltip and
        // numeric content are unchanged — value cell remains
        // interactive on hover (the row's own hover lift applies).
        const cellColor = hasValue ? '#8a82b0' : '#45455e';
        return (
          <td
            title={tip}
            style={{ padding: 'var(--table-row-pad, 14px 10px)', textAlign: 'right', verticalAlign: 'middle', fontSize: 13, fontWeight: 500, color: cellColor, letterSpacing: '-0.1px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
          >
            {display}
          </td>
        );
      })()}
      {/* RATE — count ÷ active-window minutes inside the selected
          timeframe, floored at 1 minute. Header renamed from MINT/MIN
          to avoid implying "average over the full timeframe" (which
          it isn't). With <2 mints we surface the raw count (0 or 1).
          Primary activity metric — green, weight 700. */}
      {(() => {
        const stats     = tfStatsByKey.get(r.groupingKey);
        const tfCount   = stats?.count ?? 0;
        const rate      = stats?.mintPerMin ?? 0;
        const display   = tfCount < 2
                         ? tfCount.toString()
                         : rate >= 10 ? rate.toFixed(0)
                         : rate >= 1  ? rate.toFixed(1)
                         : rate.toFixed(2);
        const activeMin = stats && stats.count >= 2
          ? Math.max(1, (stats.lastTs - stats.firstTs) / 60_000)
          : 0;
        const tip = tfCount < 2
          ? `${tfCount} mint(s) in last ${mintTf} — not enough data for a rate`
          : `${tfCount.toLocaleString()} mints over ${activeMin.toFixed(1)} active min ≈ ${display} /min`;
        return (
          <td
            title={tip}
            style={{ padding: '14px 18px 14px 10px', textAlign: 'right', verticalAlign: 'middle', fontSize: 14, fontWeight: 700, color: '#5ce0a0', letterSpacing: '-0.2px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}
          >
            {display}
          </td>
        );
      })()}
    </tr>
  );
}
