'use client';

// VictoryLabs — Tools › Bid List.
// Static snapshot: forgotten Solanart/SolSea bids sitting on NFTs currently
// held by real, active (<=60d) personal wallets — not marketplace escrows,
// not delegated/locked collateral. Built offline via a full on-chain scan
// (research/solanart-solsea-forgotten-bids/), cross-checked against DAS for
// ownership/lock state and ME for floor price. Not a live scanner — hit
// Refresh only after re-running the offline build.
// Read-only: no wallet connect, no signing, no tx building.
// Data: GET /api/tools/bid-list (requireAuth)
//
// Readability pass (this file only — no data/logic changes): row height,
// column alignment/widths, typography hierarchy (Bid/Spread primary,
// Collection/Floor/Market secondary, Owner/LastTx/Escrow tertiary), and a
// de-purpled neutral-dark table surface (purple reserved for active
// controls/sort, not the row background) — see PANEL/TH overrides below,
// scoped locally so mmm-shared.tsx (used by other tool pages) is untouched.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { LiveDot } from '@/soloist/shared';
import { VL, VLText, rgb, alpha } from '@/lib/palette';
import { API_BASE, MONO, PANEL, TH, CopyKey, short } from '@/app/tools/mmm-shared';
import { authHeaders } from '@/runtime/auth';

interface BidRow {
  mint: string;
  name: string | null;
  image: string | null;
  collectionSymbol: string | null;
  collectionName: string | null;
  priceSol: number;
  marketplace: 'solsea' | 'solanart';
  owner: string;
  escrow: string;
  lastActive: number | null;
  floorSol: number | null;
  spreadSol: number | null;
}
interface ApiResult {
  ok: true;
  builtAt: number;
  count: number;
  rows: BidRow[];
}

type SortCol = 'price' | 'spread' | 'lastActive' | 'collection';

const MARKETPLACE_COLOR: Record<BidRow['marketplace'], string> = {
  solsea: '#4ade80',
  solanart: '#60a5fa',
};

function fmtSol(sol: number | null | undefined): string {
  if (sol == null) return '—';
  return sol.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}
function fmtAgo(unixSec: number | null): string {
  if (!unixSec) return '—';
  const days = Math.floor((Date.now() / 1000 - unixSec) / 86400);
  if (days <= 0) return 'today';
  if (days === 1) return '1d ago';
  return `${days}d ago`;
}

// ── Local, page-scoped style overrides ──────────────────────────────────────
// De-purpled table surface: PANEL's own fill is already the neutral
// --vl-gray-surface token (not purple) — only its border + glow read as
// purple, so those are the only two properties overridden here.
const TABLE_PANEL: React.CSSProperties = {
  ...PANEL,
  padding: 0,
  overflow: 'hidden',
  border: '1px solid rgba(255,255,255,0.08)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04), 0 16px 40px rgba(0,0,0,0.55)',
};
// Sticky, higher-contrast header — spreads the shared TH label style
// (uppercase/10px/letterspacing, used consistently across every tool page)
// and only raises its text contrast + pins it while the page scrolls.
const THEAD_TH: React.CSSProperties = {
  ...TH, color: '#9089ab', position: 'sticky', top: 0, zIndex: 2,
  background: 'rgba(13,10,22,0.98)', borderBottom: '1px solid rgba(255,255,255,0.10)',
};
const ROW_H = { padding: '13px 10px' };

export default function BidListPage() {
  useEffect(() => { document.title = 'Bid List | VictoryLabs'; }, []);

  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ApiResult | null>(null);
  const [search, setSearch] = useState('');
  const [marketplaceFilter, setMarketplaceFilter] = useState<'all' | 'solsea' | 'solanart'>('all');
  const [sortCol, setSortCol] = useState<SortCol>('price');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const load = useCallback(() => {
    setBusy(true);
    setError(null);
    fetch(`${API_BASE}/api/tools/bid-list`, { headers: authHeaders() })
      .then(r => r.json())
      .then((data: ApiResult | { ok: false; error: string }) => {
        if (!data.ok) { setError(data.error); return; }
        setResult(data);
      })
      .catch(e => setError(String(e)))
      .finally(() => setBusy(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const toggleSort = (col: SortCol) => {
    if (sortCol === col) { setSortDir(d => d === 'asc' ? 'desc' : 'asc'); }
    else { setSortCol(col); setSortDir('desc'); }
  };
  // Sort header: active column gets a brighter, purple-accented label +
  // a clearly-spaced arrow (was a barely-visible glyph glued to the text) —
  // purple is reserved for this "active control" state, not row content.
  const sortHeader = (col: SortCol, label: string, align: 'left' | 'right' | 'center' = 'right') => {
    const active = sortCol === col;
    return (
      <th
        onClick={() => toggleSort(col)}
        style={{ ...THEAD_TH, textAlign: align, cursor: 'pointer', userSelect: 'none' as const,
          color: active ? rgb(VL.purpleTint) : THEAD_TH.color }}
      >
        {label}
        <span style={{ display: 'inline-block', marginLeft: 5, opacity: active ? 1 : 0.25, fontSize: 9 }}>
          {active ? (sortDir === 'asc' ? '▲' : '▼') : '▼'}
        </span>
      </th>
    );
  };

  const visibleRows = useMemo(() => {
    if (!result) return [];
    const q = search.trim().toLowerCase();
    let rows = result.rows.filter(r => {
      if (marketplaceFilter !== 'all' && r.marketplace !== marketplaceFilter) return false;
      if (q) {
        const hay = `${r.name ?? ''} ${r.collectionName ?? ''} ${r.mint} ${r.owner}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    rows = [...rows].sort((a, b) => {
      let av: number | string, bv: number | string;
      switch (sortCol) {
        case 'spread':     av = a.spreadSol ?? -1;      bv = b.spreadSol ?? -1;      break;
        case 'lastActive': av = a.lastActive ?? 0;       bv = b.lastActive ?? 0;       break;
        case 'collection': av = (a.collectionName ?? '').toLowerCase(); bv = (b.collectionName ?? '').toLowerCase(); break;
        default:            av = a.priceSol;              bv = b.priceSol;
      }
      if (typeof av === 'string' || typeof bv === 'string') {
        const cmp = String(av).localeCompare(String(bv));
        return sortDir === 'asc' ? cmp : -cmp;
      }
      return sortDir === 'asc' ? av - bv : bv - av;
    });
    return rows;
  }, [result, search, marketplaceFilter, sortCol, sortDir]);

  return (
    <div className="feed-root page-transition" data-page="tools">
      <div className="scroll-area" style={{ flex: 1, minHeight: 0, overflowY: 'auto', width: '100%', paddingBottom: 72 }}>
      <div style={{ width: '100%', maxWidth: 'var(--tools-max, 1280px)', margin: '0 auto', boxSizing: 'border-box', padding: '20px 4px 14px' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--vl-text-primary)', letterSpacing: '-0.5px' }}>
          BID LIST
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 11, color: 'var(--vl-text-muted)', flexWrap: 'wrap' }}>
          <LiveDot />
          <span>read-only · static snapshot · forgotten Solanart/SolSea bids on NFTs held by real active (≤60d) wallets — marketplace escrows, delegated/locked collateral, and stale bids already filtered out</span>
        </div>

        {/* ── Controls ─────────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0, marginTop: 16, marginBottom: 12 }}>
          {result && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1, marginRight: 16, flexShrink: 0 }}>
              <span style={{ fontSize: 26, fontWeight: 800, color: rgb(VL.gold), ...MONO, letterSpacing: '-1px', lineHeight: 1 }}>
                {result.count}
              </span>
              <span style={{ fontSize: 8, color: alpha(VL.gold, 0.50), textTransform: 'uppercase', letterSpacing: '1.2px', fontWeight: 700, marginTop: 3 }}>
                live targets
              </span>
            </div>
          )}

          {result && (
            <div style={{ width: 1, height: 28, background: 'rgba(255,255,255,0.10)', margin: '0 14px', flexShrink: 0 }} />
          )}

          {/* Marketplace filter — one segmented control, active state is the
              intentional purple accent (spec: purple reserved for controls). */}
          <div style={{ display: 'inline-flex', border: `1px solid ${alpha(VL.purpleTint, 0.22)}`, borderRadius: 6, overflow: 'hidden', flexShrink: 0 }}>
            {(['all', 'solsea', 'solanart'] as const).map((m, i) => (
              <button key={m} type="button" onClick={() => setMarketplaceFilter(m)}
                style={{
                  padding: '7px 12px', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.4px',
                  border: 'none', borderLeft: i > 0 ? `1px solid ${alpha(VL.purpleTint, 0.22)}` : 'none',
                  cursor: 'pointer',
                  background: marketplaceFilter === m ? alpha(VL.purpleTint, 0.20) : 'transparent',
                  color: marketplaceFilter === m ? rgb(VL.purpleTint) : VLText.muted,
                }}>
                {m}
              </button>
            ))}
          </div>

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by collection, NFT, owner…"
              spellCheck={false}
              style={{
                width: 220, padding: '6px 10px', fontSize: 11.5, ...MONO, borderRadius: 5,
                border: '1px solid rgb(var(--vl-purple-tint) / 0.35)', background: 'rgba(20,14,34,0.85)',
                color: 'var(--vl-text-primary)', outline: 'none',
              }}
            />
            {/* Reload is deliberately the quietest control on the page —
                filtering/sorting is the primary interaction, not refetching. */}
            <button type="button" onClick={load} disabled={busy}
              style={{
                padding: '6px 9px', fontSize: 10.5, fontWeight: 500, borderRadius: 5,
                border: '1px solid rgba(255,255,255,0.10)', background: 'transparent',
                color: VLText.faint, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1,
              }}>
              {busy ? '…' : '↺ reload'}
            </button>
          </div>
        </div>

        {error && (
          <div style={{
            marginBottom: 12, padding: '8px 12px', fontSize: 12, color: 'var(--vl-red-primary)',
            background: 'rgb(var(--vl-red-glow) / 0.08)', border: '1px solid rgb(var(--vl-red-glow) / 0.32)', borderRadius: 5,
          }}>
            {error}
          </div>
        )}

        {/* ── Results table ────────────────────────────────────────────────── */}
        {result && (
          <div style={TABLE_PANEL}>
            {visibleRows.length === 0 ? (
              <div style={{ padding: '32px 16px', textAlign: 'center', fontSize: 12, color: 'var(--vl-text-muted)' }}>
                No rows match the current filter.
              </div>
            ) : (
              <div style={{ overflowX: 'auto', maxHeight: '78vh', overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, tableLayout: 'fixed', minWidth: 1030 }}>
                  <colgroup>
                    <col style={{ width: 200 }} />
                    <col style={{ width: 125 }} />
                    <col style={{ width: 65 }} />
                    <col style={{ width: 90 }} />
                    <col style={{ width: 80 }} />
                    <col style={{ width: 105 }} />
                    <col style={{ width: 120 }} />
                    <col style={{ width: 65 }} />
                    <col style={{ width: 105 }} />
                    <col style={{ width: 55 }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th style={{ ...THEAD_TH, textAlign: 'left' }}>NFT</th>
                      {sortHeader('collection', 'COLLECTION', 'left')}
                      <th style={{ ...THEAD_TH, textAlign: 'center' }}>MARKET</th>
                      {sortHeader('price', 'BID (SOL)', 'right')}
                      <th style={{ ...THEAD_TH, textAlign: 'right' }}>FLOOR (SOL)</th>
                      {sortHeader('spread', 'SPREAD (SOL)', 'right')}
                      <th style={{ ...THEAD_TH, textAlign: 'left' }}>OWNER</th>
                      {sortHeader('lastActive', 'LAST TX', 'right')}
                      <th style={{ ...THEAD_TH, textAlign: 'left' }}>ESCROW</th>
                      <th style={{ ...THEAD_TH, textAlign: 'center' }}>LINK</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((r, i) => {
                      const daysAgo = r.lastActive ? Math.floor((Date.now() / 1000 - r.lastActive) / 86400) : null;
                      const recentlyActive = daysAgo != null && daysAgo <= 3;
                      return (
                      <tr key={`${r.marketplace}-${r.escrow}`}
                        style={{
                          background: i % 2 === 1 ? 'rgba(255,255,255,0.016)' : 'transparent',
                          borderBottom: '1px solid rgba(255,255,255,0.045)',
                        }}
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.055)'; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = i % 2 === 1 ? 'rgba(255,255,255,0.016)' : 'transparent'; }}>
                        {/* NFT — row anchor: avatar + high-contrast name, left-aligned */}
                        <td style={{ ...ROW_H, display: 'flex', alignItems: 'center', gap: 10 }}>
                          {r.image ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={r.image} alt="" width={32} height={32} draggable={false}
                              style={{ borderRadius: 6, objectFit: 'cover', flexShrink: 0, background: 'rgba(255,255,255,0.05)' }}
                              onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }} />
                          ) : (
                            <div style={{ width: 32, height: 32, borderRadius: 6, background: 'rgba(255,255,255,0.05)', flexShrink: 0 }} />
                          )}
                          <span style={{ fontSize: 12.5, color: 'var(--vl-text-primary)', fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                            title={r.name ?? r.mint}>
                            {r.name ?? short(r.mint)}
                          </span>
                        </td>
                        {/* Collection — secondary, muted, single-line */}
                        <td style={{ ...ROW_H, textAlign: 'left', fontSize: 11.5, color: 'var(--vl-text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          title={r.collectionName ?? ''}>
                          {r.collectionName ?? <span style={{ opacity: 0.45 }}>—</span>}
                        </td>
                        {/* Market — compact badge, Solanart blue / SolSea green stay immediately distinguishable */}
                        <td style={{ ...ROW_H, textAlign: 'center' }}>
                          <span style={{ display: 'inline-block', padding: '3px 7px', borderRadius: 4,
                            border: `1px solid ${MARKETPLACE_COLOR[r.marketplace]}66`, background: `${MARKETPLACE_COLOR[r.marketplace]}14`,
                            color: MARKETPLACE_COLOR[r.marketplace], fontSize: 9.5, fontWeight: 700, letterSpacing: '0.4px',
                            textTransform: 'uppercase', whiteSpace: 'nowrap' }}>
                            {r.marketplace}
                          </span>
                        </td>
                        {/* Bid — PRIMARY: strongest numeral in the row */}
                        <td style={{ ...ROW_H, textAlign: 'right', ...MONO, fontVariantNumeric: 'tabular-nums', fontSize: 14, fontWeight: 800, color: 'var(--vl-text-primary)' }}>
                          {fmtSol(r.priceSol)}
                        </td>
                        {/* Floor — secondary to Bid: smaller, lighter, muted */}
                        <td style={{ ...ROW_H, textAlign: 'right', ...MONO, fontVariantNumeric: 'tabular-nums', fontSize: 12, fontWeight: 500, color: 'var(--vl-text-muted)' }}>
                          {fmtSol(r.floorSol)}
                        </td>
                        {/* Spread — PRIMARY: fastest opportunity signal, sign always shown, color never the only cue */}
                        <td style={{ ...ROW_H, textAlign: 'right', ...MONO, fontVariantNumeric: 'tabular-nums', fontSize: 13.5, fontWeight: 800,
                          color: r.spreadSol == null ? 'var(--vl-text-muted)' : r.spreadSol > 0 ? '#facc15' : 'var(--vl-red-primary)' }}>
                          {r.spreadSol == null ? '—' : `${r.spreadSol > 0 ? '+' : ''}${fmtSol(r.spreadSol)}`}
                        </td>
                        {/* Owner — tertiary/supporting evidence: quiet monospace, no purple tint */}
                        <td style={{ ...ROW_H, textAlign: 'left' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <CopyKey value={r.owner} label={short(r.owner)} color={VLText.faint} />
                            <a href={`https://magiceden.io/u/${r.owner}`} target="_blank" rel="noopener noreferrer"
                              title="ME profile" style={{ display: 'inline-flex', lineHeight: 0, flexShrink: 0 }}>
                              {/* eslint-disable-next-line @next/next/no-img-element */}
                              <img src="/brand/me.png" alt="ME" width={13} height={13} draggable={false} style={{ display: 'block', objectFit: 'cover', pointerEvents: 'none', opacity: 0.6 }} />
                            </a>
                          </div>
                        </td>
                        {/* Last Tx — wallet-activity signal, concise relative time, mild contrast bump when very recent */}
                        <td style={{ ...ROW_H, textAlign: 'right', fontSize: 11, ...MONO,
                          color: recentlyActive ? '#a79eca' : VLText.faint }}>
                          {fmtAgo(r.lastActive)}
                        </td>
                        {/* Escrow — technical evidence, quietest text on the row */}
                        <td style={{ ...ROW_H, textAlign: 'left' }}>
                          <CopyKey value={r.escrow} label={short(r.escrow)} color={VLText.faint} />
                        </td>
                        <td style={{ ...ROW_H, textAlign: 'center' }}>
                          <a href={`https://magiceden.io/item-details/${r.mint}`} target="_blank" rel="noopener noreferrer"
                            style={{ color: '#c4b8e8', textDecoration: 'none', fontSize: 11 }}>
                            ME →
                          </a>
                        </td>
                      </tr>
                    );})}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {!result && !busy && !error && (
          <div style={{ ...PANEL, padding: '32px 16px', textAlign: 'center', fontSize: 12, color: 'var(--vl-text-muted)' }}>
            No data.
          </div>
        )}

        <div style={{ fontSize: 10.5, color: '#6e6688', marginTop: 6 }}>
          Read-only: no wallet connect, no signing, no tx sent. SPREAD = BID − FLOOR (positive = the forgotten bid pays more than it costs to buy the cheapest current listing in that collection right now; NFTs here are held privately, not for sale — SPREAD is a rough collection-level reference, not a live price on this exact item). Static snapshot — re-run the offline scan to refresh.
        </div>
      </div>
      </div>
    </div>
  );
}
