// VictoryLabs — canonical Trending Collections sort semantics.
// Single source of truth for /dashboard's row comparator, extracted so
// /multi's DashboardCollectionsPanel (a separate port of the same table)
// reuses the exact ordering instead of reimplementing it. See
// frontend/src/app/dashboard/page.tsx and
// frontend/src/app/multi-native/DashboardCollectionsPanel.tsx.

export type SortKey =
  | 'collection' | 'floor' | 'volume' | 'sales' | 'listedPct' | 'me_bid' | 'tnsr_bid' | 'last';
export const SORT_KEYS: readonly SortKey[] =
  ['collection', 'floor', 'volume', 'sales', 'listedPct', 'me_bid', 'tnsr_bid', 'last'];
export type SortDir = 'asc' | 'desc';

/** Minimal shape the comparator needs — both /dashboard's and /multi's
 *  MergedRow satisfy this structurally without any cast. */
export interface TrendingSortableRow {
  name: string | null;
  slug: string;
  floorSol: number | null;
  volumeSol: number | null;
  salesCount: number | null;
  listedCount: number | null;
  totalSupply: number | null;
  bid?: {
    floorSol: number | null;
    meBidSol: number | null;
    tnsrBidSol: number | null;
    listedCount: number | null;
    totalSupply: number | null;
  } | null;
  live?: { latestTs: number } | null;
}

export function numCmp(a: number, b: number): number {
  const da = Number.isFinite(a) ? a : 0;
  const db = Number.isFinite(b) ? b : 0;
  if (da < db) return -1;
  if (da > db) return 1;
  return 0;
}

export function sortValueFor(r: TrendingSortableRow, key: SortKey): number | string {
  switch (key) {
    case 'collection': return (r.name ?? r.slug).toLowerCase();
    case 'floor':      return r.bid?.floorSol ?? r.floorSol ?? 0;
    case 'volume':     return r.volumeSol ?? 0;
    case 'sales':      return r.salesCount ?? 0;
    case 'listedPct': {
      const count  = r.bid?.listedCount ?? r.listedCount;
      const supply = r.bid?.totalSupply ?? r.totalSupply;
      return count != null && supply != null && supply > 0 ? count / supply : 0;
    }
    case 'me_bid':     return r.bid?.meBidSol ?? 0;
    case 'tnsr_bid':   return r.bid?.tnsrBidSol ?? 0;
    case 'last':       return r.live?.latestTs ?? 0;
  }
}

/** Canonical /dashboard row order (see dashboard/page.tsx's sortedRows):
 *  - explicit column selected → sort by that column/direction;
 *  - no column selected + live overlay active for the range (5m/10m/1h/6h)
 *    → most-recent-sale first (this used to be the RECENT tab; it's now
 *    the permanent unsorted default for those ranges);
 *  - no column selected + live overlay inactive (1d/7d/30d) → Volume desc.
 *  Ties always fall back to most-recent-sale, then name. */
export function compareTrendingRows<T extends TrendingSortableRow>(
  a: T, b: T,
  opts: { sortCol: SortKey | null; sortDir: SortDir; liveActive: boolean },
): number {
  let primary = 0;
  if (opts.sortCol === null) {
    if (opts.liveActive) primary = numCmp(b.live?.latestTs ?? 0, a.live?.latestTs ?? 0);
    else primary = numCmp(b.volumeSol ?? 0, a.volumeSol ?? 0);
  } else {
    const sign = opts.sortDir === 'asc' ? 1 : -1;
    const va = sortValueFor(a, opts.sortCol);
    const vb = sortValueFor(b, opts.sortCol);
    primary = typeof va === 'string' ? sign * va.localeCompare(vb as string) : sign * numCmp(va as number, vb as number);
  }
  if (primary !== 0) return primary;
  const tsCmp = numCmp(b.live?.latestTs ?? 0, a.live?.latestTs ?? 0);
  if (tsCmp !== 0) return tsCmp;
  return (a.name ?? a.slug).localeCompare(b.name ?? b.slug);
}
