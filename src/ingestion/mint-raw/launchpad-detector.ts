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

export const LAUNCHMYNFT_PROGRAM    = 'F9SixdqdmEBP5kprp2gZPZNeMmfHJRCTMFjN22dx3akf';
export const MPL_CORE_PROGRAM       = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
export const BUBBLEGUM_PROGRAM      = 'BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY';
export const TOKEN_METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
/** vvv.so platform signer observed on every confirmed vvv.so mint.
 *  Treated as the on-chain fingerprint until a more durable signal
 *  (program, IDL discriminator) is identified. */
export const VVVSO_PLATFORM_SIGNER = 'AY5tENt66T5DhG7rKjh1kRMjeZTq7trMLJhk4cXAZNrn';

export type LaunchpadSource = 'LaunchMyNFT' | 'VVV';
/** Underlying NFT standard for this hit.
 *   'core'           — MPL Core asset       (programSource = mpl_core)
 *   'cnft'           — Bubblegum compressed (programSource = bubblegum)
 *   'token_metadata' — TM legacy / pNFT     (programSource = mpl_token_metadata)
 */
export type LaunchpadStandard = 'core' | 'cnft' | 'token_metadata';

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

/** Core-Create log needles. LMNFT's Anchor handler family has expanded
 *  past the original `MintCore` dispatcher — the program now ships
 *  several entry points (e.g. `MintCore`, `MintCoreV2`, future
 *  variants) that all CPI into MPL Core's create. Anchor non-mint
 *  ixs (`Update`, `SetName…`, `UpdatePhase`) never CPI into a Core
 *  CREATE — they hit Core's update/burn/transfer or no Core at all.
 *  So the bulletproof acceptance condition is "outer = LMNFT AND a
 *  CORE-program log line is one of these create needles" rather than
 *  pinning on the launchpad's specific dispatcher name.
 *
 *  Strict end-of-line match to avoid `Instruction: CreateTokenAccount`
 *  (Token program) collisions; ATA's create logs as `Program log:
 *  Create` (no `Instruction:` prefix) so it's also disjoint. */
const CORE_CREATE_LOG_REGEX = /^Program log: Instruction: (Create|CreateV1|CreateV2|CreateCollection|CreateCollectionV1)$/;
function lmnftCoreNeedleIfPresent(shape: ParsedTxShape): string | null {
  if (!shape.accountKeys.includes(LAUNCHMYNFT_PROGRAM)) return null;
  if (!shape.accountKeys.includes(MPL_CORE_PROGRAM))    return null;
  for (const line of shape.logs) {
    const m = line.match(CORE_CREATE_LOG_REGEX);
    if (m) return `Instruction: ${m[1]}`;
  }
  return null;
}

/** True iff `tx` is an LMNFT Token-Metadata mint — outer LMNFT dispatcher
 *  `Instruction: MintTm`, with Token Metadata program present and an
 *  inner Token Metadata CPI sequence (Create + Mint + optional Verify).
 *  Strict end-of-line match keeps any future `MintTmV2`-style variant
 *  out of this gate until it's confirmed.
 *
 *  Reference tx (legacy/pNFT family, with Verify):
 *    4sC8772iLoGzjzcJRMbabYQMSnBqcpaAJN4XmFsUNrm4hoe1weJAbFBtcEx9xZgKvdSjUpcib2PZtmCaQeSMHQCr
 */
const LMNFT_TM_LOG_REGEX = /^Program log: Instruction: MintTm$/;
function lmnftTmNeedleIfPresent(shape: ParsedTxShape): string | null {
  if (!shape.accountKeys.includes(LAUNCHMYNFT_PROGRAM))    return null;
  if (!shape.accountKeys.includes(TOKEN_METADATA_PROGRAM)) return null;
  for (const line of shape.logs) {
    if (LMNFT_TM_LOG_REGEX.test(line)) return 'Instruction: MintTm';
  }
  return null;
}

/** Pull the new mint and (best-effort) the verified collection out of the
 *  inner Token-Metadata CPIs of an LMNFT MintTm tx.
 *
 *  Token Metadata `Create`/`CreateMetadataAccountV3` ix layout — the FIRST
 *  TM CPI in the LMNFT MintTm flow:
 *      accounts[0] = metadata PDA  (anchor for the Verify match below)
 *      accounts[1] = mint           ← the new asset
 *      accounts[2] = mint authority
 *      accounts[3] = payer
 *      accounts[4] = update authority
 *
 *  Token Metadata `Verify` ix layout — present only when the drop sets a
 *  collection and the launchpad calls Verify in the same tx:
 *      accounts[0] = collection_authority (signer)
 *      accounts[1] = delegate_record (optional)
 *      accounts[2] = asset's metadata PDA   ← anchor (matches Create accs[0])
 *      accounts[3] = collection mint        ← what we want
 *      accounts[4] = collection metadata
 *      accounts[5] = collection master edition
 *
 *  When the Verify CPI is absent the collection is left null; the caller
 *  then falls back to the existing DAS resolve / async confirmation path,
 *  same as the Core branch. The mint is required — null returns reject. */
function extractTmMintFromInner(
  tx: RawSolanaTx,
  shape: ParsedTxShape,
): { mintAddress: string; collectionAddress: string | null } | null {
  const inner = tx.meta?.innerInstructions;
  if (!Array.isArray(inner)) return null;

  let metadataPDA:       string | null = null;
  let mintAddress:       string | null = null;
  let collectionAddress: string | null = null;

  // Pass 1: first TM CPI is the Create call. Pull metadata PDA + mint.
  outer1:
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
      if (programId !== TOKEN_METADATA_PROGRAM) continue;
      const accs: string[] = (ixAny.accounts ?? []).map((a: number | string) =>
        typeof a === 'string' ? a : shape.accountKeys[a],
      );
      if (accs.length >= 2 && typeof accs[0] === 'string' && typeof accs[1] === 'string') {
        metadataPDA = accs[0];
        mintAddress = accs[1];
      }
      break outer1;
    }
  }

  if (!mintAddress) return null;

  // Pass 2: locate the Verify CPI by anchoring on metadataPDA at accs[2].
  // This is the only TM ix in the flow whose 3rd account equals the asset's
  // metadata PDA we just allocated; both Create (metadata at accs[0]) and
  // Mint (metadata at accs[2] but accs[3]=mint, not a distinct collection)
  // are excluded by the additional `accs[3] !== mintAddress` guard.
  if (metadataPDA) {
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
        if (programId !== TOKEN_METADATA_PROGRAM) continue;
        const accs: string[] = (ixAny.accounts ?? []).map((a: number | string) =>
          typeof a === 'string' ? a : shape.accountKeys[a],
        );
        if (accs.length >= 6
            && accs[2] === metadataPDA
            && typeof accs[3] === 'string'
            && accs[3] !== mintAddress) {
          collectionAddress = accs[3];
          break;
        }
      }
      if (collectionAddress) break;
    }
  }

  return { mintAddress, collectionAddress };
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

  const lmnftCoreNeedle = lmnftCoreNeedleIfPresent(shape);
  if (lmnftCoreNeedle) {
    const core = extractCoreMintFromInner(tx, shape);
    if (!core) {
      // LMNFT outer + Core-create log present, but inner Core ix accs
      // didn't yield an asset. Treat as a parse miss, not an accept.
      // Hard-log so the operator can capture an example to refine
      // `extractCoreMintFromInner` if a new Core-create variant
      // surfaces with a different account layout.
      console.log(
        `[mints/lmnft-core-skip] sig=${tx.signature ?? '—'} reason=no_core_create coreIx=${lmnftCoreNeedle}`,
      );
      return null;
    }
    console.log(
      `[mints/lmnft-core-create] sig=${tx.signature ?? '—'} coreIx=${lmnftCoreNeedle} ` +
      `mint=${core.mintAddress} collection=${core.collectionAddress ?? 'null'} ` +
      `minter=${shape.signerKeys[0] ?? 'null'}`,
    );
    return {
      source:            'LaunchMyNFT',
      standard:          'core',
      mintAddress:       core.mintAddress,
      collectionAddress: core.collectionAddress,
      minter:            shape.signerKeys[0] ?? null,
      matchedNeedle:     lmnftCoreNeedle,
    };
  }
  // LMNFT outer present but NO Core-create log → skipped here as
  // `core_update_only` so config / update / SetName txs are visibly
  // rejected (separate from the broader `unknown_launchpad` path).
  if (shape.accountKeys.includes(LAUNCHMYNFT_PROGRAM)
      && shape.accountKeys.includes(MPL_CORE_PROGRAM)
      && !lmnftCnftNeedleIfPresent(shape)) {
    console.log(
      `[mints/lmnft-core-skip] sig=${tx.signature ?? '—'} reason=update_only`,
    );
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
  // LMNFT Token-Metadata mint variant. Gated on the dual-signal pair
  // (LMNFT outer program + strict `Instruction: MintTm` log + Token
  // Metadata program present) so a stand-alone TM Create from a wallet
  // / unrelated launchpad cannot accidentally match here.
  const tmNeedle = lmnftTmNeedleIfPresent(shape);
  if (tmNeedle) {
    const tm = extractTmMintFromInner(tx, shape);
    if (!tm) {
      // Inner TM CPI shape was wrong — log so the operator can capture
      // an example if a future LMNFT MintTm variant changes the layout.
      console.log(
        `[mints/lmnft-minttm-skip] sig=${tx.signature ?? '—'} reason=no_tm_create`,
      );
      return null;
    }
    console.log(
      `[mints/lmnft-minttm] sig=${tx.signature ?? '—'} mint=${tm.mintAddress} ` +
      `collection=${tm.collectionAddress ?? 'null'} ` +
      `minter=${shape.signerKeys[0] ?? 'null'}`,
    );
    return {
      source:            'LaunchMyNFT',
      standard:          'token_metadata',
      mintAddress:       tm.mintAddress,
      collectionAddress: tm.collectionAddress,
      minter:            shape.signerKeys[0] ?? null,
      matchedNeedle:     tmNeedle,
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
