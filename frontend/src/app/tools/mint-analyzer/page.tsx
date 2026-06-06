'use client';

// VictoryLabs — Tools › Mint Analyzer (v1).
// Read-only Solana mint transaction decoder. Paste a tx signature → backend
// fetches getTransaction, decodes programs/instructions/signers, returns a
// reconstruction verdict. NO wallet connect, NO signing, NO tx building.
// Data: GET /api/tools/mint-analyzer/analyze?sig=<signature>

import { useEffect, useState } from 'react';
import { LiveDot } from '@/soloist/shared';
import { playUiConfirm } from '@/soloist/use-ui-sound';
import { authHeaders } from '@/runtime/auth';

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? '';

// ── Mirror of backend MintAnalysis (src/mint-analyzer/types.ts) ────────────
type MintPrimitive =
  | 'candy_machine_v3_mintv2' | 'mpl_core_create_v2'
  | 'token_metadata_mint' | 'bubblegum_mint' | 'unknown';
type SignerClass = 'fee_payer' | 'user' | 'known_platform_signer' | 'unknown_program_signer';
type Verdict =
  | 'direct_mint_likely_reconstructable' | 'possible_requires_extra_inputs'
  | 'blocked_server_captcha_signature' | 'custom_program_manual_re_required';
type AccessType =
  | 'public' | 'nft_holder_gate' | 'treasury_manual_allowlist'
  | 'backend_gated' | 'unknown';

interface ProgramCall { programId: string; name: string | null; invocationCount: number; }
interface DecodedInstruction {
  path: string; programId: string; programName: string | null;
  discriminatorHex: string; instructionName: string | null;
}
interface ClassifiedSigner { address: string; class: SignerClass; label?: string; }
type FlowGateType =
  | 'nft_burn_gate' | 'spl_token_burn_gate' | 'nft_transfer_gate' | 'spl_token_transfer_gate'
  | 'candy_machine_v3' | 'mpl_core_create' | 'token_metadata_create' | 'unknown_custom_gate'
  | 'server_signature_gate' | 'off_chain_token_transfer_gate' | 'soft_transfer_not_burn';
interface FlowGate {
  type: FlowGateType;
  confidence: 'high' | 'medium' | 'low';
  assetName?: string; mint?: string; amount?: string; owner?: string; programId?: string;
  signers?: string[];
  enforcedOnChain?: boolean;
  evidence: string[];
}
interface BurnedAsset { name?: string; mint?: string; amount?: string; owner?: string; }
interface TransferredAsset { name?: string; mint?: string; amount?: string; from?: string; to?: string; }
interface FlowClues {
  detectedGates: FlowGate[];
  burnedAssets: BurnedAsset[];
  transferredAssets: TransferredAsset[];
  mintFlow: string[];
  notes: string[];
}
interface MintAnalysis {
  signature: string;
  status: 'success' | 'failed';
  slot: number;
  blockTime: string | null;
  fee: number | null;
  computeUnitsConsumed: number | null;
  programs: ProgramCall[];
  instructions: DecodedInstruction[];
  likelyMintPrimitive: MintPrimitive;
  customWrapper: { programId: string; name: string | null } | null;
  knownLaunchpad: { programId: string; name: string | null } | null;
  signers: ClassifiedSigner[];
  backendSignerObserved: boolean;
  guardAuth: { candyGuard: boolean; notes: string[] };
  verdict: Verdict;
  verdictReasons: string[];
  accessType?: AccessType;
  accessClues?: string[];
  flowClues?: FlowClues;
}

const PRIMITIVE_LABEL: Record<MintPrimitive, string> = {
  candy_machine_v3_mintv2: 'Candy Machine v3 · MintV2',
  mpl_core_create_v2:      'MPL Core · CreateV2',
  token_metadata_mint:     'Token Metadata · Mint',
  bubblegum_mint:          'Bubblegum · cNFT Mint',
  unknown:                 'Unknown',
};

// Flow-clue gate labels + chip colour. Burn/transfer gates read as amber
// "requirements"; structural steps (candy/create) green; unknown purple.
const GATE_LABEL: Record<FlowGateType, string> = {
  nft_burn_gate:                 'NFT burn gate',
  spl_token_burn_gate:           'Token burn gate',
  nft_transfer_gate:             'NFT transfer gate',
  spl_token_transfer_gate:       'Token transfer gate',
  candy_machine_v3:              'Candy Machine v3',
  mpl_core_create:               'MPL Core create',
  token_metadata_create:         'Token Metadata create',
  unknown_custom_gate:           'Unknown custom gate',
  server_signature_gate:         'Server signature gate',
  off_chain_token_transfer_gate: 'Off-chain token gate',
  soft_transfer_not_burn:        'Soft transfer, not burn',
};
// Explicit colours for the server-gated family take precedence over the
// suffix heuristic (off_chain_token_transfer_gate ends with _transfer_gate).
const GATE_COLOR: Partial<Record<FlowGateType, string>> = {
  server_signature_gate:         '#d97c7c', // danger red — server signature blocks reconstruction
  off_chain_token_transfer_gate: '#e8a14a', // amber/orange — soft token gate
  soft_transfer_not_burn:        '#c99a52', // muted amber/orange
};
function gateColor(t: FlowGateType): string {
  if (GATE_COLOR[t]) return GATE_COLOR[t]!;
  if (t.endsWith('_burn_gate') || t.endsWith('_transfer_gate')) return '#e8c14a';
  if (t === 'unknown_custom_gate') return '#a890e8';
  return '#7ed9a8';
}

const VERDICT_META: Record<Verdict, { label: string; color: string; bg: string; border: string }> = {
  direct_mint_likely_reconstructable: { label: 'Direct mint — likely reconstructable', color: '#7ed9a8', bg: 'rgba(126,217,168,0.10)', border: 'rgba(126,217,168,0.40)' },
  possible_requires_extra_inputs:     { label: 'Possible — requires extra inputs',     color: '#e8c14a', bg: 'rgba(232,193,74,0.10)',  border: 'rgba(232,193,74,0.40)' },
  blocked_server_captcha_signature:   { label: 'Blocked — server/captcha/signature',   color: '#d97c7c', bg: 'rgba(217,124,124,0.10)', border: 'rgba(217,124,124,0.40)' },
  custom_program_manual_re_required:  { label: 'Custom program — manual RE required',  color: '#a890e8', bg: 'rgba(168,144,232,0.12)', border: 'rgba(168,144,232,0.45)' },
};

// Large reconstructable status badge derived from the verdict (display-only;
// no analyzer/verdict logic touched — this is a UI restatement).
const RECONSTRUCTABLE_BADGE: Record<Verdict, { label: string; color: string; bg: string; border: string }> = {
  direct_mint_likely_reconstructable: { label: 'RECONSTRUCTABLE: YES',  color: '#7ed9a8', bg: 'rgba(126,217,168,0.12)', border: 'rgba(126,217,168,0.55)' },
  possible_requires_extra_inputs:     { label: 'RECONSTRUCTABLE: MAYBE', color: '#e8c14a', bg: 'rgba(232,193,74,0.12)',  border: 'rgba(232,193,74,0.55)' },
  blocked_server_captcha_signature:   { label: 'RECONSTRUCTABLE: NO',    color: '#d97c7c', bg: 'rgba(217,124,124,0.12)', border: 'rgba(217,124,124,0.55)' },
  custom_program_manual_re_required:  { label: 'REQUIRES MANUAL RE',     color: '#a890e8', bg: 'rgba(168,144,232,0.14)', border: 'rgba(168,144,232,0.60)' },
};

// Access type — WHO was allowed to mint (orthogonal to the verdict). Colours
// reuse the existing palette: green=public, blue=holder, purple=treasury,
// red=backend-gated, gray=unknown. Display-only restatement of accessType.
const ACCESS_META: Record<AccessType, { label: string; color: string }> = {
  public:                    { label: 'Public Mint',        color: '#7ed9a8' },
  nft_holder_gate:           { label: 'NFT Holder Gate',     color: '#7ea8d9' },
  treasury_manual_allowlist: { label: 'Treasury Allowlist',  color: '#a890e8' },
  backend_gated:             { label: 'Backend Gated',       color: '#d97c7c' },
  unknown:                   { label: 'Unknown',             color: '#7a7a94' },
};

// Confidence is a fixed function of the verdict class (display-only).
const CONFIDENCE: Record<Verdict, 'HIGH' | 'MEDIUM'> = {
  direct_mint_likely_reconstructable: 'HIGH',
  blocked_server_captcha_signature:   'HIGH',
  custom_program_manual_re_required:  'MEDIUM',
  possible_requires_extra_inputs:     'MEDIUM',
};
const CONFIDENCE_COLOR: Record<'HIGH' | 'MEDIUM', string> = { HIGH: '#7ed9a8', MEDIUM: '#e8c14a' };

const SIGNER_META: Record<SignerClass, { label: string; color: string }> = {
  fee_payer:              { label: 'FEE PAYER',       color: '#7a7a94' },
  user:                   { label: 'USER',            color: '#7ed9a8' },
  known_platform_signer:  { label: 'PLATFORM SIGNER', color: '#d97c7c' },
  unknown_program_signer: { label: 'PROGRAM SIGNER',  color: '#e8c14a' },
};

function shortAddr(s: string): string {
  return s.length > 12 ? `${s.slice(0, 5)}…${s.slice(-5)}` : s;
}

const PANEL: React.CSSProperties = {
  background: 'linear-gradient(180deg, #201a3a 0%, #1a1530 100%)',
  border: '1px solid rgba(168,144,232,0.32)',
  borderRadius: 12,
  boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), 0 16px 50px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4), 0 0 28px rgba(128,104,216,0.10)',
  padding: 12,
  marginBottom: 11,
};
const SECTION_LABEL: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase',
  color: '#56566e', marginBottom: 6,
};
const MONO = "'SF Mono','Fira Code',monospace";

function Chip({ children, color = '#a890e8' }: { children: React.ReactNode; color?: string }) {
  return (
    <span style={{
      display: 'inline-block', padding: '3px 8px', fontSize: 11, fontWeight: 600,
      borderRadius: 5, fontFamily: MONO, color,
      background: `${color}14`, border: `1px solid ${color}3a`,
    }}>{children}</span>
  );
}

export default function MintAnalyzerPage() {
  useEffect(() => { document.title = 'VictoryLabs — Mint Analyzer'; }, []);

  const [sig, setSig]         = useState('');
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<MintAnalysis | null>(null);
  // Full API response body as displayed, kept verbatim for COPY JSON.
  const [raw, setRaw]         = useState<unknown>(null);
  const [copied, setCopied]   = useState(false);

  const run = async () => {
    const trimmed = sig.trim();
    if (busy || trimmed.length === 0) return;
    playUiConfirm();
    setBusy(true);
    setError(null);
    try {
      const r = await fetch(`${API_BASE}/api/tools/mint-analyzer/analyze?sig=${encodeURIComponent(trimmed)}`, {
        headers: { ...authHeaders() },
      });
      if (r.status === 429) { setError('Rate limited — wait a moment and try again.'); return; }
      if (r.status === 400) { setError('Invalid signature — paste a full base58 Solana tx signature.'); return; }
      if (r.status === 404) { setError('Transaction not found on-chain (unknown or unconfirmed signature).'); return; }
      if (!r.ok)            { setError(`Analyze failed — HTTP ${r.status}.`); return; }
      const body = await r.json() as { ok: boolean; analysis?: MintAnalysis; error?: string };
      if (!body.ok || !body.analysis) { setError(body.error ?? 'Analyze failed.'); return; }
      setAnalysis(body.analysis);
      setRaw(body);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
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

  const v  = analysis ? VERDICT_META[analysis.verdict] : null;
  const rb = analysis ? RECONSTRUCTABLE_BADGE[analysis.verdict] : null;
  const conf = analysis ? CONFIDENCE[analysis.verdict] : null;
  // Wrapper = opaque custom wrapper OR recognised launchpad fronting the mint.
  const wrapper = analysis ? (analysis.customWrapper ?? analysis.knownLaunchpad) : null;

  return (
    <div className="feed-root page-transition" data-page="tools">
      {/* Scroll container — .feed-root is a fixed 100vh flex column, so the
          page content (header/input + result panels) must own its own
          vertical scroll. paddingBottom clears the fixed BottomStatusBar HUD
          so the final panel stays readable. Mirrors the /tools pattern. */}
      <div className="scroll-area" style={{ flex: 1, minHeight: 0, overflowY: 'auto', width: '100%', paddingBottom: 72 }}>
      <div style={{ width: '100%', maxWidth: 'var(--tools-max, 1100px)', margin: '0 auto', boxSizing: 'border-box', padding: '20px 4px 14px' }}>
        {/* Header */}
        <h1 style={{ fontSize: 22, fontWeight: 700, color: '#e8e6f2', letterSpacing: '-0.5px' }}>
          MINTX
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, fontSize: 11, color: '#7a7a94', flexWrap: 'wrap' }}>
          <LiveDot />
          <span>read-only · decodes a mint tx signature into a reconstruction verdict</span>
        </div>

        {/* Input */}
        <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
          <input
            type="text"
            value={sig}
            onChange={(e) => setSig(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') run(); }}
            placeholder="Paste Solana transaction signature…"
            spellCheck={false}
            disabled={busy}
            style={{
              flex: 1, minWidth: 280, padding: '9px 12px', fontSize: 12,
              fontFamily: MONO, borderRadius: 5,
              border: '1px solid rgba(168,144,232,0.40)',
              background: 'rgba(20,14,34,0.85)', color: '#d4d4e8', outline: 'none',
            }}
          />
          <button
            type="button"
            onClick={run}
            disabled={busy || sig.trim().length === 0}
            data-uisnd="skip"
            style={{
              padding: '7px 18px', fontSize: 12, fontWeight: 700,
              letterSpacing: '0.5px', textTransform: 'uppercase', borderRadius: 5,
              cursor: (busy || sig.trim().length === 0) ? 'not-allowed' : 'pointer',
              border: '1px solid rgba(168,144,232,0.55)',
              background: (busy || sig.trim().length === 0) ? 'rgba(128,104,216,0.15)' : 'linear-gradient(180deg, rgba(128,104,216,0.28) 0%, rgba(128,104,216,0.14) 100%)',
              color: (busy || sig.trim().length === 0) ? '#7a7a94' : '#d4d4e8',
              boxShadow: (busy || sig.trim().length === 0) ? 'none' : '0 0 12px rgba(128,104,216,0.18)',
              transition: 'all 0.15s',
            }}
          >
            {busy ? 'Analyzing…' : 'Analyze'}
          </button>
        </div>

        {error && (
          <div style={{
            marginTop: 12, padding: '8px 12px', fontSize: 12, color: '#ef7878',
            background: 'rgba(239,120,120,0.08)', border: '1px solid rgba(239,120,120,0.32)',
            borderRadius: 5,
          }}>
            {error}
          </div>
        )}
      </div>

      {/* Result */}
      {analysis && v && rb && conf && (
        <div style={{ width: '100%', maxWidth: 'var(--tools-max, 1100px)', margin: '0 auto', boxSizing: 'border-box', padding: '0 4px 24px' }}>

          {/* Verdict banner */}
          <div style={{
            ...PANEL, padding: 16, marginBottom: 16,
            background: v.bg, border: `1px solid ${v.border}`,
            boxShadow: `0 0 24px ${v.bg}`,
          }}>
            {/* Header row: label + confidence + copy-json */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase', color: '#56566e' }}>Verdict</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: '0.5px', color: '#56566e' }}>CONFIDENCE</span>
                <span style={{
                  padding: '2px 8px', fontSize: 10, fontWeight: 800, letterSpacing: '0.5px',
                  borderRadius: 4, fontFamily: MONO,
                  color: CONFIDENCE_COLOR[conf], background: `${CONFIDENCE_COLOR[conf]}1a`,
                  border: `1px solid ${CONFIDENCE_COLOR[conf]}3a`,
                }}>{conf}</span>
                <button
                  type="button"
                  onClick={copyJson}
                  data-uisnd="skip"
                  style={{
                    padding: '3px 9px', fontSize: 9.5, fontWeight: 800, letterSpacing: '0.5px',
                    borderRadius: 4, cursor: 'pointer', fontFamily: MONO,
                    border: '1px solid rgba(168,144,232,0.45)',
                    background: copied ? 'rgba(126,217,168,0.16)' : 'rgba(168,144,232,0.10)',
                    color: copied ? '#7ed9a8' : '#c4b8e8',
                    transition: 'all 0.15s',
                  }}
                >{copied ? 'COPIED ✓' : 'COPY JSON'}</button>
              </div>
            </div>

            {/* Large reconstructable status badge — the dominant signal */}
            <div style={{
              display: 'inline-block', padding: '10px 18px', borderRadius: 8,
              fontSize: 26, fontWeight: 800, letterSpacing: '0.5px', lineHeight: 1.1,
              color: rb.color, background: rb.bg, border: `1.5px solid ${rb.border}`,
            }}>{rb.label}</div>

            {/* Secondary verdict text */}
            <div style={{ fontSize: 13, fontWeight: 600, color: v.color, marginTop: 10, opacity: 0.9 }}>{v.label}</div>
            {analysis.verdictReasons.length > 0 && (
              <ul style={{ margin: '10px 0 0', paddingLeft: 18, fontSize: 12, color: '#aaaabf', lineHeight: 1.6 }}>
                {analysis.verdictReasons.map((rsn, i) => <li key={i}>{rsn}</li>)}
              </ul>
            )}
          </div>

          {/* Access type — additive panel directly below the verdict. Display-only
              restatement of backend accessType/accessClues; no analyzer logic. */}
          {analysis.accessType && (() => {
            const am = ACCESS_META[analysis.accessType];
            return (
              <div style={PANEL}>
                <div style={SECTION_LABEL}>Access type</div>
                <span style={{
                  display: 'inline-block', padding: '6px 14px', borderRadius: 6,
                  fontSize: 15, fontWeight: 800, letterSpacing: '0.4px', lineHeight: 1.1,
                  color: am.color, background: `${am.color}1a`, border: `1.5px solid ${am.color}55`,
                }}>{am.label}</span>
                {analysis.accessClues && analysis.accessClues.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
                    {analysis.accessClues.map((c, i) => (
                      <Chip key={i} color="#7a7a94">{c}</Chip>
                    ))}
                  </div>
                )}
              </div>
            );
          })()}

          {/* Status / meta */}
          <div style={PANEL}>
            <div style={SECTION_LABEL}>Transaction</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, fontSize: 12, fontFamily: MONO }}>
              <div><span style={{ color: '#56566e' }}>status </span><span style={{ color: analysis.status === 'success' ? '#7ed9a8' : '#d97c7c', fontWeight: 700 }}>{analysis.status.toUpperCase()}</span></div>
              <div><span style={{ color: '#56566e' }}>slot </span><span style={{ color: '#d4d4e8' }}>{analysis.slot.toLocaleString()}</span></div>
              <div><span style={{ color: '#56566e' }}>time </span><span style={{ color: '#d4d4e8' }}>{analysis.blockTime ? new Date(analysis.blockTime).toUTCString() : '—'}</span></div>
              {analysis.fee != null && <div><span style={{ color: '#56566e' }}>fee </span><span style={{ color: '#d4d4e8' }}>{(analysis.fee / 1e9).toFixed(6)} SOL</span></div>}
              {analysis.computeUnitsConsumed != null && <div><span style={{ color: '#56566e' }}>CU </span><span style={{ color: '#d4d4e8' }}>{analysis.computeUnitsConsumed.toLocaleString()}</span></div>}
            </div>
          </div>

          {/* Likely mint primitive + dedicated wrapper block */}
          <div style={PANEL}>
            <div style={SECTION_LABEL}>Likely mint primitive</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
              <Chip color="#7ed9a8">{PRIMITIVE_LABEL[analysis.likelyMintPrimitive]}</Chip>
            </div>

            {/* Wrapper — explicit, never inferred from the verdict text */}
            <div style={{ ...SECTION_LABEL, marginTop: 16 }}>Wrapper</div>
            {wrapper ? (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <span title={wrapper.programId} style={{
                  display: 'inline-block', padding: '3px 8px', fontSize: 12, fontWeight: 600,
                  borderRadius: 5, fontFamily: MONO, color: '#a890e8',
                  background: 'rgba(168,144,232,0.12)', border: '1px solid rgba(168,144,232,0.35)',
                }}>{wrapper.programId.slice(0, 12)}…</span>
                {wrapper.name && <span style={{ fontSize: 11, color: '#56566e', fontFamily: MONO }}>· {wrapper.name}</span>}
              </div>
            ) : (
              <span style={{
                display: 'inline-block', padding: '3px 8px', fontSize: 12, fontWeight: 700,
                borderRadius: 5, fontFamily: MONO, color: '#7a7a94',
                background: 'rgba(122,122,148,0.10)', border: '1px solid rgba(122,122,148,0.28)',
              }}>NONE</span>
            )}
          </div>

          {/* Mint Requirements / Flow Clues — additive read-only section.
              Surfaces burn/transfer gates + mint flow for ALL verdicts,
              especially MANUAL RE where the verdict triad alone is thin. */}
          {analysis.flowClues && (analysis.flowClues.detectedGates.length > 0 || analysis.flowClues.mintFlow.length > 0) && (
            <div style={PANEL}>
              <div style={SECTION_LABEL}>Mint requirements</div>

              {analysis.flowClues.detectedGates.length > 0 && (
                <>
                  <div style={{ fontSize: 10.5, color: '#6a6a84', marginBottom: 4 }}>Detected gates</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    {analysis.flowClues.detectedGates.map((g, i) => (
                      <Chip key={i} color={gateColor(g.type)}>
                        {GATE_LABEL[g.type]} · {g.confidence.toUpperCase()}
                      </Chip>
                    ))}
                  </div>
                  {(() => {
                    const gates = analysis.flowClues!.detectedGates;
                    const ssg = gates.find(g => g.type === 'server_signature_gate' && (g.signers?.length ?? 0) > 0);
                    const offChain = gates.some(g => g.enforcedOnChain === false);
                    if (!ssg && !offChain) return null;
                    return (
                      <div style={{ marginTop: 5, display: 'flex', flexWrap: 'wrap', gap: 12, fontSize: 10.5, fontFamily: MONO }}>
                        {ssg && (
                          <span style={{ color: '#d97c7c' }}>
                            Backend signer: {ssg.signers!.map(shortAddr).join(', ')}
                          </span>
                        )}
                        {offChain && <span style={{ color: '#6a6a84' }}>Not enforced on-chain</span>}
                      </div>
                    );
                  })()}
                </>
              )}

              {analysis.flowClues.burnedAssets.length > 0 && (
                <>
                  <div style={{ fontSize: 10.5, color: '#6a6a84', margin: '8px 0 4px' }}>Burned</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    {analysis.flowClues.burnedAssets.map((b, i) => (
                      <span key={i} title={b.mint} style={{
                        display: 'inline-block', padding: '3px 8px', fontSize: 11, fontWeight: 600,
                        borderRadius: 5, fontFamily: MONO, color: '#e8a14a',
                        background: 'rgba(232,161,74,0.10)', border: '1px solid rgba(232,161,74,0.34)',
                      }}>{b.name ?? shortAddr(b.mint ?? '?')}{b.amount && b.amount !== '1' ? ` ×${b.amount}` : ''}</span>
                    ))}
                  </div>
                </>
              )}

              {analysis.flowClues.transferredAssets.length > 0 && (
                <>
                  <div style={{ fontSize: 10.5, color: '#6a6a84', margin: '8px 0 4px' }}>Transferred</div>
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                    {analysis.flowClues.transferredAssets.map((t, i) => (
                      <span key={i} title={t.mint} style={{
                        display: 'inline-block', padding: '3px 8px', fontSize: 11, fontWeight: 600,
                        borderRadius: 5, fontFamily: MONO, color: '#7ea8d9',
                        background: 'rgba(126,168,217,0.10)', border: '1px solid rgba(126,168,217,0.34)',
                      }}>{t.name ?? shortAddr(t.mint ?? '?')}{t.amount && t.amount !== '1' ? ` ×${t.amount}` : ''}</span>
                    ))}
                  </div>
                </>
              )}

              {analysis.flowClues.mintFlow.length > 0 && (
                <>
                  <div style={{ fontSize: 10.5, color: '#6a6a84', margin: '8px 0 4px' }}>Flow</div>
                  <div style={{ fontSize: 12, fontFamily: MONO, color: '#c8c8dc', lineHeight: 1.6 }}>
                    {analysis.flowClues.mintFlow.join('  →  ')}
                  </div>
                </>
              )}

              {analysis.flowClues.notes.length > 0 && (
                <ul style={{ margin: '8px 0 0', paddingLeft: 18, fontSize: 11.5, color: '#aaaabf', lineHeight: 1.5 }}>
                  {analysis.flowClues.notes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              )}
            </div>
          )}

          {/* Programs called */}
          <div style={PANEL}>
            <div style={SECTION_LABEL}>Programs called</div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {analysis.programs.map(p => (
                <span key={p.programId} title={p.programId} style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 8px',
                  fontSize: 11, borderRadius: 5, fontFamily: MONO,
                  color: p.name ? '#d4d4e8' : '#e8c14a',
                  background: 'rgba(168,144,232,0.07)', border: '1px solid rgba(168,144,232,0.22)',
                }}>
                  <span style={{ fontWeight: 600 }}>{p.name ?? shortAddr(p.programId)}</span>
                  <span style={{ color: '#56566e' }}>×{p.invocationCount}</span>
                </span>
              ))}
            </div>
          </div>

          {/* Signers */}
          <div style={PANEL}>
            <div style={SECTION_LABEL}>Signers</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
              {analysis.signers.map((s, i) => {
                const m = SIGNER_META[s.class];
                return (
                  <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 12, fontFamily: MONO }}>
                    <span style={{
                      flexShrink: 0, width: 120, padding: '2px 7px', fontSize: 9.5, fontWeight: 800,
                      letterSpacing: '0.4px', borderRadius: 3, textAlign: 'center',
                      color: m.color, background: `${m.color}1a`, border: `1px solid ${m.color}3a`,
                    }}>{m.label}</span>
                    <a href={`https://solscan.io/account/${s.address}`} target="_blank" rel="noopener noreferrer"
                       style={{ color: '#d4d4e8', textDecoration: 'none' }}>{s.address}</a>
                    {s.label && <span style={{ color: '#56566e' }}>· {s.label}</span>}
                  </div>
                );
              })}
            </div>
            <div style={{ marginTop: 6, fontSize: 11, color: analysis.backendSignerObserved ? '#d97c7c' : '#7ed9a8' }}>
              {analysis.backendSignerObserved
                ? '⚠ Backend/platform co-signer observed — server signature required.'
                : '✓ No backend/platform signer observed.'}
            </div>
          </div>

          {/* Guard / auth */}
          {(analysis.guardAuth.candyGuard || analysis.guardAuth.notes.length > 0) && (
            <div style={PANEL}>
              <div style={SECTION_LABEL}>Guard / auth requirements</div>
              {analysis.guardAuth.candyGuard && <Chip color="#e8c14a">Candy Guard present</Chip>}
              {analysis.guardAuth.notes.length > 0 && (
                <ul style={{ margin: '6px 0 0', paddingLeft: 18, fontSize: 12, color: '#aaaabf', lineHeight: 1.5 }}>
                  {analysis.guardAuth.notes.map((n, i) => <li key={i}>{n}</li>)}
                </ul>
              )}
            </div>
          )}

          {/* Instructions */}
          <div style={PANEL}>
            <div style={SECTION_LABEL}>Instructions ({analysis.instructions.length})</div>
            <div style={{ overflowX: 'auto' }} className="scroll-area">
              <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: MONO, fontSize: 11 }}>
                <thead>
                  <tr style={{ color: '#56566e', textAlign: 'left' }}>
                    <th style={{ padding: '6px 10px', fontWeight: 700 }}>PATH</th>
                    <th style={{ padding: '6px 10px', fontWeight: 700 }}>PROGRAM</th>
                    <th style={{ padding: '6px 10px', fontWeight: 700 }}>INSTRUCTION</th>
                    <th style={{ padding: '6px 10px', fontWeight: 700 }}>DISCRIMINATOR</th>
                  </tr>
                </thead>
                <tbody>
                  {analysis.instructions.map((ix, i) => (
                    <tr key={i} style={{ borderTop: '1px solid rgba(255,255,255,0.04)' }}>
                      <td style={{ padding: '6px 10px', color: '#7a7a94' }}>{ix.path}</td>
                      <td style={{ padding: '6px 10px', color: ix.programName ? '#d4d4e8' : '#e8c14a' }} title={ix.programId}>
                        {ix.programName ?? shortAddr(ix.programId)}
                      </td>
                      <td style={{ padding: '6px 10px', color: ix.instructionName ? '#7ed9a8' : '#56566e' }}>
                        {ix.instructionName ?? '—'}
                      </td>
                      <td style={{ padding: '6px 10px', color: '#a890e8' }}>{ix.discriminatorHex || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

        </div>
      )}
      </div>
    </div>
  );
}
