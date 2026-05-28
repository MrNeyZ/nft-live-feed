'use client';

// VictoryLabs — Tools › Rare Feed.
// Live-ish view of rarity-scored value sales. Consumes the existing live
// sale pipeline (enriched with Magic Eden rarity, scored + filtered on the
// backend) via GET /api/tools/rare-feed/recent. Polls every ~20s — read-only,
// DB-backed, no ME/RPC cost on the client path.

import { useEffect, useMemo, useState, useCallback } from 'react';
import { TopNav, LiveDot, CollectionIcon, compressImage } from '@/soloist/shared';
import { formatSol } from '@/soloist/mock-data';

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

function shortAddr(s: string): string {
  return s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}

function fmtAge(iso: string | null): string {
  if (!iso) return '—';
  const diffSec = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSec < 0)      return 'just now';
  if (diffSec < 60)     return `${diffSec}s ago`;
  if (diffSec < 3_600)  return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86_400) return `${Math.floor(diffSec / 3_600)}h ago`;
  return `${Math.floor(diffSec / 86_400)}d ago`;
}

function fmtPct(p: number | null): string {
  if (p == null) return '—';
  return `${(p * 100).toFixed(p < 0.01 ? 2 : 1)}%`;
}

/** Source badge palette — which rarity provider supplied the rank. */
function sourceBadgeStyle(src: string | null): React.CSSProperties {
  switch (src) {
    case 'tensor':    return { color: '#6ab8ff', background: 'rgba(106,184,255,0.12)', border: '1px solid rgba(106,184,255,0.4)' };
    case 'howrare':   return { color: '#5ce0c0', background: 'rgba(92,224,192,0.12)',  border: '1px solid rgba(92,224,192,0.4)' };
    case 'magiceden': return { color: '#e0a0f0', background: 'rgba(224,160,240,0.12)', border: '1px solid rgba(224,160,240,0.4)' };
    default:          return { color: '#7a7a94', background: 'rgba(122,122,148,0.10)', border: '1px solid rgba(122,122,148,0.3)' };
  }
}
function sourceLabel(src: string | null): string {
  if (src === 'howrare')   return 'HowRare';
  if (src === 'tensor')    return 'Tensor';
  if (src === 'magiceden') return 'ME';
  return src ?? '?';
}

function scoreColor(score: number): string {
  if (score >= 80) return '#5ce0a0';
  if (score >= 60) return '#a890e8';
  if (score >= 40) return '#e8c14a';
  return '#7a7a94';
}

/** Reason-tag chip palette — TOP_1 is the standout, BELOW_FLOOR green
 *  (value buy), NEAR_FLOOR amber. */
function tagStyle(tag: string): React.CSSProperties {
  switch (tag) {
    case 'TOP_1':            return { color: '#ffd76a', background: 'rgba(255,215,106,0.14)', border: '1px solid rgba(255,215,106,0.5)' };
    case 'TOP_5':            return { color: '#a890e8', background: 'rgba(168,144,232,0.14)', border: '1px solid rgba(168,144,232,0.45)' };
    case 'TOP_10':           return { color: '#8da0e8', background: 'rgba(141,160,232,0.12)', border: '1px solid rgba(141,160,232,0.4)' };
    case 'BELOW_FLOOR':      return { color: '#5ce0a0', background: 'rgba(92,224,160,0.14)',  border: '1px solid rgba(92,224,160,0.45)' };
    case 'NEAR_FLOOR_TOP_1': return { color: '#e8c14a', background: 'rgba(232,193,74,0.14)',  border: '1px solid rgba(232,193,74,0.45)' };
    default:                 return { color: '#7a7a94', background: 'rgba(122,122,148,0.10)', border: '1px solid rgba(122,122,148,0.3)' };
  }
}

export default function RareFeedPage() {
  useEffect(() => { document.title = 'VictoryLabs — Rare Feed'; }, []);

  const [events, setEvents]   = useState<RareEvent[]>([]);
  const [minScore, setMinScore] = useState<number>(40);
  const [rarity, setRarity]   = useState<RarityFilter>('all');
  const [error, setError]     = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
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

  return (
    <div className="feed-root page-transition" data-page="tools">
      <TopNav active="tools" />

      {/* Header */}
      <div style={{ padding: '20px 4px 14px', flexShrink: 0, width: '100%', maxWidth: 'var(--tools-max, 1100px)', margin: '0 auto', boxSizing: 'border-box' }}>
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

      {/* Results card */}
      <div style={{
        flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0,
        width: '100%', maxWidth: 'var(--tools-max, 1100px)', margin: '0 auto',
        background: 'linear-gradient(180deg, #201a3a 0%, #1a1530 100%)',
        border: '1px solid rgba(168,144,232,0.65)', borderRadius: 12,
        boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.08), 0 16px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4), 0 0 28px rgba(128,104,216,0.15)',
        overflow: 'hidden', marginBottom: 16,
      }}>
        <div style={{ flex: 1, overflowY: 'auto' }} className="scroll-area">
          <table style={{ width: '100%', borderCollapse: 'collapse', tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: '30%' }} />{/* NFT      */}
              <col style={{ width: '12%' }} />{/* SALE     */}
              <col style={{ width: '12%' }} />{/* FLOOR Δ  */}
              <col style={{ width: '13%' }} />{/* RARITY   */}
              <col style={{ width:  '9%' }} />{/* SCORE    */}
              <col style={{ width: '16%' }} />{/* TAGS     */}
              <col style={{ width:  '8%' }} />{/* TIME/LINK*/}
            </colgroup>
            <thead>
              <tr style={{ position: 'sticky', top: 0, zIndex: 1, background: 'rgba(16,12,26,0.96)' }}>
                <th style={thNft}>NFT</th>
                <th style={thNum}>SALE</th>
                <th style={thNum}>FLOOR Δ</th>
                <th style={thNum}>RARITY</th>
                <th style={thNum}>SCORE</th>
                <th style={thSmall}>TAGS</th>
                <th style={{ ...thSmall, textAlign: 'center' }}>TIME</th>
              </tr>
            </thead>
            <tbody>
              {loading && rows.length === 0 && (
                <tr><td colSpan={7} style={emptyCell}>Loading rare sales…</td></tr>
              )}
              {!loading && rows.length === 0 && (
                <tr><td colSpan={7} style={emptyCell}>
                  No rare sales yet at score ≥ {minScore}. Rare Feed surfaces sales of top-rarity NFTs
                  trading at or below floor — these are infrequent, and require Magic Eden to expose a
                  rarity rank for the collection.
                </td></tr>
              )}
              {rows.map((e) => {
                const name = e.nftName ?? (e.collectionName ? `${e.collectionName}` : e.mintAddress.slice(0, 6));
                const abbr = (name[0] ?? '?').toUpperCase() + (name[1] ?? '').toUpperCase();
                const belowFloor = e.floorDeltaPct != null && e.floorDeltaPct < 0;
                return (
                  <tr key={e.saleSignature} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    {/* NFT */}
                    <td style={{ padding: '10px 8px 10px 14px', verticalAlign: 'middle' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <div style={{ flexShrink: 0, width: 40, height: 40 }}>
                          <CollectionIcon imageUrl={compressImage(e.imageUrl ?? null)} color="#8068d8" abbr={abbr} size={40} />
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 14, fontWeight: 600, color: '#f0eef8', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</div>
                          <div style={{ fontSize: 10, color: '#56566e' }}>
                            {e.collectionName && e.nftName ? <span style={{ marginRight: 6 }}>{e.collectionName}</span> : null}
                            <span style={{ fontFamily: "'SF Mono','Fira Code',monospace" }}>{shortAddr(e.mintAddress)}</span>
                            {e.source && <span style={{ marginLeft: 6, color: '#6a6a82' }}>· {e.source.replace(/_/g, ' ')}</span>}
                          </div>
                        </div>
                      </div>
                    </td>
                    {/* Sale price */}
                    <td style={tdNum}>{formatSol(e.salePriceSol)}</td>
                    {/* Floor delta */}
                    <td style={{ ...tdNum, color: belowFloor ? '#5ce0a0' : '#e8c14a' }}>
                      <div style={{ fontWeight: 700 }}>
                        {e.floorDeltaPct != null ? `${e.floorDeltaPct > 0 ? '+' : ''}${(e.floorDeltaPct * 100).toFixed(1)}%` : '—'}
                      </div>
                      {e.floorPriceSol != null && (
                        <div style={{ fontSize: 10, opacity: 0.6, marginTop: 1 }}>fl {formatSol(e.floorPriceSol)}</div>
                      )}
                    </td>
                    {/* Rarity rank / supply + percentile */}
                    <td style={tdNum}>
                      <div style={{ fontWeight: 700, color: '#d4d4e8' }}>
                        {e.rarityRank != null ? `#${e.rarityRank}` : '—'}
                        {e.totalSupply != null && <span style={{ color: '#56566e', fontWeight: 500 }}>/{e.totalSupply}</span>}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 5, marginTop: 1 }}>
                        <span style={{ fontSize: 10, opacity: 0.8, color: '#a890e8' }}>{fmtPct(e.rarityPercentile)}</span>
                        <span  style={{
                          padding: '0 4px', fontSize: 8, fontWeight: 800, letterSpacing: '0.3px',
                          borderRadius: 3, lineHeight: 1.4, textTransform: 'uppercase', ...sourceBadgeStyle(e.raritySource),
                        }}>{sourceLabel(e.raritySource)}</span>
                      </div>
                    </td>
                    {/* Score */}
                    <td style={{ ...tdNum, fontSize: 15, fontWeight: 800, color: scoreColor(e.rareScore) }}>
                      {Math.round(e.rareScore)}
                    </td>
                    {/* Reason tags */}
                    <td style={{ ...tdSmall, whiteSpace: 'normal' }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                        {e.reasonTags.map(t => (
                          <span key={t} style={{
                            padding: '1px 6px', fontSize: 8.5, fontWeight: 800, letterSpacing: '0.3px',
                            borderRadius: 3, lineHeight: 1.3, whiteSpace: 'nowrap', ...tagStyle(t),
                          }}>{t.replace(/_/g, ' ')}</span>
                        ))}
                      </div>
                    </td>
                    {/* Time + ME link */}
                    <td style={{ ...tdSmall, textAlign: 'center' }}>
                      <a href={e.meUrl} target="_blank" rel="noopener noreferrer"
                        style={{ color: '#a890e8', textDecoration: 'none', fontSize: 11 }}>
                        {fmtAge(e.saleTime)}
                      </a>
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

const thBase: React.CSSProperties = {
  padding: '10px 8px', fontSize: 9.5, fontWeight: 700, color: '#56566e',
  letterSpacing: '0.6px', textAlign: 'left', background: 'rgba(16,12,26,0.96)',
  borderBottom: '1px solid rgba(168,144,232,0.12)', textTransform: 'uppercase', userSelect: 'none',
};
const thNum: React.CSSProperties   = { ...thBase, textAlign: 'right' };
const thSmall: React.CSSProperties = { ...thBase, fontSize: 9.5 };
const thNft: React.CSSProperties   = { ...thBase, padding: '10px 8px 10px 14px' };
const tdNum: React.CSSProperties = {
  padding: '10px 6px', textAlign: 'right', fontSize: 13, fontWeight: 600,
  color: '#f0eef8', fontFamily: "'SF Mono','Fira Code',monospace", verticalAlign: 'middle',
};
const tdSmall: React.CSSProperties = {
  padding: '10px 6px', fontSize: 11, color: '#aaaabf',
  fontFamily: "'SF Mono','Fira Code',monospace", verticalAlign: 'middle',
};
const emptyCell: React.CSSProperties = {
  textAlign: 'center', color: '#55556e', padding: '64px 24px', fontSize: 13, lineHeight: 1.6,
};
