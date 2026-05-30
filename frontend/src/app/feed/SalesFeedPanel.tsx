'use client';

// VictoryLabs — native Live Feed Sales panel (Stage 1 native-/multi prep).
// Self-contained: owns its data via useSalesFeed() and renders the embed
// card-feed surface (compact "Live events" header + shared FeedCard list).
// This is what the native /multi RIGHT column will mount instead of an
// `<iframe src="/feed?embed=1">`.
//
// NOT wired into /multi yet — additive only. Standalone /feed is untouched.

import { useCallback } from 'react';
import { LiveDot } from '@/soloist/shared';
import { useInclusiveFees } from '@/soloist/price-mode';
import { FeedCard } from './lib/feed-card';
import { useSalesFeed } from './lib/use-sales-feed';

/** Render cap — three feeds paint side-by-side in /multi (matches the
 *  embed paint band-aid). */
const RENDER_CAP = 60;

export function SalesFeedPanel() {
  const { events, meStale } = useSalesFeed();
  const [inclusiveFees] = useInclusiveFees();

  // Avatar click → open the NFT image in a new tab (no modal here).
  const onPreview = useCallback((url: string) => {
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  const visible = events.length > RENDER_CAP ? events.slice(0, RENDER_CAP) : events;

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0,
      width: '100%', overflow: 'hidden',
      background: 'linear-gradient(180deg, #201a3a 0%, #1a1530 100%)',
      border: '1px solid rgba(168,144,232,0.65)', borderRadius: 12,
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4), 0 0 28px rgba(128,104,216,0.15)',
    }}>
      {/* Compact header — same "Live events" pattern as the standalone page. */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px', flexShrink: 0,
        borderBottom: '1px solid rgba(168,144,232,0.12)',
        background: 'rgba(168,144,232,0.04)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h1 style={{ fontSize: 15, fontWeight: 700, color: '#f0eef8', letterSpacing: '-0.2px', margin: 0 }}>Live events</h1>
          <LiveDot />
          <span style={{ fontSize: 11, fontWeight: 500, color: '#56566e', marginLeft: 4 }}>
            ({events.length.toLocaleString()})
          </span>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            marginLeft: 4, padding: '1px 5px', borderRadius: 3,
            fontSize: 9.5, fontWeight: 700, letterSpacing: '0.3px',
            border: meStale ? '1px solid #ef787866' : '1px solid rgba(92,224,160,0.22)',
            background: meStale ? 'rgba(239,120,120,0.14)' : 'transparent',
            color: meStale ? '#ef7878' : 'rgba(92,224,160,0.65)',
          }}>
            <span style={{
              display: 'inline-block', width: 5, height: 5, borderRadius: '50%',
              background: meStale ? '#ef7878' : '#5ce0a0',
              boxShadow: meStale ? '0 0 6px #ef787880' : '0 0 4px rgba(92,224,160,0.40)',
            }} />
            ME {meStale ? 'STALE' : 'OK'}
          </span>
        </div>
      </div>

      <div className="feed-list feed-density-compact" style={{ flex: 1, overflowY: 'auto', padding: '6px 10px 10px 13px' }}>
        {events.length === 0 && (
          <div style={{ textAlign: 'center', color: '#55556e', padding: '48px 0', fontSize: 13 }}>
            Waiting for sales…
          </div>
        )}
        {visible.map(e => (
          <FeedCard
            key={e.id}
            event={e}
            onPreview={onPreview}
            inclusiveFees={inclusiveFees}
            sellerSellCountInFeed={0}
            isNewestSellForSellerColl={false}
            density="compact"
          />
        ))}
      </div>
    </div>
  );
}
