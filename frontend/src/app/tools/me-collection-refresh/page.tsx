'use client';

// VictoryLabs — Tools › ME Collection Refresh (v1).
// Paste a wallet (+ optional collection to narrow it down) → backend walks
// every mint currently owned by that wallet (Helius DAS) and batches Magic
// Eden's own client re-sync call (`rpc/refreshNFTsByMintAddresses`) across
// them. Deliberately wallet-scoped — the real case is a handful of NFTs
// (typically <20) whose ME-cached state drifted, not a whole collection's
// supply. NO wallet connect, NO signing. Refreshes per-NFT metadata
// (owner/name/image/attributes) only — does NOT touch MMM pool/bid state,
// that mechanism is still unknown.
// Data: POST /api/tools/me-collection-refresh?wallet=<address>&collectionAddress=<address optional>

import { useEffect, useRef, useState } from 'react';
import { LiveDot, CtaButton } from '@/soloist/shared';
import { playUiConfirm } from '@/soloist/use-ui-sound';
import { authHeaders } from '@/runtime/auth';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';
const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MONO = "'SF Mono','Fira Code',monospace";

type CollectionKind = 'core' | 'pnft' | 'legacy' | 'sft' | null;
type KindFilter = 'core' | 'pnft_legacy';
interface SearchHit { slug: string; name: string; imageUrl: string | null; }

const PANEL: React.CSSProperties = {
  background: 'linear-gradient(180deg, var(--vl-gray-surface) 0%, var(--vl-gray-surface) 100%)',
  border: '1px solid rgb(var(--vl-purple-tint) / 0.32)',
  borderRadius: 12,
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), 0 16px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4), 0 0 28px rgb(var(--vl-purple-deep) / 0.10)',
  padding: 14,
  marginBottom: 11,
};
const SECTION_LABEL: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase',
  color: 'var(--vl-text-muted)', marginBottom: 6,
};

function StatCard({ label, value, sub, color = 'var(--vl-text-primary)' }: { label: string; value: React.ReactNode; sub?: string; color?: string }) {
  return (
    <div style={{ ...PANEL, flex: '1 1 160px', minWidth: 140, marginBottom: 0, padding: 14 }}>
      <div style={SECTION_LABEL}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 800, color, fontFamily: MONO, letterSpacing: '-0.5px', lineHeight: 1.1 }}>{value}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--vl-text-muted)', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

interface RefreshResult {
  totalMints: number;
  batches: number;
  refreshed: number;
  failedBatches: number;
  cnftSkipped: number;
  rateLimited: boolean;
  skippedMints: number;
}

export default function MeCollectionRefreshPage() {
  useEffect(() => { document.title = 'ME Collection Refresh | VictoryLabs'; }, []);

  const [wallet, setWallet]         = useState('');
  const [collection, setCollection] = useState('');
  // Set once the user PICKS a name-search result — cleared whenever they
  // edit the text afterward, so stale picks can't silently apply.
  const [pickedSlug, setPickedSlug] = useState<string | null>(null);
  const [busy, setBusy]             = useState(false);
  const [error, setError]           = useState<string | null>(null);
  const [result, setResult]         = useState<RefreshResult | null>(null);

  // ── Name search dropdown ──────────────────────────────────────────────
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [hits, setHits]                 = useState<SearchHit[]>([]);
  const [kindBySlug, setKindBySlug]     = useState<Record<string, CollectionKind>>({});
  const [kindFilters, setKindFilters]   = useState<Set<KindFilter>>(new Set());
  const boxRef = useRef<HTMLDivElement | null>(null);

  const toggleKindFilter = (f: KindFilter) => {
    setKindFilters((prev) => {
      const next = new Set(prev);
      if (next.has(f)) next.delete(f); else next.add(f);
      return next;
    });
  };

  // Debounced name search — gated behind a valid wallet already being
  // entered (no point resolving/searching collections for a refresh that
  // has nowhere to run yet), and skips entirely for address-shaped input
  // (existing direct-address flow, unchanged).
  const walletReady = ADDR_RE.test(wallet.trim());
  useEffect(() => {
    const q = collection.trim();
    if (!walletReady || ADDR_RE.test(q) || q.length < 2) { setHits([]); setDropdownOpen(false); return; }
    const t = setTimeout(() => {
      fetch(`${API_BASE}/api/collections/search?q=${encodeURIComponent(q)}`)
        .then((r) => (r.ok ? r.json() : { results: [] }))
        .then((data: { results?: SearchHit[] }) => {
          setHits(data.results ?? []);
          setDropdownOpen(true);
        })
        .catch(() => { /* transient — next keystroke refires */ });
    }, 300);
    return () => clearTimeout(t);
  }, [collection, walletReady]);

  // Lazily fetch + cache asset-standard kind for whatever's currently shown
  // — but only once the user has actually engaged the type toggle. Before
  // that, the dropdown is unfiltered anyway, so the kind lookup (a
  // slug→sampleMint→DAS round-trip per result) would just be wasted work
  // on every keystroke.
  useEffect(() => {
    if (kindFilters.size === 0) return;
    for (const h of hits) {
      if (h.slug in kindBySlug) continue;
      setKindBySlug((prev) => ({ ...prev, [h.slug]: undefined as unknown as CollectionKind }));
      fetch(`${API_BASE}/api/tools/me-collection-refresh/kind?slug=${encodeURIComponent(h.slug)}`)
        .then((r) => (r.ok ? r.json() : { kind: null }))
        .then((data: { kind?: CollectionKind }) => {
          setKindBySlug((prev) => ({ ...prev, [h.slug]: data.kind ?? null }));
        })
        .catch(() => { setKindBySlug((prev) => ({ ...prev, [h.slug]: null })); });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hits, kindFilters]);

  // Close dropdown on outside click.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setDropdownOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const visibleHits = hits.filter((h) => {
    if (kindFilters.size === 0) return true;
    const k = kindBySlug[h.slug];
    if (k === undefined) return true; // still loading — don't hide yet
    if (kindFilters.has('core') && k === 'core') return true;
    if (kindFilters.has('pnft_legacy') && (k === 'pnft' || k === 'legacy')) return true;
    return false;
  });

  const pickHit = (h: SearchHit) => {
    playUiConfirm();
    setCollection(h.name);
    setPickedSlug(h.slug);
    setDropdownOpen(false);
  };

  const run = async () => {
    const trimmedWallet = wallet.trim();
    const trimmedColl   = collection.trim();
    if (busy || !ADDR_RE.test(trimmedWallet)) return;
    const collIsAddress = ADDR_RE.test(trimmedColl);
    if (trimmedColl && !collIsAddress && !pickedSlug) return; // free-typed name, not yet resolved to a slug
    playUiConfirm();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const params = new URLSearchParams({ wallet: trimmedWallet });
      if (collIsAddress) params.set('collectionAddress', trimmedColl);
      else if (pickedSlug) params.set('collectionSlug', pickedSlug);
      const r = await fetch(`${API_BASE}/api/tools/me-collection-refresh?${params.toString()}`, {
        method: 'POST',
        headers: { ...authHeaders() },
      });
      if (r.status === 429) { setError('Rate limited — wait a moment and try again.'); return; }
      if (r.status === 400) { setError('Invalid address — paste a base58 Solana wallet (and, optionally, collection) address.'); return; }
      if (r.status === 404) { setError(`Couldn't resolve "${collection.trim()}" to an on-chain collection — try picking it from the dropdown again.`); return; }
      if (r.status === 502) { setError('Refresh failed (DAS/ME error) — try again shortly.'); return; }
      if (!r.ok)            { setError(`Refresh failed — HTTP ${r.status}.`); return; }
      const body = await r.json() as { ok: boolean } & Partial<RefreshResult> & { error?: string };
      if (!body.ok) { setError(body.error ?? 'Refresh failed.'); return; }
      setResult({
        totalMints: body.totalMints ?? 0,
        batches: body.batches ?? 0,
        refreshed: body.refreshed ?? 0,
        failedBatches: body.failedBatches ?? 0,
        cnftSkipped: body.cnftSkipped ?? 0,
        rateLimited: body.rateLimited ?? false,
        skippedMints: body.skippedMints ?? 0,
      });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const collTrimmed = collection.trim();
  const collIsAddress = ADDR_RE.test(collTrimmed);
  const idle = busy || !ADDR_RE.test(wallet.trim())
    || (collTrimmed.length > 0 && !collIsAddress && !pickedSlug);

  return (
    <div className="feed-root page-transition" data-page="tools">
      <div className="scroll-area" style={{ flex: 1, minHeight: 0, overflowY: 'auto', width: '100%', paddingBottom: 72 }}>
      <div style={{ width: '100%', maxWidth: 'var(--tools-max, 1100px)', margin: '0 auto', boxSizing: 'border-box', padding: '20px 4px 14px' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700, color: 'var(--vl-text-primary)', letterSpacing: '-0.5px' }}>
          ME COLLECTION REFRESH
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 11, color: 'var(--vl-text-muted)', flexWrap: 'wrap' }}>
          <LiveDot />
          <span>read-only trigger · force-resyncs Magic Eden&apos;s own per-NFT index (owner/name/image/attributes) for a wallet&apos;s NFTs, batched — does NOT refresh MMM pool/bid state</span>
        </div>

        <label style={{ display: 'block', marginTop: 16, fontSize: 11, fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase', color: 'var(--vl-text-muted)' }}>
          Wallet address
        </label>
        <div style={{ display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
          <input
            type="text"
            value={wallet}
            onChange={(e) => setWallet(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void run(); }}
            placeholder="Wallet address — refreshes every NFT it currently owns…"
            spellCheck={false}
            disabled={busy}
            style={{
              flex: 1, minWidth: 280, padding: '9px 12px', fontSize: 12,
              fontFamily: MONO, borderRadius: 5,
              border: '1px solid rgb(var(--vl-purple-tint) / 0.40)',
              background: 'rgba(20,14,34,0.85)', color: 'var(--vl-text-primary)', outline: 'none',
            }}
          />
        </div>

        <label style={{ display: 'block', marginTop: 12, fontSize: 11, fontWeight: 700, letterSpacing: '0.5px', textTransform: 'uppercase', color: 'var(--vl-text-muted)' }}>
          Collection (optional — narrows to just this collection)
        </label>

        {/* Asset-standard toggle — narrows the search dropdown below.
            Multi-select: none selected shows everything. */}
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          {([['core', 'MPL CORE'], ['pnft_legacy', 'PNFT + LEGACY']] as const).map(([f, label]) => {
            const active = kindFilters.has(f);
            return (
              <button
                key={f}
                type="button"
                onClick={() => toggleKindFilter(f)}
                data-uisnd="skip"
                style={{
                  padding: '4px 10px', fontSize: 10.5, fontWeight: 800, letterSpacing: '0.4px',
                  borderRadius: 5, cursor: 'pointer', fontFamily: MONO,
                  border: `1px solid ${active ? 'rgb(var(--vl-purple-tint) / 0.70)' : 'rgb(var(--vl-purple-tint) / 0.30)'}`,
                  background: active ? 'rgb(var(--vl-purple-tint) / 0.22)' : 'rgb(var(--vl-purple-tint) / 0.06)',
                  color: active ? 'var(--vl-text-primary)' : 'var(--vl-text-muted)',
                }}
              >{label}</button>
            );
          })}
        </div>

        <div ref={boxRef} style={{ position: 'relative', display: 'flex', gap: 8, marginTop: 6, flexWrap: 'wrap' }}>
          <input
            type="text"
            value={collection}
            onChange={(e) => { setCollection(e.target.value); setPickedSlug(null); }}
            onFocus={() => { if (hits.length > 0) setDropdownOpen(true); }}
            onKeyDown={(e) => { if (e.key === 'Enter' && !dropdownOpen) void run(); }}
            placeholder={walletReady
              ? 'Search by collection name, or paste its on-chain address — leave blank for ALL of the wallet\'s NFTs…'
              : 'Enter a wallet address above first…'}
            spellCheck={false}
            disabled={busy || !walletReady}
            style={{
              flex: 1, minWidth: 280, padding: '9px 12px', fontSize: 12,
              fontFamily: MONO, borderRadius: 5,
              border: `1px solid ${pickedSlug || collIsAddress ? 'rgb(var(--vl-green-primary) / 0.45)' : 'rgb(var(--vl-purple-tint) / 0.40)'}`,
              background: 'rgba(20,14,34,0.85)', color: 'var(--vl-text-primary)', outline: 'none',
            }}
          />
          <CtaButton onClick={() => void run()} disabled={idle} ownSound>
            {busy ? 'Refreshing…' : 'Refresh'}
          </CtaButton>

          {dropdownOpen && visibleHits.length > 0 && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, right: 0, marginTop: 4, zIndex: 20,
              maxHeight: 320, overflowY: 'auto', borderRadius: 8,
              border: '1px solid rgb(var(--vl-purple-tint) / 0.40)',
              background: 'rgba(16,11,28,0.98)', boxShadow: '0 16px 40px rgba(0,0,0,0.6)',
            }}>
              {visibleHits.map((h) => {
                const k = kindBySlug[h.slug];
                const kindLabel = k === 'core' ? 'CORE' : k === 'pnft' ? 'PNFT' : k === 'legacy' ? 'LEGACY' : k === 'sft' ? 'SFT' : k === null ? '?' : '…';
                return (
                  <button
                    key={h.slug}
                    type="button"
                    onClick={() => pickHit(h)}
                    data-uisnd="skip"
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%',
                      textAlign: 'left', padding: '8px 10px', cursor: 'pointer', border: 'none',
                      borderBottom: '1px solid rgba(255,255,255,0.05)',
                      background: 'transparent', color: 'var(--vl-text-primary)',
                    }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'rgb(var(--vl-purple-tint) / 0.10)'; }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLButtonElement).style.background = 'transparent'; }}
                  >
                    <span style={{ fontSize: 12.5, fontWeight: 600 }}>{h.name}</span>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 10, fontFamily: MONO, color: 'var(--vl-text-muted)' }}>{h.slug}</span>
                      {kindFilters.size > 0 && (
                        <span style={{
                          fontSize: 9.5, fontWeight: 800, fontFamily: MONO, padding: '2px 6px', borderRadius: 4,
                          color: '#9aa6c4', background: 'rgb(var(--vl-purple-tint) / 0.14)',
                        }}>{kindLabel}</span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {error && (
          <div style={{
            marginTop: 12, padding: '8px 12px', fontSize: 12, color: 'var(--vl-red-primary)',
            background: 'rgb(var(--vl-red-glow) / 0.08)', border: '1px solid rgb(var(--vl-red-glow) / 0.32)',
            borderRadius: 5,
          }}>
            {error}
          </div>
        )}

        {busy && !error && (
          <div style={{ marginTop: 12, fontSize: 12, color: 'var(--vl-text-muted)' }}>
            Walking collection mints and batching Magic Eden re-sync calls — large collections can take a few seconds…
          </div>
        )}

        {result && !busy && (
          <div style={{ marginTop: 16 }}>
            <div style={{ display: 'flex', gap: 11, flexWrap: 'wrap', marginBottom: 11 }}>
              <StatCard label="Mints found" value={result.totalMints.toLocaleString('en-US')} color="#c4b8e8" />
              <StatCard label="Refreshed"   value={result.refreshed.toLocaleString('en-US')} color="var(--vl-green-primary)" />
              <StatCard label="Batches"     value={result.batches} sub="100 mints/batch" color="#9aa6c4" />
              <StatCard
                label="Failed batches"
                value={result.failedBatches}
                color={result.failedBatches > 0 ? 'var(--vl-red-primary)' : 'var(--vl-text-primary)'}
              />
              <StatCard
                label="cNFTs skipped"
                value={result.cnftSkipped.toLocaleString('en-US')}
                sub="pNFT / legacy / Core only"
                color="#9aa6c4"
              />
            </div>
            {result.rateLimited && (
              <div style={{
                padding: '8px 12px', fontSize: 12, color: 'var(--vl-gold-primary)',
                background: 'rgba(232,193,74,0.08)', border: '1px solid rgba(232,193,74,0.32)',
                borderRadius: 5, marginBottom: 8,
              }}>
                ⚠ Magic Eden rate-limited us — scan stopped early. {result.skippedMints.toLocaleString('en-US')} mints were never attempted (not failures, just not reached). Wait a bit and re-run to pick up the rest.
              </div>
            )}
            {!result.rateLimited && result.failedBatches === 0 && result.totalMints > 0 && (
              <div style={{ fontSize: 12, color: 'var(--vl-green-primary)' }}>
                ✓ All {result.totalMints.toLocaleString('en-US')} mints refreshed cleanly.
              </div>
            )}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
