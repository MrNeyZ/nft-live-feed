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
//
// Layout below is a VictoryLabs read of a launchpad drop page (Rarible-style
// hero: big image + MINTING NOW + title + creator + quantity stepper + mint
// button + stats line) — reusing existing shared primitives (Pill, LiveDot,
// ItemThumb, VL palette) rather than inventing a parallel visual language.
//
// `loaded` (the inspected machine) and `flow` (the in-progress mint attempt)
// are deliberately separate pieces of state — the hero renders off `loaded`
// alone, so it stays on screen through the whole build → simulate → sign
// sequence instead of disappearing the moment a mint attempt starts. The
// simulated-cost / Sign & Send control renders inline in the exact spot the
// quantity+Mint row occupied, not as a separate panel further down the page.

import { useEffect, useState } from 'react';
import { authHeaders } from '@/runtime/auth';
import { connectPhantom, eagerConnectPhantom, getPhantom, signAllAndSend, signSendAndConfirm } from '@/wallet/phantom';
import { API_BASE, MONO, ToolButton, ToolTextInput, short } from '@/app/tools/mmm-shared';
import { VL, VLText, ALPHA, alpha, rgb } from '@/lib/palette';
import { ItemThumb, LiveDot, Pill } from '@/soloist/shared';

interface MintLimitStatus {
  id: number;
  limit: number;
  used: number | null;
  remaining: number | null;
}

interface GuardGroupSummary {
  label: string | null;
  enabledGuards: string[];
  unsupportedGuards: string[];
  supported: boolean;
  solPaymentLamports: string | null;
  mintLimit: MintLimitStatus | null;
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

interface CollectionMeta {
  name: string | null;
  image: string | null;
  description: string | null;
  creator: string | null;
}

interface LoadedMachine {
  family: CandyMintFamily;
  inspection: Inspection;
  collectionMeta: CollectionMeta | null;
  referenceCollection: string | null;
  referenceCollectionUpdateAuthority: string | null;
}

type BatchItemStatus = 'pending' | 'building' | 'simulating' | 'ready' | 'signing' | 'confirming' | 'success' | 'blocked' | 'error';

interface BatchItem {
  status: BatchItemStatus;
  sig?: string;
  solDeltaLamports?: number | null;
  message?: string;
}

// The mint-attempt state machine — independent of `loaded`/hero data. Only
// 'ready_to_sign' and 'batch' replace the quantity+Mint control; every other
// state renders alongside it.
type FlowState =
  | { kind: 'idle' }
  | { kind: 'inspecting' }
  | { kind: 'minting'; step: 'building' | 'simulating' | 'signing' }
  | {
      kind: 'ready_to_sign';
      transactionBase64: string;
      solDeltaLamports: number | null;
      botTaxDetected: boolean;
    }
  | { kind: 'batch'; total: number; items: BatchItem[]; done?: boolean }
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
  rate_limited: 'Rate limited — wait a few seconds and try again (or resume with a smaller quantity).',
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

// signSendAndConfirm returns as soon as Phantom submits the tx — it doesn't
// actually wait for it to land (public RPC WSS confirm is unreliable, see
// its own doc comment). Reuses the same tx-status endpoint the MMM pool
// buy flow polls (collection/[slug]/page.tsx) rather than hitting RPC
// directly from the browser. Best-effort: gives up after ~15s either way,
// since the next item's own simulate would just show a wrong number, not
// cause any real harm.
async function waitForConfirmation(signature: string): Promise<void> {
  // 'confirmed' typically lands within ~1 slot (~400-800ms) — a flat 3s gap
  // between polls meant every item paid a 2-3s tax even in the fast common
  // case (measured: felt like it dropped from ~500ms to 2-3s per item after
  // this was added). Poll tighter; 15x300ms keeps roughly the same ~4.5s
  // worst-case budget but resolves the common case in 1-2 polls instead.
  for (let attempt = 0; attempt < 15; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 300));
    try {
      const r = await fetch(`${API_BASE}/api/tools/mmm-pools/tx-status?sig=${encodeURIComponent(signature)}`, {
        headers: { ...authHeaders() },
      });
      if (!r.ok) continue;
      const d = await r.json() as { ok: boolean; found: boolean; confirmationStatus: string | null };
      if (d.ok && d.found && (d.confirmationStatus === 'confirmed' || d.confirmationStatus === 'finalized')) return;
    } catch {
      // transient — retry
    }
  }
}

export default function CandyMintPage() {
  const [wallet, setWallet] = useState<string | null>(null);
  const [sig, setSig] = useState('');
  const [selectedGroup, setSelectedGroup] = useState<string | null | undefined>(undefined);
  const [quantity, setQuantity] = useState(1);
  const [loaded, setLoaded] = useState<LoadedMachine | null>(null);
  const [flow, setFlow] = useState<FlowState>({ kind: 'idle' });

  useEffect(() => {
    void eagerConnectPhantom().then((pk) => { if (pk) setWallet(pk); });
  }, []);

  // mintLimit's used/remaining is per-wallet — it was only ever fetched at
  // Inspect time for whatever wallet happened to be connected then. Switch
  // wallets afterwards without re-inspecting and the panel kept showing the
  // PREVIOUS wallet's count (looked like "the site thinks it's the same
  // wallet" — it wasn't checking the new one at all, just never refreshed).
  // Re-fetch the wallet-scoped numbers whenever the connected wallet changes
  // while a machine is already loaded; everything else (family, collection
  // meta, addresses) is wallet-independent and stays put.
  useEffect(() => {
    if (!loaded) return;
    const candyMachine = loaded.inspection.candyMachine;
    const candyGuard = loaded.inspection.candyGuard;
    let cancelled = false;
    (async () => {
      try {
        const walletParam = wallet ? `&wallet=${encodeURIComponent(wallet)}` : '';
        const r = await fetch(
          `${API_BASE}/api/tools/candy-mint/inspect?candyMachine=${encodeURIComponent(candyMachine)}&candyGuard=${encodeURIComponent(candyGuard)}${walletParam}`,
          { headers: { ...authHeaders() } },
        );
        const j = await r.json() as { ok: boolean; inspection?: Inspection };
        if (!cancelled && j.ok && j.inspection) {
          setLoaded((prev) => (prev ? { ...prev, inspection: j.inspection as Inspection } : prev));
        }
      } catch {
        // best-effort refresh — keep showing whatever we already have
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only re-runs on wallet change
  }, [wallet]);

  async function handleConnect() {
    try {
      const pk = await connectPhantom();
      setWallet(pk);
    } catch (err) {
      setFlow({ kind: 'error', message: humanizeThrownError((err as Error).message) });
    }
  }

  function handleDisconnect() {
    void getPhantom()?.disconnect();
    setWallet(null);
    // Reset the in-progress mint attempt (ready_to_sign, batch, success,
    // error) — none of it belongs to whichever wallet connects next. The
    // drop itself (`loaded`) and the pasted signature stay put; the
    // wallet-switch effect re-fetches per-wallet numbers (mintLimit
    // used/remaining) once a new wallet connects.
    setFlow({ kind: 'idle' });
    setQuantity(1);
  }

  async function handleInspect() {
    if (!sig.trim()) return;
    setFlow({ kind: 'inspecting' });
    setSelectedGroup(undefined);
    setQuantity(1);
    try {
      const walletParam = wallet ? `&wallet=${encodeURIComponent(wallet)}` : '';
      const r = await fetch(`${API_BASE}/api/tools/candy-mint/inspect?sig=${encodeURIComponent(sig.trim())}${walletParam}`, {
        headers: { ...authHeaders() },
      });
      const j = await r.json() as {
        ok: boolean; family?: CandyMintFamily; inspection?: Inspection; collectionMeta?: CollectionMeta | null;
        referenceCollection?: string | null; referenceCollectionUpdateAuthority?: string | null; error?: string;
      };
      if (!j.ok || !j.inspection || !j.family) {
        setFlow({ kind: 'error', message: humanizeBackendError(j.error, r.status) });
        return;
      }
      setLoaded({
        family: j.family,
        inspection: j.inspection,
        collectionMeta: j.collectionMeta ?? null,
        referenceCollection: j.referenceCollection ?? null,
        referenceCollectionUpdateAuthority: j.referenceCollectionUpdateAuthority ?? null,
      });
      setFlow({ kind: 'idle' });
      const firstSupported = j.inspection.groups.find((g) => g.supported);
      if (firstSupported) setSelectedGroup(firstSupported.label);
    } catch (err) {
      setFlow({ kind: 'error', message: humanizeThrownError((err as Error).message) });
    }
  }

  async function handleMint() {
    if (!wallet || !loaded || selectedGroup === undefined) return;
    const { family, inspection, referenceCollection, referenceCollectionUpdateAuthority } = loaded;
    const collection = inspection.collection ?? referenceCollection;
    if (!collection) { setFlow({ kind: 'error', message: 'No collection address resolved.' }); return; }
    setFlow({ kind: 'minting', step: 'building' });
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
        setFlow({ kind: 'error', message: humanizeBackendError(j.error, r.status) });
        return;
      }
      const transactionBase64 = j.transactionBase64;

      // Phantom won't preview balance changes for an unverified dApp — simulate
      // server-side instead and show the real cost before asking for a signature.
      setFlow({ kind: 'minting', step: 'simulating' });
      const simR = await fetch(`${API_BASE}/api/tools/candy-mint/simulate-tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ transactionBase64, wallet }),
      });
      const simJ = await simR.json() as {
        ok: boolean; solDeltaLamports?: number | null; botTaxDetected?: boolean; error?: string;
      };
      if (!simJ.ok) {
        setFlow({ kind: 'error', message: humanizeBackendError(simJ.error, simR.status) });
        return;
      }
      setFlow({
        kind: 'ready_to_sign',
        transactionBase64,
        solDeltaLamports: simJ.solDeltaLamports ?? null,
        botTaxDetected: simJ.botTaxDetected ?? false,
      });
    } catch (err) {
      setFlow({ kind: 'error', message: humanizeThrownError((err as Error).message) });
    }
  }

  // The mintLimit `used`/`remaining` numbers are a snapshot taken at
  // Inspect time — nothing re-fetches them after a mint lands, so without
  // this the panel keeps showing the pre-mint count forever (looked like a
  // stuck/buggy counter, but it was just never being updated at all).
  // Bumped optimistically per confirmed signature: we know for certain our
  // own mint landed, so there's nothing to wait on a re-fetch for.
  function bumpMintedCount() {
    setLoaded((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        inspection: {
          ...prev.inspection,
          itemsRedeemed: prev.inspection.itemsRedeemed != null
            ? String(Number(prev.inspection.itemsRedeemed) + 1)
            : prev.inspection.itemsRedeemed,
          groups: prev.inspection.groups.map((g) => {
            if (g.label !== selectedGroup || !g.mintLimit) return g;
            const used = (g.mintLimit.used ?? 0) + 1;
            return { ...g, mintLimit: { ...g.mintLimit, used, remaining: Math.max(0, g.mintLimit.limit - used) } };
          }),
        },
      };
    });
  }

  async function handleConfirmSign() {
    if (flow.kind !== 'ready_to_sign') return;
    setFlow({ kind: 'minting', step: 'signing' });
    try {
      const result = await signSendAndConfirm(flow.transactionBase64);
      setFlow({ kind: 'success', sig: result.signature });
      bumpMintedCount();
    } catch (err) {
      setFlow({ kind: 'error', message: humanizeThrownError((err as Error).message) });
    }
  }

  // Batch mint: build + simulate every item first (same safety rails as a
  // single mint, same bot-tax abort — stops queuing further items the
  // moment one comes back blocked/errored), THEN sign every clean item
  // with ONE Phantom approval (signAllAndSend) instead of one popup per
  // item. Packing all N mints into a single on-chain transaction doesn't
  // fit (measured: 10 MintV1 instructions serialize to ~1830 bytes, over
  // the 1232-byte legacy wire limit) — this is what "one click mints 10"
  // actually is on real candy-machine sites: N separate transactions,
  // signed together.
  async function handleMintBatch() {
    if (!wallet || !loaded || selectedGroup === undefined) return;
    const { family, inspection, referenceCollection, referenceCollectionUpdateAuthority } = loaded;
    const collection = inspection.collection ?? referenceCollection;
    if (!collection) { setFlow({ kind: 'error', message: 'No collection address resolved.' }); return; }

    const total = Math.max(1, Math.floor(quantity));
    const items: BatchItem[] = Array.from({ length: total }, () => ({ status: 'pending' }));
    setFlow({ kind: 'batch', total, items: [...items] });

    // ── phase 1: build + simulate every item, stop at the first bad one ──
    const readyTxs: string[] = [];
    for (let i = 0; i < total; i++) {
      items[i] = { status: 'building' };
      setFlow({ kind: 'batch', total, items: [...items] });
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
          items[i] = { status: 'error', message: humanizeBackendError(j.error, r.status) };
          setFlow({ kind: 'batch', total, items: [...items] });
          break;
        }

        items[i] = { status: 'simulating' };
        setFlow({ kind: 'batch', total, items: [...items] });
        const simR = await fetch(`${API_BASE}/api/tools/candy-mint/simulate-tx`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ transactionBase64: j.transactionBase64, wallet }),
        });
        const simJ = await simR.json() as {
          ok: boolean; solDeltaLamports?: number | null; botTaxDetected?: boolean; error?: string;
        };
        if (!simJ.ok) {
          items[i] = { status: 'error', message: humanizeBackendError(simJ.error, simR.status) };
          setFlow({ kind: 'batch', total, items: [...items] });
          break;
        }
        if (simJ.botTaxDetected) {
          items[i] = { status: 'blocked', message: 'bot-tax path detected — stopped, not signing' };
          setFlow({ kind: 'batch', total, items: [...items] });
          break;
        }

        items[i] = { status: 'ready', solDeltaLamports: simJ.solDeltaLamports ?? null };
        setFlow({ kind: 'batch', total, items: [...items] });
        readyTxs.push(j.transactionBase64);
      } catch (err) {
        items[i] = { status: 'error', message: humanizeThrownError((err as Error).message) };
        setFlow({ kind: 'batch', total, items: [...items] });
        break;
      }
    }

    if (readyTxs.length === 0) {
      setFlow({ kind: 'batch', total, items: [...items], done: true });
      return;
    }

    // ── phase 2: one Phantom approval for every ready item ──────────────
    const readyIndexes = items
      .map((it, i) => (it.status === 'ready' ? i : -1))
      .filter((i) => i >= 0);
    try {
      for (const i of readyIndexes) items[i] = { ...items[i], status: 'signing' };
      setFlow({ kind: 'batch', total, items: [...items] });

      await signAllAndSend(readyTxs, (readyPos, signature) => {
        const i = readyIndexes[readyPos];
        items[i] = { ...items[i], status: 'confirming', sig: signature };
        setFlow({ kind: 'batch', total, items: [...items] });
      });

      // ── phase 3: wait for each to actually land, in submission order ──
      for (const i of readyIndexes) {
        const sig = items[i].sig;
        if (!sig) continue;
        await waitForConfirmation(sig);
        items[i] = { ...items[i], status: 'success' };
        setFlow({ kind: 'batch', total, items: [...items] });
        bumpMintedCount();
      }
    } catch (err) {
      // signAllTransactions rejected (e.g. user cancelled the approval) —
      // none of the ready items got sent; mark them back as blocked rather
      // than stuck on "signing" forever.
      const message = humanizeThrownError((err as Error).message);
      for (const i of readyIndexes) {
        if (items[i].status !== 'success') items[i] = { ...items[i], status: 'error', message };
      }
      setFlow({ kind: 'batch', total, items: [...items] });
    }

    // Release the busy lock whether the batch ran to completion or stopped
    // early on an error/blocked item — otherwise `busy` (tied to
    // flow.kind === 'batch') never clears and the Mint control can't come
    // back to start a new batch.
    setFlow({ kind: 'batch', total, items: [...items], done: true });
  }

  function handleMintClick() {
    if (quantity > 1) void handleMintBatch();
    else void handleMint();
  }

  const busy = flow.kind === 'inspecting' || flow.kind === 'minting' || (flow.kind === 'batch' && !flow.done);
  const selected = loaded?.inspection.groups.find((g) => g.label === selectedGroup) ?? null;
  const mintExhausted = selected?.mintLimit != null && selected.mintLimit.remaining === 0;
  const soldOut = loaded != null
    && loaded.inspection.itemsRedeemed != null && loaded.inspection.itemsAvailable != null
    && loaded.inspection.itemsRedeemed === loaded.inspection.itemsAvailable;
  const mintDisabled = !wallet || busy || !loaded || !loaded.inspection.alive || soldOut || !selected?.supported || mintExhausted;
  const quantityCap = Math.max(1, selected?.mintLimit?.remaining ?? 25);

  // Keeps the selected quantity in bounds as `remaining` shrinks (each
  // confirmed mint, or a wallet switch) — without this, picking e.g. 9 then
  // minting them all left `quantity` stuck at 9 with nothing to clamp it,
  // so the next attempt (now capped at 1 remaining) silently tried to batch
  // 9 anyway. The stepper's own +/- already respect `max`, but that doesn't
  // retroactively fix a value set before the cap dropped.
  useEffect(() => {
    setQuantity((q) => Math.min(Math.max(1, q), quantityCap));
  }, [quantityCap]);

  const heroTitle = loaded?.collectionMeta?.name ?? (loaded ? short(loaded.inspection.candyMachine) : null);
  const priceLabel = selected?.solPaymentLamports != null
    ? `${(Number(selected.solPaymentLamports) / 1e9).toFixed(selected.solPaymentLamports === '0' ? 0 : 3)} SOL`
    : null;

  return (
    <div style={{ maxWidth: 980, margin: '0 auto', padding: '32px 20px 60px', ...MONO }}>
      {/* ── utility strip: wallet + (once a drop is loaded) a compact re-loader ── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: loaded ? 28 : 16 }}>
        {wallet ? (
          <WalletChip wallet={wallet} onDisconnect={handleDisconnect} />
        ) : (
          <PrimaryButton onClick={handleConnect}>Connect Phantom</PrimaryButton>
        )}
        <div style={{ flex: 1 }} />
        {loaded && (
          <>
            <ToolTextInput
              value={sig}
              onChange={(e) => setSig(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleInspect(); }}
              placeholder="load a different drop by reference tx signature"
              style={{ width: 340, maxWidth: '100%' }}
            />
            <ToolButton onClick={handleInspect} disabled={busy || !sig.trim()}>
              {flow.kind === 'inspecting' ? 'checking…' : 'Inspect'}
            </ToolButton>
          </>
        )}
      </div>

      {/* ── start screen — centered loader, shown until a drop is loaded ─── */}
      {!loaded && (
        <div
          style={{
            maxWidth: 520, margin: '40px auto 0', padding: '40px 36px', borderRadius: 20, textAlign: 'center',
            background: `radial-gradient(140% 160% at 50% 0%, ${alpha(VL.purpleDeep, 0.16)} 0%, transparent 60%), linear-gradient(180deg, ${alpha(VL.purpleDeep, 0.08)} 0%, rgba(0,0,0,0.5) 100%)`,
            border: `1px solid ${alpha(VL.purpleTint, ALPHA_BORDER)}`,
            boxShadow: `inset 0 1px 0 rgba(255,255,255,0.05), 0 24px 60px rgba(0,0,0,0.55), 0 0 40px ${alpha(VL.purpleDeep, 0.1)}`,
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', color: rgb(VL.purpleTint), marginBottom: 10 }}>
            VictoryLabs · Candy Mint
          </div>
          <h1 style={{ fontSize: 24, fontWeight: 800, color: VLText.primary, margin: '0 0 10px' }}>Candy Machine Direct Mint</h1>
          <p style={{ fontSize: 12.5, color: VLText.muted, lineHeight: 1.6, margin: '0 0 22px' }}>
            Direct on-chain minting, no frontend needed. Paste a recent mint tx to load the drop.
          </p>
          <div style={{ display: 'flex', gap: 8 }}>
            <ToolTextInput
              value={sig}
              onChange={(e) => setSig(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleInspect(); }}
              placeholder="mint transaction signature"
              big
              style={{ flex: 1 }}
            />
            <ToolButton onClick={handleInspect} disabled={busy || !sig.trim()} big>
              {flow.kind === 'inspecting' ? 'checking…' : 'Inspect'}
            </ToolButton>
          </div>
          {flow.kind === 'error' && (
            <div style={{ fontSize: 12, color: rgb(VL.redStrong), marginTop: 16 }}>{flow.message}</div>
          )}
        </div>
      )}

      {/* ── launchpad hero — stays mounted through the whole mint flow ──── */}
      {loaded && (
        <div
          style={{
            position: 'relative', borderRadius: 20, overflow: 'hidden', marginBottom: 20,
            background: `radial-gradient(120% 140% at 15% 10%, ${alpha(VL.purpleDeep, 0.18)} 0%, transparent 55%), linear-gradient(180deg, ${alpha(VL.purpleDeep, 0.09)} 0%, rgba(0,0,0,0.55) 100%)`,
            border: `1px solid ${alpha(VL.purpleTint, ALPHA_BORDER)}`,
            boxShadow: `inset 0 1px 0 rgba(255,255,255,0.05), 0 24px 60px rgba(0,0,0,0.55), 0 0 40px ${alpha(VL.purpleDeep, 0.12)}`,
          }}
        >
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 32, padding: 32 }}>
            <div style={{ width: 340, height: 340, flexShrink: 0, borderRadius: 16, overflow: 'hidden', margin: '0 auto' }}>
              <ItemThumb
                imageUrl={loaded.collectionMeta?.image ?? null}
                color={rgb(VL.purpleTint)}
                abbr={(heroTitle ?? '??').slice(0, 2).toUpperCase()}
                size={340}
              />
            </div>

            <div style={{ flex: '1 1 340px', minWidth: 280, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <LiveDot color={loaded.inspection.alive ? rgb(VL.greenStrong) : rgb(VL.gray)} />
                <span style={{
                  fontSize: 11, fontWeight: 700, letterSpacing: '0.8px', textTransform: 'uppercase',
                  color: loaded.inspection.alive ? rgb(VL.greenStrong) : VLText.muted,
                }}>
                  {loaded.inspection.alive ? 'Minting now' : 'Closed — no longer mintable'}
                </span>
                <span style={{ fontSize: 10, color: VLText.muted, border: `1px solid ${alpha(VL.purpleTint, ALPHA_BORDER)}`, borderRadius: 4, padding: '1px 6px' }}>
                  {loaded.family === 'core' ? 'MPL CORE' : 'TOKEN METADATA'}
                </span>
              </div>

              <h1 style={{ fontSize: 30, fontWeight: 800, color: VLText.primary, margin: 0, lineHeight: 1.15 }}>
                {heroTitle}
              </h1>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {loaded.collectionMeta?.creator && (
                  <Pill label={`by ${short(loaded.collectionMeta.creator)}`} color={rgb(VL.purpleTint)} />
                )}
                <Pill label="on Solana" color={rgb(VL.purpleTint)} />
                <Pill label={short(loaded.inspection.candyMachine)} title="candy machine" color={rgb(VL.gray)} />
              </div>

              {loaded.collectionMeta?.description && (
                <p style={{ fontSize: 12.5, color: VLText.muted, lineHeight: 1.6, margin: 0, maxWidth: 480 }}>
                  {loaded.collectionMeta.description}
                </p>
              )}

              {loaded.inspection.alive && loaded.inspection.groups.length > 1 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                  {loaded.inspection.groups.map((g) => (
                    <Pill
                      key={g.label ?? '__root__'}
                      label={g.label ?? '(root)'}
                      active={selectedGroup === g.label}
                      color={g.supported ? rgb(VL.greenStrong) : rgb(VL.redStrong)}
                      onClick={() => setSelectedGroup(g.label)}
                      title={g.supported ? g.enabledGuards.join(', ') : `unsupported: ${g.unsupportedGuards.join(', ')}`}
                    />
                  ))}
                </div>
              )}

              {selected && !selected.supported && (
                <StatusNotice tone="warning">
                  This group needs more than a wallet signature (unsupported: {selected.unsupportedGuards.join(', ')}) — can't mint it from here.
                </StatusNotice>
              )}

              {/* Explicit reasons the mint control is missing — a blank gap
                  where the button used to be reads as "is the page broken?"
                  to anyone who doesn't already know this tool's premise
                  (machines close/sell out). Say so plainly instead. Boxed
                  as a distinct notice, not plain prose — at the same
                  font-size/color as the collection description this read
                  as the same kind of element, when it's a status, not copy. */}
              {!loaded.inspection.alive && (
                <StatusNotice>
                  This candy machine is closed — it no longer exists on-chain (fully minted, or the drop ended).
                </StatusNotice>
              )}
              {loaded.inspection.alive && soldOut && (
                <StatusNotice>
                  Fully minted ({loaded.inspection.itemsRedeemed}/{loaded.inspection.itemsAvailable}) — nothing left to mint.
                </StatusNotice>
              )}

              {/* ── mint control — the ONE spot that morphs through the flow ── */}
              {loaded.inspection.alive && !soldOut && selected?.supported && (
                <div style={{ marginTop: 8 }}>
                  {flow.kind === 'ready_to_sign' ? (
                    <ReadyToSignControl
                      flow={flow}
                      busy={busy}
                      onConfirm={handleConfirmSign}
                      onCancel={() => setFlow({ kind: 'idle' })}
                    />
                  ) : flow.kind === 'batch' && !flow.done ? (
                    <BatchControl flow={flow} />
                  ) : mintExhausted ? (
                    <StatusNotice>
                      You've hit your mint limit on this wallet ({selected?.mintLimit?.limit}/{selected?.mintLimit?.limit}) — switch wallets to mint more.
                    </StatusNotice>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                      <QuantityStepper value={quantity} max={quantityCap} onChange={setQuantity} disabled={busy} />
                      <PrimaryButton onClick={handleMintClick} disabled={mintDisabled} big>
                        {flow.kind === 'minting'
                          ? flow.step
                          : quantity > 1
                            ? `Mint ×${quantity}`
                            : priceLabel
                              ? `Mint for ${priceLabel}`
                              : 'Mint'}
                      </PrimaryButton>
                    </div>
                  )}

                  {flow.kind === 'success' && (
                    <div style={{ fontSize: 12, color: rgb(VL.greenStrong), marginTop: 10 }}>
                      Minted —{' '}
                      <a href={`https://solscan.io/tx/${flow.sig}`} target="_blank" rel="noopener noreferrer" style={{ color: rgb(VL.purpleTint) }}>
                        {short(flow.sig)}
                      </a>
                    </div>
                  )}
                  {flow.kind === 'error' && (
                    <div style={{ fontSize: 12, color: rgb(VL.redStrong), marginTop: 10 }}>{flow.message}</div>
                  )}
                </div>
              )}

              <div style={{ fontSize: 11.5, color: VLText.faint, marginTop: 10 }}>
                {loaded.inspection.itemsRedeemed != null && (
                  <>{loaded.inspection.itemsRedeemed} minted{loaded.inspection.itemsAvailable ? ` / ${loaded.inspection.itemsAvailable}` : ''}</>
                )}
                {selected?.mintLimit && (
                  <> · {selected.mintLimit.limit} per wallet{selected.mintLimit.remaining != null ? ` (${selected.mintLimit.remaining} left for you)` : ''}</>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── on-chain detail (address-level, collapsed under the hero) ──── */}
      {loaded && (
        <div style={{ fontSize: 11, color: VLText.faint, marginTop: 20, display: 'flex', flexWrap: 'wrap', gap: 14 }}>
          <span>candyMachine: {short(loaded.inspection.candyMachine)}</span>
          <span>candyGuard: {short(loaded.inspection.candyGuard)}</span>
          {loaded.inspection.collection && <span>collection: {short(loaded.inspection.collection)}</span>}
        </div>
      )}
    </div>
  );
}

const ALPHA_BORDER = 0.28;

const BATCH_STATUS_COLOR: Record<BatchItemStatus, string> = {
  pending: VLText.faint,
  building: VLText.muted,
  simulating: VLText.muted,
  ready: VLText.muted,
  signing: rgb(VL.purpleTint),
  confirming: rgb(VL.purpleTint),
  success: rgb(VL.greenStrong),
  blocked: rgb(VL.redStrong),
  error: rgb(VL.redStrong),
};

function BatchStatusBadge({ status }: { status: BatchItemStatus }) {
  return <span style={{ color: BATCH_STATUS_COLOR[status], minWidth: 70, display: 'inline-block' }}>{status}</span>;
}

// A boxed, bordered notice — distinct from the collection's own description
// paragraph, which is plain flowing prose at the same neutral tone. Without
// this the two read as the same kind of element (same size/color), even
// though one is body copy and the other is a status about why there's no
// Mint button right now.
function StatusNotice({ tone = 'neutral', children }: { tone?: 'neutral' | 'warning'; children: React.ReactNode }) {
  const accent = tone === 'warning' ? VL.redStrong : VL.purpleTint;
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 7,
      fontSize: 11.5, fontWeight: 600, color: tone === 'warning' ? rgb(VL.redStrong) : VLText.primary,
      lineHeight: 1.5, padding: '9px 11px', borderRadius: 8, marginTop: 8,
      background: alpha(accent, 0.08), border: `1px solid ${alpha(accent, ALPHA_BORDER)}`,
    }}>
      <span style={{ color: rgb(accent), flexShrink: 0, marginTop: 1 }}>{tone === 'warning' ? '⚠' : '●'}</span>
      <span>{children}</span>
    </div>
  );
}

// Replaces the quantity+Mint row in place — cost line + Sign & Send button,
// exactly where the Mint button was, per how a real launchpad's own button
// morphs into a confirm state rather than opening a separate view.
function ReadyToSignControl({ flow, busy, onConfirm, onCancel }: {
  flow: { kind: 'ready_to_sign'; solDeltaLamports: number | null; botTaxDetected: boolean };
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        <span style={{ fontSize: 10.5, color: VLText.muted }}>
          {flow.botTaxDetected ? '⚠ bot-tax path — do not sign' : 'Simulated cost (pre-signature)'}
        </span>
        <span style={{ fontSize: 15, fontWeight: 700, color: flow.botTaxDetected ? rgb(VL.redStrong) : rgb(VL.greenStrong) }}>
          {flow.solDeltaLamports != null ? `${(flow.solDeltaLamports / 1e9).toFixed(5)} SOL` : 'unknown'}
        </span>
      </div>
      <PrimaryButton onClick={onConfirm} disabled={busy || flow.botTaxDetected} big>
        {busy ? 'signing' : 'Sign & Send'}
      </PrimaryButton>
      <ToolButton onClick={onCancel} disabled={busy}>
        Cancel
      </ToolButton>
    </div>
  );
}

function BatchControl({ flow }: { flow: { kind: 'batch'; total: number; items: BatchItem[] } }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 11, color: VLText.muted }}>
        Minting {flow.items.filter((it) => it.status === 'success').length}/{flow.total}
        {' '}(one Phantom approval for all of them):
      </div>
      {flow.items.map((it, i) => (
        <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
          <span style={{ color: VLText.faint, width: 22 }}>#{i + 1}</span>
          <BatchStatusBadge status={it.status} />
          {it.solDeltaLamports != null && ['ready', 'signing', 'confirming', 'success'].includes(it.status) && (
            <span style={{ color: rgb(VL.greenStrong), fontWeight: 600 }}>
              {(it.solDeltaLamports / 1e9).toFixed(5)} SOL
            </span>
          )}
          {it.sig && (
            <a href={`https://solscan.io/tx/${it.sig}`} target="_blank" rel="noopener noreferrer" style={{ color: rgb(VL.purpleTint) }}>
              {short(it.sig)}
            </a>
          )}
          {it.message && <span style={{ color: rgb(VL.redStrong) }}>{it.message}</span>}
        </div>
      ))}
    </div>
  );
}

function QuantityStepper({ value, max, onChange, disabled }: {
  value: number; max: number; onChange: (v: number) => void; disabled?: boolean;
}) {
  const clamp = (v: number) => Math.max(1, Math.min(max, v));
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 0,
      background: 'rgba(255,255,255,0.03)', border: `1px solid ${alpha(VL.purpleTint, ALPHA_BORDER)}`,
      borderRadius: 8, overflow: 'hidden', height: 40,
    }}>
      <StepperButton onClick={() => onChange(clamp(value - 1))} disabled={disabled || value <= 1}>−</StepperButton>
      <div style={{ width: 40, textAlign: 'center', fontSize: 15, fontWeight: 700, color: VLText.primary }}>{value}</div>
      <StepperButton onClick={() => onChange(clamp(value + 1))} disabled={disabled || value >= max}>+</StepperButton>
    </div>
  );
}

function StepperButton({ onClick, disabled, children }: {
  onClick: () => void; disabled?: boolean; children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        width: 36, height: 40, border: 'none', background: 'transparent',
        color: disabled ? VLText.faint : VLText.primary, fontSize: 16, cursor: disabled ? 'not-allowed' : 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      {children}
    </button>
  );
}

// The one CTA look this page keeps local: a solid lavender fill for
// state-changing actions (Connect, Mint, Sign & Send). Read-only actions
// (Inspect) use the shared `ToolButton` from mmm-shared instead.
function PrimaryButton({ onClick, disabled, children, big }: {
  onClick: () => void; disabled?: boolean; children: React.ReactNode; big?: boolean;
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
      style={{
        ...btnStyle,
        ...(big ? { padding: '10px 22px', fontSize: 14, height: 40 } : null),
        opacity: disabled ? 0.5 : 1, filter, outline: 'none', transition: 'filter 0.1s',
      }}
    >
      {children}
    </button>
  );
}

// Reusable-by-design (not wired into other /tools pages yet): a green-dot
// pill with click-to-copy address + inline disconnect, replacing the plain
// "Connected: 71pWA…vFTPs" + underlined-text-link pattern this page (and
// every other /tools page) previously copied.
function WalletChip({ wallet, onDisconnect }: { wallet: string; onDisconnect: () => void }) {
  const [copied, setCopied] = useState(false);
  const [hoverX, setHoverX] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(wallet).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <div style={{
      display: 'inline-flex', alignItems: 'center', gap: 8,
      padding: '5px 6px 5px 10px', borderRadius: 20,
      background: alpha(VL.greenStrong, ALPHA.tintWeak),
      border: `1px solid ${alpha(VL.greenStrong, ALPHA.border)}`,
    }}>
      <LiveDot color={rgb(VL.greenStrong)} />
      <button
        onClick={copy}
        title={wallet}
        style={{
          background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontFamily: 'inherit',
          fontSize: 12, fontWeight: 600, color: copied ? rgb(VL.greenStrong) : VLText.primary,
        }}
      >
        {copied ? 'copied!' : short(wallet)}
      </button>
      <button
        onClick={onDisconnect}
        onMouseEnter={() => setHoverX(true)}
        onMouseLeave={() => setHoverX(false)}
        title="Disconnect"
        style={{
          background: 'none', border: 'none', padding: '0 2px', cursor: 'pointer', lineHeight: 1,
          fontSize: 14, color: hoverX ? VLText.primary : VLText.faint, transition: 'color 0.12s',
        }}
      >
        ×
      </button>
    </div>
  );
}

const btnStyle: React.CSSProperties = {
  padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
  background: rgb(VL.purpleTint), color: '#000', border: 'none', borderRadius: 8,
};
