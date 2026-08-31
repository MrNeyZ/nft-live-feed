'use client';

// CreateV2 tool — personal use only. Companion to Candy Mint, but for the
// OTHER mint shape: a bare Token Metadata createV1+mintV1 with no Candy
// Machine/Guard involved — the shape a self-authored 1-of-1 mint actually is
// on-chain (see ../../../../../src/direct-mint/build.ts's header comment).
//
// Layout mirrors Candy Mint's launchpad-hero read 1:1 (start screen → hero
// card → mint button in place). Same interaction too: paste a reference tx
// signature (a landed self-mint, not a candy machine), the backend decodes
// the minted asset's own on-chain fields (name/symbol/uri/image/description/
// royalty/standard/collection) via getTransaction+getAsset, and the hero
// renders off that — nothing hand-typed except confirming standard/
// collection, which the decode already prefills.

import { useEffect, useState } from 'react';
import { authHeaders } from '@/runtime/auth';
import { connectPhantom, eagerConnectPhantom, getPhantom, signSendAndConfirm, signAllAndSend } from '@/wallet/phantom';
import { API_BASE, MONO, ToolTextInput, short } from '@/app/tools/mmm-shared';
import { VL, VLText, ALPHA, alpha, rgb, hex } from '@/lib/palette';
import { ItemThumb, LiveDot, Pill, CtaButton } from '@/soloist/shared';

const ALPHA_BORDER = 0.28;

type TokenStandardChoice = 'nft' | 'pnft' | 'core';

interface LoadedMeta {
  mint: string;
  name: string;
  symbol: string;
  uri: string;
  image: string | null;
  description: string | null;
  royaltyBp: number;
  standard: TokenStandardChoice;
  collection: string | null;
}

type FlowState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'building' }
  | { kind: 'simulating' }
  | { kind: 'ready_to_sign'; transactionBase64: string; solDeltaLamports: number | null; mint: string }
  | { kind: 'signing' }
  | { kind: 'success'; sig: string; mint: string }
  | { kind: 'error'; message: string };

const BACKEND_ERROR_MESSAGES: Record<string, string> = {
  invalid_wallet: 'Connect a wallet first.',
  missing_or_invalid_standard: 'Pick NFT or pNFT.',
  missing_or_invalid_fields: 'Name and metadata URI are required.',
  invalid_collection: 'That collection address is not a valid pubkey.',
  not_collection_authority: "Your wallet isn't that collection's update authority (or an approved delegate) — can't mint into it.",
  collection_metadata_not_found: "Couldn't find that collection's metadata on-chain.",
  collection_not_found: "Couldn't find that Core collection on-chain.",
  invalid_delegate: 'That delegate address is not a valid pubkey.',
  delegate_is_self: "That's already your own wallet.",
  already_a_delegate: 'That address is already a delegate on this collection.',
  update_delegate_plugin_locked: "This collection's delegate list is locked to another address (often the launchpad's own PDA, not the collection owner) — can't be changed from here.",
  missing_name: 'Name is required.',
  missing_uri: 'Metadata URI is required.',
  invalid_royaltyBp: 'Royalty must be between 0 and 10000 bps.',
  rate_limited: 'Rate limited — wait a few seconds and try again.',
  missing_sig: 'Paste a mint transaction signature.',
  signature_not_found: 'No transaction found for that signature.',
  reference_tx_failed_onchain: 'That reference transaction failed on-chain — try a different one.',
  no_nft_mint_found_in_transaction: "That transaction doesn't look like an NFT mint (no fresh 1-of-1 token found).",
  asset_has_no_metadata_uri: "Couldn't resolve that asset's metadata URI.",
  missing_example_uri: 'Paste an example metadata URI from any existing NFT in the collection.',
  invalid_number: 'Enter a valid NFT number.',
  example_uri_has_no_number: "That URI doesn't end in a number — can't derive other NFTs' URIs from it.",
  unsafe_metadata_url: 'That URI points somewhere this tool refuses to fetch from.',
  metadata_not_found: "No metadata found at that NFT number's URI — it may not exist.",
  metadata_fetch_failed: "Couldn't fetch that NFT number's metadata URI.",
  metadata_too_large: 'That metadata file is too large.',
  metadata_not_valid_json: "That URI didn't return valid metadata JSON.",
  metadata_missing_name: 'That metadata JSON has no name field.',
};

function humanizeBackendError(code: string | undefined): string {
  if (code) {
    const base = code.split(':')[0].trim();
    return BACKEND_ERROR_MESSAGES[base] ?? code;
  }
  return 'Something went wrong.';
}

function humanizeThrownError(message: string): string {
  if (/user rejected/i.test(message)) return 'Signature request rejected.';
  return message;
}

interface ResolvedDuplicateMetadata {
  n: number;
  uri: string;
  name: string;
  image: string | null;
  description: string | null;
  royaltyBp: number;
}

async function resolveDuplicateMetadata(exampleUri: string, n: number): Promise<
  { ok: true; resolved: ResolvedDuplicateMetadata } | { ok: false; error: string }
> {
  const r = await fetch(
    `${API_BASE}/api/tools/direct-mint/duplicate-metadata?exampleUri=${encodeURIComponent(exampleUri)}&n=${n}`,
    { headers: { ...authHeaders() } },
  );
  return r.json() as Promise<{ ok: true; resolved: ResolvedDuplicateMetadata } | { ok: false; error: string }>;
}

type DupBatchItemStatus = 'pending' | 'resolving' | 'building' | 'simulating' | 'ready' | 'signing' | 'success' | 'error';

interface DupBatchItem {
  n: number;
  status: DupBatchItemStatus;
  name?: string;
  sig?: string;
  message?: string;
}

type DupBatchState =
  | { kind: 'idle' }
  | { kind: 'running'; total: number; items: DupBatchItem[]; done?: boolean };

export default function CreateV2Page() {
  const [wallet, setWallet] = useState<string | null>(null);
  const [sig, setSig] = useState('');
  const [loaded, setLoaded] = useState<LoadedMeta | null>(null);
  const [standard, setStandard] = useState<TokenStandardChoice>('pnft');
  const [collection, setCollection] = useState('');
  const [flow, setFlow] = useState<FlowState>({ kind: 'idle' });

  // "Duplicate existing NFT" — the other way to reach the same `loaded` hero
  // (see handleLoadDuplicate below): resolve name/uri/image/royalty from an
  // existing NFT's own numbered metadata file instead of a landed tx
  // signature. `dupExampleUri` is kept around after a single load so the
  // batch panel below can reuse it without retyping.
  const [startMode, setStartMode] = useState<'signature' | 'duplicate'>('signature');
  const [dupCollection, setDupCollection] = useState('');
  const [dupExampleUri, setDupExampleUri] = useState('');
  const [dupNumber, setDupNumber] = useState('1');
  const [dupCount, setDupCount] = useState('10');
  const [dupBatch, setDupBatch] = useState<DupBatchState>({ kind: 'idle' });

  useEffect(() => {
    void eagerConnectPhantom().then((pk) => { if (pk) setWallet(pk); });
  }, []);

  const busy = flow.kind === 'loading' || flow.kind === 'building' || flow.kind === 'simulating' || flow.kind === 'signing';
  const dupBatchBusy = dupBatch.kind === 'running' && !dupBatch.done;

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
    setFlow({ kind: 'idle' });
  }

  async function handleLoad() {
    if (!sig.trim()) return;
    setFlow({ kind: 'loading' });
    try {
      const r = await fetch(`${API_BASE}/api/tools/direct-mint/inspect?sig=${encodeURIComponent(sig.trim())}`, {
        headers: { ...authHeaders() },
      });
      const j = await r.json() as { ok: boolean; decoded?: LoadedMeta; error?: string };
      if (!j.ok || !j.decoded) {
        setFlow({ kind: 'error', message: humanizeBackendError(j.error) });
        return;
      }
      setLoaded(j.decoded);
      setStandard(j.decoded.standard);
      setCollection(j.decoded.collection ?? '');
      setFlow({ kind: 'idle' });
    } catch (err) {
      setFlow({ kind: 'error', message: humanizeThrownError((err as Error).message) });
    }
  }

  // Single duplicate: resolve NFT #n's metadata and drop it straight into
  // the SAME `loaded` state the signature path fills — everything past
  // this point (hero, standard/collection pills, handleMint) is unchanged.
  async function handleLoadDuplicate() {
    const n = Number(dupNumber);
    if (!dupCollection.trim() || !dupExampleUri.trim() || !Number.isFinite(n)) return;
    setFlow({ kind: 'loading' });
    try {
      const j = await resolveDuplicateMetadata(dupExampleUri.trim(), n);
      if (!j.ok) {
        setFlow({ kind: 'error', message: humanizeBackendError(j.error) });
        return;
      }
      setLoaded({
        mint: '',
        name: j.resolved.name,
        symbol: '',
        uri: j.resolved.uri,
        image: j.resolved.image,
        description: j.resolved.description,
        royaltyBp: j.resolved.royaltyBp,
        standard: 'core',
        collection: dupCollection.trim(),
      });
      setStandard('core');
      setCollection(dupCollection.trim());
      setFlow({ kind: 'idle' });
    } catch (err) {
      setFlow({ kind: 'error', message: humanizeThrownError((err as Error).message) });
    }
  }

  // Batch duplicate: always #1 through `dupCount` (per the tool's own
  // convention — a real drop's numbering starts at 1 and is contiguous, so
  // "how many" is the only input that makes sense; a from/to range would
  // just invite gaps). Same two-phase shape as Candy Mint's quantity batch
  // (build+simulate every item first, stop at the first failure, THEN one
  // Phantom approval for everything that came back clean via
  // signAllAndSend) — this is what "mint many" looks like without a real
  // candy machine to hand N mint calls to.
  async function handleDuplicateBatch() {
    if (!wallet) return;
    const collectionAddr = dupCollection.trim();
    const exampleUri = dupExampleUri.trim();
    const countNum = Number(dupCount);
    if (!collectionAddr || !exampleUri || !Number.isFinite(countNum) || countNum < 1) return;
    const total = Math.floor(countNum);

    const items: DupBatchItem[] = Array.from({ length: total }, (_, i) => ({ status: 'pending', n: i + 1 }));
    setDupBatch({ kind: 'running', total, items: [...items] });

    const readyTxs: string[] = [];
    for (let i = 0; i < total; i++) {
      items[i] = { ...items[i], status: 'resolving' };
      setDupBatch({ kind: 'running', total, items: [...items] });
      try {
        const mj = await resolveDuplicateMetadata(exampleUri, items[i].n);
        if (!mj.ok) {
          items[i] = { ...items[i], status: 'error', message: humanizeBackendError(mj.error) };
          setDupBatch({ kind: 'running', total, items: [...items] });
          break;
        }
        items[i] = { ...items[i], status: 'building', name: mj.resolved.name };
        setDupBatch({ kind: 'running', total, items: [...items] });

        const br = await fetch(`${API_BASE}/api/tools/direct-mint/build-tx`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({
            wallet, name: mj.resolved.name, symbol: '', uri: mj.resolved.uri,
            royaltyBp: mj.resolved.royaltyBp, standard: 'core', collection: collectionAddr,
          }),
        });
        const bj = await br.json() as { ok: boolean; transactionBase64?: string; error?: string };
        if (!bj.ok || !bj.transactionBase64) {
          items[i] = { ...items[i], status: 'error', message: humanizeBackendError(bj.error) };
          setDupBatch({ kind: 'running', total, items: [...items] });
          break;
        }

        items[i] = { ...items[i], status: 'simulating' };
        setDupBatch({ kind: 'running', total, items: [...items] });
        const sr = await fetch(`${API_BASE}/api/tools/direct-mint/simulate-tx`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ transactionBase64: bj.transactionBase64, wallet }),
        });
        const sj = await sr.json() as { ok: boolean; error?: string };
        if (!sj.ok) {
          items[i] = { ...items[i], status: 'error', message: humanizeBackendError(sj.error) };
          setDupBatch({ kind: 'running', total, items: [...items] });
          break;
        }

        items[i] = { ...items[i], status: 'ready' };
        setDupBatch({ kind: 'running', total, items: [...items] });
        readyTxs.push(bj.transactionBase64);
      } catch (err) {
        items[i] = { ...items[i], status: 'error', message: humanizeThrownError((err as Error).message) };
        setDupBatch({ kind: 'running', total, items: [...items] });
        break;
      }
    }

    if (readyTxs.length === 0) {
      setDupBatch({ kind: 'running', total, items: [...items], done: true });
      return;
    }

    const readyIndexes = items.map((it, i) => (it.status === 'ready' ? i : -1)).filter((i) => i >= 0);
    try {
      for (const i of readyIndexes) items[i] = { ...items[i], status: 'signing' };
      setDupBatch({ kind: 'running', total, items: [...items] });

      await signAllAndSend(readyTxs, (readyPos, signature) => {
        const i = readyIndexes[readyPos];
        items[i] = { ...items[i], status: 'success', sig: signature };
        setDupBatch({ kind: 'running', total, items: [...items] });
      });
    } catch (err) {
      const message = humanizeThrownError((err as Error).message);
      for (const i of readyIndexes) {
        if (items[i].status !== 'success') items[i] = { ...items[i], status: 'error', message };
      }
      setDupBatch({ kind: 'running', total, items: [...items] });
    }

    // Same reasoning as Candy Mint's batch: release the busy lock whether
    // the batch completed or stopped early, otherwise the panel can never
    // start another run.
    setDupBatch({ kind: 'running', total, items: [...items], done: true });
  }

  async function handleMint() {
    if (!wallet || !loaded) return;
    setFlow({ kind: 'building' });
    try {
      const r = await fetch(`${API_BASE}/api/tools/direct-mint/build-tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
          wallet,
          name: loaded.name,
          symbol: loaded.symbol,
          uri: loaded.uri,
          royaltyBp: loaded.royaltyBp,
          standard,
          collection: collection.trim() || null,
        }),
      });
      const j = await r.json() as { ok: boolean; transactionBase64?: string; mint?: string; error?: string };
      if (!j.ok || !j.transactionBase64 || !j.mint) {
        setFlow({ kind: 'error', message: humanizeBackendError(j.error) });
        return;
      }
      const { transactionBase64, mint } = j;

      // Phantom won't preview balance changes for an unverified dApp —
      // simulate server-side first (same as Candy Mint) and show the real
      // cost before asking for a signature.
      setFlow({ kind: 'simulating' });
      const simR = await fetch(`${API_BASE}/api/tools/direct-mint/simulate-tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ transactionBase64, wallet }),
      });
      const simJ = await simR.json() as { ok: boolean; solDeltaLamports?: number | null; error?: string };
      if (!simJ.ok) {
        setFlow({ kind: 'error', message: humanizeBackendError(simJ.error) });
        return;
      }
      setFlow({ kind: 'ready_to_sign', transactionBase64, solDeltaLamports: simJ.solDeltaLamports ?? null, mint });
    } catch (err) {
      setFlow({ kind: 'error', message: humanizeThrownError((err as Error).message) });
    }
  }

  async function handleConfirmSign() {
    if (flow.kind !== 'ready_to_sign') return;
    const { transactionBase64, mint } = flow;
    setFlow({ kind: 'signing' });
    try {
      const result = await signSendAndConfirm(transactionBase64);
      setFlow({ kind: 'success', sig: result.signature, mint });
    } catch (err) {
      setFlow({ kind: 'error', message: humanizeThrownError((err as Error).message) });
    }
  }

  return (
    <div style={{ maxWidth: 980, margin: '0 auto', padding: '32px 20px 60px', ...MONO }}>
      {/* ── utility strip: wallet + (once loaded) a compact re-loader ──── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, marginBottom: loaded ? 28 : 16 }}>
        {wallet ? (
          <WalletChip wallet={wallet} onDisconnect={handleDisconnect} />
        ) : (
          <CtaButton onClick={handleConnect}>Connect Phantom</CtaButton>
        )}
        <div style={{ flex: 1 }} />
        {loaded && (
          <>
            <ToolTextInput
              value={sig}
              onChange={(e) => setSig(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleLoad(); }}
              placeholder="load a different reference tx signature"
              style={{ width: 340, maxWidth: '100%' }}
            />
            <CtaButton onClick={handleLoad} disabled={busy || !sig.trim()}>
              {flow.kind === 'loading' ? 'loading…' : 'Load'}
            </CtaButton>
          </>
        )}
      </div>

      {/* ── start screen — centered loader, shown until metadata is loaded ── */}
      {!loaded && (
        <>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginBottom: 14 }}>
            <Pill label="From Signature" active={startMode === 'signature'} color={hex(VL.purpleTint)} onClick={() => setStartMode('signature')} />
            <Pill label="Duplicate Existing" active={startMode === 'duplicate'} color={hex(VL.purpleTint)} onClick={() => setStartMode('duplicate')} />
          </div>

          {startMode === 'signature' && (
            <div
              style={{
                maxWidth: 520, margin: '0 auto', padding: '40px 36px', borderRadius: 20, textAlign: 'center',
                background: `radial-gradient(140% 160% at 50% 0%, ${alpha(VL.purpleDeep, 0.16)} 0%, transparent 60%), linear-gradient(180deg, ${alpha(VL.purpleDeep, 0.08)} 0%, rgba(0,0,0,0.5) 100%)`,
                border: `1px solid ${alpha(VL.purpleTint, ALPHA_BORDER)}`,
                boxShadow: `inset 0 1px 0 rgba(255,255,255,0.05), 0 24px 60px rgba(0,0,0,0.55), 0 0 40px ${alpha(VL.purpleDeep, 0.1)}`,
              }}
            >
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', color: rgb(VL.purpleTint), marginBottom: 10 }}>
                VictoryLabs · CreateV2
              </div>
              <h1 style={{ fontSize: 24, fontWeight: 800, color: VLText.primary, margin: '0 0 10px' }}>Direct Mint</h1>
              <p style={{ fontSize: 12.5, color: VLText.muted, lineHeight: 1.6, margin: '0 0 22px' }}>
                Bare Token Metadata create, no Candy Machine needed. Paste a reference mint tx signature to load it.
              </p>
              <div style={{ display: 'flex', gap: 8 }}>
                <ToolTextInput
                  value={sig}
                  onChange={(e) => setSig(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleLoad(); }}
                  placeholder="reference mint transaction signature"
                  big
                  style={{ flex: 1 }}
                />
                <CtaButton onClick={handleLoad} disabled={busy || !sig.trim()} big>
                  {flow.kind === 'loading' ? 'loading…' : 'Load'}
                </CtaButton>
              </div>
              {flow.kind === 'error' && (
                <div style={{ fontSize: 12, color: rgb(VL.redStrong), marginTop: 16 }}>{flow.message}</div>
              )}
            </div>
          )}

          {startMode === 'duplicate' && (
            <div
              style={{
                maxWidth: 620, margin: '0 auto', padding: '32px 36px', borderRadius: 20,
                background: `radial-gradient(140% 160% at 50% 0%, ${alpha(VL.purpleDeep, 0.16)} 0%, transparent 60%), linear-gradient(180deg, ${alpha(VL.purpleDeep, 0.08)} 0%, rgba(0,0,0,0.5) 100%)`,
                border: `1px solid ${alpha(VL.purpleTint, ALPHA_BORDER)}`,
                boxShadow: `inset 0 1px 0 rgba(255,255,255,0.05), 0 24px 60px rgba(0,0,0,0.55), 0 0 40px ${alpha(VL.purpleDeep, 0.1)}`,
              }}
            >
              <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '1px', textTransform: 'uppercase', color: rgb(VL.purpleTint), marginBottom: 10, textAlign: 'center' }}>
                VictoryLabs · CreateV2
              </div>
              <h1 style={{ fontSize: 24, fontWeight: 800, color: VLText.primary, margin: '0 0 10px', textAlign: 'center' }}>Duplicate Existing NFT</h1>
              <p style={{ fontSize: 12.5, color: VLText.muted, lineHeight: 1.6, margin: '0 0 20px', textAlign: 'center' }}>
                MPL Core only. Paste one example metadata URI from an already-minted NFT in the collection (its
                trailing number gets swapped for whichever you mint) — every field, including royalty, is read
                straight off that JSON.
              </p>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
                <ToolTextInput
                  value={dupCollection}
                  onChange={(e) => setDupCollection(e.target.value)}
                  placeholder="collection mint (you must be its update authority)"
                  style={{ width: '100%' }}
                  disabled={dupBatchBusy}
                />
                <ToolTextInput
                  value={dupExampleUri}
                  onChange={(e) => setDupExampleUri(e.target.value)}
                  placeholder="example metadata URI, e.g. https://…/1447.json"
                  style={{ width: '100%' }}
                  disabled={dupBatchBusy}
                />
              </div>

              <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase', color: VLText.faint, marginBottom: 6 }}>
                Single
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
                <ToolTextInput
                  value={dupNumber}
                  onChange={(e) => setDupNumber(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void handleLoadDuplicate(); }}
                  placeholder="NFT number"
                  style={{ width: 140 }}
                  disabled={dupBatchBusy}
                />
                <CtaButton
                  onClick={handleLoadDuplicate}
                  disabled={busy || dupBatchBusy || !dupCollection.trim() || !dupExampleUri.trim() || !dupNumber.trim()}
                >
                  {flow.kind === 'loading' ? 'loading…' : 'Load & Preview'}
                </CtaButton>
              </div>

              <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase', color: VLText.faint, marginBottom: 6 }}>
                Batch — always #1 through the count below
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <ToolTextInput
                  value={dupCount}
                  onChange={(e) => setDupCount(e.target.value)}
                  placeholder="how many"
                  style={{ width: 140 }}
                  disabled={dupBatchBusy}
                />
                <CtaButton
                  onClick={handleDuplicateBatch}
                  disabled={!wallet || dupBatchBusy || !dupCollection.trim() || !dupExampleUri.trim() || !dupCount.trim()}
                >
                  {dupBatchBusy ? 'minting…' : !wallet ? 'connect wallet to mint' : `Mint Batch (1–${dupCount || '?'})`}
                </CtaButton>
              </div>

              {flow.kind === 'error' && (
                <div style={{ fontSize: 12, color: rgb(VL.redStrong), marginTop: 16 }}>{flow.message}</div>
              )}

              {dupBatch.kind === 'running' && (
                <DupBatchProgress batch={dupBatch} />
              )}
            </div>
          )}
        </>
      )}

      {/* ── hero — stays mounted through the whole mint flow ────────────── */}
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
                imageUrl={loaded.image}
                color={rgb(VL.purpleTint)}
                abbr={loaded.name.slice(0, 2).toUpperCase()}
                size={340}
              />
            </div>

            <div style={{ flex: '1 1 340px', minWidth: 280, display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <LiveDot color={rgb(VL.greenStrong)} />
                <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.8px', textTransform: 'uppercase', color: rgb(VL.greenStrong) }}>
                  Self mint · you sign as creator &amp; minter
                </span>
              </div>

              <h1 style={{ fontSize: 30, fontWeight: 800, color: VLText.primary, margin: 0, lineHeight: 1.15 }}>
                {loaded.name}
              </h1>

              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {loaded.symbol && <Pill label={loaded.symbol} color={rgb(VL.purpleTint)} />}
                <Pill label={`${(loaded.royaltyBp / 100).toFixed(2)}% royalty`} color={rgb(VL.purpleTint)} />
                {wallet && <Pill label={`by ${short(wallet)}`} color={rgb(VL.purpleTint)} />}
              </div>

              {loaded.description && (
                <p style={{ fontSize: 12.5, color: VLText.muted, lineHeight: 1.6, margin: 0, maxWidth: 480 }}>
                  {loaded.description}
                </p>
              )}

              {/* ── the two fields no metadata JSON carries ─────────────── */}
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                <Pill label="MPL Core" active={standard === 'core'} color={hex(VL.purpleTint)} onClick={() => setStandard('core')} />
                <Pill label="pNFT" active={standard === 'pnft'} color={hex(VL.purpleTint)} onClick={() => setStandard('pnft')} />
                <Pill label="Legacy NFT" active={standard === 'nft'} color={hex(VL.purpleTint)} onClick={() => setStandard('nft')} />
              </div>
              <ToolTextInput
                value={collection}
                onChange={(e) => setCollection(e.target.value)}
                placeholder="collection mint (optional — you must be its update authority)"
                style={{ width: '100%' }}
              />

              {standard === 'core' && collection.trim() && wallet && (
                <CoreDelegatePanel wallet={wallet} collection={collection.trim()} />
              )}

              {/* ── mint control — the ONE spot that morphs through the flow ── */}
              <div style={{ marginTop: 8 }}>
                {flow.kind === 'ready_to_sign' ? (
                  <ReadyToSignControl flow={flow} busy={busy} onConfirm={handleConfirmSign} onCancel={() => setFlow({ kind: 'idle' })} />
                ) : (
                  <CtaButton onClick={handleMint} disabled={!wallet || busy} big>
                    {flow.kind === 'building' ? 'building…' : flow.kind === 'simulating' ? 'simulating…' : !wallet ? 'connect wallet to mint' : 'Mint'}
                  </CtaButton>
                )}
              </div>

              {flow.kind === 'error' && <StatusNotice tone="warning">{flow.message}</StatusNotice>}
              {flow.kind === 'success' && (
                <StatusNotice>
                  Minted {short(flow.mint)} — sig{' '}
                  <a href={`https://solscan.io/tx/${flow.sig}`} target="_blank" rel="noreferrer" style={{ color: rgb(VL.purpleTint) }}>
                    {short(flow.sig)}
                  </a>
                </StatusNotice>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ReadyToSignControl({ flow, busy, onConfirm, onCancel }: {
  flow: { kind: 'ready_to_sign'; solDeltaLamports: number | null; mint: string };
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div>
      <div style={{ fontSize: 12, color: VLText.muted, marginBottom: 8 }}>
        Mint: {short(flow.mint)}
        {flow.solDeltaLamports != null && <> · cost ~{(Math.abs(flow.solDeltaLamports) / 1e9).toFixed(4)} SOL</>}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <CtaButton onClick={onConfirm} disabled={busy} big>{busy ? 'signing…' : 'Sign & Send'}</CtaButton>
        <CtaButton onClick={onCancel} disabled={busy}>Cancel</CtaButton>
      </div>
    </div>
  );
}

interface CollectionDelegateInfo {
  updateAuthority: string;
  additionalDelegates: string[];
  managingAuthority: string;
}

type DelegateFlowState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'building' }
  | { kind: 'simulating' }
  | { kind: 'ready_to_sign'; transactionBase64: string; solDeltaLamports: number | null }
  | { kind: 'signing' }
  | { kind: 'success'; sig: string }
  | { kind: 'error'; message: string };

// One-time on-chain step for granting a second wallet mint rights into a
// Core collection (../../../../../../root/nft-live-feed/src/direct-mint/
// delegate.ts's header comment): the collection's own updateAuthority (or,
// if a launchpad pinned it, whichever address actually manages the
// UpdateDelegate plugin — `managingAuthority` below, not always the same
// thing) adds a delegate wallet once, and that wallet can then mint via
// this page's normal Core path without ever touching this panel again.
function CoreDelegatePanel({ wallet, collection }: { wallet: string; collection: string }) {
  const [info, setInfo] = useState<CollectionDelegateInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [delegateInput, setDelegateInput] = useState('');
  const [flow, setFlow] = useState<DelegateFlowState>({ kind: 'idle' });

  useEffect(() => {
    setInfo(null);
    setInfoError(null);
    setFlow({ kind: 'idle' });
    let cancelled = false;
    void (async () => {
      try {
        const r = await fetch(`${API_BASE}/api/tools/direct-mint/core-collection?collection=${encodeURIComponent(collection)}`, {
          headers: { ...authHeaders() },
        });
        const j = await r.json() as { ok: boolean; info?: CollectionDelegateInfo; error?: string };
        if (cancelled) return;
        if (!j.ok || !j.info) setInfoError(humanizeBackendError(j.error));
        else setInfo(j.info);
      } catch (err) {
        if (!cancelled) setInfoError(humanizeThrownError((err as Error).message));
      }
    })();
    return () => { cancelled = true; };
  }, [collection]);

  const busy = flow.kind === 'building' || flow.kind === 'simulating' || flow.kind === 'signing';
  const canManage = info?.managingAuthority === wallet;

  async function handleAdd() {
    const delegate = delegateInput.trim();
    if (!delegate) return;
    setFlow({ kind: 'building' });
    try {
      const r = await fetch(`${API_BASE}/api/tools/direct-mint/core-delegate/build-tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ wallet, collection, delegate }),
      });
      const j = await r.json() as { ok: boolean; transactionBase64?: string; error?: string };
      if (!j.ok || !j.transactionBase64) {
        setFlow({ kind: 'error', message: humanizeBackendError(j.error) });
        return;
      }
      const { transactionBase64 } = j;

      setFlow({ kind: 'simulating' });
      const simR = await fetch(`${API_BASE}/api/tools/direct-mint/simulate-tx`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ transactionBase64, wallet }),
      });
      const simJ = await simR.json() as { ok: boolean; solDeltaLamports?: number | null; error?: string };
      if (!simJ.ok) {
        setFlow({ kind: 'error', message: humanizeBackendError(simJ.error) });
        return;
      }
      setFlow({ kind: 'ready_to_sign', transactionBase64, solDeltaLamports: simJ.solDeltaLamports ?? null });
    } catch (err) {
      setFlow({ kind: 'error', message: humanizeThrownError((err as Error).message) });
    }
  }

  async function handleConfirmSign() {
    if (flow.kind !== 'ready_to_sign') return;
    const { transactionBase64 } = flow;
    setFlow({ kind: 'signing' });
    try {
      const result = await signSendAndConfirm(transactionBase64);
      setFlow({ kind: 'success', sig: result.signature });
      setDelegateInput('');
      setInfo((prev) => (prev ? { ...prev, additionalDelegates: [...prev.additionalDelegates, delegateInput.trim()] } : prev));
    } catch (err) {
      setFlow({ kind: 'error', message: humanizeThrownError((err as Error).message) });
    }
  }

  return (
    <div style={{
      padding: '10px 12px', borderRadius: 10, marginTop: 2,
      background: alpha(VL.purpleTint, 0.05), border: `1px solid ${alpha(VL.purpleTint, 0.18)}`,
    }}>
      <div style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '0.6px', textTransform: 'uppercase', color: VLText.faint, marginBottom: 6 }}>
        Core mint delegates
      </div>

      {infoError && <StatusNotice tone="warning">{infoError}</StatusNotice>}

      {info && (
        <>
          <div style={{ fontSize: 11.5, color: VLText.muted, marginBottom: 6 }}>
            Managed by <span style={{ color: canManage ? rgb(VL.greenStrong) : rgb(VL.redStrong) }}>{short(info.managingAuthority)}</span>
            {canManage ? ' (you)' : " — not your wallet, can't grant delegates here"}
            {info.managingAuthority !== info.updateAuthority && ' · locked by the collection’s own UpdateDelegate plugin, not its update authority'}
          </div>

          {info.additionalDelegates.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
              {info.additionalDelegates.map((d) => (
                <Pill key={d} label={short(d)} color={rgb(VL.greenStrong)} />
              ))}
            </div>
          )}

          {canManage && (
            <div style={{ display: 'flex', gap: 8 }}>
              <ToolTextInput
                value={delegateInput}
                onChange={(e) => setDelegateInput(e.target.value)}
                placeholder="wallet address to grant mint rights"
                style={{ flex: 1 }}
                disabled={busy}
              />
              {flow.kind === 'ready_to_sign' ? (
                <>
                  <CtaButton onClick={handleConfirmSign} disabled={busy}>{busy ? 'signing…' : 'Sign & Send'}</CtaButton>
                  <CtaButton onClick={() => setFlow({ kind: 'idle' })} disabled={busy}>Cancel</CtaButton>
                </>
              ) : (
                <CtaButton onClick={handleAdd} disabled={busy || !delegateInput.trim()}>
                  {flow.kind === 'building' ? 'building…' : flow.kind === 'simulating' ? 'simulating…' : 'Add Delegate'}
                </CtaButton>
              )}
            </div>
          )}

          {flow.kind === 'ready_to_sign' && flow.solDeltaLamports != null && (
            <div style={{ fontSize: 11, color: VLText.muted, marginTop: 6 }}>cost ~{(Math.abs(flow.solDeltaLamports) / 1e9).toFixed(5)} SOL</div>
          )}
          {flow.kind === 'error' && <StatusNotice tone="warning">{flow.message}</StatusNotice>}
          {flow.kind === 'success' && (
            <StatusNotice>
              Delegate added — sig{' '}
              <a href={`https://solscan.io/tx/${flow.sig}`} target="_blank" rel="noreferrer" style={{ color: rgb(VL.purpleTint) }}>
                {short(flow.sig)}
              </a>
            </StatusNotice>
          )}
        </>
      )}
    </div>
  );
}

function StatusNotice({ tone = 'neutral', children }: { tone?: 'neutral' | 'warning'; children: React.ReactNode }) {
  const accent = tone === 'warning' ? VL.redStrong : VL.purpleTint;
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 7,
      fontSize: 11.5, fontWeight: 600, color: tone === 'warning' ? rgb(VL.redStrong) : VLText.primary,
      lineHeight: 1.5, padding: '9px 11px', borderRadius: 8, marginTop: 4,
      background: alpha(accent, 0.08), border: `1px solid ${alpha(accent, ALPHA_BORDER)}`,
    }}>
      <span style={{ color: rgb(accent), flexShrink: 0, marginTop: 1 }}>{tone === 'warning' ? '⚠' : '●'}</span>
      <span>{children}</span>
    </div>
  );
}

const DUP_STATUS_LABEL: Record<DupBatchItemStatus, string> = {
  pending: 'queued', resolving: 'resolving…', building: 'building…', simulating: 'simulating…',
  ready: 'ready', signing: 'signing…', success: 'minted', error: 'error',
};

const DUP_STATUS_COLOR: Record<DupBatchItemStatus, keyof typeof VL> = {
  pending: 'purpleTint', resolving: 'purpleTint', building: 'purpleTint', simulating: 'purpleTint',
  ready: 'purpleTint', signing: 'purpleTint', success: 'greenStrong', error: 'redStrong',
};

function DupBatchProgress({ batch }: { batch: { kind: 'running'; total: number; items: DupBatchItem[]; done?: boolean } }) {
  const successCount = batch.items.filter((it) => it.status === 'success').length;
  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ fontSize: 11.5, color: VLText.muted, marginBottom: 8 }}>
        {batch.done ? `Done — ${successCount}/${batch.total} minted` : `Minting… ${successCount}/${batch.total}`}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 260, overflowY: 'auto' }}>
        {batch.items.map((it) => (
          <div
            key={it.n}
            style={{
              display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5,
              padding: '5px 9px', borderRadius: 6, background: 'rgba(255,255,255,0.02)',
            }}
          >
            <span style={{ color: VLText.faint, width: 44, flexShrink: 0 }}>#{it.n}</span>
            <span style={{ color: VLText.primary, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {it.name ?? '—'}
            </span>
            {it.sig ? (
              <a href={`https://solscan.io/tx/${it.sig}`} target="_blank" rel="noreferrer" style={{ color: rgb(VL.greenStrong) }}>
                {DUP_STATUS_LABEL[it.status]}
              </a>
            ) : (
              <span style={{ color: rgb(VL[DUP_STATUS_COLOR[it.status]]) }}>
                {it.status === 'error' && it.message ? it.message : DUP_STATUS_LABEL[it.status]}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

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
