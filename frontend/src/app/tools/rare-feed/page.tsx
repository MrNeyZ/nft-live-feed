'use client';

// VictoryLabs — Tools › Rare Feed.
// Live-ish view of rarity-scored value sales. Consumes the existing live
// sale pipeline (enriched with Magic Eden rarity, scored + filtered on the
// backend) via GET /api/tools/rare-feed/recent. Polls every ~20s — read-only,
// DB-backed, no ME/RPC cost on the client path.
//
// VISUAL: renders the SAME Live Feed Sales card (shared FeedCard) so Rare
// Feed reads as "Live Feed Sales, filtered to rare sales only". The dataset
// stays rare-only (this endpoint already returns only rarity-scored value
// sales — common sales never appear here). Two card affordances are
// rare-only: a neutral "SALE" pill (rare events carry no buy/sell side) and
// a compact rarity-rank chip after the NFT name. /feed passes neither.

import { useEffect, useMemo, useState, useCallback } from 'react';
import { LiveDot } from '@/soloist/shared';
import { collectionMeta } from '@/soloist/from-backend';
import type { FeedEvent } from '@/soloist/mock-data';
import { FeedCard } from '@/app/feed/lib/feed-card';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';
const POLL_MS = 20_000;

interface RareEvent {
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
  floorDeltaPct:    number | null;   // (sale - floor) / floor
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

type RarityFilter = 'all' | 'top10' | 'top5' | 'top1';
const SCORE_OPTIONS = [0, 40, 55, 70, 85];

function fmtAge(iso: string | null): string {
  if (!iso) return '—';
  const diffSec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSec < 0)      return 'just now';
  if (diffSec < 60)     return `${diffSec}s ago`;
  if (diffSec < 3_600)  return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3_600)}h ago`;
  return `${Math.floor(diffSec / 86_400)}d ago`;
}

function scoreColor(score: number): string {
  if (score >= 80) return '#5ce0a0';
  if (score >= 60) return '#a890e8';
  if (score >= 40) return '#e8c14a';
  return '#7a7a94';
}

// Neutral SALE pill for the shared FeedCard's BUY/SELL/AMM slot. Rare
// events are completed sales with no buy/sell side exposed by the
// endpoint, so we render a single direction-agnostic pill instead of a
// (potentially wrong) BUY/SELL. Lilac-grey so it reads as metadata, not
// a trade-direction signal.
const SALE_PILL = { label: 'SALE', fg: '#9aa0c8', bg: 'rgba(154,160,200,0.14)' };

/** Map a rare-feed event onto the shared Live Feed Sales `FeedEvent`
 *  shape so it renders through the exact same card. Fields the rare
 *  endpoint doesn't expose (buyer/seller, nftType, AMM/resize signals)
 *  are left empty/null — the card degrades gracefully (e.g. WalletLink
 *  shows N/A). The FloorChip is driven by `floorDelta`, which the rare
 *  endpoint already provides as a fractional ratio (`floorDeltaPct`). */
function rareToFeedEvent(e: RareEvent): FeedEvent {
  const { abbr, color } = collectionMeta(e.collectionName);
  const ts = e.saleTime ? new Date(e.saleTime).getTime()
           : new Date(e.createdAt).getTime();
  return {
    id:               e.saleSignature,
    signature:        e.saleSignature,
    mintAddress:      e.mintAddress,
    meCollectionSlug: e.collectionSlug,
    collectionName:   e.collectionName ?? 'Unknown',
    abbr,
    color,
    nftName:          e.nftName ?? (e.collectionName ?? e.mintAddress.slice(0, 6)),
    num:              0,                   // card re-parses #N from nftName
    rank:             e.rarityRank ?? 0,
    price:            e.salePriceSol,
    grossPrice:       e.salePriceSol,
    sellerNetPrice:   null,
    floorDelta:       e.floorDeltaPct,
    marketplace:      e.source && e.source.toLowerCase().includes('tensor') ? 'tensor' : 'me',
    ts,
    side:             'buy',               // pill is overridden; only affects flash class
    nftType:          '',
    saleTypeRaw:      null,                // → kind 'unknown'; pill overridden to SALE
    buyer:            e.buyer ?? '',
    seller:           e.seller ?? '',
    imageUrl:         e.imageUrl,
    collectionAddress: null,
    sellerRemainingCount: null,
    sellerSells10m:   0,
    resizeStatus:     null,
  };
}

/** Compact rarity chip rendered inline after the NFT name (Rare Feed
 *  only). Surfaces the rank (and supply) so the operator can see why
 *  the sale qualified as rare; tinted by the backend rareScore tier.
 *  The below-floor / premium context is already conveyed by the card's
 *  own FloorChip, so this chip stays focused on rank. */
function rarityChip(e: RareEvent) {
  if (e.rarityRank == null) return null;
  const c = scoreColor(e.rareScore);
  return (
    <span style={{
      flexShrink: 0, fontSize: 9, fontWeight: 800, letterSpacing: '0.3px',
      padding: '1px 6px', borderRadius: 3, lineHeight: 1.3, whiteSpace: 'nowrap',
      color: c, background: `${c}1f`, border: `1px solid ${c}55`,
      fontFamily: "'SF Mono','Fira Code',monospace",
    }}>
      #{e.rarityRank}{e.totalSupply ? `/${e.totalSupply}` : ''}
    </span>
  );
}

export default function RareFeedPage() {
  useEffect(() => { document.title = 'VictoryLabs — Rare Feed'; }, []);

  const [events, setEvents]   = useState<RareEvent[]>([]);
  const [minScore, setMinScore] = useState<number>(40);
  const [rarity, setRarity]   = useState<RarityFilter>('all');
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<number | null>(null);

  // Multi-tab embed (?embed=1): Gate already drops TopNav + BottomStatusBar
  // globally; here we set `data-embedded="1"` so layout-mode zoom doesn't
  // double-apply inside the iframe, and let the page fill the panel by
  // dropping the centered `--tools-max` width cap. Mirrors /feed + /mints.
  const [embedded, setEmbedded] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setEmbedded(new URLSearchParams(window.location.search).get('embed') === '1');
  }, []);
  const maxW = embedded ? 'none' : 'var(--tools-max, 1100px)';

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

  // Poll on an interval; refetch immediately when minScore changes.
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

  const RARITY_TABS: { key: RarityFilter; label: string }[] = [
    { key: 'all',   label: 'All'    },
    { key: 'top10', label: 'Top 10%' },
    { key: 'top5',  label: 'Top 5%'  },
    { key: 'top1',  label: 'Top 1%'  },
  ];

  // Open the NFT image in a new tab on avatar click (the shared card
  // expects an `onPreview` callback; Rare Feed has no modal overlay).
  const onPreview = useCallback((url: string) => {
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  return (
    <div className="feed-root page-transition" data-page="tools" data-embedded={embedded ? '1' : undefined}>
      {/* TopNav rendered persistently by Gate (anti-flash). */}

      {/* Header */}
      <div style={{ padding: '20px 4px 14px', flexShrink: 0, width: '100%', maxWidth: maxW, margin: '0 auto', boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 700, color: '#e8e6f2', letterSpacing: '-0.5px' }}>
              Rare Feed
            </h1>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6 }}>
              <LiveDot />
              <span style={{ fontSize: 11, color: '#7a7a94' }}>
                Rarity-scored value sales · refreshes every 20s
                {lastUpdated && <> · updated {fmtAge(new Date(lastUpdated).toISOString())}</>}
              </span>
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            {/* Rarity toggle */}
            <div style={{ display: 'flex', gap: 4, padding: 3, borderRadius: 6, background: 'rgba(20,14,34,0.6)', border: '1px solid rgba(168,144,232,0.25)' }}>
              {RARITY_TABS.map(t => (
                <button key={t.key} type="button" onClick={() => setRarity(t.key)}
                  style={{
                    padding: '5px 11px', fontSize: 11, fontWeight: 700, letterSpacing: '0.3px',
                    borderRadius: 4, cursor: 'pointer', border: 'none',
                    background: rarity === t.key ? 'rgba(128,104,216,0.35)' : 'transparent',
                    color: rarity === t.key ? '#e8e6f2' : '#7a7a94', transition: 'all 0.12s',
                  }}>
                  {t.label}
                </button>
              ))}
            </div>
            {/* Min score */}
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#7a7a94' }}>
              min score
              <select value={minScore} onChange={(e) => setMinScore(Number(e.target.value))}
                style={{
                  padding: '5px 8px', fontSize: 12, fontWeight: 600, borderRadius: 4,
                  border: '1px solid rgba(168,144,232,0.55)', background: 'rgba(20,14,34,0.85)',
                  color: '#d4d4e8', outline: 'none', cursor: 'pointer', fontFamily: 'inherit',
                }}>
                {SCORE_OPTIONS.map(s => <option key={s} value={s} style={{ background: '#1a1530' }}>{s}</option>)}
              </select>
            </label>
          </div>
        </div>
        {error && (
          <div style={{ marginTop: 12, padding: '8px 12px', fontSize: 12, color: '#ef7878', background: 'rgba(239,120,120,0.08)', border: '1px solid rgba(239,120,120,0.32)', borderRadius: 5 }}>
            failed to load — {error}
          </div>
        )}
        {!error && (
          <div style={{ marginTop: 12, fontSize: 11, color: '#7a7a94' }}>
            <span>showing <span style={{ color: '#a890e8', fontWeight: 700 }}>{rows.length}</span> rare {rows.length === 1 ? 'sale' : 'sales'}</span>
            <span style={{ color: '#3a3a52', margin: '0 10px' }}>·</span>
            <span>score ≥ {minScore}</span>
          </div>
        )}
      </div>

      {/* Results card — same gradient panel as before; the inner list is
          now the shared Live Feed Sales card list (`.feed-list`) instead
          of a table, so rows render with identical card chrome/spacing/
          density to /feed. */}
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0,
        width: '100%', maxWidth: maxW, margin: '0 auto',
        background: 'linear-gradient(180deg, #201a3a 0%, #1a1530 100%)',
        border: '1px solid rgba(168,144,232,0.65)', borderRadius: 12,
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4), 0 0 28px rgba(128,104,216,0.15)',
        overflow: 'hidden', marginBottom: 16,
      }}>
        <div className="feed-list feed-density-compact" style={{ flex: 1, overflowY: 'auto', padding: '6px 10px 10px 13px' }}>
          {loading && rows.length === 0 && (
            <div style={emptyCell}>Loading rare sales…</div>
          )}
          {!loading && rows.length === 0 && (
            <div style={emptyCell}>
              No rare sales yet at score ≥ {minScore}. Rare Feed surfaces sales of top-rarity NFTs
              trading at or below floor — these are infrequent, and require Magic Eden to expose a
              rarity rank for the collection.
            </div>
          )}
          {rows.map((e) => (
            <FeedCard
              key={e.saleSignature}
              event={rareToFeedEvent(e)}
              onPreview={onPreview}
              inclusiveFees={false}
              sellerSellCountInFeed={0}
              isNewestSellForSellerColl={false}
              density="compact"
              pillOverride={SALE_PILL}
              nameChip={rarityChip(e)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

const emptyCell: React.CSSProperties = {
  textAlign: 'center', color: '#55556e', padding: '64px 24px', fontSize: 13, lineHeight: 1.6,
};
