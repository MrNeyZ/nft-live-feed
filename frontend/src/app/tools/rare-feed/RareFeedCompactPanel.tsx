'use client';

// VictoryLabs — COMPACT Rare Feed signal strip for /multi ONLY.
// A navigator over the RIGHT Live Feed Sales column — NOT a separate historical
// feed. It derives rare rows from the SAME live sales (useMultiSales), filtered
// to EPIC+ by rank/supply, so every row corresponds to a sale currently in the
// Live Feed. Each row: name + rarity badge + Magic Eden / Tensor links (no
// image / price / wallets / timestamp). Hover highlights + dims the matching
// sale; click scrolls to it. The full /tools/rare-feed page is untouched.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FeedEvent } from '@/soloist/mock-data';
import { RarityRankBadge } from '@/app/feed/lib/rarity-rank-badge';
import { shortenNftName } from '@/app/feed/lib/nft-name';
import { LiveDot, Pill } from '@/soloist/shared';
import { useRareHighlight } from '@/app/multi-native/lib/rare-highlight';
import { useMultiSales } from '@/app/multi-native/lib/multi-sales';
import { useSaleStreamConnected } from '@/app/multi-native/lib/sale-event-stream';
import { VL, alpha, rgb } from '@/lib/palette';

/** EPIC+ gate (mirrors RarityRankBadge tiers): percentile ≤ 15%. */
const EPIC_PCT = 0.15;

/** UX audit H3/H4 — same chip shape as MintFeedPanel's StatusChip, copied
 *  locally per the project's existing per-panel convention (see that file's
 *  comment). Covers both the new PAUSED and RECONNECTING states here. */
function StatusChip({ label }: { label: string }) {
  return (
    <span aria-live="polite" style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      padding: '1px 5px', borderRadius: 3,
      fontSize: 9, fontWeight: 600, letterSpacing: '0.5px',
      color: 'rgba(201,189,240,0.78)', background: alpha(VL.purpleTint,0.06),
      border: `1px solid ${alpha(VL.purpleTint,0.22)}`, whiteSpace: 'nowrap',
    }}>
      <span style={{ width: 4, height: 4, borderRadius: '50%', background: alpha(VL.purpleTint,0.65) }} />
      {label}
    </span>
  );
}

/** Tiny square marketplace link button (ME / Tensor). */
function MktLink({ href, label, brand }: { href: string; label: string; brand: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      title={`Open on ${label}`}
      onClick={(e) => e.stopPropagation()}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 14, height: 14, borderRadius: 4, flexShrink: 0,
        background: `${brand}1f`, border: `1px solid ${brand}66`,
        overflow: 'hidden', lineHeight: 0, textDecoration: 'none',
      }}
    >
      <img src={`/brand/${label === 'Magic Eden' ? 'me' : 'tensor'}.png`} alt={label}
           draggable={false}
           style={{ width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }} />
    </a>
  );
}

interface RowProps {
  e: FeedEvent;
  selected: boolean;
  onSelect: (mint: string) => void;
  onHover: (mint: string | null) => void;
  /** Row leave with the event's relatedTarget — the panel decides whether the
   *  cursor stayed inside the strip (keep) or left it (clear + scroll top). */
  onLeave: (related: EventTarget | null) => void;
}

/** Narrow mini-card (compact by WIDTH). Two lines so it stays readable in a
 *  thin column: top = name + rarity badge, bottom = collection + ME/Tensor.
 *  No image / price / wallets. Left accent stripe + hover/selected states. */
function RareMiniCard({ e, selected, onSelect, onHover, onLeave }: RowProps) {
  // Aggressive shortening for the narrow strip.
  const { shortName, fullName } = shortenNftName(e.nftName, 13);
  const name = (shortName ?? fullName) || (e.collectionName ?? e.mintAddress.slice(0, 6));
  // Item links built from the mint (same scheme the rare API used).
  const meUrl     = `https://magiceden.io/item-details/${e.mintAddress}`;
  const tensorUrl = `https://www.tensor.trade/item/${e.mintAddress}`;
  return (
    <div
      onClick={() => e.mintAddress && onSelect(e.mintAddress)}
      onMouseEnter={() => e.mintAddress && onHover(e.mintAddress)}
      onMouseLeave={(ev) => onLeave(ev.relatedTarget)}
      title="Hover to jump · click to pin · click again to reset"
      style={{
        display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 5,
        minHeight: 60, padding: '8px 10px 8px 12px', cursor: 'pointer',
        position: 'relative', borderRadius: 10, margin: '6px 7px',
        border: `1px solid ${selected ? 'rgba(168,144,232,0.85)' : 'rgba(168,144,232,0.22)'}`,
        background: selected ? 'rgba(168,144,232,0.16)' : 'rgba(168,144,232,0.05)',
        boxShadow: selected ? '0 0 0 1px rgba(168,144,232,0.4), 0 0 14px rgba(128,104,216,0.18)' : 'none',
        transition: 'background 0.1s, border-color 0.1s',
      }}
      onMouseOver={(ev) => { if (!selected) (ev.currentTarget as HTMLDivElement).style.background = 'rgba(168,144,232,0.11)'; }}
      onMouseOut={(ev) => { if (!selected) (ev.currentTarget as HTMLDivElement).style.background = 'rgba(168,144,232,0.05)'; }}
    >
      {/* Left accent stripe (rare/feed style). */}
      <span style={{ position: 'absolute', left: 0, top: 8, bottom: 8, width: 3, borderRadius: 3, background: 'rgba(168,144,232,0.55)' }} />

      {/* Top line: NFT name (flex) + rarity badge (right). */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 700, color: '#f0eef8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {name}
        </span>
        <RarityRankBadge
          rarityRank={e.rarityRank}
          totalSupply={e.totalSupply}
        />
      </div>

      {/* Bottom line: collection name (flex, muted) + ME/Tensor links. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: '#9a9ab4', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {e.collectionName ?? ''}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          <MktLink href={meUrl}     label="Magic Eden" brand="#e42575" />
          <MktLink href={tensorUrl} label="Tensor"     brand="#3a7bd5" />
        </div>
      </div>
    </div>
  );
}

export function RareFeedCompactPanel() {
  const { events: liveEvents } = useMultiSales();
  const hl = useRareHighlight();
  const connected = useSaleStreamConnected();
  const listRef = useRef<HTMLDivElement>(null);

  // UX audit H4 — Pause/Resume, mirroring MintFeedPanel/SalesFeedPanel's
  // exact freeze pattern (this panel had no local buffer before; it read
  // `useMultiSales()` directly on every render). Freezing the pre-filter
  // events (not the derived `rows`) keeps the EPIC+ filter itself live-free
  // of the freeze concern — same layering the other two panels use.
  const [paused, setPaused] = useState(false);
  const frozenRef = useRef<FeedEvent[]>([]);
  if (!paused) frozenRef.current = liveEvents;
  const events = paused ? frozenRef.current : liveEvents;

  // Rare rows = EPIC+ sales from the CURRENT Live Feed window, so every row
  // has a matching sale on the right. Same order (newest first) as the feed.
  const rows = useMemo(() => events.filter((e) => {
    const r = e.rarityRank, s = e.totalSupply;
    return r != null && s != null && s > 0 && r / s <= EPIC_PCT;
  }), [events]);

  // UX audit M6 — see MintFeedPanel.tsx for the identical rationale: a
  // short local grace window so "just mounted" isn't shown as "no signals".
  const [justMounted, setJustMounted] = useState(true);
  useEffect(() => {
    if (rows.length > 0) { setJustMounted(false); return; }
    const t = setTimeout(() => setJustMounted(false), 800);
    return () => clearTimeout(t);
  }, [rows.length]);

  // Row leave: clear hover (→ scroll Live Feed to top, or back to selection)
  // ONLY when the cursor actually left the rows list. Moving between rows (or
  // through the inter-card gap) keeps the cursor inside `listRef`, so we skip —
  // the next row's onMouseEnter switches the highlight with no top-reset.
  const handleRowLeave = useCallback((related: EventTarget | null) => {
    if (related && listRef.current?.contains(related as Node)) return;
    hl?.hoverMint(null);
  }, [hl]);

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0,
      width: '100%', overflow: 'hidden',
      background: 'linear-gradient(180deg, #1a1530 0%, #1a1530 100%)',
      border: '1px solid rgba(168,144,232,0.65)', borderRadius: 12,
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4), 0 0 28px rgba(128,104,216,0.15)',
    }}>
      {/* Compact header. UX audit H3/H4: right-aligned Pause added (matching
          the other two panels' header layout — left cluster + right
          controls, no new pattern); dot color + status chips reflect the
          shared stream's connection state. */}
      <div style={{
        // alignItems: 'flex-start' (was 'center') — on very narrow columns
        // the left cluster below wraps to 2 lines ("signals · hover to
        // highlight" drops under the title); centering across that taller
        // block put the Pause button vertically mid-way, overlapping the
        // wrapped second line. Anchoring to the top keeps the button
        // beside the first line regardless of how many lines wrap.
        display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
        padding: '10px 12px', flexShrink: 0,
        borderBottom: '1px solid rgba(168,144,232,0.12)', background: 'rgba(168,144,232,0.04)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, rowGap: 4, minWidth: 0 }}>
          <h1 style={{ fontSize: 14, fontWeight: 700, color: '#f0eef8', letterSpacing: '-0.2px', margin: 0 }}>Rare</h1>
          <LiveDot color={connected ? rgb(VL.green) : rgb(VL.gold)} />
          <span style={{ fontSize: 10, color: '#9a9ab4' }}>{rows.length} signals · hover to highlight</span>
          {paused && <StatusChip label="PAUSED" />}
          {!connected && <StatusChip label="RECONNECTING" />}
        </div>
        <Pill
          active
          color={paused ? rgb(VL.gold) : rgb(VL.green)}
          onClick={() => setPaused(p => !p)}
          label={paused ? '▶ Resume' : '⏸ Pause'}
        />
      </div>

      {/* Mini-cards. */}
      <div ref={listRef} style={{ flex: 1, overflowY: 'auto' }}>
        {/* UX audit M6 — see MintFeedPanel.tsx: skeleton only for the brief
            "just mounted" window, real empty state unchanged after that. */}
        {justMounted && rows.length === 0 && Array.from({ length: 3 }).map((_, i) => (
          <div key={`skeleton-${i}`} aria-hidden="true" style={{
            height: 60, borderRadius: 10, margin: '6px 7px',
            background: 'rgba(168,144,232,0.05)', opacity: 1 - i * 0.2,
          }} />
        ))}
        {!justMounted && rows.length === 0 && (
          <div style={{ textAlign: 'center', color: '#9a9ab4', padding: '32px 0', fontSize: 12 }}>
            No rare sales in the live window yet
          </div>
        )}
        {rows.map((e) => (
          <RareMiniCard
            key={e.id}
            e={e}
            selected={hl?.selectedMint === e.mintAddress && !!e.mintAddress}
            onSelect={(m) => hl?.selectMint(m)}
            onHover={(m) => hl?.hoverMint(m)}
            onLeave={handleRowLeave}
          />
        ))}
      </div>
    </div>
  );
}
