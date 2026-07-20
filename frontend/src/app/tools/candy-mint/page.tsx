'use client';

// Candy Mint tool — personal use only. Reconstructs a Candy Guard mint
// transaction from a real, already-landed mint signature (or raw
// candyMachine/candyGuard addresses) and mints directly on-chain — no
// off-chain gate beyond whatever the guard itself enforces. Supports both
// Candy Guard families — 'core' (MPL Core assets) and 'legacy' (Token
// Metadata NFTs) — auto-detected from the reference signature. Every
// backend route is requireAuth-gated (site-wide SIWS + UI_ALLOWED_WALLETS).
//
// Exists because candy machines get closed (rent reclaimed) the instant
// they sell out — a frontend can look "closed" while still minting, or
// look "live" while the machine is actually already gone. Paste a recent
// mint signature to find out which, on-chain, right now.

import { useEffect, useState } from 'react';
import { authHeaders } from '@/runtime/auth';
import { connectPhantom, eagerConnectPhantom, getPhantom, signSendAndConfirm } from '@/wallet/phantom';
import { API_BASE, MONO, PANEL, short } from '@/app/tools/mmm-shared';
import { VL, rgb } from '@/lib/palette';

interface GuardGroupSummary {
  label: string | null;
  enabledGuards: string[];
  unsupportedGuards: string[];
  supported: boolean;
  solPaymentLamports: string | null;
}

type CandyMintFamily = 'core' | 'legacy';

interface Inspection {
  alive: boolean;
  candyMachine: string;
  candyGuard: string;
  collection: string | null;
  itemsRedeemed: string | null;
  itemsAvailable: string | null;
  groups: GuardGroupSummary[];
}

type UiState =
  | { kind: 'idle' }
  | { kind: 'inspecting' }
  | {
      kind: 'inspected';
      family: CandyMintFamily;
      inspection: Inspection;
      referenceCollection: string | null;
      referenceCollectionUpdateAuthority: string | null;
    }
  | { kind: 'minting'; step: 'building' | 'signing' }
  | { kind: 'success'; sig: string }
  | { kind: 'error'; message: string };

const BACKEND_ERROR_MESSAGES: Record<string, string> = {
  invalid_signature: 'Not a valid transaction signature.',
  signature_not_found: 'No transaction found for that signature.',
  reference_tx_failed_onchain: 'That reference transaction failed on-chain — try a different one.',
  no_candy_guard_instruction_found: 'No Candy Guard mint instruction (core or legacy) in that transaction.',
  unexpected_account_count: 'Unrecognized instruction shape — not a plain mint call.',
  account_resolution_failed: 'Could not resolve accounts from that transaction.',
  unrecognized_candy_guard_program: 'That candyGuard address is not owned by either known Candy Guard program.',
  provide_sig_or_candyMachine_and_candyGuard: 'Enter a signature, or both candyMachine and candyGuard addresses.',
  candy_machine_closed: 'Candy machine is closed — the account no longer exists on-chain.',
  group_not_found: 'Selected guard group not found.',
  missing_or_invalid_fields: 'Missing or invalid fields.',
  collection_update_authority_unresolved: 'Could not resolve the collection\'s update authority (legacy mint).',
};

function humanizeBackendError(code: string | undefined, httpStatus?: number): string {
  if (code) {
    const base = code.split(':')[0].trim();
    return BACKEND_ERROR_MESSAGES[base] ?? code;
  }
  return httpStatus ? `Request failed (HTTP ${httpStatus}).` : 'Request failed. Please try again.';
}

function humanizeThrownError(message: string): string {
  const m = message.toLowerCase();
  if (m.includes('insufficient')) return 'Not enough SOL to complete this mint.';
  if (m.includes('user rejected') || m.includes('rejected the request')) return 'Transaction cancelled.';
  if (m.includes('phantom wallet not found')) return 'Phantom wallet not found. Install the Phantom extension.';
  return message;
}

export default function CandyMintPage() {
  const [wallet, setWallet] = useState<string | null>(null);
  const [sig, setSig] = useState('');
  const [selectedGroup, setSelectedGroup] = useState<string | null | undefined>(undefined);
  const [uiState, setUiState] = useState<UiState>({ kind: 'idle' });

  useEffect(() => {
    void eagerConnectPhantom().then((pk) => { if (pk) setWallet(pk); });
  }, []);

  async function handleConnect() {
    try {
      const pk = await connectPhantom();
      setWallet(pk);
    } catch (err) {
      setUiState({ kind: 'error', message: humanizeThrownError((err as Error).message) });
    }
  }

  function handleDisconnect() {
    void getPhantom()?.disconnect();
    setWallet(null);
  }

  async function handleInspect() {
    if (!sig.trim()) return;
    setUiState({ kind: 'inspecting' });
    setSelectedGroup(undefined);
    try {
      const r = await fetch(`${API_BASE}/api/tools/candy-mint/inspect?sig=${encodeURIComponent(sig.trim())}`, {
        headers: { ...authHeaders() },
      });
      const j = await r.json() as {
        ok: boolean; family?: CandyMintFamily; inspection?: Inspection;
        referenceCollection?: string | null; referenceCollectionUpdateAuthority?: string | null; error?: string;
      };
      if (!j.ok || !j.inspection || !j.family) {
        setUiState({ kind: 'error', message: humanizeBackendError(j.error, r.status) });
        return;
      }
      setUiState({
        kind: 'inspected',
        family: j.family,
        inspection: j.inspection,
        referenceCollection: j.referenceCollection ?? null,
        referenceCollectionUpdateAuthority: j.referenceCollectionUpdateAuthority ?? null,
      });
      const firstSupported = j.inspection.groups.find((g) => g.supported);
      if (firstSupported) setSelectedGroup(firstSupported.label);
    } catch (err) {
      setUiState({ kind: 'error', message: humanizeThrownError((err as Error).message) });
    }
  }

  async function handleMint() {
    if (!wallet || uiState.kind !== 'inspected' || selectedGroup === undefined) return;
    const { family, inspection, referenceCollection, referenceCollectionUpdateAuthority } = uiState;
    const collection = inspection.collection ?? referenceCollection;
    if (!collection) { setUiState({ kind: 'error', message: 'No collection address resolved.' }); return; }
    setUiState({ kind: 'minting', step: 'building' });
    try {
      const r = await fetch(`${API_BASE}/api/tools/candy-mint/build-tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          family,
          candyMachine: inspection.candyMachine,
          candyGuard: inspection.candyGuard,
          collection,
          collectionUpdateAuthority: referenceCollectionUpdateAuthority,
          group: selectedGroup,
          wallet,
        }),
      });
      const j = await r.json() as { ok: boolean; transactionBase64?: string; error?: string };
      if (!j.ok || !j.transactionBase64) {
        setUiState({ kind: 'error', message: humanizeBackendError(j.error, r.status) });
        return;
      }
      setUiState({ kind: 'minting', step: 'signing' });
      const result = await signSendAndConfirm(j.transactionBase64);
      setUiState({ kind: 'success', sig: result.signature });
    } catch (err) {
      setUiState({ kind: 'error', message: humanizeThrownError((err as Error).message) });
    }
  }

  const busy = uiState.kind === 'inspecting' || uiState.kind === 'minting';
  const inspected = uiState.kind === 'inspected' ? uiState : null;
  const selected = inspected?.inspection.groups.find((g) => g.label === selectedGroup) ?? null;
  const mintDisabled = !wallet || busy || !inspected || !inspected.inspection.alive || !selected?.supported;

  return (
    <div style={{ maxWidth: 560, margin: '40px auto', padding: '0 16px', ...MONO }}>
      <h1 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>Candy Mint — contract mint</h1>
      <p style={{ fontSize: 12, color: '#a8a2c0', marginBottom: 20 }}>
        Paste a recent Candy Guard mint signature (core or legacy). Reconstructs candyMachine/candyGuard/collection,
        checks whether the machine is still alive on-chain, and mints directly if it is.
      </p>

      {!wallet ? (
        <PrimaryButton onClick={handleConnect}>Connect Phantom</PrimaryButton>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
          <div style={{ fontSize: 12, color: '#0f0' }}>Connected: {short(wallet)}</div>
          <DisconnectLink onClick={handleDisconnect} />
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input
          value={sig}
          onChange={(e) => setSig(e.target.value)}
          placeholder="mint transaction signature"
          style={{ ...inputStyle, flex: 1 }}
        />
        <PrimaryButton onClick={handleInspect} disabled={busy || !sig.trim()}>
          {uiState.kind === 'inspecting' ? 'checking…' : 'Inspect'}
        </PrimaryButton>
      </div>

      {inspected && (
        <div style={{ ...PANEL, padding: 12, marginBottom: 16, fontSize: 12 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ color: inspected.inspection.alive ? '#0f0' : '#f66', fontWeight: 700 }}>
              {inspected.inspection.alive ? 'ALIVE — still mintable' : 'CLOSED — candy machine no longer exists'}
            </span>
            <span style={{ fontSize: 10, color: '#9a9ab4', border: '1px solid #333', borderRadius: 4, padding: '1px 5px' }}>
              {inspected.family === 'core' ? 'MPL CORE' : 'LEGACY (Token Metadata)'}
            </span>
          </div>
          <div>candyMachine: {short(inspected.inspection.candyMachine)}</div>
          <div>candyGuard: {short(inspected.inspection.candyGuard)}</div>
          {inspected.inspection.collection && <div>collection: {short(inspected.inspection.collection)}</div>}
          {inspected.inspection.itemsRedeemed && (
            <div>items: {inspected.inspection.itemsRedeemed} / {inspected.inspection.itemsAvailable}</div>
          )}

          {inspected.inspection.alive && inspected.inspection.groups.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ color: '#9a9ab4', marginBottom: 4 }}>guard group:</div>
              {inspected.inspection.groups.map((g) => (
                <label key={g.label ?? '__root__'} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, opacity: g.supported ? 1 : 0.55 }}>
                  <input
                    type="radio"
                    name="group"
                    checked={selectedGroup === g.label}
                    onChange={() => setSelectedGroup(g.label)}
                  />
                  <span>{g.label ?? '(root)'} — {g.enabledGuards.join(', ') || 'no guards'}</span>
                  {!g.supported && <span style={{ color: '#f66' }}>unsupported: {g.unsupportedGuards.join(', ')}</span>}
                  {g.solPaymentLamports && <span style={{ color: '#c2bcd8' }}>{(Number(g.solPaymentLamports) / 1e9).toFixed(3)} SOL</span>}
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      <StatusLine state={uiState} />

      <PrimaryButton onClick={handleMint} disabled={mintDisabled}>
        {uiState.kind === 'minting' ? uiState.step : 'Mint'}
      </PrimaryButton>

      {uiState.kind === 'success' && (
        <div style={{ marginTop: 16, fontSize: 12, color: '#0f0' }}>
          Confirmed:{' '}
          <a href={`https://solscan.io/tx/${uiState.sig}`} target="_blank" rel="noopener noreferrer" style={{ color: '#6cf' }}>
            {short(uiState.sig)}
          </a>
        </div>
      )}
    </div>
  );
}

function StatusLine({ state }: { state: UiState }) {
  if (state.kind === 'error') return <div style={{ fontSize: 12, marginBottom: 12, color: '#f66' }}>Error: {state.message}</div>;
  return null;
}

function PrimaryButton({ onClick, disabled, children }: {
  onClick: () => void; disabled?: boolean; children: React.ReactNode;
}) {
  const [hover, setHover] = useState(false);
  const [active, setActive] = useState(false);
  const filter = disabled ? undefined : active ? 'brightness(0.9)' : hover ? 'brightness(1.12)' : undefined;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => { setHover(false); setActive(false); }}
      onMouseDown={() => setActive(true)}
      onMouseUp={() => setActive(false)}
      style={{ ...btnStyle, opacity: disabled ? 0.5 : 1, filter, outline: 'none', transition: 'filter 0.1s' }}
    >
      {children}
    </button>
  );
}

function DisconnectLink({ onClick }: { onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        fontSize: 10, color: hover ? '#f0eef8' : '#9a9ab4',
        background: 'none', border: 'none', cursor: 'pointer', textDecoration: 'underline', padding: 0,
        transition: 'color 0.12s',
      }}
    >
      disconnect
    </button>
  );
}

const btnStyle: React.CSSProperties = {
  padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
  background: rgb(VL.violet), color: '#fff', border: 'none', borderRadius: 6,
};
const inputStyle: React.CSSProperties = {
  padding: '6px 8px', fontSize: 13, background: '#111', color: '#fff',
  border: '1px solid #333', borderRadius: 4,
};
