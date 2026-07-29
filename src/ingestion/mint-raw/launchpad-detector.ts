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
// Bubblegum LeafSchemaEvent (wrapped in the spl-noop ApplicationData V1
// envelope, head bytes [1,0]). The LeafSchema::V1 body begins after a 9-byte
// envelope header, laid out as:
//     id (Pubkey, 32) @ 9 .. 41      ← the canonical cNFT asset id
//     owner (Pubkey, 32) @ 41 .. 73
//     delegate (Pubkey, 32) @ 73 .. 105
//     nonce (u64 LE, 8) @ 105 .. 113  ← the leaf index used to derive id
// The previous NONCE offset of 103 was off by 2 bytes: it read into the
// delegate/nonce boundary, yielding a ~23-billion garbage nonce that derived a
// PHANTOM asset PDA which DAS can never resolve (every LMNFT cNFT mint surfaced
// with a fabricated mintAddress + empty name). Verified against three live
// MintToCollectionV1 txs: id@9 resolves in DAS, nonce@105 == the real leaf
// index, and PDA(["asset", tree, nonce@105]) == id@9.
// Ref: 4ysjhrsAazda3kc52K9WkaJhsgsGjrj1TiALXSsjwnkxy2uUQQ1apTfNRF3UXQoKu9EyUXgkPGRvvtKFpHjYk27T
const NOOP_LEAF_ID_OFFSET    = 9;
const NOOP_LEAF_ID_LEN       = 32;
const NOOP_LEAF_NONCE_OFFSET = 105;
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

/** MintX (mintx.io) server-gated backend co-signers.
 *
 *  MintX fronts an otherwise-standard MPL Core **Candy Guard**
 *  (`CMAGAKJ…JjWTJ`) mint, but additionally requires TWO backend
 *  signatures issued server-side after an off-chain (soft token /
 *  AddressGate) gate is satisfied. On every confirmed MintX mint the
 *  signer set is: buyer at index 0, the new asset keypair (signs to
 *  create itself), and these two keys — neither of which a client can
 *  reproduce. The gate itself surfaces on-chain as a pre-mint SPL
 *  transfer of the soft-gate token to a MintX treasury vault ATA (a
 *  *transfer*, not a burn). Because the signatures are minted by MintX's
 *  backend, the mint is NOT reconstructable — same blocked class as the
 *  vvv.so / gravemint.io platform-signer gates above. Either key present
 *  as a required signer is the fingerprint (checked via
 *  `signerKeys.includes`, not a fixed index). Reference tx:
 *    4NJcYNEEeRAa1Xzsa8XQd1iPmHGhMmcw5VwHXfdoyc7LKA4m8Cayuu4J3tuy7Hn6bDayUjr7oWYNaBt9q8wik35K
 */
export const MINTX_PLATFORM_SIGNER_PRIMARY   = 'xbWUT2Z3DWUrc4f65keHjntdtXiD7ov8d4Wj11yuBh8';
export const MINTX_PLATFORM_SIGNER_SECONDARY = 'EBxTysPFiZymqFswF5SyLKCC5ybj6ii8wg8s2Mbhseex';

/** Metaplex Candy Guard — the standard outer wrapper for Candy
 *  Machine v3 (and any future Metaplex-issued CM variants that route
 *  through the same Guard). Used as the **launchpad fingerprint** in
 *  the same sense LMNFT's outer program is — single deployed program
 *  ID, unspoofable (only Metaplex holds upgrade authority), and
 *  present on every Guarded mint regardless of inner-CPI details. */
export const CANDY_GUARD_PROGRAM         = 'Guard1JwRhJkVH6XZhzoYxeBVQe872VH6QggF4BWmS9g';

/** Metaplex Candy Machine v3 — the CPI target Candy Guard reaches
 *  into for a CM v3-backed mint. Kept as a **secondary evidence**
 *  anchor (the launchpad fingerprint above is primary): a Candy
 *  Guard tx with no Token Metadata account and no CM v3 account
 *  isn't a mint we can extract. Reference fixtures:
 *    3FCeEkMFnZRpjyHgypUY87uy6WnP8jVdxf7GabUU3k5TDjr9xovihDdgf3PVeZTFtGRYBbGj7qmWvFhGBep3ZPKQ
 *    3RkBDYSBba8NtvPWrec8Z2QY1xiWpMQAo1dYHAbrh7MU272mt9e3MJPXgcnqrUhf22BeL7Xi7egM2PdGRjhBxDRk
 *    4KZKMGiHhekCbeoGf4noBmskEHMivrij1PtBdqd9pp3entizNgrkVdR94tTjV1AJYDXmXhpkP9vfM8QRKk5n45JW */
export const CANDY_MACHINE_V3_PROGRAM    = 'CndyV3LdqHUfDLmE5naZjVN8rBZz4tqhdefbAnjHG3JR';

/** PRNT mint-pass family.
 *
 *  PRNT issues a "mint pass" as a standard MPL **Core** Candy Machine
 *  asset (Core Candy Guard `CMAGAK…` → Core Candy Machine `CMACYFEN…`
 *  → mpl-core `Create`), but layers a token-vesting leg on top: the
 *  same tx invokes the SPL722 vesting program (`SPL722…`) which logs
 *  `Instruction: InitVesting` followed by `Initialized vesting for
 *  asset <asset>`, where `<asset>` is the freshly-minted Core asset.
 *
 *  That vesting leg is the PRNT fingerprint — a plain CMA Core mint
 *  carries none of it, and a plain SPL722 vesting tx carries no Core
 *  Create. The gate requires BOTH programs, the InitVesting log, and
 *  — critically — that the asset named in the vesting log equals the
 *  Core Create's asset (accounts[0]) IN THE SAME TX. Without that
 *  equality check a CMA mint that merely shared a tx with an unrelated
 *  vesting init could be misattributed.
 *
 *  Reference tx:
 *    2h7fHRPup2eqSJhwB6EQqTPCNKFHdjA1NnE1txSJ3vVzA1P28uDkKbv1Bcyh8g8NHtyxwFrR2Nc49tvT4bWZeSjM
 *    (asset 4NXCz5sT…, collection 5eY82RX1…, minter 4Y742UF…) */
// Candy Labs — a custom Core-minting launchpad program. Name is a pure
// coincidence with Metaplex's "Candy Machine"; unrelated program, unrelated
// team. Vanity address literally spells "forge". Caught by the generic
// unknown-wrapper Core detector (no dedicated tx-shape detector needed);
// this constant only exists so the generic-fallback caller in index.ts can
// special-case its `sourceLabel` to 'Candy Labs' (frontend renders LABS)
// instead of the generic 'Metaplex Core' — see CandyMint tool investigation.
export const CANDY_LABS_WRAPPER_PROGRAM  = 'foRGEL4EUjeQMd8U2QL5Rx8je75ZFpmtLoWRyyAxxr7';
export const PRNT_VESTING_PROGRAM        = 'SPL722x7RdCpb2WEDtkHmzfTypqXp92Ft5qkYWfMcBg';
export const PRNT_CORE_CANDY_GUARD       = 'CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ';
export const PRNT_CORE_CANDY_MACHINE     = 'CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J';
const PRNT_INIT_VESTING_LOG = 'Instruction: InitVesting';
/** Captures the base58 asset id from `Initialized vesting for asset
 *  <asset> with <n> tokens`. Anchored on the program-log phrasing so a
 *  future copy that drops the trailing `with … tokens` clause still
 *  matches the asset segment. */
const PRNT_VESTING_ASSET_REGEX = /Initialized vesting for asset ([1-9A-HJ-NP-Za-km-z]{32,44})/;

/** Returns the vesting-log asset id when `tx` carries the full PRNT
 *  fingerprint (SPL722 + a Core Candy program + `Instruction:
 *  InitVesting` + the asset-log line); null otherwise. The caller is
 *  responsible for the same-tx equality check against the Core Create
 *  asset — this only proves the PRNT programs + logs are present. */
function prntVestingAssetIfPresent(shape: ParsedTxShape): string | null {
  if (!shape.accountKeys.includes(PRNT_VESTING_PROGRAM)) return null;
  if (!shape.accountKeys.includes(PRNT_CORE_CANDY_GUARD)
      && !shape.accountKeys.includes(PRNT_CORE_CANDY_MACHINE)) return null;
  let hasInitVesting = false;
  let vestingAsset: string | null = null;
  for (const line of shape.logs) {
    if (line.includes(PRNT_INIT_VESTING_LOG)) hasInitVesting = true;
    const m = PRNT_VESTING_ASSET_REGEX.exec(line);
    if (m) vestingAsset = m[1];
  }
  if (!hasInitVesting || !vestingAsset) return null;
  return vestingAsset;
}

export type LaunchpadSource = 'LaunchMyNFT' | 'VVV' | 'GRAVE' | 'CandyMachine' | 'NftsGay' | 'PRNT';
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
  /** Candy Machine v3 state account pubkey, when the hit came in via
   *  Candy Guard. The CG `MintV2` outer ix carries this at accs[2]
   *  (after `candy_guard` at [0] and `candy_machine_program` at [1]).
   *  Used by the supply resolver to read `items_redeemed` /
   *  `items_available` directly off the on-chain state. Null for
   *  every other source. */
  candyMachineState?: string | null;
  /** True when this hit is a collection DEPLOY (mpl-core CreateCollection /
   *  CreateCollectionV1), NOT an asset mint. `collectionAddress` is the created
   *  collection (Core ix accounts[0]); `mintAddress` is null (no asset);
   *  `minter` is the deployer / update authority (accounts[1]). The caller
   *  emits a distinct COLLECTION_CREATE event instead of the normal mint path. */
  collectionCreate?: boolean;
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
// Per-ASSET Core create variants only. `CreateCollection` / `CreateCollectionV1`
// are collection DEPLOY instructions (no NFT asset minted) — including them made
// a LaunchMyNFT collection-deploy tx match the mint needle, after which
// `extractCoreMintFromInner` applied the asset layout (accounts[0]=asset,
// accounts[1]=collection) to a CreateCollection ix whose real layout is
// accounts[0]=collection, accounts[1]=updateAuthority. Result: the new
// collection was stored as the minted asset and the DEPLOYER WALLET as the
// collectionAddress, so the collection-created resolver aged the wallet's
// signature history instead of the collection (CREATED showed wallet age, e.g.
// "4h"). Deploy txs must not surface as mints.
// Ref (rejected): 4vbkGLJiYemmjQPuF6tj9obqspz1Hj3NmJASYXB9tTsvdiyLZ3SWJmdxRS6cRo2McSsFDH3xzfVRTfYPjMBNk2Rd
const CORE_CREATE_LOG_REGEX = /^Program log: Instruction: (Create|CreateV1|CreateV2)$/;
function lmnftCoreNeedleIfPresent(shape: ParsedTxShape): string | null {
  if (!shape.accountKeys.includes(LAUNCHMYNFT_PROGRAM)) return null;
  if (!shape.accountKeys.includes(MPL_CORE_PROGRAM))    return null;
  for (const line of shape.logs) {
    const m = line.match(CORE_CREATE_LOG_REGEX);
    if (m) return `Instruction: ${m[1]}`;
  }
  return null;
}

/** LMNFT Core collection-DEPLOY needle. A CreateCollection / CreateCollectionV1 /
 *  CreateCollectionV2 builds the collection master (no asset minted) — deliberately
 *  EXCLUDED from `CORE_CREATE_LOG_REGEX` (the mint needle) so a deploy never parses
 *  as a mint. This separate needle surfaces the deploy as its own COLLECTION_CREATE
 *  event. Same dual fingerprint as the mint needle (LMNFT outer + MPL Core present).
 *  CreateCollectionV2 (disc 21) added: identical account layout to V1, so
 *  `extractCoreCollectionCreate` handles it without changes. */
const CORE_COLLECTION_CREATE_LOG_REGEX = /^Program log: Instruction: (CreateCollection|CreateCollectionV1|CreateCollectionV2)$/;
function lmnftCoreCollectionCreateNeedle(shape: ParsedTxShape): string | null {
  if (!shape.accountKeys.includes(LAUNCHMYNFT_PROGRAM)) return null;
  if (!shape.accountKeys.includes(MPL_CORE_PROGRAM))    return null;
  for (const line of shape.logs) {
    const m = line.match(CORE_COLLECTION_CREATE_LOG_REGEX);
    if (m) return `Instruction: ${m[1]}`;
  }
  return null;
}

/** Pull the created-collection address + deployer out of the Core
 *  CreateCollection ix. The Core CreateCollection(V1) account layout is:
 *      accounts[0] = collection (the new master being created)
 *      accounts[1] = updateAuthority / deployer (often the payer/signer)
 *  This is the inverse-role mapping of `extractCoreMintFromInner` (where
 *  accounts[0] is the asset and [1] is the collection) — keeping them as
 *  separate functions is what prevents the deploy→mint misclassification that
 *  stored the deployer wallet as the collectionAddress. Scans top-level first
 *  (deploy txs CPI Core directly), then inner. Returns null if no Core ix. */
function extractCoreCollectionCreate(
  tx: RawSolanaTx,
  shape: ParsedTxShape,
): { collectionAddress: string; deployer: string | null } | null {
  const scan = (
    list: Array<{ programIdIndex?: number; programId?: string; accounts?: Array<number | string> }> | undefined,
  ): { collectionAddress: string; deployer: string | null } | null => {
    if (!Array.isArray(list)) return null;
    for (const ix of list) {
      const programId = typeof ix.programId === 'string'
        ? ix.programId
        : typeof ix.programIdIndex === 'number'
          ? shape.accountKeys[ix.programIdIndex]
          : '';
      if (programId !== MPL_CORE_PROGRAM) continue;
      const accs = (ix.accounts ?? []).map(a => typeof a === 'string' ? a : shape.accountKeys[a]);
      const collection = accs[0];
      if (collection) return { collectionAddress: collection, deployer: accs.length > 1 ? accs[1] : null };
    }
    return null;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const top = (tx.transaction?.message as any)?.instructions;
  const fromTop = scan(top);
  if (fromTop) return fromTop;
  const inner = tx.meta?.innerInstructions;
  if (Array.isArray(inner)) {
    for (const grp of inner) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fromInner = scan((grp as any).instructions);
      if (fromInner) return fromInner;
    }
  }
  return null;
}

/** Burn-then-remint guard. A genuine fresh LMNFT MintCore mint only
 *  CREATEs a new Core asset; it never BURNs a pre-existing one. A tx that
 *  carries an MPL **Core** `Burn` instruction alongside the create is an
 *  LMNFT migration / claim (old asset burned, replacement minted) — not a
 *  primary mint — so it must not surface in the Mint Tracker. The `Create`
 *  log from the inner Core CPI would otherwise satisfy
 *  `lmnftCoreNeedleIfPresent`.
 *
 *  Scoped to MPL **Core** burns specifically. MPL Core's BurnV1 logs as the
 *  bare `Program log: Instruction: Burn` (no `V` suffix — confirmed on the
 *  reference tx, which is a top-level MPL Core ix disc=12), a string that is
 *  BYTE-IDENTICAL to the SPL Token program's `Burn` log. A plain
 *  `shape.logs.some(/Burn/)` would therefore also fire on an unrelated SPL
 *  Token burn — e.g. a fungible token-gate burn inside an otherwise-fresh
 *  mint — and wrongly drop a legitimate mint. To disambiguate without any
 *  discriminator/IDL dependency we walk the program-invoke stack in the
 *  logs and only flag a `Burn` whose log is emitted while the MPL Core
 *  program is the active (top-of-stack) program; an SPL Token burn is
 *  bracketed by the Token program and is correctly ignored.
 *  Ref (rejected): 2ehj3iTvJJMJqYkByLxrhmhfPDDbEaUamjjM6TKTmCzfWRK2SK4FZzDMYeWVeY146RPSgy7y2Jo5vEHXKoyQxHrb */
const CORE_BURN_LOG_REGEX  = /^Program log: Instruction: Burn(V\d+)?$/;
const PROGRAM_INVOKE_REGEX = /^Program (\S+) invoke \[\d+\]$/;
const PROGRAM_RESULT_REGEX = /^Program (\S+) (?:success|failed)/;
function hasCoreBurn(shape: ParsedTxShape): boolean {
  const stack: string[] = [];
  for (const line of shape.logs) {
    const inv = PROGRAM_INVOKE_REGEX.exec(line);
    if (inv) { stack.push(inv[1]); continue; }
    if (PROGRAM_RESULT_REGEX.test(line)) { stack.pop(); continue; }
    // A Burn instruction log fires while its program sits at the top of the
    // invoke stack — count it only when that program is MPL Core.
    if (CORE_BURN_LOG_REGEX.test(line) && stack[stack.length - 1] === MPL_CORE_PROGRAM) {
      return true;
    }
  }
  return false;
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

/** Candy Guard mint needle — first-class targeted launchpad path,
 *  mirroring the LMNFT branches above. The launchpad fingerprint is
 *  Candy Guard's deployed program ID alone (same idea as LMNFT's
 *  outer program); CM v3 and Token Metadata serve as evidence that
 *  this particular Guard ix is a real mint we can extract a
 *  mintAddress from.
 *
 *  Gate (all required):
 *    1. `CANDY_GUARD_PROGRAM` in accountKeys — the launchpad
 *       fingerprint. Unspoofable: only Metaplex holds upgrade
 *       authority on this program.
 *    2. `TOKEN_METADATA_PROGRAM` OR `CANDY_MACHINE_V3_PROGRAM`
 *       in accountKeys — the standard-evidence anchor. Config /
 *       `Initialize` / `Update` / `Route` / `Set…` Guard ixs never
 *       reach into TM or CM v3, so this anchor rejects them.
 *    3. A `Program log: Instruction: Mint(V\d+)?` log line —
 *       Guard's Anchor mint handler family. Strict end-of-line so
 *       future `…WithRemainingAccounts` style suffix variants
 *       surface for explicit audit before silent acceptance.
 *    4. (caller) An extractable mintAddress via
 *       `extractTmMintFromInner` — if the inner TM Create CPI
 *       shape doesn't yield a mint slot the Guard hit is rejected
 *       in the dispatch with a `candyguard-skip` log line.
 *
 *  This deliberately does NOT require BOTH CM v3 + TM nor a strict
 *  exact-MintV2 log: Candy Guard already fronts non-CM mint paths
 *  and the strict 4-gate predecessor missed real mints. Spam
 *  guard is preserved by (a) the Guard program fingerprint, which
 *  random TM sales never carry, and (b) the mint-only log family
 *  + extractor success in the dispatch. */
const CG_MINT_LOG_REGEX = /^Program log: Instruction: (Mint|MintV\d+)$/;
function candyGuardNeedleIfPresent(shape: ParsedTxShape): string | null {
  if (!shape.accountKeys.includes(CANDY_GUARD_PROGRAM)) return null;
  if (!shape.accountKeys.includes(TOKEN_METADATA_PROGRAM)
      && !shape.accountKeys.includes(CANDY_MACHINE_V3_PROGRAM)) return null;
  for (const line of shape.logs) {
    const m = line.match(CG_MINT_LOG_REGEX);
    if (m) return `Instruction: ${m[1]}`;
  }
  return null;
}

/** nfts.gay platform fee wallet. Every nfts.gay-routed Candy Guard
 *  mint includes a top-level SystemProgram.transfer to this address
 *  immediately before the CG `MintV2` ix. Confirmed across 50/50
 *  sampled tx via getSignaturesForAddress on the treasury (all CG +
 *  CM + MintV2). Same fingerprint pattern as VVV's platform signer:
 *  account-key presence is unspoofable for the recipient slot of a
 *  System.transfer that the user wallet signed. */
const NFTS_GAY_TREASURY = 'DLVZkW7kreqQ54nqDAbGG4yvTQ42ujCzChWhfQXptWcc';
function isNftsGayCgTx(shape: ParsedTxShape): boolean {
  return shape.accountKeys.includes(NFTS_GAY_TREASURY);
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
  //
  // The mint-slot index depends on the TM `Create` variant in use,
  // identified by the first byte of the instruction data:
  //
  //    disc 0   CreateMetadataAccount    │ accs[0]=metadata accs[1]=MINT
  //    disc 16  CreateMetadataAccountV2  │ accs[0]=metadata accs[1]=MINT
  //    disc 33  CreateMetadataAccountV3  │ accs[0]=metadata accs[1]=MINT
  //    disc 42  Create (V1 / pNFT)       │ accs[0]=metadata accs[1]=master_edition accs[2]=MINT
  //
  // LMNFT MintTm routes through the legacy CreateMetadataAccountV3
  // family (slot 1). Candy Guard's MintV2 wraps the new pNFT
  // `Create` (disc=42) which puts the master edition at accs[1] and
  // the mint at accs[2] — reading accs[1] there would surface the
  // master-edition pubkey as the "mint", which DAS doesn't index
  // (every downstream `getAsset` returns `RecordNotFound`) and
  // collapses per-NFT enrichment for the entire flow.
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
      // Decode discriminator byte to pick the mint slot. Default to
      // slot 1 (legacy family) when the data is missing / undecodable.
      let mintSlot = 1;
      try {
        const data = Buffer.from(bs58.decode(ixAny.data));
        if (data.length > 0 && data[0] === 42) mintSlot = 2;
      } catch { /* default mintSlot=1 */ }
      if (accs.length > mintSlot
          && typeof accs[0]        === 'string'
          && typeof accs[mintSlot] === 'string') {
        metadataPDA = accs[0];
        mintAddress = accs[mintSlot];
      }
      break outer1;
    }
  }

  if (!mintAddress) return null;

  // Pass 2: locate the Verify CPI by discriminator + metadataPDA anchor.
  //
  // Both Verify and Mint have `metadata` in their account layouts, so
  // discriminator filtering is required to avoid reading the wrong slot.
  // Accept ONLY the verify-collection family; the account slot holding
  // the asset's metadata PDA (anchor) and the collection mint differ
  // per instruction:
  //
  //   disc 18  VerifyCollection              accs: [meta, auth, payer, collMint, …]
  //   disc 30  VerifySizedCollectionItem     accs: [meta, auth, payer, collMint, …]
  //   disc 25  SetAndVerifyCollection        accs: [meta, auth, payer, updAuth, collMint, …]
  //   disc 32  SetAndVerifySizedCollectionItem  accs: [meta, auth, payer, updAuth, collMint, …]
  //   disc 52  Verify (unified / CollectionV1)  accs: [auth, delegate?, meta, collMint, …]
  //
  // Each entry: [metadataPdaIdx, collMintIdx, minAccountsLen].
  // metadataPdaIdx anchors to THIS mint's metadata so a concurrent
  // verify for a different NFT in the same tx is not misread.
  const VERIFY_COLLECTION_IDX = new Map<number, readonly [number, number, number]>([
    [18, [0, 3, 4]],
    [30, [0, 3, 4]],
    [25, [0, 4, 5]],
    [32, [0, 4, 5]],
    [52, [2, 3, 4]],
  ]);
  if (metadataPDA) {
    outer2:
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
        let disc: number | null = null;
        try {
          const data = Buffer.from(bs58.decode(ixAny.data));
          if (data.length > 0) disc = data[0];
        } catch { /* leave disc=null → skip */ }
        const layout = disc !== null ? VERIFY_COLLECTION_IDX.get(disc) : undefined;
        if (!layout) continue;
        const [metaIdx, collIdx, minLen] = layout;
        const accs: string[] = (ixAny.accounts ?? []).map((a: number | string) =>
          typeof a === 'string' ? a : shape.accountKeys[a],
        );
        if (accs.length >= minLen
            && accs[metaIdx] === metadataPDA
            && typeof accs[collIdx] === 'string'
            && accs[collIdx] !== mintAddress) {
          collectionAddress = accs[collIdx];
          break outer2;
        }
      }
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
    let leafIdB58:  string | null = null;
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
        // The LeafSchema also carries the canonical asset `id` directly.
        try {
          leafIdB58 = new PublicKey(
            data.subarray(NOOP_LEAF_ID_OFFSET, NOOP_LEAF_ID_OFFSET + NOOP_LEAF_ID_LEN),
          ).toBase58();
        } catch { leafIdB58 = null; }
      }
    }
    if (merkleTree) {
      // Phantom guard: accept the asset id ONLY when the id read straight from
      // the LeafSchema event equals the id derived from (tree, nonce). They
      // agree iff both the id and nonce offsets are correct for this event
      // layout — so a future Bubblegum variant that shifts the bytes can never
      // again emit a fabricated, unresolvable asset id. On any mismatch /
      // missing field, assetId degrades to null (the row groups by tree, the
      // existing no-mint-anchor behaviour) instead of a phantom address.
      let assetId: string | null = null;
      if (leafIdB58 && nonceLe) {
        const derived = deriveCnftAssetId(merkleTree, nonceLe);
        if (derived && derived === leafIdB58) {
          assetId = derived;
        } else {
          console.log(
            `[mints/cnft-skip] reason=asset_id_mismatch tree=${merkleTree} ` +
            `leafId=${leafIdB58} derived=${derived ?? 'null'} sig=${tx.signature ?? '—'}`,
          );
        }
      }
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

  // PRNT mint-pass — checked first. Most specific gate in the file
  // (SPL722 vesting + Core Candy program + InitVesting log + same-tx
  // asset equality), so it can never steal a hit from the broader
  // branches below; conversely it wins over the generic Core Candy
  // Machine fallback in `ingestMintRaw` (which runs only after this
  // returns), relabelling these mints PRNT instead of `Metaplex Core`.
  const prntVestingAsset = prntVestingAssetIfPresent(shape);
  if (prntVestingAsset) {
    const core = extractCoreMintFromInner(tx, shape);
    if (!core) {
      // PRNT programs + InitVesting log present but no extractable Core
      // Create asset — treat as a parse miss, never a PRNT accept.
      console.log(
        `[mints/prnt-skip] sig=${tx.signature ?? '—'} reason=no_core_create vestingAsset=${prntVestingAsset}`,
      );
      return null;
    }
    if (core.mintAddress !== prntVestingAsset) {
      // False-positive guard: the vesting log names a DIFFERENT asset
      // than the Core Create. Not a PRNT mint-pass — reject outright
      // rather than mislabel an unrelated CMA mint that merely shared a
      // tx with a vesting init.
      console.log(
        `[mints/prnt-skip] sig=${tx.signature ?? '—'} reason=asset_mismatch ` +
        `coreAsset=${core.mintAddress} vestingAsset=${prntVestingAsset}`,
      );
      return null;
    }
    console.log(
      `[mints/prnt] sig=${tx.signature ?? '—'} mint=${core.mintAddress} ` +
      `collection=${core.collectionAddress ?? 'null'} minter=${shape.signerKeys[0] ?? 'null'}`,
    );
    return {
      source:            'PRNT',
      standard:          'core',
      mintAddress:       core.mintAddress,
      collectionAddress: core.collectionAddress,
      minter:            shape.signerKeys[0] ?? null,
      matchedNeedle:     'Instruction: InitVesting',
    };
  }

  const lmnftCoreNeedle = lmnftCoreNeedleIfPresent(shape);
  if (lmnftCoreNeedle) {
    if (hasCoreBurn(shape)) {
      // Burn + create in the same tx → LMNFT migration / claim, not a
      // fresh mint. Reject so it never reaches the Mint Tracker.
      console.log(
        `[mints/lmnft-core-skip] sig=${tx.signature ?? '—'} reason=burn_remint coreIx=${lmnftCoreNeedle}`,
      );
      return null;
    }
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
  // LMNFT Core collection-DEPLOY (CreateCollection / CreateCollectionV1).
  // Checked AFTER the asset-mint needle so a lazy-create-on-first-mint tx
  // (carrying both a CreateV2 asset and a CreateCollection) is still treated
  // as a mint. A deploy-only tx mints no asset → surfaces as a distinct
  // COLLECTION_CREATE hit with the created collection as collectionAddress and
  // the update authority as the deployer/minter (never the reverse).
  const lmnftColCreateNeedle = lmnftCoreCollectionCreateNeedle(shape);
  if (lmnftColCreateNeedle) {
    const cc = extractCoreCollectionCreate(tx, shape);
    if (cc) {
      console.log(
        `[mints/lmnft-collection-create] sig=${tx.signature ?? '—'} coreIx=${lmnftColCreateNeedle} ` +
        `collection=${cc.collectionAddress} deployer=${cc.deployer ?? 'null'}`,
      );
      return {
        source:            'LaunchMyNFT',
        standard:          'core',
        mintAddress:       null,
        collectionAddress: cc.collectionAddress,
        minter:            cc.deployer ?? shape.signerKeys[0] ?? null,
        matchedNeedle:     lmnftColCreateNeedle,
        collectionCreate:  true,
      };
    }
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
  // Candy Guard — first-class targeted detector. Single program
  // fingerprint (Candy Guard) + TM / CM v3 evidence + a Mint-family
  // log; mirrors the LMNFT branches above. Runs AFTER the LMNFT TM
  // branch so an (unlikely) tx carrying both LMNFT outer + Candy
  // Guard outer would resolve as LMNFT — older detector wins for
  // backwards compat. Reuses `extractTmMintFromInner`: the inner TM
  // Create CPI shape is identical regardless of which launchpad
  // wrapped it.
  const cgNeedle = candyGuardNeedleIfPresent(shape);
  if (cgNeedle) {
    const tm = extractTmMintFromInner(tx, shape);
    if (!tm) {
      console.log(
        `[mints/candyguard-skip] sig=${tx.signature ?? '—'} reason=no_tm_create needle=${cgNeedle}`,
      );
      return null;
    }
    // Pull the candy_machine state pubkey from the outer CG MintV2
    // ix. Layout: accs[0]=candy_guard, accs[1]=candy_machine_program,
    // accs[2]=candy_machine (state). Pubkey is unspoofable since the
    // outer ix only succeeds when the program CPIs into this exact
    // state account; we forward it to the supply resolver in
    // `ingestMintRaw` for items_redeemed / items_available decode.
    const candyMachineState = extractCandyMachineState(tx, shape);
    // nfts.gay carve-out: routes through Candy Guard like a standard
    // CMv3 drop, but every mint co-pays a top-level SystemProgram fee
    // to the nfts.gay treasury. Re-label as 'NftsGay' so the UI badge
    // reads GAY instead of CANDY; supply / state extraction path is
    // unchanged. Normal CG drops without the treasury stay
    // `CandyMachine`.
    const isGay = isNftsGayCgTx(shape);
    const source: LaunchpadSource = isGay ? 'NftsGay' : 'CandyMachine';
    console.log(
      `[mints/candyguard] sig=${tx.signature ?? '—'} mint=${tm.mintAddress} ` +
      `collection=${tm.collectionAddress ?? 'null'} ` +
      `minter=${shape.signerKeys[0] ?? 'null'} needle=${cgNeedle} ` +
      `cmState=${candyMachineState ?? 'null'} source=${source}`,
    );
    return {
      source,
      standard:          'token_metadata',
      mintAddress:       tm.mintAddress,
      collectionAddress: tm.collectionAddress,
      minter:            shape.signerKeys[0] ?? null,
      matchedNeedle:     `${cgNeedle} (Candy Guard${isGay ? ' / nfts.gay' : ''})`,
      candyMachineState,
    };
  }
  return null;
}

/** Pull the candy_machine state pubkey from the outer Candy Guard
 *  MintV2 ix. The CG `MintV2` account layout (Metaplex
 *  mpl-candy-guard) puts `candy_guard` at accs[0],
 *  `candy_machine_program` at accs[1], and the candy_machine state
 *  PDA at accs[2]. Top-level scan only — Candy Guard is always the
 *  outer ix in observed CG mints. Null when the layout doesn't match
 *  (defensive — caller skips the supply resolver in that case). */
function extractCandyMachineState(tx: RawSolanaTx, shape: ParsedTxShape): string | null {
  const message = tx.transaction?.message;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const top = (message as any)?.instructions as Array<{ programIdIndex?: number; programId?: string; accounts?: Array<number | string> }> | undefined;
  if (!Array.isArray(top)) return null;
  for (const ix of top) {
    const programId = typeof ix.programId === 'string'
      ? ix.programId
      : typeof ix.programIdIndex === 'number'
        ? shape.accountKeys[ix.programIdIndex]
        : '';
    if (programId !== CANDY_GUARD_PROGRAM) continue;
    const accs = (ix.accounts ?? []).map(a => typeof a === 'string' ? a : shape.accountKeys[a]);
    if (accs.length < 3) return null;
    if (accs[1] !== CANDY_MACHINE_V3_PROGRAM) return null;
    return typeof accs[2] === 'string' ? accs[2] : null;
  }
  return null;
}

/** Same extraction as `extractCandyMachineState` above, for the MPL Core
 *  Candy Guard family (Core Candy Guard `CMAGAK…` → Core Candy Machine
 *  `CMACYFEN…`) instead of the legacy Token Metadata Candy Guard. Same
 *  account-order guarantee (candy_guard @0, candy_machine_program @1,
 *  candy_machine state @2 on the top-level ix — verified against the
 *  Umi SDK's own generated `MintV1InstructionAccounts` and a real landed
 *  tx, see candy-mint tool's decode.ts), different program ids.
 *
 *  This was missing entirely — the generic Core Candy Machine mint path
 *  (`detectCoreCandyMachineMint` in core-v2-detector.ts) only checks that
 *  the Core Candy Machine PROGRAM participated somewhere in the tx, never
 *  resolved the drop-specific STATE account, so the /mints supply
 *  cell's cap (maxSupply) was never populated for any Core Candy Machine
 *  drop (confirmed: zero `[mints/candyguard-supply]` log lines ever,
 *  despite Core Candy Machine being the single most common /mints
 *  sourceLabel in the live feed). Exported so index.ts's Core Candy
 *  Machine branch can resolve the same supply-check state address the
 *  legacy Candy Guard path already does. */
export function extractCoreCandyMachineState(tx: RawSolanaTx): string | null {
  const shape = readTxShape(tx);
  if (!shape) return null;
  const message = tx.transaction?.message;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const top = (message as any)?.instructions as Array<{ programIdIndex?: number; programId?: string; accounts?: Array<number | string> }> | undefined;
  if (!Array.isArray(top)) return null;
  for (const ix of top) {
    const programId = typeof ix.programId === 'string'
      ? ix.programId
      : typeof ix.programIdIndex === 'number'
        ? shape.accountKeys[ix.programIdIndex]
        : '';
    if (programId !== PRNT_CORE_CANDY_GUARD) continue;
    const accs = (ix.accounts ?? []).map(a => typeof a === 'string' ? a : shape.accountKeys[a]);
    if (accs.length < 3) return null;
    if (accs[1] !== PRNT_CORE_CANDY_MACHINE) return null;
    return typeof accs[2] === 'string' ? accs[2] : null;
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
