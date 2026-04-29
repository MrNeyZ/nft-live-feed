'use client';

// VictoryLabs — Tools.
// Manual, on-demand scanners. v1: Retardio listings with Magic Eden
// personal offers.

import { useEffect, useState } from 'react';
import { TopNav, LiveDot, CollectionIcon, compressImage } from '@/soloist/shared';
import { formatSol } from '@/soloist/mock-data';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

interface ScanRow {
  mint:           string;
  nftName:        string | null;
  imageUrl:       string | null;
  listingPrice:   number;
  bestOfferPrice: number;
  spreadSol:      number;
  seller:         string | null;
  buyer:          string | null;
  meUrl:          string;
  tensorUrl:      string;
}
interface ScanResult {
  ok:           true;
  slug:         string;
  scanned:      number;
  listedTotal:  number;
  withOffers:   ScanRow[];
  cachedAt:     number;
  ttlMs:        number;
  fromCache?:   boolean;
}

function shortAddr(s: string | null): string {
  if (!s) return '—';
  return s.length > 10 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}

export default function ToolsPage() {
  useEffect(() => { document.title = 'VictoryLabs — Tools'; }, []);
  const [busy, setBusy]       = useState(false);
  const [result, setResult]   = useState<ScanResult | null>(null);
  const [error, setError]     = useState<string | null>(null);
  const [minOffer, setMinOffer] = useState<string>('');

  const runScan = async () => {
    if (busy) return;
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
      setResult(data);
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
            {' · '}<span style={{ color: '#5ce0a0' }}>{result.withOffers.length}</span> with offers
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
                <th style={thStyle}>NFT</th>
                <th style={thStyleNum}>LISTING</th>
                <th style={thStyleNum}>BEST OFFER</th>
                <th style={thStyleNum}>SPREAD</th>
                <th style={thStyleSmall}>SELLER</th>
                <th style={thStyleSmall}>BUYER</th>
                <th style={thStyleSmall}>LINKS</th>
              </tr>
            </thead>
            <tbody>
              {!result && !busy && (
                <tr><td colSpan={7} style={emptyCell}>
                  Click <span style={{ color: '#a890e8', fontWeight: 600 }}>Scan ME Offers</span> to fetch active Retardio listings and their personal offers from Magic Eden.
                </td></tr>
              )}
              {busy && (
                <tr><td colSpan={7} style={emptyCell}>
                  Scanning… fetching listings + offers from Magic Eden.
                </td></tr>
              )}
              {result && result.withOffers.length === 0 && !busy && (
                <tr><td colSpan={7} style={emptyCell}>
                  No active Retardio listings have personal offers right now.
                </td></tr>
              )}
              {result?.withOffers.map((row) => {
                const name = row.nftName ?? row.mint.slice(0, 6);
                const abbr = (name[0] ?? '?').toUpperCase() + (name[1] ?? '').toUpperCase();
                const positiveSpread = row.spreadSol > 0;
                return (
                  <tr key={row.mint} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                    <td style={{ padding: '10px 8px' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <CollectionIcon imageUrl={compressImage(row.imageUrl ?? null)} color="#8068d8" abbr={abbr} size={32} />
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
                    <td style={tdStyleSmall}>{shortAddr(row.seller)}</td>
                    <td style={tdStyleSmall}>{shortAddr(row.buyer)}</td>
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
