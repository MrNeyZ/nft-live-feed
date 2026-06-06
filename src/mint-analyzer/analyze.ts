/**
 * Mint Analyzer — pure decode + classification.
 *
 * `analyze(rawTx, signature)` takes a raw `getTransaction` (encoding:'json')
 * response and returns a structured verdict. No network, no DB, no clock —
 * fully deterministic so the fixture tests are the entire test surface.
 */
import bs58 from 'bs58';
import {
  PROGRAM_REGISTRY,
  PRIMITIVE_PROGRAM_IDS,
  KNOWN_LAUNCHPAD_IDS,
  KNOWN_PLATFORM_SIGNERS,
  KNOWN_PLATFORM_ACCOUNTS,
  COMPUTE_BUDGET_PROGRAM,
  CANDY_GUARD_PROGRAM,
  CANDY_MACHINE_V3_PROGRAM,
  CORE_CANDY_GUARD_PROGRAM,
  CORE_CANDY_MACHINE_PROGRAM,
  MPL_CORE_PROGRAM,
  TOKEN_METADATA_PROGRAM,
  BUBBLEGUM_PROGRAM,
  SPL_TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  LAUNCHMYNFT_PROGRAM,
  ACCOUNT_COMPRESSION_PROGRAM,
  COMPRESSION_VERIFY_LEAF_DISC,
  gateAssetName,
  programName,
  instructionName,
} from './programs';
import type {
  RawRpcTx,
  MintAnalysis,
  MintPrimitive,
  AccessType,
  ProgramCall,
  DecodedInstruction,
  ClassifiedSigner,
  Verdict,
  FlowClues,
  FlowGate,
  BurnedAsset,
  TransferredAsset,
} from './types';

/** Flatten static account keys + ALT loaded addresses into the combined
 *  index order Solana uses: [...static, ...writable, ...readonly]. */
function buildKeyList(tx: RawRpcTx): string[] {
  const keys: string[] = [];
  for (const k of tx.transaction.message.accountKeys ?? []) {
    keys.push(typeof k === 'string' ? k : k.pubkey);
  }
  const loaded = tx.meta?.loadedAddresses;
  if (loaded) {
    for (const pk of loaded.writable ?? []) keys.push(pk);
    for (const pk of loaded.readonly ?? []) keys.push(pk);
  }
  return keys;
}

function decodeData(data: string): Buffer {
  try { return Buffer.from(bs58.decode(data ?? '')); } catch { return Buffer.alloc(0); }
}

interface FlatIx {
  path: string;
  programId: string;
  data: Buffer;
  /** resolved account addresses, in the instruction's account order */
  accounts: string[];
  /** approximate execution order: outerIndex*1000 + (inner ? innerJ+1 : 0).
   *  Lets Flow Clues compare "burn before mint" and order the mint flow. */
  order: number;
}

function flattenInstructions(tx: RawRpcTx, keys: string[]): FlatIx[] {
  const out: FlatIx[] = [];
  const outer = tx.transaction.message.instructions ?? [];
  outer.forEach((ix, i) => {
    out.push({
      path: `outer[${i}]`,
      programId: keys[ix.programIdIndex] ?? '?',
      data: decodeData(ix.data),
      accounts: (ix.accounts ?? []).map(a => keys[a] ?? '?'),
      order: i * 1000,
    });
  });
  for (const grp of tx.meta?.innerInstructions ?? []) {
    (grp.instructions ?? []).forEach((ix, j) => {
      out.push({
        path: `inner[${grp.index}][${j}]`,
        programId: keys[ix.programIdIndex] ?? '?',
        data: decodeData(ix.data),
        accounts: (ix.accounts ?? []).map(a => keys[a] ?? '?'),
        order: grp.index * 1000 + j + 1,
      });
    });
  }
  return out;
}

/** First top-level instruction that isn't a ComputeBudget setup — the
 *  program a user actually invoked ("entry"). */
function entryProgram(tx: RawRpcTx, keys: string[]): string | null {
  for (const ix of tx.transaction.message.instructions ?? []) {
    const prog = keys[ix.programIdIndex];
    if (prog && prog !== COMPUTE_BUDGET_PROGRAM) return prog;
  }
  return null;
}

function inferMintPrimitive(present: Set<string>, flat: FlatIx[]): MintPrimitive {
  if (present.has(CANDY_GUARD_PROGRAM) || present.has(CANDY_MACHINE_V3_PROGRAM)) {
    return 'candy_machine_v3_mintv2';
  }
  // Core candy machine still creates the asset via an MPL Core Create/CreateV2.
  const coreCreate = flat.some(
    f => f.programId === MPL_CORE_PROGRAM && (f.data[0] === 0 || f.data[0] === 20),
  );
  if (coreCreate || present.has(CORE_CANDY_MACHINE_PROGRAM) || present.has(CORE_CANDY_GUARD_PROGRAM)) {
    return 'mpl_core_create_v2';
  }
  if (present.has(MPL_CORE_PROGRAM)) return 'mpl_core_create_v2';
  if (present.has(BUBBLEGUM_PROGRAM)) return 'bubblegum_mint';
  if (present.has(TOKEN_METADATA_PROGRAM)) return 'token_metadata_mint';
  return 'unknown';
}

/** First-4…last-4 short form for an address used in evidence/flow strings. */
function shortAddr(a: string): string {
  return a && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a;
}

/** Little-endian u64 at `off`, as a decimal string; undefined if out of range. */
function readU64(buf: Buffer, off: number): string | undefined {
  if (buf.length < off + 8) return undefined;
  return buf.readBigUInt64LE(off).toString();
}

const CANDY_PROGRAMS = new Set([
  CANDY_GUARD_PROGRAM, CANDY_MACHINE_V3_PROGRAM,
  CORE_CANDY_GUARD_PROGRAM, CORE_CANDY_MACHINE_PROGRAM,
]);
const CANDY_MACHINE_PROGRAMS = new Set([CANDY_MACHINE_V3_PROGRAM, CORE_CANDY_MACHINE_PROGRAM]);
const SPL_TOKEN_PROGRAMS = new Set([SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM]);

/** Build the additive, read-only "Mint Requirements / Flow Clues" section.
 *  Pure heuristics over the already-flattened instruction list + logs; never
 *  reads or writes the verdict. Detection summary:
 *    - SPL Token / Token-2022 Burn (tag 8 / BurnChecked 15) and Transfer
 *      (tag 3 / TransferChecked 12), decoded from instruction data.
 *    - MPL Core BurnV1 (leading byte 12, confirmed on-chain).
 *    - Candy Machine v3 (legacy or Core) involvement.
 *    - MPL Core Create / CreateV2 (bytes 0 / 20) and Token Metadata create.
 *  A burn/transfer whose execution `order` precedes the first mint/create is
 *  classified as a likely *gate* (higher confidence). Amount === '1' reads as
 *  an NFT/pass; larger amounts as a fungible (SPL) token. */
interface FlowCtx {
  /** true for a mint gated by a backend co-signature (Candy Guard or direct) */
  serverSignatureGate: boolean;
  /** true when a Core Candy Guard is present — varies the gate wording */
  candyGuardPresent: boolean;
  /** every backend co-signer (known platform + structural AddressGate) */
  backendSigners: string[];
  /** signer index 0 — the minter/user authorising the soft-gate transfer */
  feePayer: string | null;
}

function buildFlowClues(flat: FlatIx[], present: Set<string>, ctx: FlowCtx): FlowClues {
  const detectedGates: FlowGate[] = [];
  const burnedAssets: BurnedAsset[] = [];
  const transferredAssets: TransferredAsset[] = [];
  const notes: string[] = [];
  const flowEvents: Array<{ order: number; label: string }> = [];

  // Anchor points: the create / candy-machine-mint orders this tx builds toward.
  const coreCreateOrders = flat
    .filter(f => f.programId === MPL_CORE_PROGRAM && (f.data[0] === 0 || f.data[0] === 20))
    .map(f => f.order);
  const candyMintOrders = flat.filter(f => CANDY_MACHINE_PROGRAMS.has(f.programId)).map(f => f.order);
  const tmCreateOrders = flat.filter(f => f.programId === TOKEN_METADATA_PROGRAM).map(f => f.order);
  const mintAnchors = [...coreCreateOrders, ...candyMintOrders, ...tmCreateOrders];
  const firstMintOrder = mintAnchors.length ? Math.min(...mintAnchors) : Infinity;

  // Any on-chain burn (SPL/Token-2022 Burn or MPL Core BurnV1). Its ABSENCE is
  // one of the conditions that makes a pre-mint transfer a *soft* (off-chain)
  // gate rather than an on-chain TokenBurn guard.
  const hasBurn = flat.some(f => {
    const t = f.data[0];
    return (SPL_TOKEN_PROGRAMS.has(f.programId) && (t === 8 || t === 15))
      || (f.programId === MPL_CORE_PROGRAM && t === 12);
  });

  // ── Server-signature gate (MintX-style backend co-signer) ──────────────
  if (ctx.serverSignatureGate) {
    const cg = ctx.candyGuardPresent;
    detectedGates.push({
      type: 'server_signature_gate',
      confidence: 'high',
      programId: cg ? CORE_CANDY_GUARD_PROGRAM : undefined,
      signers: ctx.backendSigners,
      owner: ctx.backendSigners[0],
      evidence: [
        cg
          ? 'Mint requires a backend/server co-signature (Candy Guard AddressGate / platform minter).'
          : 'Mint requires an extra backend co-signature that is neither the minter nor the minted asset.',
        ctx.backendSigners.length ? `Backend co-signer(s): ${ctx.backendSigners.join(', ')}` : 'Backend co-signer present.',
        'Issued server-side after an off-chain gate — cannot be reproduced client-side.',
      ],
    });
  }

  // ── Burns / transfers (the gate signals) ───────────────────────────────
  for (const f of flat) {
    const tag = f.data[0];

    // SPL Token / Token-2022 burns + transfers (reliable byte decode).
    if (SPL_TOKEN_PROGRAMS.has(f.programId)) {
      if (tag === 8 || tag === 15) {                       // Burn / BurnChecked
        const mint = f.accounts[1];
        const owner = f.accounts[2];
        const amount = readU64(f.data, 1);
        const before = f.order < firstMintOrder;
        const name = mint ? gateAssetName(mint) ?? undefined : undefined;
        const isNft = amount === '1';
        detectedGates.push({
          type: isNft ? 'nft_burn_gate' : 'spl_token_burn_gate',
          confidence: before ? 'high' : 'medium',
          assetName: name, mint, amount, owner, programId: f.programId,
          evidence: [
            `SPL ${tag === 15 ? 'BurnChecked' : 'Burn'} of ${amount ?? '?'} ${name ?? shortAddr(mint ?? '?')} at ${f.path}`,
            before ? 'burn precedes the mint/create in this tx' : 'burn occurs after the create',
          ],
        });
        burnedAssets.push({ name, mint, amount, owner });
        flowEvents.push({ order: f.order, label: `Burn ${name ?? shortAddr(mint ?? '?')}` });
      } else if ((tag === 3 || tag === 12) && f.order < firstMintOrder) { // Transfer / TransferChecked, pre-mint
        const checked = tag === 12;
        const from = f.accounts[0];
        const mint = checked ? f.accounts[1] : undefined;
        const to = checked ? f.accounts[2] : f.accounts[1];
        const authority = checked ? f.accounts[3] : f.accounts[2];
        const amount = readU64(f.data, 1);
        const name = mint ? gateAssetName(mint) ?? undefined : undefined;
        const isNft = amount === '1';
        // Off-chain (MintX-style) soft gate: a top-level, user-authorised token
        // transfer in a server-signature-gated mint, with NO on-chain burn. The
        // Candy Guard does not enforce it (it isn't a TokenPayment/TokenGate/
        // TokenBurn CPI) — the backend co-signer gates access off-chain.
        const softGate = ctx.serverSignatureGate && !hasBurn && f.path.startsWith('outer')
          && (ctx.feePayer == null || authority === ctx.feePayer);
        if (softGate) {
          detectedGates.push({
            type: 'off_chain_token_transfer_gate',
            confidence: 'high',
            assetName: name, mint, amount, owner: authority, programId: f.programId,
            enforcedOnChain: false,
            evidence: [
              `SPL ${checked ? 'TransferChecked' : 'Transfer'} of ${amount ?? '?'} ${name ?? shortAddr(mint ?? to ?? '?')} from the minter to ${shortAddr(to ?? '?')} at ${f.path}`,
              'transfer precedes the mint/create in this tx',
              'NOT enforced on-chain by Candy Guard (no TokenPayment/TokenGate/TokenBurn guard); the backend signer enforces access off-chain',
            ],
          });
          detectedGates.push({
            type: 'soft_transfer_not_burn',
            confidence: 'high',
            mint, amount, owner: authority, programId: f.programId, enforcedOnChain: false,
            evidence: ['SPL Transfer (not Burn): the gate token is moved to a treasury/vault and retained, not destroyed'],
          });
        } else {
          detectedGates.push({
            type: isNft ? 'nft_transfer_gate' : 'spl_token_transfer_gate',
            confidence: 'medium',
            assetName: name, mint, amount, owner: from, programId: f.programId,
            evidence: [`SPL ${checked ? 'TransferChecked' : 'Transfer'} of ${amount ?? '?'} ${name ?? shortAddr(mint ?? to ?? '?')} at ${f.path}`,
              'transfer precedes the mint/create in this tx'],
          });
        }
        transferredAssets.push({ name, mint, amount, from, to });
        flowEvents.push({ order: f.order, label: `Transfer ${name ?? shortAddr(mint ?? to ?? '?')}` });
      }
    }

    // MPL Core BurnV1 — leading byte 12 (confirmed on-chain). Asset = accounts[0].
    if (f.programId === MPL_CORE_PROGRAM && tag === 12) {
      const asset = f.accounts[0];
      const before = f.order < firstMintOrder;
      const name = asset ? gateAssetName(asset) ?? undefined : undefined;
      detectedGates.push({
        type: 'nft_burn_gate',
        confidence: before ? 'high' : 'medium',
        assetName: name, mint: asset, programId: f.programId,
        evidence: [`MPL Core BurnV1 of ${name ?? shortAddr(asset ?? '?')} at ${f.path}`,
          before ? 'burn precedes the mint/create in this tx' : 'burn occurs after the create'],
      });
      burnedAssets.push({ name, mint: asset });
      flowEvents.push({ order: f.order, label: `Burn ${name ?? shortAddr(asset ?? '?')}` });
    }
  }

  // ── Candy Machine v3 involvement (legacy or Core) ──────────────────────
  if ([...CANDY_PROGRAMS].some(p => present.has(p))) {
    detectedGates.push({
      type: 'candy_machine_v3',
      confidence: 'high',
      evidence: ['Candy Machine v3 / Candy Guard program invoked in this transaction'],
    });
    const cmOrder = candyMintOrders.length ? Math.min(...candyMintOrders) : firstMintOrder;
    flowEvents.push({ order: Number.isFinite(cmOrder) ? cmOrder : 0, label: 'Candy Machine V3' });
  }

  // ── The mint primitive itself, for the flow tail ───────────────────────
  if (coreCreateOrders.length) {
    detectedGates.push({
      type: 'mpl_core_create',
      confidence: 'high',
      programId: MPL_CORE_PROGRAM,
      evidence: ['MPL Core Create / CreateV2 builds the new asset'],
    });
    flowEvents.push({ order: Math.min(...coreCreateOrders), label: 'MPL Core CreateV2' });
  } else if (tmCreateOrders.length) {
    detectedGates.push({
      type: 'token_metadata_create',
      confidence: 'medium',
      programId: TOKEN_METADATA_PROGRAM,
      evidence: ['Token Metadata program creates the mint/metadata'],
    });
    flowEvents.push({ order: Math.min(...tmCreateOrders), label: 'Token Metadata Create' });
  }

  // ── Notes ──────────────────────────────────────────────────────────────
  const burnGateBeforeMint = detectedGates.some(g =>
    (g.type === 'nft_burn_gate' || g.type === 'spl_token_burn_gate') && g.confidence === 'high');
  const transferGate = detectedGates.some(g =>
    g.type === 'nft_transfer_gate' || g.type === 'spl_token_transfer_gate');
  if (burnGateBeforeMint) notes.push('Mint likely required burning a pass / brand token.');
  if (transferGate) notes.push('Mint likely required transferring a token/NFT (payment or gate) before the mint.');
  if (detectedGates.some(g => g.type === 'server_signature_gate')) {
    notes.push('Server-gated mint: a backend co-signature is required; not reconstructable client-side.');
  }
  if (detectedGates.some(g => g.type === 'off_chain_token_transfer_gate')) {
    notes.push('Off-chain token gate: the pre-mint SPL transfer is NOT enforced by an on-chain guard — it is a soft payment retained by the treasury (a transfer, not a burn).');
  }
  if (detectedGates.length === 0) {
    notes.push('No burn/transfer gates detected; the mint flow looks like a direct primitive call.');
  }

  // ── Ordered, deduped mint flow ─────────────────────────────────────────
  const mintFlow: string[] = [];
  for (const e of [...flowEvents].sort((a, b) => a.order - b.order)) {
    if (mintFlow[mintFlow.length - 1] !== e.label) mintFlow.push(e.label);
  }

  return { detectedGates, burnedAssets, transferredAssets, mintFlow, notes };
}

/** Conservative access-type detection — WHO was allowed to mint, orthogonal to
 *  the reconstructability verdict. Purely additive: reads the already-flattened
 *  instructions + signers and never touches the verdict. Rule order (first
 *  match wins):
 *    1. backend co-signature present                 → backend_gated
 *    2. LaunchMyNFT + invoked Account Compression
 *       `verifyLeaf` CPI (merkle/holder proof)       → nft_holder_gate
 *    3. LaunchMyNFT + treasury/authority self-mint
 *       (fee payer fills ≥3 slots of the wrapper ix,
 *        i.e. it is also the treasury, not an
 *        arms-length minter)                          → treasury_manual_allowlist
 *    4. LaunchMyNFT + no verifyLeaf + short wrapper
 *       payload (minimal mint args)                   → public
 *    5. otherwise                                     → unknown
 *  Payload length is only ever a SECONDARY clue/threshold — stronger structural
 *  signals (verifyLeaf, treasury slots) decide first. Thresholds are generous
 *  ranges, not the exact observed byte counts, to avoid overfitting. */
function detectAccessType(ctx: {
  flat: FlatIx[];
  present: Set<string>;
  feePayer: string | null;
  knownLaunchpad: MintAnalysis['knownLaunchpad'];
  backendSignerObserved: boolean;
}): { accessType: AccessType; accessClues: string[] } {
  const { flat, present, feePayer, knownLaunchpad, backendSignerObserved } = ctx;
  const clues: string[] = [];

  // (1) A backend/server co-signature is the strongest access gate.
  if (backendSignerObserved) {
    clues.push('backend_co_signer');
    return { accessType: 'backend_gated', accessClues: clues };
  }

  const isLmnft = knownLaunchpad?.programId === LAUNCHMYNFT_PROGRAM;
  if (isLmnft) clues.push('launchmynft_wrapper');

  // The wrapper (LaunchMyNFT MintCore) outer instruction + its payload length.
  const wrapperIx = flat.find(f => f.programId === LAUNCHMYNFT_PROGRAM && f.path.startsWith('outer'));
  const payloadLen = wrapperIx ? wrapperIx.data.length : null;

  // Invoked Account Compression verifyLeaf — the merkle/holder proof path. Keyed
  // on an actually-dispatched instruction, NOT mere accountKeys membership (the
  // compression + Bubblegum programs sit in the account list of every LMNFT mint).
  const verifyLeaf = flat.some(f =>
    f.programId === ACCOUNT_COMPRESSION_PROGRAM
    && f.data.subarray(0, 8).toString('hex') === COMPRESSION_VERIFY_LEAF_DISC);
  if (verifyLeaf) clues.push('account_compression_verify_leaf');
  if (present.has(BUBBLEGUM_PROGRAM)) clues.push('bubblegum_present');

  // Treasury / manual-allowlist self-mint: the fee payer is not an arms-length
  // minter paying a distinct treasury — it occupies the treasury/authority
  // slots of the wrapper ix too (≥3 occurrences vs the 2 minter/payer slots a
  // normal mint fills). Layout-independent; no hardcoded treasury key.
  let treasurySigner = false;
  if (wrapperIx && feePayer) {
    const fpSlots = wrapperIx.accounts.filter(a => a === feePayer).length;
    treasurySigner = fpSlots >= 3;
    if (treasurySigner) clues.push('treasury_signer');
  }

  // Secondary payload-length clues (generous ranges, not exact byte counts).
  const LONG_PROOF_BYTES = 160;
  const SHORT_PUBLIC_BYTES = 64;
  if (payloadLen != null && payloadLen >= LONG_PROOF_BYTES) clues.push('long_merkle_proof_payload');
  if (payloadLen != null && payloadLen <= SHORT_PUBLIC_BYTES) clues.push('short_public_payload');

  let accessType: AccessType = 'unknown';
  if (isLmnft && verifyLeaf) accessType = 'nft_holder_gate';
  else if (isLmnft && treasurySigner) accessType = 'treasury_manual_allowlist';
  else if (isLmnft && !verifyLeaf && payloadLen != null && payloadLen <= SHORT_PUBLIC_BYTES) accessType = 'public';

  return { accessType, accessClues: clues };
}

export function analyze(tx: RawRpcTx, signature: string): MintAnalysis {
  const keys = buildKeyList(tx);
  const flat = flattenInstructions(tx, keys);
  const present = new Set(flat.map(f => f.programId));

  // ── Programs called (deduped, with invocation counts) ──────────────────
  const counts = new Map<string, number>();
  for (const f of flat) counts.set(f.programId, (counts.get(f.programId) ?? 0) + 1);
  const programs: ProgramCall[] = [...counts.entries()].map(([programId, invocationCount]) => ({
    programId,
    name: programName(programId),
    invocationCount,
  }));

  // ── Decoded instructions ───────────────────────────────────────────────
  const instructions: DecodedInstruction[] = flat.map(f => ({
    path: f.path,
    programId: f.programId,
    programName: programName(f.programId),
    discriminatorHex: f.data.subarray(0, 8).toString('hex'),
    instructionName: instructionName(f.programId, f.data),
  }));

  // ── Wrapper detection (computed first so backend-signer detection can be
  //    scoped to *direct* mints — see genericBackendSigners below) ──────────
  const entry = entryProgram(tx, keys);
  const primitive = inferMintPrimitive(present, flat);

  let customWrapper: MintAnalysis['customWrapper'] = null;
  let knownLaunchpad: MintAnalysis['knownLaunchpad'] = null;
  if (entry && !PRIMITIVE_PROGRAM_IDS.has(entry)) {
    if (KNOWN_LAUNCHPAD_IDS.has(entry)) {
      knownLaunchpad = { programId: entry, name: programName(entry) };
    } else if (primitive !== 'unknown') {
      // Opaque program fronting a recognised mint primitive via CPI.
      customWrapper = { programId: entry, name: programName(entry) };
    }
  }

  // ── Signers + classification ───────────────────────────────────────────
  const nsig = tx.transaction.message.header?.numRequiredSignatures ?? 0;
  const signerAddrs = keys.slice(0, nsig);
  const feePayer = signerAddrs[0] ?? null;

  // Minted asset(s): an MPL Core Create/CreateV2 asset signs to create itself
  // (asset = accounts[0]). It is a signer but NOT a backend co-signer, so it
  // must be excluded from backend-signer detection below.
  const assetAddrs = new Set(
    flat
      .filter(f => f.programId === MPL_CORE_PROGRAM && (f.data[0] === 0 || f.data[0] === 20) && f.accounts[0])
      .map(f => f.accounts[0]),
  );

  // Structural (key-independent) backend-signer detection, in two tiers:
  //
  //  (a) Candy Guard tier — a required signer referenced by a Core Candy Guard
  //      mint instruction that is neither fee-payer nor minted asset is a Candy
  //      Guard AddressGate / backend minter. Catches MintX drops whose
  //      AddressGate key rotates per collection without hardcoding the key
  //      (confirmed by the MintX audit across 4 candy guards / 76 mints).
  //
  //  (b) Generic tier — for a *direct* MPL Core mint (entry is the MPL Core
  //      primitive itself: no custom wrapper, no known launchpad), ANY required
  //      signer that is neither fee-payer nor minted asset is a backend/server
  //      co-signature the client cannot reproduce (e.g. vvv.so's per-collection
  //      authority key, which is NOT the hardcoded platform signer). Scoped to
  //      direct mints so a custom-wrapper mint's own ephemeral signer (e.g.
  //      foRGE's readonly authority signer in tx3) is NOT misread as a backend
  //      co-signer — those stay MANUAL RE.
  //
  // PDAs referenced by an ix are never tx-level signers, so this only ever
  // yields genuine keypair signers.
  const coreGuardIxAccounts = new Set(
    flat.filter(f => f.programId === CORE_CANDY_GUARD_PROGRAM).flatMap(f => f.accounts),
  );
  const candyGuardBackendSigners = signerAddrs.filter(
    (address, i) => i !== 0 && coreGuardIxAccounts.has(address) && !assetAddrs.has(address),
  );
  const isDirectMint = primitive !== 'unknown' && !customWrapper && !knownLaunchpad;
  const createsCoreAsset = assetAddrs.size > 0;
  const genericBackendSigners = isDirectMint && createsCoreAsset
    ? signerAddrs.filter((address, i) => i !== 0 && !assetAddrs.has(address))
    : [];
  const candyGuardSet = new Set(candyGuardBackendSigners);
  const structuralBackendSigners = [...new Set([...candyGuardBackendSigners, ...genericBackendSigners])];
  const structuralSet = new Set(structuralBackendSigners);

  const signers: ClassifiedSigner[] = signerAddrs.map((address, i) => {
    const platform = KNOWN_PLATFORM_SIGNERS[address];
    if (platform) return { address, class: 'known_platform_signer' as const, label: platform };
    if (structuralSet.has(address)) {
      const label = candyGuardSet.has(address)
        ? 'backend co-signer (Candy Guard AddressGate)'
        : 'backend co-signer (server co-signature)';
      return { address, class: 'unknown_program_signer' as const, label };
    }
    if (i === 0) return { address, class: 'fee_payer' as const };
    return { address, class: 'user' as const };
  });
  const backendSignerObserved =
    signers.some(s => s.class === 'known_platform_signer') || structuralBackendSigners.length > 0;
  // Addresses of every backend co-signer (known platform + structural).
  const backendSigners = signerAddrs.filter(a => KNOWN_PLATFORM_SIGNERS[a] || structuralSet.has(a));
  // Server-gated mint: access is gated by a backend co-signature. True for a
  // Core Candy Guard mint with a backend signer (MintX-style) OR a direct MPL
  // Core mint with a generic backend co-signer (vvv.so-style).
  const serverSignatureGate =
    backendSignerObserved && (present.has(CORE_CANDY_GUARD_PROGRAM) || genericBackendSigners.length > 0);

  // A server-gated Core Candy Guard mint funds accounts via System / SPL
  // housekeeping before the guard ix, so `entryProgram` can mis-pick that
  // infrastructure ix as a "wrapper". When the gate is positively identified
  // AND a Candy Guard is present, the real entry is the Candy Guard (a
  // primitive), so drop the spurious wrapper. Scoped to Candy-Guard-present so
  // a genuine custom wrapper with a backend signer keeps its wrapper info, and
  // fixtures with no backend signer (e.g. tx_burn_gate) keep their verdict.
  if (serverSignatureGate && present.has(CORE_CANDY_GUARD_PROGRAM)) customWrapper = null;

  // ── Guard / auth ───────────────────────────────────────────────────────
  const candyGuard = present.has(CANDY_GUARD_PROGRAM) || present.has(CORE_CANDY_GUARD_PROGRAM);
  const notes: string[] = [];
  if (candyGuard) {
    notes.push(
      'Candy Guard present — mint is gated by a guard group (e.g. sol payment, allowlist, mint limit, start date, bot tax). Guard inputs must be satisfied to reproduce the mint.',
    );
  }
  if (knownLaunchpad) {
    notes.push(`Recognised launchpad wrapper (${knownLaunchpad.name ?? knownLaunchpad.programId}); reconstructing the inner mint needs the launchpad's drop config.`);
  }
  if (customWrapper) {
    notes.push(`Custom wrapper program (${customWrapper.programId}); instruction layout is undocumented — manual reverse-engineering required to reproduce.`);
  }
  if (serverSignatureGate) {
    if (present.has(CORE_CANDY_GUARD_PROGRAM)) {
      const mintx = signers.find(s => /MintX/i.test(s.label ?? ''));
      notes.push(`Server-gated Candy Guard mint${mintx ? ' (MintX)' : ''}: requires a backend co-signature (AddressGate). Any sibling token transfer is an off-chain soft gate, not enforced on-chain.`);
    } else {
      notes.push('Server-gated mint: requires an extra backend co-signature that is neither the minter nor the minted asset; cannot be reproduced client-side.');
    }
  }
  // Surface any known platform treasury seen as a (non-signer) account.
  for (const k of keys) {
    const acct = KNOWN_PLATFORM_ACCOUNTS[k];
    if (acct) notes.push(`Known platform account present: ${acct} (${k}).`);
  }

  // ── Verdict ────────────────────────────────────────────────────────────
  const verdictReasons: string[] = [];
  let verdict: Verdict;
  if (backendSignerObserved) {
    verdict = 'blocked_server_captcha_signature';
    const known = signers.find(s => s.class === 'known_platform_signer');
    if (known) {
      verdictReasons.push(`A known platform co-signer is required (${known.label ?? known.address}); the mint needs a server-issued signature that cannot be reproduced client-side.`);
    }
    if (candyGuardBackendSigners.length) {
      verdictReasons.push(`Mint requires a Candy Guard AddressGate / backend co-signature (${candyGuardBackendSigners.join(', ')}) that cannot be reproduced client-side.`);
    }
    const genericOnly = genericBackendSigners.filter(a => !candyGuardSet.has(a) && !KNOWN_PLATFORM_SIGNERS[a]);
    if (genericOnly.length) {
      verdictReasons.push('Mint requires an extra backend co-signature that is neither the minter nor the minted asset.');
    }
    if (serverSignatureGate && present.has(CORE_CANDY_GUARD_PROGRAM)) {
      verdictReasons.push('Core Candy Guard server-gated mint (MintX-style): the on-chain guard does not enforce the sibling token transfer — the backend co-signer gates access off-chain.');
    }
  } else if (customWrapper) {
    verdict = 'custom_program_manual_re_required';
    verdictReasons.push(`Mint is fronted by a custom program (${customWrapper.programId}) with no known instruction layout; reconstructing it requires manual reverse-engineering.`);
    verdictReasons.push(`Underlying mint primitive observed: ${primitive}.`);
  } else if (knownLaunchpad) {
    verdict = 'possible_requires_extra_inputs';
    verdictReasons.push(`Recognised launchpad (${knownLaunchpad.name ?? knownLaunchpad.programId}); reconstructable given the launchpad's drop config inputs.`);
  } else if (primitive !== 'unknown') {
    verdict = 'direct_mint_likely_reconstructable';
    verdictReasons.push(`Direct standard mint via ${primitive}; no opaque wrapper and no backend co-signer observed.`);
    if (candyGuard) verdictReasons.push('Candy Guard inputs (allowlist proof, payment, start date) still need to be satisfied at mint time.');
  } else {
    verdict = 'custom_program_manual_re_required';
    verdictReasons.push('No recognised mint primitive found in the transaction; manual reverse-engineering required.');
  }
  if (!backendSignerObserved) verdictReasons.push('No backend/platform signer observed.');

  // ── Access type (additive; orthogonal to the verdict above) ─────────────
  const { accessType, accessClues } = detectAccessType({
    flat, present, feePayer, knownLaunchpad, backendSignerObserved,
  });

  return {
    signature,
    status: tx.meta?.err == null ? 'success' : 'failed',
    slot: tx.slot,
    blockTime: tx.blockTime != null ? new Date(tx.blockTime * 1000).toISOString() : null,
    fee: tx.meta?.fee ?? null,
    computeUnitsConsumed: tx.meta?.computeUnitsConsumed ?? null,
    programs,
    instructions,
    likelyMintPrimitive: primitive,
    customWrapper,
    knownLaunchpad,
    signers,
    backendSignerObserved,
    guardAuth: { candyGuard, notes },
    verdict,
    verdictReasons,
    accessType,
    accessClues,
    // Additive read-only clues; computed independently of the verdict above.
    flowClues: buildFlowClues(flat, present, {
      serverSignatureGate,
      candyGuardPresent: present.has(CORE_CANDY_GUARD_PROGRAM),
      backendSigners,
      feePayer,
    }),
  };
}
