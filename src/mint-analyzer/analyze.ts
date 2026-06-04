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
  programName,
  instructionName,
} from './programs';
import type {
  RawRpcTx,
  MintAnalysis,
  MintPrimitive,
  ProgramCall,
  DecodedInstruction,
  ClassifiedSigner,
  Verdict,
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

interface FlatIx { path: string; programId: string; data: Buffer; }

function flattenInstructions(tx: RawRpcTx, keys: string[]): FlatIx[] {
  const out: FlatIx[] = [];
  const outer = tx.transaction.message.instructions ?? [];
  outer.forEach((ix, i) => {
    out.push({ path: `outer[${i}]`, programId: keys[ix.programIdIndex] ?? '?', data: decodeData(ix.data) });
  });
  for (const grp of tx.meta?.innerInstructions ?? []) {
    (grp.instructions ?? []).forEach((ix, j) => {
      out.push({ path: `inner[${grp.index}][${j}]`, programId: keys[ix.programIdIndex] ?? '?', data: decodeData(ix.data) });
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

  // ── Signers + classification ───────────────────────────────────────────
  const nsig = tx.transaction.message.header?.numRequiredSignatures ?? 0;
  const signers: ClassifiedSigner[] = keys.slice(0, nsig).map((address, i) => {
    const platform = KNOWN_PLATFORM_SIGNERS[address];
    if (platform) return { address, class: 'known_platform_signer' as const, label: platform };
    if (i === 0) return { address, class: 'fee_payer' as const };
    return { address, class: 'user' as const };
  });
  const backendSignerObserved = signers.some(s => s.class === 'known_platform_signer');

  // ── Wrapper detection ──────────────────────────────────────────────────
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
    const sig = signers.find(s => s.class === 'known_platform_signer');
    verdictReasons.push(`A known platform co-signer is required (${sig?.label ?? sig?.address}); the mint needs a server-issued signature that cannot be reproduced client-side.`);
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
  };
}
