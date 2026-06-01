'use client';

// VictoryLabs — COMPACT Rare Feed signal strip for /multi ONLY.
// A navigator over the RIGHT Live Feed Sales column — NOT a separate historical
// feed. It derives rare rows from the SAME live sales (useMultiSales), filtered
// to EPIC+ by rank/supply, so every row corresponds to a sale currently in the
// Live Feed. Each row: name + rarity badge + Magic Eden / Tensor links (no
// image / price / wallets / timestamp). Hover highlights + dims the matching
// sale; click scrolls to it. The full /tools/rare-feed page is untouched.

import { useMemo } from 'react';
import type { FeedEvent } from '@/soloist/mock-data';
import { RarityRankBadge } from '@/app/feed/lib/rarity-rank-badge';
import { shortenNftName } from '@/app/feed/lib/nft-name';
import { LiveDot } from '@/soloist/shared';
import { useRareHighlight } from '@/app/multi-native/lib/rare-highlight';
import { useMultiSales } from '@/app/multi-native/lib/multi-sales';

/** EPIC+ gate (mirrors RarityRankBadge tiers): percentile ≤ 15%. */
const EPIC_PCT = 0.15;

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
}

/** Narrow mini-card (compact by WIDTH). Two lines so it stays readable in a
 *  thin column: top = name + rarity badge, bottom = collection + ME/Tensor.
 *  No image / price / wallets. Left accent stripe + hover/selected states. */
function RareMiniCard({ e, selected, onSelect, onHover }: RowProps) {
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
      onMouseLeave={() => onHover(null)}
      title="Hover to highlight · click to find in Live Feed"
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
        <span style={{ flex: 1, minWidth: 0, fontSize: 11, color: '#7a7a94', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
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
  const { events } = useMultiSales();
  const hl = useRareHighlight();

  // Rare rows = EPIC+ sales from the CURRENT Live Feed window, so every row
  // has a matching sale on the right. Same order (newest first) as the feed.
  const rows = useMemo(() => events.filter((e) => {
    const r = e.rarityRank, s = e.totalSupply;
    return r != null && s != null && s > 0 && r / s <= EPIC_PCT;
  }), [events]);

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0,
      width: '100%', overflow: 'hidden',
      background: 'linear-gradient(180deg, #201a3a 0%, #1a1530 100%)',
      border: '1px solid rgba(168,144,232,0.65)', borderRadius: 12,
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4), 0 0 28px rgba(128,104,216,0.15)',
    }}>
      {/* Compact header. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '10px 12px', flexShrink: 0,
        borderBottom: '1px solid rgba(168,144,232,0.12)', background: 'rgba(168,144,232,0.04)',
      }}>
        <h1 style={{ fontSize: 14, fontWeight: 700, color: '#f0eef8', letterSpacing: '-0.2px', margin: 0 }}>Rare</h1>
        <LiveDot />
        <span style={{ fontSize: 10, color: '#56566e' }}>{rows.length} signals · hover to highlight</span>
      </div>

      {/* Mini-cards. */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {rows.length === 0 && (
          <div style={{ textAlign: 'center', color: '#55556e', padding: '32px 0', fontSize: 12 }}>
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
          />
        ))}
      </div>
    </div>
  );
}
