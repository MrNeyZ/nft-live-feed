'use client';

// VictoryLabs — Tools › Rare Feed.
// Live-ish view of rarity-scored value sales via GET /api/tools/rare-feed/recent
// (polled ~20s, DB-backed). Renders the SAME Live Feed Sales card (shared
// FeedCard) filtered to rare-only sales.
//
// Data + panel chrome are now shared, single-source:
//   • data  → useRareFeed()        (lib/use-rare-feed)
//   • panel → <RareFeedPanelView>  (gradient panel + embed header + card list)
// This page composes its full Rare-Feed header (title / rarity tabs / min
// score) ABOVE the shared panel. The native /multi column renders the same
// <RareFeedPanelView> (embedded), so there is one implementation of the
// panel chrome — no duplication.

import { useCallback, useEffect, useState } from 'react';
import { LiveDot } from '@/soloist/shared';
import { useRareFeed, SCORE_OPTIONS, type RarityFilter } from './lib/use-rare-feed';
import { RareFeedPanelView } from './RareFeedPanelView';

function fmtAge(iso: string | null): string {
  if (!iso) return '—';
  const diffSec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSec < 0)      return 'just now';
  if (diffSec < 60)     return `${diffSec}s ago`;
  if (diffSec < 3_600)  return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3_600)}h ago`;
  return `${Math.floor(diffSec / 86_400)}d ago`;
}

export default function RareFeedPage() {
  useEffect(() => { document.title = 'VictoryLabs — Rare Feed'; }, []);

  const { rows, minScore, setMinScore, rarity, setRarity, error, loading, lastUpdated } = useRareFeed();

  // Multi-tab embed (?embed=1): Gate already drops TopNav + BottomStatusBar
  // globally; here we set `data-embedded="1"` so layout-mode zoom doesn't
  // double-apply inside the iframe, and let the panel fill the column by
  // dropping the centered `--tools-max` width cap. Mirrors /feed + /mints.
  const [embedded, setEmbedded] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setEmbedded(new URLSearchParams(window.location.search).get('embed') === '1');
  }, []);
  const maxW = embedded ? 'none' : 'var(--tools-max, 1100px)';

  const RARITY_TABS: { key: RarityFilter; label: string }[] = [
    { key: 'all',   label: 'All'    },
    { key: 'top10', label: 'Top 10%' },
    { key: 'top5',  label: 'Top 5%'  },
    { key: 'top1',  label: 'Top 1%'  },
  ];

  // Open the NFT image in a new tab on avatar click (the shared card
  // expects an `onPreview` callback; Rare Feed has no modal overlay).
  const onPreview = useCallback((url: string) => {
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  return (
    <div className="feed-root page-transition" data-page="tools" data-embedded={embedded ? '1' : undefined}>
      {/* TopNav rendered persistently by Gate (anti-flash). */}

      {/* Full Rare-Feed header — hidden in embed mode so a /multi column
          renders the card feed only (the shared panel's own compact header
          takes over there). Non-embed /tools/rare-feed is unchanged. */}
      {!embedded && (
      <div style={{ padding: '20px 4px 14px', flexShrink: 0, width: '100%', maxWidth: maxW, margin: '0 auto', boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: '#e8e6f2', letterSpacing: '-0.5px' }}>
              Rare Feed
            </h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
              <LiveDot />
              <span style={{ fontSize: 11, color: '#7a7a94' }}>
                Rarity-scored value sales · refreshes every 20s
                {lastUpdated && <> · updated {fmtAge(new Date(lastUpdated).toISOString())}</>}
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {/* Rarity toggle */}
            <div style={{ display: 'flex', gap: 4, padding: 3, borderRadius: 6, background: 'rgba(20,14,34,0.6)', border: '1px solid rgba(168,144,232,0.25)' }}>
              {RARITY_TABS.map(t => (
                <button key={t.key} type="button" onClick={() => setRarity(t.key)}
                  style={{
                    padding: '5px 11px', fontSize: 11, fontWeight: 700, letterSpacing: '0.3px',
                    borderRadius: 4, cursor: 'pointer', border: 'none',
                    background: rarity === t.key ? 'rgba(128,104,216,0.35)' : 'transparent',
                    color: rarity === t.key ? '#e8e6f2' : '#7a7a94', transition: 'all 0.12s',
                  }}>
                  {t.label}
                </button>
              ))}
            </div>
            {/* Min score */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#7a7a94' }}>
              min score
              <select value={minScore} onChange={(e) => setMinScore(Number(e.target.value))}
                style={{
                  padding: '5px 8px', fontSize: 12, fontWeight: 600, borderRadius: 4,
                  border: '1px solid rgba(168,144,232,0.55)', background: 'rgba(20,14,34,0.85)',
                  color: '#d4d4e8', outline: 'none', cursor: 'pointer', fontFamily: 'inherit',
                }}>
                {SCORE_OPTIONS.map(s => <option key={s} value={s} style={{ background: '#1a1530' }}>{s}</option>)}
              </select>
            </label>
          </div>
        </div>
        {error && (
          <div style={{ marginTop: 12, padding: '8px 12px', fontSize: 12, color: '#ef7878', background: 'rgba(239,120,120,0.08)', border: '1px solid rgba(239,120,120,0.32)', borderRadius: 5 }}>
            failed to load — {error}
          </div>
        )}
        {!error && (
          <div style={{ marginTop: 12, fontSize: 11, color: '#7a7a94' }}>
            <span>showing <span style={{ color: '#a890e8', fontWeight: 700 }}>{rows.length}</span> rare {rows.length === 1 ? 'sale' : 'sales'}</span>
            <span style={{ color: '#3a3a52', margin: '0 10px' }}>·</span>
            <span>score ≥ {minScore}</span>
          </div>
        )}
      </div>
      )}

      <RareFeedPanelView
        rows={rows}
        error={error}
        loading={loading}
        onPreview={onPreview}
        embedded={embedded}
        maxW={maxW}
        minScore={minScore}
      />
    </div>
  );
}
