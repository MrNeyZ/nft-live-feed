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
import { PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import type { RawSolanaTx } from '../me-raw/types';

export const LAUNCHMYNFT_PROGRAM    = 'F9SixdqdmEBP5kprp2gZPZNeMmfHJRCTMFjN22dx3akf';
export const MPL_CORE_PROGRAM       = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
export const BUBBLEGUM_PROGRAM      = 'BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY';
export const TOKEN_METADATA_PROGRAM = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
/** SPL Account Compression Noop program — every Bubblegum mint emits a
 *  CPI to this program carrying the `LeafSchema` of the freshly-minted
 *  leaf. We decode that payload to recover the leaf nonce and derive
 *  the cNFT asset ID locally (no DAS / RPC needed). */
const NOOP_PROGRAM = 'noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV';
const BUBBLEGUM_PROGRAM_PK = new PublicKey(BUBBLEGUM_PROGRAM);
const ASSET_SEED = Buffer.from('asset');

/** Borsh layout of the `AccountCompressionEvent::ApplicationData` Noop
 *  ix data emitted by every Bubblegum mint (mint_v1 /
 *  mint_to_collection_v1 / mint_v2 / mint_to_collection_v2):
 *
 *    byte  0     AccountCompressionEvent variant tag (1 = ApplicationData)
 *    byte  1     ApplicationDataEvent variant tag    (0 = V1)
 *    bytes 2-5   u32 LE: length of application_data
 *    bytes 6+    application_data — a serialized LeafSchema:
 *      byte    6      LeafSchema variant tag (0 = V1, 1 = V2)
 *      bytes   7-38   id        (32 bytes)
 *      bytes  39-70   owner     (32 bytes)
 *      bytes  71-102  delegate  (32 bytes)
 *      bytes 103-110  nonce     (u64 LE)               ← used for PDA derivation
 *      ... data_hash, creator_hash; LeafSchemaV2 adds collection_hash etc.
 *
 *  The prefix layout up through `nonce` is identical for V1 and V2,
 *  so reading at fixed offset 103 works for both. We don't gate on the
 *  LeafSchema variant tag at byte 6 for the same reason. */
const NOOP_LEAF_NONCE_OFFSET = 103;
const NOOP_LEAF_NONCE_LEN    = 8;
const NOOP_MIN_DATA_LEN      = NOOP_LEAF_NONCE_OFFSET + NOOP_LEAF_NONCE_LEN;

/** Derive the cNFT asset ID via the canonical Bubblegum PDA seeds:
 *    findProgramAddress(["asset", merkle_tree, u64_le(nonce)], BGUM)
 *  Returns null on malformed merkle key (web3.js throws on a
 *  non-base58 string). */
function deriveCnftAssetId(merkleTree: string, nonceLe: Buffer): string | null {
  try {
    const [pda] = PublicKey.findProgramAddressSync(
      [ASSET_SEED, new PublicKey(merkleTree).toBuffer(), nonceLe],
      BUBBLEGUM_PROGRAM_PK,
    );
    return pda.toBase58();
  } catch {
    return null;
  }
}
/** vvv.so platform signer observed on every confirmed vvv.so mint.
 *  Treated as the on-chain fingerprint until a more durable signal
 *  (program, IDL discriminator) is identified. */
export const VVVSO_PLATFORM_SIGNER = 'AY5tENt66T5DhG7rKjh1kRMjeZTq7trMLJhk4cXAZNrn';

/** vvv.so platform treasury / fee-collector. Writable non-signer in
 *  every confirmed vvv.so Core CreateV2 mint observed to date
 *  (13/13 across an 11-month sample spanning 2025-06 → 2026-05),
 *  including the two newest drops where vvv has rotated the platform
 *  signer at index 2 away from VVVSO_PLATFORM_SIGNER. Used only as a
 *  flag-gated fallback fingerprint in `isVvvSoTx`; see
 *  `getMintTrackerVvvTreasuryGateEnabled`. */
export const VVVSO_PLATFORM_TREASURY = 'EQCaFM2JHFd5RrDPNhS96KLxdmiAK9eeWJyJWest31tm';

/** gravemint.io platform signer. Writable, deliberately-vanity-prefixed
 *  (`DEAD…`) keypair that signs the direct-Core ("shape A") family of
 *  Gravemint mints — both buyer-pays drops and lean house-mints where
 *  Gravemint pays everything itself. The signer can appear at idx 0,
 *  1, or 2 across observed shapes, so we check via `signerKeys.includes`
 *  rather than a fixed index. The newer program-wrapped family
 *  ("shape B", `GRAVEMINT_PROGRAM` below) does NOT sign with this key
 *  — DEAD appears only as a writable non-signer receiving a System
 *  transfer — so shape B is matched via the program ID instead. */
export const GRAVEMINT_PLATFORM_SIGNER   = 'DEADsTGdpwgudGq4SUMPqzETzoaqAuDHbQovkTzTEA1R';
/** gravemint.io treasury / fee-collector. Writable non-signer present
 *  alongside `GRAVEMINT_PLATFORM_SIGNER` in the original 5/5 audit
 *  samples but ABSENT in the leaner house-mint shape (e.g.
 *  37jWw1BSXQx5FMTyv4AuFUdhogevo1pmRkUG46LyHEiTZh8oBMFw6BiAH71V5FQagCF2MnQSf46oHQCTRjtAgvM5
 *  — 6-key tx, no treasury, no fee charged to a buyer). Kept as a
 *  diagnostic-only constant: presence is recorded on the matchedNeedle
 *  for forensic value, but it is no longer required by the gate. */
export const GRAVEMINT_PLATFORM_TREASURY = '4rUxPzDvQXfjZuHfApV7Bhf1uxsAjJDxgtYy7UaQMq24';
/** gravemint.io on-chain program. Anchor dispatcher with an
 *  `Instruction: MintCore` handler that CPIs into MPL Core CreateV2.
 *  Used as the primary fingerprint for "shape B" mints — the
 *  program-wrapped family where the buyer pays directly, DEAD does
 *  NOT sign, and the platform receives revenue via System transfers
 *  in inner ixs. Reference tx:
 *    AjieZ9mqBPM8eXkvzx8mGzNqhQcGJHRtaCQFptNhxAgrVwgFmGJwUx1517VYrwssdoA4HxGyVsAcP6bd94AsbcN
 *  The program ID is unspoofable in the same sense as a signer key:
 *  someone would have to own upgrade authority of that exact program
 *  to issue an instruction under it. We additionally require MPL Core
 *  + CreateV2 log so a hypothetical non-mint Gravemint ix (config
 *  update, etc.) cannot match. */
export const GRAVEMINT_PROGRAM           = 'GRVMNt7b2Pojom2fTF6HytLRm2hfQCN8iHm9wLvSFWVJ';

export type LaunchpadSource = 'LaunchMyNFT' | 'VVV' | 'GRAVE';
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
  /** The freshly-minted asset / mint pubkey.
   *   - Core / Token Metadata: the SPL mint account.
   *   - cNFT (Bubblegum): the asset ID PDA derived locally from the
   *     merkle tree + leaf nonce read out of the SPL Noop event the
   *     Bubblegum mint CPI emits. Stays `null` only when that event
   *     is missing / malformed (defensive — graceful degrade to the
   *     previous behaviour of emitting a row with no mint anchor). */
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

/** True iff `tx` matches the vvv.so direct-Core mint pattern.
 *
 *  Primary fingerprint: canonical platform signer
 *  `VVVSO_PLATFORM_SIGNER` present as an actual signer (not just an
 *  account reference) plus a Core `CreateV2` log. Catches 11/11
 *  classic vvv.so drops sampled across an 11-month window.
 *
 *  Secondary fingerprint (flag-gated): canonical signer absent, but
 *  `VVVSO_PLATFORM_TREASURY` present as a writable non-signer account
 *  alongside the same Core `CreateV2` log. Catches the newest drops
 *  where vvv has rotated the platform signer per-collection. Off by
 *  default — only active when `MINT_TRACKER_VVV_TREASURY_GATE=1`. */
function isVvvSoTx(shape: ParsedTxShape): boolean {
  if (!shape.accountKeys.includes(MPL_CORE_PROGRAM)) return false;
  let hasCreateV2 = false;
  for (const line of shape.logs) {
    if (line.includes('Instruction: CreateV2')) { hasCreateV2 = true; break; }
  }
  if (!hasCreateV2) return false;
  if (shape.signerKeys.includes(VVVSO_PLATFORM_SIGNER)) return true;
  if (getMintTrackerVvvTreasuryGateEnabled()
      && shape.accountKeys.includes(VVVSO_PLATFORM_TREASURY)) {
    return true;
  }
  return false;
}

/** True iff `tx` matches one of the two confirmed gravemint.io mint
 *  shapes.
 *
 *  Shared prerequisites (cheap, structural):
 *    a. MPL Core program present,
 *    b. a `Program log: Instruction: CreateV2` log line — confirms a
 *       Core mint, not an update / transfer.
 *
 *  Plus EITHER (any one is sufficient — the shapes are disjoint):
 *
 *    Shape A — direct-Core, DEAD signs:
 *      `GRAVEMINT_PLATFORM_SIGNER` is an actual signer. Covers both
 *      the original buyer-pays drops (5/5 audit samples, treasury
 *      present) and the lean house-pays shape (37jWw1…AgvM5, no
 *      treasury). The vanity-prefixed `DEAD…` keypair is unspoofable
 *      without the launchpad's private key.
 *
 *    Shape B — program-wrapped, GRVMNt dispatches:
 *      `GRAVEMINT_PROGRAM` (`GRVMNt…WVJ`) appears in `accountKeys`.
 *      Here Gravemint's own Anchor program is the outer dispatcher
 *      with an `Instruction: MintCore` handler that CPIs into Core
 *      CreateV2; the buyer signs, DEAD is a writable non-signer that
 *      receives a System transfer, treasury is present. Reference tx:
 *      AjieZ9mqBPM8eXkvzx8mGzNqhQcGJHRtaCQFptNhxAgrVwgFmGJwUx1517VYrwssdoA4HxGyVsAcP6bd94AsbcN.
 *      Treating the program ID as a fingerprint is consistent with
 *      `lmnftCoreNeedleIfPresent`, which keys off
 *      `LAUNCHMYNFT_PROGRAM` the same way.
 *
 *  Mutually exclusive with `isVvvSoTx` (different signer / treasury /
 *  program) and with the LMNFT branches (no LMNFT outer program in
 *  account keys). */
function isGraveMintTx(shape: ParsedTxShape): boolean {
  if (!shape.accountKeys.includes(MPL_CORE_PROGRAM)) return false;
  if (!shape.logs.some((line) => line.includes('Instruction: CreateV2'))) return false;
  // Shape A — DEAD signs.
  if (shape.signerKeys.includes(GRAVEMINT_PLATFORM_SIGNER)) return true;
  // Shape B — GRVMNt Anchor program orchestrates.
  if (shape.accountKeys.includes(GRAVEMINT_PROGRAM)) return true;
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

/** Pull the Merkle tree + derived asset ID from the inner CPIs of an
 *  LMNFT cNFT mint tx. Bubblegum's mint_v1 / mint_to_collection_v1 /
 *  mint_v2 / mint_to_collection_v2 ix accounts share the prefix:
 *      accounts[0] = tree config / authority PDA
 *      accounts[1] = leaf owner (the recipient wallet)
 *      accounts[2] = leaf delegate
 *      accounts[3] = merkle tree                       ← the "collection-like" group
 *      accounts[4] = payer (signer)
 *      accounts[5] = tree creator/delegate
 *      ...
 *  Bubblegum then emits a Noop CPI with the LeafSchema event for the
 *  freshly-minted leaf — that's where the `nonce` comes from. With the
 *  tree + nonce in hand we derive the asset ID locally via the
 *  canonical Bubblegum PDA seeds (no DAS / no RPC). When the Noop
 *  event is missing or layout-skewed (e.g. unknown future Bubblegum
 *  variant), assetId stays null and the row degrades to the previous
 *  no-mint-anchor behaviour. */
function extractCnftFromInner(
  tx: RawSolanaTx,
  shape: ParsedTxShape,
): { merkleTree: string; assetId: string | null } | null {
  const inner = tx.meta?.innerInstructions;
  if (!Array.isArray(inner)) return null;
  for (const grp of inner) {
    if (!Array.isArray(grp.instructions)) continue;
    let merkleTree: string | null = null;
    let nonceLe:    Buffer | null = null;
    for (const ix of grp.instructions) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ixAny = ix as any;
      const programId: string = typeof ixAny.programId === 'string'
        ? ixAny.programId
        : typeof ixAny.programIdIndex === 'number'
          ? shape.accountKeys[ixAny.programIdIndex]
          : '';
      if (programId === BUBBLEGUM_PROGRAM && merkleTree === null) {
        const accs: string[] = (ixAny.accounts ?? []).map((a: number | string) =>
          typeof a === 'string' ? a : shape.accountKeys[a],
        );
        // Merkle tree at index 3 across mint_v1 / mint_to_collection_v1
        // / mint_v2 / mint_to_collection_v2. Defensive: bail if the
        // slot's empty / not a string.
        const tree = accs.length > 3 ? accs[3] : null;
        if (typeof tree === 'string' && tree.length > 0) merkleTree = tree;
      } else if (programId === NOOP_PROGRAM && nonceLe === null) {
        // Decode the Noop ix data — base58-encoded in the parsed-tx
        // representation. Skip silently on any malformed payload (e.g.
        // a ChangeLog event, which uses tag 0 and not 1).
        let data: Buffer;
        try { data = Buffer.from(bs58.decode(ixAny.data)); } catch { continue; }
        if (data.length < NOOP_MIN_DATA_LEN) continue;
        if (data[0] !== 1)                   continue;  // not ApplicationData
        if (data[1] !== 0)                   continue;  // not V1 wrapper
        nonceLe = Buffer.from(data.subarray(
          NOOP_LEAF_NONCE_OFFSET,
          NOOP_LEAF_NONCE_OFFSET + NOOP_LEAF_NONCE_LEN,
        ));
      }
    }
    if (merkleTree) {
      const assetId = nonceLe ? deriveCnftAssetId(merkleTree, nonceLe) : null;
      return { merkleTree, assetId };
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
      // cNFT asset ID derived locally from the Bubblegum Noop event
      // (tree + leaf nonce). Stays null only when that event is missing
      // — e.g. an as-yet-unknown Bubblegum variant — so callers see
      // the same "no mint anchor" fallback as before in degenerate
      // cases. Healthy LMNFT cNFT mints now ship a real assetId,
      // restoring Solscan links + LAST MINT clickability.
      mintAddress:       cnft.assetId,
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
  // Gravemint.io targeted detector — runs AFTER vvv so a tx that
  // somehow carried both fingerprints (none seen) would still resolve
  // as VVV (older, more samples). Flag-gated; OFF by default.
  if (getMintTrackerGraveGateEnabled() && isGraveMintTx(shape)) {
    const core = extractCoreMintFromInner(tx, shape);
    if (!core) return null;
    // Record which shape matched so future audits can distinguish the
    // confirmed variants without re-decoding the tx. Shape B (Anchor
    // program) wins precedence when both signals fire — none observed
    // simultaneously, but a future buyer-pays drop under the new
    // program could.
    const shapeB = shape.accountKeys.includes(GRAVEMINT_PROGRAM);
    const treasuryPresent = shape.accountKeys.includes(GRAVEMINT_PLATFORM_TREASURY);
    const matchedNeedle = shapeB
      ? 'Instruction: CreateV2 (GRVMNt program)'
      : treasuryPresent
        ? 'Instruction: CreateV2 + treasury'
        : 'Instruction: CreateV2';
    return {
      source:            'GRAVE',
      standard:          'core',
      mintAddress:       core.mintAddress,
      collectionAddress: core.collectionAddress,
      minter:            shape.signerKeys[0] ?? null,
      matchedNeedle,
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

/** Feature-flagged Direct MPL Core CreateV2 fallback scorer. OFF by
 *  default — production behaviour is unchanged unless the operator
 *  explicitly sets `MINT_TRACKER_CORE_V2_SCORER=1`. When enabled, the
 *  fallback runs ONLY in the `unknown_launchpad` branch of targeted
 *  mode (i.e. after `detectLaunchpadMint` returns null). Intended for
 *  side-by-side comparison vs. the existing LMNFT/vvv targeted
 *  detector; never overrides a targeted hit. */
export function getMintTrackerCoreV2ScorerEnabled(): boolean {
  return process.env.MINT_TRACKER_CORE_V2_SCORER === '1';
}

/** Feature-flagged vvv.so treasury fingerprint, used as a fallback
 *  gate inside `isVvvSoTx` when the canonical platform signer is
 *  absent (signer-rotated drops). OFF by default — production
 *  behaviour is byte-identical unless the operator sets
 *  `MINT_TRACKER_VVV_TREASURY_GATE=1`. Improves source labelling
 *  (`VVV` instead of generic `Metaplex Core`) without expanding
 *  coverage — accepted txs would already be picked up by the v2-core
 *  fallback scorer when that flag is also on. */
export function getMintTrackerVvvTreasuryGateEnabled(): boolean {
  return process.env.MINT_TRACKER_VVV_TREASURY_GATE === '1';
}

/** Feature-flagged gravemint.io targeted detector. OFF by default;
 *  only active when `MINT_TRACKER_GRAVE_GATE=1`. Coverage is unchanged
 *  — Gravemint Core CreateV2 mints already surface via the v2-core
 *  fallback scorer; this flag only relabels them from `Metaplex Core`
 *  to `GRAVE`. */
export function getMintTrackerGraveGateEnabled(): boolean {
  return process.env.MINT_TRACKER_GRAVE_GATE === '1';
}
