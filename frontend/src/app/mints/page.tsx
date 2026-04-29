'use client';

// VictoryLabs — Mints.
// Real-time NFT mint tracker. Subscribes to the existing SSE stream's
// `mint_status` channel; one in-process accumulator on the backend
// emits a status frame per collection on every detected mint and on a
// 30s sweep. No per-client polling. No new RPC.
//
// Layout mirrors /dashboard so the table style is consistent — same
// `.collections-table` className for phone CSS reuse, same flex shell,
// same scroll containment.

import { useEffect, useMemo, useState } from 'react';
import { LiveDot, TopNav, BottomStatusBar, ItemThumb } from '@/soloist/shared';
import { formatSol } from '@/soloist/mock-data';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

type ProgramSource = 'mpl_token_metadata' | 'mpl_core' | 'bubblegum';
type MintRollupType = 'free' | 'paid' | 'unknown' | 'mixed';
type SourceLabel =
  | 'LaunchMyNFT' | 'VVV' | 'ME'
  | 'Metaplex Candy Machine' | 'Metaplex Core' | 'Metaplex'
  | 'Bubblegum' | 'Unknown';

interface MintStatus {
  groupingKey:       string;
  groupingKind:      string;
  programSource:     ProgramSource;
  collectionAddress: string | null;
  displayState:      'incubating' | 'shown' | 'cooled';
  shownReason?:      'threshold' | 'burst';
  observedMints:     number;
  v60:               number;
  v5m:               number;
  lastMintAt:        number;
  mintType:          MintRollupType;
  priceLamports:     number | null;
  sourceLabel:       SourceLabel;
  name?:             string;
  imageUrl?:         string;
}

/** Individual mint event — one fired per detected mint, before
 *  aggregation. Backend broadcasts these on the existing `event: mint`
 *  SSE channel (see src/events/emitter.ts MintEventWire); we mirror
 *  the shape here. Per-mint `nftName` / `imageUrl` are intentionally
 *  not on the wire — those are resolved per-`groupingKey` by the
 *  backend enricher and arrive via `mint_status`. The live feed
 *  uses the group-level imageUrl (looked up from `rows`) as the
 *  row thumbnail, with a placeholder when not yet resolved. */
interface MintEvent {
  signature:         string;
  blockTime:         string;          // ISO 8601
  programSource:     ProgramSource;
  mintAddress:       string | null;
  collectionAddress: string | null;
  groupingKey:       string;
  groupingKind:      string;
  mintType:          'free' | 'paid' | 'unknown';
  priceLamports:     number | null;
  minter:            string | null;
  sourceLabel:       SourceLabel;
  /** Wall-clock receive time (ms). Drives the "Xs ago" column without
   *  re-parsing blockTime on every tick. */
  receivedAt:        number;
}

/** Live-feed retention. Older events are dropped from the head when
 *  this is exceeded. Memory-only — never persisted. */
const LIVE_FEED_MAX = 150;
/** Proxy size for live-feed thumbnails — 64×64, matches the spec's
 *  /thumb URL form. compressImage() defaults to 200×200; the live
 *  feed uses this smaller size to halve bandwidth on rolling rows. */
function thumb64(url: string | null | undefined): string | null {
  if (!url) return null;
  if (url.startsWith('data:')) return url;
  if (url.startsWith('/thumb?') || url.startsWith('/api/thumb?')) return url;
  return `/thumb?url=${encodeURIComponent(url)}&w=64&h=64&fit=cover&output=png`;
}
function shortMint(addr: string | null): string {
  if (!addr) return '—';
  return addr.length > 10 ? `${addr.slice(0, 4)}…${addr.slice(-4)}` : addr;
}

function sourceBadge(s: SourceLabel): { label: string; bg: string; fg: string } {
  switch (s) {
    case 'LaunchMyNFT':            return { label: 'LMNFT',    bg: 'rgba(232,193,74,0.15)',  fg: '#e8c14a' };
    case 'VVV':                    return { label: 'VVV',      bg: 'rgba(95,168,230,0.15)',  fg: '#5fa8e6' };
    case 'ME':                     return { label: 'ME',       bg: 'rgba(232,122,176,0.15)', fg: '#e87ab0' };
    case 'Metaplex Candy Machine': return { label: 'CANDY',    bg: 'rgba(168,144,232,0.15)', fg: '#a890e8' };
    case 'Metaplex Core':          return { label: 'CORE',     bg: 'rgba(168,144,232,0.15)', fg: '#a890e8' };
    case 'Metaplex':               return { label: 'METAPLEX', bg: 'rgba(168,144,232,0.15)', fg: '#a890e8' };
    case 'Bubblegum':              return { label: 'cNFT',     bg: 'rgba(92,224,160,0.15)',  fg: '#5ce0a0' };
    default:                       return { label: 'UNKNOWN',  bg: 'rgba(255,255,255,0.05)', fg: '#7a7a94' };
  }
}

type SortKey = 'velocity' | 'mints';

function fmtSol(lamports: number | null): string {
  if (lamports == null) return '—';
  if (lamports === 0)   return 'FREE';
  // Shared formatter: ≥0.1 → 2 decimals, <0.1 → 3 decimals.
  return formatSol(lamports / 1e9);
}

function fmtAge(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 5_000)     return 'just now';
  if (diff < 60_000)    return `${Math.floor(diff / 1_000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  return `${Math.floor(diff / 3_600_000)}h ago`;
}

function typeBadge(t: MintRollupType): { label: string; bg: string; fg: string } {
  switch (t) {
    case 'free':    return { label: 'FREE',    bg: 'rgba(92,224,160,0.15)',  fg: '#5ce0a0' };
    case 'paid':    return { label: 'PAID',    bg: 'rgba(168,144,232,0.15)', fg: '#a890e8' };
    case 'mixed':   return { label: 'MIXED',   bg: 'rgba(232,193,74,0.15)',  fg: '#e8c14a' };
    default:        return { label: 'UNKNOWN', bg: 'rgba(255,255,255,0.05)', fg: '#7a7a94' };
  }
}

function shortKey(k: string): string {
  // Display-friendly truncation when no name is available.
  const clean = k.replace(/^[a-z]+:/, '');
  return clean.length > 14 ? `${clean.slice(0, 6)}…${clean.slice(-4)}` : clean;
}

/** Per-row external links cluster: Solscan + Magic Eden.
 *  Solscan path branches on programSource — MPL Core assets/collections
 *  are first-class accounts (`/account/`), Token Metadata mints are SPL
 *  token mints (`/token/`). Magic Eden's `/item-details/<addr>` resolves
 *  both Core asset addresses and TM mint addresses, so a single URL form
 *  covers both. Renders a muted dash when no on-chain anchor is known
 *  yet (groupingKind is `authority` / `programSource`). */
function RowLinks({
  collectionAddress,
  programSource,
}: {
  collectionAddress: string | null;
  programSource: ProgramSource;
}) {
  if (!collectionAddress) {
    return <span style={{ color: '#3a3a52', fontSize: 11 }}>—</span>;
  }
  const solscanPath = programSource === 'mpl_core' ? 'account' : 'token';
  const solscanUrl  = `https://solscan.io/${solscanPath}/${collectionAddress}`;
  const meUrl       = `https://magiceden.io/item-details/${collectionAddress}`;
  return (
    <div style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end' }}>
      <a
        href={solscanUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={`Solscan · ${collectionAddress}`}
        style={solscanChipStyle}
      >SOL</a>
      <a
        href={meUrl}
        target="_blank"
        rel="noopener noreferrer"
        title={`Magic Eden · ${collectionAddress}`}
        style={logoChipStyle}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/me.png" alt="Magic Eden" width={20} height={20} draggable={false} style={logoImgStyle} />
      </a>
    </div>
  );
}

/** Square chrome shared with /tools — 22×22 logo button. */
const logoChipStyle: React.CSSProperties = {
  display:        'inline-flex',
  alignItems:     'center',
  justifyContent: 'center',
  width:          22,
  height:         22,
  borderRadius:   4,
  overflow:       'hidden',
  border:         '1px solid rgba(255,255,255,0.08)',
  cursor:         'pointer',
  textDecoration: 'none',
  flexShrink:     0,
  lineHeight:     0,
};
const logoImgStyle: React.CSSProperties = {
  display:      'block',
  width:        '100%',
  height:       '100%',
  objectFit:    'cover',
  pointerEvents: 'none',
};
/** Text-only chip used for Solscan since we don't ship a brand asset
 *  for it. Same 22×22 footprint as the logo chips so the LINKS column
 *  stays a uniform width regardless of which links are present. */
const solscanChipStyle: React.CSSProperties = {
  display:        'inline-flex',
  alignItems:     'center',
  justifyContent: 'center',
  width:          22,
  height:         22,
  fontSize:       9,
  fontWeight:     800,
  letterSpacing:  '0.3px',
  borderRadius:   4,
  border:         '1px solid rgba(168,144,232,0.45)',
  background:     'rgba(168,144,232,0.12)',
  color:          '#a890e8',
  textDecoration: 'none',
  cursor:         'pointer',
  flexShrink:     0,
};

export default function MintsPage() {
  // Embed mode (`?embed=1`) suppresses TopNav so multi-tab can iframe
  // the real /mints page without a duplicated chrome row, mirroring
  // the existing /dashboard and /feed embed plumbing.
  const [embedded, setEmbedded] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setEmbedded(new URLSearchParams(window.location.search).get('embed') === '1');
  }, []);
  useEffect(() => { document.title = 'VictoryLabs — Mints'; }, []);
  const [rows, setRows]       = useState<Map<string, MintStatus>>(new Map());
  /** Rolling buffer of individual mint events for the bottom Live Feed.
   *  Newest at index 0; capped at LIVE_FEED_MAX. */
  const [events, setEvents]   = useState<MintEvent[]>([]);
  const [sortKey, setSortKey] = useState<SortKey>('velocity');
  const [, force]             = useState(0);

  // Self-tick so velocity / lastMint columns refresh smoothly between
  // backend status frames (every 5s here vs. 30s sweep on backend).
  useEffect(() => {
    const id = setInterval(() => force(n => n + 1), 5_000);
    return () => clearInterval(id);
  }, []);

  // Sampled console logger for `mint_status` frames. First N frames
  // emit verbatim (to confirm the wiring); after that every 25th to
  // avoid devtools spam under a hot launch. Intentionally noisy at
  // boot — we want the operator to see the SSE lifecycle in console
  // when debugging an "empty page" report.
  const dbgCountRef = (typeof window !== 'undefined')
    ? ((window as unknown as { __mintsDbg?: { n: number } }).__mintsDbg ??=
        { n: 0 })
    : { n: 0 };
  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;
    const connect = () => {
      if (cancelled) return;
      es = new EventSource(`${API_BASE}/api/events/stream`);
      es.addEventListener('mint_status', (e: MessageEvent) => {
        try {
          const s = JSON.parse(e.data) as MintStatus;
          dbgCountRef.n++;
          if (dbgCountRef.n <= 5 || dbgCountRef.n % 25 === 0) {
            // eslint-disable-next-line no-console
            console.log(
              `[mints/sse] n=${dbgCountRef.n} state=${s.displayState} ` +
              `key=${s.groupingKey.slice(0, 32)} observed=${s.observedMints} ` +
              `v60=${s.v60} v5m=${s.v5m} type=${s.mintType}`,
            );
          }
          setRows(prev => {
            const next = new Map(prev);
            // Keep all states in the rolling map — the table renders
            // only `shown` rows; incubating/cooled rows aren't surfaced
            // in this UI but stay in the map so a `mint` event can look
            // up its group's lazily-resolved imageUrl/name for the
            // Live Feed thumbnail without re-fetching.
            next.set(s.groupingKey, s);
            return next;
          });
        } catch { /* malformed frame — skip */ }
      });
      // Per-mint live feed channel. Already broadcast by the backend
      // (sse.ts → buildMintFrame); this is the first consumer. We keep
      // the latest LIVE_FEED_MAX events in memory only — never persist.
      es.addEventListener('mint', (e: MessageEvent) => {
        try {
          const m = JSON.parse(e.data) as Omit<MintEvent, 'receivedAt'>;
          const ev: MintEvent = { ...m, receivedAt: Date.now() };
          setEvents(prev => {
            const next = [ev, ...prev];
            return next.length > LIVE_FEED_MAX ? next.slice(0, LIVE_FEED_MAX) : next;
          });
        } catch { /* malformed frame — skip */ }
      });
      es.addEventListener('error', () => {
        es?.close();
        if (!cancelled) setTimeout(connect, 2_000);
      });
    };
    connect();
    return () => { cancelled = true; es?.close(); };
  // dbgCountRef is a stable mutable ref — exclude from deps to avoid the
  // effect re-running on every render and re-opening the SSE stream.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Main table — only `shown` rows (the production view). */
  const sorted = useMemo(() => {
    const arr = Array.from(rows.values()).filter(r => r.displayState === 'shown');
    if (sortKey === 'velocity') {
      arr.sort((a, b) => b.v60 - a.v60 || b.observedMints - a.observedMints);
    } else {
      arr.sort((a, b) => b.observedMints - a.observedMints || b.v60 - a.v60);
    }
    return arr;
  }, [rows, sortKey]);

  /** Live mint feed — events array drives the bottom panel directly,
   *  newest first (already maintained by the SSE handler). The group
   *  imageUrl/name is looked up from `rows` at render time so freshly
   *  enriched groups update their feed thumbnails on the next React
   *  re-render without re-fetching anything. */

  return (
    <div className="feed-root" data-page="mints" data-embedded={embedded ? '1' : undefined}>
      {!embedded && <TopNav active="mints" />}

      {/* Header — hidden in embed mode so the multi-tab pane chrome
          owns the title context. Mirrors the same pattern used by
          /dashboard's "Trending collections" header. */}
      {!embedded && (
        <div style={{ padding: '20px 4px 14px', flexShrink: 0, width: '100%', maxWidth: 1000, margin: '0 auto', boxSizing: 'border-box' }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between' }}>
            <div>
              <h1 style={{ fontSize: 22, fontWeight: 700, color: '#e8e6f2', letterSpacing: '-0.5px' }}>
                Live mint tracker
              </h1>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
                <LiveDot />
                <span style={{ fontSize: 11, color: '#4fb67d' }}>
                  {sorted.length === 0 ? 'No active mints' : `${sorted.length} active collection${sorted.length === 1 ? '' : 's'}`}
                </span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Table card (mirrors dashboard chrome). In embed mode the
          maxWidth cap is removed so the card fills the iframe edge-
          to-edge, matching how /dashboard and /feed render in their
          multi-tab panes; bottom margin is dropped for the same reason. */}
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0,
        width: '100%',
        maxWidth: embedded ? 'none' : 1000,
        margin: '0 auto',
        background: 'linear-gradient(180deg, #201a3a 0%, #1a1530 100%)',
        border: '1px solid rgba(168,144,232,0.65)',
        borderRadius: 12,
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4), 0 0 28px rgba(128,104,216,0.15)',
        overflow: 'hidden',
        marginBottom: embedded ? 0 : 16,
      }}>
        <div style={{ flex: 1, overflowY: 'auto' }} className="scroll-area">
          <table className="collections-table" style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <thead>
              <tr style={{ position: 'sticky', top: 0, zIndex: 1, background: 'rgba(28,22,50,0.95)' }}>
                <th style={thStyle} onClick={() => setSortKey('mints')}>
                  COLLECTION
                </th>
                <th style={{ ...thStyle, cursor: 'pointer' }} onClick={() => setSortKey('mints')}>
                  MINTS {sortKey === 'mints' && <span style={{ color: '#8068d8' }}>↓</span>}
                </th>
                <th style={{ ...thStyle, cursor: 'pointer' }} onClick={() => setSortKey('velocity')}>
                  MINT/MIN {sortKey === 'velocity' && <span style={{ color: '#8068d8' }}>↓</span>}
                </th>
                <th style={thStyle}>LAST MINT</th>
                <th style={thStyle}>PRICE</th>
                <th style={thStyle}>SOURCE</th>
                <th style={thStyle}>TYPE</th>
                <th style={thStyle}>LINKS</th>
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', color: '#55556e', padding: '48px 0 12px', fontSize: 13 }}>
                    Waiting for active mints…
                  </td>
                </tr>
              )}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', color: '#3a3a52', padding: '0 24px 48px', fontSize: 11.5, lineHeight: 1.5 }}>
                    Collections appear after burst activity (≥ 8 mints in 60 s)
                    or 50 observed mints. Until then they incubate silently in
                    the backend.
                  </td>
                </tr>
              )}
              {sorted.map((r, i) => {
                const tb = typeBadge(r.mintType);
                const displayName = r.name ?? shortKey(r.groupingKey);
                const isBurst = r.shownReason === 'burst';
                return (
                  <tr key={r.groupingKey} style={{
                    borderBottom: '1px solid rgba(255,255,255,0.04)',
                    transition: 'background 0.12s',
                  }}>
                    <td style={{ padding: '12px 6px 12px 10px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                        <span style={{ color: '#8a8aa6', fontSize: 12, fontWeight: 500, fontFamily: "'SF Mono','Fira Code',monospace", minWidth: 18, textAlign: 'right' }}>{i + 1}</span>
                        {/* Single collection preview image — same component
                            (ItemThumb) the Live Feed below uses, so the
                            multi-tab embed and the standalone page render a
                            consistent NFT-style square thumbnail in both
                            surfaces. Source URL is routed through the 64×64
                            variant of the /thumb proxy (vs. the 200×200
                            compressImage default) — at a 40 px DOM render
                            size, the smaller proxy fetch is ~3× cheaper
                            on bandwidth without visible quality loss.
                            ItemThumb already sets width/height attrs on
                            the <img>, so layout doesn't shift when the
                            image arrives. Falls back to the initials
                            placeholder on missing / errored images,
                            mirroring /feed's thumbnail behaviour. */}
                        <ItemThumb
                          imageUrl={thumb64(r.imageUrl ?? null)}
                          color="#8068d8"
                          abbr={(displayName[0] ?? '?').toUpperCase() + (displayName[1] ?? '').toUpperCase()}
                          size={40}
                        />
                        <span style={{ fontSize: 14, fontWeight: 600, color: '#f0eef8', letterSpacing: '-0.2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {displayName}
                          {isBurst && (
                            <span title="Burst-detected — recent velocity spike" style={{ marginLeft: 6, fontSize: 10, color: '#e87a5e' }}>🔥</span>
                          )}
                        </span>
                      </div>
                    </td>
                    <td style={{ padding: '12px 4px', textAlign: 'right', fontSize: 14, fontWeight: 800, color: '#f0eef8', letterSpacing: '-0.2px' }}>
                      {r.observedMints.toLocaleString()}
                    </td>
                    <td style={{ padding: '12px 4px', textAlign: 'right', fontSize: 14, fontWeight: 700, color: '#5ce0a0', letterSpacing: '-0.2px' }}>
                      {r.v60.toFixed(0)}
                    </td>
                    <td style={{ padding: '12px 4px', textAlign: 'right', fontSize: 11.5, color: '#5e5e78', fontWeight: 500 }}>
                      {fmtAge(r.lastMintAt)}
                    </td>
                    <td style={{ padding: '12px 4px', textAlign: 'right', fontSize: 12, color: '#aaaabf', fontWeight: 600, fontFamily: "'SF Mono','Fira Code',monospace" }}>
                      {fmtSol(r.priceLamports)}
                    </td>
                    <td style={{ padding: '12px 4px', textAlign: 'right' }}>
                      {(() => {
                        const sb = sourceBadge(r.sourceLabel);
                        return (
                          <span style={{
                            display: 'inline-block', padding: '2px 8px', fontSize: 10, fontWeight: 700, borderRadius: 4,
                            background: sb.bg, color: sb.fg, letterSpacing: '0.3px',
                          }}>{sb.label}</span>
                        );
                      })()}
                    </td>
                    <td style={{ padding: '12px 8px 12px 4px', textAlign: 'right' }}>
                      <span style={{
                        display: 'inline-block', padding: '2px 8px', fontSize: 10, fontWeight: 700, borderRadius: 4,
                        background: tb.bg, color: tb.fg, letterSpacing: '0.3px',
                      }}>{tb.label}</span>
                    </td>
                    {/* LINKS column — Solscan + Magic Eden item page for the
                        collection asset. Both keyed off `collectionAddress`
                        which is the only stable on-chain anchor available
                        on the per-collection rollup (no individual mint
                        address is exposed at this aggregation level). */}
                    <td style={{ padding: '12px 8px 12px 4px', textAlign: 'right' }}>
                      <RowLinks
                        collectionAddress={r.collectionAddress}
                        programSource={r.programSource}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Live Mint Feed ──────────────────────────────────────────────
          Per-mint stream (one row = one detected mint), independent of
          the aggregation gate that drives the table above. Renders
          regardless of whether any collection has reached `shown` state
          — useful as the always-active heartbeat for the page. Image
          + name are looked up from the per-group `rows` map (populated
          by `mint_status` frames) so freshly-enriched groups upgrade
          their thumbnails in-place; new mints from un-enriched groups
          render the placeholder until the backend's enricher catches
          up. No per-NFT metadata fetching anywhere on the client. */}
      {!embedded && (
        <div style={{
          width: '100%', maxWidth: 1000, margin: '0 auto 16px',
          background: 'linear-gradient(180deg, #201a3a 0%, #1a1530 100%)',
          border: '1px solid rgba(168,144,232,0.65)', borderRadius: 12,
          boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4), 0 0 28px rgba(128,104,216,0.15)',
          // Fixed-height pane: the feed must never grow with content —
          // it sits below the active-collections table as a scrollable
          // panel, not a page-expanding block. height + maxHeight pin
          // the box; the inner scroll-area below handles overflow.
          overflow: 'hidden', display: 'flex', flexDirection: 'column', height: 360, maxHeight: 360,
        }}>
          <div style={{ padding: '10px 14px 8px', borderBottom: '1px solid rgba(168,144,232,0.12)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <LiveDot />
              <span style={{ fontSize: 11, fontWeight: 700, color: '#a890e8', letterSpacing: '0.6px' }}>
                LIVE MINT FEED
              </span>
            </div>
            <span style={{ fontSize: 10, color: '#55556e' }}>
              {events.length === 0 ? 'waiting…' : `${events.length} recent · max ${LIVE_FEED_MAX}`}
            </span>
          </div>
          <div className="scroll-area" style={{ flex: 1, overflowY: 'auto' }}>
            {events.length === 0 && (
              <div style={{ textAlign: 'center', color: '#3a3a52', padding: '36px 16px', fontSize: 12 }}>
                Waiting for individual mint events…
              </div>
            )}
            {events.map(ev => {
              const group       = rows.get(ev.groupingKey);
              const displayName = group?.name ?? shortMint(ev.mintAddress);
              const abbr        = (displayName[0] ?? '?').toUpperCase() + (displayName[1] ?? '').toUpperCase();
              const sb          = sourceBadge(ev.sourceLabel);
              const priceText   = ev.priceLamports == null
                ? '—'
                : ev.priceLamports === 0 ? 'FREE' : formatSol(ev.priceLamports / 1e9);
              const priceColor  = ev.priceLamports == null
                ? '#55556e'
                : ev.priceLamports === 0 ? '#5ce0a0' : '#f0eef8';
              return (
                <div key={ev.signature} style={{
                  display: 'flex', alignItems: 'center', gap: 12,
                  padding: '8px 14px',
                  borderBottom: '1px solid rgba(255,255,255,0.04)',
                }}>
                  {/* 64×64 NFT thumbnail. ItemThumb renders the placeholder
                      tile (initials + group color) until the group's
                      imageUrl is enriched, at which point this re-renders
                      with the proxied image. */}
                  <ItemThumb
                    imageUrl={thumb64(group?.imageUrl ?? null)}
                    color="#8068d8"
                    abbr={abbr}
                    size={64}
                  />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: '#f0eef8', letterSpacing: '-0.2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {displayName}
                    </div>
                    <div style={{ fontSize: 10.5, color: '#56566e', fontFamily: "'SF Mono','Fira Code',monospace", marginTop: 2 }}>
                      {shortMint(ev.mintAddress)}
                    </div>
                  </div>
                  <span style={{
                    display: 'inline-block', padding: '2px 8px', fontSize: 10, fontWeight: 700, borderRadius: 4,
                    background: sb.bg, color: sb.fg, letterSpacing: '0.3px', flexShrink: 0,
                  }}>{sb.label}</span>
                  <span style={{
                    minWidth: 64, textAlign: 'right',
                    fontSize: 13, fontWeight: 700, color: priceColor,
                    fontFamily: "'SF Mono','Fira Code',monospace",
                    fontVariantNumeric: 'tabular-nums',
                    flexShrink: 0,
                  }}>{priceText}</span>
                  <span style={{ minWidth: 56, textAlign: 'right', fontSize: 11, color: '#5e5e78', fontWeight: 500, flexShrink: 0 }}>
                    {fmtAge(ev.receivedAt)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!embedded && <BottomStatusBar />}
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: '10px 4px',
  fontSize: 9.5,
  fontWeight: 700,
  color: '#56566e',
  letterSpacing: '0.6px',
  textAlign: 'right',
  background: 'rgba(28,22,50,0.95)',
  borderBottom: '1px solid rgba(168,144,232,0.12)',
  textTransform: 'uppercase',
  userSelect: 'none',
};
