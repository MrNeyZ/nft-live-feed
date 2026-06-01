'use client';

// VictoryLabs — COMPACT Rare Feed signal strip for /multi ONLY.
// A dense rarity watchlist (not a second sales feed): each row is just NFT
// name + rarity badge + Magic Eden / Tensor links. No image / price / floor /
// wallets / timestamp. Clicking a row highlights the matching sale in the Live
// Feed column (via RareHighlightProvider). The full /tools/rare-feed page is
// untouched — it still renders <RareFeedPanelView> with full cards.

import { useRareFeed } from './lib/use-rare-feed';
import type { RareEvent } from './lib/use-rare-feed';
import { RarityRankBadge } from '@/app/feed/lib/rarity-rank-badge';
import { LiveDot } from '@/soloist/shared';
import { useRareHighlight } from '@/app/multi-native/lib/rare-highlight';

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
        width: 16, height: 16, borderRadius: 4, flexShrink: 0,
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

function CompactRow({ e, selected, onSelect }: { e: RareEvent; selected: boolean; onSelect: (mint: string) => void }) {
  const stem = e.nftName ?? e.collectionName ?? e.mintAddress.slice(0, 6);
  return (
    <div
      onClick={() => e.mintAddress && onSelect(e.mintAddress)}
      title="Highlight this sale in Live Feed"
      style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '0 8px', height: 30, cursor: 'pointer',
        borderBottom: '1px solid rgba(168,144,232,0.07)',
        background: selected ? 'rgba(168,144,232,0.16)' : 'transparent',
        transition: 'background 0.1s',
      }}
    >
      {/* Name + collection (truncated). */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', lineHeight: 1.15 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#e8e6f2', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {stem}
        </span>
        {e.collectionName && (
          <span style={{ fontSize: 9, color: '#6e6e8a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {e.collectionName}
          </span>
        )}
      </div>
      {/* Rarity badge (shared component — same as full Rare Feed). */}
      <RarityRankBadge
        rarityRank={e.rarityRank}
        totalSupply={e.totalSupply}
        reasonTags={e.reasonTags}
        rareScore={e.rareScore}
      />
      {/* Marketplace links. */}
      <MktLink href={e.meUrl}     label="Magic Eden" brand="#e42575" />
      <MktLink href={e.tensorUrl} label="Tensor"     brand="#3a7bd5" />
    </div>
  );
}

export function RareFeedCompactPanel() {
  const { rows, error, loading } = useRareFeed();
  const hl = useRareHighlight();

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
        <span style={{ fontSize: 10, color: '#56566e' }}>{rows.length} signals · click to find in feed</span>
      </div>

      {/* Dense rows. */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {error && (
          <div style={{ padding: '10px 12px', fontSize: 11, color: '#ef7878' }}>failed — {error}</div>
        )}
        {!error && rows.length === 0 && (
          <div style={{ textAlign: 'center', color: '#55556e', padding: '32px 0', fontSize: 12 }}>
            {loading ? 'Loading…' : 'No rare signals yet'}
          </div>
        )}
        {rows.map((e) => (
          <CompactRow
            key={e.saleSignature}
            e={e}
            selected={hl?.mint === e.mintAddress && !!e.mintAddress}
            onSelect={(m) => hl?.select(m)}
          />
        ))}
      </div>
    </div>
  );
}
