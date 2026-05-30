'use client';

// VictoryLabs — Rare Feed data hook (Stage 1 native-/multi prep).
// Encapsulates the rare-feed REST poll + rarity-tab filtering so both the
// standalone /tools/rare-feed page and the upcoming native <RareFeedPanel>
// (for /multi) can share ONE data source. Pure data — no rendering.
//
// NOTE: this module is additive. The standalone page still has its own
// inline copy for now; DRY-ing it onto this hook is a later (optional)
// step so the standalone page is not touched during Stage 1.

import { useCallback, useEffect, useMemo, useState } from 'react';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';
const POLL_MS = 20_000;

export interface RareEvent {
  saleSignature:    string;
  mintAddress:      string;
  collectionSlug:   string | null;
  collectionName:   string | null;
  nftName:          string | null;
  imageUrl:         string | null;
  source:           string | null;
  seller:           string | null;
  buyer:            string | null;
  salePriceSol:     number;
  floorPriceSol:    number | null;
  floorDeltaPct:    number | null;
  rarityRank:       number | null;
  totalSupply:      number | null;
  rarityPercentile: number | null;
  raritySource:     string | null;
  rareScore:        number;
  reasonTags:       string[];
  saleTime:         string | null;
  createdAt:        string;
  meUrl:            string;
  tensorUrl:        string;
}

interface RecentResponse {
  ok:       boolean;
  minScore: number;
  count:    number;
  events:   RareEvent[];
}

export type RarityFilter = 'all' | 'top10' | 'top5' | 'top1';
export const SCORE_OPTIONS = [0, 40, 55, 70, 85];

export interface UseRareFeed {
  events:      RareEvent[];
  /** `events` after the active rarity-tab filter. */
  rows:        RareEvent[];
  minScore:    number;
  setMinScore: (n: number) => void;
  rarity:      RarityFilter;
  setRarity:   (r: RarityFilter) => void;
  error:       string | null;
  loading:     boolean;
  lastUpdated: number | null;
}

/** Poll /api/tools/rare-feed/recent every ~20s; expose events + a
 *  rarity-tab-filtered `rows`. Identical fetch/filter semantics to the
 *  standalone page (rare-only dataset; common sales never appear). */
export function useRareFeed(initialMinScore = 40): UseRareFeed {
  const [events, setEvents]           = useState<RareEvent[]>([]);
  const [minScore, setMinScore]       = useState<number>(initialMinScore);
  const [rarity, setRarity]           = useState<RarityFilter>('all');
  const [error, setError]             = useState<string | null>(null);
  const [loading, setLoading]         = useState(true);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  const load = useCallback(async (signal?: AbortSignal) => {
    try {
      const r = await fetch(`${API_BASE}/api/tools/rare-feed/recent?limit=100&minScore=${minScore}`, { signal });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json() as RecentResponse;
      setEvents(Array.isArray(data.events) ? data.events : []);
      setError(null);
      setLastUpdated(Date.now());
    } catch (e) {
      if ((e as Error).name === 'AbortError') return;
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [minScore]);

  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    void load(ctrl.signal);
    const id = setInterval(() => { void load(); }, POLL_MS);
    return () => { ctrl.abort(); clearInterval(id); };
  }, [load]);

  const rows = useMemo(() => {
    if (rarity === 'all') return events;
    const tag = rarity === 'top1' ? 'TOP_1' : rarity === 'top5' ? 'TOP_5' : 'TOP_10';
    return events.filter(e => e.reasonTags.includes(tag));
  }, [events, rarity]);

  return { events, rows, minScore, setMinScore, rarity, setRarity, error, loading, lastUpdated };
}
