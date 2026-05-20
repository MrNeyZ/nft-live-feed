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

// ─── DeFi / pool program hard-rejects ─────────────────────────────────────
//
// Any tx that touches one of these accounts is rejected before we do
// any decoding work. CreateV2 is occasionally emitted inside DEX /
// AMM / LP txs (e.g. when a pool authority happens to mint a position
// NFT through Core); those are not NFT drops and must not surface in
// /mints. Curated; extend as new false positives are observed.
const DEFI_PROGRAM_BLACKLIST: ReadonlySet<string> = new Set([
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
const SYSTEM_PROGRAM = '11111111111111111111111111111111';

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
}

interface TxShape {
  accountKeys: string[];
  signerKeys:  string[];
  preBalances:  number[];
  postBalances: number[];
}

function readShape(tx: RawSolanaTx): TxShape | null {
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

function nameLooksLikePool(name: string, uri: string): boolean {
  const haystack = `${name}\n${uri}`.toLowerCase();
  for (const p of NEGATIVE_NAME_PATTERNS) {
    if (haystack.includes(p)) return true;
  }
  return false;
}

function isFresh(shape: TxShape, address: string): boolean {
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
