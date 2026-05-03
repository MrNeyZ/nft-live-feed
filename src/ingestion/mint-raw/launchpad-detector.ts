/**
 * Launchpad-targeted mint detector.
 *
 * The generic /mints ingestion path classifies every Token Metadata /
 * MPL Core mint on the chain — useful breadth-wise but too noisy for
 * the operator-facing surface, which only cares about a small set of
 * launchpads. This module replaces that classification with a pair of
 * narrow detectors that match exactly two launchpads via signals
 * extracted from real on-chain transactions:
 *
 *   1. LaunchMyNFT — outer program `F9SixdqdmEBP5kprp2gZPZNeMmfHJRCTMFjN22dx3akf`
 *      with `Instruction: MintCore` log and an inner CPI to MPL Core
 *      `Instruction: Create`. Reference tx:
 *      3qjW71UQFuq9X65Fk4bKVmGyPs6XVGc8rtHF1UiqzBJ7AfQ9ZA1RVX1PpKYFGJfG93vwcCcuTR5edV2zXNtDDUeQ
 *
 *   2. vvv.so — direct MPL Core `Instruction: CreateV2` mint, but
 *      always co-signed by a stable platform signer
 *      `AY5tENt66T5DhG7rKjh1kRMjeZTq7trMLJhk4cXAZNrn` alongside the
 *      buyer + the new asset. (vvv.so doesn't have a unique program
 *      of its own — the platform signer is the only on-chain
 *      fingerprint we have.) Reference tx:
 *      4nvMBRxq7L7eY7spzMWggj1QjenbcZ5uUMEKb49Fy8vCMRUvSKc62gWtdxWRz7EEQtKFyrgPC72EfG2FvCjCxv4Q
 *
 * The detectors are deliberately narrow: anything else returns null so
 * targeted-mode ingestion can reject `unknown_launchpad` cleanly.
 */
import type { RawSolanaTx } from '../me-raw/types';

export const LAUNCHMYNFT_PROGRAM = 'F9SixdqdmEBP5kprp2gZPZNeMmfHJRCTMFjN22dx3akf';
export const MPL_CORE_PROGRAM    = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
export const BUBBLEGUM_PROGRAM   = 'BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY';
/** vvv.so platform signer observed on every confirmed vvv.so mint.
 *  Treated as the on-chain fingerprint until a more durable signal
 *  (program, IDL discriminator) is identified. */
export const VVVSO_PLATFORM_SIGNER = 'AY5tENt66T5DhG7rKjh1kRMjeZTq7trMLJhk4cXAZNrn';

export type LaunchpadSource = 'LaunchMyNFT' | 'VVV';
export type LaunchpadStandard = 'core' | 'cnft';

export interface LaunchpadHit {
  source:            LaunchpadSource;
  /** Underlying NFT standard for this hit. Drives `programSource` on
   *  the wire (`mpl_core` vs `bubblegum`) and the standalone-asset
   *  filter at ingest (cNFTs aren't really "standalone" in the same
   *  sense — they live in a Merkle tree which IS the collection-like
   *  grouping). Defaults to 'core' for backward compatibility. */
  standard:          LaunchpadStandard;
  /** The freshly-minted asset / mint pubkey. Null for cNFT mints —
   *  cNFTs don't have an on-chain mint account; the asset ID is a
   *  derivative of (tree, leaf nonce) computed off-chain via DAS. */
  mintAddress:       string | null;
  /** Buyer / payer wallet (signer at index 0). */
  minter:            string | null;
  /** Core path: collection group address from the inner Core CPI.
   *  cNFT path: the Merkle tree address (functions as the group). */
  collectionAddress: string | null;
  /** Optional: matched needle for diagnostics. */
  matchedNeedle?:    string;
}

interface ParsedTxShape {
  accountKeys: string[];
  signerKeys:  string[];
  logs:        string[];
}

function readTxShape(tx: RawSolanaTx): ParsedTxShape | null {
  const message = tx.transaction?.message;
  if (!message) return null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawKeys = (message as any).accountKeys as Array<string | { pubkey: string; signer?: boolean }> | undefined;
  if (!Array.isArray(rawKeys)) return null;
  const accountKeys: string[] = [];
  const signerKeys:  string[] = [];
  for (const k of rawKeys) {
    if (typeof k === 'string') {
      accountKeys.push(k);
    } else if (k && typeof k === 'object') {
      accountKeys.push(k.pubkey);
      if (k.signer) signerKeys.push(k.pubkey);
    }
  }
  const logs = Array.isArray(tx.meta?.logMessages)
    ? (tx.meta!.logMessages as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  return { accountKeys, signerKeys, logs };
}

/** True iff `tx` invoked LMNFT's MintCore handler — the Core path,
 *  unique log string, never collides with unrelated programs. */
function isLaunchMyNftCoreTx(shape: ParsedTxShape): boolean {
  if (!shape.accountKeys.includes(LAUNCHMYNFT_PROGRAM)) return false;
  for (const line of shape.logs) {
    if (line.includes('Instruction: MintCore')) return true;
  }
  return false;
}

/** True iff `tx` is an LMNFT cNFT mint — confirmed dispatcher names
 *  `Instruction: MintV2` and `Instruction: MintCv3` from the launchpad
 *  survey (8 of 93 LMNFT txs sampled). Both invoke Bubblegum as an
 *  inner CPI. Update-style ixs that happen to share a prefix never
 *  invoke Bubblegum, so the dual gate (LMNFT log + Bubblegum CPI)
 *  rejects `SetNameCoreWithOldUrl`, `UpdatePhase`, etc. cleanly. */
const LMNFT_CNFT_NEEDLES: readonly string[] = [
  'Instruction: MintV2',
  'Instruction: MintCv3',
];
function lmnftCnftNeedleIfPresent(shape: ParsedTxShape): string | null {
  if (!shape.accountKeys.includes(LAUNCHMYNFT_PROGRAM)) return null;
  if (!shape.accountKeys.includes(BUBBLEGUM_PROGRAM))   return null;
  for (const line of shape.logs) {
    for (const n of LMNFT_CNFT_NEEDLES) {
      if (line.includes(n)) return n;
    }
  }
  return null;
}

/** True iff `tx` matches the vvv.so direct-Core mint pattern. The
 *  platform signer's presence as an actual signer (not just an account
 *  reference) plus a Core `CreateV2` log is the fingerprint. */
function isVvvSoTx(shape: ParsedTxShape): boolean {
  if (!shape.signerKeys.includes(VVVSO_PLATFORM_SIGNER)) return false;
  if (!shape.accountKeys.includes(MPL_CORE_PROGRAM))     return false;
  for (const line of shape.logs) {
    if (line.includes('Instruction: CreateV2')) return true;
  }
  return false;
}

/** Pull the asset/mint, payer, and (best-effort) collection out of the
 *  inner MPL Core CPI in `tx`. Both LMNFT and vvv.so allocate the new
 *  asset via Core's Create / CreateV2 (LMNFT as an inner CPI from its
 *  outer MintCore; vvv.so as the outer instruction directly). The
 *  Core CreateV1/V2 ix layout is consistent enough for our extraction:
 *      accounts[0] = asset
 *      accounts[1] = collection (optional)
 *      accounts[3] = payer (signer)
 *  Returns null if no Core ix is present or the asset slot is empty. */
function extractCoreMintFromInner(
  tx: RawSolanaTx,
  shape: ParsedTxShape,
): { mintAddress: string; collectionAddress: string | null } | null {
  // Top-level scan first (vvv.so case — Core ix is the outer ix).
  const message = tx.transaction?.message;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const top = (message as any)?.instructions as Array<{ programIdIndex?: number; programId?: string; accounts?: Array<number | string> }> | undefined;
  if (Array.isArray(top)) {
    for (const ix of top) {
      const programId = typeof ix.programId === 'string'
        ? ix.programId
        : typeof ix.programIdIndex === 'number'
          ? shape.accountKeys[ix.programIdIndex]
          : '';
      if (programId !== MPL_CORE_PROGRAM) continue;
      const accs = (ix.accounts ?? []).map(a => typeof a === 'string' ? a : shape.accountKeys[a]);
      const mint = accs[0];
      const coll = accs.length > 1 ? accs[1] : null;
      if (mint) return { mintAddress: mint, collectionAddress: coll ?? null };
    }
  }
  // Inner-CPI scan (LMNFT case — outer ix is LMNFT, Core invoked via CPI).
  const inner = tx.meta?.innerInstructions;
  if (Array.isArray(inner)) {
    for (const grp of inner) {
      if (!Array.isArray(grp.instructions)) continue;
      for (const ix of grp.instructions) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const ixAny = ix as any;
        const programId: string = typeof ixAny.programId === 'string'
          ? ixAny.programId
          : typeof ixAny.programIdIndex === 'number'
            ? shape.accountKeys[ixAny.programIdIndex]
            : '';
        if (programId !== MPL_CORE_PROGRAM) continue;
        const accs: string[] = (ixAny.accounts ?? []).map((a: number | string) =>
          typeof a === 'string' ? a : shape.accountKeys[a],
        );
        const mint = accs[0];
        const coll = accs.length > 1 ? accs[1] : null;
        if (mint) return { mintAddress: mint, collectionAddress: coll ?? null };
      }
    }
  }
  return null;
}

/** Pull the Merkle tree (and best-effort collection) from the inner
 *  Bubblegum CPI of an LMNFT cNFT mint tx. Bubblegum's mint_v1 /
 *  mint_to_collection_v1 ix accounts:
 *      accounts[0] = tree config / authority PDA
 *      accounts[1] = leaf owner (the recipient wallet)
 *      accounts[2] = leaf delegate
 *      accounts[3] = merkle tree                       ← the "collection-like" group
 *      accounts[4] = payer (signer)
 *      accounts[5] = tree creator/delegate
 *      ...
 *  cNFTs have no on-chain mint account; the asset ID is computed
 *  off-chain from (tree, leaf_nonce). We use the tree address as the
 *  collection-equivalent and leave `mintAddress = null`. */
function extractCnftFromInner(
  tx: RawSolanaTx,
  shape: ParsedTxShape,
): { merkleTree: string } | null {
  const inner = tx.meta?.innerInstructions;
  if (!Array.isArray(inner)) return null;
  for (const grp of inner) {
    if (!Array.isArray(grp.instructions)) continue;
    for (const ix of grp.instructions) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ixAny = ix as any;
      const programId: string = typeof ixAny.programId === 'string'
        ? ixAny.programId
        : typeof ixAny.programIdIndex === 'number'
          ? shape.accountKeys[ixAny.programIdIndex]
          : '';
      if (programId !== BUBBLEGUM_PROGRAM) continue;
      const accs: string[] = (ixAny.accounts ?? []).map((a: number | string) =>
        typeof a === 'string' ? a : shape.accountKeys[a],
      );
      // Merkle tree at index 3 across mint_v1 / mint_to_collection_v1.
      // Defensive: bail if the slot's empty / not a string.
      const tree = accs.length > 3 ? accs[3] : null;
      if (typeof tree === 'string' && tree.length > 0) {
        return { merkleTree: tree };
      }
    }
  }
  return null;
}

/** Public: classify a fetched tx against the targeted launchpad set.
 *  Returns the first matching launchpad hit, or null when neither
 *  detector accepts. Caller is responsible for the recordMint side
 *  effect; this module is a pure read of the tx. */
export function detectLaunchpadMint(tx: RawSolanaTx): LaunchpadHit | null {
  const shape = readTxShape(tx);
  if (!shape) return null;

  if (isLaunchMyNftCoreTx(shape)) {
    const core = extractCoreMintFromInner(tx, shape);
    if (!core) return null;
    return {
      source:            'LaunchMyNFT',
      standard:          'core',
      mintAddress:       core.mintAddress,
      collectionAddress: core.collectionAddress,
      minter:            shape.signerKeys[0] ?? null,
      matchedNeedle:     'Instruction: MintCore',
    };
  }
  const cnftNeedle = lmnftCnftNeedleIfPresent(shape);
  if (cnftNeedle) {
    const cnft = extractCnftFromInner(tx, shape);
    if (!cnft) return null;   // gate failed — Bubblegum CPI present but tree slot empty
    return {
      source:            'LaunchMyNFT',
      standard:          'cnft',
      // cNFTs have no on-chain mint account.
      mintAddress:       null,
      // Use the Merkle tree as the collection-equivalent grouping
      // anchor — every cNFT in this drop shares this tree.
      collectionAddress: cnft.merkleTree,
      minter:            shape.signerKeys[0] ?? null,
      matchedNeedle:     cnftNeedle,
    };
  }
  if (isVvvSoTx(shape)) {
    const core = extractCoreMintFromInner(tx, shape);
    if (!core) return null;
    return {
      source:            'VVV',
      standard:          'core',
      mintAddress:       core.mintAddress,
      collectionAddress: core.collectionAddress,
      // First signer is buyer; vvv.so platform signer is at index 2.
      minter:            shape.signerKeys[0] ?? null,
      matchedNeedle:     'Instruction: CreateV2',
    };
  }
  return null;
}

/** Tracker mode resolver. Defaults to `targeted` per the operator
 *  spec; set `MINT_TRACKER_MODE=legacy` to re-enable the broader
 *  Token Metadata / Core classifier path. */
export type MintTrackerMode = 'targeted' | 'legacy';
export function getMintTrackerMode(): MintTrackerMode {
  const raw = process.env.MINT_TRACKER_MODE;
  return raw === 'legacy' ? 'legacy' : 'targeted';
}
