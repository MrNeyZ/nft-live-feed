'use client';

// VictoryLabs — Tools › VVV Stages.
// Paste a vvv.so mint page link, get its whitelist stages (name, price,
// window, minted/cap) + eligible collections per stage, laid out in our
// own interface instead of vvv.so's page.
//
// vvv.so sits behind a Vercel bot-checkpoint that blocks server-side
// fetches from this VPS (confirmed: curl AND headless/headed Playwright
// both get a 429 "Code 10" challenge) — so there is no backend route here.
// Data comes from a Tampermonkey userscript (public/vvv-vl-bridge.user.js)
// that runs in the user's own real browser tab, opened as a popup from
// this page: it calls vvv.so's own get-collection-details API same-origin
// (real cookies, passes the checkpoint) and posts the JSON back via
// window.postMessage. Requires the userscript installed once.
//
// Cached per-slug in localStorage so revisiting a slug doesn't need a
// fresh popup unless the user asks to refresh.
//
// Presentation-only redesign pass — parsing/fetch/message-bridge logic is
// unchanged; only the render below (and the `.vvv-*` rules in
// globals.css) changed shape.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LiveDot, CtaButton, ItemThumb } from '@/soloist/shared';
import { VL, VLText, ALPHA, rgb, alpha, type RGB } from '@/lib/palette';
import { MONO, PANEL, ToolTextInput, short } from '@/app/tools/mmm-shared';

const VVV_ORIGIN = 'https://www.vvv.so';
const CACHE_PREFIX = 'vl.vvv.cache.';
const USERSCRIPT_URL = '/vvv-vl-bridge.user.js';

interface WhitelistStage {
  id: string;
  name: string;
  start_time: string;
  end_time: string;
  mint_price: number;
  minted_count: number;
  max_mints_total: number;
  max_mints_per_wallet: number;
  whitelist_type: string;
  min_nfts_in_collection?: number;
  custom_addresses?: string[];
  whitelisted_coins?: { mint: string; min_balance: number }[];
  whitelisted_coin_symbols?: string[];
  whitelisted_collections?: string[];
  whitelisted_collection_symbols?: string[];
}
interface CollectionDetails {
  name: string;
  symbol: string;
  slug: string;
  description?: string;
  price_per_nft: number;
  collection_size: number;
  collection_image_url?: string;
  launch_date?: string;
  whitelist_settings: WhitelistStage[];
}
interface ApiPayload {
  collection: CollectionDetails;
  numMinted: string;
}

type StageStatus = 'live' | 'upcoming' | 'ended';

const STATUS_META: Record<StageStatus, { label: string; color: string; bg: string; border: string }> = {
  live:     { label: 'LIVE',     color: 'var(--vl-green-primary)', bg: alpha(VL.green, ALPHA.tint), border: alpha(VL.green, ALPHA.glow) },
  upcoming: { label: 'UPCOMING', color: 'var(--vl-gold-primary)',  bg: alpha(VL.gold, ALPHA.tint),  border: alpha(VL.gold, ALPHA.glowSoft) },
  ended:    { label: 'ENDED',    color: 'var(--vl-text-muted)',    bg: 'rgba(255,255,255,0.03)',    border: 'rgba(255,255,255,0.08)' },
};
// Display order — live first (can't be missed), then upcoming, ended last
// so closed stages never compete visually with anything actionable.
const STATUS_ORDER: Record<StageStatus, number> = { live: 0, upcoming: 1, ended: 2 };

function parseSlug(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const m = /vvv\.so\/([a-zA-Z0-9_-]+)/i.exec(trimmed);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]+$/.test(trimmed)) return trimmed;
  return null;
}

function stageStatusOf(stage: WhitelistStage, nowMs: number): StageStatus {
  const start = Date.parse(stage.start_time);
  const end = Date.parse(stage.end_time);
  if (nowMs < start) return 'upcoming';
  if (nowMs > end) return 'ended';
  return 'live';
}

// Two short, non-wrapping lines instead of one long "start → end" string —
// the single-line version wrapped mid-date on narrow columns.
function fmtStamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function fmtInt(n: number): string { return n.toLocaleString(); }

// vvv.so only ever gives us the on-chain collection address (no Tensor
// slug), so link straight to it — Tensor's /trade/ route resolves a raw
// collection mint the same as a slug.
function tensorCollectionUrl(collectionAddress: string): string {
  return `https://www.tensor.trade/trade/${collectionAddress}`;
}
function birdeyeTokenUrl(mint: string): string {
  return `https://birdeye.so/token/${mint}?chain=solana`;
}

function loadCache(slug: string): ApiPayload | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + slug);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
function saveCache(slug: string, data: ApiPayload): void {
  try { localStorage.setItem(CACHE_PREFIX + slug, JSON.stringify(data)); } catch { /* ignore */ }
}

// ── small presentational pieces ─────────────────────────────────────────

/** Big value / small caps label pair — the collection hero's stat blocks. */
function StatTile({ value, label, accent }: { value: React.ReactNode; label: string; accent?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 92 }}>
      <span style={{ fontSize: 17, fontWeight: 800, color: accent ?? VLText.primary, ...MONO, fontVariantNumeric: 'tabular-nums', letterSpacing: '-0.2px' }}>
        {value}
      </span>
      <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.7px', textTransform: 'uppercase', color: VLText.faint }}>
        {label}
      </span>
    </div>
  );
}

/** Compact per-stage metric (price / minted / limit) — label above value,
 *  small enough to sit three-across in a row without breaking density. */
function MetricChip({ label, value, strong }: { label: string; value: React.ReactNode; strong?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <span style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase', color: VLText.faint }}>
        {label}
      </span>
      <span style={{
        fontSize: 12.5, fontWeight: strong ? 800 : 600, ...MONO, fontVariantNumeric: 'tabular-nums',
        color: strong ? rgb(VL.blue) : VLText.primary,
      }}>
        {value}
      </span>
    </div>
  );
}

/** Non-interactive eligibility-kind tag — same visual language as the
 *  active `Pill` state, but a `<span>` (not a `<button>`): these label
 *  data, they don't do anything on click, so they must not pick up the
 *  browser's native button chrome. */
function KindTag({ label, color }: { label: string; color: RGB }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center',
      padding: '3px 9px', fontSize: 10.5, fontWeight: 600, borderRadius: 4, letterSpacing: '0.3px',
      border: `1px solid ${alpha(color, ALPHA.borderStrong)}`, background: alpha(color, ALPHA.tint), color: rgb(color),
    }}>
      {label}
    </span>
  );
}

/** Whole eligibility chip is the link (to Tensor/Birdeye) — the marketplace
 *  logo inside is just a "this is a Tensor/Birdeye-tracked asset" indicator,
 *  not a separate click target. One link per collection/token, so N
 *  entries in a stage stays compact instead of spawning N extra rows. */
function EligibilityChip({ href, title, style, children }: { href: string; title: string; style: React.CSSProperties; children: React.ReactNode }) {
  const [hover, setHover] = useState(false);
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        ...style,
        borderColor: hover ? alpha(VL.purpleTint, 0.5) : style.borderColor,
        background: hover ? 'rgba(255,255,255,0.07)' : style.background,
      }}
    >
      {children}
    </a>
  );
}

function StatusBadge({ status }: { status: StageStatus }) {
  const m = STATUS_META[status];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '2px 7px', borderRadius: 4, fontSize: 9.5, fontWeight: 800, letterSpacing: '0.6px',
      color: m.color, background: m.bg, border: `1px solid ${m.border}`, flexShrink: 0,
    }}>
      {status === 'live' && (
        <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'currentColor', boxShadow: '0 0 5px currentColor' }} />
      )}
      {m.label}
    </span>
  );
}

/** Type-tagged eligibility read-out — NFT hold / token balance / off-chain
 *  allowlist / public read as visually distinct kinds, not one grey blob. */
function EligibilityBlock({ stage }: { stage: WhitelistStage }) {
  const collections = stage.whitelisted_collections ?? [];
  const symbols = stage.whitelisted_collection_symbols ?? [];
  const coins = stage.whitelisted_coins ?? [];
  const coinSymbols = stage.whitelisted_coin_symbols ?? [];

  const chipStyle: React.CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    fontSize: 10.5, ...MONO, padding: '2px 5px 2px 7px', borderRadius: 5,
    background: 'rgba(255,255,255,0.04)', border: `1px solid ${alpha(VL.purpleTint, 0.25)}`,
    color: VLText.primary, textDecoration: 'none', cursor: 'pointer',
    transition: 'border-color 0.12s, background 0.12s',
  };

  if (stage.whitelist_type === 'nft' && collections.length > 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <KindTag label="NFT" color={VL.purpleTint} />
        {collections.map((addr, i) => (
          <EligibilityChip key={addr} href={tensorCollectionUrl(addr)} title={`${addr} — open on Tensor`} style={chipStyle}>
            {symbols[i] || short(addr)}
            <img src="/brand/tensor.png" alt="Tensor" width={12} height={12} draggable={false} style={{ display: 'block', borderRadius: 2, flexShrink: 0 }} />
          </EligibilityChip>
        ))}
        {collections.length > 1 && <span style={{ fontSize: 9.5, color: VLText.faint }}>hold any 1</span>}
      </div>
    );
  }
  if (stage.whitelist_type === 'coin' && coins.length > 0) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
        <KindTag label="TOKEN" color={VL.blue} />
        {coins.map((c, i) => (
          <EligibilityChip key={c.mint} href={birdeyeTokenUrl(c.mint)} title={`${c.mint} — open on Birdeye`} style={chipStyle}>
            {coinSymbols[i] || short(c.mint)} ≥{c.min_balance.toLocaleString()}
            <img src="/brand/birdeye.png" alt="Birdeye" width={12} height={12} draggable={false} style={{ display: 'block', borderRadius: 2, flexShrink: 0 }} />
          </EligibilityChip>
        ))}
        {coins.length > 1 && <span style={{ fontSize: 9.5, color: VLText.faint }}>hold any 1</span>}
      </div>
    );
  }
  if (stage.whitelist_type === 'custom') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <KindTag label="ALLOWLIST" color={VL.gray} />
        <span style={{ fontSize: 10.5, color: VLText.muted }}>off-chain / historical criteria</span>
      </div>
    );
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <KindTag label="PUBLIC" color={VL.greenStrong} />
      <span style={{ fontSize: 10.5, color: VLText.muted }}>no holding requirement</span>
    </div>
  );
}

function StageRow({ stage, now }: { stage: WhitelistStage; now: number }) {
  const status = stageStatusOf(stage, now);
  return (
    <div className={`vvv-stage-row vvv-stage-row--${status}`}>
      <div className="vvv-stage-row-top">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{ fontSize: 13.5, fontWeight: 700, color: VLText.primary, letterSpacing: '-0.1px' }}>
            {stage.name}
          </span>
          <StatusBadge status={status} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
          <MetricChip label="Price" value={stage.mint_price === 0 ? 'FREE' : `${stage.mint_price} SOL`} strong />
          <MetricChip label="Minted" value={`${fmtInt(stage.minted_count)}/${fmtInt(stage.max_mints_total)}`} />
          <MetricChip label="Limit" value={`${stage.max_mints_per_wallet}/wallet`} />
        </div>
      </div>
      <div className="vvv-stage-row-bottom">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
          <span style={{ fontSize: 10.5, ...MONO, color: VLText.muted, whiteSpace: 'nowrap' }}>{fmtStamp(stage.start_time)}</span>
          <span style={{ fontSize: 10.5, ...MONO, color: VLText.faint, whiteSpace: 'nowrap' }}>→ {fmtStamp(stage.end_time)}</span>
        </div>
        <EligibilityBlock stage={stage} />
      </div>
    </div>
  );
}

export default function VvvStagesPage() {
  useEffect(() => { document.title = 'VVV Stages | VictoryLabs'; }, []);

  const [linkInput, setLinkInput] = useState('');
  const [slug, setSlug] = useState<string | null>(null);
  const [data, setData] = useState<ApiPayload | null>(null);
  const [status, setStatus] = useState<'idle' | 'waiting' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const popupRef = useRef<Window | null>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.origin !== VVV_ORIGIN) return;
      const msg = e.data;
      if (!msg || msg.source !== 'vl-vvv-bridge') return;
      if (slug && msg.slug !== slug) return;
      if (msg.ok) {
        setData(msg.data);
        saveCache(msg.slug, msg.data);
        setStatus('idle');
        setErrorMsg(null);
      } else {
        setStatus('error');
        setErrorMsg(msg.error || 'bridge fetch failed');
      }
      try { popupRef.current?.close(); } catch { /* ignore */ }
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [slug]);

  const load = useCallback((forceRefresh: boolean) => {
    const s = parseSlug(linkInput);
    if (!s) { setStatus('error'); setErrorMsg('paste a vvv.so link or slug'); return; }
    setSlug(s);
    setErrorMsg(null);

    if (!forceRefresh) {
      const cached = loadCache(s);
      if (cached) { setData(cached); setStatus('idle'); return; }
    }

    setData(null);
    setStatus('waiting');
    const popup = window.open(`${VVV_ORIGIN}/${s}`, 'vl-vvv-bridge', 'width=520,height=780');
    popupRef.current = popup;
    if (!popup) {
      setStatus('error');
      setErrorMsg('popup blocked — allow popups for victorylabs.app');
    }
  }, [linkInput]);

  const sortedStages = useMemo(() => {
    const stages = data?.collection.whitelist_settings ?? [];
    return [...stages].sort((a, b) => {
      const sa = STATUS_ORDER[stageStatusOf(a, now)];
      const sb = STATUS_ORDER[stageStatusOf(b, now)];
      if (sa !== sb) return sa - sb;
      return Date.parse(a.start_time) - Date.parse(b.start_time);
    });
  }, [data, now]);

  const hasLive = sortedStages.some((s) => stageStatusOf(s, now) === 'live');
  const numMinted = data ? parseInt(data.numMinted, 10) : 0;
  const pctMinted = data && data.collection.collection_size > 0
    ? Math.min(100, (numMinted / data.collection.collection_size) * 100)
    : 0;

  return (
    <div className="feed-root page-transition" data-page="tools-vvv">
      <div className="scroll-area" style={{ flex: 1, minHeight: 0, overflowY: 'auto', width: '100%', paddingBottom: 72 }}>
        <div style={{ width: '100%', maxWidth: 900, margin: '0 auto', boxSizing: 'border-box', padding: '20px 4px 14px' }}>

          {/* ── header ──────────────────────────────────────────────── */}
          <h1 style={{ fontSize: 21, fontWeight: 800, color: VLText.primary, letterSpacing: '-0.4px', margin: 0 }}>
            VVV STAGES
          </h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 5, fontSize: 10.5, color: VLText.faint, flexWrap: 'wrap' }}>
            <LiveDot />
            <span>paste a vvv.so mint link — whitelist stages + eligible collections</span>
          </div>

          {/* ── url inspector toolbar ───────────────────────────────── */}
          <div style={{ ...PANEL, padding: 10, marginTop: 14, marginBottom: 0 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <ToolTextInput
                value={linkInput}
                onChange={(e) => setLinkInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') load(false); }}
                placeholder="https://www.vvv.so/horses7  (or just the slug)"
                big
                style={{ flex: 1, minWidth: 200 }}
              />
              <CtaButton onClick={() => load(false)} disabled={status === 'waiting'} big ownSound>
                {status === 'waiting' ? 'Waiting…' : 'Get Stages'}
              </CtaButton>
              {data && (
                <button
                  type="button"
                  className={`vvv-icon-btn${status === 'waiting' ? ' vvv-icon-btn--spin' : ''}`}
                  onClick={() => load(true)}
                  disabled={status === 'waiting'}
                  title="Refresh — re-open the bridge popup"
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.3" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                    <path d="M21 3v6h-6" />
                  </svg>
                </button>
              )}
            </div>

            {status === 'waiting' && (
              <div style={{
                marginTop: 9, display: 'flex', alignItems: 'flex-start', gap: 7,
                fontSize: 11, color: rgb(VL.blue), lineHeight: 1.5,
                padding: '8px 10px', borderRadius: 7, background: alpha(VL.blue, 0.08), border: `1px solid ${alpha(VL.blue, 0.25)}`,
              }}>
                <span>●</span>
                <span>
                  waiting on popup — needs the VL VVV Stages Bridge userscript installed on vvv.so.{' '}
                  <a href={USERSCRIPT_URL} style={{ color: rgb(VL.blue), textDecoration: 'underline' }}>get userscript</a>
                </span>
              </div>
            )}
            {status === 'error' && errorMsg && (
              <div style={{
                marginTop: 9, display: 'flex', alignItems: 'flex-start', gap: 7,
                fontSize: 11, color: rgb(VL.redStrong), lineHeight: 1.5,
                padding: '8px 10px', borderRadius: 7, background: alpha(VL.redStrong, 0.08), border: `1px solid ${alpha(VL.redStrong, 0.3)}`,
              }}>
                <span>⚠</span>
                <span>{errorMsg}</span>
              </div>
            )}
          </div>

          {data && (
            <>
              {/* ── collection hero ──────────────────────────────────── */}
              <div style={{
                position: 'relative', borderRadius: 12, overflow: 'hidden', marginTop: 14,
                background: `radial-gradient(120% 160% at 10% 0%, ${alpha(VL.blue, 0.10)} 0%, transparent 60%), linear-gradient(180deg, var(--vl-gray-surface) 0%, var(--vl-gray-surface) 100%)`,
                border: `1px solid ${alpha(VL.purpleTint, 0.28)}`,
                boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.05), 0 14px 40px rgba(0,0,0,0.5)',
                padding: 14,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                  <div style={{ borderRadius: 10, overflow: 'hidden', flexShrink: 0, border: `1px solid ${alpha(VL.purpleTint, 0.3)}` }}>
                    <ItemThumb
                      imageUrl={data.collection.collection_image_url ?? null}
                      color={rgb(VL.blue)}
                      abbr={(data.collection.symbol || data.collection.name || '??').slice(0, 2).toUpperCase()}
                      size={64}
                    />
                  </div>

                  <div style={{ flex: '1 1 160px', minWidth: 140 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 15.5, fontWeight: 800, color: VLText.primary, letterSpacing: '-0.2px' }}>
                        {data.collection.name}
                      </span>
                      <span style={{
                        fontSize: 9.5, fontWeight: 700, letterSpacing: '0.5px', color: rgb(VL.blue),
                        background: alpha(VL.blue, 0.14), border: `1px solid ${alpha(VL.blue, 0.35)}`,
                        borderRadius: 4, padding: '1px 6px',
                      }}>
                        {data.collection.symbol}
                      </span>
                    </div>
                    {/* mint progress */}
                    <div style={{ marginTop: 8, maxWidth: 240 }}>
                      <div style={{ height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.06)', overflow: 'hidden' }}>
                        <div style={{ height: '100%', width: `${pctMinted}%`, borderRadius: 2, background: rgb(VL.blue), transition: 'width 0.3s' }} />
                      </div>
                    </div>
                  </div>

                  <div style={{ display: 'flex', alignItems: 'center', gap: 22, marginLeft: 'auto' }}>
                    <StatTile value={`${fmtInt(numMinted)} / ${fmtInt(data.collection.collection_size)}`} label="Minted" />
                    <StatTile value={`${data.collection.price_per_nft} SOL`} label="Base Price" accent={rgb(VL.blue)} />
                    {hasLive && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, alignItems: 'flex-start' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, fontWeight: 800, color: 'var(--vl-green-primary)' }}>
                          <span style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--vl-green-primary)', boxShadow: '0 0 6px var(--vl-green-primary)' }} />
                          LIVE NOW
                        </span>
                        <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.7px', textTransform: 'uppercase', color: VLText.faint }}>
                          stage active
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* ── stages ───────────────────────────────────────────── */}
              <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginTop: 18, marginBottom: 8 }}>
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.8px', textTransform: 'uppercase', color: VLText.muted }}>
                  Mint Stages
                </span>
                <span style={{ fontSize: 10.5, color: VLText.faint, ...MONO }}>{sortedStages.length} total</span>
              </div>

              <div>
                {sortedStages.map((stage) => <StageRow key={stage.id} stage={stage} now={now} />)}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
