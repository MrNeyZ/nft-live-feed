'use client';

// VictoryLabs — Tools › Holders (MVP).
// Read-only exact NFT collection holder count. Paste a collection address →
// backend paginates Helius DAS getAssetsByGroup and returns the distinct-owner
// count (source of truth = on-chain ownership, NOT Magic Eden / Tensor cached
// stats). NO wallet connect, NO signing, NO tx building.
// Data: GET /api/tools/holders/analyze?collection=<collectionAddress>

import { useEffect, useState } from 'react';
import { LiveDot } from '@/soloist/shared';
import { playUiConfirm } from '@/soloist/use-ui-sound';
import { authHeaders } from '@/runtime/auth';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

// ── Mirror of backend HoldersAnalysis (src/tools-holders/types.ts) ──────────
interface HolderEntry { wallet: string; count: number; percent: number; }
interface HolderDistribution {
  holders1: number; holders2to5: number; holders6to10: number; holders11plus: number;
}
interface HoldersAnalysis {
  inputType:         'collection' | 'slug' | 'name';
  inputValue:        string;
  resolvedCollectionAddress: string;
  resolvedName?:     string;
  collectionAddress: string;
  totalAssets:       number;
  uniqueHolders:     number;
  updatedAt:         string;
  topHolders:        HolderEntry[];
  holderDistribution:HolderDistribution;
  warnings:          string[];
}

interface NameCandidate { slug: string; name: string; }

// Input classification, in priority order (mirrors the backend): a base58
// pubkey → `collection`; a slug-shaped token (alnum + _- , no spaces) → `slug`;
// anything else (spaces / punctuation, i.e. a plain name) → `name`.
const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SLUG_RE = /^[a-z0-9_-]+$/i;
function classifyInput(v: string): 'collection' | 'slug' | 'name' {
  if (ADDR_RE.test(v)) return 'collection';
  if (SLUG_RE.test(v)) return 'slug';
  return 'name';
}

const PANEL: React.CSSProperties = {
  background: 'linear-gradient(180deg, #1a1530 0%, #1a1530 100%)',
  border: '1px solid rgba(168,144,232,0.32)',
  borderRadius: 12,
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), 0 16px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4), 0 0 28px rgba(128,104,216,0.10)',
  padding: 12,
  marginBottom: 11,
};
const SECTION_LABEL: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase',
  color: '#9a9ab4', marginBottom: 6,
};
const MONO = "'SF Mono','Fira Code',monospace";

function shortAddr(s: string): string {
  return s.length > 12 ? `${s.slice(0, 5)}…${s.slice(-5)}` : s;
}
function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}
function fmtWhen(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString('en-US', { hour12: false });
  } catch { return iso; }
}

// Big stat card (Unique holders / Total NFTs / Top holder / Updated).
function StatCard({ label, value, sub, color = '#f0eef8' }: { label: string; value: React.ReactNode; sub?: string; color?: string }) {
  return (
    <div style={{ ...PANEL, flex: '1 1 180px', minWidth: 160, marginBottom: 0, padding: 14 }}>
      <div style={SECTION_LABEL}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, color, fontFamily: MONO, letterSpacing: '-0.5px', lineHeight: 1.1, wordBreak: 'break-word' }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: '#9a9ab4', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

export default function HoldersPage() {
  useEffect(() => { document.title = 'Holders | VictoryLabs'; }, []);

  const [collection, setCollection] = useState('');
  const [busy, setBusy]             = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [analysis, setAnalysis]     = useState<HoldersAnalysis | null>(null);
  const [candidates, setCandidates] = useState<NameCandidate[] | null>(null);
  const [raw, setRaw]               = useState<unknown>(null);
  const [copied, setCopied]         = useState(false);

  // Run with an explicit param/value. Factored out so an ambiguous-name
  // candidate can re-run directly as a slug with one click.
  const analyze = async (param: 'collection' | 'slug' | 'name', value: string) => {
    if (busy || value.length === 0) return;
    playUiConfirm();
    setBusy(true);
    setError(null);
    setCandidates(null);
    try {
      const r = await fetch(`${API_BASE}/api/tools/holders/analyze?${param}=${encodeURIComponent(value)}`, {
        headers: { ...authHeaders() },
      });
      if (r.status === 429) { setError('Rate limited — wait a moment and try again.'); return; }
      if (r.status === 400) {
        setError(
          param === 'name' ? 'Invalid name — type at least 2 characters, or paste the slug/address.'
          : param === 'slug' ? 'Invalid slug — use the marketplace collection slug, or paste the collection address.'
          : 'Invalid collection address — paste a base58 Solana collection address.',
        );
        return;
      }
      if (r.status === 409) {
        // Ambiguous name — surface the candidates instead of guessing.
        const body = await r.json() as { candidates?: NameCandidate[] };
        setCandidates(body.candidates ?? []);
        setError(`"${value}" matches multiple verified collections — pick one below.`);
        return;
      }
      if (r.status === 404) {
        setError(
          param === 'name' ? `No verified collection found for "${value}" — check the name, or paste the slug/address.`
          : `Couldn't resolve slug "${value}" to a collection — check the slug, or paste the collection address instead.`,
        );
        return;
      }
      if (r.status === 502) { setError('On-chain lookup failed (RPC error) — try again shortly.'); return; }
      if (!r.ok)            { setError(`Analyze failed — HTTP ${r.status}.`); return; }
      const body = await r.json() as { ok: boolean; analysis?: HoldersAnalysis; error?: string };
      if (!body.ok || !body.analysis) { setError(body.error ?? 'Analyze failed.'); return; }
      setAnalysis(body.analysis);
      setRaw(body);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const run = () => {
    const trimmed = collection.trim();
    if (trimmed.length === 0) return;
    // address → collection (unchanged) · slug-shaped → slug · else → name.
    void analyze(classifyInput(trimmed), trimmed);
  };

  const copyJson = async () => {
    if (raw == null) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(raw, null, 2));
      playUiConfirm();
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Copy failed — clipboard unavailable in this browser.');
    }
  };

  const top = analysis?.topHolders ?? [];
  const dist = analysis?.holderDistribution;
  const idle = busy || collection.trim().length === 0;

  return (
    <div className="feed-root page-transition" data-page="tools">
      <div className="scroll-area" style={{ flex: 1, minHeight: 0, overflowY: 'auto', width: '100%', paddingBottom: 72 }}>
      <div style={{ width: '100%', maxWidth: 'var(--tools-max, 1100px)', margin: '0 auto', boxSizing: 'border-box', padding: '20px 4px 14px' }}>
        {/* Header */}
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#f0eef8', letterSpacing: '-0.5px' }}>
          HOLDERS
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 11, color: '#9a9ab4', flexWrap: 'wrap' }}>
          <LiveDot />
          <span>read-only · exact distinct-owner count from on-chain ownership (Helius DAS) — not marketplace cached stats</span>
        </div>

        {/* Input */}
        <label style={{ display: 'block', marginTop: 16, fontSize: 11, fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase', color: '#9a9ab4' }}>
          Collection address, slug, or name
        </label>
        <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
          <input
            type="text"
            value={collection}
            onChange={(e) => setCollection(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') run(); }}
            placeholder="Collection address, marketplace slug, or name…"
            spellCheck={false}
            disabled={busy}
            style={{
              flex: 1, minWidth: 280, padding: '9px 12px', fontSize: 12,
              fontFamily: MONO, borderRadius: 5,
              border: '1px solid rgba(168,144,232,0.40)',
              background: 'rgba(20,14,34,0.85)', color: '#f0eef8', outline: 'none',
            }}
          />
          <button
            type="button"
            onClick={run}
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
            {busy ? 'Counting…' : 'Analyze'}
          </button>
        </div>

        {/* Error */}
        {error && (
          <div style={{
            marginTop: 12, padding: '8px 12px', fontSize: 12, color: '#d96867',
            background: 'rgba(239,120,120,0.08)', border: '1px solid rgba(239,120,120,0.32)',
            borderRadius: 5,
          }}>
            {error}
          </div>
        )}

        {/* Ambiguous-name candidates — never auto-pick; let the user choose.
            Each resolves directly by its unambiguous slug. */}
        {candidates && candidates.length > 0 && !busy && (
          <div style={{ ...PANEL, marginTop: 12, padding: 12, border: '1px solid rgba(232,193,74,0.34)', background: 'rgba(232,193,74,0.06)' }}>
            <div style={{ ...SECTION_LABEL, color: '#c7b479' }}>Multiple matches — pick one</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {candidates.map((c) => (
                <button
                  key={c.slug}
                  type="button"
                  onClick={() => { setCollection(c.slug); void analyze('slug', c.slug); }}
                  data-uisnd="skip"
                  style={{
                    display: 'flex', alignItems: 'baseline', gap: 8, textAlign: 'left',
                    padding: '7px 10px', borderRadius: 5, cursor: 'pointer',
                    border: '1px solid rgba(168,144,232,0.30)', background: 'rgba(168,144,232,0.08)',
                    color: '#f0eef8',
                  }}
                >
                  <span style={{ fontSize: 12.5, fontWeight: 700 }}>{c.name}</span>
                  <span style={{ fontSize: 11, fontFamily: MONO, color: '#9a9ab4' }}>{c.slug}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Loading hint */}
        {busy && !error && (
          <div style={{ marginTop: 12, fontSize: 12, color: '#9a9ab4' }}>
            Walking on-chain assets — large collections can take a few seconds…
          </div>
        )}

        {/* Results */}
        {analysis && !busy && (
          <div style={{ marginTop: 16 }}>
            {/* Stat cards */}
            <div style={{ display: 'flex', gap: 11, flexWrap: 'wrap', marginBottom: 11 }}>
              <StatCard label="Unique holders" value={fmtNum(analysis.uniqueHolders)} color="#43b984" />
              <StatCard label="Total NFTs"     value={fmtNum(analysis.totalAssets)} color="#c4b8e8" />
              <StatCard
                label="Top holder"
                value={top[0] ? shortAddr(top[0].wallet) : '—'}
                sub={top[0] ? `${fmtNum(top[0].count)} NFTs · ${top[0].percent}%` : undefined}
                color="#c7b479"
              />
              <StatCard label="Updated" value={fmtWhen(analysis.updatedAt)} color="#9aa6c4" />
            </div>

            {/* Resolved collection — always shown; for slug input it proves
                which on-chain address the count was computed against. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 11, fontSize: 11.5, color: '#9a9ab4' }}>
              <span style={{ fontFamily: MONO, textTransform: 'uppercase', letterSpacing: '0.5px', color: '#c7b479' }}>
                {analysis.resolvedName
                  ? `${analysis.resolvedName} →`
                  : analysis.inputType === 'slug' ? `slug "${analysis.inputValue}" →`
                  : analysis.inputType === 'name' ? `"${analysis.inputValue}" →`
                  : 'collection'}
              </span>
              <a
                href={`https://solscan.io/token/${analysis.resolvedCollectionAddress}`}
                target="_blank"
                rel="noopener noreferrer"
                style={{ fontFamily: MONO, color: '#c4b8e8', textDecoration: 'none' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'underline'; }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'none'; }}
              >{analysis.resolvedCollectionAddress}</a>
            </div>

            {/* Copy JSON */}
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
              <button
                type="button"
                onClick={copyJson}
                data-uisnd="skip"
                style={{
                  padding: '3px 9px', fontSize: 9.5, fontWeight: 800, letterSpacing: '0.5px',
                  borderRadius: 4, cursor: 'pointer', fontFamily: MONO,
                  border: '1px solid rgba(168,144,232,0.45)',
                  background: copied ? 'rgba(126,217,168,0.16)' : 'rgba(168,144,232,0.10)',
                  color: copied ? '#43b984' : '#c4b8e8',
                  transition: 'all 0.15s',
                }}
              >{copied ? 'COPIED ✓' : 'COPY JSON'}</button>
            </div>

            {/* Warnings */}
            {analysis.warnings.length > 0 && (
              <div style={{ ...PANEL, padding: 12, border: '1px solid rgba(232,193,74,0.34)', background: 'rgba(232,193,74,0.06)' }}>
                <div style={{ ...SECTION_LABEL, color: '#c7b479' }}>Warnings</div>
                <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: '#d8cda6', lineHeight: 1.5 }}>
                  {analysis.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              </div>
            )}

            {/* Holder distribution */}
            {dist && (
              <div style={{ ...PANEL, padding: 14 }}>
                <div style={SECTION_LABEL}>Holder distribution</div>
                <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                  {([
                    ['Hold 1', dist.holders1],
                    ['Hold 2–5', dist.holders2to5],
                    ['Hold 6–10', dist.holders6to10],
                    ['Hold 11+', dist.holders11plus],
                  ] as const).map(([label, n]) => (
                    <div key={label} style={{ flex: '1 1 120px', minWidth: 110, padding: '10px 12px', borderRadius: 8, background: 'rgba(168,144,232,0.06)', border: '1px solid rgba(168,144,232,0.22)' }}>
                      <div style={{ fontSize: 18, fontWeight: 800, color: '#f0eef8', fontFamily: MONO }}>{fmtNum(n)}</div>
                      <div style={{ fontSize: 10.5, color: '#9a9ab4', marginTop: 2, textTransform: 'uppercase', letterSpacing: '0.5px' }}>{label}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Top holders table */}
            <div style={{ ...PANEL, padding: 14 }}>
              <div style={SECTION_LABEL}>Top holders (max 25)</div>
              {top.length === 0 ? (
                <div style={{ fontSize: 12, color: '#9a9ab4' }}>No holders to show.</div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ color: '#9a9ab4', textAlign: 'left' }}>
                        <th style={{ padding: '6px 8px', fontWeight: 700, letterSpacing: '0.5px', fontSize: 10.5, textTransform: 'uppercase' }}>#</th>
                        <th style={{ padding: '6px 8px', fontWeight: 700, letterSpacing: '0.5px', fontSize: 10.5, textTransform: 'uppercase' }}>Wallet</th>
                        <th style={{ padding: '6px 8px', fontWeight: 700, letterSpacing: '0.5px', fontSize: 10.5, textTransform: 'uppercase', textAlign: 'right' }}>NFTs</th>
                        <th style={{ padding: '6px 8px', fontWeight: 700, letterSpacing: '0.5px', fontSize: 10.5, textTransform: 'uppercase', textAlign: 'right' }}>% supply</th>
                      </tr>
                    </thead>
                    <tbody>
                      {top.map((h, i) => (
                        <tr key={h.wallet} style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                          <td style={{ padding: '6px 8px', color: '#9a9ab4', fontFamily: MONO }}>{i + 1}</td>
                          <td style={{ padding: '6px 8px', fontFamily: MONO }}>
                            <a
                              href={`https://solscan.io/account/${h.wallet}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={{ color: '#c4b8e8', textDecoration: 'none' }}
                              onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'underline'; }}
                              onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.textDecoration = 'none'; }}
                            >{shortAddr(h.wallet)}</a>
                          </td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', color: '#f0eef8', fontFamily: MONO, fontWeight: 700 }}>{fmtNum(h.count)}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', color: '#9aa6c4', fontFamily: MONO }}>{h.percent}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div style={{ fontSize: 10.5, color: '#6e6688', marginTop: 4 }}>
              Source: Helius DAS getAssetsByGroup (groupKey=collection). Holder = distinct on-chain owner wallet.
            </div>
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
