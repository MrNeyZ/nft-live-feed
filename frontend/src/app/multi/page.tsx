'use client';

// VictoryLabs — Multi-tab.
// Native composite layout: one document, one SSE connection, one events
// buffer. The two panes share state via the same `feedReducer` instance —
// no iframes, no duplicated Gate/TopNav/heartbeat/SSE work.
//
// Layout:
//   ┌─────────────┬──────────────┐
//   │ DASHBOARD   │              │
//   │ (top-left)  │   LIVE FEED  │
//   ├─────────────┤  (full right)│
//   │ (reserved)  │              │
//   │ (bottom-left)              │
//   └─────────────┴──────────────┘

import { useEffect, useMemo, useReducer, useState } from 'react';
import { TopNav, ItemThumb, MktIconBadge, LiveDot, compressImage } from '@/soloist/shared';
import { fromBackend, fromRow, marketplaceUrl } from '@/soloist/from-backend';
import type { BackendEvent, LatestApiResponse } from '@/soloist/from-backend';
import { feedReducer, initFeedState, orderedEvents, type MetaPatch } from '@/soloist/feed-store';
import { shortWallet, timeAgo, type FeedEvent } from '@/soloist/mock-data';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';
const MAX_EVENTS      = 200;
const SNAPSHOT_LIMIT  = 100;
const FEED_VISIBLE    = 80;
const TREND_VISIBLE   = 8;
/** Window over which a collection is "trending" — recent sale count. */
const TREND_WINDOW_MS = 30 * 60_000;

interface TrendRow {
  name:   string;
  slug:   string | null;
  abbr:   string;
  color:  string;
  image:  string | null;
  sales:  number;
  latest: number;
}

function aggregateTrend(events: FeedEvent[], now: number): TrendRow[] {
  const byName = new Map<string, TrendRow>();
  const cutoff = now - TREND_WINDOW_MS;
  for (const e of events) {
    if (e.ts < cutoff) continue;
    if (!e.collectionName || e.collectionName === 'Unknown') continue;
    const existing = byName.get(e.collectionName);
    if (existing) {
      existing.sales++;
      if (e.ts > existing.latest) existing.latest = e.ts;
      if (!existing.image && e.imageUrl) existing.image = e.imageUrl;
    } else {
      byName.set(e.collectionName, {
        name:   e.collectionName,
        slug:   e.meCollectionSlug,
        abbr:   e.abbr,
        color:  e.color,
        image:  e.imageUrl,
        sales:  1,
        latest: e.ts,
      });
    }
  }
  return Array.from(byName.values())
    .sort((a, b) => b.sales - a.sales || b.latest - a.latest)
    .slice(0, TREND_VISIBLE);
}

export default function MultiTabPage() {
  useEffect(() => { document.title = 'VictoryLabs — Multi-tab'; }, []);

  const [feedState, dispatch] = useReducer(feedReducer, undefined, () => initFeedState(MAX_EVENTS));
  const events = useMemo(() => orderedEvents(feedState), [feedState]);
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5_000);
    return () => clearInterval(id);
  }, []);
  const trending = useMemo(() => aggregateTrend(events, now), [events, now]);

  // Single SSE connection + one snapshot fetch — both panes consume from
  // the same store. No iframes, no duplicated event source.
  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;
    fetch(`${API_BASE}/api/events/latest?limit=${SNAPSHOT_LIMIT}`)
      .then(r => r.json())
      .then((data: LatestApiResponse) => {
        if (cancelled) return;
        const snap: FeedEvent[] = data.events.map(r => fromBackend(fromRow(r)));
        dispatch({ type: 'snapshot', events: snap });
      })
      .catch(() => { /* live stream still attempts to connect */ })
      .finally(() => {
        if (cancelled) return;
        es = new EventSource(`${API_BASE}/api/events/stream`);
        es.addEventListener('sale', (e: MessageEvent) => {
          try {
            const ev = fromBackend(JSON.parse(e.data) as BackendEvent);
            dispatch({ type: 'live', event: ev });
          } catch { /* malformed */ }
        });
        es.addEventListener('meta', (e: MessageEvent) => {
          try { dispatch({ type: 'meta', patch: JSON.parse(e.data) as MetaPatch }); }
          catch { /* malformed */ }
        });
        es.addEventListener('remove', (e: MessageEvent) => {
          try {
            const { signature } = JSON.parse(e.data) as { signature: string };
            if (signature) dispatch({ type: 'remove', signature });
          } catch { /* malformed */ }
        });
      });
    return () => { cancelled = true; es?.close(); };
  }, []);

  return (
    // `data-no-scale` opts this page out of PC-mode +15% zoom; padding-right 0
    // so the feed pane sits flush with the viewport edge.
    <div className="feed-root" data-no-scale="1" style={{ paddingRight: 0 }}>
      <TopNav active="multi" />

      <div style={{
        flex: 1,
        display: 'grid',
        gridTemplateColumns: '1.55fr 1fr',
        gridTemplateRows: '1fr 1fr',
        gap: 12,
        padding: '12px 0',
        minHeight: 0,
      }}>
        {/* Top-left: trending collections (native, computed from shared events buffer) */}
        <div style={paneStyle}>
          <PaneHeader title="Trending collections" countLabel={`${trending.length}`} />
          <div style={{ flex: 1, overflowY: 'auto', padding: '6px 8px 8px' }} className="feed-list">
            {trending.length === 0 && (
              <div style={emptyStyle}>Waiting for sales…</div>
            )}
            {trending.map((row, i) => (
              <a
                key={row.name}
                href={row.slug ? `/collection/${encodeURIComponent(row.slug)}` : '#'}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '6px 10px', borderRadius: 6, textDecoration: 'none',
                  color: 'inherit', cursor: row.slug ? 'pointer' : 'default',
                }}
                onClick={(e) => { if (!row.slug) e.preventDefault(); }}
              >
                <span style={{ width: 18, fontSize: 11, color: '#56566e', fontFamily: "'SF Mono','Fira Code',monospace" }}>{i + 1}</span>
                <ItemThumb imageUrl={compressImage(row.image)} color={row.color} abbr={row.abbr} size={32} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: '#e8e6f2', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {row.name}
                  </div>
                  <div style={{ fontSize: 10.5, color: '#7a7a94' }}>{timeAgo(row.latest)}</div>
                </div>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#a890e8' }}>{row.sales}</span>
                <span style={{ fontSize: 10, color: '#56566e', letterSpacing: '0.5px', textTransform: 'uppercase' }}>sales</span>
              </a>
            ))}
          </div>
        </div>

        {/* Right column: live feed (spans both rows) */}
        <div style={{ ...paneStyle, gridRow: '1 / 3' }}>
          <PaneHeader title="Live events" countLabel={`(${events.length})`} live />
          <div style={{ flex: 1, overflowY: 'auto', padding: '6px 10px 8px' }} className="feed-list">
            {events.length === 0 && <div style={emptyStyle}>Waiting for sales…</div>}
            {events.slice(0, FEED_VISIBLE).map(e => <MultiFeedRow key={e.id} event={e} />)}
          </div>
        </div>

        {/* Bottom-left: reserved placeholder */}
        <div style={{
          gridColumn: '1 / 2', gridRow: '2 / 3',
          minWidth: 0, minHeight: 0,
          border: '1px dashed rgba(168,144,232,0.22)',
          borderRadius: 10,
          background: 'rgba(20,14,34,0.4)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          color: '#55556e', fontSize: 11, letterSpacing: '1px', textTransform: 'uppercase',
        }}>
          reserved · future tool
        </div>
      </div>
    </div>
  );
}

const paneStyle: React.CSSProperties = {
  minWidth: 0, minHeight: 0,
  display: 'flex', flexDirection: 'column',
  border: '1px solid rgba(168,144,232,0.28)',
  borderRadius: 10,
  overflow: 'hidden',
  background: 'linear-gradient(180deg, rgba(32,26,58,0.55) 0%, rgba(26,21,48,0.55) 100%)',
};

const emptyStyle: React.CSSProperties = {
  textAlign: 'center', color: '#55556e', padding: '32px 0', fontSize: 12,
};

function PaneHeader({ title, countLabel, live = false }: { title: string; countLabel: string; live?: boolean }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8,
      padding: '8px 12px',
      borderBottom: '1px solid rgba(168,144,232,0.12)',
      background: 'rgba(168,144,232,0.04)', flexShrink: 0,
    }}>
      <span style={{ fontSize: 13, fontWeight: 700, color: '#f0eef8', letterSpacing: '-0.2px' }}>{title}</span>
      {live && <LiveDot />}
      <span style={{ fontSize: 11, fontWeight: 600, color: '#8068d8' }}>{countLabel}</span>
    </div>
  );
}

function MultiFeedRow({ event }: { event: FeedEvent }) {
  const m = event.nftName.match(/^(.*?)\s*#?(\d+)$/);
  const baseName = m ? m[1] : event.nftName;
  const num = m ? m[2] : '';
  const isBuy = event.side === 'buy';
  const accent = isBuy ? '#5ce0a0' : '#ef7878';
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '6px 8px',
      borderLeft: `2px solid ${accent}88`,
      borderRadius: 5,
      marginBottom: 3,
      background: 'rgba(255,255,255,0.015)',
    }}>
      <ItemThumb imageUrl={compressImage(event.imageUrl)} color={event.color} abbr={event.abbr} size={36} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: '#f0eef8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {baseName}{num && <span style={{ color: '#aaaabf' }}> #{num}</span>}
        </div>
        <div style={{ fontSize: 10, color: '#7a7a94', fontFamily: "'SF Mono','Fira Code',monospace" }}>
          {event.buyer ? shortWallet(event.buyer) : 'N/A'}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 10, color: '#7a7a94' }}>{timeAgo(event.ts)}</span>
          <MktIconBadge mp={event.marketplace} href={marketplaceUrl(event)} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{
            padding: '1px 6px', fontSize: 10, fontWeight: 700, borderRadius: 3,
            background: `${accent}22`, color: accent, letterSpacing: '0.2px',
          }}>{isBuy ? 'BUY' : 'SELL'}</span>
          <span style={{ fontSize: 12, fontWeight: 700, color: '#f0eef8', fontFamily: "'SF Mono','Fira Code',monospace" }}>
            {event.price.toFixed(2)} <span style={{ color: '#8a8aa6', fontSize: 10 }}>SOL</span>
          </span>
        </div>
      </div>
    </div>
  );
}
