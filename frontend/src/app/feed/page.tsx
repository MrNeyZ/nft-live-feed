'use client';

// Soloist — Live Feed (design port of feed.html)
// Snapshot via REST + live updates via SSE; mapped through `fromBackend`.

import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { FeedEvent } from '@/soloist/mock-data';
import { fromBackend, fromRow } from '@/soloist/from-backend';
import { useBlacklist, FEED_BLACKLIST_KEY } from '@/soloist/blacklist-store';
import { isFeedEventBlacklisted } from '@/soloist/blacklist-filter';
import type { BackendEvent, LatestApiResponse } from '@/soloist/from-backend';
import { LiveDot, Pill, EVENTS_COUNT_EVENT, SETTINGS_PILL_INACTIVE, settingsPillActive, SettingsToggle } from '@/soloist/shared';
import { useInclusiveFees } from '@/soloist/price-mode';
import {
  feedReducer, initFeedState, orderedEvents,
  type MetaPatch, type FeedAction,
} from '@/soloist/feed-store';
import { isCnftDust } from '@/soloist/cnft-filter';
import { playDeepDiscountAlert } from '@/soloist/use-ui-sound';
import type { Density, FilterKey } from './lib/types';
import { FeedCard } from './lib/feed-card';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';
const MAX_EVENTS = 200;
const SNAPSHOT_LIMIT = 100;

// Visible-row cap on the rendered FeedCard list. MAX_EVENTS bounds the
// in-memory ring buffer that the reducer maintains; this constant bounds
// how many of those events actually mount as DOM nodes after filtering.
// During a sustained burst (mint storm, AMM repricing flood) the buffer
// can be 200 events that all pass the active filter, which means 200
// memo'd FeedCards in the DOM — each card paints a thumbnail, time-ago
// chip, FloorChip, and several flex rows. Capping render to 150 keeps
// the layout/paint budget bounded without changing the underlying data
// model: the trimmed rows are still in `events` / `filtered` / the
// seller-dump aggregate, just not in the DOM. Scrollback impact is
// limited to the most-burst-y periods; quiet operation (filtered.length
// < cap) is byte-identical to before.
const MAX_RENDERED_ROWS = 150;

import { sellerCountKey } from './lib/format';

// ── Persisted seller-remaining counts ──────────────────────────────────────
// Helpers (load / persist / debounced flush) live in lib/seller-count-storage.
// The pagehide/beforeunload listener is registered here at module load so the
// page lifecycle owns the side-effect; the helpers themselves remain pure
// re: the page state.
import {
  loadSellerCounts, flushSellerCountsNow, schedulePersistSellerCounts,
} from './lib/seller-count-storage';
if (typeof window !== 'undefined') {
  // Best-effort flush on tab close. `pagehide` is the more reliable
  // mobile-safe sibling of `beforeunload`; both fire synchronously and
  // localStorage.setItem is allowed in either.
  window.addEventListener('pagehide',     flushSellerCountsNow);
  window.addEventListener('beforeunload', flushSellerCountsNow);
}
/** Scroll tolerance (px) for treating the user as "at top". */
const AT_TOP_THRESHOLD = 4;
// Permanent + user blacklist matching lives in the shared pure helper
// (soloist/blacklist-filter), applied at both ingestion boundaries and the
// render backstop so blacklisted sales never paint.





/** Density modes for the live feed surface — drives card padding,
 *  row-wrap spacing, and thumb size. Stored in localStorage as
 *  `vl.feed.density`; default is COMPACT (the current polished
 *  baseline). COMFY adds a notch of breathing room; TAPE shrinks
 *  the thumb (56 → 40) and tightens padding for an ultra-dense
 *  trading-tape look. CSS rules under `.feed-density-{comfy,
 *  compact,tape}` carry the layout deltas (globals.css). */
const DENSITIES: ReadonlyArray<Density> = ['comfy', 'compact', 'tape'];
const DENSITY_LS_KEY = 'vl.feed.density';
function isDensity(v: unknown): v is Density {
  return v === 'comfy' || v === 'compact' || v === 'tape';
}



// ── Feed App ─────────────────────────────────────────────────────────────────


const FILTERS: { key: FilterKey; label: string; color: string }[] = [
  { key: 'all',     label: 'All',        color: '#a890e8' },
  { key: 'buy',     label: 'Buy',        color: '#5ce0a0' },
  { key: 'sell',    label: 'Sell',       color: '#ef7878' },
  { key: 'buyAmm',  label: 'Buy AMM',    color: '#5ce0a0' },
  { key: 'sellAmm', label: 'Sell AMM',   color: '#ef7878' },
  { key: 'listing', label: 'Listings',   color: '#a890e8' },
];

/** Inactive-pill style for Type/Price utility filters inside the
 *  filters panel. Brought up to the same family as
 *  DENSITY_PILL_INACTIVE_STYLE — faint white-α 0.025 fill, white-α
 *  0.08 border, color #8e8eb0 — so the panel reads as one
 *  consistent tone instead of "Density bright / everything else
 *  ghost". Pills are still clearly inactive (no per-color
 *  highlight, no border at full lilac), but visible. Active pills
 *  retain their per-color highlight + glow at the call site, so
 *  the active selection still dominates. */
const FILTER_PILL_INACTIVE_STYLE: React.CSSProperties = {
  background: 'rgba(255, 255, 255, 0.025)',
  border: '1px solid rgba(255, 255, 255, 0.08)',
  color: '#8e8eb0',
};

/** Settings pill styling (SETTINGS_PILL_INACTIVE / settingsPillActive) and the
 *  ⚙ SettingsToggle now live in the shared VictoryLabs settings system
 *  (@/soloist/shared) so Live Feed, Mint Tracker, and future panels render one
 *  identical control language. Imported below. */

/** Density pills are the primary "feed mode" control inside the
 *  filters panel — sized noticeably larger than the Type/Price
 *  utility pills so they read as a segmented control rather than
 *  another tiny toggle, but trimmed back from the prior 4 × 14 /
 *  11.5 px sizing so they don't dominate the panel. Inactive pills
 *  are still subdued (they're not the active mode), but carry a
 *  real bg + border so the row reads as a 3-button segment, not
 *  three ghost chips. */
const DENSITY_PILL_BASE_STYLE: React.CSSProperties = {
  padding:        '3px 12px',
  fontSize:       11,
  letterSpacing:  '0.4px',
};
const DENSITY_PILL_INACTIVE_STYLE: React.CSSProperties = {
  ...DENSITY_PILL_BASE_STYLE,
  background:    'rgba(255, 255, 255, 0.025)',
  border:        '1px solid rgba(255, 255, 255, 0.08)',
  color:         '#8e8eb0',
  fontWeight:    600,
};
const DENSITY_PILL_ACTIVE_STYLE: React.CSSProperties = {
  ...DENSITY_PILL_BASE_STYLE,
  background:    'rgba(168, 144, 232, 0.26)',
  border:        '1px solid #a890e8',
  boxShadow:     '0 0 0 1px rgba(168, 144, 232, 0.36), 0 0 10px rgba(168, 144, 232, 0.42)',
  color:         '#f0eef8',
  fontWeight:    700,
};

import {
  SALE_TYPE_BUY, SALE_TYPE_SELL, SALE_TYPE_BUY_AMM, SALE_TYPE_SELL_AMM,
} from './lib/sale-kind';

export default function FeedPage() {
  // Read query directly off window.location to stay compatible with
  // Next's static prerender (useSearchParams would force a Suspense
  // boundary). Defaults to false on server, hydrates to the real value.
  const [embedded, setEmbedded] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setEmbedded(new URLSearchParams(window.location.search).get('embed') === '1');
  }, []);
  useEffect(() => { document.title = 'Live Feed | VictoryLabs'; }, []);
  // Age-bucket walker — one global setInterval that re-stamps
  // `data-age-bucket` on every `.feed-card[data-event-ts]` element every
  // 30 s. CSS rules under those selectors apply a subtle opacity decay
  // (fresh 1.00, mid 0.92, old 0.86) via a CSS custom property so the
  // age fade stacks multiplicatively with the existing hover-dim. This
  // is intentionally a direct DOM walk, not React state — passing a
  // "now tick" prop into FeedCard would break React.memo and re-render
  // ~150 rows every tick. Cost: ~1 ms/walk.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const tick = () => {
      // Skip the DOM walk on a hidden tab — age buckets aren't user-
      // visible there and the CSS decay catches up the moment the tab
      // returns to visible (next tick walks all cards).
      if (typeof document !== 'undefined' && document.hidden) return;
      const now = Date.now();
      const cards = document.querySelectorAll<HTMLElement>('.feed-card[data-event-ts]');
      for (const card of cards) {
        const tsStr = card.dataset.eventTs;
        if (!tsStr) continue;
        const ts = Number(tsStr);
        if (!Number.isFinite(ts)) continue;
        const ageMin = (now - ts) / 60_000;
        const next = ageMin < 2 ? 'fresh' : ageMin < 5 ? 'mid' : 'old';
        if (card.dataset.ageBucket !== next) card.dataset.ageBucket = next;
      }
    };
    const id = setInterval(tick, 30_000);
    return () => clearInterval(id);
  }, []);
  const [filter, setFilter] = useState<FilterKey>('all');
  // Price-tier quick filter. Independent of `filter` (Type) — both can
  // be active at once. Only one price tier can be selected at a time;
  // clicking the active tier flips back to 'all'.
  const [priceFilter, setPriceFilter] = useState<'all' | 'p001' | 'p01' | 'p1'>('all');
  const [collFilter, setCollFilter] = useState<string | null>(null);
  const [collInput, setCollInput] = useState('');
  // Frontend-only collection blacklist (independent of WATCH). Independent,
  // versioned, persisted store (vl.feed.blacklist.v1) — survives reload,
  // separate from /mints. Normalized lowercased slugs/names; matched here
  // against meCollectionSlug + collectionName.
  const { slugs: blacklistSlugs, add: addBlacklistToken, remove: removeBlacklist } = useBlacklist(FEED_BLACKLIST_KEY);
  const blacklistSet = useMemo(() => new Set(blacklistSlugs), [blacklistSlugs]);
  // Live mirror so the SSE handler (registered once) and the REST snapshot
  // see the CURRENT blacklist without re-subscribing — lets incoming sales
  // be dropped at the boundary even for tokens added mid-session.
  const blacklistSetRef = useRef(blacklistSet);
  useEffect(() => { blacklistSetRef.current = blacklistSet; }, [blacklistSet]);
  const [blInput, setBlInput] = useState('');
  const addBlacklist = (raw: string) => {
    addBlacklistToken(raw);
    setBlInput('');
  };
  const [paused, setPaused] = useState(false);   // manual Pause button
  // Hover auto-pause: freeze the stream while the cursor is over the feed
  // list so fast-scrolling cards/badges stay clickable. Independent of the
  // manual button — effective pause is the OR of the two. Auto-resume on
  // mouse-leave only clears the hover pause, never the manual one.
  const [hoverPauseEnabled, setHoverPauseEnabled] = useState(true);
  const [hoverPaused, setHoverPaused] = useState(false);
  const isPaused = paused || hoverPaused;
  // Per-source data health (defaults to 'ok' before the backend's first
  // `status` frame lands so a brand-new mount doesn't show a false alert).
  const [sourceState, setSourceState] = useState<{ magiceden: 'ok' | 'stale'; tensor: 'ok' | 'stale' }>(
    { magiceden: 'ok', tensor: 'ok' },
  );
  // SSE socket-level status — distinct from `sourceState` (which reflects
  // backend-reported upstream API freshness). Surfaced via console only;
  // no UI slot exists for connection state and the existing meStale chip
  // is reserved for source health, not connection. Held in a ref instead
  // of useState so transitions don't trigger re-renders nobody reads.
  const sseStatusRef = useRef<'connecting' | 'open' | 'error'>('connecting');
  const meStale = sourceState.magiceden === 'stale';
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
  // Two-state mount machine so the close animation has time to play
  // before React unmounts the panel. `filtersMounted` lags
  // `filtersOpen` by the close-animation duration: it flips true
  // immediately on open (so the open-animation runs on a fresh
  // mount), and waits ~180 ms after close before flipping false.
  // Re-opening mid-close cancels the unmount timer via the effect
  // cleanup, so a rapid toggle just restarts the open animation
  // without a flicker. Duration is shared with FILTERS_CLOSE_MS
  // below + the `feedFiltersOut` keyframe (globals.css).
  const FILTERS_CLOSE_MS = 180;
  const [filtersMounted, setFiltersMounted] = useState(false);
  useEffect(() => {
    if (filtersOpen) {
      setFiltersMounted(true);
      return;
    }
    if (!filtersMounted) return;
    const t = setTimeout(() => setFiltersMounted(false), FILTERS_CLOSE_MS);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersOpen]);
  // Inclusive-fees toggle (bottom bar). Affects only AMM_SELL price display
  // — see `displayPrice()` in src/soloist/price-mode.ts. Persisted in
  // localStorage; updates here propagate via the 'vl:priceMode' event.
  const [inclusiveFees] = useInclusiveFees();

  // Live-feed density mode (COMFY / COMPACT / TAPE). Lazy-init from
  // localStorage so the user's prior choice survives page reloads;
  // SSR safely returns 'compact' (current polished baseline). Bad /
  // corrupt values fall through the type guard and reset to compact
  // — never throws. Persistence side-effect lives in the useEffect
  // below so it runs only after hydration (no setItem during SSR).
  const [density, setDensity] = useState<Density>(() => {
    if (typeof window === 'undefined') return 'compact';
    try {
      const v = window.localStorage.getItem(DENSITY_LS_KEY);
      return isDensity(v) ? v : 'compact';
    } catch {
      return 'compact';
    }
  });
  useEffect(() => {
    try { window.localStorage.setItem(DENSITY_LS_KEY, density); } catch { /* noop */ }
  }, [density]);

  // Normalized feed state: dedup + ordering + patching live inside the reducer,
  // so every SSE/REST path below just dispatches a typed action instead of
  // splicing a flat array by hand.
  const [feedState, dispatch] = useReducer(feedReducer, undefined, () => initFeedState(MAX_EVENTS));
  const events = useMemo(() => orderedEvents(feedState), [feedState]);
  // Mirror of `feedState` for the SSE listeners (which can't depend on
  // a state value without re-installing the EventSource on every tick).
  // Used by the seller_count listener to detect orphan patches.
  const feedStateRef = useRef(feedState);
  useEffect(() => { feedStateRef.current = feedState; }, [feedState]);
  // Persistent seller-remaining counts keyed by signature. Backend
  // emits `seller_count` SSE patches asynchronously after each sell-
  // type sale; without persistence the badge would vanish on every
  // page reload (the REST snapshot doesn't carry the count). Hydrated
  // once on mount and updated on every patch — the map is also used
  // to inject counts into late-arriving snapshot/live events that
  // already had their patch processed in a prior session.
  const sellerCountRef = useRef<Map<string, number>>(new Map());
  useEffect(() => { sellerCountRef.current = loadSellerCounts(); }, []);
  // Push the live event count to the persistent BottomStatusBar in
  // Gate. Window-event channel — the bar is no longer this page's
  // child, so prop drilling isn't possible. Consumer ignores stale
  // values when this page unmounts; the last dispatched count remains
  // visible until the next /feed visit refreshes it.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent<number>(EVENTS_COUNT_EVENT, { detail: events.length }));
  }, [events.length]);

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
  const pausedRef    = useRef(isPaused);
  const pausedBuffer = useRef<FeedAction[]>([]);
  const PAUSE_BUFFER_MAX = 500;

  // Keep the ref in sync with the EFFECTIVE pause (manual OR hover). Read
  // from the ref inside the SSE handlers so the long-lived useEffect closure
  // does not need to remount when pause toggles — the EventSource stays
  // connected.
  useEffect(() => { pausedRef.current = isPaused; }, [isPaused]);

  // Drain on resume. captureScroll once before the batch so a user who
  // scrolled mid-pause keeps their viewport.
  useEffect(() => {
    if (isPaused) return;
    const buf = pausedBuffer.current;
    if (buf.length === 0) return;
    pausedBuffer.current = [];
    captureScroll();
    for (const action of buf) dispatch(action);
  }, [isPaused]);

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
      sseStatusRef.current = 'connecting';
      es = new EventSource(`${API_BASE}/api/events/stream`);
      // Reset backoff once the connection lands so the next disconnect
      // starts from 1 s again instead of inheriting the prior cap.
      es.addEventListener('open', () => {
        attempt = 0;
        sseStatusRef.current = 'open';
        console.debug('[sse/feed] connected');
      });
      es.addEventListener('sale', (e: MessageEvent) => {
        try {
          const raw = fromBackend(JSON.parse(e.data) as BackendEvent);
          // Inject any persisted seller-remaining count we already
          // resolved in a prior session — keyed by seller+collection
          // so the same wallet+collection lights up all matching rows
          // immediately, including ones that arrive after a reload.
          const k = sellerCountKey(raw.seller, raw.collectionAddress);
          const persisted = k ? sellerCountRef.current.get(k) : undefined;
          const ev = typeof persisted === 'number'
            ? { ...raw, sellerRemainingCount: persisted }
            : raw;
          // Boundary filter — drop blacklisted sales BEFORE they enter feed
          // state so they never paint (no flash). Uses the live ref so a
          // token blacklisted mid-session takes effect on the next event.
          // (Sales whose collection name only arrives via a later `meta`
          // patch are caught by the render backstop instead.)
          if (isFeedEventBlacklisted(ev, blacklistSetRef.current)) return;
          // Deep-discount alert: only fires from the LIVE SSE path
          // (never from REST snapshot / persisted hydration). Backend
          // floorDelta = (price - floor) / floor, so price <= floor*0.5
          // ↔ floorDelta <= -0.5. When backend's floorDelta is null
          // (floor not yet resolved at sale time) we recompute from the
          // local `floorBySlug` cache — same fallback FeedCard already
          // uses for the FloorChip, just lifted into the alert path so
          // bid_sells with a known cached floor don't silently miss.
          let alertDelta: number | null = typeof ev.floorDelta === 'number' ? ev.floorDelta : null;
          if (alertDelta == null && ev.meCollectionSlug) {
            const f = floorBySlugRef.current[ev.meCollectionSlug];
            const safePrice = Number.isFinite(ev.price) ? ev.price : ev.grossPrice;
            if (typeof f === 'number' && f > 0 && Number.isFinite(safePrice) && safePrice > 0) {
              alertDelta = (safePrice - f) / f;
            }
          }
          if (alertDelta != null && alertDelta <= -0.5) {
            playDeepDiscountAlert(ev.signature);
          }
          enqueue({ type: 'live', event: ev });
        } catch { /* malformed frame — skip */ }
      });
      // Enrichment patches: fill in nftName / collectionName / meCollectionSlug
      // for events previously rendered as "Unknown #?". Matches by signature
      // and by mintAddress (same mint in multiple sales benefits from one fetch).
      es.addEventListener('meta', (e: MessageEvent) => {
        try {
          const patch = JSON.parse(e.data) as MetaPatch;
          // Pass the live blacklist so the reducer can DROP a row whose real
          // collection name/slug is first revealed by this meta frame —
          // removing the late-meta flash for sales that landed name-less.
          enqueue({ type: 'meta', patch, blacklist: blacklistSetRef.current });
        } catch { /* malformed frame — skip */ }
      });
      // Backend fires `remove` for rows deleted after enrichment (blacklisted
      // collections, late cNFT floor-gate). Without this listener the card
      // painted from the earlier `sale` frame would linger forever because
      // `collectionName` is null at sale time and never gets patched (no
      // `meta` frame is emitted for blacklisted rows).
      es.addEventListener('seller_count', (e: MessageEvent) => {
        try {
          const { signature, seller, collection, count, sells10m, signal } = JSON.parse(e.data) as {
            signature?: string;
            seller:     string;
            collection: string;
            count:      number | null;
            sells10m?:  number;
            signal?:    'multi';
          };
          console.log(
            `[seller-count-ui] signature=${signature ?? '—'} ` +
            `seller=${seller} collection=${collection} count=${count ?? 'null'} ` +
            `sells10m=${sells10m ?? '—'} signal=${signal ?? '—'}`,
          );
          if (!seller || !collection) {
            console.log('[seller-count-ui-miss] reason=invalid_payload');
            return;
          }
          // Persist by seller+collection so reloads / future rows from
          // the same wallet+collection can re-attach the count. We
          // only store finite counts; the 🔥 multi-sell signal is
          // ephemeral (re-derived by backend on next sale) so it
          // doesn't survive reload — which is fine, it's a real-time
          // dumping indicator, not historical state.
          if (typeof count === 'number' && Number.isFinite(count)) {
            const k = sellerCountKey(seller, collection)!;
            sellerCountRef.current.set(k, count);
            schedulePersistSellerCounts(sellerCountRef.current);
          }
          // UNSAMPLED orphan check — counts how many feed rows the
          // patch will actually update. 0 means the sale frame either
          // hasn't arrived yet OR the row was evicted (MAX_EVENTS cap).
          // Persistence still keeps the value for any future matching
          // arrival, but a chronic stream of zero-match patches points
          // at a key-mismatch upstream.
          let matches = 0;
          for (const ev of feedStateRef.current.byId.values()) {
            if ((signature && ev.signature === signature) ||
                (ev.seller === seller && ev.collectionAddress === collection)) matches++;
          }
          if (matches === 0) {
            console.log(
              `[seller-count-ui-miss] reason=no_matching_row signature=${signature ?? '—'} ` +
              `seller=${seller} collection=${collection}`,
            );
          }
          enqueue({
            type: 'seller_count',
            patch: { signature, seller, collection, count: count ?? null, sells10m, signal },
          });
        } catch { /* malformed frame — skip */ }
      });
      es.addEventListener('remove', (e: MessageEvent) => {
        try {
          const { signature } = JSON.parse(e.data) as { signature: string };
          if (signature) enqueue({ type: 'remove', signature });
        } catch { /* malformed frame — skip */ }
      });
      // Resize-status patch — backend resize-status-resolver emits this
      // when a prefilter-matching sale's mint completes its on-demand
      // lookup. Frontend renders the RESIZE chip ONLY when the patched
      // value is 'metaplex_resized_unclaimed' (see FeedCard).
      es.addEventListener('resize_status', (e: MessageEvent) => {
        try {
          const patch = JSON.parse(e.data) as { signature: string; mint: string;
            resizeStatus: 'none' | 'metaplex_resized_unclaimed' | 'claimed' | 'user_resized' };
          if (patch.signature && patch.resizeStatus) {
            enqueue({ type: 'resize_status', patch });
          }
        } catch { /* malformed frame — skip */ }
      });
      // Per-source health: backend emits one `status` frame on connect for
      // each known source plus a fresh frame on every state flip. Bypass
      // the pause buffer — operator status info should always be live.
      es.addEventListener('status', (e: MessageEvent) => {
        try {
          const { source, state } = JSON.parse(e.data) as {
            source: 'magiceden' | 'tensor';
            state:  'ok' | 'stale';
          };
          setSourceState(prev => ({ ...prev, [source]: state }));
        } catch { /* malformed frame — skip */ }
      });
      es.addEventListener('error', () => {
        sseStatusRef.current = 'error';
        console.warn('[sse/feed] connection error — scheduling reconnect');
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
        const events: FeedEvent[] = data.events.map(r => {
          const ev = fromBackend(fromRow(r));
          // REST snapshot doesn't carry sellerRemainingCount — re-attach
          // any value we resolved in a prior session, keyed by
          // seller+collection so the badge survives reloads.
          const k = sellerCountKey(ev.seller, ev.collectionAddress);
          const persisted = k ? sellerCountRef.current.get(k) : undefined;
          return typeof persisted === 'number'
            ? { ...ev, sellerRemainingCount: persisted }
            : ev;
        })
          // Boundary filter — drop blacklisted sales out of the hydration
          // snapshot so they never enter state on refresh (no flash).
          .filter(ev => !isFeedEventBlacklisted(ev, blacklistSetRef.current));
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

  // Backfill sweep — runs whenever feedState changes. For any row that
  // has a seller+collection both known but `sellerRemainingCount` not
  // attached, look up the persisted count by (seller, collection) and
  // dispatch a seller_count patch. Closes the race where a prior row's
  // SSE seller_count broadcast set the cache key after this row was
  // inserted, OR where this row's collectionAddress was null at sale
  // time and only resolved later via `meta` (the reducer's `meta` case
  // updates collectionAddress but doesn't re-attempt the count lookup).
  // Idempotent: skips when count is already on the row, or no key
  // resolves, or no persisted value exists.
  useEffect(() => {
    for (const ev of feedState.byId.values()) {
      if (typeof ev.sellerRemainingCount === 'number') continue;
      const k = sellerCountKey(ev.seller, ev.collectionAddress);
      if (!k) continue;
      const persisted = sellerCountRef.current.get(k);
      if (typeof persisted !== 'number') continue;
      // Synthetic patch — re-uses the existing seller_count reducer.
      // No `signature` because we want to match by (seller+collection)
      // which is the persisted key.
      dispatch({
        type:  'seller_count',
        patch: {
          seller:     ev.seller!,
          collection: ev.collectionAddress!,
          count:      persisted,
          sells10m:   ev.sellerSells10m ?? 0,
        },
      });
      // One match per pass — patchWhere fans out to all matching rows
      // anyway, so we don't need to iterate the full set.
      break;
    }
  }, [feedState]);

  // ── Collection-floor lookup ─────────────────────────────────────────────
  // Dual-purpose cache populated from /api/collections/bids:
  //   1. cNFT dust filter — hide cNFT low-floor noise by collection floor,
  //      not sale price. Hides cNFT collections whose CURRENT FLOOR is at or
  //      below 0.005 SOL via the shared `isCnftDust` predicate (Dashboard
  //      uses the same predicate so the two surfaces stay in lockstep).
  //   2. % floor fallback — when the backend didn't compute `floorDelta`
  //      for an event but its slug landed in this cache, FeedCard derives
  //      the chip locally from price/floor.
  // Floor is fetched once per newly-seen slug, batched with a small
  // debounce so bursts don't turn into 1-per-event calls. Backend caches
  // per slug for 60 s, frontend bounds with a 500-entry cap and a 5-min
  // per-slug request TTL.
  const [floorBySlug, setFloorBySlug] = useState<Record<string, number | null>>({});
  // Mirror of `floorBySlug` for the SSE listeners — they install once
  // (deps `[]`) and would otherwise capture an empty initial map.
  // Used by the deep-discount alert path so a sale whose backend
  // `floorDelta` is null can still trip the alert when we have a
  // cached floor for the slug.
  const floorBySlugRef = useRef(floorBySlug);
  useEffect(() => { floorBySlugRef.current = floorBySlug; }, [floorBySlug]);
  // Slug → timestamp of last request. After FLOOR_REQUEST_TTL_MS the slug is
  // eligible for a refresh so a long-running tab doesn't keep stale floors.
  const requestedFloorRef = useRef<Map<string, number>>(new Map());
  const pendingFloorRef   = useRef<Set<string>>(new Set());
  const floorFetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Keep the cNFT floor map bounded — avoids unbounded growth across long
   *  sessions without changing filter behavior. Insertion-order eviction. */
  const FLOOR_BY_SLUG_MAX = 500;
  /** How long a fetched floor is considered fresh enough to skip a refresh. */
  const FLOOR_REQUEST_TTL_MS = 5 * 60_000;

  useEffect(() => {
    const now = Date.now();
    for (const e of events) {
      if (!e.meCollectionSlug) continue;
      const last = requestedFloorRef.current.get(e.meCollectionSlug);
      if (last != null && now - last < FLOOR_REQUEST_TTL_MS) continue;
      pendingFloorRef.current.add(e.meCollectionSlug);
    }
    if (pendingFloorRef.current.size === 0 || floorFetchTimerRef.current) return;
    floorFetchTimerRef.current = setTimeout(async () => {
      floorFetchTimerRef.current = null;
      const batch = Array.from(pendingFloorRef.current).slice(0, 80);
      pendingFloorRef.current.clear();
      const fetchedAt = Date.now();
      for (const s of batch) requestedFloorRef.current.set(s, fetchedAt);
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
          // Bound the map. Object iteration is insertion-order in modern
          // engines; drop the oldest keys until under the cap. Cheap because
          // it only runs when we've genuinely overflowed.
          const keys = Object.keys(next);
          if (keys.length > FLOOR_BY_SLUG_MAX) {
            const drop = keys.length - FLOOR_BY_SLUG_MAX;
            for (let i = 0; i < drop; i++) delete next[keys[i]];
          }
          return next;
        });
      } catch { /* transient — retry path is the next unseen cNFT slug */ }
    }, 500);
  }, [events]);
  useEffect(() => () => {
    if (floorFetchTimerRef.current) clearTimeout(floorFetchTimerRef.current);
  }, []);

  // ── Slug-less cNFT floor (DRiP / Tensor) ────────────────────────────────────
  // The /bids fetch above is ME-slug-keyed; cNFT collections without an ME slug
  // (DRiP, Tensor-native) never get a floor there, so `isCnftDust` failed open.
  // Resolve their floor by ON-CHAIN COLLECTION ADDRESS via /cnft-floor and merge
  // into the SAME `floorBySlug` map (keyed by address — `isCnftDust` looks up
  // `meCollectionSlug ?? collectionAddress`). Mirrors the slug path's debounce /
  // TTL / cap; the ME-slug flow is untouched.
  const requestedCnftAddrRef = useRef<Map<string, number>>(new Map());
  const pendingCnftAddrRef    = useRef<Set<string>>(new Set());
  const cnftFloorTimerRef     = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const now = Date.now();
    for (const e of events) {
      if (e.nftType !== 'cnft' || e.meCollectionSlug || !e.collectionAddress) continue;
      const addr = e.collectionAddress;
      const last = requestedCnftAddrRef.current.get(addr);
      if (last != null && now - last < FLOOR_REQUEST_TTL_MS) continue;
      pendingCnftAddrRef.current.add(addr);
    }
    if (pendingCnftAddrRef.current.size === 0 || cnftFloorTimerRef.current) return;
    cnftFloorTimerRef.current = setTimeout(async () => {
      cnftFloorTimerRef.current = null;
      const batch = Array.from(pendingCnftAddrRef.current).slice(0, 20);
      pendingCnftAddrRef.current.clear();
      const fetchedAt = Date.now();
      for (const a of batch) requestedCnftAddrRef.current.set(a, fetchedAt);
      try {
        const res = await fetch(
          `${API_BASE}/api/collections/cnft-floor?addresses=${encodeURIComponent(batch.join(','))}`,
        );
        if (!res.ok) return;
        const data = await res.json() as {
          floors?: Record<string, { floorLamports: number | null }>;
        };
        if (!data.floors) return;
        setFloorBySlug(prev => {
          const next = { ...prev };
          for (const [addr, v] of Object.entries(data.floors!)) {
            next[addr] = typeof v.floorLamports === 'number' ? v.floorLamports / 1e9 : null;
          }
          const keys = Object.keys(next);
          if (keys.length > FLOOR_BY_SLUG_MAX) {
            const drop = keys.length - FLOOR_BY_SLUG_MAX;
            for (let i = 0; i < drop; i++) delete next[keys[i]];
          }
          return next;
        });
      } catch { /* transient — retried on the next unseen slug-less cNFT */ }
    }, 500);
  }, [events]);
  useEffect(() => () => {
    if (cnftFloorTimerRef.current) clearTimeout(cnftFloorTimerRef.current);
  }, []);

  const filtered = useMemo(() => events.filter(e => {
    // Collection-floor gate for cNFTs (replaces the old sale-price guard):
    // shared predicate — see `@/soloist/cnft-filter`. Hide cNFT low-floor
    // noise by collection floor, not sale price.
    if (isCnftDust(e, s => floorBySlug[s])) return false;
    // Permanent + user blacklist (shared helper). Render-time backstop —
    // the SSE/REST boundaries already drop these before insert, but a card
    // whose collection name only arrives via a late `meta` patch is caught
    // here once the patch lands.
    if (isFeedEventBlacklisted(e, blacklistSet)) return false;
    if (collFilter) {
      const target = collFilter.toLowerCase();
      const slug = e.meCollectionSlug?.toLowerCase() ?? '';
      const name = e.collectionName?.toLowerCase() ?? '';
      if (slug !== target && name !== target) return false;
    }
    // Price-tier gate (independent of Type). When active, drop events
    // whose price is missing/invalid OR below the threshold. Display
    // `price` is the seller-net-preferred figure already in SOL; fall
    // back to gross when the display value isn't finite (paranoia —
    // shouldn't happen for normal sales).
    if (priceFilter !== 'all') {
      const candidate = Number.isFinite(e.price) ? e.price : e.grossPrice;
      if (!Number.isFinite(candidate) || candidate <= 0) return false;
      if (priceFilter === 'p001' && candidate < 0.01) return false;
      if (priceFilter === 'p01'  && candidate < 0.1)  return false;
      if (priceFilter === 'p1'   && candidate < 1)    return false;
    }
    const t = e.saleTypeRaw;
    if (filter === 'buy')     return t === SALE_TYPE_BUY;
    if (filter === 'sell')    return t === SALE_TYPE_SELL;
    if (filter === 'buyAmm')  return t === SALE_TYPE_BUY_AMM;
    if (filter === 'sellAmm') return t === SALE_TYPE_SELL_AMM;
    if (filter === 'listing') return false; // backend does not emit listings in v1
    return true;
  }), [events, filter, priceFilter, collFilter, blacklistSet, floorBySlug]);

  // Per seller+collection sell-side aggregator over the visible feed.
  // Drives the noise-cut on the seller-remaining badge: only the most
  // recent row in each (seller, collection) bucket carries the badge,
  // and only when there's either real activity (2+ visible sells) or
  // the remaining count itself crosses the higher 10-NFT threshold.
  // Computed on `filtered` so price/type/collection filters narrow the
  // window the same way the rendered list does.
  interface SellerDumpInfo { count: number; newestId: string; newestTs: number; }
  const sellerDumpMap = useMemo(() => {
    const m = new Map<string, SellerDumpInfo>();
    for (const ev of filtered) {
      const t = ev.saleTypeRaw;
      const isSell = t === SALE_TYPE_SELL || t === SALE_TYPE_SELL_AMM;
      if (!isSell) continue;
      if (!ev.seller || !ev.collectionAddress) continue;
      const k = `${ev.seller}-${ev.collectionAddress}`;
      const prev = m.get(k);
      if (!prev) {
        m.set(k, { count: 1, newestId: ev.id, newestTs: ev.ts });
      } else {
        prev.count += 1;
        if (ev.ts > prev.newestTs) {
          prev.newestId = ev.id;
          prev.newestTs = ev.ts;
        }
      }
    }
    return m;
  }, [filtered]);

  // Visible slice — bounds the rendered DOM to MAX_RENDERED_ROWS regardless
  // of how many events pass the filter. `filtered` is already sorted
  // newest-first by the reducer, so .slice(0, N) preserves the user's view
  // (most recent activity first) and trims only the tail. When
  // filtered.length <= MAX_RENDERED_ROWS this returns the same array
  // reference content-wise — the cap is a no-op outside burst periods.
  // sellerDumpMap stays computed over the full `filtered` set so the
  // dump-badge aggregation isn't biased by the render cap.
  // In /multi embed mode three card feeds paint side-by-side, so the
  // rendered-DOM cap drops to 60 (from 150) to cut burst-time paint/
  // compositing. Non-embed /feed keeps the full 150. State + aggregates
  // are untouched — this only bounds how many cards mount.
  const renderCap = embedded ? 60 : MAX_RENDERED_ROWS;
  const visible = useMemo(
    () => filtered.length <= renderCap ? filtered : filtered.slice(0, renderCap),
    [filtered, renderCap],
  );

  // Page-level wheel forwarding: when the user scrolls anywhere on the
  // page (including the empty "black" margins outside the centered 640 px
  // column), forward the wheel delta to the feed list. Skipped when the
  // event already targets an element inside `listRef` so the native scroll
  // chain isn't double-stepped, and skipped when the target is a
  // genuinely-scrollable inner element (search dropdown, etc.) so we
  // don't hijack their natural scroll.
  const handleRootWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    const list = listRef.current;
    if (!list) return;
    const target = e.target as Node | null;
    if (target && list.contains(target)) return;            // native chain handles it
    if (e.deltaY === 0) return;
    list.scrollTop += e.deltaY;
  };

  return (
    <div className="feed-root page-transition" data-embedded={embedded ? '1' : undefined} onWheel={handleRootWheel}>
      {/* TopNav rendered persistently by Gate so it survives client-side
          route changes (kills the chrome-unmount flash on navigation). */}

      {/* Centered column stage */}
      <div style={{ flex: 1, display: 'flex', justifyContent: 'center', minHeight: 0, padding: '0 0 10px' }}>
        <div style={{ width: '100%', maxWidth: embedded ? 'none' : 'var(--feed-max, 660px)', display: 'flex', flexDirection: 'column', minHeight: 0, transition: 'max-width 0.28s ease' }}>

          {/* Promoted feed card. In embed mode (multi-tab pane) the
              top margin is dropped so the embedded card top aligns
              flush with the embedded /dashboard table card top. */}
          <div style={{
            flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden',
            background: 'linear-gradient(180deg, #201a3a 0%, #1a1530 100%)',
            border: '1px solid rgba(168,144,232,0.65)',
            borderRadius: 12,
            boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4), 0 0 28px rgba(128,104,216,0.15)',
            margin: embedded ? 0 : '14px 0 3px',
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
                <LiveDot />
                {/* Event count — dimmed from #8068d8 → #56566e so the
                    title "Live events" + the LiveDot stay primary; the
                    count is supplementary context (operator usually
                    reads the rows, not the number). */}
                <span style={{ fontSize: 11, fontWeight: 500, color: '#56566e', marginLeft: 4 }}>
                  ({filtered.length.toLocaleString()})
                </span>
                {/* Source-health indicator. Green = both sources fresh.
                    Red = Magic Eden stale (most common: ME API stalls
                    while Tensor keeps producing events). Resting OK
                    state is now noticeably subtler (~30 % of the prior
                    saturation) — only the STALE state remains loud,
                    which is the correct attention model: silent when
                    healthy, alarming when not. */}
                <span
                  
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 3,
                    marginLeft: 4, padding: '1px 5px', borderRadius: 3,
                    fontSize: 9.5, fontWeight: 700, letterSpacing: '0.3px',
                    border: meStale ? '1px solid #ef787866' : '1px solid rgba(92,224,160,0.22)',
                    background: meStale ? 'rgba(239,120,120,0.14)' : 'transparent',
                    color: meStale ? '#ef7878' : 'rgba(92,224,160,0.65)',
                    cursor: 'help',
                  }}
                >
                  <span style={{
                    display: 'inline-block', width: 5, height: 5, borderRadius: '50%',
                    background: meStale ? '#ef7878' : '#5ce0a0',
                    boxShadow: meStale ? '0 0 6px #ef787880' : '0 0 4px rgba(92,224,160,0.40)',
                  }} />
                  ME {meStale ? 'STALE' : 'OK'}
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
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                <SettingsToggle
                  active={filtersOpen}
                  onClick={() => setFiltersOpen(o => !o)}
                />
                {/* Density + Hover-pause live inside the Settings panel below —
                    the top bar stays [Settings][Pause]. (vl.feed.density
                    persistence + pause logic unchanged.) */}
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
              {filtersMounted && (
                <div className={`feed-filters-panel ${filtersOpen ? 'feed-filters-panel-open' : 'feed-filters-panel-close'}`}>
                  {/* Settings organized into three semantic groups, each an
                      aligned label/control grid. Compact, low-weight controls
                      (see SETTINGS_PILL_* + .feed-srow). Collapses to a single
                      column on narrow widths via CSS. */}
                  <div className="feed-settings">
                    {/* GROUP 1 — CONTENT (sale-direction filter) */}
                    <div className="feed-set-group feed-set-group--content">
                      <div className="feed-set-group-hd">Content</div>
                      <div className="feed-srow">
                        <span className="feed-srow-lbl">Type</span>
                        <div className="feed-srow-ctl">
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
                                style={isActive ? settingsPillActive(f.color) : SETTINGS_PILL_INACTIVE}
                              />
                            );
                          })}
                        </div>
                      </div>
                    </div>

                    {/* GROUP 2 — DISPLAY (price · density · hover pause) */}
                    <div className="feed-set-group feed-set-group--display">
                      <div className="feed-set-group-hd">Display</div>
                      {/* PRICE — segmented min-price selector. 'Any' clears the
                          gate; thresholds match the existing filter logic. */}
                      <div className="feed-srow" role="group" aria-label="Minimum price">
                        <span className="feed-srow-lbl">Price</span>
                        <div className="feed-srow-ctl feed-seg">
                          {([
                            { key: 'all',  label: 'Any'  },
                            { key: 'p001', label: '0.01' },
                            { key: 'p01',  label: '0.1'  },
                            { key: 'p1',   label: '1.0'  },
                          ] as const).map(p => {
                            const isActive = priceFilter === p.key;
                            return (
                              <Pill
                                key={p.key}
                                active={isActive}
                                color="#a890e8"
                                onClick={() => setPriceFilter(p.key)}
                                label={p.label}
                                size="sm"
                                style={isActive ? settingsPillActive('#a890e8') : SETTINGS_PILL_INACTIVE}
                              />
                            );
                          })}
                        </div>
                      </div>
                      {/* DENSITY — feed mode (vl.feed.density persistence unchanged) */}
                      <div className="feed-srow" role="group" aria-label="Card density">
                        <span className="feed-srow-lbl">Density</span>
                        <div className="feed-srow-ctl feed-seg">
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
                      {/* HOVER PAUSE — iOS-style switch. Behavior unchanged:
                          On = hovering the feed list auto-pauses + leaving
                          resumes; manual Pause overrides. Turning Off clears
                          any in-effect hover pause so the stream resumes. */}
                      <div className="feed-srow" role="group" aria-label="Hover pause">
                        <span className="feed-srow-lbl">Hover</span>
                        <div className="feed-srow-ctl">
                          <button
                            type="button"
                            role="switch"
                            aria-checked={hoverPauseEnabled}
                            
                            onClick={() => setHoverPauseEnabled(prev => {
                              const next = !prev;
                              if (!next) setHoverPaused(false);
                              return next;
                            })}
                            className={`vl-switch${hoverPauseEnabled ? ' vl-switch-on' : ''}`}
                          >
                            <span className="vl-switch-thumb" />
                          </button>
                          <span className="feed-srow-hint">{hoverPauseEnabled ? 'On' : 'Off'}</span>
                        </div>
                      </div>
                    </div>

                    {/* GROUP 3 — LISTS (watch · blacklist) */}
                    <div className="feed-set-group feed-set-group--lists">
                      <div className="feed-set-group-hd">Lists</div>
                      {/* WATCH — pin the feed to one collection slug. */}
                      <div className="feed-srow">
                        <span className="feed-srow-lbl">Watch</span>
                        <div className="feed-srow-ctl">
                          <input
                            className="feed-coll-input"
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
                          />
                          <Pill
                            active
                            color="#a890e8"
                            onClick={() => {
                              const v = collInput.trim();
                              if (v) { setCollFilter(v); setCollInput(''); }
                            }}
                            label="+"
                            
                            size="sm"
                            style={settingsPillActive('#a890e8')}
                          />
                          {collFilter && (
                            <span className="feed-chip feed-chip-watch">
                              <span className="feed-chip-txt">{collFilter}</span>
                              <button
                                type="button"
                                onClick={() => setCollFilter(null)}
                                
                                className="feed-chip-x"
                              >✕</button>
                            </span>
                          )}
                        </div>
                      </div>
                      {/* BLACKLIST — temporary, frontend-only excludes (pink).
                          Multi-slug; never persisted / sent to the backend. */}
                      <div className="feed-srow">
                        <span className="feed-srow-lbl">Blacklist</span>
                        <div className="feed-srow-ctl">
                          <input
                            className="feed-coll-input"
                            value={blInput}
                            onChange={(e) => setBlInput(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter') addBlacklist(blInput); }}
                            placeholder="collection slug…"
                            spellCheck={false}
                            autoComplete="off"
                          />
                          <Pill
                            active
                            color="#e58aa3"
                            onClick={() => addBlacklist(blInput)}
                            label="+"
                            
                            size="sm"
                            style={settingsPillActive('#e58aa3')}
                          />
                          {blacklistSlugs.map((slug) => (
                            <span key={slug} className="feed-chip feed-chip-bl">
                              <span className="feed-chip-txt">{slug}</span>
                              <button
                                type="button"
                                onClick={() => removeBlacklist(slug)}
                                
                                className="feed-chip-x"
                              >✕</button>
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                  </div>{/* /feed-settings */}
                </div>
              )}

              {/* Feed list */}
              <div
                ref={listRef}
                className={`feed-list feed-density-${density}`}
                /* Hover auto-pause attaches to the events container ONLY (not
                   the header/filters). mouseenter/mouseleave don't fire when
                   moving between child cards, so there's no flicker. Entering
                   arms hover-pause unless the user already manually paused;
                   leaving clears only the hover pause (manual stays). */
                onMouseEnter={() => { if (hoverPauseEnabled && !paused) setHoverPaused(true); }}
                onMouseLeave={() => { if (hoverPaused) setHoverPaused(false); }}
                style={{ flex: 1, overflowY: 'auto', padding: '6px 10px 10px 13px' }}
              >
                {filtered.length === 0 && (
                  meStale ? (
                    <div style={{
                      textAlign: 'center', padding: '40px 16px', fontSize: 13,
                      color: '#ef7878',
                      border: '1px solid rgba(239,120,120,0.28)',
                      background: 'rgba(239,120,120,0.06)',
                      borderRadius: 8, margin: '24px 8px',
                    }}>
                      <div style={{ fontWeight: 700, marginBottom: 4, letterSpacing: '0.3px' }}>
                        ⚠ Magic Eden data is stale
                      </div>
                      <div style={{ fontSize: 11.5, color: '#c98787', fontWeight: 500 }}>
                        No events received from Magic Eden recently. Tensor data still flowing.
                      </div>
                    </div>
                  ) : (
                    <div style={{ textAlign: 'center', color: '#55556e', padding: '48px 0', fontSize: 13 }}>
                      No events match current filters
                    </div>
                  )
                )}
                {visible.map(e => {
                  // Per-card slug-floor lookup. `floorBySlug` is keyed
                  // by ME slug; cards without a slug or without a
                  // cached floor pass `null` and fall back to backend
                  // floorDelta only inside the card.
                  const slugFloor = e.meCollectionSlug ? floorBySlug[e.meCollectionSlug] ?? null : null;
                  const dk = e.seller && e.collectionAddress ? `${e.seller}-${e.collectionAddress}` : null;
                  const dump = dk ? sellerDumpMap.get(dk) : undefined;
                  const sellerSellCountInFeed = dump?.count ?? 0;
                  const isNewestSellForSellerColl = !!dump && dump.newestId === e.id;
                  return (
                    <FeedCard
                      key={e.id}
                      event={e}
                      onPreview={setPreview}
                      inclusiveFees={inclusiveFees}
                      slugFloor={slugFloor}
                      sellerSellCountInFeed={sellerSellCountInFeed}
                      isNewestSellForSellerColl={isNewestSellForSellerColl}
                      density={density}
                    />
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom status — shared component. Hidden in embed mode (multi-tab)
          so the parent page can own the chrome; the full-bleed `100vw`
          would otherwise escape its grid cell. */}

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
