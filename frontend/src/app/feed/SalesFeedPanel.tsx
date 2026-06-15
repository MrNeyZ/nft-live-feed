'use client';

// VictoryLabs — native Live Feed Sales panel for /multi-native.
// Owns data via useSalesFeed() and renders the "Live events" header + the
// shared FeedCard list. Header now carries the [Settings][Pause] cluster to
// visually match /feed; Pause freezes the rendered list, Settings opens a
// compact Density panel. All state is LOCAL here — /feed/page.tsx is NOT
// touched (no shared-chrome refactor; isolated to /multi-native).

import { useCallback, useEffect, useRef, useState } from 'react';
import { LiveDot, Pill, SettingsToggle, settingsPillActive, SETTINGS_PILL_INACTIVE } from '@/soloist/shared';
import { useInclusiveFees } from '@/soloist/price-mode';
import type { FeedEvent } from '@/soloist/mock-data';
import type { Density } from './lib/types';
import { useRareHighlight } from '@/app/multi-native/lib/rare-highlight';
import { useMultiSales } from '@/app/multi-native/lib/multi-sales';
import { FeedCard, SlowTimeTickContext } from './lib/feed-card';

const RENDER_CAP = 40;
const DENSITIES: ReadonlyArray<Density> = ['comfy', 'compact', 'tape'];

export function SalesFeedPanel() {
  const { events, meStale } = useMultiSales();
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

  // /multi only: the compact Rare Feed publishes hovered/selected mints here.
  // Null on /feed (no provider).
  const hl = useRareHighlight();
  const cardRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const listRef = useRef<HTMLDivElement>(null);

  // Scroll WITHIN the feed-list container only — never el.scrollIntoView(),
  // which would also scroll the document <body> (it's ~nav-height taller than
  // the viewport) and push the TopNav off-screen.
  const scrollToSale = useCallback((mint: string) => {
    const c = listRef.current;
    const el = cardRefs.current.get(mint);
    if (!c || !el) return;
    const delta = (el.getBoundingClientRect().top - c.getBoundingClientRect().top)
      - (c.clientHeight / 2 - el.clientHeight / 2);
    c.scrollTo({ top: c.scrollTop + delta, behavior: 'smooth' });
  }, []);
  const scrollToTop = useCallback(() => {
    listRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  // One locator for the whole Rare → Sales interaction. Target = hovered ??
  // selected (hover overrides selection visually + for scroll):
  //   • hover a row / move between rows → jump to that sale;
  //   • leave the Rare panel with a selection → return to the selected sale;
  //   • leave with NO selection (or deselect) → scroll the feed back to top.
  // Moving between rows never hits the top branch (hovered stays non-null).
  useEffect(() => {
    const target = hl?.hoveredMint ?? hl?.selectedMint ?? null;
    if (target) scrollToSale(target);
    else scrollToTop();
  }, [hl?.hoveredMint, hl?.selectedMint, hl?.selectNonce, scrollToSale, scrollToTop]);

  return (
    <SlowTimeTickContext.Provider value={true}>
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0,
      width: '100%', overflow: 'hidden',
      background: 'linear-gradient(180deg, #1a1530 0%, #1a1530 100%)',
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
          <span style={{ fontSize: 11, fontWeight: 500, color: '#9a9ab4', marginLeft: 4 }}>
            ({list.length.toLocaleString()})
          </span>
          <span style={{
            display: 'inline-flex', alignItems: 'center', gap: 3,
            marginLeft: 4, padding: '1px 5px', borderRadius: 3,
            fontSize: 9.5, fontWeight: 700, letterSpacing: '0.3px',
            border: meStale ? '1px solid #d9686766' : '1px solid rgba(92,224,160,0.22)',
            background: meStale ? 'rgba(239,120,120,0.14)' : 'transparent',
            color: meStale ? '#d96867' : 'rgba(92,224,160,0.65)',
          }}>
            <span style={{
              display: 'inline-block', width: 5, height: 5, borderRadius: '50%',
              background: meStale ? '#d96867' : '#43b984',
              boxShadow: meStale ? '0 0 6px #d9686780' : '0 0 4px rgba(92,224,160,0.40)',
            }} />
            ME {meStale ? 'STALE' : 'OK'}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <SettingsToggle active={settingsOpen} onClick={() => setSettingsOpen(o => !o)} />
          <Pill
            active
            color={paused ? '#c7b479' : '#43b984'}
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
            <span style={{ fontSize: 11, fontWeight: 600, color: '#9a9ab4' }}>Density</span>
            <div style={{ display: 'flex', gap: 4 }}>
              {DENSITIES.map(d => {
                const isActive = density === d;
                return (
                  <Pill
                    key={d}
                    active={isActive}
                    color="#ad92ee"
                    onClick={() => setDensity(d)}
                    label={d.charAt(0).toUpperCase() + d.slice(1)}
                    size="sm"
                    style={isActive ? settingsPillActive('#ad92ee') : SETTINGS_PILL_INACTIVE}
                  />
                );
              })}
            </div>
          </div>
        )}

        <div ref={listRef} className={`feed-list feed-density-${density}`} style={{ flex: 1, overflowY: 'auto', padding: '6px 10px 10px 13px' }}>
          {list.length === 0 && (
            <div style={{ textAlign: 'center', color: '#9a9ab4', padding: '48px 0', fontSize: 13 }}>
              Waiting for sales…
            </div>
          )}
          {(() => {
            // Dimming is HOVER-ONLY (transient, like Mint SHOW): the rest of
            // the feed dims only while a rare row is hovered AND its sale is
            // visible. A click NEVER dims the feed — it only keeps a subtle
            // ring on the selected card (+ scroll), so the feed is never left
            // permanently greyed out after the mouse leaves.
            const hoverMint    = hl?.hoveredMint ?? null;
            const selectedMint = hl?.selectedMint ?? null;
            const focusing = !!hoverMint && visible.some(e => e.mintAddress === hoverMint);
            return visible.map(e => {
              const isHover    = focusing && e.mintAddress === hoverMint;
              const isSelected = !!selectedMint && e.mintAddress === selectedMint;
              const dimmed     = focusing && !isHover;          // only while hovering
              const ringed     = isHover || isSelected;          // hover OR persistent click
              return (
                <div
                  key={e.id}
                  ref={(el) => { if (el && e.mintAddress) cardRefs.current.set(e.mintAddress, el); }}
                  style={{
                    borderRadius: 10,
                    transition: 'opacity 120ms ease, filter 120ms ease',
                    ...(ringed ? {
                      outline: '2px solid rgba(168,144,232,0.85)',
                      outlineOffset: -2,
                      background: 'rgba(168,144,232,0.10)',
                    } : {}),
                    ...(dimmed ? { opacity: 0.32, filter: 'brightness(0.65)' } : { opacity: 1 }),
                  }}
                >
                  <FeedCard
                    event={e}
                    onPreview={onPreview}
                    inclusiveFees={inclusiveFees}
                    sellerSellCountInFeed={0}
                    isNewestSellForSellerColl={false}
                    density={density}
                  />
                </div>
              );
            });
          })()}
        </div>
      </div>
    </div>
    </SlowTimeTickContext.Provider>
  );
}
