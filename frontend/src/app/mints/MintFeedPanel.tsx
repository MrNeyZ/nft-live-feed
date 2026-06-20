'use client';

// VictoryLabs — native Live Mint Feed panel for /multi-native.
// Owns data via useMintFeed() (mint channels only — no collections-table
// subsystem) and renders the "Live Mint Feed" header + shared LiveMintFeedCard
// list. Header carries a local [Pause] control + PAUSED chip to read closer
// to /mints?embed=1. All state is LOCAL — /mints/page.tsx is NOT touched.
//
// Skipped (too entangled to add without /mints page state — see report):
//   • FeedFiltersPopover (needs selectedTypes/sources + a filter pipeline)
//   • pinned/hover collection chips (driven by the LEFT table, absent here)

import { useEffect, useRef, useState } from 'react';
import { LiveDot, Pill } from '@/soloist/shared';
import { useSaleStream } from '@/app/multi-native/lib/sale-event-stream';
import type { MintEvent } from './lib/types';
import { LiveMintFeedCard } from './components/LiveMintFeedCard';
import { useMintFeed } from './lib/use-mint-feed';
import { VL, VLText, rgb, alpha } from '@/lib/palette';

const RENDER_CAP = 40;

/** Replicated PAUSED status chip (the /mints one is inline in page.tsx and
 *  not exported; copied verbatim here to avoid touching the page). */
function PausedChip() {
  return (
    <span aria-live="polite" style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      padding: '1px 5px', borderRadius: 3,
      fontSize: 9, fontWeight: 600, letterSpacing: '0.5px',
      color: 'rgba(201,189,240,0.78)', background: alpha(VL.purpleTint,0.06),
      border: `1px solid ${alpha(VL.purpleTint,0.22)}`, whiteSpace: 'nowrap',
    }}>
      <span style={{ width: 4, height: 4, borderRadius: '50%', background: alpha(VL.purpleTint,0.65) }} />
      PAUSED
    </span>
  );
}

export function MintFeedPanel() {
  const { events, rows } = useMintFeed(useSaleStream());

  const [paused, setPaused] = useState(false);
  // Pause freeze: while paused, render the last live snapshot (events keep
  // flowing in the hook; only rendering freezes).
  const frozenRef = useRef<MintEvent[]>([]);
  if (!paused) frozenRef.current = events;
  const list = paused ? frozenRef.current : events;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  const visible = list.length > RENDER_CAP ? list.slice(0, RENDER_CAP) : list;

  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0,
      width: '100%', overflow: 'hidden',
      background: 'linear-gradient(180deg, #1a1530 0%, #1a1530 100%)',
      border: `1px solid ${alpha(VL.purpleTint,0.65)}`, borderRadius: 12,
      boxShadow: `inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4), 0 0 28px ${alpha(VL.purpleDeep,0.15)}`,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px', flexShrink: 0,
        borderBottom: `1px solid ${alpha(VL.purpleTint,0.12)}`,
        background: alpha(VL.purpleTint,0.04), gap: 10,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 6, rowGap: 4, minWidth: 0, flex: 1 }}>
          <h1 style={{ fontSize: 15, fontWeight: 700, color: VLText.primary, letterSpacing: '-0.2px', margin: 0 }}>Live Mint Feed</h1>
          <LiveDot />
          <span style={{ fontSize: 11, fontWeight: 500, color: VLText.muted, marginLeft: 4 }}>
            ({list.length.toLocaleString()})
          </span>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            marginLeft: 4, padding: '1px 5px', borderRadius: 3,
            fontSize: 9.5, fontWeight: 700, letterSpacing: '0.3px',
            border: `1px solid ${alpha(VL.greenGlow,0.22)}`, background: 'transparent',
            color: alpha(VL.greenGlow,0.65),
          }}>
            <span style={{
              display: 'inline-block', width: 5, height: 5, borderRadius: '50%',
              background: rgb(VL.green), boxShadow: `0 0 4px ${alpha(VL.greenGlow,0.40)}`,
            }} />
            MINT OK
          </span>
          {paused && <PausedChip />}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
          <Pill
            active
            color={paused ? '#c7b479' : '#43b984'}
            onClick={() => setPaused(p => !p)}
            label={paused ? '▶ Resume' : '⏸ Pause'}
          />
        </div>
      </div>

      <div className="scroll-area" style={{
        flex: 1, overflowY: 'auto',
        display: 'flex', flexDirection: 'column', gap: 6,
        padding: '8px 8px', scrollbarGutter: 'stable both-edges',
      }}>
        {list.length === 0 && (
          <div style={{ textAlign: 'center', color: '#241f3b', padding: '36px 16px', fontSize: 12 }}>
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
