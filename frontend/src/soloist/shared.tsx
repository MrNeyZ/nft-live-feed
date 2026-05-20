'use client';

// Shared presentational primitives used across the Soloist design.
// Port of soloist-shared.jsx — kept visually identical.

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Marketplace, rndFloat, rndInt,
} from './mock-data';
import { useCollectionIcons } from './collection-icons';
import { clearAuth as runtimeClearAuth } from '@/runtime/auth';
import { setMode as runtimeSetMode, fetchMode as runtimeFetchMode, setRuntimeChoice, type RuntimeMode } from '@/runtime/mode';
import { fetchMintTrackerEnabled, setMintTrackerEnabled } from '@/runtime/mint-tracker';
import { sendHeartbeat, HEARTBEAT_INTERVAL_MS } from '@/runtime/heartbeat';
import { useLayoutMode, LAYOUT_MODES } from './layout-mode';
import { useInclusiveFees } from './price-mode';
import { useUiSoundEnabled, setUiSoundEnabled } from './use-ui-sound';

// Route http(s) image URLs through our own `/thumb` endpoint so thumbnails
// render at a small fixed size instead of the full-size upstream asset
// (PFP originals commonly 2 000×2 000 / ~2 MB). `/thumb` is implemented
// as a Next.js Route Handler that 302-redirects to wsrv.nl with strong
// browser + edge cache headers (see src/app/thumb/route.ts).
//
// Default size: 128 px — visually crisp at 2x DPI for the live feed's
// 56 px card thumbnail and the 22–40 px collection icons, while cutting
// payload roughly in half vs the previous 200 px default. Callers that
// render at a larger display size (e.g. the 200 px avatar preview overlay)
// pass an explicit `size` hint so the proxy URL matches their target.
//
// GIFs are forced to static PNG via wsrv's `output=png` flag to prevent
// animation + scroll jank. irys.xyz hosts are bypassed (wsrv returns HTTP
// 400 "Domain or TLD blocked by policy" for them — the raw URL renders
// better than a broken proxy response). Non-http URLs (data URIs, relative
// paths) pass through untouched.
export function compressImage(
  url: string | null | undefined,
  size: number = 128,
): string | null {
  if (!url) return null;
  if (!(url.startsWith('http://') || url.startsWith('https://'))) return url;
  if (url.includes('irys.xyz')) return url;
  // Always force `output=png`. The proxy / wsrv decodes animated inputs
  // (GIF, animated WebP/AVIF) and emits only the first frame as PNG, so
  // every NFT thumbnail renders as a static image with no animation
  // regardless of the upstream format. Previously this was gated on a
  // `.gif` URL extension check, which missed CDN-hashed URLs (Tensor /
  // Magic Eden often serve animated GIFs from URLs without a visible
  // `.gif` suffix). PNG keeps transparency intact (vs JPEG) which
  // matters for NFTs rendered against the dark theme.
  return `/thumb?url=${encodeURIComponent(url)}&w=${size}&h=${size}&fit=cover&output=png`;
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

/** Host-grouped per-stage failure counter. Sampled (1st + every 50th per
 *  bucket) so a dead collection can't flood devtools but the operator can
 *  still answer "are images failing more on host X?". Output format:
 *      [feed/image] proxy_fail   host=bafy…ipfs.dweb.link count=1
 *      [feed/image] raw_fallback host=bafy…ipfs.dweb.link count=1
 *  Every counter resets on hot-reload, which is fine — diagnostics live
 *  for the session, not durably. */
const _imgFailCount: Map<string, number> = (() => {
  const g = globalThis as unknown as { __vlImgFail?: Map<string, number> };
  if (!g.__vlImgFail) g.__vlImgFail = new Map();
  return g.__vlImgFail;
})();
function noteImageFail(stage: 'proxy_fail' | 'raw_fallback' | 'primary_exhausted', src: string): void {
  if (typeof window === 'undefined') return;
  let host = '';
  try {
    if (src.startsWith('/thumb')) {
      const parsed = new URL(src, 'http://x');
      const raw = parsed.searchParams.get('url') ?? '';
      host = raw ? new URL(raw).host : '/thumb';
    } else {
      host = new URL(src).host;
    }
  } catch { host = '?'; }
  const key = `${stage}|${host}`;
  const n   = (_imgFailCount.get(key) ?? 0) + 1;
  _imgFailCount.set(key, n);
  if (n === 1 || n % 50 === 0) {
    // eslint-disable-next-line no-console
    console.log(`[feed/image] ${stage} host=${host} count=${n}`);
  }
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
  imageUrl, fallbackImageUrl, color, abbr, size,
}: {
  imageUrl: string | null | undefined;
  /** Optional 2nd-tier URL tried after the primary chain (proxy + raw)
   *  exhausts. Each URL gets its own proxy→raw retry pair; initials
   *  only fire when ALL candidates fail. Wired by the /mints tracker
   *  table so a row with a broken collection hero can still show a
   *  working per-NFT image instead of degrading to initials. */
  fallbackImageUrl?: string | null | undefined;
  color: string;
  abbr: string;
  size: number;
}) {
  // Stage machine — primary URL gets proxy + raw fallbacks; if both
  // fail and a `fallbackImageUrl` was supplied, swap to it and run
  // the same proxy+raw pair on it; only after BOTH candidates exhaust
  // do we render the initials placeholder.
  const [useFallback, setUseFallback] = useState(false);
  const [fellBack,    setFellBack]    = useState(false);
  const [errored,     setErrored]     = useState(false);
  // Reset all stage flags whenever either URL changes. Without this,
  // a card whose first image attempt failed is pinned to the
  // placeholder forever even if a fresh mint_meta patch later
  // supplies a working URL. memo-wrapped → re-renders without remount.
  useEffect(() => {
    setUseFallback(false);
    setFellBack(false);
    setErrored(false);
  }, [imageUrl, fallbackImageUrl]);
  const activeUrl = useFallback ? fallbackImageUrl : imageUrl;
  if (!activeUrl || errored) return <NFTThumb color={color} abbr={abbr} size={size} />;
  const src = fellBack ? rawUpstreamImage(activeUrl) : activeUrl;
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      // Thumbnails are decorative under dense lists — never compete with
      // primary content (text, layout, network requests for next page of
      // events). Browser's image priority hint stays at 'low' across the
      // feed; the lazy attribute already gates above-the-fold off-screen
      // loads.
      fetchPriority="low"
      onError={() => {
        if (!fellBack) {
          // First failure — proxy refused / upstream timeout. Try raw
          // upstream of the active URL (browser may follow redirect
          // chains wsrv refused, e.g. cross-host IPFS gateway hops).
          noteImageFail('proxy_fail', src);
          setFellBack(true);
        } else if (!useFallback && fallbackImageUrl) {
          // Primary URL fully exhausted (proxy + raw both failed) and
          // a fallback URL was supplied. Swap to it and reset the
          // proxy/raw subchain so it gets its own two-step retry.
          noteImageFail('primary_exhausted', src);
          setUseFallback(true);
          setFellBack(false);
        } else {
          // No fallback URL left (either was never supplied or has
          // also exhausted). Render initials.
          noteImageFail('raw_fallback', src);
          setErrored(true);
        }
      }}
      style={{ width: size, height: size, borderRadius: 4, objectFit: 'cover', display: 'block', background: '#0e0b22' }}
    />
  );
});

export function NFTThumb({ color, abbr, size = 36 }: { color: string; abbr: string; size?: number }) {
  return (
    <div style={{
      width: size, height: size, borderRadius: 6, flexShrink: 0,
      background: `linear-gradient(135deg, ${color}4d 0%, ${color}1f 100%)`,
      border: `1px solid ${color}33`,
      boxShadow: `inset 0 1px 0 ${color}1f, 0 1px 2px rgba(0,0,0,0.3)`,
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
  // Reset both error flags on imageUrl change — same rationale as in
  // ItemThumb. Collection avatars get a fresh URL whenever the row's
  // sticky-merged collection meta upgrades (LMNFT scrape → DAS), so
  // pinning placeholder after one early failure is especially visible
  // here.
  useEffect(() => {
    setErrored(false);
    setFellBack(false);
  }, [imageUrl]);
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
      // Same rationale as ItemThumb: collection avatars are decorative
      // and should not compete with above-the-fold layout requests.
      fetchPriority="low"
      onError={() => {
        if (!fellBack) {
          // First failure — wsrv proxy returned an error or the upstream
          // host hung past the browser's load timeout. Sampled & grouped
          // by host (see noteImageFail). Then fall back to the raw
          // upstream URL — the browser can sometimes follow redirect
          // chains wsrv refuses (e.g. cross-host IPFS gateway hops).
          noteImageFail('proxy_fail', src);
          setFellBack(true);
        } else {
          // Second failure — raw upstream is also dead (most often
          // genuine upstream content loss, e.g. a CID that fell out of
          // the IPFS DHT). Render the initials placeholder.
          noteImageFail('raw_fallback', src);
          setErrored(true);
        }
      }}
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
  // Slightly slimmer / lighter than before — 1px less horizontal padding and
  // a hair weaker borders (idle rim + active tint) so filter/tab/timeframe
  // pills (Filters, Pause, …) read a touch more "terminal", less "dashboard
  // app". Size band, typography, radius, and active logic are unchanged.
  const pad      = size === 'sm' ? '2px 7px' : '3px 9px';
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
        border:     active ? `1px solid ${color}55` : '1px solid rgba(255,255,255,0.07)',
        background: active ? `${color}1c`           : 'rgba(255,255,255,0.03)',
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

/* ─── Canonical VictoryLabs settings system ──────────────────────────────────
 * One visual language for every settings/filter panel (Live Feed, Mint Tracker,
 * Dashboard, Rare Feed, future tools). The layout primitives live as shared CSS
 * classes in globals.css (.feed-filters-panel, .feed-set-group, .feed-set-group-hd,
 * .feed-srow, .feed-srow-lbl, .feed-srow-ctl, .feed-seg, .vl-switch); the control
 * styling lives here so all panels render identical pills + Settings buttons.
 * Compact terminal density — ~22px pills, quiet tint, no neon glow. */

/** Inactive settings pill (~22px) — subtle, low-weight, terminal feel. */
export const SETTINGS_PILL_INACTIVE: React.CSSProperties = {
  padding: '2px 8px', fontSize: 10, fontWeight: 600, letterSpacing: '0.3px',
  background: 'rgba(255, 255, 255, 0.025)',
  border: '1px solid rgba(255, 255, 255, 0.05)',
  color: '#8a8aa6',
  boxShadow: 'none',
};

/** Active settings pill — purple-tinted (or accent-colored), brighter text,
 *  NO glow. `color` defaults to the brand purple so callers can omit it. */
export const settingsPillActive = (color = '#a890e8'): React.CSSProperties => ({
  padding: '2px 8px', fontSize: 10, fontWeight: 700, letterSpacing: '0.3px',
  background: `${color}24`,
  border: `1px solid ${color}44`,
  color: '#f0eef8',
  boxShadow: 'none',
});

/** Canonical Settings/⚙ toggle — one shared gear badge used by every panel so
 *  the control has identical dimensions everywhere. Optional `count` renders a
 *  "· N" active-filter badge (e.g. "Settings · 4"). Owns no logic. */
export function SettingsToggle({
  active, onClick, label = 'Settings', title = 'Settings', count, style,
}: {
  active: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  label?: string;
  title?: string;
  count?: number;
  style?: React.CSSProperties;
}) {
  const text = count && count > 0 ? `${label} · ${count}` : label;
  return (
    <Pill
      active={active}
      onClick={onClick}
      title={title}
      icon={<span style={{ fontSize: 11, lineHeight: 1 }}>⚙</span>}
      label={text}
      style={style}
    />
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

type Page = 'dashboard' | 'collection' | 'feed' | 'multi' | 'mints' | 'tools';

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

/** Module-level cache for the sliding tab indicator's geometry.
 *  Survives TopNav remounts (which happen on every route change in
 *  Next App Router because pages aren't wrapped in a shared layout
 *  here). When a fresh TopNav mounts after a navigation, it seeds
 *  its initial state from this cache → the indicator paints at the
 *  PREVIOUS active tab's position for one frame → the resize/effect
 *  callback then sets the new position → CSS transition smoothly
 *  slides between them. Net effect: visual continuity equivalent to
 *  a truly persistent TopNav, without the structural refactor.
 *  null until the first computation. */
let _topnavLastIndicator: { left: number; width: number } | null = null;

// Hover-dropdown item styles, hoisted to module scope so the same
// object reference is shared across renders (also keeps the JSX
// inside the TOPNAV map readable).
// Font size / weight / letter-spacing match the TopNav tab labels
// (BOARD, FEED, TOOLS, …) at line ~743: `fontSize: 12, fontWeight: 600,
// letterSpacing: '0.5px'`. Kept in sync so the dropdown text reads as
// part of the same nav surface.
const DROPDOWN_ITEM_STYLE: React.CSSProperties = {
  display:        'block',
  padding:        '5px 6px',
  textAlign:      'center',
  fontSize:       12,
  fontWeight:     600,
  letterSpacing:  '0.5px',
  textTransform:  'uppercase',
  lineHeight:     1.2,
  color:          '#aaaabf',
  textDecoration: 'none',
  borderRadius:   3,
  transition:     'background 0.12s, color 0.12s',
  cursor:         'pointer',
};

export function TopNav({ active }: { active?: Page } = {}) {
  // TPS / SOL price / live indicator moved to the bottom status bar
  // (`<BottomStatusBar />`). The fetch lives there now — TopNav stays
  // clean for nav tabs + search + mode + OFF only.

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
    { key: 'dashboard',  label: 'BOARD',      href: '/dashboard' },
    { key: 'multi',      label: 'MULTI',      href: '/multi'     },
    { key: 'mints',      label: 'MINTS',      href: '/mints'     },
    { key: 'tools',      label: 'TOOLS',      href: '/tools'     },
    { key: 'feed',       label: 'FEED',       href: '/feed'      },
  ];

  // ── Active tab + sliding indicator ─────────────────────────────────
  // Active key is derived from `usePathname()` so navigations between
  // routes update the indicator without callers having to keep the
  // `active` prop in sync. The optional prop is kept as a fallback for
  // backward compatibility with existing call sites that still pass it
  // (e.g. before they're migrated to the persistent layout).
  const pathname = usePathname() ?? '';
  // Router used for explicit prefetch on hover (App Router prefetches
  // <Link> in the viewport by default, but tabs pulled from a freshly
  // mounted nav can still take a beat on the first hover — calling
  // router.prefetch on pointer-enter primes the chunk before click).
  const router = useRouter();
  // One-time pre-warm on TopNav mount: prefetch every internal nav
  // route so the very first switch after the app boots feels instant.
  // Cheap — Next.js dedupes prefetches per path so the hover-prefetch
  // path below is a no-op on already-warmed routes.
  useEffect(() => {
    const HREFS = ['/dashboard', '/multi', '/mints', '/tools', '/feed'];
    for (const h of HREFS) router.prefetch(h);
  }, [router]);
  // Pathname-change perf log. Pairs with the click-time stamp set in
  // each Link's onClick to print a one-liner like
  //   [nav-perf] mounted /feed after 142ms
  // so the operator can see whether a slow switch is JS-load-bound,
  // data-fetch-bound, or already fast. Only fires on actual route
  // changes (skips the initial mount).
  const prevPathnameRef = useRef<string | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (prevPathnameRef.current !== null && prevPathnameRef.current !== pathname) {
      const w = window as unknown as { __navPerfClick?: number };
      const clickedAt = typeof w.__navPerfClick === 'number' ? w.__navPerfClick : null;
      const dt = clickedAt != null ? Math.round(performance.now() - clickedAt) : null;
      console.log(`[nav-perf] mounted ${pathname}${dt != null ? ` after ${dt}ms` : ''}`);
    }
    prevPathnameRef.current = pathname;
  }, [pathname]);
  const activeKey: Page = (() => {
    if (pathname.startsWith('/dashboard')) return 'dashboard';
    if (pathname.startsWith('/multi'))     return 'multi';
    if (pathname.startsWith('/mints'))     return 'mints';
    if (pathname.startsWith('/tools'))     return 'tools';
    if (pathname.startsWith('/feed'))      return 'feed';
    return active ?? 'dashboard';
  })();

  // Refs to the rendered <a> for each tab — used to measure offsetLeft
  // / offsetWidth of the active tab so the indicator can position
  // itself behind it. The Map shape lets us look up by Page key
  // directly, regardless of render order.
  // Hover-dropdown state for the TOOLS tab. The Burner / Offers menu
  // appears under TOOLS when the operator hovers either the tab or
  // the dropdown itself; closes when the pointer leaves both.
  const [toolsOpen, setToolsOpen] = useState(false);
  // Phone-only "OTHER" action-sheet menu — surfaces the nav items
  // hidden by the topnav-tab phone trim (Mints, Offers, Burner).
  const [otherOpen, setOtherOpen] = useState(false);
  // Single hover key for the entire nav row — set on mouse enter of any
  // tab, cleared on leave. Drives a subtle highlight on the hovered tab
  // (suppressed when that tab is also active so it doesn't double up
  // with the sliding indicator). Single state instead of one boolean
  // per tab keeps the render cheap and the close-out trivial.
  const [hoverKey, setHoverKey] = useState<Page | null>(null);

  // Stored as HTMLElement (not HTMLAnchorElement) because the TOOLS tab
  // is wrapped in a `position: relative` <div> for its dropdown — the
  // link's offsetLeft would then be 0 (relative to the wrapper) and
  // break the sliding indicator. We register the wrapper for tools and
  // the <a> for everything else; both expose offsetLeft/offsetWidth in
  // the topnav-tabs frame, which is what the indicator needs.
  const tabRefs = useRef(new Map<Page, HTMLElement>());
  const setTabRef = (key: Page) => (el: HTMLElement | null) => {
    if (el) tabRefs.current.set(key, el);
    else    tabRefs.current.delete(key);
  };

  // Lazy initial state from the module-level cache. On the very first
  // visit, the cache is null — we fall through to computing it on
  // mount in the useEffect below (indicator opacity stays 0 until
  // computed, fading in to avoid a 0,0-positioned flash).
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(
    () => _topnavLastIndicator,
  );

  // Recompute on activeKey change. useEffect (not useLayoutEffect) so
  // the browser commits one paint frame at the previous indicator
  // position (from the module cache) BEFORE the state update — that
  // intermediate paint is what kicks the CSS transition into life.
  // Without it, React would batch the two state values into a single
  // commit and the browser would paint only the final position,
  // skipping the slide animation.
  useEffect(() => {
    const el = tabRefs.current.get(activeKey);
    if (!el) return;
    const next = { left: el.offsetLeft, width: el.offsetWidth };
    setIndicator(next);
    _topnavLastIndicator = next;
  }, [activeKey]);

  // Resize listener — re-measures when the viewport (and thus the tab
  // widths via font hinting / responsive padding) changes. Cheap; runs
  // at most once per resize debounce frame.
  useEffect(() => {
    const onResize = () => {
      const el = tabRefs.current.get(activeKey);
      if (!el) return;
      const next = { left: el.offsetLeft, width: el.offsetWidth };
      setIndicator(next);
      _topnavLastIndicator = next;
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [activeKey]);

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
      // Layered chrome so the header reads as a real platform shell:
      //   • dark glass base — vertical gradient + backdrop blur
      //   • soft purple haze pooled toward the top-centre (radial layer on top)
      //   • faintly purple 1px bottom separator
      //   • low downward glow (purple-tinted) + the original black drop shadow
      //   • inset 1px top highlight = the "glass edge" sheen
      background:
        'radial-gradient(120% 180% at 50% -45%, rgba(132,108,224,0.08) 0%, rgba(132,108,224,0.035) 40%, transparent 66%), ' +
        'linear-gradient(180deg, rgba(22,16,38,0.82) 0%, rgba(11,9,20,0.96) 100%)',
      borderBottom: '1px solid rgba(168,144,232,0.10)',
      boxShadow:
        'inset 0 1px 0 rgba(255,255,255,0.04), ' +
        '0 1px 0 rgba(168,144,232,0.06), ' +
        '0 16px 38px -12px rgba(58,40,104,0.42), ' +
        '0 8px 24px rgba(0,0,0,0.42)',
      backdropFilter: 'blur(14px)',
      WebkitBackdropFilter: 'blur(14px)',
      flexShrink: 0,
      position: 'relative', zIndex: 100,
    }}>
    <div className="topnav-inner" style={{
      // Phase 2: TopNav is shell chrome — viewport-anchored, no
      // max-width column constraint (matches the BottomStatusBar
      // pattern). Side padding + height drive off the shared shell
      // tokens (`--shell-x`, `--shell-height`) so PC/laptop/phone
      // tiers stay coherent across the top + bottom bars.
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '0 var(--shell-x, 24px)', height: 'var(--shell-height, 48px)',
      width: '100%',
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
        <Link href="/dashboard" className="topnav-logo" aria-label="VictoryLabs — home" style={{
          display: 'flex', alignItems: 'center', textDecoration: 'none',
          // Typography-only wordmark — no image, no box, fully transparent
          // (see `.vl-logo` in globals.css). Ported from the WC v2 handoff
          // prototype + the requested overrides (Victory 24px / scaleX 0.95
          // / transform-origin). The lockup itself is aria-hidden; this link
          // carries the accessible name.
          marginLeft: 6,
        }}>
          <div className="vl-logo" aria-hidden="true">
            <span className="v">Victory</span><span className="l">Labs</span>
          </div>
        </Link>
        <div className="topnav-tabs" style={{ display: 'flex', gap: 2, position: 'relative' }}>
          {/* Sliding pill — replaces the per-tab background/box-shadow.
              `position: absolute` over the tab row, sized to the active
              tab via the indicator state computed in the effects above.
              CSS transitions on `left` and `width` produce the slide
              animation; opacity fades from 0 on the very first paint
              before geometry is known. zIndex 0 keeps it visually
              behind the labels (which sit at zIndex 1). */}
          <span
            className="topnav-active-indicator"
            aria-hidden
            style={{
              position: 'absolute',
              top: 0, bottom: 0,
              left:  indicator?.left  ?? 0,
              width: indicator?.width ?? 0,
              opacity: indicator ? 1 : 0,
              // Soft capsule: a purple wash, a 1px inset border, a top sheen,
              // and a tight lift-shadow + a faint glow so the active tab
              // outranks the others — dialled down again here (lighter border,
              // weaker lift/glow) so it reads closer to the layout-switcher
              // capsule's language: a "selected terminal tab", not a clickable
              // neon button. Wash / radius / size / animations unchanged.
              borderRadius: 6,
              // Subtle filled active state — neutral white wash, no outline, no
              // glow (purple identity now lives in the chrome haze + runtime
              // module, not on every nav tab). The slide animation is kept.
              background: 'rgba(255,255,255,0.05)',
              boxShadow: 'none',
              transition:
                'left 180ms cubic-bezier(0.22, 1, 0.36, 1), ' +
                'width 180ms cubic-bezier(0.22, 1, 0.36, 1), ' +
                'opacity 180ms ease-out',
              pointerEvents: 'none',
              zIndex: 0,
            }}
          />
          {pages.map(p => {
            const isTools = p.key === 'tools';
            const isActive = activeKey === p.key;
            // Subtle hover highlight on every tab. Suppressed when the
            // tab is also active so it doesn't double up with the
            // sliding indicator behind the label (active stays the
            // strongest visual state).
            const isHover = hoverKey === p.key && !isActive;
            // Shared visual style for both the <Link> nav tabs and the
            // TOOLS <button> trigger so both render pixel-identically.
            const tabStyle: React.CSSProperties = {
              position: 'relative', zIndex: 1,
              padding: '4px 16px', fontSize: 12, fontWeight: 600,
              // Inactive a notch more muted; active text noticeably brighter
              // (the sliding capsule behind it carries the rest of the weight).
              color: isActive ? '#e7e0f6' : (isHover ? '#b4b4c8' : '#4f4f66'),
              letterSpacing: '0.5px', borderRadius: 6, textDecoration: 'none',
              // Background + box-shadow removed — handled by the
              // sliding indicator behind the labels (except for the
              // hover-highlight, which paints its own subtle tint when
              // the tab isn't already active).
              background: isHover ? 'rgba(255,255,255,0.025)' : 'transparent',
              transition: 'color 160ms ease-out, background 160ms ease-out',
            };
            // Non-tools tabs render the regular Link. TOOLS itself does
            // NOT navigate — it's purely a dropdown trigger; navigation
            // happens via the Burner / Offers items inside the menu.
            if (!isTools) {
              return (
                <Link
                  key={p.key}
                  ref={setTabRef(p.key)}
                  href={p.href}
                  prefetch
                  className="topnav-tab"
                  data-tab={p.key}
                  onMouseEnter={() => { setHoverKey(p.key); router.prefetch(p.href); }}
                  onMouseLeave={() => setHoverKey(prev => prev === p.key ? null : prev)}
                  onClick={() => {
                    if (typeof window !== 'undefined') {
                      (window as unknown as { __navPerfClick?: number }).__navPerfClick = performance.now();
                      console.log(`[nav-perf] click ${p.href}`);
                    }
                  }}
                  style={tabStyle}
                >{p.label}</Link>
              );
            }
            // TOOLS trigger: a non-navigating <button> styled to match
            // a nav tab. Active styling still derives from `pathname`,
            // which the dropdown's Offers item updates by linking to
            // /tools — so opening Offers still highlights TOOLS.
            return (
              <div
                key={p.key}
                ref={setTabRef(p.key)}
                style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}
                onPointerEnter={() => setToolsOpen(true)}
                onPointerLeave={() => setToolsOpen(false)}
              >
                <button
                  type="button"
                  className="topnav-tab"
                  data-tab={p.key}
                  aria-haspopup="menu"
                  aria-expanded={toolsOpen}
                  onMouseEnter={() => setHoverKey(p.key)}
                  onMouseLeave={() => setHoverKey(prev => prev === p.key ? null : prev)}
                  // No onClick — TOOLS is a dropdown trigger only.
                  // Hover (handled by the wrapper) opens the menu;
                  // navigation happens via Burner / Offers items.
                  style={{
                    ...tabStyle,
                    border: 'none', outline: 'none',
                    font: 'inherit', cursor: 'pointer',
                  }}
                >{p.label}</button>
                {toolsOpen && (
                  <div
                    role="menu"
                    aria-label="Tools menu"
                    style={{
                      position: 'absolute', top: '100%', left: 0,
                      marginTop: 0,
                      width: '100%',
                      padding: 3,
                      background: 'linear-gradient(180deg, rgba(20,14,34,0.98) 0%, rgba(14,11,28,0.98) 100%)',
                      border: '1px solid rgba(168,144,232,0.28)',
                      borderRadius: 6,
                      boxShadow: '0 8px 24px rgba(0,0,0,0.55), 0 0 0 1px rgba(0,0,0,0.4), 0 0 14px rgba(128,104,216,0.18)',
                      backdropFilter: 'blur(8px)',
                      zIndex: 1000,
                      display: 'flex', flexDirection: 'column', gap: 1,
                    }}
                  >
                    <a
                      role="menuitem"
                      href="https://wallet.victorylabs.app/burner"
                      target="_blank"
                      rel="noopener noreferrer"
                      style={DROPDOWN_ITEM_STYLE}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = 'rgba(168,144,232,0.10)'; (e.currentTarget as HTMLAnchorElement).style.color = '#d0c8e4'; }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = 'transparent';                  (e.currentTarget as HTMLAnchorElement).style.color = '#aaaabf'; }}
                    >
                      Burner
                    </a>
                    <Link
                      role="menuitem"
                      href="/tools"
                      prefetch
                      style={DROPDOWN_ITEM_STYLE}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = 'rgba(168,144,232,0.10)'; (e.currentTarget as HTMLAnchorElement).style.color = '#d0c8e4'; router.prefetch('/tools'); }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = 'transparent';                  (e.currentTarget as HTMLAnchorElement).style.color = '#aaaabf'; }}
                      onClick={() => {
                        if (typeof window !== 'undefined') {
                          (window as unknown as { __navPerfClick?: number }).__navPerfClick = performance.now();
                          console.log('[nav-perf] click /tools');
                        }
                        setToolsOpen(false);
                      }}
                    >
                      Offers
                    </Link>
                  </div>
                )}
              </div>
            );
          })}
          {/* Phone-only "OTHER" trigger. Hidden on desktop / laptop via
              the `.topnav-tab-other-mobile` rule in globals.css. Tap
              opens a centered action-sheet modal with Mints / Offers /
              Burner — the nav items the phone trim hides. */}
          <button
            type="button"
            className="topnav-tab topnav-tab-other-mobile"
            data-tab="other"
            onClick={() => setOtherOpen(true)}
            aria-haspopup="dialog"
            aria-expanded={otherOpen}
            style={{
              position: 'relative', zIndex: 1,
              padding: '4px 16px', fontSize: 12, fontWeight: 600,
              color: '#4f4f66',
              letterSpacing: '0.5px', borderRadius: 6, textDecoration: 'none',
              background: 'transparent',
              border: 'none', outline: 'none', font: 'inherit', cursor: 'pointer',
            }}
          >OTHER</button>
        </div>
      </div>

      {otherOpen && <OtherMenuModal onClose={() => setOtherOpen(false)} />}

      {/* Center: search collections */}
      <div ref={searchRef} className="topnav-search" style={{ position: 'relative', flex: '0 1 var(--shell-search-max, 480px)', maxWidth: 'var(--shell-search-max, 480px)', marginLeft: 18 }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '0 12px', height: 28,
          // Glass/inset field: a recessed look (inner top shadow) at rest;
          // on focus it brightens, the border goes purple, and a soft outer
          // glow ring fades in. Functionality/handlers below are unchanged.
          background: open ? 'rgba(255,255,255,0.045)' : 'rgba(255,255,255,0.025)',
          border: open ? '1px solid rgba(168,144,232,0.55)' : '1px solid rgba(255,255,255,0.06)',
          borderRadius: 8,
          boxShadow: open
            ? 'inset 0 1px 2px rgba(0,0,0,0.28), 0 0 0 3px rgba(132,108,224,0.12)'
            : 'inset 0 1px 2px rgba(0,0,0,0.28), inset 0 -1px 0 rgba(255,255,255,0.02)',
          transition: 'border-color 0.16s ease, box-shadow 0.16s ease, background-color 0.16s ease',
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
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              minWidth: 14, height: 15, padding: '0 4px',
              fontSize: 9.5, fontFamily: "'SF Mono','Fira Code',monospace",
              color: '#4f4f63', border: 'none',
              borderRadius: 3, background: 'rgba(255,255,255,0.04)', lineHeight: 1,
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

      {/* Unified runtime module: [● Sales · Mints ▾] [⏻]. Layout-mode switcher
          is a floating bottom-right pill (FloatingLayoutModeSwitcher in Gate). */}
      <div className="topnav-right" style={{
        display: 'flex', alignItems: 'center', gap: 16, marginRight: 2,
      }}>
        <RuntimeControls />
      </div>
    </div>
    </div>
  );
}

/**
 * Shared bottom status bar.
 *
 * Single source of TPS / SOL price / live-indicator + Discord/Twitter/
 * alerts/EVENTS counts. Mounted at the bottom of every main page so the
 * chrome reads as a balanced top + bottom rail. Pages pass `eventsCount`
 * when they have one (e.g. Live Feed); otherwise the EVENTS slot is
 * omitted. Full-bleed wrapper breaks out of `.feed-root`'s 16 px
 * horizontal padding so the gradient extends edge-to-edge regardless
 * of ancestor padding.
 */
/** Cross-route channel for /feed → BottomStatusBar.
 *  Now that the bar lives in the persistent shell (Gate), it can't
 *  receive `eventsCount` as a prop anymore. Instead /feed dispatches
 *  this window event whenever its event count changes; the bar
 *  listens and renders. The last value persists when /feed unmounts
 *  (operator navigates away), which is the desired UX.
 *  Exported as a constant so producer + consumer can't drift. */
export const EVENTS_COUNT_EVENT = 'vl:eventsCount';

/** Minimal bottom-bar icon control — transparent, no border, subtle hover
 *  tint only, ~16px icon. Active state shown via color (purple on / muted
 *  off) rather than a pill/border, keeping the terminal-utility feel. */
function BarIconButton({ on, onClick, title, children }: {
  on: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 24, height: 22, padding: 0, borderRadius: 5,
        background: 'transparent', border: 'none', cursor: 'pointer',
        color: on ? '#a890e8' : '#5c5c74',
        transition: 'background 0.12s, color 0.12s',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'rgba(255,255,255,0.05)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; }}
    >
      {children}
    </button>
  );
}

export function BottomStatusBar({ eventsCount: propEventsCount }: { eventsCount?: number } = {}) {
  const [sol, setSol] = useState<string>(() => rndFloat(38, 42).toFixed(2));
  const [tps, setTps] = useState<number>(() => rndInt(2100, 2800));
  const [inclusiveFees, setInclusiveFees] = useInclusiveFees();
  const uiSoundEnabled = useUiSoundEnabled();
  // Listen for cross-route EVENTS-count signals from /feed. Falls back
  // to the optional `eventsCount` prop for backward compat with any
  // call site that still passes it directly.
  const [busEventsCount, setBusEventsCount] = useState<number | null>(null);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (e: Event) => {
      const ce = e as CustomEvent<number>;
      if (typeof ce.detail === 'number') setBusEventsCount(ce.detail);
    };
    window.addEventListener(EVENTS_COUNT_EVENT, handler as EventListener);
    return () => window.removeEventListener(EVENTS_COUNT_EVENT, handler as EventListener);
  }, []);
  const eventsCount = propEventsCount ?? busEventsCount ?? undefined;
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
  // "Platform module" surface — a barely-there panel that lets a related
  // cluster of footer items read as one unit (Magic Eden-style chrome)
  // instead of disconnected text. Reads as cut *into* the bar: a fill a touch
  // darker than the footer base, a hairline rim, a soft inner shadow at the
  // top edge, and a faint sheen along the bottom — a little more physical
  // depth than before, still subtle. Tiny radius keeps the terminal feel;
  // per-use callers add their own internal `gap`. Stays quieter / more
  // recessed than the topbar's surfaces.
  const groupModule: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center',
    padding: '1px 9px', borderRadius: 5,
    background: 'rgba(0,0,0,0.20)',
    border: '1px solid rgba(255,255,255,0.05)',
    boxShadow:
      'inset 0 1px 2px rgba(0,0,0,0.26), ' +
      'inset 0 -1px 0 rgba(255,255,255,0.022)',
  };
  return (
    <div className="bottom-status" style={{
      width: '100vw',
      marginLeft: 'calc(50% - 50vw)',
      // Mirror of the topbar's layered chrome, flipped to anchor at the
      // bottom: a deeper dark-glass base (vertical gradient + backdrop blur),
      // a faint purple haze pooled toward the bottom edge, a slightly
      // stronger top separator, a crisp top-edge highlight + a soft inner
      // shadow descending from it (so page content reads as sitting *in
      // front of* the footer), and an upward purple-tinted depth shadow +
      // the original black one. Kept a touch more restrained than the topbar
      // so the header stays the dominant chrome.
      background:
        'radial-gradient(120% 180% at 50% 140%, rgba(132,108,224,0.07) 0%, rgba(132,108,224,0.03) 42%, transparent 66%), ' +
        'linear-gradient(180deg, rgba(11,9,20,0.96) 0%, rgba(22,16,38,0.82) 100%)',
      borderTop: '1px solid rgba(168,144,232,0.10)',
      boxShadow:
        'inset 0 1px 0 rgba(255,255,255,0.05), ' +
        'inset 0 6px 14px -10px rgba(0,0,0,0.28), ' +
        '0 -1px 0 rgba(168,144,232,0.06), ' +
        '0 -16px 38px -12px rgba(58,40,104,0.38), ' +
        '0 -8px 24px rgba(0,0,0,0.40)',
      backdropFilter: 'blur(14px)',
      WebkitBackdropFilter: 'blur(14px)',
      flexShrink: 0,
    }}>
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        // Phase 2: bar is shell chrome — shares the `--shell-x` token
        // with the TopNav so both bars maintain the same edge-gap
        // across PC (40), laptop (24), and phone (12) tiers. No max-
        // width column constraint; full viewport width. Vertical 7 px
        // padding preserves the pre-existing bar height; chip sizes
        // are unchanged.
        padding: '7px var(--shell-x, 24px)',
        width: '100%',
        fontSize: 11, fontFamily: "'SF Mono','Fira Code',monospace",
      }}>
        {/* LEFT — live metrics only. Market + live readouts grouped into quiet
            stat modules; values a notch clearer than their labels. */}
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <div style={{ ...groupModule, gap: 12 }}>
            <span><span style={{ color: '#5c5c74' }}>SOL </span><span style={{ color: '#62cb93' }}>${sol}</span></span>
            <span><span style={{ color: '#5c5c74' }}>TPS </span><span style={{ color: '#ab9be6' }}>{tps.toLocaleString()}</span></span>
          </div>
          <div style={{ ...groupModule, gap: 10 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
              <LiveDot />
              <span style={{ color: '#62cb93' }}>live</span>
              {typeof eventsCount === 'number' && (
                <span style={{ color: '#5c5c74' }}> · <span style={{ color: '#7e7e98' }}>{eventsCount}</span> events</span>
              )}
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <span style={{ color: '#36b868', fontWeight: 700 }}>0</span>
              <span style={{ color: '#5c5c74' }}>alerts</span>
            </span>
          </div>
        </div>
        {/* RIGHT — controls + socials. Minimal borderless icon controls
            (sound / fees), then the social links. */}
        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
          <div style={{ display: 'flex', gap: 2, alignItems: 'center' }}>
            {/* UI Sound toggle — synthesised hover/click ticks (logic unchanged). */}
            <BarIconButton
              on={uiSoundEnabled}
              onClick={() => setUiSoundEnabled(!uiSoundEnabled)}
              title={uiSoundEnabled ? 'UI sound ON — subtle hover/click ticks' : 'UI sound OFF — click to enable subtle hover/click ticks'}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M11 5 6 9H2v6h4l5 4z" />
                {uiSoundEnabled
                  ? <path d="M15.5 8.5a5 5 0 0 1 0 7" />
                  : <line x1="22" y1="9" x2="16" y2="15" />}
              </svg>
            </BarIconButton>
            {/* Inclusive-fees toggle — affects only AMM_SELL display (logic unchanged). */}
            <BarIconButton
              on={inclusiveFees}
              onClick={() => setInclusiveFees(!inclusiveFees)}
              title={inclusiveFees ? 'Inclusive fees ON — AMM_SELL shows full pool / buyer-paid price' : 'Inclusive fees OFF — AMM_SELL shows seller net (proceeds after pool fees)'}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="19" y1="5" x2="5" y2="19" />
                <circle cx="6.5" cy="6.5" r="2.5" />
                <circle cx="17.5" cy="17.5" r="2.5" />
              </svg>
            </BarIconButton>
          </div>
          <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
            <a href="https://discord.com/" target="_blank" rel="noopener noreferrer" style={{ color: '#5c5c74', fontFamily: 'inherit', textDecoration: 'none' }}>Discord</a>
            <a href="https://x.com/VictoryHell_" target="_blank" rel="noopener noreferrer" style={{ color: '#5c5c74', fontFamily: 'inherit', textDecoration: 'none' }}>Twitter</a>
          </div>
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
        bottom: 39,
        zIndex: 9999,
        display: 'inline-flex', alignItems: 'center',
        padding: 2, gap: 2, borderRadius: 5,
        // Calmer / more recessed than before — a much fainter purple rim, a
        // darker base closer to the footer chrome, an inner top shadow + a
        // faint bottom sheen so it reads as a milled-in control rather than a
        // bright floating widget, and a lighter outer drop shadow (the purple
        // glow ring is gone).
        border: '1px solid rgba(168,144,232,0.18)',
        background: 'rgba(14,11,24,0.95)',
        backdropFilter: 'blur(8px)',
        boxShadow:
          'inset 0 1px 2px rgba(0,0,0,0.28), ' +
          'inset 0 -1px 0 rgba(255,255,255,0.022), ' +
          '0 3px 10px -2px rgba(0,0,0,0.42)',
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
          // Softened: a quieter purple wash + rim, plus a faint top sheen so
          // the active capsule reads as a slightly raised key inside the
          // recessed track. The brighter active label keeps the state obvious.
          background: 'rgba(168,144,232,0.16)',
          border: '1px solid rgba(168,144,232,0.26)',
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04)',
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
              // 3px → 2px vertical: a very subtle vertical tighten (slimmer
              // capsule too, since it tracks the button height). Horizontal
              // padding, min-width, and font size are untouched.
              padding: '2px 7px', fontSize: 9.5, fontWeight: 700,
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
/** Phone-only action-sheet menu. Centered card with backdrop blur,
 *  scale + fade animation, three nav items (Mints, Offers, Burner).
 *  Closes on backdrop click, Esc, the X button, or after item nav.
 *  Pure React state — no portal lib, no animation lib. */
function OtherMenuModal({ onClose }: { onClose: () => void }): JSX.Element {
  const router = useRouter();
  // Esc-key dismiss + backdrop click; mounted once via useEffect.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const goInternal = (href: string) => {
    onClose();
    router.push(href);
  };
  const ITEM_STYLE: React.CSSProperties = {
    display:        'flex',
    alignItems:     'center',
    justifyContent: 'flex-start',
    width:          '100%',
    padding:        '11px 14px',
    fontSize:       13,
    fontWeight:     600,
    letterSpacing:  '0.4px',
    color:          '#d0c8e4',
    background:     'transparent',
    border:         'none',
    outline:        'none',
    borderRadius:   8,
    cursor:         'pointer',
    fontFamily:     'inherit',
    textTransform:  'uppercase',
    textDecoration: 'none',
    transition:     'background 0.12s, color 0.12s',
  };
  const ITEM_LABEL: React.CSSProperties = { flex: 1, textAlign: 'left' };
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Other navigation"
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(8, 6, 18, 0.62)',
        backdropFilter: 'blur(6px)',
        WebkitBackdropFilter: 'blur(6px)',
        zIndex: 9999,
        animation: 'otherMenuBackdropIn 160ms ease-out',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          minWidth: 240, maxWidth: 320, width: '78%',
          padding: 8,
          background: 'linear-gradient(180deg, rgba(20,14,34,0.98) 0%, rgba(14,11,28,0.98) 100%)',
          border: '1px solid rgba(168,144,232,0.28)',
          borderRadius: 12,
          boxShadow:
            '0 20px 50px rgba(0,0,0,0.65), ' +
            '0 0 0 1px rgba(0,0,0,0.4), ' +
            '0 0 28px rgba(128,104,216,0.18)',
          animation: 'otherMenuCardIn 180ms cubic-bezier(0.22,1,0.36,1)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 8px 8px' }}>
          <span style={{ fontSize: 10, fontWeight: 700, color: '#7a7a94', letterSpacing: '1px' }}>OTHER</span>
          <button
            type="button"
            aria-label="Close"
            onClick={onClose}
            style={{
              width: 22, height: 22, padding: 0,
              border: 'none', outline: 'none',
              background: 'transparent', color: '#55556e',
              fontSize: 16, lineHeight: '22px', cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >×</button>
        </div>
        <button
          type="button"
          style={ITEM_STYLE}
          onMouseDown={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(168,144,232,0.12)'; }}
          onMouseUp={(e)   => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
          onClick={() => goInternal('/mints')}
        >
          <span style={ITEM_LABEL}>Mints</span>
        </button>
        <button
          type="button"
          style={ITEM_STYLE}
          onMouseDown={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgba(168,144,232,0.12)'; }}
          onMouseUp={(e)   => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
          onClick={() => goInternal('/tools')}
        >
          <span style={ITEM_LABEL}>Offers</span>
        </button>
        <a
          href="https://wallet.victorylabs.app/burner"
          target="_blank"
          rel="noopener noreferrer"
          style={ITEM_STYLE}
          onMouseDown={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = 'rgba(168,144,232,0.12)'; }}
          onMouseUp={(e)   => { (e.currentTarget as HTMLAnchorElement).style.background = 'transparent'; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = 'transparent'; }}
          onClick={onClose}
        >
          <span style={ITEM_LABEL}>Burner</span>
        </a>
      </div>
    </div>
  );
}

/**
 * Unified runtime control module — one compact cluster replacing the old
 * three competing accents (MODE badge + MINTS ON/OFF + OFF). A status pill
 * (purple-tinted, ~28px) opens a dropdown to manage runtime; a power button
 * is the kill switch. All underlying runtime logic is preserved verbatim:
 * fetchMode (sales mode display), setMintTrackerEnabled (optimistic Mints
 * toggle), and runtimeSetMode('off') + clearAuth + redirect (power off).
 */
function RuntimeControls() {
  const [mode, setMode]               = useState<RuntimeMode | null>(null);
  const [mintsEnabled, setMintsEnabled] = useState<boolean | null>(null);
  const [open, setOpen]               = useState(false);
  const [mintsBusy, setMintsBusy]     = useState(false);
  const [offBusy, setOffBusy]         = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    runtimeFetchMode().then(m => { if (!cancelled) setMode(m); });
    fetchMintTrackerEnabled().then(v => { if (!cancelled) setMintsEnabled(v); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false); };
    const onKey  = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
  }, [open]);

  // Don't paint until the first fetch resolves (avoids a flash of "Idle").
  if (mode === null && mintsEnabled === null) return null;

  const salesActive = mode != null && mode !== 'off';
  const mintsActive = mintsEnabled === true;
  // Tiny status dot: green = both subsystems active, yellow = partial, gray =
  // none active.
  const activeCount = (salesActive ? 1 : 0) + (mintsActive ? 1 : 0);
  const dot = activeCount === 2 ? '#5ce0a0' : activeCount === 1 ? '#e0c45c' : '#6a6a82';
  const parts: string[] = [];
  if (salesActive) parts.push('Sales');
  if (mintsActive) parts.push('Mints');
  const label = parts.length ? parts.join(' · ') : 'Idle';

  // MINTS toggle — optimistic, rolls back on failure (unchanged logic).
  const toggleMints = async () => {
    if (mintsBusy || mintsEnabled === null) return;
    setMintsBusy(true);
    const next = !mintsEnabled;
    setMintsEnabled(next);
    const result = await setMintTrackerEnabled(next);
    setMintsEnabled(typeof result === 'boolean' ? result : !next);
    setMintsBusy(false);
  };
  // Kill switch — stop ingestion, drop runtime selection, sign out, reload
  // into <Gate> (unchanged logic).
  const powerOff = async () => {
    if (offBusy) return;
    setOffBusy(true);
    try { await runtimeSetMode('off'); } catch { /* ignore; still wipe local state */ }
    setRuntimeChoice(null);
    runtimeClearAuth();
    window.location.href = '/';
  };

  return (
    <div ref={rootRef} className="topnav-runtime" style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        title="Runtime — click to manage"
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 7,
          height: 28, padding: '0 10px', borderRadius: 7,
          background: open ? 'rgba(168,144,232,0.16)' : 'rgba(168,144,232,0.08)',
          border: '1px solid rgba(168,144,232,0.18)',
          color: '#cfc6e6', fontFamily: 'inherit', fontSize: 11, letterSpacing: '0.4px',
          cursor: 'pointer', transition: 'background 0.14s, border-color 0.14s',
        }}
        onMouseEnter={e => { e.currentTarget.style.background = 'rgba(168,144,232,0.14)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = open ? 'rgba(168,144,232,0.16)' : 'rgba(168,144,232,0.08)'; }}
      >
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: dot, boxShadow: `0 0 6px ${dot}99`, flexShrink: 0 }} />
        <span className="topnav-mode-badge" style={{ fontWeight: 600 }}>{label}</span>
        <span aria-hidden style={{ fontSize: 9, opacity: 0.7 }}>▾</span>
      </button>
      <button
        type="button"
        onClick={powerOff}
        disabled={offBusy}
        title="Stop ingestion and sign out"
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 28, height: 28, borderRadius: 7,
          background: 'rgba(224,106,106,0.08)',
          border: '1px solid rgba(224,106,106,0.20)',
          color: offBusy ? '#55556e' : '#e0888a',
          cursor: offBusy ? 'not-allowed' : 'pointer',
          transition: 'background 0.14s, color 0.14s',
        }}
        onMouseEnter={e => { if (!offBusy) e.currentTarget.style.background = 'rgba(224,106,106,0.16)'; }}
        onMouseLeave={e => { e.currentTarget.style.background = 'rgba(224,106,106,0.08)'; }}
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <line x1="12" y1="2" x2="12" y2="12" />
          <path d="M18.4 6.6a9 9 0 1 1-12.8 0" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          style={{
            position: 'absolute', top: '100%', right: 0, marginTop: 6,
            minWidth: 200,
            background: 'linear-gradient(180deg, rgba(20,14,34,0.98) 0%, rgba(14,11,28,0.98) 100%)',
            border: '1px solid rgba(168,144,232,0.22)', borderRadius: 8,
            boxShadow: '0 12px 32px rgba(0,0,0,0.6), 0 0 14px rgba(128,104,216,0.14)',
            padding: 8, zIndex: 1000,
            backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)',
            display: 'flex', flexDirection: 'column', gap: 8, fontFamily: 'inherit',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
            <span style={{ fontSize: 10, letterSpacing: '0.6px', color: '#7a7a94', textTransform: 'uppercase' }}>Sales</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11, color: salesActive ? '#cfc6e6' : '#6a6a82' }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: salesActive ? '#5ce0a0' : '#6a6a82' }} />
              {salesActive ? mode!.replace('_', ' ').toUpperCase() : 'OFF'}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
            <span style={{ fontSize: 10, letterSpacing: '0.6px', color: '#7a7a94', textTransform: 'uppercase' }}>Mints</span>
            <button
              type="button"
              onClick={toggleMints}
              disabled={mintsBusy || mintsEnabled === null}
              role="switch"
              aria-checked={mintsActive}
              title={mintsActive ? 'Mint tracker ON — click to stop' : 'Mint tracker OFF — click to start'}
              className={`vl-switch${mintsActive ? ' vl-switch-on' : ''}`}
              style={{ opacity: mintsBusy ? 0.5 : 1, cursor: mintsBusy ? 'wait' : 'pointer' }}
            >
              <span className="vl-switch-thumb" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/* MintTrackerToggle + OffButton were folded into RuntimeControls above so the
 * topbar carries one unified runtime module instead of three competing
 * accents. Their logic (optimistic Mints toggle, OFF kill switch) lives there. */
