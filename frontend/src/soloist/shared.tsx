'use client';

// Shared presentational primitives used across the Soloist design.
// Port of soloist-shared.jsx — kept visually identical.

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  Marketplace, rndFloat, rndInt,
} from './mock-data';
import { useCollectionIcons } from './collection-icons';
import { clearAuth as runtimeClearAuth } from '@/runtime/auth';
import { setMode as runtimeSetMode, fetchMode as runtimeFetchMode, type RuntimeMode } from '@/runtime/mode';
import { sendHeartbeat, HEARTBEAT_INTERVAL_MS } from '@/runtime/heartbeat';
import { useLayoutMode, LAYOUT_MODES } from './layout-mode';

// Route http(s) image URLs through our own `/thumb` endpoint so thumbnails
// render at 200×200 instead of the full-size upstream asset (PFP originals
// commonly 2 000×2 000 / ~2 MB). `/thumb` is served by nginx in production
// (proxy_pass to wsrv.nl, with `proxy_cache` + Cloudflare edge cache for
// cross-user reuse) and by a Next.js rewrite in dev (see next.config.mjs).
// GIFs are forced to static PNG via wsrv's `output=png` flag to prevent
// animation + scroll jank. irys.xyz hosts are bypassed (wsrv returns HTTP
// 400 "Domain or TLD blocked by policy" for them — the raw URL renders
// better than a broken proxy response). Non-http URLs (data URIs, relative
// paths) pass through untouched.
export function compressImage(url: string | null | undefined): string | null {
  if (!url) return null;
  if (!(url.startsWith('http://') || url.startsWith('https://'))) return url;
  if (url.includes('irys.xyz')) return url;
  const isGif = /\.gif(\?|$)/i.test(url);
  const base = `/thumb?url=${encodeURIComponent(url)}&w=200&h=200&fit=cover`;
  return isGif ? `${base}&output=png` : base;
}

// Row-as-link helpers — used by navigable rows that cannot nest inside an
// `<a>` (e.g. `<tr>`). `linkNav` intercepts Cmd/Ctrl/Shift/middle-click and
// opens the href in a new tab, returning `true` so the caller knows not to
// run its own normal-left-click navigation. `rowLinkHandlers` bundles this
// with `onAuxClick` for middle-click. Right-click / browser link menu is
// not provided by these handlers — callers that need it should also render
// an `<a href>` inside the row (e.g. around the name cell).
export function linkNav(e: React.MouseEvent, href: string): boolean {
  if (e.metaKey || e.ctrlKey || e.shiftKey || (e as React.MouseEvent).button === 1) {
    e.preventDefault();
    window.open(href, '_blank', 'noopener,noreferrer');
    return true;
  }
  return false;
}

/**
 * Transparent `<a href>` sized to fill its nearest positioned ancestor.
 * Pair with `position: relative` on a `<tr>` (or wrapping element) and you
 * get whole-row link semantics: right-clicking anywhere over the row gives
 * the browser's native link context menu. Plain clicks are `preventDefault`
 * so the row's own click handler owns same-tab navigation; modifier /
 * middle clicks bubble up to `rowLinkHandlers` which opens a new tab.
 */
export function RowLinkOverlay({ href }: { href: string | null }) {
  if (!href) return null;
  return (
    <a
      href={href}
      aria-hidden
      tabIndex={-1}
      onClick={(e) => e.preventDefault()}
      style={{ position: 'absolute', inset: 0, zIndex: 0, background: 'transparent' }}
    />
  );
}

export function rowLinkHandlers(href: string, onLeftClick: () => void) {
  return {
    onClick: (e: React.MouseEvent) => {
      if (linkNav(e, href)) return;
      onLeftClick();
    },
    // React's onAuxClick fires for non-primary mouse buttons (1 = middle).
    onAuxClick: (e: React.MouseEvent) => {
      if (e.button !== 1) return;
      e.preventDefault();
      window.open(href, '_blank', 'noopener,noreferrer');
    },
  };
}

// Reverse of `compressImage` for fallback: extract the upstream URL from a
// thumbnail proxy URL — both our own `/thumb?url=…` form (production +
// dev) and the legacy `https://wsrv.nl/?url=…` form (still recognised in
// case a stale URL was cached somewhere). wsrv blocks many custom hosts
// by policy (returns HTTP 400 "Domain or TLD blocked") — e.g.
// sensei.launchifi.xyz. ItemThumb / CollectionIcon retry with this raw
// URL once before showing the placeholder so those collections don't
// lose their thumbnails. Non-proxy inputs pass through untouched.
function rawUpstreamImage(u: string): string {
  try {
    // Relative `/thumb?url=…` — same-origin proxy. Parse against a dummy
    // base because URL() refuses bare relative strings.
    if (u.startsWith('/thumb')) {
      const parsed = new URL(u, 'http://x');
      const raw = parsed.searchParams.get('url');
      if (!raw) return u;
      return (raw.startsWith('http://') || raw.startsWith('https://')) ? raw : `https://${raw}`;
    }
    const parsed = new URL(u);
    if (parsed.hostname !== 'wsrv.nl') return u;
    const raw = parsed.searchParams.get('url');
    if (!raw) return u;
    return (raw.startsWith('http://') || raw.startsWith('https://')) ? raw : `https://${raw}`;
  } catch { return u; }
}

// Image-capable thumb used by Collection page (32px) and Live Feed (56px).
// Falls back to the NFTThumb abbr/color placeholder when the image URL is
// missing or fails to load. Lazy + async so a long list never blocks first
// paint on image decode.
export const ItemThumb = memo(function ItemThumb({
  imageUrl, color, abbr, size,
}: { imageUrl: string | null | undefined; color: string; abbr: string; size: number }) {
  const [errored, setErrored] = useState(false);
  const [fellBack, setFellBack] = useState(false);
  if (!imageUrl || errored) return <NFTThumb color={color} abbr={abbr} size={size} />;
  // On first load error try the raw upstream URL (wsrv may have refused the
  // host). If that fails too, fall back to the initials placeholder.
  const src = fellBack ? rawUpstreamImage(imageUrl) : imageUrl;
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => { if (!fellBack) setFellBack(true); else setErrored(true); }}
      style={{ width: size, height: size, borderRadius: 4, objectFit: 'cover', display: 'block', background: '#0e0b22' }}
    />
  );
});

export function NFTThumb({ color, abbr, size = 36 }: { color: string; abbr: string; size?: number }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: 6, flexShrink: 0,
      background: `linear-gradient(135deg, ${color}38 0%, ${color}14 100%)`,
      border: `1px solid ${color}22`,
      boxShadow: `inset 0 1px 0 ${color}14, 0 1px 2px rgba(0,0,0,0.3)`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.28, fontWeight: 700, color: color + 'cc', userSelect: 'none',
    }}>{abbr}</div>
  );
}

// Circular collection avatar that attempts a real image and falls back to the
// initials/color placeholder on missing / failed load. Callers pass a URL
// that has already been routed through `compressImage()` so the same wsrv.nl
// resize + GIF-to-PNG + irys-bypass rules apply everywhere.
export const CollectionIcon = memo(function CollectionIcon({
  imageUrl, color, abbr, size = 40,
}: { imageUrl: string | null | undefined; color: string; abbr: string; size?: number }) {
  const [errored, setErrored] = useState(false);
  const [fellBack, setFellBack] = useState(false);
  if (!imageUrl || errored) return <CollectionCircle color={color} abbr={abbr} size={size} />;
  const src = fellBack ? rawUpstreamImage(imageUrl) : imageUrl;
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => { if (!fellBack) setFellBack(true); else setErrored(true); }}
      style={{
        width: size, height: size, borderRadius: '50%',
        objectFit: 'cover', display: 'block',
        background: '#0e0b22',
        border: `1px solid ${color}2a`,
        flexShrink: 0,
      }}
    />
  );
});

export function CollectionCircle({ color, abbr, size = 40 }: { color: string; abbr: string; size?: number }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: '50%', flexShrink: 0,
      background: `linear-gradient(135deg, ${color}3d 0%, ${color}14 100%)`,
      border: `1px solid ${color}2a`,
      boxShadow: `inset 0 1px 0 ${color}18, 0 2px 6px rgba(0,0,0,0.35), 0 0 12px ${color}18`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.28, fontWeight: 700, color: color + 'd0', userSelect: 'none',
    }}>{abbr}</div>
  );
}

/**
 * Unified Pill primitive for filter/tab/timeframe buttons.
 *
 * Centralises the repeated inline `{ padding, fontSize, fontWeight,
 * borderRadius, border, background, color, cursor }` block used across
 * the Dashboard, Live Feed, Collection page, and runtime Gate. One look,
 * two visual states (active/idle), optional color override for semantic
 * tints (e.g. green "buys", red "sells"), optional leading icon.
 *
 * Does NOT own business logic — callers still supply `active` and `onClick`.
 * `color` defaults to the app's brand purple; pass a hex to keep the
 * row/button coherent with its semantic accent.
 */
export function Pill({
  label, active = false, color = '#a890e8',
  onClick, icon, title, disabled = false, size = 'md', style,
}: {
  label:    React.ReactNode;
  active?:  boolean;
  color?:   string;      // base hex for the active-tint palette
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  icon?:    React.ReactNode;
  title?:   string;
  disabled?: boolean;
  size?:    'sm' | 'md';
  style?:   React.CSSProperties;
}) {
  const pad      = size === 'sm' ? '2px 8px' : '3px 10px';
  const fontSize = size === 'sm' ? 10 : 10.5;
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: pad, fontSize, fontWeight: 600, borderRadius: 4,
        letterSpacing: '0.3px',
        border:     active ? `1px solid ${color}66` : '1px solid rgba(255,255,255,0.08)',
        background: active ? `${color}22`           : 'rgba(255,255,255,0.03)',
        color:      active ? color                  : '#8f8fa8',
        cursor:     disabled ? 'not-allowed' : 'pointer',
        opacity:    disabled ? 0.55 : 1,
        transition: 'all 0.12s',
        ...style,
      }}
    >
      {icon}
      {label}
    </button>
  );
}

export function LiveDot({ color = '#4fb67d' }: { color?: string }) {
  return (
    <span style={{
      display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
      background: color, boxShadow: `0 0 8px ${color}, 0 0 2px ${color}`,
      animation: 'pulseDot 2s ease-in-out infinite',
    }} />
  );
}

export function RankBadge({ rank }: { rank: number }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', fontSize: 10, fontWeight: 500,
      padding: '1px 6px', borderRadius: 3, border: '1px solid #8068d818',
      background: '#8068d808', color: '#7a6a9c', letterSpacing: '0.2px',
      fontFamily: "'SF Mono','Fira Code',monospace", flexShrink: 0, lineHeight: '14px',
    }}>R {rank}</span>
  );
}

export function TypeBadge({ type }: { type: 'buy' | 'sell' }) {
  if (type === 'buy') return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', fontSize: 10, fontWeight: 700,
      padding: '1px 6px', borderRadius: 3, border: '1px solid #36b86848',
      background: '#36b86820', color: '#5ce0a0', letterSpacing: '0.3px',
      flexShrink: 0, lineHeight: '14px',
    }}>BUY</span>
  );
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', fontSize: 10, fontWeight: 700,
      padding: '1px 6px', borderRadius: 3, border: '1px solid #bf5f5f48',
      background: '#bf5f5f20', color: '#ef7878', letterSpacing: '0.3px',
      flexShrink: 0, lineHeight: '14px',
    }}>SELL</span>
  );
}

/**
 * Brand-PNG marketplace badge (Live Feed variant) — same `/brand/{me,tensor}.png`
 * assets the Collection header uses, sized and chrome-styled identically so
 * the two surfaces read consistently. Falls back to the text `MktBadge` for
 * any unknown marketplace value. Click-handling mirrors `MktBadge` exactly:
 * `stopPropagation` so a badge click doesn't bubble into the row.
 */
export function MktIconBadge({ mp, href }: { mp: Marketplace; href?: string | null }) {
  const src = mp === 'me' ? '/brand/me.png' : mp === 'tensor' ? '/brand/tensor.png' : null;
  if (!src) return <MktBadge mp={mp} href={href} />;
  const chip: React.CSSProperties = {
    display:'inline-flex', alignItems:'center', justifyContent:'center',
    width:18, height:18, borderRadius:4, overflow:'hidden',
    border:'1px solid rgba(255,255,255,0.08)',
    flexShrink:0, lineHeight:0,
  };
  const img = (
    <img
      src={src}
      alt=""
      draggable={false}
      style={{ display:'block', width:'100%', height:'100%', objectFit:'cover', pointerEvents:'none' }}
    />
  );
  if (href) {
    return (
      <a href={href} target="_blank" rel="noreferrer noopener"
         onClick={(e) => e.stopPropagation()}
         style={{ ...chip, cursor:'pointer', textDecoration:'none' }}>
        {img}
      </a>
    );
  }
  return <span style={chip}>{img}</span>;
}

export function MktBadge({ mp, href }: { mp: Marketplace; href?: string | null }) {
  const meStyle = {
    display: 'inline-flex', alignItems: 'center', fontSize: 10, fontWeight: 700,
    padding: '1px 6px', borderRadius: 3, border: '1px solid #d63d7c48',
    background: '#d63d7c20', color: '#e87ab0', letterSpacing: '0.2px',
    flexShrink: 0, lineHeight: '14px',
  } as const;
  const tStyle = {
    display: 'inline-flex', alignItems: 'center', fontSize: 10, fontWeight: 700,
    padding: '1px 6px', borderRadius: 3, border: '1px solid #8068d848',
    background: '#8068d820', color: '#a890e8', letterSpacing: '0.2px',
    flexShrink: 0, lineHeight: '14px',
  } as const;
  const style = mp === 'me' ? meStyle : tStyle;
  const label = mp === 'me' ? 'ME' : 'T';
  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noreferrer noopener"
        onClick={(e) => e.stopPropagation()}
        style={{ ...style, cursor: 'pointer', textDecoration: 'none' }}
      >{label}</a>
    );
  }
  return <span style={style}>{label}</span>;
}

// ── Top Nav ─────────────────────────────────────────────────────────────────

type Page = 'dashboard' | 'collection' | 'feed' | 'multi';

/** Search candidate sourced from real recent sales — every entry has a real
 *  ME slug, the only thing the dynamic /collection/[slug] route accepts. */
interface SearchHit {
  name:    string;
  slug:    string;
  abbr:    string;
  color:   string;
  floor:   number;
  iconUrl: string | null;
}

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

/** Fallback abbreviation derivation — mirrors `collectionMeta` in from-backend.ts.
 *  Used when search rows aren't in the curated COLLECTIONS_DB. */
function abbrOf(name: string): string {
  const w = name.split(/\s+/).filter(Boolean);
  return ((w.length >= 2 ? (w[0][0] ?? '') + (w[1][0] ?? '') : name.slice(0, 2)) || '??').toUpperCase();
}
function colorOf(name: string): string {
  let h = 0; for (let i = 0; i < name.length; i++) h = (h + name.charCodeAt(i)) | 0;
  const palette = ['#ff8c42', '#36b868', '#8068d8', '#4e8cd4', '#c9a820', '#28a878', '#d47832', '#b01d62', '#2fa8d8', '#c084fc', '#e879f9'];
  return palette[Math.abs(h) % palette.length];
}

export function TopNav({ active }: { active: Page }) {
  // Live market header stats — fetched once on mount + every 20 min from the
  // backend /api/market/header (server-side cached). Fall back to the old
  // visual placeholders only until the first fetch resolves so nothing flashes
  // as null while the request is in flight.
  const [sol, setSol] = useState<string>(() => rndFloat(38, 42).toFixed(2));
  const [tps, setTps] = useState<number>(() => rndInt(2100, 2800));
  useEffect(() => {
    let cancelled = false;
    const load = () => fetch(`${API_BASE}/api/market/header`)
      .then(r => r.ok ? r.json() : null)
      .then((data: { tps?: number | null; solUsd?: number | null } | null) => {
        if (cancelled || !data) return;
        if (typeof data.tps    === 'number') setTps(data.tps);
        if (typeof data.solUsd === 'number') setSol(data.solUsd.toFixed(2));
      })
      .catch(() => { /* keep prior value */ });
    load();
    const id = setInterval(load, 20 * 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Frontend-tab liveness ping. Only main app pages render TopNav, so mounting
  // the heartbeat here gives it exactly the scope the backend expects —
  // Dashboard / Live Feed / Collection page, never /access. If every tab
  // closes, the backend's idle watcher flips runtime mode to `off` and stops
  // burning Helius credits on its own.
  useEffect(() => {
    sendHeartbeat();
    const id = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
    return () => { clearInterval(id); };
  }, []);

  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const searchRef = useRef<HTMLDivElement>(null);

  // MULTI-TAB replaces the old COLLECTION button (collection details are
  // already reachable via the search bar / dashboard rows). It opens the
  // combined dashboard + live-feed page.
  const pages: { key: Page; label: string; href: string }[] = [
    { key: 'dashboard',  label: 'DASHBOARD',  href: '/dashboard' },
    { key: 'multi',      label: 'MULTI-TAB',  href: '/multi'     },
    { key: 'feed',       label: 'LIVE FEED',  href: '/feed'      },
  ];

  // Build a real (name → slug) index from recent sales so search results
  // always carry a slug suitable for /collection/[slug]. One snapshot fetch
  // per mount; trending list reflects whatever's actually trading.
  const [hits, setHits] = useState<SearchHit[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE}/api/events/latest?limit=200`)
      .then(r => r.ok ? r.json() : { events: [] })
      .then((data: { events: Array<{ collection_name?: string | null; me_collection_slug?: string | null }> }) => {
        if (cancelled) return;
        const counts = new Map<string, { name: string; slug: string; n: number }>();
        for (const e of data.events ?? []) {
          const name = (e.collection_name ?? '').trim();
          const slug = (e.me_collection_slug ?? '').trim();
          if (!name || !slug || name === 'Unknown') continue;
          const cur = counts.get(slug);
          if (cur) cur.n++;
          else counts.set(slug, { name, slug, n: 1 });
        }
        // iconUrl is resolved at render time via useCollectionIcons — no
        // per-NFT image ever leaks into the collection-avatar path.
        const arr: SearchHit[] = Array.from(counts.values())
          .sort((a, b) => b.n - a.n)
          .map(({ name, slug }) => ({
            name, slug, abbr: abbrOf(name), color: colorOf(name), floor: 0,
            iconUrl: null,
          }));
        setHits(arr);
      })
      .catch(() => { /* search will simply show empty until it succeeds */ });
    return () => { cancelled = true; };
  }, []);

  // Global search results populated from the backend /api/collections/search
  // endpoint with a 300 ms debounce. Merged with the local TRENDING hits so a
  // new user starts with zero-latency suggestions but can discover any slug
  // the backend has ever ingested (not just this session's history).
  const [remoteHits, setRemoteHits] = useState<SearchHit[]>([]);
  useEffect(() => {
    const qq = q.trim().toLowerCase();
    if (qq.length < 2) { setRemoteHits([]); return; }
    const t = setTimeout(() => {
      let cancelled = false;
      fetch(`${API_BASE}/api/collections/search?q=${encodeURIComponent(qq)}`)
        .then(r => r.ok ? r.json() : { results: [] })
        .then((data: { results: Array<{ slug: string; name: string; imageUrl: string | null }> }) => {
          if (cancelled) return;
          setRemoteHits((data.results ?? []).map(r => ({
            name:    r.name,
            slug:    r.slug,
            abbr:    abbrOf(r.name),
            color:   colorOf(r.name),
            floor:   0,
            // Collection icon resolved via useCollectionIcons hook below —
            // backend search's item-image field is ignored on purpose.
            iconUrl: null,
          })));
        })
        .catch(() => { /* transient — debounce will refire on next keystroke */ });
      return () => { cancelled = true; };
    }, 300);
    return () => clearTimeout(t);
  }, [q]);

  const results = useMemo(() => {
    if (!q.trim()) return hits.slice(0, 8);
    const qq = q.toLowerCase();
    const bySlug = new Map<string, SearchHit>();
    // Local instant matches first (zero latency).
    for (const c of hits) {
      if (c.name.toLowerCase().includes(qq) || c.slug.toLowerCase().includes(qq)) {
        bySlug.set(c.slug, c);
      }
    }
    // Global results from backend — dedup by slug, local-first.
    for (const c of remoteHits) if (!bySlug.has(c.slug)) bySlug.set(c.slug, c);
    return Array.from(bySlug.values()).slice(0, 8);
  }, [q, hits, remoteHits]);

  // Resolve official collection icons for whatever is currently visible.
  const resultSlugs = useMemo(() => results.map(c => c.slug), [results]);
  const iconBySlug = useCollectionIcons(resultSlugs);

  const pickCollection = (col: SearchHit) => {
    setOpen(false);
    setQ('');
    // Navigate by slug — the only thing the dynamic route accepts. No more
    // localStorage / "current collection" plumbing for the static template.
    window.location.href = `/collection/${encodeURIComponent(col.slug)}`;
  };

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && (document.activeElement as HTMLElement | null)?.tagName !== 'INPUT') {
        e.preventDefault();
        searchRef.current?.querySelector('input')?.focus();
      }
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown')      { e.preventDefault(); setHi(h => Math.min(h + 1, results.length - 1)); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); setHi(h => Math.max(0, h - 1)); }
    else if (e.key === 'Enter' && results[hi]) { e.preventDefault(); pickCollection(results[hi]); }
    else if (e.key === 'Escape')    { setOpen(false); }
  };

  return (
    // Full-bleed chrome wrapper: breaks out of `.feed-root`'s 16 px horizontal
    // padding so the header background extends edge-to-edge regardless of
    // ancestor padding. Inner container keeps the existing centered layout.
    <div className="topnav-root" style={{
      width: '100vw',
      marginLeft: 'calc(50% - 50vw)',
      background: 'linear-gradient(180deg, rgba(20,14,34,0.7) 0%, rgba(10,8,18,0.95) 100%)',
      borderBottom: '1px solid rgba(255,255,255,0.04)',
      boxShadow: '0 1px 0 rgba(128,104,216,0.04), 0 8px 24px rgba(0,0,0,0.4)',
      backdropFilter: 'blur(12px)',
      flexShrink: 0,
      position: 'relative', zIndex: 100,
    }}>
    <div className="topnav-inner" style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0 20px', height: 44,
      maxWidth: 'var(--topnav-max, 1400px)', margin: '0 auto',
      gap: 12,
    }}>
      {/* alignItems: 'baseline' pins the logo's text baseline to the nav
          tab's text baseline — fixes the "floating" offset that `center`
          alignment produced because the serif/cursive logo has more ascender
          headroom than the sans nav tabs. */}
      <div className="topnav-left" style={{ display: 'flex', alignItems: 'center', gap: 32 }}>
        {/* Logo + tabs use next/link for client-side routing. Plain
            <a href> would do a full document navigation, tearing down
            the layout shell and showing a brief empty frame between
            documents (the "black flash" symptom). With <Link>, the
            layout shell stays mounted and only the route segment swaps. */}
        <Link href="/dashboard" className="topnav-logo" style={{
          display: 'flex', alignItems: 'center', textDecoration: 'none',
          marginLeft: 6,
        }}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/brand/victorylabs.png"
            alt="VictoryLabs"
            width={125}
            height={38}
            draggable={false}
            style={{ display: 'block' }}
          />
        </Link>
        <div className="topnav-tabs" style={{ display: 'flex', gap: 2 }}>
          {pages.map(p => (
            <Link key={p.key} href={p.href} className="topnav-tab" data-tab={p.key} style={{
              padding: '5px 16px', fontSize: 12, fontWeight: 600,
              color: active === p.key ? '#d0c8e4' : '#55556e',
              letterSpacing: '0.5px', borderRadius: 4, textDecoration: 'none',
              background: active === p.key
                ? 'linear-gradient(180deg, rgba(128,104,216,0.14) 0%, rgba(128,104,216,0.04) 100%)'
                : 'transparent',
              boxShadow: active === p.key
                ? '0 0 12px rgba(128,104,216,0.15), inset 0 0 0 1px rgba(128,104,216,0.12)'
                : 'none',
              transition: 'all 0.2s',
            }}>{p.label}</Link>
          ))}
        </div>
      </div>

      {/* Center: search collections */}
      <div ref={searchRef} className="topnav-search" style={{ position: 'relative', flex: '0 1 360px', maxWidth: 360, marginLeft: 18 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '4px 10px 4px 12px', height: 28,
          background: 'rgba(255,255,255,0.03)',
          border: open ? '1px solid rgba(168,144,232,0.5)' : '1px solid rgba(255,255,255,0.05)',
          borderRadius: 5,
          boxShadow: open ? '0 0 0 3px rgba(128,104,216,0.08)' : 'none',
          transition: 'all 0.15s',
        }}>
          <svg
            aria-hidden="true"
            width="14" height="14" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2.2"
            strokeLinecap="round" strokeLinejoin="round"
            style={{ color: '#6a6a82', flexShrink: 0 }}
          >
            <circle cx="11" cy="11" r="7" />
            <line x1="20" y1="20" x2="16.2" y2="16.2" />
          </svg>
          <input
            type="text"
            placeholder="Search collections…"
            value={q}
            onChange={e => { setQ(e.target.value); setOpen(true); setHi(0); }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            style={{
              flex: 1, background: 'transparent', border: 'none', outline: 'none',
              color: '#d4d4e8', fontSize: 12, fontFamily: 'inherit', padding: 0,
            }}
          />
          {!q && (
            <kbd style={{
              padding: '1px 6px', fontSize: 10, fontFamily: "'SF Mono','Fira Code',monospace",
              color: '#56566e', border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 3, background: 'rgba(255,255,255,0.02)', lineHeight: 1,
            }}>/</kbd>
          )}
        </div>

        {open && results.length > 0 && (
          <div style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0, right: 0,
            background: 'linear-gradient(180deg, #1a1430 0%, #14102a 100%)',
            border: '1px solid rgba(168,144,232,0.28)',
            borderRadius: 6,
            boxShadow: '0 16px 40px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.3)',
            maxHeight: 320, overflowY: 'auto', padding: 4,
          }}>
            {!q && (
              <div style={{ fontSize: 9, fontWeight: 600, color: '#56566e', letterSpacing: '0.8px', padding: '5px 8px 3px' }}>
                TRENDING
              </div>
            )}
            {results.map((col, i) => {
              const href = `/collection/${encodeURIComponent(col.slug)}`;
              return (
                <a
                  key={col.name}
                  href={href}
                  // Keep the input focused through the click so the blur handler
                  // doesn't close the dropdown mid-click. preventDefault on
                  // mousedown blocks the focus change; the click → navigation
                  // chain still fires normally.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setHi(i)}
                  // Plain left-click: close dropdown + reset query, let the
                  // anchor handle the nav. Cmd/Ctrl/Shift/middle/right-click
                  // are all handled natively by the browser because this is
                  // a real <a href>.
                  onClick={() => { setOpen(false); setQ(''); }}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 9,
                    padding: '5px 8px', borderRadius: 4, cursor: 'pointer',
                    background: hi === i ? 'rgba(128,104,216,0.12)' : 'transparent',
                    textDecoration: 'none', color: 'inherit',
                  }}>
                  <CollectionIcon imageUrl={compressImage(iconBySlug[col.slug] ?? null)} color={col.color} abbr={col.abbr} size={22} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 600, color: '#d4d4e8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{col.name}</div>
                    <div style={{ fontSize: 9, color: '#56566e', fontFamily: "'SF Mono','Fira Code',monospace" }}>{col.slug}</div>
                  </div>
                  <span style={{ fontSize: 9, color: '#56566e', fontFamily: "'SF Mono','Fira Code',monospace" }}>#{i + 1}</span>
                </a>
              );
            })}
          </div>
        )}
      </div>

      <div style={{
        display: 'flex', alignItems: 'center', gap: 18,
        fontSize: 12, color: '#4a4a62',
        fontFamily: "'SF Mono','Fira Code',monospace",
      }}>
        <span className="topnav-stat-tps"><span style={{ color: '#55556e' }}>TPS </span><span style={{ color: '#9683dc', textShadow: '0 0 8px rgba(128,104,216,0.3)' }}>{tps.toLocaleString()}</span></span>
        <span className="topnav-stat-sol"><span style={{ color: '#55556e' }}>SOL </span><span style={{ color: '#4fb67d', textShadow: '0 0 8px rgba(52,180,96,0.2)' }}>${sol}</span></span>
        <div className="topnav-stat-live" style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <LiveDot />
          <span style={{ color: '#4fb67d', fontSize: 11 }}>live</span>
        </div>
        <ModeBadge />
        {/* Layout-mode switcher is rendered as a floating bottom-right pill
            in every mode (see FloatingLayoutModeSwitcher mounted in Gate),
            so the TopNav row no longer carries it — keeps the stats row
            from clipping at narrow widths. */}
        <OffButton />
      </div>
    </div>
    </div>
  );
}

/**
 * Floating tri-state UI scale switcher (PC / Laptop / Phone). Persists in
 * localStorage via useLayoutMode and toggles a `data-layout` attribute on
 * <html>. Always rendered as a fixed bottom-right pill — same placement
 * regardless of layout mode or viewport size — and mounted once at the
 * app root (Gate) so it lives independent of TopNav and stays visible on
 * any page. Comfortable tap targets sized for phone use.
 */
export function FloatingLayoutModeSwitcher() {
  const [mode, setMode] = useLayoutMode();
  // Sliding active-indicator: a single absolute pill that animates `left` /
  // `width` between the buttons instead of each button toggling its own
  // background. Refs measure the active button on every mode change; a flag
  // suppresses the very first transition so the indicator doesn't slide in
  // from {0,0} on initial mount.
  const buttonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [pill, setPill] = useState<{ left: number; width: number; primed: boolean }>({
    left: 0, width: 0, primed: false,
  });
  useLayoutEffect(() => {
    const idx = LAYOUT_MODES.findIndex(m => m.key === mode);
    const el  = buttonRefs.current[idx];
    if (!el) return;
    setPill(prev => ({ left: el.offsetLeft, width: el.offsetWidth, primed: prev.primed || true }));
  }, [mode]);
  return (
    <div
      role="group"
      aria-label="UI layout mode"
      style={{
        position: 'fixed',
        right: 12,
        bottom: 32,
        zIndex: 9999,
        display: 'inline-flex', alignItems: 'center',
        padding: 2, gap: 2, borderRadius: 5,
        border: '1px solid rgba(168,144,232,0.45)',
        background: 'rgba(20,14,34,0.94)',
        backdropFilter: 'blur(8px)',
        boxShadow: '0 4px 14px rgba(0,0,0,0.5), 0 0 0 1px rgba(168,144,232,0.14)',
      }}
    >
      {/* Sliding indicator. zIndex: 0 so button text reads on top.
          `transition` only kicks in after the first measurement so the
          pill doesn't visibly slide from {0,0} into place on mount. */}
      <span
        aria-hidden
        style={{
          position: 'absolute',
          top: 2, bottom: 2,
          left: pill.left, width: pill.width,
          background: 'rgba(168,144,232,0.22)',
          border: '1px solid rgba(168,144,232,0.35)',
          borderRadius: 3,
          transition: pill.primed
            ? 'left 0.22s cubic-bezier(0.4, 0.0, 0.2, 1), width 0.22s cubic-bezier(0.4, 0.0, 0.2, 1)'
            : 'none',
          pointerEvents: 'none',
          zIndex: 0,
        }}
      />
      {LAYOUT_MODES.map((m, i) => {
        const active = mode === m.key;
        return (
          <button
            key={m.key}
            ref={el => { buttonRefs.current[i] = el; }}
            type="button"
            title={m.title}
            onClick={() => setMode(m.key)}
            style={{
              position: 'relative', zIndex: 1,
              padding: '3px 7px', fontSize: 9.5, fontWeight: 700,
              letterSpacing: '0.4px', borderRadius: 3,
              border: 'none',
              background: 'transparent',
              color: active ? '#d0c8e4' : '#8f8fa8',
              cursor: 'pointer', textTransform: 'uppercase',
              transition: 'color 0.18s ease',
              fontFamily: 'inherit',
              minWidth: 32,
            }}
          >{m.label}</button>
        );
      })}
    </div>
  );
}

/**
 * Live label of the current backend runtime mode. Polls once on mount —
 * it only changes in response to a deliberate user action (mode pick or
 * OFF button) and both of those reload the app, so a background interval
 * is unnecessary noise.
 */
function ModeBadge() {
  const [mode, setMode] = useState<RuntimeMode | null>(null);
  useEffect(() => {
    let cancelled = false;
    runtimeFetchMode().then(m => { if (!cancelled) setMode(m); });
    return () => { cancelled = true; };
  }, []);
  if (!mode || mode === 'off') return null;
  return (
    <span className="topnav-mode-badge" style={{ color: '#9683dc', fontSize: 10, letterSpacing: '1px', fontWeight: 600 }}>
      MODE: {mode.replace('_', ' ').toUpperCase()}
    </span>
  );
}

/**
 * OFF button — top-right of the main app chrome.
 *
 * Posts `mode=off` to the backend (stops the listener + AMM gap-healer), then
 * clears the frontend auth session and reloads the page. The reload drops
 * us back into <Gate>, which sees no auth and renders <Login>.
 */
function OffButton() {
  const [busy, setBusy] = useState(false);
  const handle = async () => {
    if (busy) return;
    setBusy(true);
    try { await runtimeSetMode('off'); } catch { /* ignore; we still wipe local state */ }
    runtimeClearAuth();
    window.location.href = '/';
  };
  return (
    <button
      onClick={handle}
      disabled={busy}
      title="Stop ingestion and sign out"
      style={{
        padding: '3px 10px', fontSize: 10, fontWeight: 700, letterSpacing: '1px',
        color: busy ? '#55556e' : '#e06a6a',
        background: 'transparent',
        border: '1px solid rgba(224,106,106,0.35)',
        borderRadius: 4,
        cursor: busy ? 'not-allowed' : 'pointer',
        fontFamily: 'inherit',
      }}>
      OFF
    </button>
  );
}
