/**
 * Direct MPL Core CreateV2 fallback detector.
 *
 * Feature-flagged via `MINT_TRACKER_CORE_V2_SCORER=1` and wired into
 * `ingestMintRaw` ONLY after the existing LMNFT/vvv targeted detector
 * returns null. Goal: improve /mints coverage for direct Core CreateV2
 * mints (vvv-like flows without the vvv platform signer) without
 * touching production behaviour by default.
 *
 * Pure-read: no side effects, no enqueues, no recordMint. The caller
 * decides what to do with an accept verdict.
 *
 * Scoring is intentionally conservative: hard-reject any DeFi/pool
 * program before doing any work, require a real (non-placeholder)
 * collection slot, require the asset account to be freshly created,
 * and require a real (https / ipfs / arweave / shadow-drive) URI.
 * Plugin presence and trusted-host hits are bonuses, not gates.
 *
 * Reference accept fixture (currently missed by targeted mode):
 *   2MweizR9LJUhiou1Qu91fCsuW6G1BDgmxz6EsaVG8nxKw9SpNyvSdNAf1H6Xw6JCq2zBxTsvNXeZhSarB35NMEMu
 */
import bs58 from 'bs58';
import type { RawSolanaTx } from '../me-raw/types';
import { MPL_CORE_PROGRAM } from './launchpad-detector';
import {
  TOKEN_METADATA_PROGRAM,
  TOKEN_AUTH_RULES_PROGRAM,
  SPL_TOKEN_PROGRAM,
  ATA_PROGRAM,
  LUCKY_BUY_PROGRAM,
} from '../me-raw/programs';

// ─── DeFi / pool program hard-rejects ─────────────────────────────────────
//
// Any tx that touches one of these accounts is rejected before we do
// any decoding work. CreateV2 is occasionally emitted inside DEX /
// AMM / LP txs (e.g. when a pool authority happens to mint a position
// NFT through Core); those are not NFT drops and must not surface in
// /mints. Curated; extend as new false positives are observed.
export const DEFI_PROGRAM_BLACKLIST: ReadonlySet<string> = new Set([
  // Meteora DLMM
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo',
  // Meteora DAMM v1 (Dynamic Pools)
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB',
  // Meteora DAMM v2
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG',
  // Orca Whirlpools
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc',
  // Raydium AMM v4
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  // Raydium CLMM
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  // Raydium CP-Swap
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
  // Pump AMM
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA',
  // Pump.fun
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P',
]);

/** SPL Token-2022 program. Out of scope for /mints (Core / pNFT /
 *  legacy all run on the original SPL Token program); explicit reject
 *  rather than rely on prefilters elsewhere. */
const TOKEN_2022_PROGRAM = 'TokenzQdBNbLqP5VEUNnHNEoA1YtbRuVvYr7fXMxHEy';

/** Core CreateV2 instruction discriminator — first byte of the ix
 *  data, also documented in the `mpl-core` IDL. Matches the
 *  `Program log: Instruction: CreateV2` we already gate on. */
const CORE_CREATE_V2_DISC = 20;

/** mpl-core `Create` (V1) instruction discriminator. The MPL **Core** Candy
 *  Machine mints assets via this (logs `Instruction: Create`), not CreateV2. */
const CORE_CREATE_V1_DISC = 0;

/** Discriminators that create a Core asset — either form. Used by the Core
 *  Candy Machine detector below (CMv3-core emits the V1 `Create`). */
const CORE_CREATE_DISCS: ReadonlySet<number> = new Set([CORE_CREATE_V1_DISC, CORE_CREATE_V2_DISC]);

/** MPL **Core** Candy Machine + Candy Guard program ids. These are DISTINCT
 *  from the legacy Token-Metadata candy machine (`CndyV3…`) and the legacy
 *  candy guard (`Guard1Jw…`) the targeted detector / `candy_guard` WS target
 *  already cover. A modern CMv3-core mint chains:
 *    Core Candy Guard (CMAGAK, MintV1) → Core Candy Machine (CMACYFEN,
 *    MintAsset) → mpl-core Create — and many launchpads wrap that chain.
 *  The candy-machine program lands in `accountKeys` at any CPI depth, so its
 *  presence is the robust trigger for direct / guard / wrapper variants. */
const CORE_CANDY_MACHINE_PROGRAM = 'CMACYFENjoBMHzapRXyo1JZkVS6EtaDDzkjMrmQLvr4J';
const CORE_CANDY_GUARD_PROGRAM   = 'CMAGAKJ67e9hRZgfC5SFTbZH8MgEmtqazKXjmkaJjWTJ';
void CORE_CANDY_GUARD_PROGRAM; // referenced for documentation; detection keys on the machine

/** Magic Eden launchpad program. Fronts an MPL Core mint: the ME program
 *  (`CMZYPASG…`) CPIs into mpl-core `Create` (V1, disc 0) to build the asset.
 *  Distinct from the Core Candy Machine (`CMACYFEN…`) path and NOT recognized
 *  by the targeted launchpad detector, so without a dedicated branch these
 *  mints reject as `unknown_launchpad` and never reach the Mint Tracker.
 *  The program id lands in `accountKeys` and the tx also mentions MPL Core, so
 *  it arrives via the existing mpl_core WS/poll — no new subscription needed.
 *  Reference tx:
 *    4Tg4BrFXFrSzzEYqvaXEa2TaMJahydbnfiuofedsyCNr4uBtT31q5oKYSyapRC4ijLGg44fU1dR3i6SnmW76akoN
 *    (asset 24oYx…, inner mpl-core Create disc=0, collection HxSsfM9… "Quack Heads"). */
export const MAGIC_EDEN_LAUNCHPAD_PROGRAM = 'CMZYPASGWeTz7RNGHaRJfCq2XQ5pYK6nDvVQxzkH51zb';
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/** Magic Eden "reward" wrapper programs. Gamified flows (Lucky Buy, `LUCK57…`)
 *  that CPI into mpl-core to mint a consolation/reward asset into an ME-owned
 *  reward collection — NOT a real paid collection drop. A Core mint wrapped by
 *  one of these is a reward/claim, so the generic Core fallback rejects it
 *  (`magic_eden_lucky_buy_reward`) rather than surfacing it in /mints. Distinct
 *  from MAGIC_EDEN_LAUNCHPAD_PROGRAM (`CMZYPASG…`), which IS a real launchpad
 *  and stays accepted via its dedicated detector. Extend as new ME reward
 *  wrappers are observed. */
const ME_REWARD_WRAPPER_PROGRAMS: ReadonlySet<string> = new Set([
  LUCKY_BUY_PROGRAM,
]);

/** Agent-identity registry programs. `RegisterIdentityV1` (`1DREGFgy…`) mints
 *  an on-demand "agent identity" Core asset — a utility/identity NFT, NOT a
 *  curated collection drop. It runs both standalone and behind front-ends like
 *  aign.fun (`ANUK3r5…`), so it's keyed on the INVOKED identity program — the
 *  semantic root marker — rather than any one wrapper. A Core mint that invokes
 *  one is rejected (`agent_identity_mint`), same mechanism as the ME-reward
 *  reject. NOT a price/free filter; NOT keyed on aign.fun alone. Extend as new
 *  identity-registry programs are observed. */
const AGENT_IDENTITY_PROGRAMS: ReadonlySet<string> = new Set([
  '1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p',
]);

/** Trusted NFT metadata host fragments. Matched substring-style on
 *  the parsed URI (lowercased). Conservative bonus, not a gate. */
const TRUSTED_URI_HOST_HINTS: readonly string[] = [
  'ipfs://',
  'ar://',
  '.ipfs.',
  'arweave.net',
  'nft.storage',
  'w3s.link',
  'pinata.cloud',
  'mypinata.cloud',
  'shdw-drive.genesysgo.net',
  'shadow-drive',
];

/** Names / URIs that strongly indicate non-NFT (LP position, pool
 *  receipt). Case-insensitive substring match. */
const NEGATIVE_NAME_PATTERNS: readonly string[] = [
  'lp position',
  'lp-position',
  'liquidity position',
  'pool position',
  'lp receipt',
  'meteora',
  'whirlpool',
  'orca lp',
  'raydium lp',
];

/** Result of a Core CreateV2 candidate evaluation. Always returned
 *  (even on reject) so the caller can emit one audit-log line per tx
 *  the flag touches. `accept === true` is the only case the caller
 *  acts on; everything else is observational. */
export interface CoreV2Detection {
  accept:            boolean;
  score:             number;
  reasons:           string[];
  rejectReason:      string | null;
  mintAddress:       string | null;
  collectionAddress: string | null;
  minter:            string | null;
  name:              string | null;
  uri:               string | null;
  pluginsCount:      number | null;
  /** Set only by `detectGenericCoreLaunchpadMint` — the non-primitive custom
   *  wrapper program that CPI'd into mpl-core Create. Lets the caller
   *  special-case a known-but-unenumerated wrapper's display label (e.g.
   *  Candy Labs → 'LABS') without a dedicated tx-shape detector. */
  wrapperProgramId?: string | null;
}

export interface TxShape {
  accountKeys: string[];
  signerKeys:  string[];
  preBalances:  number[];
  postBalances: number[];
}

export function readShape(tx: RawSolanaTx): TxShape | null {
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const loaded = (tx.meta as any)?.loadedAddresses as { writable?: string[]; readonly?: string[] } | undefined;
  if (loaded?.writable) for (const k of loaded.writable) accountKeys.push(k);
  if (loaded?.readonly) for (const k of loaded.readonly) accountKeys.push(k);
  const preBalances  = Array.isArray(tx.meta?.preBalances)  ? (tx.meta!.preBalances  as number[]) : [];
  const postBalances = Array.isArray(tx.meta?.postBalances) ? (tx.meta!.postBalances as number[]) : [];
  return { accountKeys, signerKeys, preBalances, postBalances };
}

/** Parse the relevant prefix of a CreateV2 ix payload. Returns null
 *  if the discriminator doesn't match OR the buffer is too short for
 *  the required string lengths. We stop after `plugins.length` —
 *  walking individual plugin variants would require a full
 *  PluginAuthorityPair Borsh implementation and is not needed for
 *  the conservative score. */
interface CreateV2ParsedArgs {
  name:         string;
  uri:          string;
  pluginsCount: number;
}
function parseCreateV2Args(dataB58: string): CreateV2ParsedArgs | null {
  let buf: Buffer;
  try { buf = Buffer.from(bs58.decode(dataB58)); } catch { return null; }
  if (buf.length < 1) return null;
  if (buf[0] !== CORE_CREATE_V2_DISC) return null;
  let off = 1;
  if (off + 1 > buf.length) return null;
  off += 1;                                       // dataState (u8)
  if (off + 4 > buf.length) return null;
  const nameLen = buf.readUInt32LE(off); off += 4;
  if (nameLen > 256 || off + nameLen > buf.length) return null;
  const name = buf.slice(off, off + nameLen).toString('utf8'); off += nameLen;
  if (off + 4 > buf.length) return null;
  const uriLen = buf.readUInt32LE(off); off += 4;
  if (uriLen > 2048 || off + uriLen > buf.length) return null;
  const uri = buf.slice(off, off + uriLen).toString('utf8'); off += uriLen;
  let pluginsCount = 0;
  if (off + 1 <= buf.length) {
    const opt = buf[off]; off += 1;
    if (opt === 1 && off + 4 <= buf.length) {
      pluginsCount = buf.readUInt32LE(off);
      // Sanity bound — plugin vectors with > 64 entries are not seen
      // in legit Core mints; clamp to avoid believing a misdecode.
      if (pluginsCount > 64) pluginsCount = 0;
    }
  }
  return { name, uri, pluginsCount };
}

interface FoundCreateV2 {
  accounts: number[];
  dataB58:  string;
  viaInner: boolean;
}
function findCreateV2Ix(
  tx: RawSolanaTx,
  accountKeys: string[],
  discSet: ReadonlySet<number> = new Set([CORE_CREATE_V2_DISC]),
): FoundCreateV2 | null {
  const message = tx.transaction?.message;
  if (!message) return null;
  const isCreateV2 = (programId: string, dataB58: string): boolean => {
    if (programId !== MPL_CORE_PROGRAM) return false;
    // Cheap discriminator pre-check before full bs58 decode: base58
    // disc=20 always starts with one of a small set of glyphs. We
    // decode anyway for accuracy — bs58 of a single byte is 2 chars.
    try {
      const buf = Buffer.from(bs58.decode(dataB58));
      return buf.length >= 1 && discSet.has(buf[0]);
    } catch { return false; }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const top = (message as any).instructions as Array<{ programIdIndex?: number; programId?: string; accounts?: Array<number | string>; data?: string }> | undefined;
  if (Array.isArray(top)) {
    for (const ix of top) {
      const programId = typeof ix.programId === 'string'
        ? ix.programId
        : typeof ix.programIdIndex === 'number'
          ? accountKeys[ix.programIdIndex]
          : '';
      const dataB58 = typeof ix.data === 'string' ? ix.data : '';
      if (!dataB58) continue;
      if (!isCreateV2(programId, dataB58)) continue;
      const accs = (ix.accounts ?? []).map(a => typeof a === 'number' ? a : accountKeys.indexOf(a));
      return { accounts: accs, dataB58, viaInner: false };
    }
  }
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
            ? accountKeys[ixAny.programIdIndex]
            : '';
        const dataB58: string = typeof ixAny.data === 'string' ? ixAny.data : '';
        if (!dataB58) continue;
        if (!isCreateV2(programId, dataB58)) continue;
        const accs: number[] = (ixAny.accounts ?? []).map((a: number | string) =>
          typeof a === 'number' ? a : accountKeys.indexOf(a),
        );
        return { accounts: accs, dataB58, viaInner: true };
      }
    }
  }
  return null;
}

function uriIsTrusted(uri: string): boolean {
  const u = uri.toLowerCase();
  for (const h of TRUSTED_URI_HOST_HINTS) {
    if (u.includes(h)) return true;
  }
  return false;
}

function uriShapeOk(uri: string): boolean {
  if (!uri) return false;
  if (uri.length < 8) return false;
  return /^(https?:\/\/|ipfs:\/\/|ar:\/\/)/i.test(uri);
}

export function nameLooksLikePool(name: string, uri: string): boolean {
  const haystack = `${name}\n${uri}`.toLowerCase();
  for (const p of NEGATIVE_NAME_PATTERNS) {
    if (haystack.includes(p)) return true;
  }
  return false;
}

export function isFresh(shape: TxShape, address: string): boolean {
  const idx = shape.accountKeys.indexOf(address);
  if (idx < 0) return false;
  const pre  = shape.preBalances[idx];
  const post = shape.postBalances[idx];
  if (typeof pre !== 'number' || typeof post !== 'number') return false;
  return pre === 0 && post > 0;
}

/** Conservative Core CreateV2 fallback detector. Returns null when
 *  no CreateV2 ix is present at all (the common case — caller should
 *  treat as a no-op). Returns a populated `CoreV2Detection` otherwise,
 *  with `accept` set per the scoring rules below.
 *
 *  Scoring rules:
 *    Hard reject (returns accept=false immediately):
 *      - any account key in DEFI_PROGRAM_BLACKLIST
 *      - Token-2022 program present in account keys
 *      - CreateV2 ix data fails to Borsh-decode
 *      - asset account (accounts[0]) cannot be resolved
 *      - accounts[1] is the Core program placeholder (no collection)
 *      - asset account was NOT freshly created (pre>0 or pre===post)
 *      - URI is empty / not http(s)/ipfs/ar
 *      - name / uri match a pool-receipt pattern
 *    Bonuses (additive to a base score of 1 for "valid CreateV2"):
 *      +1 plugin vector has at least one entry
 *      +1 URI host matches a trusted NFT metadata CDN
 *      +1 collection address is a different account than the asset
 *  Accept threshold: score >= 2.
 *
 *  The lowest possible accept score therefore still requires:
 *    valid CreateV2 + non-placeholder collection + fresh asset +
 *    real URI shape + (trusted host OR plugin presence). */
export function detectCoreCreateV2NftCandidate(tx: RawSolanaTx): CoreV2Detection | null {
  const shape = readShape(tx);
  if (!shape) return null;
  if (!shape.accountKeys.includes(MPL_CORE_PROGRAM)) return null;

  // Hard reject before any further work — pool-position / DEX-LP txs
  // occasionally emit CreateV2 and would otherwise score high.
  for (const k of shape.accountKeys) {
    if (DEFI_PROGRAM_BLACKLIST.has(k)) {
      return {
        accept: false, score: 0, reasons: [],
        rejectReason: 'defi_program_present',
        mintAddress: null, collectionAddress: null, minter: null,
        name: null, uri: null, pluginsCount: null,
      };
    }
  }
  if (shape.accountKeys.includes(TOKEN_2022_PROGRAM)) {
    return {
      accept: false, score: 0, reasons: [],
      rejectReason: 'token_2022_present',
      mintAddress: null, collectionAddress: null, minter: null,
      name: null, uri: null, pluginsCount: null,
    };
  }

  const found = findCreateV2Ix(tx, shape.accountKeys);
  if (!found) return null;

  const args = parseCreateV2Args(found.dataB58);
  if (!args) {
    return {
      accept: false, score: 0, reasons: [],
      rejectReason: 'borsh_decode_failed',
      mintAddress: null, collectionAddress: null, minter: null,
      name: null, uri: null, pluginsCount: null,
    };
  }

  const accIxs = found.accounts;
  const asset      = accIxs.length > 0 && accIxs[0] >= 0 ? shape.accountKeys[accIxs[0]] ?? null : null;
  const collection = accIxs.length > 1 && accIxs[1] >= 0 ? shape.accountKeys[accIxs[1]] ?? null : null;
  // CreateV2 account layout (when all optionals are Some):
  //   [0] asset, [1] collection, [2] authority (signer, optional),
  //   [3] payer (signer), [4] owner (optional), [5] updateAuthority,
  //   [6] systemProgram, [7] logWrapper
  // Payer is the first writable signer at index 3 in the dense case;
  // for safety we fall back to signerKeys[0] (transaction fee payer).
  const minter = shape.signerKeys[0] ?? null;

  if (!asset) {
    return {
      accept: false, score: 0, reasons: [],
      rejectReason: 'no_asset_account',
      mintAddress: null, collectionAddress: null, minter,
      name: args.name, uri: args.uri, pluginsCount: args.pluginsCount,
    };
  }

  const reasons: string[] = ['core_create_v2'];
  let score = 1;
  let rejectReason: string | null = null;

  // Hard requirements past the basic ix-shape check.
  const hasRealCollection = !!collection && collection !== MPL_CORE_PROGRAM && collection !== asset;
  if (!hasRealCollection) {
    rejectReason = 'no_collection';
  } else if (!isFresh(shape, asset)) {
    rejectReason = 'asset_not_fresh';
  } else if (!uriShapeOk(args.uri)) {
    rejectReason = 'bad_uri_shape';
  } else if (nameLooksLikePool(args.name, args.uri)) {
    rejectReason = 'pool_like_name';
  }

  if (rejectReason) {
    return {
      accept: false, score, reasons, rejectReason,
      mintAddress: asset, collectionAddress: collection,
      minter, name: args.name, uri: args.uri, pluginsCount: args.pluginsCount,
    };
  }

  // Agent-identity registry reject — same fingerprint as the generic Core
  // fallback. A `RegisterIdentityV1` (`1DREGFgy…`) mint reaches us here when its
  // asset is created via CreateV2 (not the direct `Create` the generic fallback
  // sees), so without this gate it would score and surface as a launchpad mint.
  // Keyed on the identity program being INVOKED, after the real-mint gates pass.
  const invoked = collectInvokedPrograms(tx, shape.accountKeys);
  for (const p of invoked) {
    if (AGENT_IDENTITY_PROGRAMS.has(p)) {
      return {
        accept: false, score, reasons, rejectReason: 'agent_identity_mint',
        mintAddress: asset, collectionAddress: collection,
        minter, name: args.name, uri: args.uri, pluginsCount: args.pluginsCount,
      };
    }
  }

  // Score bonuses — collection presence is already required above so
  // its bonus is effectively baseline, but emitted as a reason for
  // log auditability.
  reasons.push('collection_present');
  score += 1;
  if (args.pluginsCount > 0) { reasons.push('has_plugins');     score += 1; }
  if (uriIsTrusted(args.uri)) { reasons.push('trusted_uri_host'); score += 1; }

  const accept = score >= 2;
  return {
    accept,
    score,
    reasons,
    rejectReason: accept ? null : 'score_below_threshold',
    mintAddress:       asset,
    collectionAddress: collection,
    minter,
    name:              args.name,
    uri:               args.uri,
    pluginsCount:      args.pluginsCount,
  };
}

/** "Primitive" / infrastructure programs — the building blocks every mint
 *  composes from, plus the launchpad/candy programs that have their OWN
 *  dedicated detectors above. A tx whose only invoked programs are these is
 *  either a bare direct mint (handled by the v2 scorer) or a known launchpad
 *  (handled earlier) — NOT an unknown custom launchpad. The generic fallback
 *  below requires at least one invoked program OUTSIDE this set (the custom
 *  wrapper) before it will accept, so it never fires on a plain direct
 *  CreateV2 and never poaches a tx a dedicated detector already owns. */
const COMPUTE_BUDGET_PROGRAM = 'ComputeBudget111111111111111111111111111111';
const NOOP_PROGRAM_ID        = 'noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV';
const MEMO_V1_PROGRAM        = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo';
const MEMO_V2_PROGRAM        = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
// Native signature-verification programs. They appear in many txs that carry a
// signed allowlist / proof payload (ME Lucky Buy, gated mints, …) and are NOT
// launchpads — so they must not satisfy the "custom wrapper" gate, or a bare
// direct mint with an ed25519 proof would be misread as a launchpad mint.
const ED25519_SIGVERIFY_PROGRAM = 'Ed25519SigVerify111111111111111111111111111';
const SECP256K1_PROGRAM         = 'KeccakSecp256k11111111111111111111111111111';
const CANDY_MACHINE_V3_PROGRAM = 'CndyV3LdqHUfDLmE5naZjVN8rBZz4tqhdefbAnjHG3JR';
const CANDY_GUARD_PROGRAM       = 'Guard1JwRhJkVH6XZhzoYxeBVQe872VH6QggF4BWmS9g';
const BUBBLEGUM_PROGRAM         = 'BGUMAp9Gq7iTEuizy4pqaxsTyUCBK68MDfK752saRPUY';
const PRIMITIVE_PROGRAMS: ReadonlySet<string> = new Set([
  MPL_CORE_PROGRAM,
  TOKEN_METADATA_PROGRAM,
  TOKEN_AUTH_RULES_PROGRAM,
  SPL_TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  ATA_PROGRAM,
  SYSTEM_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
  NOOP_PROGRAM_ID,
  MEMO_V1_PROGRAM,
  MEMO_V2_PROGRAM,
  ED25519_SIGVERIFY_PROGRAM,
  SECP256K1_PROGRAM,
  // Known launchpad / candy programs — each has its own detector above, so
  // they must not count as the "custom wrapper" that arms the generic path.
  CORE_CANDY_MACHINE_PROGRAM,
  CORE_CANDY_GUARD_PROGRAM,
  MAGIC_EDEN_LAUNCHPAD_PROGRAM,
  CANDY_MACHINE_V3_PROGRAM,
  CANDY_GUARD_PROGRAM,
  BUBBLEGUM_PROGRAM,
]);

/** Collect every program id actually INVOKED by the tx (top-level + inner
 *  instructions), resolved through `accountKeys` for the raw-json index form.
 *  Used to decide whether a custom (non-primitive) wrapper program is driving
 *  the mint. Account keys that merely appear as instruction operands are NOT
 *  counted — only program ids of real instructions. */
function collectInvokedPrograms(tx: RawSolanaTx, accountKeys: string[]): Set<string> {
  const out = new Set<string>();
  const resolve = (ix: { programId?: string; programIdIndex?: number }): string => {
    if (typeof ix.programId === 'string') return ix.programId;
    if (typeof ix.programIdIndex === 'number') return accountKeys[ix.programIdIndex] ?? '';
    return '';
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const message = (tx.transaction?.message as any) ?? {};
  const top = Array.isArray(message.instructions) ? message.instructions : [];
  for (const ix of top) { const p = resolve(ix); if (p) out.add(p); }
  const inner = tx.meta?.innerInstructions;
  if (Array.isArray(inner)) {
    for (const grp of inner) {
      if (!Array.isArray(grp.instructions)) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const ix of grp.instructions as any[]) { const p = resolve(ix); if (p) out.add(p); }
    }
  }
  return out;
}

/** Generic UNKNOWN custom-launchpad MPL Core fallback.
 *
 *  Last-resort Core mint detector, run ONLY after the targeted launchpad
 *  detector, the Magic Eden detector, AND the Core Candy Machine detector
 *  have all missed (see `ingestMintRaw`). Goal: track the long tail of
 *  custom launchpad programs that CPI into mpl-core `Create`/`CreateV2`
 *  without us having to enumerate each wrapper program id.
 *
 *  This intentionally does NOT key on any specific wrapper program. Instead
 *  it proves the tx is a real Core NFT mint driven by *some* custom program:
 *    - MPL Core present
 *    - an mpl-core Create (disc 0) or CreateV2 (disc 20) ix exists
 *    - asset = create.accounts[0], freshly created in THIS tx (lamports 0→>0)
 *    - collection = create.accounts[1], real (≠ null / asset / system / Core)
 *    - at least one invoked program is a non-primitive custom wrapper
 *      (i.e. not bare-direct-mint, not a program a dedicated detector owns)
 *  Hard rejects: DeFi/AMM blacklist present, Token-2022 present, no fresh
 *  asset (transfer/sale-only txs have no fresh Create), no real collection.
 *
 *  Returns null when MPL Core or a create-ix is absent, or when no custom
 *  wrapper is involved (caller falls through to the v2 scorer / reject).
 *  Reference accept: 5UsaHCoHZQFgJiS62uE82t9La6wLmoEn3zRcLcvifctTQrSCza3mzJoJo6E4TcrpDxjxqzqrTyypeKscWH39GRzf
 *  (wrapper 22NeePs5…, inner mpl-core Create disc=0, collection 7c3tY7n… "little swag figures2"). */
export function detectGenericCoreLaunchpadMint(tx: RawSolanaTx): CoreV2Detection | null {
  const shape = readShape(tx);
  if (!shape) return null;
  if (!shape.accountKeys.includes(MPL_CORE_PROGRAM)) return null;

  const rej = (rejectReason: string, mint: string | null = null, collection: string | null = null): CoreV2Detection => ({
    accept: false, score: 0, reasons: ['generic_core_launchpad'], rejectReason,
    mintAddress: mint, collectionAddress: collection, minter: shape.signerKeys[0] ?? null,
    name: null, uri: null, pluginsCount: null,
  });

  for (const k of shape.accountKeys) {
    if (DEFI_PROGRAM_BLACKLIST.has(k)) return rej('defi_program_present');
  }
  if (shape.accountKeys.includes(TOKEN_2022_PROGRAM)) return rej('token_2022_present');

  // Must be an actual Core mint — a fresh asset built by an inner/top
  // mpl-core Create (disc 0) or CreateV2 (disc 20). Transfer / sale-only
  // txs carry no such create ix, so this also satisfies the
  // "reject obvious transfer/sale-only tx" requirement.
  const found = findCreateV2Ix(tx, shape.accountKeys, CORE_CREATE_DISCS);
  if (!found) return null;

  const accIxs = found.accounts;
  const asset      = accIxs.length > 0 && accIxs[0] >= 0 ? shape.accountKeys[accIxs[0]] ?? null : null;
  const collection = accIxs.length > 1 && accIxs[1] >= 0 ? shape.accountKeys[accIxs[1]] ?? null : null;
  const minter     = shape.signerKeys[0] ?? null;
  if (!asset) return rej('no_asset_account', null, collection);

  const hasRealCollection = !!collection
    && collection !== MPL_CORE_PROGRAM
    && collection !== asset
    && collection !== SYSTEM_PROGRAM;
  if (!hasRealCollection) return rej('no_collection', asset, collection);
  if (!isFresh(shape, asset)) return rej('asset_not_fresh', asset, collection);

  // Programs actually invoked by the tx — drives both the ME-reward reject and
  // the custom-wrapper gate below.
  const invoked = collectInvokedPrograms(tx, shape.accountKeys);

  // Magic Eden Lucky Buy reward/claim reject. Lucky Buy (`LUCK57…`) is a
  // gamified "spin" that CPIs into mpl-core to mint a consolation/reward asset
  // into an ME reward collection (e.g. "Lucky Emmy" 9BSPDYd…) — not a real paid
  // collection drop. Such a tx otherwise passes every gate above (real fresh
  // Core mint into a real collection; Lucky Buy is the non-primitive wrapper),
  // so it would surface in /mints. Reject it here, keyed on the ME reward
  // program being INVOKED (not merely an account operand). Conservative: fires
  // only after a real Core mint is confirmed, and never touches the real ME
  // launchpad (`CMZYPASG…`) or any non-Lucky-Buy wrapper.
  for (const p of invoked) {
    if (ME_REWARD_WRAPPER_PROGRAMS.has(p)) return rej('magic_eden_lucky_buy_reward', asset, collection);
  }

  // Agent-identity registry reject. `RegisterIdentityV1` (`1DREGFgy…`) CPIs into
  // mpl-core to mint an on-demand agent-identity asset (e.g. aign.fun, but also
  // standalone) — a utility/identity NFT, not a real collection drop. Like the
  // ME-reward case it otherwise passes every gate above (fresh Core mint into a
  // real collection; the identity/front-end program is the non-primitive
  // wrapper). Keyed on the identity program being INVOKED — not on aign.fun
  // (`ANUK3r5…`) alone, since the program also mints standalone. Parser-level,
  // no price/free dependency.
  for (const p of invoked) {
    if (AGENT_IDENTITY_PROGRAMS.has(p)) return rej('agent_identity_mint', asset, collection);
  }

  // Require a custom wrapper — at least one invoked program outside the
  // primitive/infra + known-launchpad set. Without this gate a bare direct
  // CreateV2 (no wrapper) would match here instead of falling through to the
  // dedicated v2 scorer; with it, the generic path only ever fires on
  // genuinely-unknown custom launchpads.
  let wrapper: string | null = null;
  for (const p of invoked) { if (!PRIMITIVE_PROGRAMS.has(p)) { wrapper = p; break; } }
  if (!wrapper) return rej('no_custom_wrapper', asset, collection);

  return {
    accept: true, score: 2, reasons: ['generic_core_launchpad', 'collection_present', `wrapper:${wrapper}`],
    rejectReason: null,
    mintAddress: asset, collectionAddress: collection, minter,
    name: null, uri: null, pluginsCount: null,
    wrapperProgramId: wrapper,
  };
}

// ─── Legacy Metaplex Token Metadata generic launchpad fallback ────────────
//
// The generic Core detector above tracks unknown launchpads that CPI into
// mpl-core. This sibling covers the parallel hole for the LEGACY Token
// Metadata standard (CreateMetadataAccountV3 + CreateMasterEditionV3 +
// VerifyCollection) driven by an unknown custom launchpad wrapper. NOT MPL
// Core. Reference accept:
//   3rtQjpaXA6pDJXdAwE8qz3f3CaThUVekVvte86CyRVtVj6r9gmb1hfM2Ruut2adQXNqvRu1EqbbY6VwhB9DWG1Zc
//   (wrapper L2TExMFK…, asset AQ3sv5… "WrappedBulls #191", collection BR5k11k…
//    "WrappedBulls", paid in a Token-2022 pump.fun token — payment only).

/** Token Metadata legacy instruction discriminators (first data byte). */
const TM_CREATE_METADATA_V3       = 33;
const TM_CREATE_MASTER_EDITION_V3 = 17;
/** Verify-collection-family ixs → the account index holding the collection
 *  MINT in each variant's account layout. Used to read the on-chain-verified
 *  collection directly from the verify ix. */
export const TM_VERIFY_COLLECTION_MINT_IDX: ReadonlyMap<number, number> = new Map([
  [18, 3], // VerifyCollection                    [meta, auth, payer, collMint, …]
  [30, 3], // VerifySizedCollectionItem           [meta, auth, payer, collMint, …]
  [25, 4], // SetAndVerifyCollection              [meta, auth, payer, updAuth, collMint, …]
  [32, 4], // SetAndVerifySizedCollectionItem     [meta, auth, payer, updAuth, collMint, …]
  [52, 3], // Verify (unified, CollectionV1)      [auth, delegate?, meta, collMint, …]
]);

/** Canonical Associated Token Account program. The shared `ATA_PROGRAM`
 *  constant in me-raw/programs.ts is currently MALFORMED (…LJe1bC instead of
 *  the real …LJA8knL), so PRIMITIVE_PROGRAMS does not actually contain the
 *  real ATA id. Every legacy-TM NFT creates an ATA, so without pinning the
 *  correct id here the ATA program would masquerade as a "custom wrapper" and
 *  poach plain direct / Candy Machine TM mints. Pinned locally; the shared
 *  constant is left untouched (out of scope for this change). */
const ATA_PROGRAM_CANONICAL = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

export interface TmIx { disc: number; accounts: number[]; dataB58: string; }
/** Collect every Token Metadata instruction (top + inner), with its
 *  first-byte discriminator and resolved account indices. Single pass so the
 *  detector can locate create/master-edition/verify ixs without re-walking. */
export function collectTokenMetadataIxs(tx: RawSolanaTx, accountKeys: string[]): TmIx[] {
  const out: TmIx[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const consider = (ix: any): void => {
    const programId: string = typeof ix.programId === 'string'
      ? ix.programId
      : typeof ix.programIdIndex === 'number' ? accountKeys[ix.programIdIndex] ?? '' : '';
    if (programId !== TOKEN_METADATA_PROGRAM) return;
    const dataB58: string = typeof ix.data === 'string' ? ix.data : '';
    if (!dataB58) return;
    let disc = -1;
    try { const buf = Buffer.from(bs58.decode(dataB58)); if (buf.length >= 1) disc = buf[0]; } catch { return; }
    const accounts: number[] = (ix.accounts ?? []).map((a: number | string) =>
      typeof a === 'number' ? a : accountKeys.indexOf(a));
    out.push({ disc, accounts, dataB58 });
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const message = (tx.transaction?.message as any) ?? {};
  const top = Array.isArray(message.instructions) ? message.instructions : [];
  for (const ix of top) consider(ix);
  const inner = tx.meta?.innerInstructions;
  if (Array.isArray(inner)) {
    for (const grp of inner) {
      if (!Array.isArray(grp.instructions)) continue;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      for (const ix of grp.instructions as any[]) consider(ix);
    }
  }
  return out;
}

interface CreateMetadataV3Parsed { name: string; uri: string; collectionKey: string | null; }
/** Parse the relevant prefix of a CreateMetadataAccountV3 ix payload:
 *  DataV2 { name, symbol, uri, sellerFeeBasisPoints, creators?, collection?,
 *  uses? }. We only need name, uri, and the collection key — so we stop after
 *  the collection option and never touch `uses` / `isMutable` /
 *  `collectionDetails`. Returns null on a short / malformed buffer. */
function parseCreateMetadataV3Args(dataB58: string): CreateMetadataV3Parsed | null {
  let buf: Buffer;
  try { buf = Buffer.from(bs58.decode(dataB58)); } catch { return null; }
  if (buf.length < 1 || buf[0] !== TM_CREATE_METADATA_V3) return null;
  let off = 1;
  const readStr = (): string | null => {
    if (off + 4 > buf.length) return null;
    const len = buf.readUInt32LE(off); off += 4;
    if (len > 2048 || off + len > buf.length) return null;
    const s = buf.slice(off, off + len).toString('utf8'); off += len;
    return s;
  };
  const name = readStr();   if (name === null) return null;
  const symbol = readStr(); if (symbol === null) return null;
  void symbol;
  const uri = readStr();    if (uri === null) return null;
  if (off + 2 > buf.length) return null;
  off += 2;                                            // sellerFeeBasisPoints (u16)
  if (off + 1 > buf.length) return null;
  const hasCreators = buf[off]; off += 1;              // creators: Option<Vec<Creator>>
  if (hasCreators === 1) {
    if (off + 4 > buf.length) return null;
    const n = buf.readUInt32LE(off); off += 4;
    const span = n * 34;                               // Creator = pubkey(32)+verified(1)+share(1)
    if (n > 1024 || off + span > buf.length) return null;
    off += span;
  }
  if (off + 1 > buf.length) return null;
  const hasCollection = buf[off]; off += 1;            // collection: Option<Collection{verified,key}>
  let collectionKey: string | null = null;
  if (hasCollection === 1) {
    if (off + 1 + 32 > buf.length) return null;
    off += 1;                                          // verified (bool)
    collectionKey = bs58.encode(buf.slice(off, off + 32)); off += 32;
  }
  return { name, uri, collectionKey };
}

/** True when `mint` appears in postTokenBalances as a classic SPL Token
 *  (Tokenkeg…) account with 0 decimals — the NFT shape. Combined with a
 *  CreateMasterEditionV3 in the same tx (supply 1) this proves a NonFungible.
 *  Rejects fungible mints and Token-2022 mints — in particular the Token-2022
 *  payment token that rides along in custom-launchpad TM mints. */
function isClassicNftMint(tx: RawSolanaTx, mint: string): boolean {
  const post = tx.meta?.postTokenBalances;
  if (!Array.isArray(post)) return false;
  for (const b of post) {
    if (b.mint === mint && b.programId === SPL_TOKEN_PROGRAM && b.uiTokenAmount?.decimals === 0) return true;
  }
  return false;
}

/** Generic UNKNOWN custom-launchpad LEGACY Token Metadata fallback.
 *
 *  Last-resort detector for the legacy Metaplex Token Metadata standard, run
 *  ONLY after the targeted launchpad, ME, Core Candy Machine and generic Core
 *  detectors have all missed (see `ingestMintRaw`). Goal: track the long tail
 *  of custom launchpad programs that CPI into Token Metadata to mint a real,
 *  freshly-created NonFungible into a real collection — the TM analogue of
 *  `detectGenericCoreLaunchpadMint`. This is NOT MPL Core.
 *
 *  Accept gates (all required):
 *    - Token Metadata program present
 *    - a CreateMetadataAccountV3 (disc 33) ix exists (the mint create)
 *    - a CreateMasterEditionV3 (disc 17) ix exists ⇒ supply-1 NonFungible
 *    - asset = create.accounts[1] is a classic SPL Token mint, decimals 0
 *      (so a Token-2022 / fungible mint is rejected), freshly created in-tx
 *    - a real collection — from a Verify-family ix's collection mint when
 *      present, else the DataV2 collection key in the metadata create
 *    - at least one invoked program is a non-primitive custom wrapper
 *      (excludes bare direct / Candy Machine TM mints)
 *  Hard rejects: DeFi/AMM blacklist present, pool-like name/uri.
 *  Deliberately does NOT reject on Token-2022 presence — here it is the
 *  payment currency, not the NFT mint.
 *
 *  Returns null when Token Metadata or a CreateMetadataAccountV3 is absent
 *  (caller falls through to the final unknown_launchpad reject). Downstream,
 *  `scheduleCollectionConfirmation` re-checks the collection via DAS and drops
 *  the row if the grouping can't be confirmed. */
export function detectGenericTokenMetadataLaunchpadMint(tx: RawSolanaTx): CoreV2Detection | null {
  const shape = readShape(tx);
  if (!shape) return null;
  if (!shape.accountKeys.includes(TOKEN_METADATA_PROGRAM)) return null;

  const rej = (
    rejectReason: string, mint: string | null = null, collection: string | null = null,
    name: string | null = null, uri: string | null = null,
  ): CoreV2Detection => ({
    accept: false, score: 0, reasons: ['generic_token_metadata_launchpad'], rejectReason,
    mintAddress: mint, collectionAddress: collection, minter: shape.signerKeys[0] ?? null,
    name, uri, pluginsCount: null,
  });

  // DeFi/AMM hard-reject (pool-position NFTs occasionally mint via TM). No
  // Token-2022 reject — see the doc comment.
  for (const k of shape.accountKeys) {
    if (DEFI_PROGRAM_BLACKLIST.has(k)) return rej('defi_program_present');
  }

  const tmIxs = collectTokenMetadataIxs(tx, shape.accountKeys);
  const createMeta = tmIxs.find(x => x.disc === TM_CREATE_METADATA_V3);
  if (!createMeta) return null;             // not a TM create-mint (update / transfer / burn)

  const parsed = parseCreateMetadataV3Args(createMeta.dataB58);
  if (!parsed) return rej('borsh_decode_failed');

  // Master edition ⇒ NonFungible (supply 1). An SFT / fungible TM mint has
  // none and must not surface in /mints.
  if (!tmIxs.some(x => x.disc === TM_CREATE_MASTER_EDITION_V3)) {
    return rej('no_master_edition', null, parsed.collectionKey, parsed.name, parsed.uri);
  }

  // asset (mint) = CreateMetadataAccountV3 accounts[1].
  const mintIdx = createMeta.accounts.length > 1 ? createMeta.accounts[1] : -1;
  const asset = mintIdx >= 0 ? shape.accountKeys[mintIdx] ?? null : null;
  if (!asset) return rej('no_asset_account', null, parsed.collectionKey, parsed.name, parsed.uri);

  if (!isClassicNftMint(tx, asset)) return rej('not_nft_shape', asset, parsed.collectionKey, parsed.name, parsed.uri);
  if (!isFresh(shape, asset))       return rej('asset_not_fresh', asset, parsed.collectionKey, parsed.name, parsed.uri);

  // Collection — prefer a Verify-family ix's collection mint (verified
  // on-chain in this tx); else the DataV2 collection key from the create.
  let collection: string | null = null;
  for (const x of tmIxs) {
    const idx = TM_VERIFY_COLLECTION_MINT_IDX.get(x.disc);
    if (idx === undefined) continue;
    const ai = x.accounts.length > idx ? x.accounts[idx] : -1;
    if (ai >= 0) { collection = shape.accountKeys[ai] ?? null; if (collection) break; }
  }
  if (!collection) collection = parsed.collectionKey;
  const realCollection = !!collection
    && collection !== asset
    && collection !== SYSTEM_PROGRAM
    && collection !== TOKEN_METADATA_PROGRAM
    && collection !== SPL_TOKEN_PROGRAM;
  if (!realCollection) return rej('no_collection', asset, collection, parsed.name, parsed.uri);

  if (nameLooksLikePool(parsed.name, parsed.uri)) {
    return rej('pool_like_name', asset, collection, parsed.name, parsed.uri);
  }

  // Custom wrapper required — at least one invoked program outside the
  // primitive/infra + known-launchpad set (and not the ATA program). Without
  // this gate a bare direct TM mint or a Candy Machine v3 mint (both invoke
  // only primitive programs) would be poached; with it, only genuinely
  // unknown custom launchpads pass.
  const invoked = collectInvokedPrograms(tx, shape.accountKeys);
  let wrapper: string | null = null;
  for (const p of invoked) {
    if (!PRIMITIVE_PROGRAMS.has(p) && p !== ATA_PROGRAM_CANONICAL) { wrapper = p; break; }
  }
  if (!wrapper) return rej('no_custom_wrapper', asset, collection, parsed.name, parsed.uri);

  return {
    accept: true, score: 2,
    reasons: ['generic_token_metadata_launchpad', 'collection_present', `wrapper:${wrapper}`],
    rejectReason: null,
    mintAddress: asset, collectionAddress: collection, minter: shape.signerKeys[0] ?? null,
    name: parsed.name, uri: parsed.uri, pluginsCount: null,
  };
}

/** MPL **Core** Candy Machine mint detector (CMv3-core).
 *
 *  Covers the path the targeted detector + CreateV2 scorer both miss: a Core
 *  Candy Machine (`CMACYFEN…`) mint whose asset is created by an inner
 *  mpl-core `Create` (V1, disc 0) — not a direct `CreateV2`. Robust to:
 *    - direct candy-machine `MintAsset`
 *    - Core Candy Guard (`CMAGAK…`, `MintV1`) wrapping it
 *    - launchpad programs that invoke the candy machine internally
 *  …because the candy-machine program id lands in `accountKeys` at any CPI
 *  depth, and the asset-create ix is found across top + inner instructions.
 *
 *  Conservative: requires the Core Candy Machine program present, a freshly
 *  created asset (lamports 0 → >0), and a real collection (≠ asset / program /
 *  system). No URI/name gate — candy machines are NFT drops by construction,
 *  the V1 `Create` carries no inline metadata (DAS confirms name/image later),
 *  and the DeFi/Token-2022 rejects below guard against the rare pool case.
 *
 *  Returns null when the Core Candy Machine isn't involved (caller no-ops). */
export function detectCoreCandyMachineMint(tx: RawSolanaTx): CoreV2Detection | null {
  const shape = readShape(tx);
  if (!shape) return null;
  if (!shape.accountKeys.includes(MPL_CORE_PROGRAM)) return null;
  if (!shape.accountKeys.includes(CORE_CANDY_MACHINE_PROGRAM)) return null;

  const rej = (rejectReason: string, mint: string | null = null, collection: string | null = null): CoreV2Detection => ({
    accept: false, score: 0, reasons: ['core_candy_machine'], rejectReason,
    mintAddress: mint, collectionAddress: collection, minter: shape.signerKeys[0] ?? null,
    name: null, uri: null, pluginsCount: null,
  });

  for (const k of shape.accountKeys) {
    if (DEFI_PROGRAM_BLACKLIST.has(k)) return rej('defi_program_present');
  }
  if (shape.accountKeys.includes(TOKEN_2022_PROGRAM)) return rej('token_2022_present');

  // The asset is minted by an mpl-core Create (V1) or CreateV2 inner ix.
  const found = findCreateV2Ix(tx, shape.accountKeys, CORE_CREATE_DISCS);
  if (!found) return null; // candy machine present but no asset-create ix we model

  const accIxs = found.accounts;
  const asset      = accIxs.length > 0 && accIxs[0] >= 0 ? shape.accountKeys[accIxs[0]] ?? null : null;
  const collection = accIxs.length > 1 && accIxs[1] >= 0 ? shape.accountKeys[accIxs[1]] ?? null : null;
  const minter     = shape.signerKeys[0] ?? null;
  if (!asset) return rej('no_asset_account', null, collection);

  const hasRealCollection = !!collection
    && collection !== MPL_CORE_PROGRAM
    && collection !== asset
    && collection !== SYSTEM_PROGRAM;
  if (!hasRealCollection) return rej('no_collection', asset, collection);
  if (!isFresh(shape, asset)) return rej('asset_not_fresh', asset, collection);

  return {
    accept: true, score: 2, reasons: ['core_candy_machine', 'collection_present'],
    rejectReason: null,
    mintAddress: asset, collectionAddress: collection, minter,
    name: null, uri: null, pluginsCount: null,
  };
}

/** Magic Eden launchpad Core mint detector.
 *
 *  Mirrors `detectCoreCandyMachineMint` but keys on the Magic Eden launchpad
 *  program (`CMZYPASG…`) instead of the Core Candy Machine program. ME fronts
 *  an MPL Core mint whose asset is created by an inner mpl-core `Create`
 *  (V1, disc 0) or `CreateV2` (disc 20) — the same `CORE_CREATE_DISCS` family.
 *  Account layout from the create ix: asset = accounts[0], collection =
 *  accounts[1].
 *
 *  Conservative, identical gate set to the Core Candy Machine detector:
 *  ME program present + MPL Core present + a freshly created asset (lamports
 *  0 → >0) + a real collection (≠ asset / program / system). The DeFi /
 *  Token-2022 rejects guard the rare pool case.
 *
 *  Returns null when the ME launchpad program isn't involved (caller no-ops). */
export function detectMagicEdenCoreMint(tx: RawSolanaTx): CoreV2Detection | null {
  const shape = readShape(tx);
  if (!shape) return null;
  if (!shape.accountKeys.includes(MPL_CORE_PROGRAM)) return null;
  if (!shape.accountKeys.includes(MAGIC_EDEN_LAUNCHPAD_PROGRAM)) return null;

  const rej = (rejectReason: string, mint: string | null = null, collection: string | null = null): CoreV2Detection => ({
    accept: false, score: 0, reasons: ['magic_eden_launchpad'], rejectReason,
    mintAddress: mint, collectionAddress: collection, minter: shape.signerKeys[0] ?? null,
    name: null, uri: null, pluginsCount: null,
  });

  for (const k of shape.accountKeys) {
    if (DEFI_PROGRAM_BLACKLIST.has(k)) return rej('defi_program_present');
  }
  if (shape.accountKeys.includes(TOKEN_2022_PROGRAM)) return rej('token_2022_present');

  // Asset minted by an mpl-core Create (V1) or CreateV2 inner ix.
  const found = findCreateV2Ix(tx, shape.accountKeys, CORE_CREATE_DISCS);
  if (!found) return null; // ME program present but no asset-create ix we model

  const accIxs = found.accounts;
  const asset      = accIxs.length > 0 && accIxs[0] >= 0 ? shape.accountKeys[accIxs[0]] ?? null : null;
  const collection = accIxs.length > 1 && accIxs[1] >= 0 ? shape.accountKeys[accIxs[1]] ?? null : null;
  const minter     = shape.signerKeys[0] ?? null;
  if (!asset) return rej('no_asset_account', null, collection);

  const hasRealCollection = !!collection
    && collection !== MPL_CORE_PROGRAM
    && collection !== asset
    && collection !== SYSTEM_PROGRAM;
  if (!hasRealCollection) return rej('no_collection', asset, collection);
  if (!isFresh(shape, asset)) return rej('asset_not_fresh', asset, collection);

  return {
    accept: true, score: 2, reasons: ['magic_eden_launchpad', 'collection_present'],
    rejectReason: null,
    mintAddress: asset, collectionAddress: collection, minter,
    name: null, uri: null, pluginsCount: null,
  };
}
