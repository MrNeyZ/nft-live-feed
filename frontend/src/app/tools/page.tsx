'use client';

// VictoryLabs — Tools.
// Manual, on-demand scanners. v1: Retardio listings with Magic Eden
// personal offers.

import { useEffect, useMemo, useState } from 'react';
import { TopNav, LiveDot, BottomStatusBar, CollectionIcon, compressImage } from '@/soloist/shared';
import { formatSol } from '@/soloist/mock-data';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

interface ScanRow {
  mint:               string;
  nftName:            string | null;
  imageUrl:           string | null;
  listingPrice:       number;
  bestOfferPrice:     number;
  spreadSol:          number;
  bestOfferId:        string;
  bestOfferCreatedAt: number | null;     // seconds since epoch
  meUrl:              string;
  tensorUrl:          string;
  /** Frontend-only flag: row's `bestOfferId` was not present in the
   *  previous cached scan. Set at scan-merge time, persisted in
   *  localStorage, cleared on the next scan. */
  isNew?:             boolean;
}

type SortKey = 'nft' | 'listing' | 'offer' | 'spread' | 'age';
type SortDir = 'asc' | 'desc';

function fmtAge(createdAtSec: number | null): string {
  if (createdAtSec == null) return '—';
  const diffSec = Math.floor(Date.now() / 1000) - createdAtSec;
  if (diffSec < 0)        return 'just now';
  if (diffSec < 60)       return `${diffSec}s ago`;
  if (diffSec < 3_600)    return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86_400)   return `${Math.floor(diffSec / 3_600)}h ago`;
  return `${Math.floor(diffSec / 86_400)}d ago`;
}
interface ScanResult {
  ok:            true;
  slug:          string;
  scanned:       number;
  listedTotal:   number;
  offersFetched: number;
  offersActive:  number;
  withOffers:    ScanRow[];
  cachedAt:      number;
  ttlMs:         number;
  fromCache?:    boolean;
}

function shortAddr(s: string | null): string {
  if (!s) return '—';
  return s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}

/** localStorage key for the persisted scan result. Survives navigation
 *  away from /tools and full page reloads so the table doesn't reset
 *  to "click Scan" on every visit. */
const STORAGE_KEY = 'vl.tools.retardioMeOfferScan';

/** NEW flags auto-expire after this many minutes so a long absence
 *  doesn't leave the ribbon stuck. The next scan also clears them
 *  organically (they'll appear in prevIds), so this is the worst-case
 *  bound — operator never sees a "NEW" badge older than 10 minutes. */
const NEW_FLAG_TTL_MS = 10 * 60_000;

function loadPersisted(): ScanResult | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ScanResult;
    // Sanity-check the shape — reject anything that doesn't smell like
    // a v1 scan result so a stale schema can't crash render.
    if (!parsed || !Array.isArray(parsed.withOffers)) return null;
    // Expire NEW flags older than the TTL.
    const ageMs = Date.now() - (parsed.cachedAt ?? 0);
    if (ageMs > NEW_FLAG_TTL_MS) {
      return {
        ...parsed,
        withOffers: parsed.withOffers.map(r => ({ ...r, isNew: false })),
      };
    }
    return parsed;
  } catch {
    return null;
  }
}

function savePersisted(result: ScanResult): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(result)); } catch { /* quota / private mode — ignore */ }
}

export default function ToolsPage() {
  useEffect(() => { document.title = 'VictoryLabs — Tools'; }, []);
  const [busy, setBusy]         = useState(false);
  // result is hydrated from localStorage on first mount so the table
  // is populated immediately on navigation back to /tools without
  // requiring a fresh scan.
  const [result, setResult]     = useState<ScanResult | null>(null);
  useEffect(() => { setResult(loadPersisted()); }, []);
  const [error, setError]       = useState<string | null>(null);
  const [minOffer, setMinOffer] = useState<string>('');
  // Default sort: highest BEST OFFER first; tie-break highest SPREAD.
  const [sortKey, setSortKey]   = useState<SortKey>('offer');
  const [sortDir, setSortDir]   = useState<SortDir>('desc');

  const sortedRows = useMemo(() => {
    if (!result) return [] as ScanRow[];
    const arr = [...result.withOffers];
    const dir = sortDir === 'asc' ? 1 : -1;
    arr.sort((a, b) => {
      let va: number | string;
      let vb: number | string;
      switch (sortKey) {
        case 'nft':
          va = (a.nftName ?? a.mint).toLowerCase();
          vb = (b.nftName ?? b.mint).toLowerCase();
          if (va < vb) return -1 * dir;
          if (va > vb) return  1 * dir;
          return 0;
        case 'listing': va = a.listingPrice;   vb = b.listingPrice;   break;
        case 'offer':   va = a.bestOfferPrice; vb = b.bestOfferPrice; break;
        case 'spread':  va = a.spreadSol;      vb = b.spreadSol;      break;
        case 'age':
          // Newer first when desc; "—" (null createdAt) sinks to the
          // bottom regardless of dir so unknown-age rows don't pollute
          // the visible top.
          va = a.bestOfferCreatedAt ?? -Infinity;
          vb = b.bestOfferCreatedAt ?? -Infinity;
          break;
      }
      const primary = (va as number) - (vb as number);
      if (primary !== 0) return primary * dir;
      // Stable tie-break by spread desc to match the spec's default.
      return b.spreadSol - a.spreadSol;
    });
    return arr;
  }, [result, sortKey, sortDir]);

  const onHeaderClick = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      // First click on a numeric column: descending feels right
      // (largest first); on the alphabetic NFT column: ascending.
      setSortDir(key === 'nft' ? 'asc' : 'desc');
    }
  };
  const sortArrow = (key: SortKey) => sortKey === key ? (sortDir === 'asc' ? '↑' : '↓') : '';

  const runScan = async () => {
    if (busy) return;
    // Capture old offer IDs BEFORE issuing the request so the diff is
    // computed against what was visible when the user clicked Scan.
    // `result` is left in place during the fetch so the table stays
    // visible while busy=true (incremental refresh, not flash-clear).
    const prevIds = new Set<string>(
      (result?.withOffers ?? [])
        .map(r => r.bestOfferId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    );
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {};
      const min = parseFloat(minOffer);
      if (Number.isFinite(min) && min > 0) body.minOfferSol = min;
      const r = await fetch(`${API_BASE}/api/tools/retardio-me-offer-scan`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status}${txt ? ` — ${txt.slice(0, 80)}` : ''}`);
      }
      const data = await r.json() as ScanResult;
      // Mark rows whose bestOfferId wasn't in the previous scan as NEW.
      // Skip the first scan (empty prevIds) so we don't paint everything
      // NEW on first visit.
      const isFirstScan = prevIds.size === 0;
      const merged: ScanResult = {
        ...data,
        withOffers: data.withOffers.map(row => ({
          ...row,
          isNew: !isFirstScan && !prevIds.has(row.bestOfferId),
        })),
      };
      setResult(merged);
      savePersisted(merged);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="feed-root" data-page="tools">
      <TopNav active="tools" />

      {/* Header */}
      <div style={{ padding: '20px 4px 14px', flexShrink: 0, width: '100%', maxWidth: 1100, margin: '0 auto', boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: '#e8e6f2', letterSpacing: '-0.5px' }}>
              Retardio · Magic Eden personal offers
            </h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
              <LiveDot />
              <span style={{ fontSize: 11, color: '#7a7a94' }}>
                Manual scan · ~5–10 s · cached for 45 s
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="number"
              step="0.01"
              min="0"
              value={minOffer}
              onChange={(e) => setMinOffer(e.target.value)}
              placeholder="min offer (SOL)"
              style={{
                width: 140, padding: '6px 10px', fontSize: 12,
                borderRadius: 4, border: '1px solid rgba(168,144,232,0.28)',
                background: 'rgba(20,14,34,0.5)', color: '#e8e6f2', outline: 'none',
              }}
              disabled={busy}
            />
            <button
              type="button"
              onClick={runScan}
              disabled={busy}
              style={{
                padding: '7px 16px', fontSize: 12, fontWeight: 700,
                letterSpacing: '0.5px', textTransform: 'uppercase',
                borderRadius: 5, cursor: busy ? 'wait' : 'pointer',
                border: '1px solid rgba(168,144,232,0.55)',
                background: busy ? 'rgba(128,104,216,0.15)' : 'linear-gradient(180deg, rgba(128,104,216,0.28) 0%, rgba(128,104,216,0.14) 100%)',
                color: busy ? '#7a7a94' : '#d4d4e8',
                boxShadow: busy ? 'none' : '0 0 12px rgba(128,104,216,0.18)',
                transition: 'all 0.15s',
              }}
            >
              {busy ? 'Scanning…' : 'Scan ME Offers'}
            </button>
          </div>
        </div>
        {error && (
          <div style={{
            marginTop: 12, padding: '8px 12px', fontSize: 12, color: '#ef7878',
            background: 'rgba(239,120,120,0.08)', border: '1px solid rgba(239,120,120,0.32)',
            borderRadius: 5,
          }}>
            scan failed — {error}
          </div>
        )}
        {result && !error && (
          <div style={{ marginTop: 12, fontSize: 11, color: '#7a7a94' }}>
            slug=<span style={{ color: '#a890e8', fontFamily: "'SF Mono','Fira Code',monospace" }}>{result.slug}</span>
            {' · '}scanned <span style={{ color: '#d4d4e8' }}>{result.scanned}</span> / {result.listedTotal} listings
            {' · '}offers <span style={{ color: '#5ce0a0' }}>{result.offersActive}</span> active / {result.offersFetched} fetched
            {' · '}<span style={{ color: '#5ce0a0' }}>{result.withOffers.length}</span> with active offers
            {result.fromCache && <span style={{ color: '#c9a820' }}> · cached</span>}
          </div>
        )}
      </div>

      {/* Results card */}
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0,
        width: '100%', maxWidth: 1100, margin: '0 auto',
        background: 'linear-gradient(180deg, #201a3a 0%, #1a1530 100%)',
        border: '1px solid rgba(168,144,232,0.65)',
        borderRadius: 12,
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4), 0 0 28px rgba(128,104,216,0.15)',
        overflow: 'hidden', marginBottom: 16,
      }}>
        <div style={{ flex: 1, overflowY: 'auto' }} className="scroll-area">
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <thead>
              <tr style={{ position: 'sticky', top: 0, zIndex: 1, background: 'rgba(28,22,50,0.95)' }}>
                <th style={{ ...thStyle,    cursor: 'pointer' }} onClick={() => onHeaderClick('nft')}>
                  NFT {sortArrow('nft')     && <span style={{ color: '#8068d8' }}>{sortArrow('nft')}</span>}
                </th>
                <th style={{ ...thStyleNum, cursor: 'pointer' }} onClick={() => onHeaderClick('listing')}>
                  LISTING {sortArrow('listing') && <span style={{ color: '#8068d8' }}>{sortArrow('listing')}</span>}
                </th>
                <th style={{ ...thStyleNum, cursor: 'pointer' }} onClick={() => onHeaderClick('offer')}>
                  BEST OFFER {sortArrow('offer') && <span style={{ color: '#8068d8' }}>{sortArrow('offer')}</span>}
                </th>
                <th style={{ ...thStyleNum, cursor: 'pointer' }} onClick={() => onHeaderClick('spread')}>
                  SPREAD {sortArrow('spread') && <span style={{ color: '#8068d8' }}>{sortArrow('spread')}</span>}
                </th>
                <th style={{ ...thStyleNum, cursor: 'pointer' }} onClick={() => onHeaderClick('age')}>
                  AGE {sortArrow('age') && <span style={{ color: '#8068d8' }}>{sortArrow('age')}</span>}
                </th>
                <th style={thStyleSmall}>LINKS</th>
              </tr>
            </thead>
            <tbody>
              {!result && !busy && (
                <tr><td colSpan={6} style={emptyCell}>
                  Click <span style={{ color: '#a890e8', fontWeight: 600 }}>Scan ME Offers</span> to fetch active Retardio listings and their personal offers from Magic Eden.
                </td></tr>
              )}
              {busy && (
                <tr><td colSpan={6} style={emptyCell}>
                  Scanning… fetching listings + offers from Magic Eden.
                </td></tr>
              )}
              {result && sortedRows.length === 0 && !busy && (
                <tr><td colSpan={6} style={emptyCell}>
                  No active Retardio listings have personal offers right now.
                </td></tr>
              )}
              {sortedRows.map((row) => {
                const name = row.nftName ?? row.mint.slice(0, 6);
                const abbr = (name[0] ?? '?').toUpperCase() + (name[1] ?? '').toUpperCase();
                const positiveSpread = row.spreadSol > 0;
                return (
                  <tr key={row.mint} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    <td style={{ padding: '10px 8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        {/* Thumbnail wrapper carries `position: relative`
                            so the NEW pill can corner-anchor over the
                            top-right of the icon without affecting flex
                            layout. Pointer-events:none on the badge so
                            future click handlers on the icon still work. */}
                        <div style={{ position: 'relative', flexShrink: 0, width: 32, height: 32 }}>
                          <CollectionIcon imageUrl={compressImage(row.imageUrl ?? null)} color="#8068d8" abbr={abbr} size={32} />
                          {row.isNew && (
                            <span style={{
                              position: 'absolute', top: -4, right: -4,
                              padding: '1px 5px', fontSize: 8, fontWeight: 800,
                              letterSpacing: '0.4px', textTransform: 'uppercase',
                              borderRadius: 3, lineHeight: 1.1,
                              border: '1px solid rgba(168,144,232,0.7)',
                              background: 'linear-gradient(180deg, rgba(168,144,232,0.95) 0%, rgba(128,104,216,0.95) 100%)',
                              color: '#0e0b22',
                              boxShadow: '0 0 0 1px rgba(20,14,34,0.7), 0 1px 4px rgba(0,0,0,0.5)',
                              pointerEvents: 'none', userSelect: 'none',
                            }}>NEW</span>
                          )}
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600, color: '#f0eef8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
                          <div style={{ fontSize: 10, color: '#56566e', fontFamily: "'SF Mono','Fira Code',monospace" }}>{shortAddr(row.mint)}</div>
                        </div>
                      </div>
                    </td>
                    <td style={tdStyleNum}>{formatSol(row.listingPrice)}</td>
                    <td style={{ ...tdStyleNum, color: '#5ce0a0' }}>{formatSol(row.bestOfferPrice)}</td>
                    <td style={{ ...tdStyleNum, color: positiveSpread ? '#5ce0a0' : '#ef7878', fontWeight: 700 }}>
                      {positiveSpread ? '+' : ''}{formatSol(Math.abs(row.spreadSol))}
                    </td>
                    <td style={{ ...tdStyleNum, color: '#aaaabf', fontWeight: 500 }}>
                      {fmtAge(row.bestOfferCreatedAt)}
                    </td>
                    <td style={tdStyleSmall}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <a href={row.meUrl} target="_blank" rel="noopener noreferrer" style={linkChipStyle('#e87ab0')}>ME</a>
                        <a href={row.tensorUrl} target="_blank" rel="noopener noreferrer" style={linkChipStyle('#a890e8')}>T</a>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
      <BottomStatusBar />
    </div>
  );
}

const thStyle: React.CSSProperties = {
  padding: '10px 8px', fontSize: 9.5, fontWeight: 700,
  color: '#56566e', letterSpacing: '0.6px', textAlign: 'left',
  background: 'rgba(28,22,50,0.95)', borderBottom: '1px solid rgba(168,144,232,0.12)',
  textTransform: 'uppercase', userSelect: 'none',
};
const thStyleNum: React.CSSProperties = { ...thStyle, textAlign: 'right' };
const thStyleSmall: React.CSSProperties = { ...thStyle, textAlign: 'left', fontSize: 9.5 };
const tdStyleNum: React.CSSProperties = {
  padding: '10px 8px', textAlign: 'right', fontSize: 13, fontWeight: 600,
  color: '#f0eef8', fontFamily: "'SF Mono','Fira Code',monospace",
};
const tdStyleSmall: React.CSSProperties = {
  padding: '10px 8px', fontSize: 11, color: '#aaaabf', fontFamily: "'SF Mono','Fira Code',monospace",
};
const emptyCell: React.CSSProperties = {
  textAlign: 'center', color: '#55556e', padding: '64px 24px', fontSize: 13, lineHeight: 1.5,
};
function linkChipStyle(color: string): React.CSSProperties {
  return {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 22, height: 22, fontSize: 9.5, fontWeight: 700, letterSpacing: '0.4px',
    borderRadius: 4, textDecoration: 'none', cursor: 'pointer',
    border: `1px solid ${color}48`, background: `${color}1a`, color,
  };
}
