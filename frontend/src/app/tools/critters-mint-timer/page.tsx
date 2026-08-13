'use client';

// VictoryLabs — Tools › Critters Mint Timer.
// Read-only countdown list of upcoming cheap NFT "edition" mints from
// critters.quest/edition-mint. No wallet, no signing, no mint-transaction
// requests — the actual sniper bot lives in a separate project on a
// different VPS. This page only reads the public catalog (proxied through
// our own backend, see tools-critters-mint-timer.ts).
// Data: GET /api/tools/critters-mint-timer?maxPrice= (requireAuth)

import { useCallback, useEffect, useMemo, useState } from 'react';
import { LiveDot } from '@/soloist/shared';
import { VL, VLText, rgb, alpha } from '@/lib/palette';
import { API_BASE, MONO, PANEL, TH, short } from '@/app/tools/mmm-shared';
import { authHeaders } from '@/runtime/auth';

interface EditionRow {
  mint: string;
  name: string;
  mintStartDate: number;
  priceSol: number;
  supply: number;
  remaining: number;
  editionMintActive: boolean;
}
interface ApiResult {
  ok: true;
  fetchedAt: number;
  ageMs: number | null;
  maxPrice: number;
  count: number;
  rows: EditionRow[];
  warning?: string;
}

const DEFAULT_MAX_PRICE = 0.16;
// Matches the backend's own float32-noise tolerance (tools-critters-mint-timer.ts)
// — used here only for the "cheap + soon" row highlight, not for filtering
// (filtering already happened server-side).
const PRICE_EPSILON = 0.001;

function fmtCountdown(startMs: number, nowMs: number): string {
  const diff = startMs - nowMs;
  if (diff <= 0) return 'starting…';
  const s = Math.floor(diff / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function fmtUtc(ms: number): string {
  // "18:41 UTC" — time only, no date/seconds. Fixed to UTC regardless of
  // the viewer's local timezone, so a start time is unambiguous.
  const iso = new Date(ms).toISOString(); // "2026-08-13T18:41:30.000Z"
  return `${iso.slice(11, 16)} UTC`;
}

// ── Usability-pass tiers ─────────────────────────────────────────────────
// PRICE: a distinct hue (cool cyan→blue) from REMAINING's green and STARTS
// IN's amber, so "cheap" reads as its own signal. Fixed absolute
// thresholds, not relative to the current max-price filter — "cheap"
// should mean the same thing regardless of what the box is set to. Cheaper
// = stronger (same "more important = more prominent" logic as urgency).
function priceTierStyle(priceSol: number): React.CSSProperties {
  if (priceSol <= 0.05) return { color: '#22d3ee', fontWeight: 800, fontSize: 15.5 };
  if (priceSol <= 0.08) return { color: '#38bdf8', fontWeight: 800, fontSize: 15 };
  if (priceSol <= 0.10) return { color: '#7dd3fc', fontWeight: 700, fontSize: 14 };
  return { color: 'var(--vl-text-primary)', fontWeight: 700, fontSize: 14 };
}
// STARTS IN: four urgency tiers. <15min breaks from the gold family into
// red/orange — this is the one signal that should visually interrupt a
// scan, everything else stays within amber so it reads as "same thing,
// more/less urgent" rather than a status change. No animation/flashing —
// urgency is conveyed by color + weight + size only.
function countdownTierStyle(startMs: number, nowMs: number): React.CSSProperties {
  const diffMin = (startMs - nowMs) / 60_000;
  if (diffMin < 15) return { color: '#f97316', fontWeight: 800, fontSize: 15.5 };
  if (diffMin < 60) return { color: '#fbbf24', fontWeight: 800, fontSize: 14.5 };
  if (diffMin < 180) return { color: '#facc15', fontWeight: 700, fontSize: 13.5 };
  return { color: alpha(VL.gold, 0.55), fontWeight: 600, fontSize: 12.5 };
}

const THEAD_TH: React.CSSProperties = { ...TH, color: '#ada5c9', background: 'rgba(13,10,22,0.98)', borderBottom: '1px solid rgba(255,255,255,0.14)' };
const ROW_H = { padding: '11px 10px' };

// 'time' backs BOTH the STARTS IN and START (UTC) headers — they order the
// same underlying `mintStartDate`, so clicking either sorts by it and both
// headers light up together rather than tracking two redundant sort states.
type SortCol = 'price' | 'time' | 'remaining';

export default function CrittersMintTimerPage() {
  useEffect(() => { document.title = 'Critters Mint Timer | VictoryLabs'; }, []);

  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ApiResult | null>(null);
  const [maxPriceInput, setMaxPriceInput] = useState(String(DEFAULT_MAX_PRICE));
  // The threshold actually in effect — separate from the raw text input so
  // the background auto-refresh below re-fetches with the last *applied*
  // value, not whatever's mid-typing in the box.
  const [appliedMaxPrice, setAppliedMaxPrice] = useState(DEFAULT_MAX_PRICE);
  const [now, setNow] = useState(() => Date.now());
  // null = default behavior (ascending by mintStartDate, unchanged from
  // before this pass). Explicit sort survives background refresh since it
  // lives here, not derived from `result`.
  const [sortCol, setSortCol] = useState<SortCol | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const load = useCallback((maxPrice: number, opts?: { background?: boolean }) => {
    if (!opts?.background) setBusy(true);
    setError(null);
    fetch(`${API_BASE}/api/tools/critters-mint-timer?maxPrice=${encodeURIComponent(maxPrice)}`, { headers: authHeaders() })
      .then(r => r.json())
      .then((data: ApiResult | { ok: false; error: string }) => {
        if (!data.ok) { setError(data.error); return; }
        setResult(data);
      })
      .catch(e => setError(String(e)))
      .finally(() => { if (!opts?.background) setBusy(false); });
  }, []);

  useEffect(() => {
    load(DEFAULT_MAX_PRICE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Background auto-refresh — matches the backend's own ~45s poll cadence,
  // so the page reflects new/closed editions without a manual reload or
  // "apply" click. Uses `background:true` so it doesn't flash the busy
  // spinner or clobber a filter the user is mid-typing.
  useEffect(() => {
    const t = setInterval(() => load(appliedMaxPrice, { background: true }), 45_000);
    return () => clearInterval(t);
  }, [appliedMaxPrice, load]);

  // Live countdown tick — cosmetic only, no refetch.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const visibleRows = useMemo(() => {
    if (!result) return [];
    const rows = [...result.rows];
    if (sortCol === null) {
      rows.sort((a, b) => a.mintStartDate - b.mintStartDate); // preserved default
      return rows;
    }
    const dir = sortDir === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      const av = sortCol === 'price' ? a.priceSol : sortCol === 'remaining' ? a.remaining : a.mintStartDate;
      const bv = sortCol === 'price' ? b.priceSol : sortCol === 'remaining' ? b.remaining : b.mintStartDate;
      return (av - bv) * dir;
    });
    return rows;
  }, [result, sortCol, sortDir]);

  const toggleSort = (col: SortCol) => {
    if (sortCol === col) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'));
    else { setSortCol(col); setSortDir('asc'); }
  };
  // Same convention as /mints' sortArrow — nothing rendered on inactive
  // headers (not even a dimmed placeholder), a small purple ↑/↓ only next
  // to the active sort column.
  const sortArrow = (col: SortCol) => {
    if (sortCol !== col) return null;
    return <span style={{ color: rgb(VL.purpleTint), marginLeft: 4 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>;
  };
  const sortableThStyle: React.CSSProperties = { ...THEAD_TH, textAlign: 'right', cursor: 'pointer', userSelect: 'none' };

  const applyFilter = () => {
    const p = Number(maxPriceInput);
    const valid = Number.isFinite(p) && p >= 0 ? p : DEFAULT_MAX_PRICE;
    setAppliedMaxPrice(valid);
    load(valid);
  };

  return (
    <div className="feed-root page-transition" data-page="tools">
      <div className="scroll-area" style={{ flex: 1, minHeight: 0, overflowY: 'auto', width: '100%', paddingBottom: 72 }}>
      <div style={{ width: '100%', maxWidth: 'var(--tools-max, 1280px)', margin: '0 auto', boxSizing: 'border-box', padding: '20px 4px 14px' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--vl-text-primary)', letterSpacing: '-0.5px' }}>
          CRITTERS MINT TIMER
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 11, color: 'var(--vl-text-muted)', flexWrap: 'wrap' }}>
          <LiveDot />
          <span>read-only · upcoming cheap edition mints from critters.quest, refreshed server-side every ~45s · no wallet, no signing</span>
        </div>

        {/* ── Controls ─────────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12, marginTop: 16, marginBottom: 12 }}>
          {result && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1, flexShrink: 0 }}>
              <span style={{ fontSize: 26, fontWeight: 800, color: rgb(VL.gold), ...MONO, letterSpacing: '-1px', lineHeight: 1 }}>
                {result.count}
              </span>
              <span style={{ fontSize: 8, color: alpha(VL.gold, 0.50), textTransform: 'uppercase', letterSpacing: '1.2px', fontWeight: 700, marginTop: 3 }}>
                upcoming ≤ {result.maxPrice} SOL
              </span>
            </div>
          )}

          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, marginLeft: 'auto', flexWrap: 'wrap' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={{ fontSize: 9.5, color: 'var(--vl-text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', fontWeight: 700 }}>Max price (SOL)</span>
              <input
                type="text"
                value={maxPriceInput}
                onChange={(e) => setMaxPriceInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') applyFilter(); }}
                spellCheck={false}
                style={{
                  width: 100, padding: '6px 10px', fontSize: 11.5, ...MONO, borderRadius: 5,
                  border: '1px solid rgb(var(--vl-purple-tint) / 0.35)', background: 'rgba(20,14,34,0.85)',
                  color: 'var(--vl-text-primary)', outline: 'none',
                }}
              />
            </label>
            <button type="button" onClick={applyFilter} disabled={busy}
              style={{
                padding: '6px 12px', fontSize: 11, fontWeight: 700, borderRadius: 5,
                border: `1px solid ${alpha(VL.purpleTint, 0.28)}`, background: alpha(VL.purpleTint, 0.14),
                color: rgb(VL.purpleTint), cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1,
              }}>
              {busy ? '…' : 'apply'}
            </button>
            {result?.fetchedAt != null && result.fetchedAt > 0 && (
              <span style={{ fontSize: 10.5, color: VLText.faint, ...MONO, alignSelf: 'center' }}>
                data {Math.max(0, Math.floor((now - result.fetchedAt) / 1000))}s old
              </span>
            )}
          </div>
        </div>

        {result?.warning && (
          <div style={{
            marginBottom: 12, padding: '8px 12px', fontSize: 11.5, color: rgb(VL.gold),
            background: alpha(VL.gold, 0.08), border: `1px solid ${alpha(VL.gold, 0.32)}`, borderRadius: 5,
          }}>
            {result.warning}
          </div>
        )}
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
          <div style={{ ...PANEL, padding: 0, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.11)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 16px 40px rgba(0,0,0,0.55)' }}>
            {visibleRows.length === 0 ? (
              <div style={{ padding: '32px 16px', textAlign: 'center', fontSize: 12, color: 'var(--vl-text-muted)' }}>
                No upcoming editions under {result.maxPrice} SOL right now.
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5, tableLayout: 'fixed', minWidth: 1060 }}>
                  <colgroup>
                    <col style={{ width: 260 }} />
                    <col style={{ width: 150 }} />
                    <col style={{ width: 100 }} />
                    <col style={{ width: 100 }} />
                    <col style={{ width: 110 }} />
                    <col style={{ width: 140 }} />
                    <col style={{ width: 160 }} />
                    <col style={{ width: 80 }} />
                  </colgroup>
                  <thead>
                    <tr>
                      <th style={{ ...THEAD_TH, textAlign: 'left' }}>NAME</th>
                      <th style={{ ...THEAD_TH, textAlign: 'left' }}>MINT</th>
                      <th style={sortableThStyle} onClick={() => toggleSort('price')}>PRICE (SOL){sortArrow('price')}</th>
                      <th style={{ ...THEAD_TH, textAlign: 'right' }}>SUPPLY</th>
                      <th style={sortableThStyle} onClick={() => toggleSort('remaining')}>REMAINING{sortArrow('remaining')}</th>
                      <th style={sortableThStyle} onClick={() => toggleSort('time')}>STARTS IN{sortArrow('time')}</th>
                      <th style={sortableThStyle} onClick={() => toggleSort('time')}>START (UTC){sortArrow('time')}</th>
                      <th style={{ ...THEAD_TH, textAlign: 'center' }}>LINK</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((r, i) => {
                      // "Cheap enough + opening soon" — the two FCFS-relevant
                      // conditions at once. Price check is redundant against
                      // current data (the backend already filters to
                      // appliedMaxPrice) but kept explicit/correct in case
                      // that ever changes independently of this check.
                      const isHot = r.priceSol <= appliedMaxPrice + PRICE_EPSILON && (r.mintStartDate - now) < 3_600_000;
                      const altBg = i % 2 === 1 ? 'rgba(255,255,255,0.024)' : 'transparent';
                      return (
                      <tr key={r.mint}
                        style={{
                          background: altBg,
                          borderBottom: '1px solid rgba(255,255,255,0.06)',
                        }}
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,255,255,0.07)'; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = altBg; }}>
                        {/* borderLeft lives on the cell, not <tr> — row-level
                            borders are unreliably rendered across browsers,
                            especially with border-collapse:collapse. */}
                        <td style={{ ...ROW_H, textAlign: 'left', fontSize: 13, color: 'var(--vl-text-primary)', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          borderLeft: isHot ? '3px solid rgba(74,222,128,0.6)' : '3px solid transparent', paddingLeft: 7 }}
                          title={r.name}>
                          {r.name}
                          {!r.editionMintActive && (
                            <span title="Off-chain flag says inactive — may not be reliably mintable" style={{ marginLeft: 6, fontSize: 9, color: 'var(--vl-red-primary)', ...MONO }}>⚠</span>
                          )}
                        </td>
                        <td style={{ ...ROW_H, textAlign: 'left' }}>
                          <a href={`https://solscan.io/account/${r.mint}`} target="_blank" rel="noopener noreferrer"
                            style={{ fontSize: 10.5, ...MONO, color: VLText.muted, textDecoration: 'none', opacity: 0.7, transition: 'opacity 0.12s, color 0.12s' }}
                            onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = 'var(--vl-text-primary)'; (e.currentTarget as HTMLAnchorElement).style.opacity = '1'; }}
                            onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = VLText.muted; (e.currentTarget as HTMLAnchorElement).style.opacity = '0.7'; }}>
                            {short(r.mint)}
                          </a>
                        </td>
                        <td style={{ ...ROW_H, textAlign: 'right', ...MONO, fontVariantNumeric: 'tabular-nums', ...priceTierStyle(r.priceSol) }}>
                          {r.priceSol}
                        </td>
                        <td style={{ ...ROW_H, textAlign: 'right', ...MONO, fontVariantNumeric: 'tabular-nums', color: 'var(--vl-text-muted)' }}>
                          {r.supply}
                        </td>
                        <td style={{ ...ROW_H, textAlign: 'right', ...MONO, fontVariantNumeric: 'tabular-nums', fontWeight: 700,
                          color: r.remaining > 0 ? '#4ade80' : 'var(--vl-text-muted)' }}>
                          {r.remaining}
                        </td>
                        <td style={{ ...ROW_H, textAlign: 'right', ...MONO, fontVariantNumeric: 'tabular-nums', ...countdownTierStyle(r.mintStartDate, now) }}>
                          {fmtCountdown(r.mintStartDate, now)}
                        </td>
                        <td style={{ ...ROW_H, textAlign: 'right', ...MONO, fontVariantNumeric: 'tabular-nums', fontSize: 11, color: VLText.muted }}>
                          {fmtUtc(r.mintStartDate)}
                        </td>
                        <td style={{ ...ROW_H, textAlign: 'center' }}>
                          <a href={`https://critters.quest/edition-mint/${r.mint}`} target="_blank" rel="noopener noreferrer"
                            style={{ color: alpha(VL.purpleTint, 0.9), textDecoration: 'none', fontSize: 11, fontWeight: 700, transition: 'color 0.12s' }}
                            onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = rgb(VL.purpleTint); (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'underline'; }}
                            onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = alpha(VL.purpleTint, 0.9); (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'none'; }}
                            onFocus={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = rgb(VL.purpleTint); (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'underline'; }}
                            onBlur={(e) => { (e.currentTarget as HTMLAnchorElement).style.color = alpha(VL.purpleTint, 0.9); (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'none'; }}>
                            Open →
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
          Read-only: no wallet connect, no signing, no mint requests. ⚠ next to a name means critters.quest&apos;s own <code>editionMintActive</code> flag reports inactive — off-chain flag only, not a hard guarantee either way. Price threshold applied with a small epsilon to absorb the source&apos;s float32 rounding noise.
        </div>
      </div>
      </div>
    </div>
  );
}
