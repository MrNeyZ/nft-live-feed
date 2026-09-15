'use client';

// VictoryLabs — Tools › Ghost Bid.
// Forgotten M2 (Magic Eden) + Solanart bids, ranked by profit
// (bid * (1 - royaltyBp/10000 - feeBp/10000) - floor — royalty/fee come out
// of the bid, not stacked on top of the floor; feeBp is 200 on ME, 150 on
// Solanart, both verified against the original hand-built dataset),
// sitting on NFTs currently held by real wallets. Same criteria/columns as
// the manually-built forgotten-bids top-100 table (see
// forgotten-bids-2026-08-25/ on the research VPS): rank by profit, one row
// per bid, identity columns (sns/matrica/discord/twitter/pumpfun/me/galxe)
// filled where a multi-source scan found a match, ME rows tagged when 2+ share one
// buyer's escrow (only the first accepted actually pays — the rest drain
// to zero).
//
// REFRESH re-checks live escrow funding instead of just refetching the
// cached list: ME rows hit `/v2/wallets/{buyer}/escrow_balance` (the
// shared M2 escrow balance), Solanart rows hit one batched
// getMultipleAccounts on their self-funded offer PDAs. effectiveBid =
// min(originalBid, liveBalance) — so a shared-escrow bid drained by a
// different accepted offer visibly drops in profit/rank instead of
// showing a stale number.
//
// Read-only: no wallet connect, no signing, no tx building.
// Data: GET /api/tools/ghostbid (requireAuth), POST /api/tools/ghostbid/refresh

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { compressImage } from '@/soloist/shared';
import { VL, VLText, rgb, alpha, type RGB } from '@/lib/palette';
import { API_BASE, MONO, PANEL, TH, ToolButton } from '@/app/tools/mmm-shared';
import { authHeaders } from '@/runtime/auth';
import { GhostBidRequestArbiter, floorSnapshotCaption } from './logic';

interface GhostBidRow {
  mint: string;
  nft: string;
  image: string | null;
  owner: string;
  buyer: string;
  offerAccount: string | null;
  marketplace: 'ME' | 'Solanart';
  bidSol: number;
  floorSol: number | null;
  lastActiveAt: number | null;
  liveBidSol: number;
  profitSol: number | null;
  drained: boolean;
  sharedEscrowGroup: string | null;
  liveOwner: string | null;
  ownerChanged: boolean;
  ownerChangedAt: number | null;
  sns: string | null;
  matrica: string | null;
  discord: string | null;
  twitter: string | null;
  pumpfun: string | null;
  me: string | null;
  galxe: string | null;
  listingStatus: string | null;
}
interface ApiResult {
  ok: true;
  list?: number;
  updatedAt: number;
  /** Unix ms mtime of this list's dataset file — see floorSnapshotCaption
   *  in ./logic. Absent on a response from a not-yet-redeployed backend;
   *  the caption falls back to honest un-dated wording in that case. */
  snapshotAt?: number;
  count: number;
  rows: GhostBidRow[];
  checked?: { meBuyers: number; meResolved: number; solanartAccounts: number; solanartResolved: number; owners: number; ownerActivityResolved: number; mints?: number; mintOwnersResolved?: number; filled?: number; ownerChanged?: number; ownerChangedActivityResolved?: number };
}

type SortCol = 'profit' | 'days' | 'sns' | 'matrica' | 'social' | 'pumpfun' | 'me' | 'galxe';

// `listingStatus` null / 'LISTED_ME' / 'LISTED_TENSOR' → owner is a real,
// resolved wallet (either the actual holder, or that mint's real seller —
// still actionable). Anything else ('LISTED_SOLANART_STUCK' or
// 'STUCK_OTHER:<programId>') means `owner` is a program-owned escrow/vault
// with no resolvable real wallet — a dead Solanart listing (no working
// delist path) or an unrelated staking contract. Not actionable; the row
// stays in the list (so the profit math is still visible) but gets a red
// wash so it reads as "skip" at a glance.
function isStuckListing(status: string | null): boolean {
  return !!status && status !== 'LISTED_ME' && status !== 'LISTED_TENSOR';
}
function stuckReason(status: string | null): string {
  if (status === 'LISTED_SOLANART_STUCK') return 'Held in Solanart’s dead-marketplace escrow — no working delist path, owner can’t move it';
  if (status?.startsWith('STUCK_OTHER:')) return `Held by an unresolved on-chain program (${status.slice('STUCK_OTHER:'.length)}) — likely staked, not a real wallet`;
  return 'Not actionable';
}

// Deterministic color per shared-escrow buyer — same buyer always gets the
// same dot, distinct buyers get visibly distinct hues (matches the
// RED/ORANGE/YELLOW/GREEN/BLUE/PURPLE convention from the manual table).
const GROUP_HUES = [0, 30, 50, 140, 210, 270];
function groupColor(buyer: string): string {
  let h = 0;
  for (let i = 0; i < buyer.length; i++) h = (h * 31 + buyer.charCodeAt(i)) >>> 0;
  return `hsl(${GROUP_HUES[h % GROUP_HUES.length]} 75% 62%)`;
}

// Session-local, buyer-keyed cache — hovering the same shared-escrow dot
// twice (or a second row that shares the same buyer) doesn't refire the
// network call. Short TTL since the whole point is a fresh number.
const escrowHoverCache = new Map<string, { balanceSol: number | null; fetchedAt: number }>();
const ESCROW_HOVER_CACHE_TTL_MS = 20_000;

/** Shared-escrow-group dot — hover fires one cheap, single-buyer
 *  `escrow-check` call (not a full table refresh) and shows the buyer's
 *  live M2 escrow balance in a small floating tooltip. */
function EscrowDot({ buyer, color }: { buyer: string; color: string }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<'loading' | 'ok' | 'error'>('loading');
  const [balanceSol, setBalanceSol] = useState<number | null>(null);

  const handleEnter = () => {
    setOpen(true);
    const cached = escrowHoverCache.get(buyer);
    if (cached && Date.now() - cached.fetchedAt < ESCROW_HOVER_CACHE_TTL_MS) {
      setBalanceSol(cached.balanceSol);
      setState(cached.balanceSol == null ? 'error' : 'ok');
      return;
    }
    setState('loading');
    fetch(`${API_BASE}/api/tools/ghostbid/escrow-check?buyer=${buyer}`, { headers: authHeaders() })
      .then(r => r.json())
      .then((data: { ok: true; balanceSol: number } | { ok: false }) => {
        const resolved = data.ok ? data.balanceSol : null;
        escrowHoverCache.set(buyer, { balanceSol: resolved, fetchedAt: Date.now() });
        setBalanceSol(resolved);
        setState(resolved == null ? 'error' : 'ok');
      })
      .catch(() => setState('error'));
  };

  return (
    <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}
      onMouseEnter={handleEnter} onMouseLeave={() => setOpen(false)}>
      <span style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: color, cursor: 'default' }} />
      {open && (
        <div style={{
          // Anchored to the dot's LEFT edge, opening rightward and downward —
          // the dot lives in the leftmost column hard against the table edge,
          // so a centered (translateX(-50%)) tooltip spilled its left half
          // past the scroll-area / TABLE_PANEL `overflow:hidden` and got
          // clipped. Opening into the table body keeps it fully visible;
          // dropping below the row also clears the sticky header.
          position: 'absolute', top: 'calc(100% + 6px)', left: 0,
          background: 'rgba(13,10,22,0.98)', border: '1px solid rgba(255,255,255,0.14)',
          borderRadius: 6, padding: '6px 10px', fontSize: 11, whiteSpace: 'nowrap', zIndex: 10,
          boxShadow: '0 10px 28px rgba(0,0,0,0.55)', ...MONO,
        }}>
          {state === 'loading' && <span style={{ color: VLText.faint }}>checking escrow…</span>}
          {state === 'ok' && <span style={{ color: rgb(VL.goldBright), fontWeight: 700 }}>{balanceSol!.toFixed(4)} SOL in escrow now</span>}
          {state === 'error' && <span style={{ color: 'var(--vl-red-primary)' }}>couldn&apos;t resolve</span>}
        </div>
      )}
    </span>
  );
}

// No dedicated "orange" role exists in the VL palette (only green/red/
// purple/gold/pink/blue/violet/gray) — this blends the two adjacent
// warm tokens (goldBright + redGlow) rather than hand-picking a one-off
// hex, so it still reads as "from the palette", just mixed.
const ORANGE: RGB = [
  Math.round((VL.goldBright[0] + VL.redGlow[0]) / 2),
  Math.round((VL.goldBright[1] + VL.redGlow[1]) / 2),
  Math.round((VL.goldBright[2] + VL.redGlow[2]) / 2),
];

// Wallet-activity recency, from the shared VL palette only. Requested tiers:
// 0-7d brightest yellow, 8-30d orange, 31-120d a duller yellow, 121-365d a
// legible (not washed-out) gray, 366+d the dimmest — same faint tone as
// every other "nothing to see here" text on the site.
// Derived at render time from the stored unix timestamp, not a pre-baked
// integer — so the number keeps ticking up with real elapsed time even
// between Refreshes, instead of freezing at whatever it read on page load.
function daysAgo(lastActiveAt: number | null): number | null {
  if (lastActiveAt == null) return null;
  return Math.max(0, Math.floor((Date.now() / 1000 - lastActiveAt) / 86400));
}

function daysColor(days: number | null): string {
  if (days == null) return VLText.faint;
  if (days <= 7)   return rgb(VL.redStrong);  // top priority — most recently active
  if (days <= 30)  return rgb(ORANGE);
  if (days <= 120) return rgb(VL.goldBright);
  if (days <= 365) return rgb(VL.gray);
  return VLText.faint;
}

function fmtSol(sol: number | null | undefined): string {
  if (sol == null) return '—';
  return sol.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
}
// Matrica falls back to showing the raw wallet address as "username" when
// an account never set a custom display name (confirmed live against their
// API — not a parsing bug on our side). A wallet-shaped string isn't a
// useful identity, so treat it the same as no match.
const WALLET_SHAPED_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function fmtIdent(v: string | null): React.ReactNode {
  const usable = v && !WALLET_SHAPED_RE.test(v) ? v : null;
  return usable ? (
    <span style={{ color: '#e7e2fa', fontWeight: 600 }}>{usable}</span>
  ) : (
    <span style={{ opacity: 0.3 }}>—</span>
  );
}

// Twitter and Discord merged into one column — a Twitter handle and a
// Discord username#tag are already visually distinct (Discord's trailing
// `#1234` is the tell) without separate columns for two values that are
// rarely both populated. When a row does have both, stack them instead of
// picking one.
function SocialCell({ twitter, discord }: { twitter: string | null; discord: string | null }) {
  if (!twitter && !discord) return <span style={{ opacity: 0.3 }}>—</span>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1, lineHeight: 1.3 }}>
      {discord && <span style={{ color: '#e7e2fa', fontWeight: 600 }}>{discord}</span>}
      {twitter && <span style={{ color: '#e7e2fa', fontWeight: 600 }}>{twitter}</span>}
    </div>
  );
}

// 4+4 (not the shared `short()` helper's 5+5) — these two columns got
// narrowed to sit closer together, and xxxx…xxxx is plenty to recognize a
// wallet without re-widening the column back out.
function shortAddr(s: string): string {
  return s.length > 8 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}

// Owner/Mint link — plain `magiceden.io/u/<addr>` profile (works for every
// wallet regardless of when the offer was placed — the query-param variant
// with ?chains=&wallets=&activeTab= is new-ME-UI-only and 404s for older
// accounts) and `magiceden.io/item-details/<mint>` for the NFT itself.
// Owner = green (who to contact), Mint = blue (the asset itself) — same
// tokens as everywhere else on the site, dimmed via opacity (not a washed-
// out hex) so they sit quietly next to Profit/Days, brightening on hover.
function AddrLink({ href, addr, title, hue, copyOnClick }: { href: string; addr: string; title: string; hue: RGB; copyOnClick?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <a href={href} target="_blank" rel="noopener noreferrer"
      title={copyOnClick ? `${title} — click to copy, shift-click to open` : title}
      style={{ fontSize: 11.5, ...MONO, color: copied ? rgb(VL.green) : rgb(hue), textDecoration: 'none', fontWeight: 600, opacity: copied ? 1 : 0.72, transition: 'opacity 0.12s' }}
      onClick={(e) => {
        if (!copyOnClick || e.shiftKey || e.metaKey || e.ctrlKey) return;
        e.preventDefault();
        navigator.clipboard.writeText(addr).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 900);
        }).catch(() => {});
      }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.opacity = '1'; (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'underline'; }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.opacity = copied ? '1' : '0.72'; (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'none'; }}>
      {copied ? 'copied!' : shortAddr(addr)}
    </a>
  );
}

const TABLE_PANEL: React.CSSProperties = {
  ...PANEL, padding: 0, overflow: 'hidden',
  border: '1px solid rgba(255,255,255,0.08)',
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.04), 0 16px 40px rgba(0,0,0,0.55)',
};
const THEAD_TH: React.CSSProperties = {
  ...TH, color: '#9089ab', position: 'sticky', top: 0, zIndex: 2,
  background: 'rgba(13,10,22,0.98)', borderBottom: '1px solid rgba(255,255,255,0.10)',
};
const ROW_H = { padding: '12px 9px' };

export default function GhostBidPage() {
  useEffect(() => { document.title = 'Ghost Bid | VictoryLabs'; }, []);

  const [busy, setBusy] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ApiResult | null>(null);
  const [search, setSearch] = useState('');
  const [marketplaceFilter, setMarketplaceFilter] = useState<'all' | 'ME' | 'Solanart'>('all');
  const [groupedOnly, setGroupedOnly] = useState(false);
  const [sortCol, setSortCol] = useState<SortCol>('profit');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');
  // 5 static snapshots (ranks ~1-100 / 101-200 / 201-300 / 301-400 / 401-500,
  // combined M2+Solanart, same build methodology per list) — the backend
  // keeps each list's cached/live-refreshed state independently.
  const [activeList, setActiveList] = useState<1 | 2 | 3 | 4 | 5 | 6 | 7 | 8>(1);
  const [listMenuOpen, setListMenuOpen] = useState(false);
  const LIST_COUNTS: Record<1 | 2 | 3 | 4 | 5 | 6 | 7 | 8, number> = { 1: 96, 2: 94, 3: 95, 4: 95, 5: 91, 6: 91, 7: 95, 8: 47 };

  // GB-1 fix: `result`/`error` are shared between load() and refresh(), and
  // either can be in flight for either list at once (list-switch mid-fetch,
  // a double refresh-click, or the auto-refresh effect firing right as the
  // operator picks a different list). Two requests of the same OR different
  // kind can resolve out of order — comparing the response's own `list`
  // field against `activeList` doesn't catch same-list-different-request
  // races (Refresh A vs Refresh B on the same list). The arbiter tracks one
  // shared "most recently STARTED" generation for result/error, plus a
  // per-kind latest-generation so a stale load/refresh can never clear the
  // OTHER kind's — or a newer same-kind request's — loading flag. See
  // ./logic.ts (GhostBidRequestArbiter) for the isolated, tested logic.
  const requestArbiterRef = useRef(new GhostBidRequestArbiter());

  const load = useCallback(() => {
    const arbiter = requestArbiterRef.current;
    const gen = arbiter.beginLoad();
    setBusy(true);
    setError(null);
    fetch(`${API_BASE}/api/tools/ghostbid?list=${activeList}`, { headers: authHeaders() })
      .then(r => r.json())
      .then((data: ApiResult | { ok: false; error: string }) => {
        if (!arbiter.isLatestOverall(gen)) return; // superseded — a newer load/refresh already painted
        if (!data.ok) { setError(data.error); return; }
        setResult(data);
      })
      .catch(e => {
        if (!arbiter.isLatestOverall(gen)) return;
        setError(String(e));
      })
      .finally(() => {
        if (!arbiter.isLatestLoad(gen)) return; // a newer load owns `busy` now
        setBusy(false);
      });
  }, [activeList]);

  const refresh = useCallback(() => {
    const arbiter = requestArbiterRef.current;
    const gen = arbiter.beginRefresh();
    setRefreshing(true);
    setError(null);
    fetch(`${API_BASE}/api/tools/ghostbid/refresh?list=${activeList}`, { method: 'POST', headers: authHeaders() })
      .then(r => r.json())
      .then((data: ApiResult | { ok: false; error: string }) => {
        if (!arbiter.isLatestOverall(gen)) return;
        if (!data.ok) { setError(data.error); return; }
        setResult(data);
      })
      .catch(e => {
        if (!arbiter.isLatestOverall(gen)) return;
        setError(String(e));
      })
      .finally(() => {
        if (!arbiter.isLatestRefresh(gen)) return; // a newer refresh owns `refreshing` now
        setRefreshing(false);
      });
  }, [activeList]);

  // Re-fires whenever activeList changes (load/refresh both depend on it) —
  // switching lists in the dropdown re-triggers this exact same mount flow.
  useEffect(() => { setResult(null); load(); }, [load]);

  // Once per list load (not a recurring poll): after the cached snapshot
  // paints, if it's stale (never live-checked, or the last check was more
  // than 5 minutes ago) fire a background Refresh — no loading-state
  // change, no blocking, the table just updates in place when it lands.
  // ~90-100 Helius RPC calls per full refresh (mostly
  // getSignaturesForAddress, one per unique owner) — cheap enough per
  // visit, but real cost if it fired on every render, hence the staleness
  // gate and the once-per-list ref reset below.
  const autoRefreshedListRef = useRef<number | null>(null);
  useEffect(() => {
    if (!result || autoRefreshedListRef.current === activeList) return;
    autoRefreshedListRef.current = activeList;
    const STALE_MS = 5 * 60_000;
    if (result.updatedAt === 0 || Date.now() - result.updatedAt > STALE_MS) {
      refresh();
    }
  }, [result, refresh, activeList]);

  const toggleSort = (col: SortCol) => {
    if (sortCol === col) { setSortDir(d => d === 'asc' ? 'desc' : 'asc'); }
    else { setSortCol(col); setSortDir('desc'); }
  };
  const sortHeader = (col: SortCol, label: string) => {
    const active = sortCol === col;
    return (
      <th onClick={() => toggleSort(col)}
        style={{ ...THEAD_TH, textAlign: 'center', cursor: 'pointer', userSelect: 'none' as const,
          color: active ? rgb(VL.purpleTint) : THEAD_TH.color }}>
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
      if (groupedOnly && !r.sharedEscrowGroup) return false;
      if (q) {
        const hay = `${r.nft} ${r.mint} ${r.owner} ${r.sns ?? ''} ${r.matrica ?? ''} ${r.discord ?? ''} ${r.twitter ?? ''} ${r.pumpfun ?? ''} ${r.me ?? ''} ${r.galxe ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
    const presence = (r: GhostBidRow): number => {
      switch (sortCol) {
        case 'sns':     return r.sns ? 1 : 0;
        case 'matrica': return r.matrica ? 1 : 0;
        case 'social':  return (r.twitter || r.discord) ? 1 : 0;
        case 'pumpfun': return r.pumpfun ? 1 : 0;
        case 'me':      return r.me ? 1 : 0;
        case 'galxe':   return r.galxe ? 1 : 0;
        default:        return 0;
      }
    };
    rows = [...rows].sort((a, b) => {
      let av: number, bv: number;
      if (sortCol === 'days') { av = daysAgo(a.lastActiveAt) ?? -1; bv = daysAgo(b.lastActiveAt) ?? -1; }
      else if (sortCol === 'profit') { av = a.profitSol ?? -Infinity; bv = b.profitSol ?? -Infinity; }
      else { av = presence(a); bv = presence(b); }
      return sortDir === 'asc' ? av - bv : bv - av;
    });
    return rows;
  }, [result, search, marketplaceFilter, groupedOnly, sortCol, sortDir]);

  return (
    <div className="feed-root page-transition" data-page="tools">
      {/* No page-level scroll here on purpose — the table below is the only
          scrollable region (its own overflowY), sized via flex to fill
          whatever height is left under the header/controls. A second,
          outer scrollbar on top of the table's own was pure redundancy. */}
      <div className="scroll-area" style={{ flex: 1, minHeight: 0, overflowY: 'hidden', width: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* `.ghostbid-page` overrides the global --tools-max token for this
          page only (see globals.css) — a bare `var(--tools-max, 1960px)`
          fallback here would never apply since the var is always set by
          the shared responsive tiers already. */}
      {/* width: fit-content instead of a guessed --tools-max pixel value —
          the container now always hugs whatever the table (plus its panel
          border + scrollbar gutter) actually renders at, so there's never
          a leftover gap to hand-tune again if a column width changes. */}
      <div style={{ width: 'fit-content', maxWidth: '100%', margin: '0 auto', boxSizing: 'border-box', padding: '20px 4px 14px', display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        {/* ── Controls ─────────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 0, marginBottom: 12 }}>
          {result && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', lineHeight: 1, marginRight: 16, flexShrink: 0 }}>
              <span style={{ fontSize: 26, fontWeight: 800, color: rgb(VL.gold), ...MONO, letterSpacing: '-1px', lineHeight: 1 }}>
                {result.count}
              </span>
              <span style={{ fontSize: 8, color: alpha(VL.gold, 0.50), textTransform: 'uppercase', letterSpacing: '1.2px', fontWeight: 700, marginTop: 3 }}>
                ghost bids
              </span>
            </div>
          )}

          {/* List switcher — 5 static rank-range snapshots (~1-100 each,
              list 5 is a shorter 72). Picking one swaps the whole table via
              activeList; the backend caches each list's own live-refresh
              state separately. */}
          <div style={{ position: 'relative', marginRight: 16, flexShrink: 0 }}>
            <button type="button" onClick={() => setListMenuOpen(o => !o)}
              style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '7px 12px', fontSize: 11, fontWeight: 700,
                borderRadius: 6, border: `1px solid ${alpha(VL.purpleTint, 0.30)}`,
                background: alpha(VL.purpleTint, 0.10), color: rgb(VL.purpleTint), cursor: 'pointer',
              }}>
              List {activeList}
              <span style={{ fontSize: 9, opacity: 0.7 }}>{listMenuOpen ? '▲' : '▼'}</span>
            </button>
            {listMenuOpen && (
              <div style={{
                position: 'absolute', top: '110%', left: 0, zIndex: 20, minWidth: 140,
                background: 'rgba(13,10,22,0.98)', border: `1px solid ${alpha(VL.purpleTint, 0.30)}`,
                borderRadius: 8, overflow: 'hidden', boxShadow: '0 12px 32px rgba(0,0,0,0.55)',
              }}>
                {([1, 2, 3, 4, 5, 6, 7, 8] as const).map(n => (
                  <button key={n} type="button"
                    onClick={() => { setActiveList(n); setListMenuOpen(false); }}
                    style={{
                      display: 'flex', justifyContent: 'space-between', width: '100%', padding: '9px 12px',
                      fontSize: 11.5, fontWeight: n === activeList ? 800 : 600, border: 'none', cursor: 'pointer',
                      background: n === activeList ? alpha(VL.purpleTint, 0.18) : 'transparent',
                      color: n === activeList ? rgb(VL.purpleTint) : VLText.primary, textAlign: 'left',
                    }}
                    onMouseEnter={(e) => { if (n !== activeList) (e.currentTarget as HTMLButtonElement).style.background = 'rgba(255,255,255,0.06)'; }}
                    onMouseLeave={(e) => { if (n !== activeList) (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}>
                    <span>List {n}</span>
                    <span style={{ ...MONO, fontSize: 10, opacity: 0.6 }}>{LIST_COUNTS[n]}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {result && <div style={{ width: 1, height: 28, background: 'rgba(255,255,255,0.10)', margin: '0 14px', flexShrink: 0 }} />}

          <div style={{ display: 'inline-flex', border: `1px solid ${alpha(VL.purpleTint, 0.22)}`, borderRadius: 6, overflow: 'hidden', flexShrink: 0 }}>
            {(['all', 'ME', 'Solanart'] as const).map((m, i) => (
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

          <button type="button" onClick={() => setGroupedOnly(g => !g)}
            style={{
              marginLeft: 8, padding: '7px 12px', fontSize: 11, fontWeight: 700, borderRadius: 6,
              border: `1px solid ${groupedOnly ? '#facc15aa' : 'rgba(255,255,255,0.10)'}`,
              background: groupedOnly ? '#facc1520' : 'transparent',
              color: groupedOnly ? '#facc15' : VLText.muted, cursor: 'pointer', flexShrink: 0,
            }}>
            shared escrow only
          </button>

          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filter by NFT, owner, handle…"
              spellCheck={false}
              style={{
                width: 220, padding: '6px 10px', fontSize: 11.5, ...MONO, borderRadius: 5,
                border: '1px solid rgb(var(--vl-purple-tint) / 0.35)', background: 'rgba(20,14,34,0.85)',
                color: 'var(--vl-text-primary)', outline: 'none',
              }}
            />
            {/* Single action button, same ToolButton treatment as every
                other Scan/Check/Analyze control across the tools pages —
                the separate quiet "reload" (plain refetch of the cached
                GET) added a second button for no real benefit on a
                single-operator page, so it's gone; the initial load on
                mount still uses the plain GET internally. */}
            <ToolButton onClick={refresh} disabled={refreshing}>
              {refreshing ? 'Checking escrows…' : 'Refresh'}
            </ToolButton>
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

        {result && (
          <div style={{ marginBottom: result.checked ? 4 : 12, fontSize: 10.5, color: VLText.faint, ...MONO }}>
            {floorSnapshotCaption(result.snapshotAt)}
          </div>
        )}

        {result?.checked && (
          <div style={{ marginBottom: 12, fontSize: 10.5, color: VLText.faint, ...MONO }}>
            checked {result.checked.meBuyers} ME buyers ({result.checked.meResolved} resolved) ·
            {' '}{result.checked.solanartAccounts} Solanart escrows ({result.checked.solanartResolved} resolved) ·
            {' '}{result.checked.owners} owner wallets ({result.checked.ownerActivityResolved} resolved)
            {typeof result.checked.mints === 'number' && (
              <>
                {' '}· {result.checked.mints} mint owners ({result.checked.mintOwnersResolved} resolved
                {typeof result.checked.filled === 'number' && result.checked.filled > 0
                  ? `, ${result.checked.filled} filled → dropped` : ''})
              </>
            )}
          </div>
        )}

        {/* ── Results table ────────────────────────────────────────────────── */}
        {result && (
          <div style={{ ...TABLE_PANEL, flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            {visibleRows.length === 0 ? (
              <div style={{ padding: '32px 16px', textAlign: 'center', fontSize: 12, color: 'var(--vl-text-muted)' }}>
                No rows match the current filter.
              </div>
            ) : (
              <div className="scroll-area" style={{ overflowX: 'auto', overflowY: 'auto', flex: 1, minHeight: 0 }}>
                {/* Explicit (not 100%) width: with tableLayout:fixed, a 100%-wide
                    table stretches every column proportionally to fill
                    whatever the flex container happens to be (the wide
                    --tools-max panel), leaving huge dead space around
                    short, centered content in every column. Sizing the
                    table to its actual content width and letting it sit
                    left-aligned in the panel fixes that outright. */}
                <table style={{ width: 1430, borderCollapse: 'collapse', fontSize: 12, tableLayout: 'fixed' }}>
                  <colgroup>
                    <col style={{ width: 40 }} />{/* # */}
                    <col style={{ width: 230 }} />{/* NFT */}
                    <col style={{ width: 56 }} />{/* Market — logo links to the bidder's ME profile */}
                    <col style={{ width: 115 }} />{/* Profit — the only price/decision number left */}
                    <col style={{ width: 60 }} />{/* Days */}
                    <col style={{ width: 110 }} />{/* Owner (+ Solscan badge) */}
                    <col style={{ width: 110 }} />{/* Mint */}
                    <col style={{ width: 110 }} />{/* SNS */}
                    <col style={{ width: 130 }} />{/* Matrica */}
                    <col style={{ width: 140 }} />{/* Twitter/Discord — merged, stacked when a row has both */}
                    <col style={{ width: 110 }} />{/* Pumpfun */}
                    <col style={{ width: 110 }} />{/* ME */}
                    <col style={{ width: 110 }} />{/* Galxe */}
                  </colgroup>
                  <thead>
                    <tr>
                      <th style={{ ...THEAD_TH, textAlign: 'center' }}>#</th>
                      <th style={{ ...THEAD_TH, textAlign: 'left' }}>NFT</th>
                      <th style={{ ...THEAD_TH, textAlign: 'center' }}>MARKET</th>
                      {sortHeader('profit', 'PROFIT (SOL)')}
                      {sortHeader('days', 'DAYS')}
                      <th style={{ ...THEAD_TH, textAlign: 'center' }}>OWNER</th>
                      <th style={{ ...THEAD_TH, textAlign: 'center' }}>MINT</th>
                      {sortHeader('sns', 'SNS')}
                      {sortHeader('matrica', 'MATRICA')}
                      {sortHeader('social', 'TWITTER/DISCORD')}
                      {sortHeader('pumpfun', 'PUMPFUN')}
                      {sortHeader('me', 'ME')}
                      {sortHeader('galxe', 'GALXE')}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((r, i) => {
                      const stuck = isStuckListing(r.listingStatus);
                      const baseBg = stuck
                        ? 'rgb(var(--vl-red-glow) / 0.14)'
                        : (i % 2 === 1 ? 'rgba(255,255,255,0.028)' : 'transparent');
                      const hoverBg = stuck ? 'rgb(var(--vl-red-glow) / 0.20)' : 'rgba(196,184,232,0.10)';
                      return (
                      <tr key={`${r.marketplace}-${r.mint}-${r.buyer}`}
                        title={stuck ? stuckReason(r.listingStatus) : undefined}
                        style={{
                          background: baseBg,
                          borderBottom: '1px solid rgba(255,255,255,0.07)',
                        }}
                        onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = hoverBg; }}
                        onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = baseBg; }}>
                        <td style={{ ...ROW_H, textAlign: 'center', ...MONO, fontSize: 11, color: 'var(--vl-text-muted)' }}>
                          {i + 1}
                        </td>
                        <td style={{ ...ROW_H, display: 'flex', alignItems: 'center', gap: 9 }}>
                          {r.image ? (
                            // 64px source through the shared /thumb proxy (wsrv-backed resize +
                            // cache) — was hot-linking the original full-size NFT image and just
                            // shrinking it with CSS width/height, so every row downloaded a full
                            // arweave/IPFS asset for a 30px preview.
                            // eslint-disable-next-line @next/next/no-img-element
                            <img src={compressImage(r.image, 64) ?? undefined} alt="" width={32} height={32} draggable={false}
                              data-fallback={r.image}
                              style={{ borderRadius: 6, objectFit: 'cover', flexShrink: 0, background: 'rgba(255,255,255,0.06)' }}
                              onError={(e) => {
                                // The shared /thumb proxy rewrites some IPFS gateways (e.g.
                                // *.mypinata.cloud) to ipfs.io, which is occasionally down for
                                // content that's only pinned on the original dedicated gateway.
                                // One retry against the raw, unproxied URL before giving up —
                                // full-size-but-visible beats a blank tile.
                                const img = e.currentTarget as HTMLImageElement;
                                const fallback = img.dataset.fallback;
                                if (fallback && img.src !== fallback) { img.src = fallback; return; }
                                img.style.visibility = 'hidden';
                              }} />
                          ) : (
                            <div style={{ width: 32, height: 32, borderRadius: 6, background: 'rgba(255,255,255,0.06)', flexShrink: 0 }} />
                          )}
                          {r.sharedEscrowGroup && (
                            <EscrowDot buyer={r.sharedEscrowGroup} color={groupColor(r.sharedEscrowGroup)} />
                          )}
                          <span style={{ fontSize: 12.5, color: '#f2f0fa', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                            title={r.nft}>
                            {r.nft}
                          </span>
                        </td>
                        <td style={{ ...ROW_H, textAlign: 'center' }}>
                          {/* Logo doubles as the bidder link — no separate BIDDER column */}
                          <a href={`https://magiceden.io/u/${r.buyer}?activeTab=%22offers%22`} target="_blank" rel="noopener noreferrer" title="Bidder's ME profile — Offers tab">
                            {/* eslint-disable-next-line @next/next/no-img-element */}
                            <img src={r.marketplace === 'ME' ? '/brand/me.png' : '/brand/solanart.svg'}
                              alt={r.marketplace} width={18} height={18} draggable={false}
                              style={{ display: 'inline-block', objectFit: 'contain', borderRadius: 4, verticalAlign: 'middle' }} />
                          </a>
                        </td>
                        {/* Profit — the only price number left, PRIMARY */}
                        <td style={{ ...ROW_H, textAlign: 'center', ...MONO, fontVariantNumeric: 'tabular-nums', fontSize: 16, fontWeight: 900,
                          color: r.profitSol == null ? 'var(--vl-text-muted)' : r.profitSol > 0 ? '#ffd85e' : 'var(--vl-red-primary)' }}
                          title={r.floorSol == null ? `No floor data — bid is ${fmtSol(r.bidSol)} SOL, profit not computable`
                            : r.drained ? `bid dropped from ${fmtSol(r.bidSol)} to ${fmtSol(r.liveBidSol)} SOL — shared escrow spent elsewhere` : undefined}>
                          {r.floorSol == null ? (
                            <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: 0.3, color: 'var(--vl-text-muted)', background: 'rgba(255,255,255,0.06)', borderRadius: 4, padding: '3px 6px' }}>
                              NO FLOOR
                            </span>
                          ) : fmtSol(r.profitSol)}{r.drained && <span style={{ marginLeft: 4, fontSize: 10, color: 'var(--vl-red-primary)' }}>▼</span>}
                        </td>
                        {(() => {
                          const days = daysAgo(r.lastActiveAt);
                          return (
                            <td style={{ ...ROW_H, textAlign: 'center', fontSize: 11.5, ...MONO, color: daysColor(days), fontWeight: 700 }}
                              title={r.lastActiveAt == null ? undefined
                                : days! <= 7   ? 'active in the last week'
                                : days! <= 30  ? 'active in the last month'
                                : days! <= 120 ? 'active in the last 4 months'
                                : days! <= 365 ? 'active in the last year'
                                : 'stale — no activity in 365+ days'}>
                              {days ?? '—'}
                            </td>
                          );
                        })()}
                        <td style={{ ...ROW_H, textAlign: 'center' }}>
                          {(() => {
                            const shownOwner = r.ownerChanged && r.liveOwner ? r.liveOwner : r.owner;
                            const changeDays = r.ownerChanged ? daysAgo(r.ownerChangedAt) : null;
                            const recent = changeDays != null && changeDays <= 30;
                            const changeTitle = !r.ownerChanged ? undefined
                              : changeDays != null
                                ? `Owner changed ${changeDays}d ago (was ${r.owner}) — table's snapshot owner is stale`
                                : `Owner changed since our snapshot (was ${r.owner}) — exact time unresolved`;
                            return (
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                                {r.ownerChanged && (
                                  <span title={changeTitle}
                                    style={{
                                      fontSize: 9, fontWeight: 800, lineHeight: 1, padding: '2px 4px', borderRadius: 4,
                                      color: recent ? rgb(VL.redStrong) : VLText.faint,
                                      background: recent ? 'rgb(var(--vl-red-glow) / 0.16)' : 'rgba(255,255,255,0.06)',
                                      flexShrink: 0,
                                    }}>
                                    ⇄{changeDays != null ? `${changeDays}d` : ''}
                                  </span>
                                )}
                                <AddrLink href={`https://magiceden.io/u/${shownOwner}`} addr={shownOwner} title={r.ownerChanged ? "Current owner's ME profile (live, not the snapshot owner)" : "Owner's ME profile"} hue={VL.green} copyOnClick />
                                <a href={`https://solscan.io/account/${shownOwner}`} target="_blank" rel="noopener noreferrer"
                                  title="View owner on Solscan" style={{ display: 'inline-flex', lineHeight: 0, flexShrink: 0, opacity: 0.55 }}
                                  onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.opacity = '1'; }}
                                  onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.opacity = '0.55'; }}>
                                  {/* eslint-disable-next-line @next/next/no-img-element */}
                                  <img src="/brand/solscan.png" alt="Solscan" width={11} height={11} draggable={false} style={{ display: 'block', objectFit: 'contain' }} />
                                </a>
                              </span>
                            );
                          })()}
                        </td>
                        <td style={{ ...ROW_H, textAlign: 'center' }}>
                          <AddrLink href={`https://magiceden.io/item-details/${r.mint}`} addr={r.mint} title="This NFT on ME" hue={VL.blue} />
                        </td>
                        <td style={{ ...ROW_H, textAlign: 'center', fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fmtIdent(r.sns)}</td>
                        <td style={{ ...ROW_H, textAlign: 'center', fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fmtIdent(r.matrica)}</td>
                        <td style={{ ...ROW_H, textAlign: 'center', fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          <SocialCell twitter={r.twitter} discord={r.discord} />
                        </td>
                        <td style={{ ...ROW_H, textAlign: 'center', fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fmtIdent(r.pumpfun)}</td>
                        <td style={{ ...ROW_H, textAlign: 'center', fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fmtIdent(r.me)}</td>
                        <td style={{ ...ROW_H, textAlign: 'center', fontSize: 11.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{fmtIdent(r.galxe)}</td>
                      </tr>
                      );
                    })}
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

      </div>
      </div>
    </div>
  );
}
