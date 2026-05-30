'use client';

// VictoryLabs — native Rare Sales feed panel (Stage 1 native-/multi prep).
// Self-contained: owns its data via useRareFeed() and renders the embed
// card-feed surface (compact "Rare events" header + Live Feed Sales cards
// via the shared FeedCard). This is what the native /multi center column
// will mount instead of an `<iframe src="/tools/rare-feed?embed=1">`.
//
// NOT wired into /multi yet — additive only. The iframe /multi stays live
// until the three native panels are proven. Standalone /tools/rare-feed is
// untouched.

import { useCallback } from 'react';
import { LiveDot } from '@/soloist/shared';
import { FeedCard } from '@/app/feed/lib/feed-card';
import { useRareFeed } from './lib/use-rare-feed';
import { rareToFeedEvent, rarityChip, SALE_PILL } from './lib/rare-feed-card';

/** Cap rendered cards (matches the embed band-aid — three feeds paint
 *  side-by-side in /multi). */
const RENDER_CAP = 60;

export function RareFeedPanel() {
  const { rows, error, loading } = useRareFeed();

  // Avatar click → open the NFT image in a new tab (no modal here).
  const onPreview = useCallback((url: string) => {
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  const visible = rows.length > RENDER_CAP ? rows.slice(0, RENDER_CAP) : rows;

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0,
      width: '100%', overflow: 'hidden',
      background: 'linear-gradient(180deg, #201a3a 0%, #1a1530 100%)',
      border: '1px solid rgba(168,144,232,0.65)', borderRadius: 12,
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4), 0 0 28px rgba(128,104,216,0.15)',
    }}>
      {/* Compact header — same pattern as /feed's "Live events". */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px', flexShrink: 0,
        borderBottom: '1px solid rgba(168,144,232,0.12)',
        background: 'rgba(168,144,232,0.04)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h1 style={{ fontSize: 15, fontWeight: 700, color: '#f0eef8', letterSpacing: '-0.2px', margin: 0 }}>Rare events</h1>
          <LiveDot />
          <span style={{ fontSize: 11, fontWeight: 500, color: '#56566e', marginLeft: 4 }}>
            ({rows.length.toLocaleString()})
          </span>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            marginLeft: 4, padding: '1px 5px', borderRadius: 3,
            fontSize: 9.5, fontWeight: 700, letterSpacing: '0.3px',
            border: error ? '1px solid #ef787866' : '1px solid rgba(92,224,160,0.22)',
            background: error ? 'rgba(239,120,120,0.14)' : 'transparent',
            color: error ? '#ef7878' : 'rgba(92,224,160,0.65)',
          }}>
            <span style={{
              display: 'inline-block', width: 5, height: 5, borderRadius: '50%',
              background: error ? '#ef7878' : '#5ce0a0',
              boxShadow: error ? '0 0 6px #ef787880' : '0 0 4px rgba(92,224,160,0.40)',
            }} />
            RARE {error ? 'ERR' : 'OK'}
          </span>
        </div>
      </div>

      <div className="feed-list feed-density-compact" style={{ flex: 1, overflowY: 'auto', padding: '6px 10px 10px 13px' }}>
        {loading && rows.length === 0 && (
          <div style={EMPTY_CELL}>Loading rare sales…</div>
        )}
        {!loading && rows.length === 0 && (
          <div style={EMPTY_CELL}>
            No rare sales yet. Rare Feed surfaces sales of top-rarity NFTs trading at or below floor —
            these are infrequent, and require Magic Eden to expose a rarity rank for the collection.
          </div>
        )}
        {visible.map((e) => (
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

const EMPTY_CELL: React.CSSProperties = {
  textAlign: 'center', color: '#55556e', padding: '64px 24px', fontSize: 13, lineHeight: 1.6,
};
