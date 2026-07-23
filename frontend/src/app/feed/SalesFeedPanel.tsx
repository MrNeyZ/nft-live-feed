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
import { useDashboardHighlight } from '@/app/multi-native/lib/dashboard-highlight';
import { useMultiSales } from '@/app/multi-native/lib/multi-sales';
import { useSaleStreamConnected } from '@/app/multi-native/lib/sale-event-stream';
import { FeedCard, SlowTimeTickContext } from './lib/feed-card';
import { VL, VLText, rgb, alpha } from '@/lib/palette';

const RENDER_CAP = 40;
const DENSITIES: ReadonlyArray<Density> = ['comfy', 'compact', 'tape'];
/** Dashboard-hover collection highlight only ever matches within this many
 *  of the newest visible cards — "visible" meaning without scrolling, not
 *  RENDER_CAP's full off-screen buffer. No auto-scroll either way (see
 *  dashboard-highlight.tsx doc): a match further down the list just doesn't
 *  light up until it scrolls into this window on its own. */
const COLLECTION_HIGHLIGHT_WINDOW = 20;

/** UX audit H3 — reconnecting status chip. Same shape as MintFeedPanel's
 *  local StatusChip (that file's comment explains why these are copied
 *  per-panel rather than shared); this panel had no chip of its own before,
 *  so only the RECONNECTING label is added here, not a PAUSED one. */
function ReconnectingChip() {
  return (
    <span aria-live="polite" style={{
      display: 'inline-flex', alignItems: 'center', gap: 3,
      padding: '1px 5px', borderRadius: 3,
      fontSize: 9, fontWeight: 600, letterSpacing: '0.5px',
      color: 'rgba(201,189,240,0.78)', background: alpha(VL.purpleTint,0.06),
      border: `1px solid ${alpha(VL.purpleTint,0.22)}`, whiteSpace: 'nowrap',
    }}>
      <span style={{ width: 4, height: 4, borderRadius: '50%', background: alpha(VL.purpleTint,0.65) }} />
      RECONNECTING
    </span>
  );
}

export function SalesFeedPanel() {
  const { events } = useMultiSales();
  const [inclusiveFees] = useInclusiveFees();
  const connected = useSaleStreamConnected();

  const [paused, setPaused] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [density, setDensity] = useState<Density>('compact');

  // Pause freeze: while paused, render the last live snapshot instead of
  // new events (events keep flowing in the hook; only rendering freezes).
  const frozenRef = useRef<FeedEvent[]>([]);
  if (!paused) frozenRef.current = events;
  const list = paused ? frozenRef.current : events;
  const visible = list.length > RENDER_CAP ? list.slice(0, RENDER_CAP) : list;

  // UX audit M6 — see MintFeedPanel.tsx for the identical rationale: a
  // short local grace window so "just mounted" isn't shown as "no sales".
  const [justMounted, setJustMounted] = useState(true);
  useEffect(() => {
    if (list.length > 0) { setJustMounted(false); return; }
    const t = setTimeout(() => setJustMounted(false), 800);
    return () => clearTimeout(t);
  }, [list.length]);

  const onPreview = useCallback((url: string) => {
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  // /multi only: the compact Rare Feed publishes hovered/selected mints here.
  // Null on /feed (no provider).
  const hl = useRareHighlight();
  // /multi only: the LEFT DashboardCollectionsPanel publishes a hovered
  // collection slug here. Null on /feed (no provider).
  const dashHl = useDashboardHighlight();
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
      border: `1px solid ${alpha(VL.purpleTint, 0.65)}`, borderRadius: 12,
      boxShadow: `inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4), 0 0 28px ${alpha(VL.purpleDeep, 0.15)}`,
    }}>
      {/* Header — left "Live events" cluster + right [Settings][Pause]. */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '10px 14px', flexShrink: 0,
        borderBottom: `1px solid ${alpha(VL.purpleTint, 0.12)}`,
        background: alpha(VL.purpleTint, 0.04),
      }}>
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, rowGap: 4, minWidth: 0 }}>
          <h1 style={{ fontSize: 15, fontWeight: 700, color: VLText.primary, letterSpacing: '-0.2px', margin: 0 }}>Live events</h1>
          <LiveDot color={connected ? rgb(VL.green) : rgb(VL.gold)} />
          <span style={{ fontSize: 11, fontWeight: 500, color: VLText.muted, marginLeft: 4 }}>
            ({list.length.toLocaleString()})
          </span>
          {!connected && <ReconnectingChip />}
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
            borderBottom: `1px solid ${alpha(VL.purpleTint, 0.12)}`,
            background: alpha(VL.purpleTint, 0.04),
          }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: VLText.muted }}>Density</span>
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

        <div ref={listRef} className={`feed-list feed-density-${density}`} style={{ flex: 1, overflowY: 'auto', padding: '6px 10px 10px 13px' }}>
          {/* UX audit M6 — see MintFeedPanel.tsx: skeleton only for the brief
              "just mounted" window, real empty state unchanged after that. */}
          {justMounted && list.length === 0 && Array.from({ length: 4 }).map((_, i) => (
            <div key={`skeleton-${i}`} aria-hidden="true" style={{
              height: 64, borderRadius: 10, marginBottom: 8,
              background: 'rgba(255,255,255,0.035)', opacity: 1 - i * 0.15,
            }} />
          ))}
          {!justMounted && list.length === 0 && (
            <div style={{ textAlign: 'center', color: VLText.muted, padding: '48px 0', fontSize: 13 }}>
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
            // Dashboard -> feed collection highlight: deliberately NOT the
            // same treatment as the Rare bridge above — no dimming of the
            // rest of the feed, just the same lift/scale/glow a real mouse
            // hover already gives a card (see .feed-card:hover in
            // globals.css), applied to every visible match for the hovered
            // collection. Capped to the top COLLECTION_HIGHLIGHT_WINDOW
            // cards ("visible without scrolling") — no auto-scroll, a match
            // further down just doesn't light up.
            const hoveredSlug = dashHl?.hoveredSlug ?? null;
            return visible.map((e, idx) => {
              const isHover    = focusing && e.mintAddress === hoverMint;
              const isSelected = !!selectedMint && e.mintAddress === selectedMint;
              const dimmed     = focusing && !isHover;          // only while hovering
              const ringed     = isHover || isSelected;          // hover OR persistent click
              const collMatch  = !!hoveredSlug && idx < COLLECTION_HIGHLIGHT_WINDOW && e.meCollectionSlug === hoveredSlug;
              return (
                <div
                  key={e.id}
                  ref={(el) => { if (el && e.mintAddress) cardRefs.current.set(e.mintAddress, el); }}
                  style={{
                    borderRadius: 10,
                    transition: 'opacity 120ms ease, filter 120ms ease, transform 200ms ease-out, background 200ms ease-out, box-shadow 200ms ease-out',
                    ...(ringed ? {
                      outline: `2px solid ${alpha(VL.purpleTint, 0.85)}`,
                      outlineOffset: -2,
                      background: alpha(VL.purpleTint, 0.10),
                    } : {}),
                    ...(collMatch ? {
                      transform: 'translateY(-1px) scale(1.005)',
                      background: 'rgba(255, 255, 255, 0.12)',
                      boxShadow: '0 0 0 1px rgba(168, 144, 232, 0.40) inset, 0 0 18px rgba(128, 104, 216, 0.22)',
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
