'use client';

// VictoryLabs — Tools › ME vs Tensor Arb.
// Paste a collection slug, collection address, or an individual NFT mint
// address → backend auto-detects which, resolves a mint to its ME
// collection first if needed, then reuses the existing ME + MMM + Tensor
// listings snapshot (listings-store.ts) and returns every ME/MMM-side
// listing currently priced BELOW Tensor's own cheapest active listing for
// that collection. Read-only, no wallet connect, no signing — one lookup
// per request, cached server-side per collection TTL so repeat checks on a
// hot collection are fast, not a fresh scan every time.
// Data: GET /api/tools/me-tensor-arb?q=<slug | collection address | mint>

import { useEffect, useState } from 'react';
import { LiveDot } from '@/soloist/shared';
import { playUiConfirm } from '@/soloist/use-ui-sound';
import { authHeaders } from '@/runtime/auth';
import { API_BASE, MONO, PANEL, TH, TH_L, ADDR_RE, short } from '@/app/tools/mmm-shared';

interface ArbListing {
  mint:      string;
  priceSol:  number;
  seller:    string;
  source:    'ME' | 'MMM';
  rank:      number | null;
  listedAt:  number | null;
  nftName:   string | null;
  imageUrl:  string | null;
  multiple:  number;
}
interface ArbResult {
  ok: true;
  resolvedSlug:      string;
  resolvedVia:       'slug' | 'me-mint-lookup' | 'address-passthrough';
  tensorFloorSol:    number | null;
  tensorListedCount: number;
  listings:          ArbListing[];
}

const SLUG_RE = /^[a-z0-9_-]+$/i;
function isValidQuery(v: string): boolean { return SLUG_RE.test(v) || ADDR_RE.test(v); }
function resolvedViaLabel(via: ArbResult['resolvedVia']): string {
  if (via === 'me-mint-lookup') return 'resolved from NFT mint →';
  if (via === 'address-passthrough') return 'collection address →';
  return 'slug →';
}

function fmtSol(n: number): string { return n.toFixed(4).replace(/0+$/, '').replace(/\.$/, ''); }
function fmtWhen(ms: number | null): string {
  if (ms == null) return '—';
  try { return new Date(ms).toLocaleString('en-US', { hour12: false }); } catch { return '—'; }
}

export default function MeTensorArbPage() {
  useEffect(() => { document.title = 'ME vs Tensor Arb | VictoryLabs'; }, []);

  const [slug, setSlug]     = useState('');
  const [busy, setBusy]     = useState(false);
  const [error, setError]   = useState<string | null>(null);
  const [result, setResult] = useState<ArbResult | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  const run = async () => {
    const trimmed = slug.trim();
    if (busy || !isValidQuery(trimmed)) {
      if (trimmed.length > 0) setError('Invalid input — use a marketplace slug, collection address, or NFT mint address.');
      return;
    }
    playUiConfirm();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/api/tools/me-tensor-arb?q=${encodeURIComponent(trimmed)}`, {
        headers: { ...authHeaders() },
      });
      if (r.status === 429) { setError('Rate limited — wait a moment and try again.'); return; }
      if (r.status === 400) { setError('Invalid input.'); return; }
      if (r.status === 503) { setError('Tensor API key not configured on the server — nothing to compare against.'); return; }
      if (!r.ok) { setError(`Lookup failed — HTTP ${r.status}.`); return; }
      const body = await r.json() as ArbResult;
      setResult(body);
      setCheckedAt(Date.now());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const idle = busy || slug.trim().length === 0;
  const listings = result?.listings ?? [];

  return (
    <div className="feed-root page-transition" data-page="tools">
      <div className="scroll-area" style={{ flex: 1, minHeight: 0, overflowY: 'auto', width: '100%', paddingBottom: 72 }}>
      <div style={{ width: '100%', maxWidth: 'var(--tools-max, 1100px)', margin: '0 auto', boxSizing: 'border-box', padding: '20px 4px 14px' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#f0eef8', letterSpacing: '-0.5px' }}>
          ME vs TENSOR ARB
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 11, color: '#9a9ab4', flexWrap: 'wrap' }}>
          <LiveDot />
          <span>read-only · finds ME/MMM listings priced below Tensor&apos;s cheapest active listing for the same collection</span>
        </div>

        <label style={{ display: 'block', marginTop: 16, fontSize: 11, fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase', color: '#9a9ab4' }}>
          Collection slug, collection address, or NFT mint address
        </label>
        <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
          <input
            type="text"
            value={slug}
            onChange={(e) => setSlug(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void run(); }}
            placeholder="e.g. solfussisters0, a collection address, or one NFT's mint address"
            spellCheck={false}
            disabled={busy}
            style={{
              flex: 1, minWidth: 280, padding: '9px 12px', fontSize: 12,
              ...MONO, borderRadius: 5,
              border: '1px solid rgba(168,144,232,0.40)',
              background: 'rgba(20,14,34,0.85)', color: '#f0eef8', outline: 'none',
            }}
          />
          <button
            type="button"
            onClick={() => void run()}
            disabled={idle}
            data-uisnd="skip"
            style={{
              padding: '7px 18px', fontSize: 12, fontWeight: 700,
              letterSpacing: '0.5px', textTransform: 'uppercase', borderRadius: 5,
              cursor: idle ? 'not-allowed' : 'pointer',
              border: '1px solid rgba(168,144,232,0.55)',
              background: idle ? 'rgba(128,104,216,0.15)' : 'linear-gradient(180deg, rgba(128,104,216,0.28) 0%, rgba(128,104,216,0.14) 100%)',
              color: idle ? '#9a9ab4' : '#f0eef8',
              boxShadow: idle ? 'none' : '0 0 12px rgba(128,104,216,0.18)',
              transition: 'all 0.15s',
            }}
          >
            {busy ? 'Checking…' : 'Check'}
          </button>
        </div>

        {error && (
          <div style={{
            marginTop: 12, padding: '8px 12px', fontSize: 12, color: '#d96867',
            background: 'rgba(239,120,120,0.08)', border: '1px solid rgba(239,120,120,0.32)',
            borderRadius: 5,
          }}>
            {error}
          </div>
        )}

        {result && !busy && (
          <div style={{ marginTop: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 11, fontSize: 11.5, color: '#9a9ab4' }}>
              <span style={{ ...MONO, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#c7b479' }}>
                {resolvedViaLabel(result.resolvedVia)}
              </span>
              <span style={{ ...MONO, color: '#c4b8e8' }}>{result.resolvedSlug}</span>
            </div>
            <div style={{ display: 'flex', gap: 11, flexWrap: 'wrap', marginBottom: 11 }}>
              <div style={{ ...PANEL, flex: '1 1 180px', minWidth: 160, marginBottom: 0, padding: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase', color: '#9a9ab4', marginBottom: 6 }}>Tensor floor</div>
                <div style={{ fontSize: 24, fontWeight: 800, color: '#f0eef8', ...MONO, letterSpacing: '-0.5px' }}>
                  {result.tensorFloorSol != null ? `${fmtSol(result.tensorFloorSol)} SOL` : '—'}
                </div>
                <div style={{ fontSize: 11, color: '#9a9ab4', marginTop: 4 }}>{result.tensorListedCount} active Tensor listings</div>
              </div>
              <div style={{ ...PANEL, flex: '1 1 180px', minWidth: 160, marginBottom: 0, padding: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase', color: '#9a9ab4', marginBottom: 6 }}>Below Tensor floor</div>
                <div style={{ fontSize: 24, fontWeight: 800, color: listings.length > 0 ? '#43b984' : '#f0eef8', ...MONO, letterSpacing: '-0.5px' }}>
                  {listings.length}
                </div>
                <div style={{ fontSize: 11, color: '#9a9ab4', marginTop: 4 }}>checked {fmtWhen(checkedAt)}</div>
              </div>
            </div>

            <div style={{ ...PANEL, padding: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase', color: '#9a9ab4', marginBottom: 6 }}>
                Arbitrage candidates
              </div>
              {result.tensorFloorSol == null ? (
                <div style={{ fontSize: 12, color: '#9a9ab4' }}>No active Tensor listings found for this collection — nothing to compare against.</div>
              ) : listings.length === 0 ? (
                <div style={{ fontSize: 12, color: '#9a9ab4' }}>Nothing currently listed below the Tensor floor.</div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr>
                        <th style={TH_L}>Mint</th>
                        <th style={TH_L}>Source</th>
                        <th style={TH}>Price</th>
                        <th style={TH}>vs Tensor</th>
                        <th style={TH}>Listed</th>
                        <th style={TH_L}>Link</th>
                      </tr>
                    </thead>
                    <tbody>
                      {listings.map((l) => (
                        <tr key={l.mint} style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                          <td style={{ padding: '6px 8px', ...MONO }}>{l.nftName ?? short(l.mint)}</td>
                          <td style={{ padding: '6px 8px', color: l.source === 'MMM' ? '#c7b479' : '#9aa6c4' }}>{l.source}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', color: '#43b984', fontWeight: 700, ...MONO }}>{fmtSol(l.priceSol)}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', ...MONO }}>{l.multiple.toFixed(2)}×</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', color: '#9a9ab4', ...MONO }}>{fmtWhen(l.listedAt)}</td>
                          <td style={{ padding: '6px 8px' }}>
                            <a
                              href={`https://magiceden.io/item-details/${l.mint}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ color: '#c4b8e8', textDecoration: 'none' }}
                              onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'underline'; }}
                              onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'none'; }}
                            >open on ME →</a>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            <div style={{ fontSize: 10.5, color: '#6e6688', marginTop: 4 }}>
              cNFT listings can sell out within minutes — re-check before buying. Source: listings-store.ts snapshot (ME direct + MMM sell-side + Tensor active_listings).
            </div>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
