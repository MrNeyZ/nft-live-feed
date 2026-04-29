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
import { LiveDot, TopNav, BottomStatusBar, CollectionIcon, compressImage } from '@/soloist/shared';
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
  const [sortKey, setSortKey] = useState<SortKey>('velocity');
  const [, force]             = useState(0);

  // Self-tick so velocity / lastMint columns refresh smoothly between
  // backend status frames (every 5s here vs. 30s sweep on backend).
  useEffect(() => {
    const id = setInterval(() => force(n => n + 1), 5_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;
    const connect = () => {
      if (cancelled) return;
      es = new EventSource(`${API_BASE}/api/events/stream`);
      es.addEventListener('mint_status', (e: MessageEvent) => {
        try {
          const s = JSON.parse(e.data) as MintStatus;
          setRows(prev => {
            const next = new Map(prev);
            if (s.displayState === 'shown') next.set(s.groupingKey, s);
            else next.delete(s.groupingKey);
            return next;
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
  }, []);

  const sorted = useMemo(() => {
    const arr = Array.from(rows.values());
    if (sortKey === 'velocity') {
      arr.sort((a, b) => b.v60 - a.v60 || b.observedMints - a.observedMints);
    } else {
      arr.sort((a, b) => b.observedMints - a.observedMints || b.v60 - a.v60);
    }
    return arr;
  }, [rows, sortKey]);

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
              </tr>
            </thead>
            <tbody>
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', color: '#55556e', padding: '48px 0 12px', fontSize: 13 }}>
                    Waiting for active mints…
                  </td>
                </tr>
              )}
              {sorted.length === 0 && (
                <tr>
                  <td colSpan={7} style={{ textAlign: 'center', color: '#3a3a52', padding: '0 24px 48px', fontSize: 11.5, lineHeight: 1.5 }}>
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
                        <CollectionIcon imageUrl={compressImage(r.imageUrl ?? null)} color="#8068d8" abbr={(displayName[0] ?? '?').toUpperCase() + (displayName[1] ?? '').toUpperCase()} size={32} />
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
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
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
