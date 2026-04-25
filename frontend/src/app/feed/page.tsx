'use client';

// Soloist — Live Feed (design port of feed.html)
// Snapshot via REST + live updates via SSE; mapped through `fromBackend`.

import { memo, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  FeedEvent, Side,
  rndFloat, shortWallet, timeAgo,
} from '@/soloist/mock-data';
import { fromBackend, fromRow, marketplaceUrl } from '@/soloist/from-backend';
import type { BackendEvent, LatestApiResponse } from '@/soloist/from-backend';
import { ItemThumb, LiveDot, MktIconBadge, Pill, TopNav, compressImage } from '@/soloist/shared';
import {
  feedReducer, initFeedState, orderedEvents,
  type MetaPatch, type FeedAction,
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
  const kind  = saleKind(event.saleTypeRaw);
  const style = KIND_STYLES[kind];
  // Border tint: buy/buyAmm → green border, sell/sellAmm → red border.
  // Falls back to the existing buy-card class for unknown so neutral rows
  // still look familiar.
  const borderClass =
    style.borderTone === 'sell' ? 'sell-card' :
    style.borderTone === 'buy'  ? 'buy-card'  : 'buy-card';
  const cardClass = `feed-card ${borderClass}`;
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
  const thumbImg       = compressImage(event.imageUrl);
  const thumbSlug      = event.meCollectionSlug;
  const nftBorderColor = getNftBorderColor(event.nftType);
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
          style={{ cursor: thumbImg ? 'pointer' : 'default', position: 'relative' }}
        >
          <div draggable={false} style={{ pointerEvents: 'none', userSelect: 'none' }}>
            <ItemThumb imageUrl={thumbImg} color={event.color} abbr={event.abbr} size={56} />
          </div>
          {nftBorderColor && (
            <span
              aria-hidden
              style={{
                position: 'absolute', inset: 0,
                borderRadius: 6,
                // Layered border — colored hairline (1px) for type identity
                // plus a faint dark inset line just inside it. The dark
                // ring cuts through bright pixels on light/colorful NFTs;
                // the colored line keeps full opacity so it stays visible
                // against dark NFTs and the dark feed background. Total
                // visual band = 2 px, but only 1 px of it is colored, so
                // the rim doesn't read as "thick".
                border: `1px solid ${nftBorderColor}`,
                boxShadow: 'inset 0 0 0 1px rgba(0,0,0,0.45)',
                pointerEvents: 'none',
              }}
            />
          )}
        </div>

        {/* Middle column */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', paddingTop: 1, paddingBottom: 1 }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, overflow: 'hidden' }}>
            {thumbSlug ? (
              <a
                href={`/collection/${encodeURIComponent(thumbSlug)}`}
                onClick={(e) => e.stopPropagation()}
                style={{
                  fontSize: 14, fontWeight: 700, color: '#f0eef8', letterSpacing: '-0.2px',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  textDecoration: 'none', cursor: 'pointer',
                }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'underline'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'none'; }}
              >
                {baseName}{num && <span style={{ color: '#e8e6f2' }}> #{num}</span>}
              </a>
            ) : (
              <span style={{
                fontSize: 14, fontWeight: 700, color: '#f0eef8', letterSpacing: '-0.2px',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              }}>
                {baseName}{num && <span style={{ color: '#e8e6f2' }}> #{num}</span>}
              </span>
            )}
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
              background: style.bg, color: style.fg, letterSpacing: '0.2px',
            }}>{style.label}</span>
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

type FilterKey = 'all' | Side | 'buyAmm' | 'sellAmm' | 'listing';

const FILTERS: { key: FilterKey; label: string; color: string }[] = [
  { key: 'all',     label: 'All',        color: '#a890e8' },
  { key: 'buy',     label: 'Buy',        color: '#5ce0a0' },
  { key: 'sell',    label: 'Sell',       color: '#ef7878' },
  { key: 'buyAmm',  label: 'Buy AMM',    color: '#5ce0a0' },
  { key: 'sellAmm', label: 'Sell AMM',   color: '#ef7878' },
  { key: 'listing', label: 'Listings',   color: '#a890e8' },
];

/** Canonical backend `sale_type` values, derived in src/domain/sale-type.ts.
 *  Listings is intentionally absent — the backend does not yet emit listing
 *  events, so the Listings filter is wired but renders empty. */
const SALE_TYPE_BUY      = 'normal_sale'; // default buy / list buy
const SALE_TYPE_SELL     = 'bid_sell';    // sell into bid
const SALE_TYPE_BUY_AMM  = 'pool_buy';    // buy from AMM/pool
const SALE_TYPE_SELL_AMM = 'pool_sale';   // sell into AMM/pool

type SaleKind = 'buy' | 'sell' | 'buyAmm' | 'sellAmm' | 'unknown';

interface KindStyle {
  label: string;
  /** Foreground / accent color for the badge text + border tint. */
  fg: string;
  /** Translucent background tint for the badge. */
  bg: string;
  /** 'buy' tone or 'sell' tone — drives the card's left/right border color. */
  borderTone: 'buy' | 'sell' | 'neutral';
}

// All four kinds share the BUY/SELL text — color alone distinguishes
// AMM vs normal so the badge stays compact and the eye reads side first.
//   buy     — green
//   sell    — red
//   buyAmm  — blue (clearly bluer than green so AMM reads as a different bucket)
//   sellAmm — yellow-orange (noticeably yellow vs the red SELL)
const KIND_STYLES: Record<SaleKind, KindStyle> = {
  buy:     { label: 'BUY',  fg: '#5ce0a0', bg: 'rgba(92,224,160,0.18)',  borderTone: 'buy'  },
  sell:    { label: 'SELL', fg: '#ef7878', bg: 'rgba(239,120,120,0.18)', borderTone: 'sell' },
  buyAmm:  { label: 'BUY',  fg: '#4faee8', bg: 'rgba(79,174,232,0.18)',  borderTone: 'buy'  },
  sellAmm: { label: 'SELL', fg: '#e8c14a', bg: 'rgba(232,193,74,0.18)',  borderTone: 'sell' },
  unknown: { label: '—',    fg: '#8f8fa8', bg: 'rgba(255,255,255,0.05)', borderTone: 'neutral' },
};

function saleKind(saleTypeRaw: string | null): SaleKind {
  switch (saleTypeRaw) {
    case SALE_TYPE_BUY:      return 'buy';
    case SALE_TYPE_SELL:     return 'sell';
    case SALE_TYPE_BUY_AMM:  return 'buyAmm';
    case SALE_TYPE_SELL_AMM: return 'sellAmm';
    default:                 return 'unknown';
  }
}

/**
 * NFT-type → thin border color for the card thumbnail. Backend values:
 *   legacy / pnft        → pale yellow
 *   metaplex_core / core → pale pink
 *   cnft                 → pale purple (visibly distinct from pink)
 *   anything else        → null (no border)
 */
function getNftBorderColor(nftType: string): string | null {
  // Full-opacity colors — the inset dark ring (applied at the call site)
  // gives contrast against light NFTs, so we don't need translucency to
  // soften the colored line; full saturation keeps it readable on dark
  // NFTs and against the feed background.
  switch (nftType) {
    case 'legacy':
    case 'pnft':          return '#ffe082';  // pale yellow
    case 'metaplex_core':
    case 'core':          return '#ff9eb8';  // pale pink
    case 'cnft':          return '#ba8aff';  // pale purple — clearly cooler than pink
    default:              return null;
  }
}

export default function FeedPage() {
  const embedded = useSearchParams()?.get('embed') === '1';
  useEffect(() => { document.title = 'VictoryLabs — Live Feed'; }, []);
  const [filter, setFilter] = useState<FilterKey>('all');
  const [collFilter, setCollFilter] = useState<string | null>(null);
  const [collInput, setCollInput] = useState('');
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

  // Pause without disconnecting: while `paused` is true, incoming SSE
  // events are buffered in `pausedBuffer` instead of dispatched. On resume
  // the buffer drains in order through the reducer (dedup is a property of
  // the reducer's byId Map, so any overlap with snapshot is harmless).
  // Capped at PAUSE_BUFFER_MAX so a long pause can't blow up memory; the
  // oldest entries are dropped first.
  const pausedRef    = useRef(paused);
  const pausedBuffer = useRef<FeedAction[]>([]);
  const PAUSE_BUFFER_MAX = 500;

  // Keep the ref in sync with state. Read from the ref inside the SSE
  // handlers so the long-lived useEffect closure does not need to remount
  // when `paused` toggles — the EventSource stays connected.
  useEffect(() => { pausedRef.current = paused; }, [paused]);

  // Drain on resume. captureScroll once before the batch so a user who
  // scrolled mid-pause keeps their viewport.
  useEffect(() => {
    if (paused) return;
    const buf = pausedBuffer.current;
    if (buf.length === 0) return;
    pausedBuffer.current = [];
    captureScroll();
    for (const action of buf) dispatch(action);
  }, [paused]);

  // Snapshot on mount + live SSE. The connection is opened ONCE per mount
  // and stays open across pause toggles. Pause is implemented inside the
  // event handlers via the `pausedRef` lookup below.
  //
  // Currently subscribed: `sale` (live append), `meta` (enrichment patch),
  // `remove` (post-enrichment blacklist / cNFT floor-gate). `rawpatch`
  // exists in the reducer but is not yet wired here.
  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    // Exponential backoff with jitter on reconnect — caps the herd-thunder
    // pattern when the backend restarts (every connected tab would
    // otherwise hammer the just-rebooted backend on a 3 s grid).
    let attempt = 0;
    const scheduleReconnect = () => {
      if (cancelled || document.hidden) return;
      const base = Math.min(30_000, 1_000 * 2 ** attempt);
      const jitter = Math.random() * 1_000;
      reconnectTimer = setTimeout(connect, base + jitter);
      attempt++;
    };

    /** Buffer-or-dispatch. Read the pause flag from a ref so the effect
     *  closure does not need to reinstall on toggle. captureScroll only
     *  fires for the list-expanding 'live' action; meta/remove never grow
     *  the list. */
    const enqueue = (action: FeedAction) => {
      if (pausedRef.current) {
        const b = pausedBuffer.current;
        b.push(action);
        if (b.length > PAUSE_BUFFER_MAX) {
          // Drop oldest in one splice — keeps the buffer at the cap.
          b.splice(0, b.length - PAUSE_BUFFER_MAX);
        }
        return;
      }
      if (action.type === 'live') captureScroll();
      dispatch(action);
    };

    const connect = () => {
      if (cancelled) return;
      es?.close();
      es = new EventSource(`${API_BASE}/api/events/stream`);
      // Reset backoff once the connection lands so the next disconnect
      // starts from 1 s again instead of inheriting the prior cap.
      es.addEventListener('open', () => { attempt = 0; });
      es.addEventListener('sale', (e: MessageEvent) => {
        try {
          const ev = fromBackend(JSON.parse(e.data) as BackendEvent);
          enqueue({ type: 'live', event: ev });
        } catch { /* malformed frame — skip */ }
      });
      // Enrichment patches: fill in nftName / collectionName / meCollectionSlug
      // for events previously rendered as "Unknown #?". Matches by signature
      // and by mintAddress (same mint in multiple sales benefits from one fetch).
      es.addEventListener('meta', (e: MessageEvent) => {
        try {
          const patch = JSON.parse(e.data) as MetaPatch;
          enqueue({ type: 'meta', patch });
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
          if (signature) enqueue({ type: 'remove', signature });
        } catch { /* malformed frame — skip */ }
      });
      es.addEventListener('error', () => {
        es?.close();
        scheduleReconnect();
      });
    };

    // Pull latest snapshot (newest-first) and dispatch as a single `snapshot`
    // action — the reducer handles dedup against any live events that might
    // have already arrived for the same signatures. The snapshot is mount-
    // time only and bypasses the pause buffer.
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
      // Drop any buffered actions on unmount — they belong to the closed
      // EventSource session and will be replaced by a fresh snapshot the
      // next time this page mounts.
      pausedBuffer.current = [];
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    if (collFilter) {
      const target = collFilter.toLowerCase();
      const slug = e.meCollectionSlug?.toLowerCase() ?? '';
      const name = e.collectionName?.toLowerCase() ?? '';
      if (slug !== target && name !== target) return false;
    }
    const t = e.saleTypeRaw;
    if (filter === 'buy')     return t === SALE_TYPE_BUY;
    if (filter === 'sell')    return t === SALE_TYPE_SELL;
    if (filter === 'buyAmm')  return t === SALE_TYPE_BUY_AMM;
    if (filter === 'sellAmm') return t === SALE_TYPE_SELL_AMM;
    if (filter === 'listing') return false; // backend does not emit listings in v1
    return true;
  }), [events, filter, collFilter, floorBySlug]);

  return (
    <div className="feed-root">
      {!embedded && <TopNav active="feed" />}

      {/* Centered column stage */}
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center', minHeight: 0, padding: '0 0 10px' }}>
        <div style={{ width: '100%', maxWidth: 'var(--feed-column-max, 640px)', display: 'flex', flexDirection: 'column', minHeight: 0, transition: 'max-width 0.28s ease' }}>

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
                {(filter !== 'all' || collFilter) && (
                  <span style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    marginLeft: 6, padding: '2px 8px', fontSize: 10, fontWeight: 600,
                    borderRadius: 4, letterSpacing: '0.2px',
                    border: '1px solid rgba(168,144,232,0.28)',
                    background: 'rgba(168,144,232,0.08)',
                    color: '#a890e8',
                  }}>
                    {filter !== 'all' && (FILTERS.find(f => f.key === filter)?.label ?? filter)}
                    {filter !== 'all' && collFilter && (
                      <span style={{ color: '#56566e' }}>•</span>
                    )}
                    {collFilter && (
                      <span style={{
                        fontFamily: "'SF Mono','Fira Code',monospace",
                        maxWidth: 200, overflow: 'hidden',
                        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      }}>{collFilter}</span>
                    )}
                  </span>
                )}
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
                  color={paused ? '#c9a820' : '#5ce0a0'}
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
                    {FILTERS.map(f => {
                      const isActive = filter === f.key;
                      return (
                        <Pill
                          key={f.key}
                          active={isActive}
                          color={f.color}
                          onClick={() => setFilter(f.key)}
                          label={f.label}
                          size="sm"
                          // Stronger highlight on the active filter — bumped
                          // background opacity, full-color border, subtle glow
                          // — so the current selection reads at a glance.
                          style={isActive ? {
                            background:  `${f.color}38`,
                            border:      `1px solid ${f.color}`,
                            boxShadow:   `0 0 0 1px ${f.color}33, 0 0 8px ${f.color}40`,
                            fontWeight:  700,
                          } : undefined}
                        />
                      );
                    })}
                  </div>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 10, color: '#56566e', marginRight: 2 }}>Collection:</span>
                    <input
                      value={collInput}
                      onChange={(e) => setCollInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          const v = collInput.trim();
                          if (v) { setCollFilter(v); setCollInput(''); }
                        }
                      }}
                      placeholder="collection slug…"
                      spellCheck={false}
                      autoComplete="off"
                      style={{
                        padding: '3px 8px', fontSize: 10.5, borderRadius: 4,
                        border: '1px solid rgba(255,255,255,0.08)',
                        background: 'rgba(255,255,255,0.03)',
                        color: '#e8e6f2', outline: 'none',
                        minWidth: 180, fontFamily: "'SF Mono','Fira Code',monospace",
                        letterSpacing: '0.2px',
                      }}
                    />
                    <Pill
                      active
                      color="#a890e8"
                      onClick={() => {
                        const v = collInput.trim();
                        if (v) { setCollFilter(v); setCollInput(''); }
                      }}
                      label="Add"
                      size="sm"
                    />
                    {collFilter && (
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', gap: 6,
                        padding: '2px 4px 2px 8px', fontSize: 10.5, fontWeight: 600,
                        borderRadius: 4, letterSpacing: '0.2px',
                        border: '1px solid #a890e866',
                        background: '#a890e822',
                        color: '#a890e8',
                        fontFamily: "'SF Mono','Fira Code',monospace",
                        maxWidth: 240, overflow: 'hidden',
                      }}>
                        <span style={{
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        }}>{collFilter}</span>
                        <button
                          type="button"
                          onClick={() => setCollFilter(null)}
                          title="Clear collection filter"
                          style={{
                            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                            width: 14, height: 14, padding: 0, borderRadius: 3,
                            border: 'none', background: 'transparent',
                            color: '#a890e8', cursor: 'pointer', fontSize: 11, lineHeight: 1,
                          }}
                        >✕</button>
                      </span>
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
          wrapper breaks out of `.feed-root`'s 16 px horizontal padding.
          Hidden in embed mode (multi-tab) so the parent page can own the
          chrome; the full-bleed `100vw` would otherwise escape its grid
          cell. */}
      {!embedded && <div style={{
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
          maxWidth: 'var(--status-max, 1400px)', margin: '0 auto',
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
      </div>}

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
