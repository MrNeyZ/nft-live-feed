'use client';

// VictoryLabs — native Live Feed Sales panel for /multi-native.
// Owns data via useSalesFeed() and renders the "Live events" header + the
// shared FeedCard list. Header now carries the [Settings][Pause] cluster to
// visually match /feed; Pause freezes the rendered list, Settings opens a
// compact Density panel. All state is LOCAL here — /feed/page.tsx is NOT
// touched (no shared-chrome refactor; isolated to /multi-native).

import { useCallback, useRef, useState } from 'react';
import { LiveDot, Pill, SettingsToggle, settingsPillActive, SETTINGS_PILL_INACTIVE } from '@/soloist/shared';
import { useInclusiveFees } from '@/soloist/price-mode';
import type { FeedEvent } from '@/soloist/mock-data';
import type { Density } from './lib/types';
import { FeedCard, SlowTimeTickContext } from './lib/feed-card';
import { useSalesFeed } from './lib/use-sales-feed';

const RENDER_CAP = 40;
const DENSITIES: ReadonlyArray<Density> = ['comfy', 'compact', 'tape'];

export function SalesFeedPanel() {
  const { events, meStale } = useSalesFeed();
  const [inclusiveFees] = useInclusiveFees();

  const [paused, setPaused] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [density, setDensity] = useState<Density>('compact');

  // Pause freeze: while paused, render the last live snapshot instead of
  // new events (events keep flowing in the hook; only rendering freezes).
  const frozenRef = useRef<FeedEvent[]>([]);
  if (!paused) frozenRef.current = events;
  const list = paused ? frozenRef.current : events;
  const visible = list.length > RENDER_CAP ? list.slice(0, RENDER_CAP) : list;

  const onPreview = useCallback((url: string) => {
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  return (
    <SlowTimeTickContext.Provider value={true}>
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0,
      width: '100%', overflow: 'hidden',
      background: 'linear-gradient(180deg, #201a3a 0%, #1a1530 100%)',
      border: '1px solid rgba(168,144,232,0.65)', borderRadius: 12,
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4), 0 0 28px rgba(128,104,216,0.15)',
    }}>
      {/* Header — left "Live events" cluster + right [Settings][Pause]. */}
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
            ({list.length.toLocaleString()})
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <SettingsToggle active={settingsOpen} onClick={() => setSettingsOpen(o => !o)} />
          <Pill
            active
            color={paused ? '#c9a820' : '#5ce0a0'}
            onClick={() => setPaused(p => !p)}
            label={paused ? '▶ Resume' : '⏸ Pause'}
          />
        </div>
      </div>

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
        {settingsOpen && (
          // Compact single-row toolbar (not the /feed multi-group grid —
          // that brought the divider + empty space). Density label + pills
          // inline; same pill styles/colors.
          <div role="group" aria-label="Card density" style={{
            display: 'flex', alignItems: 'center', gap: 8,
            padding: '6px 14px', flexShrink: 0,
            borderBottom: '1px solid rgba(168,144,232,0.12)',
            background: 'rgba(168,144,232,0.04)',
          }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: '#7a7a94' }}>Density</span>
            <div style={{ display: 'flex', gap: 4 }}>
              {DENSITIES.map(d => {
                const isActive = density === d;
                return (
                  <Pill
                    key={d}
                    active={isActive}
                    color="#a890e8"
                    onClick={() => setDensity(d)}
                    label={d.charAt(0).toUpperCase() + d.slice(1)}
                    size="sm"
                    style={isActive ? settingsPillActive('#a890e8') : SETTINGS_PILL_INACTIVE}
                  />
                );
              })}
            </div>
          </div>
        )}

        <div className={`feed-list feed-density-${density}`} style={{ flex: 1, overflowY: 'auto', padding: '6px 10px 10px 13px' }}>
          {list.length === 0 && (
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
              density={density}
            />
          ))}
        </div>
      </div>
    </div>
    </SlowTimeTickContext.Provider>
  );
}
