'use client';

// VictoryLabs — Rare Feed panel VIEW (single source of truth for chrome).
// The gradient panel + embed compact header + feed-list + rare cards,
// extracted VERBATIM from rare-feed/page.tsx so there is ONE implementation
// of the panel chrome. Both consumers render this:
//   • standalone /tools/rare-feed page (its full Rare-Feed header sits
//     ABOVE this panel; passes embedded + maxW from its own state)
//   • native /multi RareFeedPanel (embedded, maxW 'none')
// Presentational only — data (rows/error/loading) is passed in.

import { LiveDot } from '@/soloist/shared';
import { FeedCard } from '@/app/feed/lib/feed-card';
import type { RareEvent } from './lib/use-rare-feed';
import { rareToFeedEvent, rarityChip, SALE_PILL } from './lib/rare-feed-card';

export interface RareFeedPanelViewProps {
  rows:      RareEvent[];
  error:     string | null;
  loading:   boolean;
  onPreview: (url: string) => void;
  /** Embed mode: show the compact in-panel header, drop bottom margin,
   *  cap rendered cards at 60. (Standalone non-embed passes false.) */
  embedded:  boolean;
  /** Panel max-width: 'none' in embed/multi, 'var(--tools-max,…)' standalone. */
  maxW:      string;
  /** Surfaced in the empty-state copy. */
  minScore:  number;
}

export function RareFeedPanelView({ rows, error, loading, onPreview, embedded, maxW, minScore }: RareFeedPanelViewProps) {
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0,
      width: '100%', maxWidth: maxW, margin: '0 auto',
      overflow: 'hidden',
      background: 'linear-gradient(180deg, #1a1530 0%, #1a1530 100%)',
      border: '1px solid rgba(168,144,232,0.65)', borderRadius: 12,
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4), 0 0 28px rgba(128,104,216,0.15)',
      marginBottom: embedded ? 0 : 16,
    }}>
      {/* Embed-only compact header — matches the right Live Feed Sales
          panel's "Live events" header. The standalone page keeps its own
          full header above this panel; this one renders only in embed. */}
      {embedded && (
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '10px 14px', flexShrink: 0,
          borderBottom: '1px solid rgba(168,144,232,0.12)',
          background: 'rgba(168,144,232,0.04)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <h1 style={{ fontSize: 15, fontWeight: 700, color: '#f0eef8', letterSpacing: '-0.2px' }}>Rare events</h1>
            <LiveDot />
            <span style={{ fontSize: 11, fontWeight: 500, color: '#9a9ab4', marginLeft: 4 }}>
              ({rows.length.toLocaleString()})
            </span>
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 3,
              marginLeft: 4, padding: '1px 5px', borderRadius: 3,
              fontSize: 9.5, fontWeight: 700, letterSpacing: '0.3px',
              border: error ? '1px solid #d9686766' : '1px solid rgba(92,224,160,0.22)',
              background: error ? 'rgba(239,120,120,0.14)' : 'transparent',
              color: error ? '#d96867' : 'rgba(92,224,160,0.65)',
            }}>
              <span style={{
                display: 'inline-block', width: 5, height: 5, borderRadius: '50%',
                background: error ? '#d96867' : '#43b984',
                boxShadow: error ? '0 0 6px #d9686780' : '0 0 4px rgba(92,224,160,0.40)',
              }} />
              RARE {error ? 'ERR' : 'OK'}
            </span>
          </div>
        </div>
      )}
      <div className="feed-list feed-density-compact" style={{ flex: 1, overflowY: 'auto', padding: '6px 10px 10px 13px' }}>
        {loading && rows.length === 0 && (
          <div style={emptyCell}>Loading rare sales…</div>
        )}
        {!loading && rows.length === 0 && (
          <div style={emptyCell}>
            No rare sales yet at score ≥ {minScore}. Rare Feed surfaces sales of top-rarity NFTs
            trading at or below floor — these are infrequent, and require Magic Eden to expose a
            rarity rank for the collection.
          </div>
        )}
        {/* Embed (/multi) caps rendered cards at 60 to cut paint cost
            when three feeds run side-by-side; standalone page renders all. */}
        {(embedded ? rows.slice(0, 40) : rows).map((e) => (
          <FeedCard
            key={e.saleSignature}
            event={rareToFeedEvent(e)}
            onPreview={onPreview}
            inclusiveFees={false}
            sellerSellCountInFeed={0}
            isNewestSellForSellerColl={false}
            density="compact"
            pillOverride={SALE_PILL}
            nameChip={rarityChip(e)}
          />
        ))}
      </div>
    </div>
  );
}

const emptyCell: React.CSSProperties = {
  textAlign: 'center', color: '#9a9ab4', padding: '64px 24px', fontSize: 13, lineHeight: 1.6,
};
