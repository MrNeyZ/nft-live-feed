'use client';

// VictoryLabs — Tools.
// Manual, on-demand scanners. v1: Retardio listings with Magic Eden
// personal offers.

import { useEffect, useMemo, useState } from 'react';
import { TopNav, LiveDot, CollectionIcon, compressImage } from '@/soloist/shared';
import { formatSol } from '@/soloist/mock-data';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

/** Collections the scanner can target. Order here drives the dropdown
 *  order; first entry is the default selection. */
const COLLECTIONS: ReadonlyArray<{ slug: string; label: string }> = [
  { slug: 'retardio_cousins', label: 'Retardio Cousins' },
  { slug: 'nub',              label: 'NUB'              },
  { slug: 'webkidz',          label: 'Webkidz'          },
  { slug: 'trncha',           label: 'Trencher'         },
];

type OfferStatus = 'AVAILABLE' | 'EXPIRED' | 'EXPECTED';

interface ScanRow {
  mint:               string;
  nftName:            string | null;
  imageUrl:           string | null;
  listingPrice:       number;
  bestOfferPrice:     number;
  spreadSol:          number;
  bestOfferId:        string;
  bestOfferStatus:    OfferStatus;
  bestOfferCreatedAt: number | null;     // seconds since epoch
  meUrl:              string;
  tensorUrl:          string;
  /** Frontend-only flag: row's `bestOfferId` was not present in the
   *  previous cached scan. Set at scan-merge time, persisted in
   *  localStorage, cleared on the next scan. */
  isNew?:             boolean;
}

function statusRank(s: OfferStatus): number {
  return s === 'AVAILABLE' ? 0 : s === 'EXPECTED' ? 1 : 2;
}
function statusBadgeStyle(s: OfferStatus): React.CSSProperties {
  // Match site palette: green for active, amber for unclear, dim red
  // for expired. Same opacity tier as the existing FREE/PAID/MIXED
  // badges on /mints.
  if (s === 'AVAILABLE') return { color: '#5ce0a0', background: 'rgba(92,224,160,0.15)',  border: '1px solid rgba(92,224,160,0.45)' };
  if (s === 'EXPECTED')  return { color: '#e8c14a', background: 'rgba(232,193,74,0.15)',  border: '1px solid rgba(232,193,74,0.45)' };
  return { color: '#a07474', background: 'rgba(160,116,116,0.10)', border: '1px solid rgba(160,116,116,0.35)' };
}

type SortKey = 'nft' | 'listing' | 'offer' | 'spread' | 'age' | 'status';
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
  ok:              true;
  slug:            string;
  scanned:         number;
  listedTotal:     number;
  offersFetched:   number;
  offersAvailable: number;
  withOffers:      ScanRow[];
  cachedAt:        number;
  ttlMs:           number;
  fromCache?:      boolean;
  /** Frontend-only: number of rows whose `bestOfferId` was not present
   *  in the previous scan (i.e. count of `isNew=true` rows after merge).
   *  Persisted alongside the rows so the summary line keeps showing
   *  "added N" between page loads until the next scan. Undefined on
   *  the very first scan (no baseline to diff against). */
  addedCount?:     number;
}

function shortAddr(s: string | null): string {
  if (!s) return '—';
  return s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}

/** localStorage key — separate entry per slug so changing collections
 *  loads that collection's cached result instead of clobbering it. */
function storageKey(slug: string): string {
  return `vl.tools.meOfferScan:${slug}`;
}

/** NEW flags auto-expire after this many minutes so a long absence
 *  doesn't leave the ribbon stuck. The next scan also clears them
 *  organically (they'll appear in prevIds), so this is the worst-case
 *  bound — operator never sees a "NEW" badge older than 10 minutes. */
const NEW_FLAG_TTL_MS = 10 * 60_000;

function loadPersisted(slug: string): ScanResult | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(storageKey(slug));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ScanResult;
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

function savePersisted(slug: string, result: ScanResult): void {
  if (typeof window === 'undefined') return;
  try { window.localStorage.setItem(storageKey(slug), JSON.stringify(result)); } catch { /* quota / private mode */ }
}

export default function ToolsPage() {
  useEffect(() => { document.title = 'VictoryLabs — Tools'; }, []);
  const [busy, setBusy]                 = useState(false);
  // 429-driven cooldown. When the backend rate-limits us we soft-warn
  // (keeping any cached rows visible) and disable the Scan button until
  // the timestamp passes. `nowMs` ticks once a second only while a
  // cooldown is active so the countdown text re-renders without an
  // ever-running interval.
  const [cooldownUntilMs, setCooldownUntilMs] = useState<number | null>(null);
  const [is429, setIs429]                     = useState(false);
  const [nowMs, setNowMs]                     = useState<number>(() => Date.now());
  useEffect(() => {
    if (cooldownUntilMs == null) return;
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, [cooldownUntilMs]);
  const cooldownLeftSec = cooldownUntilMs != null
    ? Math.max(0, Math.ceil((cooldownUntilMs - nowMs) / 1000))
    : 0;
  const inCooldown = cooldownLeftSec > 0;
  useEffect(() => {
    if (cooldownUntilMs != null && cooldownLeftSec === 0) setCooldownUntilMs(null);
  }, [cooldownUntilMs, cooldownLeftSec]);
  // Selected collection drives the scan request body, the localStorage
  // key, and the displayed result. Changing it loads that slug's
  // cached scan if one exists.
  const [selectedSlug, setSelectedSlug] = useState<string>(COLLECTIONS[0].slug);
  const [result, setResult]             = useState<ScanResult | null>(null);
  // Hydrate from localStorage whenever the selected collection changes
  // (initial mount + any subsequent dropdown pick).
  useEffect(() => { setResult(loadPersisted(selectedSlug)); }, [selectedSlug]);
  const [error, setError]               = useState<string | null>(null);
  // Default sort: status priority + highest BEST OFFER first; tie-break
  // highest SPREAD. The status priority is enforced inside the offer
  // case below so AVAILABLE always groups above EXPECTED above EXPIRED.
  const [sortKey, setSortKey]           = useState<SortKey>('offer');
  const [sortDir, setSortDir]           = useState<SortDir>('desc');

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
        case 'offer': {
          // Status takes priority over price: AVAILABLE > EXPECTED >
          // EXPIRED, regardless of sort direction. Within a status
          // tier, price respects the user's chosen direction.
          const ra = statusRank(a.bestOfferStatus);
          const rb = statusRank(b.bestOfferStatus);
          if (ra !== rb) return ra - rb;
          return (a.bestOfferPrice - b.bestOfferPrice) * dir;
        }
        case 'spread':  va = a.spreadSol;      vb = b.spreadSol;      break;
        case 'age':
          // Newer first when desc; "—" (null createdAt) sinks to the
          // bottom regardless of dir so unknown-age rows don't pollute
          // the visible top.
          va = a.bestOfferCreatedAt ?? -Infinity;
          vb = b.bestOfferCreatedAt ?? -Infinity;
          break;
        case 'status':
          // Pure status ordering (asc: AVAILABLE → EXPECTED → EXPIRED).
          // Different from the implicit status priority inside `offer`,
          // which still groups by status but tie-breaks within a tier
          // by price; here, status is the primary key and the secondary
          // tie-break (spread desc) at the bottom of this comparator
          // takes over within a tier.
          va = statusRank(a.bestOfferStatus);
          vb = statusRank(b.bestOfferStatus);
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
      // (largest first); on the alphabetic NFT column: ascending; on
      // STATUS, ascending so AVAILABLE (the actionable tier) leads.
      setSortDir(key === 'nft' || key === 'status' ? 'asc' : 'desc');
    }
  };
  const sortArrow = (key: SortKey) => sortKey === key ? (sortDir === 'asc' ? '↑' : '↓') : '';

  const runScan = async () => {
    if (busy || inCooldown) return;
    // Capture two baseline sets BEFORE issuing the request so the
    // diff is computed against what was visible when the user clicked
    // Scan. `result` is left in place during the fetch so the table
    // stays visible while busy=true (incremental refresh, not
    // flash-clear).
    //   prevOfferIds — bestOfferId per row from the last scan.
    //                  A row keeping the same listing but landing
    //                  a different best offer (different pdaAddress)
    //                  reads as a "new offer on a known listing".
    //   prevMints    — mint addresses from the last scan.
    //                  A row whose mint is brand-new is a "new
    //                  listing".
    const prevOfferIds = new Set<string>(
      (result?.withOffers ?? [])
        .map(r => r.bestOfferId)
        .filter((id): id is string => typeof id === 'string' && id.length > 0),
    );
    const prevMints = new Set<string>(
      (result?.withOffers ?? [])
        .map(r => r.mint)
        .filter((m): m is string => typeof m === 'string' && m.length > 0),
    );
    setBusy(true);
    setError(null);
    setIs429(false);
    try {
      const body: Record<string, unknown> = { slug: selectedSlug };
      const r = await fetch(`${API_BASE}/api/tools/retardio-me-offer-scan`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      if (r.status === 429) {
        // Soft path: surface a non-fatal warning, keep cached rows in
        // place, and start a 45 s cooldown so the operator can't
        // hammer the endpoint right back into another rate-limit.
        setIs429(true);
        setError('Rate limited — showing cached results. Try again in ~45s.');
        setCooldownUntilMs(Date.now() + 45_000);
        return;
      }
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status}${txt ? ` — ${txt.slice(0, 80)}` : ''}`);
      }
      const data = await r.json() as ScanResult;
      // NEW badge rules (per spec):
      //   - new offer on a known listing  → NEW
      //   - brand-new listing whose best offer is AVAILABLE/EXPECTED
      //                                       → NEW
      //   - brand-new listing but bestOfferStatus === 'EXPIRED'
      //                                       → NOT NEW (silent surface)
      //   - already-known offer (same bestOfferId)
      //                                       → NOT NEW
      // Skip the first-ever scan (empty prevMints) so we don't paint
      // every row NEW on first visit. `addedCount` then counts only
      // rows that actually got the badge — expired rows never bump it.
      const isFirstScan = prevMints.size === 0 && prevOfferIds.size === 0;
      const mergedRows = data.withOffers.map(row => {
        if (isFirstScan) return { ...row, isNew: false };
        const isNewOffer   = !!row.bestOfferId && !prevOfferIds.has(row.bestOfferId);
        const isNewListing = !prevMints.has(row.mint);
        const eligible     = row.bestOfferStatus !== 'EXPIRED';
        return { ...row, isNew: eligible && (isNewOffer || isNewListing) };
      });
      const addedCount = isFirstScan
        ? undefined
        : mergedRows.reduce((n, r) => n + (r.isNew ? 1 : 0), 0);
      const merged: ScanResult = {
        ...data,
        withOffers: mergedRows,
        addedCount,
      };
      setResult(merged);
      savePersisted(selectedSlug, merged);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="feed-root page-transition" data-page="tools">
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
            <select
              value={selectedSlug}
              onChange={(e) => setSelectedSlug(e.target.value)}
              disabled={busy}
              style={{
                padding: '6px 10px', fontSize: 12, fontWeight: 600,
                borderRadius: 4, border: '1px solid rgba(168,144,232,0.55)',
                background: 'rgba(20,14,34,0.85)', color: '#d4d4e8',
                outline: 'none', cursor: busy ? 'wait' : 'pointer',
                minWidth: 180, fontFamily: 'inherit',
              }}
            >
              {COLLECTIONS.map(c => (
                <option key={c.slug} value={c.slug} style={{ background: '#1a1530', color: '#d4d4e8' }}>
                  {c.label}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={runScan}
              disabled={busy || inCooldown}
              style={{
                padding: '7px 16px', fontSize: 12, fontWeight: 700,
                letterSpacing: '0.5px', textTransform: 'uppercase',
                borderRadius: 5, cursor: (busy || inCooldown) ? 'not-allowed' : 'pointer',
                border: '1px solid rgba(168,144,232,0.55)',
                background: (busy || inCooldown) ? 'rgba(128,104,216,0.15)' : 'linear-gradient(180deg, rgba(128,104,216,0.28) 0%, rgba(128,104,216,0.14) 100%)',
                color: (busy || inCooldown) ? '#7a7a94' : '#d4d4e8',
                boxShadow: (busy || inCooldown) ? 'none' : '0 0 12px rgba(128,104,216,0.18)',
                transition: 'all 0.15s',
              }}
            >
              {busy ? 'Scanning…' : inCooldown ? `Wait ${cooldownLeftSec}s` : 'Scan ME Offers'}
            </button>
          </div>
        </div>
        {error && (
          // Soft amber banner for 429 (cached rows still visible);
          // hard red banner for any other failure. Both keep `result`
          // intact — the scan never wipes existing data.
          is429 ? (
            <div style={{
              marginTop: 12, padding: '8px 12px', fontSize: 12, color: '#e0b34a',
              background: 'rgba(224,179,74,0.08)', border: '1px solid rgba(224,179,74,0.32)',
              borderRadius: 5,
            }}>
              {error}
            </div>
          ) : (
            <div style={{
              marginTop: 12, padding: '8px 12px', fontSize: 12, color: '#ef7878',
              background: 'rgba(239,120,120,0.08)', border: '1px solid rgba(239,120,120,0.32)',
              borderRadius: 5,
            }}>
              scan failed — {error}
            </div>
          )
        )}
        {result && !error && (
          <div style={{ marginTop: 12, fontSize: 11, color: '#7a7a94' }}>
            slug=<span style={{ color: '#a890e8', fontFamily: "'SF Mono','Fira Code',monospace" }}>{result.slug}</span>
            {' · '}scanned <span style={{ color: '#d4d4e8' }}>{result.scanned}</span> / {result.listedTotal} listings
            {' · '}offers <span style={{ color: '#5ce0a0' }}>{result.offersAvailable}</span> available / {result.offersFetched} fetched
            {' · '}rows <span style={{ color: '#5ce0a0' }}>{result.withOffers.length}</span> shown
            {/* Persisted across reloads via localStorage; cleared/recomputed
                on every Scan click. Undefined = first-ever scan for this
                slug (no baseline yet); 0 = scanned but nothing new; >0 =
                highlight in the same purple as the NEW corner ribbon. */}
            {result.addedCount !== undefined && (
              <>
                {' · '}
                {result.addedCount > 0 ? (
                  <span style={{ color: '#a890e8', fontWeight: 700 }}>
                    added {result.addedCount} new
                  </span>
                ) : (
                  <span>added 0</span>
                )}
              </>
            )}
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
            {/* Explicit column widths so the table reads as a balanced
                trading layout — without these, browser auto-distribution
                pushed LINKS to the far edge and crowded NFT against the
                left border. NFT is widest (30 %) but not glued to the
                edge thanks to thStyleNft's 14 px left padding; metric
                columns sit at 12–14 % each; STATUS / LINKS stay
                compact. Total = 100 %. */}
            <colgroup>
              <col style={{ width: '30%' }} />{/* NFT        */}
              <col style={{ width: '12%' }} />{/* LISTING    */}
              <col style={{ width: '14%' }} />{/* BEST OFFER */}
              <col style={{ width: '14%' }} />{/* SPREAD     */}
              <col style={{ width: '10%' }} />{/* AGE        */}
              <col style={{ width: '12%' }} />{/* STATUS     */}
              <col style={{ width:  '8%' }} />{/* LINKS      */}
            </colgroup>
            <thead>
              <tr style={{ position: 'sticky', top: 0, zIndex: 1, background: 'rgba(28,22,50,0.95)' }}>
                <th style={{ ...thStyleNft,  cursor: 'pointer' }} onClick={() => onHeaderClick('nft')}>
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
                <th style={{ ...thStyleSmall, cursor: 'pointer' }} onClick={() => onHeaderClick('status')}>
                  STATUS {sortArrow('status') && <span style={{ color: '#8068d8' }}>{sortArrow('status')}</span>}
                </th>
                <th style={thStyleSmall}>LINKS</th>
              </tr>
            </thead>
            <tbody>
              {!result && !busy && (
                <tr><td colSpan={7} style={emptyCell}>
                  Click <span style={{ color: '#a890e8', fontWeight: 600 }}>Scan ME Offers</span> to fetch listings and personal offers from Magic Eden for the selected collection.
                </td></tr>
              )}
              {busy && !result && (
                <tr><td colSpan={7} style={emptyCell}>
                  Scanning… fetching listings + offers from Magic Eden.
                </td></tr>
              )}
              {result && sortedRows.length === 0 && !busy && (
                <tr><td colSpan={7} style={emptyCell}>
                  No listings with personal offers right now.
                </td></tr>
              )}
              {sortedRows.map((row) => {
                const name = row.nftName ?? row.mint.slice(0, 6);
                const abbr = (name[0] ?? '?').toUpperCase() + (name[1] ?? '').toUpperCase();
                const positiveSpread = row.spreadSol > 0;
                // Dim expired rows so they read as background context
                // rather than actionable rows. AVAILABLE / EXPECTED at
                // full opacity; EXPIRED at 0.5.
                const rowOpacity = row.bestOfferStatus === 'EXPIRED' ? 0.5 : 1;
                const sb = statusBadgeStyle(row.bestOfferStatus);
                // NEW pill: surfaces fresh offers based on the offer's own
                // age (the same `bestOfferCreatedAt` that powers the AGE
                // column), not on scan time. Self-expires after 24 h and
                // never fires for expired offers.
                const offerAgeSec = row.bestOfferCreatedAt != null
                  ? Math.floor(Date.now() / 1000) - row.bestOfferCreatedAt
                  : null;
                const showNewBadge = offerAgeSec != null
                  && offerAgeSec < 24 * 60 * 60
                  && row.bestOfferStatus !== 'EXPIRED';
                return (
                  <tr key={row.mint} className="tools-offer-row" style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', opacity: rowOpacity }}>
                    <td style={{ padding: '10px 8px 10px 14px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        {/* Thumbnail wrapper carries `position: relative`
                            so the NEW pill can corner-anchor over the
                            top-right of the icon without affecting flex
                            layout. Pointer-events:none on the badge so
                            future click handlers on the icon still work. */}
                        <div style={{ flexShrink: 0, width: 40, height: 40 }}>
                          <CollectionIcon imageUrl={compressImage(row.imageUrl ?? null)} color="#8068d8" abbr={abbr} size={40} />
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                            <span style={{ fontSize: 14, fontWeight: 600, color: '#f0eef8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
                            {showNewBadge && (
                              // Compact NEW pill, inline next to the NFT
                              // title. Same purple-gradient chrome as the
                              // prior corner-anchored variant so the dark
                              // UI palette stays consistent. Fires on the
                              // 24 h offer-age rule (see showNewBadge).
                              <span style={{
                                flexShrink: 0,
                                padding: '1px 5px', fontSize: 8.5, fontWeight: 800,
                                letterSpacing: '0.4px', textTransform: 'uppercase',
                                borderRadius: 3, lineHeight: 1.2,
                                border: '1px solid rgba(168,144,232,0.7)',
                                background: 'linear-gradient(180deg, rgba(168,144,232,0.95) 0%, rgba(128,104,216,0.95) 100%)',
                                color: '#0e0b22',
                                boxShadow: '0 0 0 1px rgba(20,14,34,0.7), 0 1px 4px rgba(0,0,0,0.5)',
                                pointerEvents: 'none', userSelect: 'none',
                              }}>NEW</span>
                            )}
                          </div>
                          <div style={{ fontSize: 10, color: '#56566e', fontFamily: "'SF Mono','Fira Code',monospace" }}>{shortAddr(row.mint)}</div>
                        </div>
                      </div>
                    </td>
                    <td style={tdStyleNum}>{formatSol(row.listingPrice)}</td>
                    <td style={{ ...tdStyleNum, color: '#5ce0a0' }}>
                      {row.bestOfferStatus === 'EXPIRED' && (
                        // Inline EXPIRED tag — kept here in addition to the
                        // STATUS column so the offer-price reading itself
                        // is unambiguous even when the row's 0.5 opacity
                        // mutes the right-side badge. Reuses the shared
                        // expired palette via statusBadgeStyle for visual
                        // consistency with the column at the row's end.
                        <span style={{
                          display: 'inline-block', marginRight: 6,
                          padding: '1px 5px', fontSize: 8.5, fontWeight: 700,
                          letterSpacing: '0.4px', textTransform: 'uppercase',
                          borderRadius: 3, lineHeight: 1.2,
                          verticalAlign: 'middle',
                          ...statusBadgeStyle('EXPIRED'),
                        }}>EXPIRED</span>
                      )}
                      {formatSol(row.bestOfferPrice)}
                    </td>
                    <td style={{ ...tdStyleNum, color: positiveSpread ? '#5ce0a0' : '#ef7878', fontWeight: 700 }}>
                      {positiveSpread ? '+' : ''}{formatSol(Math.abs(row.spreadSol))}
                    </td>
                    <td style={{ ...tdStyleNum, color: '#aaaabf', fontWeight: 500 }}>
                      {fmtAge(row.bestOfferCreatedAt)}
                    </td>
                    <td style={tdStyleSmall}>
                      <span style={{
                        display: 'inline-block', padding: '2px 7px',
                        fontSize: 9.5, fontWeight: 700, borderRadius: 3,
                        letterSpacing: '0.4px', textTransform: 'uppercase',
                        ...sb,
                      }}>{row.bestOfferStatus}</span>
                    </td>
                    <td style={tdStyleSmall}>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <a href={row.meUrl} target="_blank" rel="noopener noreferrer" style={logoChipStyle}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src="/brand/me.png" alt="Magic Eden" width={20} height={20} draggable={false} style={logoImgStyle} />
                        </a>
                        <a href={row.tensorUrl} target="_blank" rel="noopener noreferrer" style={logoChipStyle}>
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src="/brand/tensor.png" alt="Tensor" width={20} height={20} draggable={false} style={logoImgStyle} />
                        </a>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
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
/** First column header — extra left padding so the NFT label doesn't
 *  press against the card border. Mirrored on the row's NFT cell
 *  (`padding: '10px 8px 10px 14px'`) below. */
const thStyleNft: React.CSSProperties = { ...thStyle, padding: '10px 8px 10px 14px' };
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

/** Square chrome for the marketplace-logo links — same compact size as
 *  the prior text chips (22×22) so the LINKS column keeps its width.
 *  Mirrors `MktIconBadge` chrome exactly. */
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
