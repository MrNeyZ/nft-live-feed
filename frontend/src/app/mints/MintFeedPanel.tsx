'use client';

// VictoryLabs — native Live Mint Feed panel (Stage 1 native-/multi prep).
// Self-contained: owns its data via useMintFeed() (mint channels ONLY — no
// collections-table subsystem) and renders the embed card-feed surface
// (compact "Live Mint Feed" header + shared LiveMintFeedCard list). This is
// what the native /multi LEFT column will mount instead of an
// `<iframe src="/mints?embed=1">`.
//
// NOT wired into /multi yet — additive only. Standalone /mints is untouched.

import { useEffect, useState } from 'react';
import { LiveDot } from '@/soloist/shared';
import { LiveMintFeedCard } from './components/LiveMintFeedCard';
import { useMintFeed } from './lib/use-mint-feed';

/** Render cap — three feeds paint side-by-side in /multi (matches the
 *  embed paint band-aid). */
const RENDER_CAP = 60;

export function MintFeedPanel() {
  const { events, rows } = useMintFeed();

  // Lightweight age tick (5 s) so card age tiers refresh during quiet
  // periods — mirrors the standalone page's force-tick cadence without a
  // per-card timer.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
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
      {/* Compact header — same pattern as the standalone Live Mint Feed. */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px', flexShrink: 0,
        borderBottom: '1px solid rgba(168,144,232,0.12)',
        background: 'rgba(168,144,232,0.04)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <h1 style={{ fontSize: 15, fontWeight: 700, color: '#f0eef8', letterSpacing: '-0.2px', margin: 0 }}>Live Mint Feed</h1>
          <LiveDot />
          <span style={{ fontSize: 11, fontWeight: 500, color: '#56566e', marginLeft: 4 }}>
            ({events.length.toLocaleString()})
          </span>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            marginLeft: 4, padding: '1px 5px', borderRadius: 3,
            fontSize: 9.5, fontWeight: 700, letterSpacing: '0.3px',
            border: '1px solid rgba(92,224,160,0.22)', background: 'transparent',
            color: 'rgba(92,224,160,0.65)',
          }}>
            <span style={{
              display: 'inline-block', width: 5, height: 5, borderRadius: '50%',
              background: '#5ce0a0', boxShadow: '0 0 4px rgba(92,224,160,0.40)',
            }} />
            MINT OK
          </span>
        </div>
      </div>

      <div className="scroll-area" style={{
        flex: 1, overflowY: 'auto',
        display: 'flex', flexDirection: 'column', gap: 6,
        padding: '8px 8px', scrollbarGutter: 'stable both-edges',
      }}>
        {events.length === 0 && (
          <div style={{ textAlign: 'center', color: '#3a3a52', padding: '36px 16px', fontSize: 12 }}>
            Waiting for individual mint events…
          </div>
        )}
        {visible.map(ev => (
          <LiveMintFeedCard
            key={ev.signature}
            event={ev}
            group={rows.get(ev.groupingKey)}
            now={now}
            embedded
          />
        ))}
      </div>
    </div>
  );
}
