'use client';

// Soloist — Live Feed (design port of feed.html)
// Snapshot via REST + live updates via SSE; mapped through `fromBackend`.

import { memo, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  COLLECTIONS_DB, FeedEvent, Side,
  rndFloat, shortWallet, timeAgo,
} from '@/soloist/mock-data';
import { fromBackend, fromRow, marketplaceUrl } from '@/soloist/from-backend';
import type { BackendEvent, LatestApiResponse } from '@/soloist/from-backend';
import { ItemThumb, LiveDot, MktIconBadge, Pill, TopNav, compressImage } from '@/soloist/shared';
import {
  feedReducer, initFeedState, orderedEvents,
  type MetaPatch,
} from '@/soloist/feed-store';
import { isCnftDust } from '@/soloist/cnft-filter';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';
const MAX_EVENTS = 200;
const SNAPSHOT_LIMIT = 100;
/** Scroll tolerance (px) for treating the user as "at top". */
const AT_TOP_THRESHOLD = 4;
/** Lowercased collection-name blacklist; mirrors src/db/blacklist.ts NAME_BLACKLIST. */
const FEED_NAME_BLACKLIST = new Set<string>([
  'collector crypt',
]);
/** Frontend-only slug blacklist — hide specific collections from the Live
 *  Feed without touching ingestion. Collection page for these slugs still
 *  renders normally if visited directly. */
const FEED_SLUG_BLACKLIST = new Set<string>([
  'staratlascrew',
]);

// ── Time-ago leaf ────────────────────────────────────────────────────────────
// Self-ticking time label. Each instance owns its own 3 s interval, so a
// 200-card feed only re-renders the 200 small <span>s instead of every
// FeedCard root (the previous "tick" prop pattern invalidated React.memo
// on every card every 3 s). Color tier and "just now" copy match the
// previous inline logic exactly to keep the visual contract.
function TimeAgo({ ts }: { ts: number }) {
  const [, force] = useState(0);
  useEffect(() => {
    const id = setInterval(() => force(n => n + 1), 3000);
    return () => clearInterval(id);
  }, []);
  const now       = Date.now();
  const isNew     = ts > now - 6000;
  const ageMs     = now - ts;
  const isJustNow = ageMs < 5000;
  const isRecent  = !isJustNow && ageMs < 60000;
  const color     = isJustNow ? '#e87ab0' : isRecent ? '#c7b479' : '#877496';
  const weight    = isJustNow ? 600 : 500;
  const text      = isNew ? 'just now' : timeAgo(ts);
  return <span style={{ fontSize: 11, color, fontWeight: weight }}>{text}</span>;
}

// ── Feed Card ────────────────────────────────────────────────────────────────
// Memoized: existing cards skip render when new events are prepended.
// Re-renders only when `event` changes — the time label has been hoisted
// into the <TimeAgo> leaf above, so card bodies are stable after first paint.

interface FeedCardProps {
  event: FeedEvent;
  /** LMB on avatar → open a small centered image preview. */
  onPreview: (url: string) => void;
}

const FeedCard = memo(function FeedCard({ event, onPreview }: FeedCardProps) {
  // Row-flash class lasts 6 s from event.ts. Computed once at mount with a
  // one-shot setTimeout to flip false — no per-tick recompute needed since
  // every card mounts at most once per event.
  const [isNew, setIsNew] = useState(() => event.ts > Date.now() - 6000);
  useEffect(() => {
    if (!isNew) return;
    const remaining = 6000 - (Date.now() - event.ts);
    if (remaining <= 0) { setIsNew(false); return; }
    const t = setTimeout(() => setIsNew(false), remaining);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const cardClass = `feed-card ${event.side === 'buy' ? 'buy-card' : 'sell-card'}`;
  const typeLabel = event.side === 'buy' ? 'Buy' : 'Sell';
  const typeBg = event.side === 'buy' ? 'rgba(79,209,144,0.18)' : 'rgba(229,133,133,0.18)';
  const typeFg = event.side === 'buy' ? '#4fd190' : '#e58585';
  const m = event.nftName.match(/^(.*?)\s*#?(\d+)$/);
  const baseName = m ? m[1] : event.nftName;
  const num = m ? m[2] : '';

  // Avatar click routing, local to the Live Feed card:
  //   LMB  → centered image preview (onPreview callback).
  //   MMB  → open /collection/<slug> in a new tab.
  //   RMB  → default (browser context menu) — no handler.
  //
  // The inner <ItemThumb> is wrapped in a `pointer-events: none` shell so
  // the <img> never becomes the event target. That removes every
  // image-native default (open-image-in-new-tab, drag-to-tab, extension
  // middle-click-open-URL) without an absolute overlay. Parent handlers
  // still fire because events fall through to `.feed-thumb`.
  const thumbImg  = compressImage(event.imageUrl);
  const thumbSlug = event.meCollectionSlug;
  const handleThumbClick = () => { if (thumbImg) onPreview(thumbImg); };
  const handleThumbMouseDown = (e: React.MouseEvent) => {
    if (e.button === 1) { e.preventDefault(); e.stopPropagation(); }
  };
  const handleThumbAuxClick = (e: React.MouseEvent) => {
    if (e.button !== 1) return;
    e.preventDefault();
    e.stopPropagation();
    if (thumbSlug) {
      window.open(`/collection/${encodeURIComponent(thumbSlug)}`, '_blank', 'noopener,noreferrer');
    }
  };

  return (
    <div className={`feed-row-wrap${isNew ? ' new-' + event.side : ''}`}>
      <div className={cardClass}>
        <div
          className="feed-thumb"
          onClick={handleThumbClick}
          onMouseDown={handleThumbMouseDown}
          onAuxClick={handleThumbAuxClick}
          style={{ cursor: thumbImg ? 'pointer' : 'default' }}
        >
          <div draggable={false} style={{ pointerEvents: 'none', userSelect: 'none' }}>
            <ItemThumb imageUrl={thumbImg} color={event.color} abbr={event.abbr} size={56} />
          </div>
        </div>

        {/* Middle column */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', paddingTop: 1, paddingBottom: 1 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, overflow: 'hidden' }}>
            <span style={{
              fontSize: 14, fontWeight: 700, color: '#f0eef8', letterSpacing: '-0.2px',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>
              {baseName}{num && <span style={{ color: '#e8e6f2' }}> #{num}</span>}
            </span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, marginTop: 3 }}>
            <div style={{ fontSize: 10.5, color: '#55556e' }}>
              <span style={{ marginRight: 6 }}>seller:</span>
              <span style={{ color: '#7a7a94', fontWeight: 500, fontFamily: "'SF Mono','Fira Code',monospace" }}>
                {event.seller ? shortWallet(event.seller) : 'N/A'}
              </span>
            </div>
            <div style={{ fontSize: 10.5, color: '#55556e' }}>
              <span style={{ marginRight: 6 }}>buyer:</span>
              <span style={{ color: '#7a7a94', fontWeight: 500, fontFamily: "'SF Mono','Fira Code',monospace" }}>
                {event.buyer ? shortWallet(event.buyer) : 'N/A'}
              </span>
            </div>
          </div>
        </div>

        {/* Right column */}
        <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', alignItems: 'flex-end', gap: 6, flexShrink: 0, paddingTop: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <TimeAgo ts={event.ts} />
            <MktIconBadge mp={event.marketplace} href={marketplaceUrl(event)} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              padding: '3px 8px', fontSize: 11, fontWeight: 700, borderRadius: 4,
              background: typeBg, color: typeFg, letterSpacing: '0.2px',
            }}>{typeLabel}</span>
            <span style={{ fontSize: 11, color: '#6a6a84' }}>for</span>
            <span style={{
              fontSize: 15, fontWeight: 700, color: '#f0eef8', letterSpacing: '-0.3px',
              fontFamily: "'SF Mono','Fira Code',monospace",
            }}>
              {event.price.toFixed(2)}{' '}
              <span style={{ color: '#8a8aa6', fontWeight: 600, fontSize: 11 }}>SOL</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  );
});

// ── Feed App ─────────────────────────────────────────────────────────────────

type FilterKey = 'all' | Side | 'listing' | 'me' | 'tensor';

const FILTERS: { key: FilterKey; label: string; color: string }[] = [
  { key: 'all',     label: 'All',        color: '#a890e8' },
  { key: 'buy',     label: 'Buys',       color: '#4fd190' },
  { key: 'sell',    label: 'Sells',      color: '#e58585' },
  { key: 'listing', label: 'Listings',   color: '#a890e8' },
  { key: 'me',      label: 'Magic Eden', color: '#e87ab0' },
  { key: 'tensor',  label: 'Tensor',     color: '#a890e8' },
];

export default function FeedPage() {
  const [filter, setFilter] = useState<FilterKey>('all');
  const [collFilter, setCollFilter] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  // Avatar-preview overlay state. One modal per page; clicking another thumb
  // just replaces the URL. Cleared on backdrop click or Escape key.
  const [preview, setPreview] = useState<string | null>(null);
  useEffect(() => {
    if (!preview) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPreview(null); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [preview]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [solPrice] = useState(() => rndFloat(38, 42).toFixed(2));

  // Normalized feed state: dedup + ordering + patching live inside the reducer,
  // so every SSE/REST path below just dispatches a typed action instead of
  // splicing a flat array by hand.
  const [feedState, dispatch] = useReducer(feedReducer, undefined, () => initFeedState(MAX_EVENTS));
  const events = useMemo(() => orderedEvents(feedState), [feedState]);

  // Scrollable list element + scroll snapshot captured before list-expanding
  // dispatches. Layout effect consumes the snapshot post-commit and either
  // pins the user to the top (if they were already there) or compensates
  // scrollTop by the added height so their viewport doesn't jump. First-wins:
  // when many events are batched, only the earliest snapshot is used.
  const listRef = useRef<HTMLDivElement>(null);
  const scrollSnapshotRef = useRef<{ height: number; top: number; wasAtTop: boolean } | null>(null);

  function captureScroll() {
    if (scrollSnapshotRef.current !== null) return;
    const el = listRef.current;
    scrollSnapshotRef.current = {
      height:   el?.scrollHeight ?? 0,
      top:      el?.scrollTop    ?? 0,
      wasAtTop: !el || el.scrollTop <= AT_TOP_THRESHOLD,
    };
  }

  useLayoutEffect(() => {
    const snap = scrollSnapshotRef.current;
    if (!snap) return;
    scrollSnapshotRef.current = null;
    const el = listRef.current;
    if (!el) return;
    if (snap.wasAtTop) {
      el.scrollTop = 0;
    } else {
      const delta = el.scrollHeight - snap.height;
      if (delta !== 0) el.scrollTop = snap.top + delta;
    }
  }, [feedState]);

  // Time labels self-tick inside <TimeAgo>; no parent-level tick state needed.

  // Snapshot on mount + live SSE. Paused → close stream; resume → reconnect
  // and re-fetch snapshot so events that arrived during the pause get merged
  // in (reducer dedups the overlap by id).
  //
  // Currently subscribed: `sale` (live append), `meta` (enrichment patch).
  // `rawpatch` and `remove` actions exist in the reducer but are not yet
  // wired here — adding them is one dispatch line each with no state rewire.
  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    // Exponential backoff with jitter on reconnect — caps the herd-thunder
    // pattern when the backend restarts (every connected tab would
    // otherwise hammer the just-rebooted backend on a 3 s grid).
    let attempt = 0;
    const scheduleReconnect = () => {
      if (cancelled || paused || document.hidden) return;
      const base = Math.min(30_000, 1_000 * 2 ** attempt);
      const jitter = Math.random() * 1_000;
      reconnectTimer = setTimeout(connect, base + jitter);
      attempt++;
    };

    const connect = () => {
      if (cancelled || paused) return;
      es?.close();
      es = new EventSource(`${API_BASE}/api/events/stream`);
      // Reset backoff once the connection lands so the next disconnect
      // starts from 1 s again instead of inheriting the prior cap.
      es.addEventListener('open', () => { attempt = 0; });
      // `sale` is the only list-expanding SSE event, so it's also the only
      // path that captures the scroll snapshot before dispatching.
      es.addEventListener('sale', (e: MessageEvent) => {
        try {
          const ev = fromBackend(JSON.parse(e.data) as BackendEvent);
          captureScroll();
          dispatch({ type: 'live', event: ev });
        } catch { /* malformed frame — skip */ }
      });
      // Enrichment patches: fill in nftName / collectionName / meCollectionSlug
      // for events previously rendered as "Unknown #?". Matches by signature
      // and by mintAddress (same mint in multiple sales benefits from one fetch).
      // Patch logic lives in the reducer so this handler stays a pure
      // JSON → action adapter.
      es.addEventListener('meta', (e: MessageEvent) => {
        try {
          const patch = JSON.parse(e.data) as MetaPatch;
          dispatch({ type: 'meta', patch });
        } catch { /* malformed frame — skip */ }
      });
      // Backend fires `remove` for rows deleted after enrichment (blacklisted
      // collections, late cNFT floor-gate). Without this listener the card
      // painted from the earlier `sale` frame would linger forever because
      // `collectionName` is null at sale time and never gets patched (no
      // `meta` frame is emitted for blacklisted rows).
      es.addEventListener('remove', (e: MessageEvent) => {
        try {
          const { signature } = JSON.parse(e.data) as { signature: string };
          if (signature) dispatch({ type: 'remove', signature });
        } catch { /* malformed frame — skip */ }
      });
      es.addEventListener('error', () => {
        es?.close();
        scheduleReconnect();
      });
    };

    // Pull latest snapshot (newest-first) and dispatch as a single `snapshot`
    // action — the reducer handles dedup against any live events that might
    // have already arrived for the same signatures.
    fetch(`${API_BASE}/api/events/latest?limit=${SNAPSHOT_LIMIT}`)
      .then(r => r.json())
      .then((data: LatestApiResponse) => {
        if (cancelled) return;
        const events: FeedEvent[] = data.events.map(r => fromBackend(fromRow(r)));
        captureScroll();
        dispatch({ type: 'snapshot', events });
      })
      .catch(() => { /* snapshot failed — live stream still attempts to connect */ })
      .finally(() => { if (!cancelled) connect(); });

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      es?.close();
    };
  }, [paused]);

  // ── cNFT collection-floor filter ────────────────────────────────────────
  // Hide cNFT collections whose CURRENT FLOOR is below 0.002 SOL. Reuses
  // /api/collections/bids (same endpoint the Dashboard uses; backend caches
  // per slug for 60s). Floor is fetched once per newly-seen cNFT slug,
  // batched with a small debounce so bursts don't turn into 1-per-event
  // calls. Shared predicate (`isCnftDust`) keeps Dashboard in lockstep.
  const [floorBySlug, setFloorBySlug] = useState<Record<string, number | null>>({});
  const requestedFloorRef = useRef<Set<string>>(new Set());
  const pendingFloorRef   = useRef<Set<string>>(new Set());
  const floorFetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    for (const e of events) {
      if (e.nftType !== 'cnft' || !e.meCollectionSlug) continue;
      if (requestedFloorRef.current.has(e.meCollectionSlug)) continue;
      pendingFloorRef.current.add(e.meCollectionSlug);
    }
    if (pendingFloorRef.current.size === 0 || floorFetchTimerRef.current) return;
    floorFetchTimerRef.current = setTimeout(async () => {
      floorFetchTimerRef.current = null;
      const batch = Array.from(pendingFloorRef.current).slice(0, 80);
      pendingFloorRef.current.clear();
      for (const s of batch) requestedFloorRef.current.add(s);
      try {
        const res = await fetch(
          `${API_BASE}/api/collections/bids?slugs=${encodeURIComponent(batch.join(','))}`,
        );
        if (!res.ok) return;
        const data = await res.json() as {
          bids?: Record<string, { floorLamports: number | null }>;
        };
        if (!data.bids) return;
        setFloorBySlug(prev => {
          const next = { ...prev };
          for (const [slug, v] of Object.entries(data.bids!)) {
            next[slug] = typeof v.floorLamports === 'number' ? v.floorLamports / 1e9 : null;
          }
          return next;
        });
      } catch { /* transient — retry path is the next unseen cNFT slug */ }
    }, 500);
  }, [events]);
  useEffect(() => () => {
    if (floorFetchTimerRef.current) clearTimeout(floorFetchTimerRef.current);
  }, []);

  const filtered = useMemo(() => events.filter(e => {
    // Collection-floor gate for cNFTs (replaces the old sale-price guard):
    // shared predicate — see `@/soloist/cnft-filter`.
    if (isCnftDust(e, s => floorBySlug[s])) return false;
    // Defensive blacklist — backend deletes blacklisted rows after enrichment,
    // but if a card was already painted via the immediate `sale` SSE frame we
    // also drop it here once enrichment / meta fills in the collection name.
    // Lowercase comparison matches NAME_BLACKLIST in src/db/blacklist.ts.
    if (e.collectionName && FEED_NAME_BLACKLIST.has(e.collectionName.toLowerCase())) return false;
    if (e.meCollectionSlug && FEED_SLUG_BLACKLIST.has(e.meCollectionSlug)) return false;
    if (collFilter && e.collectionName !== collFilter) return false;
    if (filter === 'buy')     return e.side === 'buy';
    if (filter === 'sell')    return e.side === 'sell';
    if (filter === 'listing') return false; // backend does not emit listings in v1
    if (filter === 'me')      return e.marketplace === 'me';
    if (filter === 'tensor')  return e.marketplace === 'tensor';
    return true;
  }), [events, filter, collFilter, floorBySlug]);

  return (
    <div className="feed-root">
      <TopNav active="feed" />

      {/* Centered column stage */}
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center', minHeight: 0, padding: '0 0 10px' }}>
        <div style={{ width: '100%', maxWidth: 640, display: 'flex', flexDirection: 'column', minHeight: 0 }}>

          {/* Promoted feed card */}
          <div style={{
            flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden',
            background: 'linear-gradient(180deg, #201a3a 0%, #1a1530 100%)',
            border: '1px solid rgba(168,144,232,0.65)',
            borderRadius: 12,
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4), 0 0 28px rgba(128,104,216,0.15)',
            margin: '14px 0 3px',
            minHeight: 0,
          }}>

            {/* Card header */}
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
              padding: '10px 14px', flexShrink: 0,
              borderBottom: '1px solid rgba(168,144,232,0.12)',
              background: 'rgba(168,144,232,0.04)',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <h1 style={{ fontSize: 15, fontWeight: 700, color: '#f0eef8', letterSpacing: '-0.2px' }}>Live events</h1>
                <span style={{ fontSize: 13 }}>⚡</span>
                <LiveDot />
                <span style={{ fontSize: 11, fontWeight: 600, color: '#8068d8', marginLeft: 4 }}>
                  ({filtered.length.toLocaleString()})
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Pill
                  active={filtersOpen}
                  onClick={() => setFiltersOpen(o => !o)}
                  title="Filters"
                  icon={<span style={{ fontSize: 11, lineHeight: 1 }}>⚙</span>}
                  label="Filters"
                />
                <Pill
                  active
                  color={paused ? '#c9a820' : '#4fd190'}
                  onClick={() => setPaused(p => !p)}
                  label={paused ? '▶ Resume' : '⏸ Pause'}
                />
              </div>
            </div>

            {/* Feed surface */}
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', minHeight: 0 }}>
              {filtersOpen && (
                <div style={{ padding: '10px 4px 12px', flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', gap: 5, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 10, color: '#56566e', marginRight: 2 }}>Type:</span>
                    {FILTERS.map(f => (
                      <Pill
                        key={f.key}
                        active={filter === f.key}
                        color={f.color}
                        onClick={() => setFilter(f.key)}
                        label={f.label}
                        size="sm"
                      />
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 10, color: '#56566e', marginRight: 2 }}>Collection:</span>
                    {COLLECTIONS_DB.slice(0, 8).map(c => (
                      <Pill
                        key={c.name}
                        active={collFilter === c.name}
                        color={c.color}
                        onClick={() => setCollFilter(collFilter === c.name ? null : c.name)}
                        label={c.abbr}
                        size="sm"
                      />
                    ))}
                    {collFilter && (
                      <button onClick={() => setCollFilter(null)} style={{
                        padding: '2px 8px', fontSize: 10, borderRadius: 4,
                        border: '1px solid #bf5f5f40', background: '#bf5f5f15',
                        color: '#e58585', cursor: 'pointer',
                      }}>✕ clear</button>
                    )}
                  </div>
                </div>
              )}

              {/* Feed list */}
              <div ref={listRef} className="feed-list" style={{ flex: 1, overflowY: 'auto', padding: '6px 10px 10px 13px' }}>
                {filtered.length === 0 && (
                  <div style={{ textAlign: 'center', color: '#55556e', padding: '48px 0', fontSize: 13 }}>
                    No events match current filters
                  </div>
                )}
                {filtered.map(e => <FeedCard key={e.id} event={e} onPreview={setPreview} />)}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom status — mirrors the top nav's gradient/border/shadow so the
          shell reads as two balanced rails instead of top-only. Full-bleed
          wrapper breaks out of `.feed-root`'s 16 px horizontal padding. */}
      <div style={{
        width: '100vw',
        marginLeft: 'calc(50% - 50vw)',
        background: 'linear-gradient(180deg, rgba(10,8,18,0.95) 0%, rgba(20,14,34,0.7) 100%)',
        borderTop: '1px solid rgba(255,255,255,0.04)',
        boxShadow: '0 -1px 0 rgba(128,104,216,0.04), 0 -8px 24px rgba(0,0,0,0.4)',
        backdropFilter: 'blur(12px)',
        flexShrink: 0,
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: '6px 18px',
          maxWidth: 1400, margin: '0 auto',
          fontSize: 11,
        }}>
          <div style={{ display: 'flex', gap: 16 }}>
            <span style={{ color: '#55556e' }}>Discord</span>
            <span style={{ color: '#55556e' }}>Twitter</span>
            <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: '#36b868', fontWeight: 700 }}>0</span>
              <span style={{ color: '#55556e' }}>alerts</span>
            </span>
          </div>
          <div style={{ display: 'flex', gap: 16, fontFamily: "'SF Mono','Fira Code',monospace" }}>
            <span><span style={{ color: '#55556e' }}>EVENTS </span><span style={{ color: '#56566e' }}>{events.length}</span></span>
            <span><span style={{ color: '#55556e' }}>SOL </span><span style={{ color: '#36b868' }}>${solPrice}</span></span>
          </div>
        </div>
      </div>

      {/* Avatar preview — single overlay shared by every FeedCard. Backdrop
       *  click and Escape close it. The <img> stops propagation so clicks on
       *  the picture itself don't dismiss. Reuses the already-fetched wsrv
       *  URL from `compressImage`, so no extra network request. */}
      {preview && (
        <div
          onClick={() => setPreview(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(0,0,0,0.75)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'zoom-out',
          }}
          role="dialog"
          aria-label="Preview"
        >
          <img
            src={preview}
            alt=""
            loading="lazy"
            decoding="async"
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 200, height: 200, objectFit: 'contain',
              borderRadius: 8, background: '#0e0b22',
              boxShadow: '0 16px 40px rgba(0,0,0,0.6)',
              cursor: 'default',
            }}
          />
        </div>
      )}
    </div>
  );
}
