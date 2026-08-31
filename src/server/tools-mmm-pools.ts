/**
 * MMM Dormant Pool Scanner — read-only tool.
 *
 *   GET /api/tools/mmm-pools/scan?owner=<wallet>
 *
 * Given an owner wallet, returns all MMM pool configs owned by that wallet
 * together with derived escrow PDA balances. Classifies each pool by
 * executable (real escrow >= spotPrice), diverged (real > tracked),
 * and underfunded (0 < tracked < spot). Read-only: no wallet, no signing,
 * no transactions, no DB writes.
 *
 * Offsets verified empirically against live accounts (Jun 2026):
 *   spot_price            u64 LE  @ 8
 *   expiry                i64 LE  @ 27
 *   owner                Pubkey  @ 121
 *   buyside_payment_amount u64 LE @ 447
 *   allowlists[0..5]    6×33B   @ 249  (type u8 + pubkey 32B each)
 */

import { Router, Request, Response }                 from 'express';
import {
  PublicKey, Transaction, TransactionInstruction,
  SystemProgram, SYSVAR_RENT_PUBKEY, SYSVAR_INSTRUCTIONS_PUBKEY,
  AddressLookupTableAccount, TransactionMessage, VersionedTransaction,
}                                                    from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
}                                                    from '@solana/spl-token';
import bs58                                          from 'bs58';
import fs, { promises as fsp }                       from 'fs';
import path                                          from 'path';
import { rateLimit }                                 from './rate-limit';
import { requireAuth }                               from './runtime';
import { meCooldownActive, setMeCooldown, meAuthHeaders } from '../me-api-cooldown';
import { fetchAsset }                                from '../enrichment/helius-das';

const MMM_PROGRAM_ID = new PublicKey('mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc');
const ESCROW_SEED    = Buffer.from('mmm_buyside_sol_escrow_account');
export const POOL_SIZE = 849;
const RPC_TIMEOUT_MS = 90_000;
const CHUNK_SIZE     = 100;
// Dust threshold shared by triage-stream, pool-stream, and collection-scan — pools
// below this real escrow are noise (can't realistically be topped up + sold for
// meaningful profit) and are hidden consistently across all three scanners.
const MIN_VISIBLE_ESCROW_LAMPORTS = 10_000_000; // 0.01 SOL

// Pool layout field offsets (verified empirically, Jun 2026)
const OFF_SPOT     = 8;
const OFF_EXPIRY   = 27;
const OFF_OWNER    = 121;
const OFF_COSIGNER = 153;   // immediately after owner (32 bytes)
const OFF_REFERRAL = 185;   // immediately after cosigner (32 bytes)
const OFF_BPA      = 447;
const OFF_SHARED_ESCROW = 455; // shared_escrow_account Pubkey (32 bytes)
const OFF_AL       = 249;   // allowlists start

// MMM on-chain constants (verified from live sol_fulfill_buy txs)
const METAPLEX_PROGRAM   = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const AUTH_RULES_PROGRAM = new PublicKey('auth9SigNpDKz4sJJ1DfCTuZrZNSAgh9sFD3rboVmgg');
const MPL_CORE_PROGRAM_ID = new PublicKey('CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d');
// M2 (Magic Eden v2 auction house) program — CPI target for shared-escrow
// withdrawals inside sol_fulfill_buy/sol_mip1_fulfill_buy/sol_mpl_core_fulfill_buy.
// Verified against magicoss/mmm source (constants.rs): M2_PROGRAM + M2_AUCTION_HOUSE
// are fixed protocol constants, not per-pool values.
const M2_PROGRAM_ID = new PublicKey('M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K');
const SOL_FULFILL_BUY_DISC          = Buffer.from('5c10e24f1ff23576', 'hex'); // sol_fulfill_buy (legacy/non-pNFT)
const SOL_MIP1_FULFILL_BUY_DISC     = Buffer.from('ec529e7a0818af91', 'hex'); // sol_mip1_fulfill_buy (pNFT)
const SOL_MPL_CORE_FULFILL_BUY_DISC = Buffer.from('aba722c170158e59', 'hex'); // sol_mpl_core_fulfill_buy (MPL Core)
const SELL_STATE_SEED      = Buffer.from('mmm_sell_state');
const TOKEN_RECORD_SEED    = Buffer.from('token_record');

// PREVIOUSLY: a single hardcoded pubkey (`4nGoPfgRW2nkAp6ELx8bYRxLVRrNB3Si8drp4PRuDa3Q` —
// which is open_solmap's own FVCA, not a protocol constant at all) was appended as
// account [18] for EVERY sale regardless of collection. It only "worked" for
// open_solmap by coincidence. Real on-chain SolFulfillBuy/SolMip1FulfillBuy both take
// the NFT's full on-chain `creators` array (verified + unverified, in order) as
// remaining_accounts for royalty payout — confirmed 2026-08-07 by decoding a real
// Metaplex Metadata account and diffing against two live successful fulfill-buy txs
// (creators list order/addresses matched exactly). Fixed below via decodeMetadataAccount.

interface DecodedMetadata {
  creators: Array<{ address: string; verified: boolean; share: number }>;
  tokenStandard: number | null; // 4 = ProgrammableNonFungible (pNFT)
  ruleSet: string | null;
}

/** Minimal Borsh decoder for a Metaplex Token Metadata account — just enough
 *  to recover `creators` (for royalty remaining_accounts) and, for pNFTs,
 *  `token_standard` + `programmable_config.rule_set`. Byte offsets verified
 *  live 2026-08-07 against a real pNFT metadata account (Myros #2036,
 *  H1GLRWcdjFXN9zJwDJouXbVTMG9mg2BXgQtyJXKVRzKf) — decoded creators and
 *  rule_set both matched the real transaction's remaining_accounts /
 *  authorizationRules exactly. Reads defensively past `uses` since older
 *  (pre-pNFT) Metadata accounts end there with no trailing bytes.
 */
function decodeMetadataAccount(data: Buffer): DecodedMetadata {
  let off = 1 + 32 + 32; // key(1) + update_authority(32) + mint(32)
  const readString = () => {
    const len = data.readUInt32LE(off); off += 4;
    off += len;
  };
  readString(); // name
  readString(); // symbol
  readString(); // uri
  off += 2;     // seller_fee_basis_points: u16

  const creators: DecodedMetadata['creators'] = [];
  const hasCreators = data[off]; off += 1;
  if (hasCreators) {
    const n = data.readUInt32LE(off); off += 4;
    for (let i = 0; i < n; i++) {
      const address = new PublicKey(data.subarray(off, off + 32)).toBase58(); off += 32;
      const verified = data[off] === 1; off += 1;
      const share = data[off]; off += 1;
      creators.push({ address, verified, share });
    }
  }

  off += 1; // primary_sale_happened: bool
  off += 1; // is_mutable: bool
  if (data[off]) { off += 1; off += 1; } else { off += 1; } // edition_nonce: Option<u8>

  let tokenStandard: number | null = null;
  if (off < data.length) {
    const hasTs = data[off]; off += 1;
    if (hasTs) { tokenStandard = data[off]; off += 1; }
  }
  if (off < data.length) { // collection: Option<Collection { verified: bool, key: Pubkey }>
    const hasCollection = data[off]; off += 1;
    if (hasCollection) off += 1 + 32;
  }
  if (off < data.length) { // uses: Option<Uses { use_method: u8, remaining: u64, total: u64 }>
    const hasUses = data[off]; off += 1;
    if (hasUses) off += 1 + 8 + 8;
  }
  if (off < data.length) { // collection_details: Option<CollectionDetails> — V1{size:u64} | V2{padding:[u8;8]}, both 1+8 bytes
    const hasCollDetails = data[off]; off += 1;
    if (hasCollDetails) off += 1 + 8;
  }
  let ruleSet: string | null = null;
  if (off < data.length) { // programmable_config: Option<ProgrammableConfig::V1{ rule_set: Option<Pubkey> }>
    const hasProgConfig = data[off]; off += 1;
    if (hasProgConfig) {
      off += 1; // variant tag
      const hasRuleSet = data[off]; off += 1;
      if (hasRuleSet) { ruleSet = new PublicKey(data.subarray(off, off + 32)).toBase58(); off += 32; }
    }
  }

  return { creators, tokenStandard, ruleSet };
}

async function fetchMetadataAccount(metadataPk: PublicKey): Promise<DecodedMetadata> {
  const result = await rpcPost('getAccountInfo', [metadataPk.toBase58(), { encoding: 'base64' }]) as
    { value: { data: [string, string] } | null };
  if (!result.value) throw new Error('metadata_account_not_found');
  return decodeMetadataAccount(Buffer.from(result.value.data[0], 'base64'));
}

function tokenRecordPda(mintPk: PublicKey, tokenAccountPk: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METAPLEX_PROGRAM.toBuffer(), mintPk.toBuffer(), TOKEN_RECORD_SEED, tokenAccountPk.toBuffer()],
    METAPLEX_PROGRAM,
  );
  return pda;
}

function serializeFulfillBuyArgs(minPayment: number): Buffer {
  // 21-byte SolFulfillBuyArgs body (asset_amount, min_payment_amount,
  // allowlist_aux, maker_fee_bp, taker_fee_bp) — shared by sol_fulfill_buy
  // and sol_mip1_fulfill_buy per the on-chain IDL; only the 8-byte
  // instruction discriminator differs between the two.
  const data = Buffer.alloc(21);
  data.writeBigUInt64LE(BigInt(1), 0);
  data.writeBigUInt64LE(BigInt(minPayment), 8);
  data[16] = 0x00;               // allowlist_aux = None
  data.writeInt16LE(-100, 17);   // maker_fee_bp
  data.writeInt16LE(200, 19);    // taker_fee_bp
  return data;
}

function creatorKeys(creators: DecodedMetadata['creators']) {
  return creators.map(c => ({ pubkey: new PublicKey(c.address), isSigner: false, isWritable: true }));
}

/** Shared-escrow pools require 2 extra remaining_accounts BEFORE the royalty
 *  creator accounts: [m2_program, shared_escrow_account] — the mmm program
 *  CPIs into M2's withdraw_by_mmm to pull funds from the shared wallet into
 *  the per-pool escrow PDA atomically, inside the same fulfill-buy ix.
 *  Verified against magicoss/mmm source (util.rs check_remaining_accounts_for_m2/
 *  withdraw_m2, identical across vanilla/mip1/mpl_core_asset fulfill-buy). */
function sharedEscrowRemainingAccounts(pool: MmmPool) {
  if (!pool.usingSharedEscrow) return [];
  return [
    { pubkey: M2_PROGRAM_ID,                       isSigner: false, isWritable: false },
    { pubkey: new PublicKey(pool.sharedEscrowAccount), isSigner: false, isWritable: true },
  ];
}

interface CoreAssetInfo {
  collection: string | null;
  creators: DecodedMetadata['creators'];
}

/** MPL Core assets almost always inherit royalty from a Collection-level
 *  `royalties` plugin rather than carrying their own — per-asset DAS
 *  `creators` comes back empty in that (common) case. Verified live
 *  2026-08-07 (Curved Cats): asset-level creators=[], collection-level
 *  creators=[{address, share:100, verified:true}] matched exactly the
 *  remaining_accounts of a real successful sol_mpl_core_fulfill_buy tx.
 *  Falls back to the collection's own creators only when the asset itself
 *  has none. */
async function fetchCoreAssetInfo(assetMint: string): Promise<CoreAssetInfo> {
  const fetchDas = async (id: string) => {
    const r = await fetch(rpcUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id } }),
      signal: AbortSignal.timeout(8_000),
    });
    return await r.json() as {
      result?: {
        creators?: Array<{ address: string; share: number; verified: boolean }>;
        grouping?: Array<{ group_key: string; group_value: string }>;
      };
    };
  };

  const assetJson = await fetchDas(assetMint);
  const collection = (assetJson.result?.grouping ?? []).find(g => g.group_key === 'collection')?.group_value ?? null;
  let creators = assetJson.result?.creators ?? [];

  if (creators.length === 0 && collection) {
    const collJson = await fetchDas(collection);
    creators = collJson.result?.creators ?? [];
  }

  return { collection, creators };
}

/** sol_mpl_core_fulfill_buy — 11 fixed accounts + one remaining account per
 *  royalty creator. No SPL token/ATA/metadata accounts at all (MPL Core
 *  doesn't use them) — inherently tiny (~500-600 bytes even with several
 *  creators), nowhere near the 1232-byte cap that blocks large pNFT sales.
 *  Account order verified live 2026-08-07 against a real successful tx. */
function buildSolMplCoreFulfillBuyIx(
  pool:         MmmPool,
  poolPk:       PublicKey,
  sellerPk:     PublicKey,
  assetPk:      PublicKey,
  collectionPk: PublicKey,
  creators:     DecodedMetadata['creators'],
): TransactionInstruction {
  const MMM_PK     = MMM_PROGRAM_ID;
  const ownerPk    = new PublicKey(pool.owner);
  const cosignerPk = new PublicKey(pool.cosigner);
  const referralPk = new PublicKey(pool.referral);

  const [escrowPk] = PublicKey.findProgramAddressSync([ESCROW_SEED, poolPk.toBuffer()], MMM_PK);
  const [sellStatePk] = PublicKey.findProgramAddressSync(
    [SELL_STATE_SEED, poolPk.toBuffer(), assetPk.toBuffer()], MMM_PK);

  const minPayment = Math.floor(pool.spotPrice * 9800 / 10000);
  const data = Buffer.concat([SOL_MPL_CORE_FULFILL_BUY_DISC, serializeFulfillBuyArgs(minPayment)]);

  return new TransactionInstruction({
    programId: MMM_PK,
    data,
    keys: [
      { pubkey: sellerPk,                isSigner: true,  isWritable: true  }, // [0] payer
      { pubkey: ownerPk,                 isSigner: false, isWritable: true  }, // [1] owner
      { pubkey: cosignerPk,              isSigner: false, isWritable: false }, // [2] cosigner
      { pubkey: referralPk,              isSigner: false, isWritable: true  }, // [3] referral
      { pubkey: poolPk,                  isSigner: false, isWritable: true  }, // [4] pool
      { pubkey: escrowPk,                isSigner: false, isWritable: true  }, // [5] buyside_sol_escrow_account
      { pubkey: assetPk,                 isSigner: false, isWritable: true  }, // [6] asset
      { pubkey: sellStatePk,             isSigner: false, isWritable: true  }, // [7] sell_state
      { pubkey: collectionPk,            isSigner: false, isWritable: false }, // [8] collection
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // [9] system_program
      { pubkey: MPL_CORE_PROGRAM_ID,     isSigner: false, isWritable: false }, // [10] asset_program
      ...sharedEscrowRemainingAccounts(pool),                                  // [11..12] m2_program + shared_escrow_account (shared-escrow pools only)
      ...creatorKeys(creators),                                                // [11/13..] royalty creators (dynamic)
    ],
  });
}

// Shared on-chain ALT (not ours — reused as-is) carrying the fixed accounts
// every SolFulfillBuy repeats (mmm program, token/ATA/rent/instructions
// sysvars, metadata program, etc). Referencing it in a v0 tx frees enough
// space to fit 5-creator pNFTs under Solana's 1232-byte tx cap — confirmed
// live 2026-08-07 by diffing two real successful fulfill-buy txs (22 and 30
// accounts respectively) that both used it. Legacy (non-versioned) tx
// building was the actual cause of past "byte limit" pool skips, not a real
// protocol block. See memory project_mmm_alt_bytelimit_fix.
const MMM_SHARED_ALT_ADDRESS = '9JqEwvgiSLd5gvMKtKXTYtmKBuhByGRZe7iPzHNQd4s3';
let mmmAltCache: { account: AddressLookupTableAccount; fetchedAt: number } | null = null;
const MMM_ALT_TTL_MS = 30 * 60 * 1000;

async function fetchMmmSharedAlt(): Promise<AddressLookupTableAccount> {
  if (mmmAltCache && Date.now() - mmmAltCache.fetchedAt < MMM_ALT_TTL_MS) {
    return mmmAltCache.account;
  }
  const result = await rpcPost('getAccountInfo', [MMM_SHARED_ALT_ADDRESS, { encoding: 'base64' }]) as
    { value: { data: [string, string] } | null };
  if (!result.value) throw new Error('mmm_shared_alt_not_found');
  const data = Buffer.from(result.value.data[0], 'base64');
  const state = AddressLookupTableAccount.deserialize(data);
  const account = new AddressLookupTableAccount({ key: new PublicKey(MMM_SHARED_ALT_ADDRESS), state });
  mmmAltCache = { account, fetchedAt: Date.now() };
  return account;
}

export const ALLOWLIST_TYPE: Record<number, string> = {
  0: 'empty', 1: 'FVCA', 2: 'mint', 3: 'MCC',
  4: 'metadata', 5: 'group', 6: 'core_collection', 255: 'any',
};

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  return key
    ? `https://beta.helius-rpc.com/?api-key=${key}`
    : 'https://api.mainnet-beta.solana.com';
}

// Idempotent reads only — never sendTransaction or any state-changing RPC.
const RETRYABLE_RPC_METHODS = new Set(['getLatestBlockhash', 'getAccountInfo', 'getSignatureStatuses']);
const RETRY_BACKOFF_MS = [250, 500];

async function rpcPostOnce(method: string, params: unknown[], timeoutMs: number): Promise<unknown> {
  const r = await fetch(rpcUrl(), {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal:  AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`RPC ${method} HTTP ${r.status}`);
  const j = await r.json() as { result?: unknown; error?: { message?: string } };
  if (j.error) throw new Error(`RPC ${method} error: ${j.error.message ?? JSON.stringify(j.error)}`);
  return j.result;
}

export async function rpcPost(method: string, params: unknown[], timeoutMs = RPC_TIMEOUT_MS): Promise<unknown> {
  if (!RETRYABLE_RPC_METHODS.has(method)) {
    return rpcPostOnce(method, params, timeoutMs);
  }
  for (let attempt = 0; ; attempt++) {
    try {
      return await rpcPostOnce(method, params, timeoutMs);
    } catch (err) {
      if (attempt >= RETRY_BACKOFF_MS.length) throw err;
      await new Promise((res) => setTimeout(res, RETRY_BACKOFF_MS[attempt]));
    }
  }
}

// getProgramAccounts against MMM_PROGRAM_ID now gets rejected by Helius
// ("Request deprioritized due to number of accounts requested") — the
// program has too many accounts for a single unpaginated scan. Helius'
// getProgramAccountsV2 is the paginated replacement; loop paginationKey
// until an empty page comes back. Single source of truth for all 4
// MMM getProgramAccounts call sites (owner scan, collection scan, both
// pool-stream/triage-stream full scans).
async function getProgramAccountsPaginated(
  programId: string,
  opts: { encoding: string; commitment?: string; filters?: unknown[] },
  timeoutMs = RPC_TIMEOUT_MS,
): Promise<Array<{ pubkey: string; account: { data: [string, string] } }>> {
  const out: Array<{ pubkey: string; account: { data: [string, string] } }> = [];
  let paginationKey: string | undefined;
  for (;;) {
    const params: Record<string, unknown> = { ...opts, limit: 10_000 };
    if (paginationKey) params.paginationKey = paginationKey;
    const page = await rpcPost('getProgramAccountsV2', [
      programId,
      params,
    ], timeoutMs) as { accounts: Array<{ pubkey: string; account: { data: [string, string] } }>; paginationKey: string | null };
    if (!page.accounts.length) break;
    out.push(...page.accounts);
    if (!page.paginationKey) break;
    paginationKey = page.paginationKey;
  }
  return out;
}

function deriveEscrowPda(poolKey: string): string {
  const pool = new PublicKey(poolKey);
  const [pda] = PublicKey.findProgramAddressSync(
    [ESCROW_SEED, pool.toBuffer()],
    MMM_PROGRAM_ID,
  );
  return pda.toBase58();
}

export interface Allowlist { type: string; pubkey: string; }

export interface MmmPool {
  poolKey:        string;
  escrowPda:      string;
  sharedEscrowAccount: string; // pool.shared_escrow_account (M2 PDA); default pubkey when unused
  usingSharedEscrow:   boolean;
  fundingAccount: string;   // account real balance actually funds this pool: sharedEscrowAccount when using shared escrow, else escrowPda
  owner:          string;
  cosigner:       string;
  referral:       string;
  spotPrice:      number;   // lamports
  spotPriceSol:   number;
  bpa:            number;   // tracked buyside_payment_amount, lamports
  bpaSol:         number;
  realEscrow:     number;   // actual lamports in fundingAccount
  realEscrowSol:  number;
  missing:        number;   // spotPrice - realEscrow (lamports)
  missingSol:     number;
  divergence:     number;   // realEscrow - bpa (lamports)
  divergenceSol:  number;
  expiry:         number;
  executable:     boolean;  // realEscrow >= spotPrice
  underfunded:    boolean;  // expiry==0 && bpa>0 && bpa<spotPrice
  diverged:       boolean;  // realEscrow > bpa
  allowlists:     Allowlist[];
  isMIP1:         boolean;
}

export function parsePool(pubkey: string, dataB64: string): MmmPool | null {
  const raw = Buffer.from(dataB64, 'base64');
  if (raw.length !== POOL_SIZE) return null;

  const view     = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const spot     = Number(view.getBigUint64(OFF_SPOT,   true));
  const expiry   = Number(view.getBigInt64(OFF_EXPIRY, true));
  const bpa      = Number(view.getBigUint64(OFF_BPA,   true));

  const allowlists: Allowlist[] = [];
  for (let i = 0; i < 6; i++) {
    const off  = OFF_AL + i * 33;
    const atyp = raw[off];
    if (atyp === 0) continue;
    const apub = new PublicKey(raw.subarray(off + 1, off + 33)).toBase58();
    allowlists.push({ type: ALLOWLIST_TYPE[atyp] ?? String(atyp), pubkey: apub });
  }

  let escrowPda: string;
  try { escrowPda = deriveEscrowPda(pubkey); }
  catch { return null; }

  let owner    = '';
  let cosigner = '';
  let referral = '';
  let sharedEscrowAccount = SystemProgram.programId.toBase58();
  try { owner    = new PublicKey(raw.subarray(OFF_OWNER,    OFF_OWNER    + 32)).toBase58(); } catch { /* ignore */ }
  try { cosigner = new PublicKey(raw.subarray(OFF_COSIGNER, OFF_COSIGNER + 32)).toBase58(); } catch { /* ignore */ }
  try { referral = new PublicKey(raw.subarray(OFF_REFERRAL, OFF_REFERRAL + 32)).toBase58(); } catch { /* ignore */ }
  try { sharedEscrowAccount = new PublicKey(raw.subarray(OFF_SHARED_ESCROW, OFF_SHARED_ESCROW + 32)).toBase58(); } catch { /* ignore */ }
  // Mirrors on-chain Pool::using_shared_escrow() exactly (state.rs): true iff
  // shared_escrow_account != Pubkey::default().
  const usingSharedEscrow = sharedEscrowAccount !== SystemProgram.programId.toBase58();
  const fundingAccount    = usingSharedEscrow ? sharedEscrowAccount : escrowPda;

  return {
    poolKey:       pubkey,
    escrowPda,
    sharedEscrowAccount,
    usingSharedEscrow,
    fundingAccount,
    owner,
    cosigner,
    referral,
    spotPrice:     spot,
    spotPriceSol:  spot / 1e9,
    bpa,
    bpaSol:        bpa / 1e9,
    realEscrow:    0,
    realEscrowSol: 0,
    missing:       spot,
    missingSol:    spot / 1e9,
    divergence:    -bpa,
    divergenceSol: -bpa / 1e9,
    expiry,
    executable:    false,
    underfunded:   expiry === 0 && bpa > 0 && bpa < spot,
    diverged:      false,
    allowlists,
    isMIP1:        false,
  };
}

function applyBalance(p: MmmPool, lamports: number): MmmPool {
  return {
    ...p,
    realEscrow:    lamports,
    realEscrowSol: lamports / 1e9,
    missing:       p.spotPrice - lamports,
    missingSol:    (p.spotPrice - lamports) / 1e9,
    divergence:    lamports - p.bpa,
    divergenceSol: (lamports - p.bpa) / 1e9,
    executable:    lamports >= p.spotPrice,
    diverged:      lamports > p.bpa,
  };
}

// Bounded parallelism across chunks — same shape as batchResolveFvcaNames's
// concurrency-limited loop below. getMultipleAccounts is a plain, cheap RPC
// read (not a rate-limit-fragile DAS searchAssets call), so a modest 5-wide
// window is safe; still far short of "spam" since total request count is
// unchanged, only the scheduling is.
const BALANCE_FETCH_CONCURRENCY = 5;

async function fetchMultipleBalances(pdas: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const chunks: string[][] = [];
  for (let i = 0; i < pdas.length; i += CHUNK_SIZE) chunks.push(pdas.slice(i, i + CHUNK_SIZE));

  for (let i = 0; i < chunks.length; i += BALANCE_FETCH_CONCURRENCY) {
    await Promise.all(chunks.slice(i, i + BALANCE_FETCH_CONCURRENCY).map(async chunk => {
      try {
        const result = await rpcPost('getMultipleAccounts', [
          chunk,
          { encoding: 'base64', commitment: 'confirmed' },
        ]) as { value: Array<{ lamports: number } | null> };
        for (let j = 0; j < chunk.length; j++) {
          const acct = result.value[j];
          out.set(chunk[j], acct?.lamports ?? 0);
        }
      } catch {
        // Leave missing PDAs absent — caller treats as 0
      }
    }));
  }
  return out;
}

// ── ME API: collection name lookup ──────────────────────────────────────────
const ME_BASE = 'https://api-mainnet.magiceden.dev/v2';

interface MePoolResult {
  collectionSymbol?:        string;
  collectionName?:          string;
  poolType?:                string;
  isMIP1?:                  boolean;
  poolKey?:                 string;
  buysideCreatorRoyaltyBp?: number;
  buyOrdersAmount?:         number;
  updatedAt?:               string;
  // ME-side kill-switch — a pool with this set can never actually be
  // fulfilled (found live 2026-08-07: a fully-funded 140 SOL SMB Gen2 pool,
  // untouched since 2023, blockedAt=2023-07-09 — ME's own cosigner refuses
  // it). Not previously tracked anywhere in this codebase; surfaced as a
  // real false-positive risk for any profit-ranking that only looks at
  // funded amount vs floor.
  blockedAt?:                string | null;
}

async function fetchMeCollectionInfo(owner: string): Promise<Map<string, MePoolResult>> {
  const out = new Map<string, MePoolResult>();
  if (meCooldownActive()) return out;
  const url = `${ME_BASE}/mmm/pools?owner=${encodeURIComponent(owner)}&showInvalid=true&filterOnSide=1&limit=100`;
  // One retry: a transient failure here silently becomes meKnown=false
  // downstream, which the frontend treats as "confirmed unknown/invalid" and
  // skips the ME bridge (the only path that can get a real co-sign) — so a
  // single flaky request can wrongly doom an otherwise-sellable pool.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'VictoryLabs/1.0', ...meAuthHeaders() },
        signal:  AbortSignal.timeout(15_000),
      });
      if (r.status === 429) { setMeCooldown(60_000); return out; }
      if (!r.ok) { if (attempt === 0) { await new Promise(res => setTimeout(res, 1500)); continue; } return out; }
      const data = await r.json() as { results?: MePoolResult[] };
      for (const mp of data.results ?? []) {
        const pk = mp.poolKey;
        if (pk) out.set(pk, mp);
      }
      return out;
    } catch {
      if (attempt === 0) { await new Promise(res => setTimeout(res, 1500)); continue; }
    }
  }
  return out;
}

export interface MmmPoolWithCollection extends MmmPool {
  collectionName:   string;
  collectionSymbol: string;
  poolType:         string;
  isMIP1:           boolean;
  meKnown:          boolean;
  // Verified-creators count sampled from one representative asset in the
  // collection (same array for every mint in a drop) — only populated by
  // lookupSinglePool today; owner-scan leaves it undefined (no per-pool DAS
  // sample there, would multiply RPC cost across a whole wallet's pools).
  sampleCreatorsCount?: number | null;
  // Raw ME registry fields for poolType==='invalid' diagnostics. ME's
  // /mmm/pools?owner= listing can go stale for a pool it already wrote off
  // (confirmed Jul 2026: a topped-up pool still read buyOrdersAmount:0 from
  // a Feb-2025 snapshot) — surface these instead of trusting poolType alone.
  buysideCreatorRoyaltyBp?: number | null;
  buyOrdersAmount?:         number | null;
  meUpdatedAt?:             string | null;
  // ME-side kill-switch — set means this pool can never actually be
  // fulfilled regardless of how well-funded it looks (confirmed 2026-08-07:
  // a fully-funded 140 SOL SMB Gen2 pool, untouched since 2023, has this
  // set). Must gate any "profitable"/executable ranking, not just be
  // informational — a blocked pool with a huge funded balance is the
  // single worst false positive this scanner can produce.
  blockedAt?:               string | null;
}

export interface MmmPoolScanResult {
  ok:          true;
  owner:       string;
  total:       number;
  executable:  number;
  underfunded: number;
  diverged:    number;
  pools:       MmmPoolWithCollection[];
  scannedAt:   string;
}

async function scanOwnerPools(owner: string): Promise<MmmPoolScanResult> {
  // 1. getProgramAccounts with memcmp on owner field (offset 121)
  const result = await getProgramAccountsPaginated(MMM_PROGRAM_ID.toBase58(), {
    encoding:   'base64',
    commitment: 'confirmed',
    filters: [
      { dataSize: POOL_SIZE },
      { memcmp: { offset: OFF_OWNER, bytes: owner, encoding: 'base58' } },
    ],
  });

  // 2. Parse all pool configs
  const pools: MmmPool[] = [];
  for (const acct of result) {
    const p = parsePool(acct.pubkey, acct.account.data[0]);
    if (p) pools.push(p);
  }

  // 3. Batch fetch real escrow balances
  const balances = await fetchMultipleBalances(pools.map(p => p.fundingAccount));
  const hydrated  = pools.map(p => applyBalance(p, balances.get(p.fundingAccount) ?? 0));

  // 4. ME collection info (non-fatal)
  const meInfo = await fetchMeCollectionInfo(owner);

  // 5. Merge + rank: executable > missing asc > spot desc
  const merged: MmmPoolWithCollection[] = hydrated.map(p => {
    const me = meInfo.get(p.poolKey) ?? {};
    return {
      ...p,
      collectionName:   me.collectionName   ?? me.collectionSymbol ?? '',
      collectionSymbol: me.collectionSymbol ?? '',
      poolType:         me.poolType         ?? '',
      isMIP1:           me.isMIP1           ?? false,
      meKnown:          Object.keys(me).length > 0,
      blockedAt:        me.blockedAt        ?? null,
    };
  });

  merged.sort((a, b) => {
    if (a.executable !== b.executable) return a.executable ? -1 : 1;
    if (a.missing !== b.missing)       return a.missing - b.missing;
    return b.spotPrice - a.spotPrice;
  });

  const known = merged.filter(p => p.collectionName !== '');
  return {
    ok:          true,
    owner,
    total:       known.length,
    executable:  known.filter(p => p.executable).length,
    underfunded: known.filter(p => p.underfunded).length,
    diverged:    known.filter(p => p.diverged).length,
    pools:       known,
    scannedAt:   new Date().toISOString(),
  };
}

// ── DAS helpers ─────────────────────────────────────────────────────────────

interface DasAsset {
  id: string;
  interface?: string;
  content?: {
    metadata?: { name?: string; token_standard?: string };
    links?: { image?: string };
    files?: Array<{ uri?: string; cdn_uri?: string; mime?: string }>;
  };
  grouping?: Array<{ group_key: string; group_value: string }>;
  creators?: Array<{ address: string; verified: boolean }>;
  compression?: { compressed?: boolean; tree?: string; leaf_id?: number };
  token_info?: { token_program?: string };
}

// Fetch ALL wallet assets via getAssetsByOwner (object-params format required by Helius DAS)
// Audit #7 (research_backlog.md) D3: an HTTP error or thrown fetch/parse error
// mid-scan used to silently `break` and return whatever pages were already
// collected, indistinguishable from "wallet genuinely owns only N NFTs".
// `truncated` now tells the caller (and ultimately the API response) that
// the result may be an undercount, mirroring `tools-holders/fetch-assets.ts`.
async function getAllWalletAssets(wallet: string): Promise<{ assets: DasAsset[]; truncated: boolean }> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return { assets: [], truncated: false };
  const all: DasAsset[] = [];
  const PAGE_LIMIT = 1000;
  let truncated = false;
  for (let page = 1; page <= 20; page++) {
    try {
      const r = await fetch(`https://beta.helius-rpc.com/?api-key=${apiKey}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'getAssetsByOwner',
          params: {
            ownerAddress: wallet,
            page,
            limit: PAGE_LIMIT,
            displayOptions: { showFungible: false, showNativeBalance: false },
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) { truncated = true; break; }
      const j = await r.json() as { result?: { items?: DasAsset[]; total?: number } };
      const batch = j.result?.items ?? [];
      all.push(...batch);
      if (batch.length < PAGE_LIMIT) break;
    } catch { truncated = true; break; }
  }
  return { assets: all, truncated };
}

function assetMatchesAllowlist(asset: DasAsset, al: Allowlist): boolean {
  const pubkey = al.pubkey;
  switch (al.type) {
    case 'MCC':
    case 'core_collection':
    case 'group':
      return (asset.grouping ?? []).some(g => g.group_value === pubkey);
    case 'FVCA':
      return (asset.creators ?? []).some(c => c.address === pubkey && c.verified);
    case 'mint':
      return asset.id === pubkey;
    case 'any':
      return true;
    default:
      return false;
  }
}

const TOKEN_2022_PROGRAM_ID_STR = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';

export interface WalletNft {
  mint: string; name: string; imageUrl: string | null; compressed?: boolean;
  isPNFT: boolean; creatorsCount: number; isToken2022: boolean;
}

// Confirmed empirically (Jun 2026): pNFT + 5 verified creators in a legacy (non-ALT)
// MMM sol-fulfill-buy tx lands at exactly 1240 bytes — 8 over the 1232 network cap.
// pNFT + 3 creators fits; Legacy-standard NFTs have much more headroom regardless
// of creator count. Surfaced as a size-risk badge before the user hits Sell.
// Audit #7 (research_backlog.md) D1: the official Helius DAS `interface`
// enum also includes LEGACY_NFT / V2_NFT / MplBubblegumV2 / MplCoreCollection
// / MplCoreGroup — none of them imply pNFT status, so they're intentionally
// NOT added here. LEGACY_NFT/V2_NFT are non-programmable by definition;
// MplBubblegumV2 (cNFT) and MplCore* (collection/group accounts) are outside
// the legacy sol-fulfill-buy byte-size risk this check exists for.
function isProgrammable(asset: DasAsset): boolean {
  const std = asset.content?.metadata?.token_standard;
  return std === 'ProgrammableNonFungible' || std === 'ProgrammableNFT' || asset.interface === 'ProgrammableNFT';
}

function toWalletNft(asset: DasAsset): WalletNft {
  const img = asset.content?.links?.image
    ?? asset.content?.files?.find(f => f.mime?.startsWith('image/'))?.cdn_uri
    ?? asset.content?.files?.find(f => f.mime?.startsWith('image/'))?.uri
    ?? null;
  return {
    mint:          asset.id,
    name:          asset.content?.metadata?.name ?? asset.id.slice(0, 8),
    imageUrl:      img,
    compressed:    asset.compression?.compressed === true,
    isPNFT:        isProgrammable(asset),
    creatorsCount: asset.creators?.length ?? 0,
    // DAS `interface`/`token_standard` can both read as a plain legacy NFT
    // (e.g. Mutantmon: `interface: "V1_NFT"`) while the mint is actually
    // owned by the Token-2022 program — only `token_info.token_program`
    // reveals it. Confirmed 2026-07-02: getAssociatedTokenAddressSync()
    // called without the T22 program id derives a *different, nonexistent*
    // ATA for these mints, which ME's sol-fulfill-buy tx then references —
    // on-chain fails with AccountNotInitialized (payer_asset_account).
    isToken2022:   asset.token_info?.token_program === TOKEN_2022_PROGRAM_ID_STR,
  };
}

async function fetchWalletNftsForPool(
  wallet: string, pool: MmmPool,
): Promise<{ nfts: WalletNft[]; truncated: boolean }> {
  const allowlists = pool.allowlists.filter(al => al.type !== 'empty');
  if (!allowlists.length) return { nfts: [], truncated: false };

  const { assets: allAssets, truncated } = await getAllWalletAssets(wallet);

  const nfts = allAssets
    .filter(asset => allowlists.some(al => assetMatchesAllowlist(asset, al)))
    .map(toWalletNft);
  return { nfts, truncated };
}

// Manual lookup for a single mint — bypasses the wallet-holds-it-already requirement.
// Confirmed (Jul 2026) the "no matching NFTs" case is common when the user hasn't
// bought the target NFT yet (they're checking the pool before acquiring it) — same
// reasoning as 'any'-allowlist pools where every NFT is a valid candidate. Doesn't
// check ownership or allowlist match; the real bridge/on-chain attempt is the ground
// truth either way (matches the "always attempt, let ME's response decide" philosophy
// already used for poolType/royaltyBp above).
async function fetchAssetByMint(mint: string): Promise<WalletNft | null> {
  // Routed through the shared cached/deduped fetchAsset() (helius-das.ts)
  // instead of a raw getAsset POST — same underlying DAS payload, so the
  // cast below is safe: it just widens the shared helper's narrower return
  // type to this file's richer local `DasAsset` (id/compression/token_info
  // fields the shared type doesn't model but the real Helius response has).
  const asset = await fetchAsset(mint);
  if (!asset) return null;
  return toWalletNft(asset as unknown as DasAsset);
}

// ── On-chain sol_fulfill_buy builder ─────────────────────────────────────────
// Account layout verified from live txs (Jun 2026). 19 accounts, no remaining_accounts.

/** Legacy (non-pNFT) sol_fulfill_buy — 18 fixed accounts + one remaining
 *  account per on-chain creator (royalty payout targets), in metadata order. */
function buildSolFulfillBuyIx(
  pool:     MmmPool,
  poolPk:   PublicKey,
  sellerPk: PublicKey,
  mintPk:   PublicKey,
  creators: DecodedMetadata['creators'],
): TransactionInstruction {
  const MMM_PK     = MMM_PROGRAM_ID;
  const ownerPk    = new PublicKey(pool.owner);
  const cosignerPk = new PublicKey(pool.cosigner);
  const referralPk = new PublicKey(pool.referral);

  const [escrowPk] = PublicKey.findProgramAddressSync(
    [ESCROW_SEED, poolPk.toBuffer()], MMM_PK,
  );
  const [metadataPk] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METAPLEX_PROGRAM.toBuffer(), mintPk.toBuffer()],
    METAPLEX_PROGRAM,
  );
  const [editionPk] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METAPLEX_PROGRAM.toBuffer(), mintPk.toBuffer(), Buffer.from('edition')],
    METAPLEX_PROGRAM,
  );
  const [sellStatePk] = PublicKey.findProgramAddressSync(
    [SELL_STATE_SEED, poolPk.toBuffer(), mintPk.toBuffer()], MMM_PK,
  );

  const sellerAta = getAssociatedTokenAddressSync(mintPk, sellerPk, false);
  const poolAta   = getAssociatedTokenAddressSync(mintPk, poolPk, true);
  const ownerAta  = getAssociatedTokenAddressSync(mintPk, ownerPk, false);

  // min_payment_amount = spot * (10000 - taker_fee_bp) / 10000
  const minPayment = Math.floor(pool.spotPrice * 9800 / 10000);
  const data = Buffer.concat([SOL_FULFILL_BUY_DISC, serializeFulfillBuyArgs(minPayment)]);

  return new TransactionInstruction({
    programId: MMM_PK,
    data,
    keys: [
      { pubkey: sellerPk,                 isSigner: true,  isWritable: true  }, // [0] payer
      { pubkey: ownerPk,                  isSigner: false, isWritable: true  }, // [1] owner
      { pubkey: cosignerPk,               isSigner: false, isWritable: false }, // [2] cosigner (no-cosigner pool: passes as read-only)
      { pubkey: referralPk,               isSigner: false, isWritable: true  }, // [3] referral
      { pubkey: poolPk,                   isSigner: false, isWritable: true  }, // [4] pool
      { pubkey: escrowPk,                 isSigner: false, isWritable: true  }, // [5] escrow
      { pubkey: metadataPk,               isSigner: false, isWritable: false }, // [6] metadata
      { pubkey: editionPk,                isSigner: false, isWritable: false }, // [7] master_edition
      { pubkey: mintPk,                   isSigner: false, isWritable: false }, // [8] mint
      { pubkey: sellerAta,                isSigner: false, isWritable: true  }, // [9] payer_asset_account
      { pubkey: poolAta,                  isSigner: false, isWritable: true  }, // [10] sellside_asset_token_account
      { pubkey: ownerAta,                 isSigner: false, isWritable: true  }, // [11] owner_token_account
      { pubkey: SystemProgram.programId,  isSigner: false, isWritable: false }, // [12] allowlist_aux_account (None)
      { pubkey: sellStatePk,              isSigner: false, isWritable: true  }, // [13] sell_state
      { pubkey: SystemProgram.programId,  isSigner: false, isWritable: false }, // [14] system_program
      { pubkey: TOKEN_PROGRAM_ID,         isSigner: false, isWritable: false }, // [15] token_program
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // [16] associated_token_program
      { pubkey: SYSVAR_RENT_PUBKEY,       isSigner: false, isWritable: false }, // [17] rent
      ...sharedEscrowRemainingAccounts(pool),                                   // [18..19] m2_program + shared_escrow_account (shared-escrow pools only)
      ...creatorKeys(creators),                                                 // [18/20..] royalty creators (dynamic)
    ],
  });
}

/** pNFT sol_mip1_fulfill_buy — 25 fixed accounts (incl. token records +
 *  auth rules) + one remaining account per on-chain creator. Account order
 *  and token-record/rule_set derivation verified live 2026-08-07 against a
 *  real successful pNFT fulfill-buy tx. */
function buildSolMip1FulfillBuyIx(
  pool:     MmmPool,
  poolPk:   PublicKey,
  sellerPk: PublicKey,
  mintPk:   PublicKey,
  creators: DecodedMetadata['creators'],
  ruleSet:  string | null,
): TransactionInstruction {
  const MMM_PK     = MMM_PROGRAM_ID;
  const ownerPk    = new PublicKey(pool.owner);
  const cosignerPk = new PublicKey(pool.cosigner);
  const referralPk = new PublicKey(pool.referral);

  const [escrowPk] = PublicKey.findProgramAddressSync(
    [ESCROW_SEED, poolPk.toBuffer()], MMM_PK,
  );
  const [metadataPk] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METAPLEX_PROGRAM.toBuffer(), mintPk.toBuffer()],
    METAPLEX_PROGRAM,
  );
  const [editionPk] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METAPLEX_PROGRAM.toBuffer(), mintPk.toBuffer(), Buffer.from('edition')],
    METAPLEX_PROGRAM,
  );
  const [sellStatePk] = PublicKey.findProgramAddressSync(
    [SELL_STATE_SEED, poolPk.toBuffer(), mintPk.toBuffer()], MMM_PK,
  );

  const sellerAta = getAssociatedTokenAddressSync(mintPk, sellerPk, false);
  const poolAta   = getAssociatedTokenAddressSync(mintPk, poolPk, true);
  const ownerAta  = getAssociatedTokenAddressSync(mintPk, ownerPk, false);

  const tokenOwnerTokenRecord = tokenRecordPda(mintPk, sellerAta);
  const poolTokenRecord       = tokenRecordPda(mintPk, poolAta);
  const poolOwnerTokenRecord  = tokenRecordPda(mintPk, ownerAta);
  // Untested: no observed example of a ruleset-less pNFT fulfill-buy yet.
  // Metaplex convention for "no rule set" elsewhere is the token metadata
  // program id itself as sentinel — applied here defensively.
  const authorizationRulesPk = new PublicKey(ruleSet ?? METAPLEX_PROGRAM.toBase58());

  const minPayment = Math.floor(pool.spotPrice * 9800 / 10000);
  const data = Buffer.concat([SOL_MIP1_FULFILL_BUY_DISC, serializeFulfillBuyArgs(minPayment)]);

  return new TransactionInstruction({
    programId: MMM_PK,
    data,
    keys: [
      { pubkey: sellerPk,                 isSigner: true,  isWritable: true  }, // [0] payer
      { pubkey: ownerPk,                  isSigner: false, isWritable: true  }, // [1] owner
      { pubkey: cosignerPk,               isSigner: false, isWritable: false }, // [2] cosigner
      { pubkey: referralPk,               isSigner: false, isWritable: true  }, // [3] referral
      { pubkey: poolPk,                   isSigner: false, isWritable: true  }, // [4] pool
      { pubkey: escrowPk,                 isSigner: false, isWritable: true  }, // [5] escrow
      { pubkey: metadataPk,               isSigner: false, isWritable: true  }, // [6] metadata
      { pubkey: mintPk,                   isSigner: false, isWritable: false }, // [7] mint
      { pubkey: editionPk,                isSigner: false, isWritable: false }, // [8] master_edition
      { pubkey: sellerAta,                isSigner: false, isWritable: true  }, // [9] payer_asset_account
      { pubkey: poolAta,                  isSigner: false, isWritable: true  }, // [10] sellside_asset_token_account
      { pubkey: ownerAta,                 isSigner: false, isWritable: true  }, // [11] owner_token_account
      { pubkey: SystemProgram.programId,  isSigner: false, isWritable: false }, // [12] allowlist_aux_account (None)
      { pubkey: sellStatePk,              isSigner: false, isWritable: true  }, // [13] sell_state
      { pubkey: tokenOwnerTokenRecord,    isSigner: false, isWritable: true  }, // [14] token_owner_token_record
      { pubkey: poolTokenRecord,          isSigner: false, isWritable: true  }, // [15] pool_token_record
      { pubkey: poolOwnerTokenRecord,     isSigner: false, isWritable: true  }, // [16] pool_owner_token_record
      { pubkey: METAPLEX_PROGRAM,         isSigner: false, isWritable: false }, // [17] token_metadata_program
      { pubkey: AUTH_RULES_PROGRAM,       isSigner: false, isWritable: false }, // [18] authorization_rules_program
      { pubkey: authorizationRulesPk,     isSigner: false, isWritable: false }, // [19] authorization_rules
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false }, // [20] instructions
      { pubkey: SystemProgram.programId,  isSigner: false, isWritable: false }, // [21] system_program
      { pubkey: TOKEN_PROGRAM_ID,         isSigner: false, isWritable: false }, // [22] token_program
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // [23] associated_token_program
      { pubkey: SYSVAR_RENT_PUBKEY,       isSigner: false, isWritable: false }, // [24] rent
      ...sharedEscrowRemainingAccounts(pool),                                   // [25..26] m2_program + shared_escrow_account (shared-escrow pools only)
      ...creatorKeys(creators),                                                 // [25/27..] royalty creators (dynamic)
    ],
  });
}

// ── ME bid-accept tx proxy → on-chain fallback ────────────────────────────────

// Real ME instruction-building host — NOT api-mainnet.magiceden.dev (that
// domain's /mmm/pools/{key}/instruction/sol-fulfill-buy path is dead, always
// 400 "Not Found", confirmed 2026-08-07). ME's own frontend/userscript calls
// this .io host + /v2/instructions/mmm/ path instead. ME_BASE (.dev) is still
// correct for the /mmm/pools?owner= list endpoint used elsewhere in this file.
const ME_IXS_BASE = 'https://api-mainnet.magiceden.io/v2/instructions/mmm';

/** True iff `mintPk` is owned by the MPL Core program rather than the SPL
 *  Token program — i.e. it's a Core asset, not a Token Metadata NFT (legacy
 *  or pNFT). Core assets have no Metadata PDA / ATA / token account at all,
 *  so this must be checked before attempting the Token Metadata decode path. */
async function isMplCoreAsset(mintPk: PublicKey): Promise<boolean> {
  const result = await rpcPost('getAccountInfo', [mintPk.toBase58(), { encoding: 'base64' }]) as
    { value: { owner: string } | null };
  return result.value?.owner === MPL_CORE_PROGRAM_ID.toBase58();
}

/** Shared v0+ALT (fallback: legacy) serialization for any already-built
 *  fulfill-buy instruction — used by both the Token Metadata and MPL Core
 *  on-chain builders below. */
async function serializeOnchainIx(ix: TransactionInstruction, sellerPk: PublicKey): Promise<Uint8Array> {
  let bhResult: { value: { blockhash: string; lastValidBlockHeight: number } };
  try {
    bhResult = await rpcPost('getLatestBlockhash', [{ commitment: 'confirmed' }]) as typeof bhResult;
    console.log('[fallback] blockhash=%s lastValidBlockHeight=%s', bhResult.value.blockhash, bhResult.value.lastValidBlockHeight);
  } catch (e) {
    console.error('[fallback] getLatestBlockhash threw:', (e instanceof Error ? e.stack : String(e)));
    throw e;
  }

  // v0 versioned tx + shared ALT: compresses the fixed accounts every
  // fulfill-buy repeats (mmm program, token/ATA/rent/instructions sysvars,
  // metadata program) into 1-byte refs — required for 5-creator pNFTs to
  // fit under the 1232-byte cap. Falls back to legacy tx if the ALT can't
  // be fetched (still correct for low-creator-count NFTs, just no headroom).
  try {
    const alt = await fetchMmmSharedAlt();
    const message = new TransactionMessage({
      payerKey: sellerPk,
      recentBlockhash: bhResult.value.blockhash,
      instructions: [ix],
    }).compileToV0Message([alt]);
    const vtx = new VersionedTransaction(message);
    const serialized = vtx.serialize();
    console.log('[fallback] v0 serialize OK, byteLength=%s', serialized.length);
    return serialized;
  } catch (e) {
    console.warn('[fallback] ALT/v0 build failed, falling back to legacy tx:', (e instanceof Error ? e.message : String(e)));
    const tx = new Transaction();
    tx.add(ix);
    tx.feePayer        = sellerPk;
    tx.recentBlockhash = bhResult.value.blockhash;
    const serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    console.log('[fallback] legacy serialize OK, byteLength=%s', serialized.length);
    return serialized;
  }
}

/** MPL Core on-chain builder path. No ME REST endpoint for Core fulfill-buy
 *  has been found (confirmed 2026-08-07: /v2/instructions/mmm/sol-fulfill-buy
 *  requires assetTokenAccount unconditionally, which Core assets don't have;
 *  every guessed sibling path — sol-mpl-core-fulfill-buy, mpl-core-sol-
 *  fulfill-buy, etc. — 404s) — goes straight to the on-chain builder, same
 *  me_cosigner_required guard as the Token Metadata path for pools with a
 *  real ME cosigner. */
async function fetchCoreBidAcceptTx(
  poolKey: string,
  seller:  string,
  mint:    string,
): Promise<{ txBase64: string; source: 'onchain' }> {
  const poolPk   = new PublicKey(poolKey);
  const sellerPk = new PublicKey(seller);
  const assetPk  = new PublicKey(mint);

  const coreInfo = await fetchCoreAssetInfo(mint);
  console.log('[fallback] core asset decoded: collection=%s creators=%s', coreInfo.collection, JSON.stringify(coreInfo.creators));
  if (!coreInfo.collection) throw new Error('core_collection_not_found');

  const poolResult = await lookupSinglePool(poolKey);
  if (poolResult.type !== 'pool') throw new Error('pool_not_found');
  const pool = poolResult.pool;

  if (pool.cosigner !== SystemProgram.programId.toBase58()) {
    console.log('[fallback] BLOCKED: pool requires a real cosigner signature, cosigner=%s', pool.cosigner);
    throw new Error('me_cosigner_required: no known ME endpoint for MPL Core fulfill-buy (on-chain builder cannot provide a cosigner signature)');
  }

  const ix = buildSolMplCoreFulfillBuyIx(
    pool, poolPk, sellerPk, assetPk, new PublicKey(coreInfo.collection), coreInfo.creators);
  const serialized = await serializeOnchainIx(ix, sellerPk);
  return { txBase64: Buffer.from(serialized).toString('base64'), source: 'onchain' };
}

export async function fetchBidAcceptTx(
  poolKey: string,
  seller:  string,
  mint:    string,
): Promise<{ txBase64: string; source: 'me_api' | 'onchain' }> {
  const poolPk   = new PublicKey(poolKey);
  const sellerPk = new PublicKey(seller);
  const mintPk   = new PublicKey(mint);

  if (await isMplCoreAsset(mintPk)) {
    console.log('[fallback] mint=%s is an MPL Core asset — routing to Core builder', mint);
    return fetchCoreBidAcceptTx(poolKey, seller, mint);
  }

  const [metadataPk] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METAPLEX_PROGRAM.toBuffer(), mintPk.toBuffer()], METAPLEX_PROGRAM);

  // Read the NFT's real on-chain creators (+ pNFT token_standard/rule_set)
  // directly off its Metadata account up front — needed both to build the
  // correct ME API request (assetTokenAccount + tokenStandard=4 for pNFT)
  // and, if ME fails, for the on-chain fallback below. Authoritative source
  // for royalty remaining_accounts; do NOT reuse a single hardcoded creator
  // account across pools.
  let meta: DecodedMetadata;
  try {
    meta = await fetchMetadataAccount(metadataPk);
    console.log('[fallback] metadata decoded: tokenStandard=%s creators=%s ruleSet=%s',
      meta.tokenStandard, JSON.stringify(meta.creators), meta.ruleSet);
  } catch (e) {
    console.error('[fetchBidAcceptTx] fetchMetadataAccount threw:', (e instanceof Error ? e.stack : String(e)));
    throw e;
  }
  const isPNFT = meta.tokenStandard === 4; // ProgrammableNonFungible
  const sellerAta = getAssociatedTokenAddressSync(mintPk, sellerPk, false);

  // Pool lookup moved up front (was previously only done in the on-chain
  // fallback branch) — needed *before* deciding what to do with an
  // oversized ME-built tx below, not just when ME's HTTP call itself fails.
  let poolResult: Awaited<ReturnType<typeof lookupSinglePool>>;
  try {
    poolResult = await lookupSinglePool(poolKey);
  } catch (e) {
    console.error('[fallback] lookupSinglePool threw:', (e instanceof Error ? e.stack : String(e)));
    throw e;
  }
  console.log('[fallback] lookupSinglePool type=%s', poolResult.type);
  if (poolResult.type !== 'pool') throw new Error('pool_not_found');
  const pool = poolResult.pool;
  console.log('[fallback] pool decoded: owner=%s cosigner=%s referral=%s spotPriceSol=%s expiry=%s isMIP1=%s',
    pool.owner, pool.cosigner, pool.referral, pool.spotPriceSol, pool.expiry, pool.isMIP1);
  console.log('[fallback] pool allowlists: %s', JSON.stringify(pool.allowlists));
  console.log('[fallback] pool escrowPda=%s realEscrowSol=%s executable=%s', pool.escrowPda, pool.realEscrowSol, pool.executable);
  const hasRealCosigner = pool.cosigner !== SystemProgram.programId.toBase58();

  // Try ME API first (returns fully cosigned tx). ME builds this as a
  // legacy (non-versioned, non-ALT) tx — fine for low creator counts, but
  // pNFT + ~5 verified creators regularly blows past Solana's 1232-byte
  // wire limit. Past behavior trusted ME's 200 OK response blindly and
  // shipped that oversized tx straight to the wallet, which is exactly
  // where "Transaction too large" was surfacing — bypassing the on-chain
  // ALT-based builder below entirely, since that only ran when ME's HTTP
  // call itself failed, not when ME succeeded with a too-big result.
  // Fix: check the returned tx's actual byte length before trusting it.
  const TX_WIRE_LIMIT = 1232;
  try {
    const url = `${ME_IXS_BASE}/sol-fulfill-buy`
      + `?pool=`                 + encodeURIComponent(poolKey)
      + `&seller=`               + encodeURIComponent(seller)
      + `&assetMint=`            + encodeURIComponent(mint)
      + `&assetTokenAccount=`    + encodeURIComponent(sellerAta.toBase58())
      + `&assetAmount=1`
      + `&minPaymentAmount=0`
      + (isPNFT ? '&tokenStandard=4' : '');

    const r = await fetch(url, {
      headers: {
        'User-Agent': 'VictoryLabs/1.0',
        ...meAuthHeaders(),
      },
      signal:  AbortSignal.timeout(15_000),
    });

    if (r.ok) {
      const data = await r.json() as { tx?: { data?: number[] }; txSigned?: { data?: number[] } };
      const src  = data.txSigned ?? data.tx;
      if (src?.data && Array.isArray(src.data)) {
        if (src.data.length <= TX_WIRE_LIMIT) {
          return { txBase64: Buffer.from(src.data).toString('base64'), source: 'me_api' };
        }
        console.warn(`[tools/mmm-pools] ME tx for ${poolKey} is ${src.data.length} bytes (> ${TX_WIRE_LIMIT}), isPNFT=${isPNFT} creators=${meta.creators.length}`);
        if (hasRealCosigner) {
          // ME's tx already carries their own cosigner signature over this
          // exact message — we cannot rebuild it as v0+ALT ourselves
          // without invalidating that signature (a versioned message
          // compiles to different bytes even for an equivalent account
          // set), and we have no way to get ME to re-sign a smaller one.
          // Genuine dead end, not a bug we can route around here.
          throw new Error(
            `me_tx_too_large_cosigned: ME-built tx is ${src.data.length} bytes (limit ${TX_WIRE_LIMIT}) `
            + `and this pool requires ME's cosigner signature, so it can't be rebuilt as a versioned/ALT tx client-side`);
        }
        // No real cosigner required — ME's tx isn't load-bearing for
        // signing, only for correctness. Discard it and fall through to
        // the on-chain ALT-based builder below, same as an ME API failure.
        console.log('[tools/mmm-pools] oversized ME tx + no cosigner required — falling through to on-chain ALT builder');
      }
    } else {
      // ME API failed — fall through to on-chain builder
      console.warn(`[tools/mmm-pools] ME API ${r.status} for ${poolKey}, trying on-chain builder`);
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('me_tx_too_large_cosigned')) throw e;
    console.warn(`[tools/mmm-pools] ME API error for ${poolKey}:`, e);
  }

  // On-chain fallback: verify no ME cosigner required (pool already looked
  // up above, before the ME API attempt).
  console.log('[fallback] PATH=onchain poolKey=%s seller=%s mint=%s', poolKey, seller, mint);

  if (hasRealCosigner) {
    console.log('[fallback] BLOCKED: pool requires a real cosigner signature, cosigner=%s', pool.cosigner);
    throw new Error('me_cosigner_required: ME API unavailable for this pool and it requires a cosigner signature (on-chain builder cannot provide one)');
  }
  console.log('[fallback] cosigner check passed (default/no cosigner)');

  let ix: TransactionInstruction;
  try {
    ix = isPNFT
      ? buildSolMip1FulfillBuyIx(pool, poolPk, sellerPk, mintPk, meta.creators, meta.ruleSet)
      : buildSolFulfillBuyIx(pool, poolPk, sellerPk, mintPk, meta.creators);
    console.log('[fallback] build%sFulfillBuyIx OK (isPNFT=%s, %s creators)',
      isPNFT ? 'SolMip1' : 'SolFulfillBuy', isPNFT, meta.creators.length);
  } catch (e) {
    console.error('[fallback] build fulfill-buy ix threw:', (e instanceof Error ? e.stack : String(e)));
    throw e;
  }

  const serialized = await serializeOnchainIx(ix, sellerPk);
  return { txBase64: Buffer.from(serialized).toString('base64'), source: 'onchain' };
}

// ── Single-pool lookup ───────────────────────────────────────────────────────

export type MmmPoolLookupResult =
  | { ok: true; type: 'pool';   pool: MmmPoolWithCollection; scannedAt: string }
  | { ok: true; type: 'escrow'; input: string; lamports: number; sol: number; scannedAt: string };

async function lookupSinglePool(key: string): Promise<MmmPoolLookupResult> {
  const result = await rpcPost('getAccountInfo', [
    key,
    { encoding: 'base64', commitment: 'confirmed' },
  ]) as { value: { data: [string, string]; lamports: number } | null };

  if (!result.value) throw new Error('account_not_found');

  const dataB64: string = Array.isArray(result.value.data) ? result.value.data[0] : '';
  const raw = dataB64 ? Buffer.from(dataB64, 'base64') : null;

  if (!raw || raw.length !== POOL_SIZE) {
    return {
      ok: true, type: 'escrow',
      input:    key,
      lamports: result.value.lamports,
      sol:      result.value.lamports / 1e9,
      scannedAt: new Date().toISOString(),
    };
  }

  const pool = parsePool(key, dataB64);
  if (!pool) throw new Error('parse_failed');

  const balances = await fetchMultipleBalances([pool.fundingAccount]);
  const hydrated  = applyBalance(pool, balances.get(pool.fundingAccount) ?? 0);

  const meInfo = await fetchMeCollectionInfo(pool.owner);
  const me     = meInfo.get(pool.poolKey) ?? {};

  // ME API sometimes misses isMIP1 (e.g. owner lookup returns empty).
  // Fall back to fvcaInfoCache (populated by pool-stream scans), then DAS.
  // Also samples verified-creators count off the same DAS item — confirmed
  // empirically (Jun 2026): pNFT + 5 creators busts the legacy 1232B tx cap.
  // Surfaced here (pool level, before the buyer owns any matching NFT) since
  // every asset in a collection shares the same creators array from mint —
  // no need to already hold the NFT to know the size risk in advance.
  let isMIP1 = me.isMIP1 ?? false;
  let sampleCreatorsCount: number | undefined;
  const fvcaAl = pool.allowlists.find(al => al.type === 'FVCA' || al.type === 'MCC');
  if (fvcaAl) {
    const cached = fvcaInfoCache.get(fvcaAl.pubkey);
    if (cached?.tokenStandard && cached.sampleCreatorsCount !== undefined) {
      if (!isMIP1) isMIP1 = cached.tokenStandard === 'ProgrammableNonFungible' || cached.tokenStandard === 'ProgrammableNFT';
      sampleCreatorsCount = cached.sampleCreatorsCount;
    } else {
      // DAS searchAssets: sample one NFT from the collection
      try {
        const dasRes = await fetch(rpcUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'searchAssets',
            params: { creatorAddress: fvcaAl.pubkey, creatorVerified: true, limit: 1, page: 1 } }),
          signal: AbortSignal.timeout(8_000),
        });
        const dasJson = dasRes.ok ? await dasRes.json() as {
          result?: { items?: Array<{ content?: { metadata?: { token_standard?: string } }; interface?: string; creators?: Array<{ address: string }> }> };
        } : {};
        const item = dasJson.result?.items?.[0];
        const tokenStd = item?.content?.metadata?.token_standard || item?.interface || '';
        sampleCreatorsCount = item?.creators?.length;
        if (tokenStd || sampleCreatorsCount !== undefined) {
          if (!isMIP1 && tokenStd) isMIP1 = tokenStd === 'ProgrammableNonFungible' || tokenStd === 'ProgrammableNFT';
          // Populate cache for future pool-stream scans + single-pool lookups
          const existing = fvcaInfoCache.get(fvcaAl.pubkey);
          fvcaInfoCache.set(fvcaAl.pubkey, {
            name:          existing?.name ?? '',
            slug:          existing?.slug ?? '',
            cachedAt:      Date.now(),
            tokenStandard: tokenStd || existing?.tokenStandard,
            sampleCreatorsCount,
          });
          saveFvcaInfoCacheDebounced();
        }
      } catch { /* non-fatal */ }
    }
  }

  return {
    ok: true, type: 'pool',
    pool: {
      ...hydrated,
      collectionName:   me.collectionName   ?? me.collectionSymbol ?? '',
      collectionSymbol: me.collectionSymbol ?? '',
      poolType:         me.poolType         ?? '',
      isMIP1,
      meKnown: Object.keys(me).length > 0,
      sampleCreatorsCount: sampleCreatorsCount ?? null,
      buysideCreatorRoyaltyBp: me.buysideCreatorRoyaltyBp ?? null,
      buyOrdersAmount:         me.buyOrdersAmount         ?? null,
      meUpdatedAt:             me.updatedAt               ?? null,
      blockedAt:               me.blockedAt               ?? null,
    },
    scannedAt: new Date().toISOString(),
  };
}

// ── Triage collection types + cache ──────────────────────────────────────────
// 'core_collection' included as of 2026-08-07: the earlier exclusion was
// based on one failed two_sided Core pool (a real, separate, already-known
// block — see [[project_mmm_two_sided_pooltype_real_block]] — that applies
// regardless of asset type, not something specific to Core). Since then a
// real MPL Core sol_mpl_core_fulfill_buy sale was confirmed live on-chain
// (Curved Cats, one-sided pool), and the accept path now has a verified
// on-chain builder for Core (buildSolMplCoreFulfillBuyIx). No reason left to
// blanket-exclude Core pools from Pool Feed / triage scan results.
const COLL_AL_TYPES = new Set(['FVCA', 'MCC', 'group', 'core_collection']);

export interface TriageCollection {
  alType:          string;
  alKey:           string;
  count:           number;
  bestPct:         number;
  avgPct:          number;
  bestPool:        string;
  bestSpotSol:     number;
  bestRealSol:     number;   // 0 in fast mode
  bestMissingSol:  number;
  totalMissingSol: number;
  tier:            'HIGH' | 'LOW' | 'VERY_LOW' | 'SKIP';
  collectionName:  string;   // resolved via DAS (empty if unknown)
  collectionSlug:  string;   // resolved via reverse slug cache (empty if unknown)
}

interface TriageCacheEntry {
  collections:      TriageCollection[];
  totalPools:       number;
  underfundedTotal: number;
  collectionCount:  number;
  mode:             'full' | 'fast';
  builtAt:          number;  // Date.now()
}

// In-memory triage cache (keyed by mode). Separate TTLs so a fresh full-mode
// run doesn't evict the fast-mode cache and vice-versa.
const triageCache: { full?: TriageCacheEntry; fast?: TriageCacheEntry } = {};
const TRIAGE_CACHE_TTL_MS = 20 * 60 * 1000; // 20 minutes

// Flat pool list cache — populated as a side-effect of every triage run.
// Used by pool-stream so it doesn't need a separate scan.
interface FlatPool {
  poolKey:        string;
  escrowPda:      string;   // top-up/funding address: shared_escrow_account when sharedEscrow, else the pool's own escrow PDA
  sharedEscrow:   boolean;
  owner:          string;
  spotPriceSol:   number;
  realEscrowSol:  number;
  missingSol:     number;
  pct:            number;    // realEscrow / spotPrice * 100
  alType:         string;
  alKey:          string;
  collectionName: string;
  isMIP1:         boolean;
  anyOnly:        boolean;   // allowlist type 'any' — invisible to FVCA/MCC-scoped scans
}
let rawPoolsCache: { pools: FlatPool[]; builtAt: number } | null = null;
// Separate cache for the "include any-allowlist pools" pool-stream mode — kept apart from
// rawPoolsCache (FVCA/MCC-scoped, also fed by triage-stream) so toggling doesn't cross-serve.
let rawPoolsCacheAny: { pools: FlatPool[]; builtAt: number } | null = null;

// Append-only trend log for fresh (non-cached) scans — totalPools / collectionCount
// over time, so "does the candidate pool keeps changing or is it stuck" is a grep
// away instead of a guess. Non-fatal: a write failure never breaks the scan response.
const SCAN_STATS_LOG = path.join(__dirname, '../../data/mmm-pool-scan-stats.jsonl');
async function logScanStats(stats: Record<string, unknown>): Promise<void> {
  try {
    await fsp.appendFile(SCAN_STATS_LOG, JSON.stringify({ ts: new Date().toISOString(), ...stats }) + '\n', 'utf8');
  } catch { /* non-fatal */ }
}

// Collections whose legacy NFTs are no longer actively traded (migrated to Core etc.)
// Pools under these FVCAs are structurally valid but practically unsellable.
const FVCA_FEED_BLOCKLIST = new Set([
  '2So3Y3AT7MFkK8P6LqgP2yBCJouuDpSp1gYZmDDFxay3', // Honeyland Generations (migrated to Core)
]);

// FVCA → collection info cache (populated by resolve-slug and batchResolveFvcaNames).
// Keyed by FVCA address; long TTL because creator/name never change post-mint.
type FvcaInfo = { name: string; slug: string; cachedAt: number; tokenStandard?: string; sampleCreatorsCount?: number };
const fvcaInfoCache = new Map<string, FvcaInfo>();
const FVCA_INFO_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// Negative cache for FVCAs that failed to resolve a name (DAS searchAssets
// returned nothing / errored — usually a dead/rugged collection with no
// indexed assets). Without this, a failed FVCA is never written to
// fvcaInfoCache, so it stays "missing" forever and keeps re-consuming the
// top-200-per-scan resolution budget every single run (confirmed Jul 2026:
// two back-to-back scans grew the cache by +1 then +111 — most of the
// budget was being burned re-attempting the same unresolvable set instead
// of reaching new candidates). Short TTL (vs 24h success TTL) so a
// collection that gets indexed later still gets picked up reasonably soon.
// In-memory only (not disk-persisted) — a restart just costs one extra
// wasted retry per dead FVCA, not worth the added complexity.
const fvcaFailCache = new Map<string, number>(); // fvca → failedAt
const FVCA_FAIL_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

// Disk-backed so a pm2 restart doesn't wipe every resolved collection name —
// batchResolveFvcaNames only resolves ~200 new/expired names per scan (Helius
// rate-limit budget), so out of ~800 underfunded collections it can take 4+
// scans to fully repopulate an empty cache. Confirmed Jul 2026: a backend
// restart made previously-visible pools vanish from pool-stream results
// (filtered out for empty collectionName) until re-resolved scan-by-scan,
// looking exactly like "new" pools reappearing days later.
const FVCA_CACHE_FILE = path.join(__dirname, '../../data/mmm-fvca-info-cache.json');

(function loadFvcaInfoCacheFromDisk(): void {
  try {
    const raw = fs.readFileSync(FVCA_CACHE_FILE, 'utf8');
    const entries = JSON.parse(raw) as Array<[string, FvcaInfo]>;
    for (const [k, v] of entries) fvcaInfoCache.set(k, v);
    console.log(`[tools/mmm-pools] loaded ${fvcaInfoCache.size} cached collection names from disk`);
  } catch { /* first boot or corrupt file — start empty, non-fatal */ }
})();

let fvcaCacheSaveTimer: ReturnType<typeof setTimeout> | null = null;
function saveFvcaInfoCacheDebounced(): void {
  if (fvcaCacheSaveTimer) return;
  fvcaCacheSaveTimer = setTimeout(() => {
    fvcaCacheSaveTimer = null;
    const entries = [...fvcaInfoCache.entries()];
    fsp.writeFile(FVCA_CACHE_FILE, JSON.stringify(entries), 'utf8').catch(() => { /* non-fatal */ });
  }, 2_000);
}

// Persistent, never-expiring ledger of every poolKey pool-stream has ever shown.
// Deliberately separate from rawPoolsCache/rawPoolsCacheAny (20-min TTL) — a
// stale/cleared/rebuilt scan cache or a pm2 restart must never make an
// existing pool look "new" again. Only a poolKey that has genuinely never
// been recorded here gets the NEW badge, and it's recorded permanently the
// first time it's shown, regardless of which cache branch served it.
const KNOWN_POOL_KEYS_FILE = path.join(__dirname, '../../data/mmm-known-pool-keys.json');
const knownPoolFirstSeen = new Map<string, number>(); // poolKey -> firstSeenAt (epoch ms)

(function loadKnownPoolKeysFromDisk(): void {
  try {
    const raw = fs.readFileSync(KNOWN_POOL_KEYS_FILE, 'utf8');
    const entries = JSON.parse(raw) as Array<[string, number]>;
    for (const [k, v] of entries) knownPoolFirstSeen.set(k, v);
    console.log(`[tools/mmm-pools] loaded ${knownPoolFirstSeen.size} known pool keys from disk`);
  } catch { /* first boot or corrupt file — start empty, non-fatal */ }
})();

let knownPoolKeysSaveTimer: ReturnType<typeof setTimeout> | null = null;
function saveKnownPoolKeysDebounced(): void {
  if (knownPoolKeysSaveTimer) return;
  knownPoolKeysSaveTimer = setTimeout(() => {
    knownPoolKeysSaveTimer = null;
    fsp.writeFile(KNOWN_POOL_KEYS_FILE, JSON.stringify([...knownPoolFirstSeen.entries()]), 'utf8')
      .catch(() => { /* non-fatal */ });
  }, 2_000);
}

/** Tag isNew on each pool in `toReturn` (true the first time its poolKey has
 *  ever been recorded), then permanently record every key in `allScanned` —
 *  the FULL unfiltered scan result, not just the min_pct-thresholded subset
 *  being displayed. Recording only what's shown would let a poolKey that
 *  exists but sits below today's threshold get flagged "new" later, the
 *  first time a lower min_pct (or the any-mode toggle) brings it into view.
 *  Independent of the 20-min scan-result cache, so re-serving a
 *  cached/rebuilt list never re-flags an existing pool. */
function tagNewPools(allScanned: FlatPool[], toReturn: FlatPool[]): Array<FlatPool & { isNew: boolean }> {
  const now = Date.now();
  const tagged = toReturn.map(p => ({ ...p, isNew: !knownPoolFirstSeen.has(p.poolKey) }));
  let dirty = false;
  for (const p of allScanned) {
    if (!knownPoolFirstSeen.has(p.poolKey)) { knownPoolFirstSeen.set(p.poolKey, now); dirty = true; }
  }
  if (dirty) saveKnownPoolKeysDebounced();
  return tagged;
}

// ME API fetch helper for bulk name/slug resolution. These are public
// endpoints (no auth required to succeed), but attaching the shared key
// avoids Cloudflare's tighter per-IP limit on keyless calls — same
// rationale as meAuthHeaders()'s own doc comment.
async function meFetchBulk(url: string) {
  return fetch(url, {
    headers: { Accept: 'application/json', ...meAuthHeaders() },
    signal: AbortSignal.timeout(8_000),
  });
}

// Given a single NFT mint address, resolve ME collection slug + canonical name.
// Uses ME /v2/tokens/{mint} → `collection` (ME slug) + /v2/collections/{slug} → `name`.
// Returns null on any failure (non-fatal caller).
async function resolveCollectionFromMint(mint: string): Promise<{ slug: string; name: string } | null> {
  try {
    const tokRes = await meFetchBulk(
      `https://api-mainnet.magiceden.dev/v2/tokens/${encodeURIComponent(mint)}`,
    );
    if (tokRes.status === 429) { setMeCooldown(60_000); return null; }
    if (!tokRes.ok) return null;
    const tok = await tokRes.json() as {
      collection?: string;       // ME slug
      collectionName?: string;   // canonical name (sometimes present)
      name?: string;             // NFT name e.g. "Open Solmap #12345"
    };
    const slug = tok.collection ?? '';
    if (!slug) return null;

    // Use collectionName if ME provides it; otherwise fetch from /v2/collections/{slug}
    let name = tok.collectionName ?? '';
    if (!name) {
      try {
        const colRes = await meFetchBulk(
          `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(slug)}`,
        );
        if (colRes.ok) {
          const col = await colRes.json() as { name?: string };
          name = col.name ?? '';
        }
      } catch { /* non-fatal */ }
    }
    // Last resort: strip number from NFT name
    if (!name && tok.name) name = tok.name.replace(/\s+#\s*\d+$/, '').trim();
    return { slug, name };
  } catch {
    return null;
  }
}

// Batch-resolve collection names + ME slugs for a list of FVCA/allowlist keys.
// Three-step chain; each step is non-fatal:
//
//   1. DAS searchAssets(key) → first NFT mint + NFT symbol/baseName fallback + collection mint
//      (collection mint is the Metaplex collection NFT address, from grouping[0].group_value)
//   2. DAS getAsset(collectionMint) → canonical on-chain collection name (no ME rate-limit risk)
//   3. ME /v2/tokens/{mint} → ME slug — ONLY if ME cooldown is not active, capped at low concurrency
//
// Populates fvcaInfoCache in-place.
// fvcas must be pre-sorted by importance (most pools first) so rate-limit
// budget is spent on the most valuable collections.
async function batchResolveFvcaNames(fvcas: string[]): Promise<void> {
  const DAS_CONCURRENCY = 3;   // Helius rate-limits hard; keep pressure low
  const DAS_BATCH_DELAY = 50;  // ms between DAS batches (~60 req/s max)
  const ME_CONCURRENCY  = 2;
  const ME_BATCH_DELAY  = 150;

  const missing = fvcas.filter(f => {
    const hit = fvcaInfoCache.get(f);
    if (hit && Date.now() - hit.cachedAt <= FVCA_INFO_TTL_MS) return false;
    const failedAt = fvcaFailCache.get(f);
    if (failedAt && Date.now() - failedAt <= FVCA_FAIL_TTL_MS) return false;
    return true;
  });
  if (!missing.length) return;
  // fvcas is pre-sorted by pool count desc — cap DAS queries to top 200 to
  // avoid Helius rate limits while still covering all HIGH-tier collections.
  const toResolve = missing.slice(0, 200);

  // ── Step 1: DAS searchAssets → mint + collection mint + fallback name ──────
  const mintMap    = new Map<string, string>(); // fvca → first NFT mint
  const colMintMap = new Map<string, string>(); // fvca → collection mint (from grouping)

  for (let i = 0; i < toResolve.length; i += DAS_CONCURRENCY) {
    await Promise.all(toResolve.slice(i, i + DAS_CONCURRENCY).map(async fvca => {
      try {
        const res = await fetch(rpcUrl(), {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'searchAssets',
            params:  { creatorAddress: fvca, creatorVerified: true, limit: 1, page: 1 },
          }),
          signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) return;
        const data = await res.json() as {
          result?: {
            items?: Array<{
              id?: string;
              interface?: string;
              content?: { metadata?: { name?: string; symbol?: string; token_standard?: string } };
              grouping?: Array<{ group_key?: string; group_value?: string }>;
            }>;
          };
        };
        if (!data.result?.items?.length) return;
        const item   = data.result.items[0];
        const mintId = item?.id ?? '';
        if (mintId) mintMap.set(fvca, mintId);

        // Metaplex collection NFT address (grouping key = "collection")
        const colMint = item?.grouping?.find(g => g.group_key === 'collection')?.group_value ?? '';
        if (colMint) colMintMap.set(fvca, colMint);

        // DAS fallback name (symbol or stripped NFT name) — overwritten in steps 2/3
        const meta     = item?.content?.metadata;
        const symbol   = meta?.symbol ?? '';
        const rawName  = meta?.name   ?? '';
        const baseName = rawName.replace(/\s+#\s*\d+$/, '').trim();
        const dasName  = (symbol.length > 2) ? symbol : baseName;
        // Prefer content.metadata.token_standard (reliable) over interface (can be "Custom")
        const tokenStd = meta?.token_standard || item?.interface || '';
        const existing = fvcaInfoCache.get(fvca);
        fvcaInfoCache.set(fvca, {
          name:          dasName || existing?.name || '',
          slug:          existing?.slug ?? '',
          cachedAt:      Date.now(),
          tokenStandard: tokenStd || existing?.tokenStandard || '',
        });
      } catch { /* non-fatal */ }
    }));
    if (i + DAS_CONCURRENCY < toResolve.length) {
      await new Promise(r => setTimeout(r, DAS_BATCH_DELAY));
    }
  }

  // ── Step 2: DAS getAsset(collectionMint) → canonical name ────────────────
  // Uses the Metaplex collection NFT's on-chain metadata, no ME calls needed.
  const hasColMint = toResolve.filter(f => colMintMap.has(f));

  for (let i = 0; i < hasColMint.length; i += DAS_CONCURRENCY) {
    await Promise.all(hasColMint.slice(i, i + DAS_CONCURRENCY).map(async fvca => {
      const colMint = colMintMap.get(fvca)!;
      try {
        // Shared cached/deduped fetchAsset() (helius-das.ts) instead of a
        // raw getAsset POST — same 8s timeout the direct call used.
        const asset   = await fetchAsset(colMint);
        const colName = asset?.content?.metadata?.name ?? '';
        if (colName) {
          const existing = fvcaInfoCache.get(fvca);
          fvcaInfoCache.set(fvca, { name: colName, slug: existing?.slug ?? '', cachedAt: Date.now(), tokenStandard: existing?.tokenStandard });
        }
      } catch { /* non-fatal */ }
    }));
  }

  // Anything still nameless after steps 1+2 (dead/rugged FVCA, DAS found
  // nothing, or a transient error) — negative-cache it so it stops
  // re-consuming the top-200 budget every scan. Step 3 (ME slug) can't
  // rescue a name-less entry since it only runs for fvcas already in
  // mintMap (i.e. step 1 already succeeded).
  const failedNow = toResolve.filter(f => !fvcaInfoCache.get(f)?.name);
  if (failedNow.length) {
    const now = Date.now();
    for (const f of failedNow) fvcaFailCache.set(f, now);
  }

  // ── Step 3: ME /v2/tokens/{mint} → ME slug (rate-limit aware) ────────────
  // Skip entirely if the process-wide ME cooldown is active to avoid piling on.
  // Cap at top 30 — we'll hit rate-limit anyway, so prioritise the biggest pools.
  if (meCooldownActive()) { saveFvcaInfoCacheDebounced(); return; }

  const needSlug = toResolve
    .filter(f => mintMap.has(f) && !fvcaInfoCache.get(f)?.slug)
    .slice(0, 30);

  for (let i = 0; i < needSlug.length; i += ME_CONCURRENCY) {
    if (meCooldownActive()) break;
    await Promise.all(needSlug.slice(i, i + ME_CONCURRENCY).map(async fvca => {
      if (meCooldownActive()) return;
      const mint = mintMap.get(fvca)!;
      const result = await resolveCollectionFromMint(mint);
      if (result) {
        fvcaInfoCache.set(fvca, { name: result.name || (fvcaInfoCache.get(fvca)?.name ?? ''), slug: result.slug, cachedAt: Date.now(), tokenStandard: fvcaInfoCache.get(fvca)?.tokenStandard });
      }
    }));
    if (i + ME_CONCURRENCY < needSlug.length) {
      await new Promise(r => setTimeout(r, ME_BATCH_DELAY));
    }
  }
  saveFvcaInfoCacheDebounced();
}

export function createMmmPoolsRouter(): Router {
  const router = Router();
  const limit  = rateLimit({ limit: 10, windowMs: 60_000, label: 'tools/mmm-pools' });
  // tx-status is a cheap read-only confirmation poll, not a pool action —
  // sharing the 10/min pool-action budget meant a single multi-item Candy
  // Mint batch (each item polled several times while waiting to land)
  // burned through it by itself: the first couple of items confirmed
  // instantly, then every later item's poll 429'd for up to the rest of the
  // 60s window (looked like a random multi-second stall on item 5 of 5).
  const txStatusLimit = rateLimit({ limit: 120, windowMs: 60_000, label: 'tools/mmm-pools/tx-status' });

  // ── Triage SSE stream ──────────────────────────────────────────────────────
  // GET /api/tools/mmm-pools/triage-stream?min_pct=5&fast=0&force=0
  //
  // fast=1  → skip getMultipleAccounts entirely, use on-chain bpa as proxy.
  //           0 balance-fetch credits. Slightly less accurate but fast.
  // force=1 → bypass the in-memory cache and re-run a full scan.
  //
  // Result is cached per mode (full/fast) for 20 min. Subsequent requests
  // within the TTL are served instantly at 0 RPC credit cost.
  router.get('/tools/mmm-pools/triage-stream',
    rateLimit({ limit: 4, windowMs: 120_000, label: 'tools/mmm-triage' }),
    requireAuth,
    async (req: Request, res: Response) => {
      const minPct = Math.max(0, Math.min(100,
        parseFloat(String(req.query.min_pct ?? '5')) || 5));
      const fast  = req.query.fast  === '1';
      const force = req.query.force === '1';
      const mode  = fast ? 'fast' : 'full';

      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders();

      const emit = (type: string, payload: Record<string, unknown>) => {
        try { res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`); }
        catch { /* client disconnected */ }
      };

      try {
        // ── Serve from cache if fresh ────────────────────────────────────────
        const cached = triageCache[mode];
        if (!force && cached && Date.now() - cached.builtAt < TRIAGE_CACHE_TTL_MS) {
          const ageMin  = Math.floor((Date.now() - cached.builtAt) / 60_000);
          const ageSec  = Math.floor((Date.now() - cached.builtAt) / 1_000) % 60;
          const ageStr  = ageMin > 0 ? `${ageMin}m ${ageSec}s` : `${ageSec}s`;
          emit('progress', { msg: `Cached result (${ageStr} old, TTL 20m) — 0 RPC calls`, cached: true });
          emit('result', {
            ...cached,
            minPct,
            cached:       true,
            cacheAgeMs:   Date.now() - cached.builtAt,
          });
          return res.end();
        }

        // ── Live scan ────────────────────────────────────────────────────────
        // NOTE 2026-08-07: previously filtered to expiry==0 ("infinite-lifetime")
        // pools only. Dropped that filter — confirmed live (real fulfilled sale,
        // pool sitting 2 years) that MMM's fulfill_buy does not reject a pool for
        // having a past/nonzero expiry, so excluding those pools at the RPC level
        // was silently hiding real, fulfillable underfunded pools.
        emit('progress', { msg: `Fetching all MMM pools${fast ? ' [fast mode]' : ''}...` });

        const accounts = await getProgramAccountsPaginated(MMM_PROGRAM_ID.toBase58(), {
          encoding:   'base64',
          commitment: 'confirmed',
          filters: [
            { dataSize: POOL_SIZE },
          ],
        }, 180_000);

        emit('progress', { msg: `Got ${accounts.length} pools, parsing...` });

        // Pre-filter on bpa (no RPC needed, local parse only)
        // Confirmed live 2026-08-08 (simulateTransaction on an expired pool):
        // MMM's fulfill_buy rejects a pool whose expiry has passed with
        // AnchorError 6014 "Expired" — only expiry==0 or a still-future expiry
        // is actually fulfillable.
        const nowSec = Math.floor(Date.now() / 1000);
        const candidates: MmmPool[] = [];
        for (const acct of accounts) {
          const p = parsePool(acct.pubkey, acct.account.data[0]);
          if (!p) continue;
          if (!(p.bpa > 0 && p.bpa < p.spotPrice)) continue;
          if (!(p.expiry === 0 || p.expiry > nowSec)) continue;
          if (!p.allowlists.some(al => COLL_AL_TYPES.has(al.type))) continue;
          candidates.push(p);
        }

        let underfunded: MmmPool[];

        if (fast) {
          // Fast mode: treat bpa as the real balance — 0 getMultipleAccounts calls.
          // bpa is the on-chain tracked deposit; it diverges from the actual PDA balance
          // only when SOL was added/removed outside the MMM contract (rare). Good enough
          // for broad triage; use full mode to verify top candidates.
          emit('progress', { msg: `${candidates.length} candidates (fast mode — using tracked bpa, no balance fetch)` });
          underfunded = candidates.map(p => applyBalance(p, p.bpa));
          // After applyBalance with bpa: executable only if bpa >= spot, which we already
          // filtered out (bpa < spot), so all candidates are "underfunded" here.
          underfunded = underfunded.filter(p => !p.executable && p.realEscrow >= MIN_VISIBLE_ESCROW_LAMPORTS);
        } else {
          // Full mode: fetch real escrow balances via getMultipleAccounts batches.
          // Cost: ceil(candidates.length / 100) RPC calls.
          emit('progress', {
            msg: `${candidates.length} candidates — fetching real escrow balances (${Math.ceil(candidates.length / 100)} batch calls)...`,
          });
          const balances = await fetchMultipleBalances(candidates.map(p => p.fundingAccount));
          const hydrated = candidates.map(p => applyBalance(p, balances.get(p.fundingAccount) ?? 0));
          underfunded = hydrated.filter(p => p.realEscrow >= MIN_VISIBLE_ESCROW_LAMPORTS && !p.executable);
        }

        emit('progress', { msg: `${underfunded.length} underfunded pools — grouping by collection...` });

        // Group by primary collection allowlist key
        const groups = new Map<string, { alType: string; alKey: string; pools: MmmPool[] }>();
        for (const p of underfunded) {
          const al = p.allowlists.find(a => COLL_AL_TYPES.has(a.type));
          if (!al) continue;
          const gk = al.pubkey;
          if (!groups.has(gk)) groups.set(gk, { alType: al.type, alKey: al.pubkey, pools: [] });
          groups.get(gk)!.pools.push(p);
        }

        // Batch-resolve names+slugs. Sort by pool count descending so Helius
        // rate-limit budget is spent on the collections with the most pools first.
        const uniqueFvcas = [...groups.entries()]
          .sort((a, b) => b[1].pools.length - a[1].pools.length)
          .map(([k]) => k);
        emit('progress', { msg: `Resolving names for ${uniqueFvcas.length} collections...` });
        await batchResolveFvcaNames(uniqueFvcas);

        const tierOrd: Record<string, number> = { HIGH: 0, LOW: 1, VERY_LOW: 2, SKIP: 3 };
        let collections: TriageCollection[] = [];

        for (const [, g] of groups) {
          const pcts    = g.pools.map(p => p.realEscrow / p.spotPrice * 100);
          const bestPct = Math.max(...pcts);
          const avgPct  = pcts.reduce((a, b) => a + b, 0) / pcts.length;
          const best    = g.pools.reduce((a, b) =>
            (a.realEscrow / a.spotPrice > b.realEscrow / b.spotPrice ? a : b));
          const t: TriageCollection['tier'] =
            bestPct >= 20 ? 'HIGH' : bestPct >= 5 ? 'LOW' : bestPct >= 2.1 ? 'VERY_LOW' : 'SKIP';
          const info = fvcaInfoCache.get(g.alKey);

          collections.push({
            alType:          g.alType,
            alKey:           g.alKey,
            count:           g.pools.length,
            bestPct:         Math.round(bestPct * 10) / 10,
            avgPct:          Math.round(avgPct  * 10) / 10,
            bestPool:        best.poolKey,
            bestSpotSol:     best.spotPriceSol,
            bestRealSol:     fast ? 0 : best.realEscrowSol,
            bestMissingSol:  best.missingSol,
            totalMissingSol: Math.round(g.pools.reduce((s, p) => s + p.missing, 0) / 1e9 * 10000) / 10000,
            tier:            t,
            collectionName:  info?.name ?? '',
            collectionSlug:  info?.slug ?? '',
          });
        }

        // Drop collections ME doesn't recognise — their sol-fulfill-buy returns 500
        collections = collections.filter(c => c.collectionName !== '');

        collections.sort((a, b) => {
          const da = tierOrd[a.tier] ?? 3;
          const db = tierOrd[b.tier] ?? 3;
          if (da !== db) return da - db;
          if (a.count !== b.count) return b.count - a.count;
          return b.bestPct - a.bestPct;
        });

        // Populate flat pool cache for pool-stream
        rawPoolsCache = {
          builtAt: Date.now(),
          pools: underfunded.filter(p => !p.allowlists.some(a => a.type === 'metadata') && !p.allowlists.some(a => FVCA_FEED_BLOCKLIST.has(a.pubkey))).map(p => {
            const al = p.allowlists.find(a => COLL_AL_TYPES.has(a.type));
            const info = al ? fvcaInfoCache.get(al.pubkey) : undefined;
            return {
              poolKey:        p.poolKey,
              escrowPda:      p.fundingAccount,
              sharedEscrow:   p.usingSharedEscrow,
              owner:          p.owner,
              spotPriceSol:   p.spotPriceSol,
              realEscrowSol:  p.realEscrowSol,
              missingSol:     p.missingSol,
              pct:            p.spotPrice > 0 ? p.realEscrow / p.spotPrice * 100 : 0,
              alType:         al?.type ?? '',
              alKey:          al?.pubkey ?? '',
              collectionName: info?.name ?? '',
              isMIP1:         info?.tokenStandard === 'ProgrammableNonFungible' || info?.tokenStandard === 'ProgrammableNFT',
              anyOnly:        false,
            };
          }),
        };

        // Store in cache
        triageCache[mode] = {
          collections,
          totalPools:       accounts.length,
          underfundedTotal: underfunded.length,
          collectionCount:  collections.length,
          mode,
          builtAt:          Date.now(),
        };
        void logScanStats({
          source: 'triage-stream', mode,
          totalPools: accounts.length, candidates: candidates.length,
          underfundedTotal: underfunded.length, collectionCount: collections.length,
        });

        emit('result', {
          collections,
          totalPools:       accounts.length,
          underfundedTotal: underfunded.length,
          collectionCount:  collections.length,
          minPct,
          cached:           false,
          cacheAgeMs:       0,
          fast,
        });

      } catch (e) {
        console.error('[tools/mmm-pools] triage-stream error', e);
        emit('error', { msg: String(e) });
      }

      res.end();
    },
  );

  // ── Pool-stream SSE ───────────────────────────────────────────────────────
  // GET /api/tools/mmm-pools/pool-stream?min_pct=50&fast=1&force=0&any=1
  // Returns individual underfunded pools sorted by % funded desc.
  // Reuses rawPoolsCache populated by the most recent triage run (20-min TTL).
  //
  // any=1 — also includes pools whose ONLY collection-scoped allowlist entry is
  // type 'any' ("buy any NFT" bids). These have no FVCA/MCC to group or name by,
  // so they're excluded from COLL_AL_TYPES and from triage entirely. Cached
  // separately (rawPoolsCacheAny) so toggling the mode never cross-serves.
  router.get(
    '/tools/mmm-pools/pool-stream',
    limit,
    requireAuth,
    (req: Request, res: Response) => {
      const minPct     = parseFloat(req.query['min_pct'] as string ?? '50') || 50;
      const force       = req.query['force'] === '1';
      const fast        = req.query['fast']  !== '0'; // default true
      const includeAny  = req.query['any']   === '1';
      const cacheRef     = () => includeAny ? rawPoolsCacheAny : rawPoolsCache;
      const setCacheRef  = (v: { pools: FlatPool[]; builtAt: number }) => {
        if (includeAny) rawPoolsCacheAny = v; else rawPoolsCache = v;
      };

      res.setHeader('Content-Type',  'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection',    'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      const emit = (type: string, data: Record<string, unknown>) => {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
      };

      void (async () => {
        try {
          // Use cache if fresh
          const cached = cacheRef();
          if (!force && cached && Date.now() - cached.builtAt < TRIAGE_CACHE_TTL_MS) {
            const filtered = cached.pools
              .filter(p => p.pct >= minPct)
              .sort((a, b) => b.pct - a.pct);
            emit('progress', { msg: `Cached (${Math.floor((Date.now() - cached.builtAt) / 60_000)}m ago) — ${filtered.length} pools ≥${minPct}%`, cached: true });
            emit('result', { pools: tagNewPools(cached.pools, filtered), cached: true, cacheAgeMs: Date.now() - cached.builtAt });
            return res.end();
          }

          // Fresh scan
          // NOTE 2026-08-07: previously filtered to expiry==0 ("infinite-lifetime")
          // pools only. Dropped that filter — confirmed live (real fulfilled sale,
          // pool sitting 2 years) that MMM's fulfill_buy does not reject a pool for
          // having a past/nonzero expiry, so excluding those pools at the RPC level
          // was silently hiding real, fulfillable underfunded pools.
          emit('progress', { msg: `Fetching all MMM pools${fast ? ' [fast]' : ''}…` });
          const accounts = await getProgramAccountsPaginated(MMM_PROGRAM_ID.toBase58(), {
            encoding:   'base64',
            commitment: 'confirmed',
            filters: [
              { dataSize: POOL_SIZE },
            ],
          }, 180_000);

          emit('progress', { msg: `${accounts.length} pools — filtering candidates…` });

          // Confirmed live 2026-08-08 (simulateTransaction on an expired pool):
          // MMM's fulfill_buy rejects a pool whose expiry has passed with
          // AnchorError 6014 "Expired" — a past-expiry pool is NOT fulfillable,
          // only expiry==0 (infinite) or a still-future expiry works.
          const nowSec = Math.floor(Date.now() / 1000);
          const candidates: MmmPool[] = [];
          for (const acct of accounts) {
            const p = parsePool(acct.pubkey, acct.account.data[0]);
            if (!p) continue;
            if (!(p.bpa > 0 && p.bpa < p.spotPrice)) continue;
            if (!(p.expiry === 0 || p.expiry > nowSec)) continue;
            const hasCollAl = p.allowlists.some(al => COLL_AL_TYPES.has(al.type));
            const hasAnyAl  = includeAny && p.allowlists.some(al => al.type === 'any');
            if (!hasCollAl && !hasAnyAl) continue;
            candidates.push(p);
          }

          let underfunded: MmmPool[];
          if (fast) {
            underfunded = candidates.map(p => applyBalance(p, p.bpa))
              .filter(p => !p.executable && p.realEscrow >= MIN_VISIBLE_ESCROW_LAMPORTS);
          } else {
            emit('progress', { msg: `Fetching real escrow balances (${Math.ceil(candidates.length / 100)} calls)…` });
            const balances = await fetchMultipleBalances(candidates.map(p => p.fundingAccount));
            underfunded = candidates.map(p => applyBalance(p, balances.get(p.fundingAccount) ?? 0))
              .filter(p => p.realEscrow >= MIN_VISIBLE_ESCROW_LAMPORTS && !p.executable);
          }

          // Resolve collection names (same logic as triage — sort by pool count so
          // Helius rate-limit budget goes to the most pool-heavy collections first).
          const fvcaGroups = new Map<string, number>();
          for (const p of underfunded) {
            const al = p.allowlists.find(a => COLL_AL_TYPES.has(a.type));
            if (al) fvcaGroups.set(al.pubkey, (fvcaGroups.get(al.pubkey) ?? 0) + 1);
          }
          const uniqueFvcas = [...fvcaGroups.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([k]) => k);
          emit('progress', { msg: `Resolving names for ${uniqueFvcas.length} collections…` });
          await batchResolveFvcaNames(uniqueFvcas);

          // Populate flat cache and resolve names from fvcaInfoCache
          const flatPools: FlatPool[] = underfunded.filter(p => !p.allowlists.some(a => a.type === 'metadata') && !p.allowlists.some(a => FVCA_FEED_BLOCKLIST.has(a.pubkey))).map(p => {
            const al        = p.allowlists.find(a => COLL_AL_TYPES.has(a.type));
            const isAnyPool = !al && p.allowlists.some(a => a.type === 'any');
            const info      = al ? fvcaInfoCache.get(al.pubkey) : undefined;
            return {
              poolKey:        p.poolKey,
              escrowPda:      p.fundingAccount,
              sharedEscrow:   p.usingSharedEscrow,
              owner:          p.owner,
              spotPriceSol:   p.spotPriceSol,
              realEscrowSol:  p.realEscrowSol,
              missingSol:     p.missingSol,
              pct:            p.spotPrice > 0 ? p.realEscrow / p.spotPrice * 100 : 0,
              alType:         al?.type ?? (isAnyPool ? 'any' : ''),
              alKey:          al?.pubkey ?? '',
              // Unresolved FVCA name is NOT a sellability signal (confirmed empirically
              // on multiple pools) — fall back to a short address label instead of
              // dropping the pool entirely, so unresolved-name collections stay visible.
              collectionName: info?.name || (isAnyPool ? '(Any NFT)' : (al ? `Unknown (${al.pubkey.slice(0, 6)}…)` : '')),
              isMIP1:         info?.tokenStandard === 'ProgrammableNonFungible' || info?.tokenStandard === 'ProgrammableNFT',
              anyOnly:        isAnyPool,
            };
          });
          const knownFlatPools = flatPools.filter(p => p.realEscrowSol >= MIN_VISIBLE_ESCROW_LAMPORTS / 1e9);
          setCacheRef({ pools: knownFlatPools, builtAt: Date.now() });
          void logScanStats({
            source: 'pool-stream', includeAny,
            totalPools: accounts.length, candidates: candidates.length,
            underfundedTotal: underfunded.length, collectionCount: uniqueFvcas.length,
          });

          const filtered = knownFlatPools.filter(p => p.pct >= minPct).sort((a, b) => b.pct - a.pct);
          emit('progress', { msg: `${filtered.length} pools ≥${minPct}% funded${includeAny ? ' (incl. any-NFT bids)' : ''}` });
          emit('result', { pools: tagNewPools(knownFlatPools, filtered), cached: false, cacheAgeMs: 0 });
        } catch (e) {
          emit('error', { msg: String(e) });
        }
        res.end();
      })();
    },
  );

  // Proxy sendRawTransaction through Helius so the browser doesn't hit the public RPC
  // (which returns 403 for sendTransaction from browser origins).
  router.post('/tools/mmm-pools/send-tx', limit, requireAuth, async (req: Request, res: Response) => {
    const { tx } = req.body as { tx?: string };
    if (!tx || typeof tx !== 'string') {
      return res.status(400).json({ ok: false, error: 'missing_tx' });
    }
    try {
      const result = await rpcPost('sendTransaction', [
        tx,
        { encoding: 'base64', skipPreflight: true, maxRetries: 3, preflightCommitment: 'confirmed' },
      ]) as string;
      return res.json({ ok: true, signature: result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/mmm-pools] send-tx error', msg);
      return res.status(502).json({ ok: false, error: 'rpc_error', message: msg });
    }
  });

  // Verify a submitted transaction landed on-chain.
  // Returns immediately with the current status (caller should poll if not_found).
  router.get('/tools/mmm-pools/tx-status', txStatusLimit, requireAuth, async (req: Request, res: Response) => {
    const sig = String(req.query.sig ?? '').trim();
    if (!sig || !/^[1-9A-HJ-NP-Za-km-z]{80,100}$/.test(sig)) {
      return res.status(400).json({ ok: false, error: 'invalid_sig' });
    }
    try {
      const result = await rpcPost('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]) as {
        value: Array<{ slot: number; confirmations: number | null; confirmationStatus: string; err: unknown } | null>
      };
      const entry = result.value[0];
      if (!entry) {
        return res.json({ ok: true, found: false, confirmationStatus: null, err: null });
      }
      return res.json({
        ok: true,
        found: true,
        confirmationStatus: entry.confirmationStatus,
        err: entry.err ?? null,
      });
    } catch (err) {
      console.error('[tools/mmm-pools] tx-status error', err);
      return res.status(502).json({ ok: false, error: 'rpc_error', message: String(err) });
    }
  });

  // Manual mint lookup — fallback for when the connected wallet doesn't hold a
  // matching NFT yet (e.g. checking a pool before buying the target NFT).
  router.get('/tools/mmm-pools/manual-nft', limit, requireAuth, async (req: Request, res: Response) => {
    const mint = String(req.query.mint ?? '').trim();
    if (!mint || !ADDR_RE.test(mint)) {
      return res.status(400).json({ ok: false, error: 'invalid_params' });
    }
    try {
      const nft = await fetchAssetByMint(mint);
      if (!nft) return res.status(404).json({ ok: false, error: 'not_found' });
      return res.json({ ok: true, nft });
    } catch (err) {
      console.error('[tools/mmm-pools] manual-nft error', err);
      return res.status(502).json({ ok: false, error: 'rpc_error', message: String(err) });
    }
  });

  router.get('/tools/mmm-pools/wallet-nfts', limit, requireAuth, async (req: Request, res: Response) => {
    const wallet  = String(req.query.wallet ?? '').trim();
    const poolKey = String(req.query.pool   ?? '').trim();
    if (!wallet || !ADDR_RE.test(wallet) || !poolKey || !ADDR_RE.test(poolKey)) {
      return res.status(400).json({ ok: false, error: 'invalid_params' });
    }
    try {
      const result = await lookupSinglePool(poolKey);
      if (result.type !== 'pool') return res.json({ ok: true, nfts: [], truncated: false });
      const { nfts, truncated } = await fetchWalletNftsForPool(wallet, result.pool);
      return res.json({ ok: true, nfts, truncated });
    } catch (err) {
      console.error('[tools/mmm-pools] wallet-nfts error', err);
      return res.status(502).json({ ok: false, error: 'rpc_error', message: String(err) });
    }
  });

  router.get('/tools/mmm-pools/bid-accept-tx', limit, requireAuth, async (req: Request, res: Response) => {
    const poolKey = String(req.query.pool   ?? '').trim();
    const seller  = String(req.query.seller ?? '').trim();
    const mint    = String(req.query.mint   ?? '').trim();
    if (!poolKey || !ADDR_RE.test(poolKey) || !seller || !ADDR_RE.test(seller) || !mint || !ADDR_RE.test(mint)) {
      return res.status(400).json({ ok: false, error: 'invalid_params' });
    }
    try {
      const result = await fetchBidAcceptTx(poolKey, seller, mint);
      return res.json({ ok: true, ...result });
    } catch (err) {
      const msg = String(err);
      console.error('[tools/mmm-pools] bid-accept-tx error', err);
      if (msg.includes('me_cosigner_required')) {
        return res.status(422).json({ ok: false, error: 'me_cosigner_required',
          message: 'ME API does not recognize this pool — it cannot be accepted (pool may be expired or not indexed by ME).' });
      }
      if (msg.includes('pool_not_found')) {
        return res.status(404).json({ ok: false, error: 'pool_not_found', message: 'Pool not found on-chain.' });
      }
      return res.status(502).json({ ok: false, error: 'bid_accept_error', message: msg });
    }
  });

  router.get('/tools/mmm-pools/pool', limit, requireAuth, async (req: Request, res: Response) => {
    const key = String(req.query.key ?? '').trim();
    if (!key || !ADDR_RE.test(key)) {
      return res.status(400).json({ ok: false, error: 'invalid_address' });
    }
    try { new PublicKey(key); } catch {
      return res.status(400).json({ ok: false, error: 'invalid_address' });
    }
    try {
      const result = await lookupSinglePool(key);
      return res.json(result);
    } catch (err) {
      const msg = String(err);
      if (msg.includes('account_not_found')) {
        return res.status(404).json({ ok: false, error: 'account_not_found' });
      }
      console.error('[tools/mmm-pools] lookup error', err);
      return res.status(502).json({ ok: false, error: 'rpc_error', message: msg });
    }
  });

  // ── Collection underfunded pool scan ──────────────────────────────────────
  // GET /api/tools/mmm-pools/collection-scan?fvca=<pubkey>[&mcc=<pubkey>]
  //   or ?symbol=<me-collection-slug>  (for collections with no FVCA/MCC — any-allowlist pools)
  // Returns active (non-expired) pools for a collection where
  // 0 < realEscrow < spotPrice — the "ghost bids" that can execute on-chain
  // if topped up but are invisible in the ME UI.
  // For symbol path, returns ALL active pools (executable + underfunded).
  router.get('/tools/mmm-pools/collection-scan', rateLimit({ limit: 6, windowMs: 60_000, label: 'tools/mmm-collection-scan' }), requireAuth, async (req: Request, res: Response) => {
    const fvca   = String(req.query.fvca   ?? '').trim();
    const mcc    = String(req.query.mcc    ?? '').trim();
    const symbol = String(req.query.symbol ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!fvca && !mcc && !symbol) {
      return res.status(400).json({ ok: false, error: 'missing_params', message: 'fvca, mcc, or symbol required' });
    }
    if (fvca && !ADDR_RE.test(fvca)) return res.status(400).json({ ok: false, error: 'invalid_fvca' });
    if (mcc  && !ADDR_RE.test(mcc))  return res.status(400).json({ ok: false, error: 'invalid_mcc' });

    // ── Symbol path: fetch pools from ME by collectionSymbol ────────────────
    if (symbol && !fvca && !mcc) {
      try {
        const now = Math.floor(Date.now() / 1000);
        const meUrl = `https://api-mainnet.magiceden.io/v2/mmm/pools?collectionSymbol=${encodeURIComponent(symbol)}&filterOnSide=1&limit=100`;
        const meResp = await fetch(meUrl, { headers: { Accept: 'application/json', ...meAuthHeaders() }, signal: AbortSignal.timeout(8_000) });
        if (!meResp.ok) return res.status(502).json({ ok: false, error: 'me_api_error', message: `ME ${meResp.status}` });
        const meData = await meResp.json() as { results?: Array<{ poolKey?: string }> };
        const poolKeys = (meData.results ?? []).map(p => p.poolKey).filter((k): k is string => !!k);

        if (poolKeys.length === 0) {
          return res.json({ ok: true, fvca: null, mcc: null, symbol, collectionName: '', collectionSlug: symbol, totalFound: 0, expired: 0, activeTotal: 0, executable: 0, underfunded: 0, emptyEscrow: 0, pools: [], scannedAt: new Date().toISOString() });
        }

        // Batch-fetch on-chain pool accounts
        const acctResp = await rpcPost('getMultipleAccounts', [
          poolKeys,
          { encoding: 'base64', commitment: 'confirmed' },
        ]) as { value: Array<{ data: [string, string] } | null> };

        const allPools: MmmPool[] = [];
        for (let i = 0; i < poolKeys.length; i++) {
          const acct = acctResp.value[i];
          if (!acct) continue;
          const p = parsePool(poolKeys[i], acct.data[0]);
          if (p) allPools.push(p);
        }

        const balances  = await fetchMultipleBalances(allPools.map(p => p.fundingAccount));
        const hydrated  = allPools.map(p => applyBalance(p, balances.get(p.fundingAccount) ?? 0));
        const isActive  = (p: MmmPool) => p.expiry === 0 || p.expiry > now;
        const active    = hydrated.filter(isActive);
        const expired   = hydrated.length - active.length;
        const executable   = active.filter(p => p.executable);
        const underfunded  = active.filter(p => !p.executable && p.realEscrow >= MIN_VISIBLE_ESCROW_LAMPORTS);
        const emptyEscrow  = active.filter(p => p.realEscrow < MIN_VISIBLE_ESCROW_LAMPORTS);

        // Return all active pools (executable first, then underfunded by missing asc)
        const pools = [
          ...executable.sort((a, b) => b.spotPrice - a.spotPrice),
          ...underfunded.sort((a, b) => a.missing - b.missing),
        ];

        let collectionName = '';
        try {
          const colResp = await meFetchBulk(`https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(symbol)}`);
          if (colResp.ok) collectionName = ((await colResp.json() as { name?: string }).name) ?? '';
        } catch { /* non-fatal */ }

        return res.json({
          ok: true, fvca: null, mcc: null, symbol, collectionName, collectionSlug: symbol,
          totalFound: hydrated.length, expired, activeTotal: active.length,
          executable: executable.length, underfunded: underfunded.length, emptyEscrow: emptyEscrow.length,
          pools,
          scannedAt: new Date().toISOString(),
        });
      } catch (err) {
        console.error('[tools/mmm-pools] collection-scan symbol error', err);
        return res.status(502).json({ ok: false, error: 'rpc_error', message: String(err) });
      }
    }

    try {
      const now = Math.floor(Date.now() / 1000);
      const seen = new Map<string, { pubkey: string; account: { data: [string, string] } }>();

      // Try all 4 collection allowlist types for each provided pubkey.
      // A pool is stored with exactly one type per slot; we don't know which
      // the bidder chose, so we probe all variants and dedup by pool key.
      // Types: FVCA=1, MCC=3, group=5, core_collection=6
      const ALL_COLL_TYPES = [1, 3, 5, 6] as const;
      const queries: Array<{ type: 1 | 3 | 5 | 6; pubkey: string }> = [];
      for (const t of ALL_COLL_TYPES) {
        if (fvca) queries.push({ type: t, pubkey: fvca });
        if (mcc && mcc !== fvca) queries.push({ type: t, pubkey: mcc });
      }

      for (const q of queries) {
        const creatorBuf = new PublicKey(q.pubkey).toBuffer();
        // 33-byte allowlist entry: 1-byte type + 32-byte pubkey, base58-encoded for memcmp
        const matchBuf = Buffer.concat([Buffer.from([q.type]), creatorBuf]);
        const matchB58 = bs58.encode(matchBuf);

        for (let slot = 0; slot < 6; slot++) {
          const offset = OFF_AL + slot * 33;
          const result = await getProgramAccountsPaginated(MMM_PROGRAM_ID.toBase58(), {
            encoding:   'base64',
            commitment: 'confirmed',
            filters: [
              { dataSize: POOL_SIZE },
              { memcmp: { offset, bytes: matchB58 } },
            ],
          });
          for (const acct of result) seen.set(acct.pubkey, acct);
        }
      }

      const accounts = Array.from(seen.values());
      const allPools: MmmPool[] = [];
      for (const acct of accounts) {
        const p = parsePool(acct.pubkey, acct.account.data[0]);
        if (p) allPools.push(p);
      }

      // Fetch real escrow balances
      const balances = await fetchMultipleBalances(allPools.map(p => p.fundingAccount));
      const hydrated  = allPools.map(p => applyBalance(p, balances.get(p.fundingAccount) ?? 0));

      // Classify
      const isActive      = (p: MmmPool) => p.expiry === 0 || p.expiry > now;
      const active        = hydrated.filter(isActive);
      const expired       = hydrated.length - active.length;
      const executable    = active.filter(p => p.executable);
      const underfunded   = active.filter(p => !p.executable && p.realEscrow >= MIN_VISIBLE_ESCROW_LAMPORTS);
      const emptyEscrow   = active.filter(p => p.realEscrow < MIN_VISIBLE_ESCROW_LAMPORTS);

      // Sort underfunded by missing ASC (closest to executable first)
      underfunded.sort((a, b) => a.missing - b.missing);

      // Resolve collection name for the scanned FVCA (non-fatal, uses 24h cache).
      // DAS searchAssets → Tensor find_collection chain; slugCache may already have it.
      let collectionName = '';
      let collectionSlug = '';
      const scanKey = fvca || mcc;
      if (scanKey) {
        const cached = fvcaInfoCache.get(scanKey);
        if (cached && Date.now() - cached.cachedAt < FVCA_INFO_TTL_MS) {
          collectionName = cached.name;
          collectionSlug = cached.slug;
        } else {
          try { await batchResolveFvcaNames([scanKey]); } catch { /* non-fatal */ }
          const info = fvcaInfoCache.get(scanKey);
          collectionName = info?.name ?? '';
          collectionSlug = info?.slug ?? '';
        }
      }

      return res.json({
        ok:             true,
        fvca:           fvca || null,
        mcc:            mcc  || null,
        collectionName,
        collectionSlug,
        totalFound:     hydrated.length,
        expired,
        activeTotal:    active.length,
        executable:     executable.length,
        underfunded:    underfunded.length,
        emptyEscrow:    emptyEscrow.length,
        pools:          underfunded,
        scannedAt:      new Date().toISOString(),
      });
    } catch (err) {
      console.error('[tools/mmm-pools] collection-scan error', err);
      return res.status(502).json({ ok: false, error: 'rpc_error', message: String(err) });
    }
  });

  // Persistent in-process slug→FVCA cache. slug→FVCA mapping is immutable
  // (collection creators don't change after mint), so TTL is intentionally long.
  const slugCache = new Map<string, { fvca: string; mcc: string; collectionName: string; cachedAt: number }>();
  const SLUG_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

  // Resolve a ME collection slug → first verified creator (FVCA) via ME listings + Helius DAS.
  router.get('/tools/mmm-pools/resolve-slug', limit, requireAuth, async (req: Request, res: Response) => {
    const slug = String(req.query.slug ?? '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
    if (!slug) return res.status(400).json({ ok: false, error: 'missing_slug' });

    // Serve from cache — slug→FVCA never changes post-mint
    const hit = slugCache.get(slug);
    if (hit && Date.now() - hit.cachedAt < SLUG_CACHE_TTL_MS) {
      return res.json({ ok: true, fvca: hit.fvca || null, mcc: hit.mcc || null, collectionName: hit.collectionName, slug, cached: true });
    }

    try {
      let mint = '';
      for (let attempt = 0; attempt < 3 && !mint; attempt++) {
        if (attempt > 0) await new Promise(r => setTimeout(r, 600 * attempt));
        const meRes = await fetch(
          `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(slug)}/listings?offset=0&limit=5`,
          { headers: { Accept: 'application/json', ...meAuthHeaders() }, signal: AbortSignal.timeout(8_000) },
        );
        if (meRes.status === 404) return res.status(404).json({ ok: false, error: 'collection_not_found' });
        if (!meRes.ok) {
          if (attempt === 2) return res.status(502).json({ ok: false, error: `me_api_${meRes.status}`, message: 'ME API unavailable, please retry' });
          continue;
        }
        let listings: Array<{ tokenMint?: string; mintAddress?: string }>;
        try {
          listings = await meRes.json() as typeof listings;
        } catch {
          if (attempt === 2) return res.status(502).json({ ok: false, error: 'me_api_bad_response', message: 'ME API unavailable, please retry' });
          continue;
        }
        mint = listings[0]?.tokenMint ?? listings[0]?.mintAddress ?? '';
      }
      if (!mint) return res.status(404).json({ ok: false, error: 'no_listings' });

      // Get FVCA via DAS getAsset
      const dasRes = await fetch(rpcUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: mint } }),
        signal: AbortSignal.timeout(8_000),
      });
      const das = await dasRes.json() as {
        result?: {
          creators?: Array<{ address: string; verified: boolean }>;
          grouping?: Array<{ group_key: string; group_value: string }>;
        };
      };
      const fvca = (das.result?.creators ?? []).find(c => c.verified)?.address ?? '';
      const mcc  = (das.result?.grouping  ?? []).find(g => g.group_key === 'collection')?.group_value ?? '';

      // Always fetch collection name (needed for all paths including symbol fallback)
      let name = '';
      try {
        const colRes = await meFetchBulk(
          `https://api-mainnet.magiceden.dev/v2/collections/${encodeURIComponent(slug)}`,
        );
        if (colRes.ok) name = ((await colRes.json() as { name?: string }).name) ?? '';
      } catch { /* non-fatal */ }

      if (!fvca && !mcc) {
        // No on-chain allowlist key — fall back to symbol-based ME scan
        slugCache.set(slug, { fvca: '', mcc: '', collectionName: name, cachedAt: Date.now() });
        return res.json({ ok: true, fvca: null, mcc: null, symbol: slug, collectionName: name, slug, cached: false });
      }

      slugCache.set(slug, { fvca, mcc, collectionName: name, cachedAt: Date.now() });
      if (fvca) fvcaInfoCache.set(fvca, { name, slug, cachedAt: Date.now(), tokenStandard: fvcaInfoCache.get(fvca)?.tokenStandard });
      if (mcc)  fvcaInfoCache.set(mcc,  { name, slug, cachedAt: Date.now(), tokenStandard: fvcaInfoCache.get(mcc)?.tokenStandard });
      saveFvcaInfoCacheDebounced();
      return res.json({ ok: true, fvca: fvca || null, mcc: mcc || null, symbol: null, collectionName: name, slug, cached: false });
    } catch (err) {
      return res.status(502).json({ ok: false, error: 'resolve_failed', message: String(err) });
    }
  });

  router.get('/tools/mmm-pools/scan', limit, requireAuth, async (req: Request, res: Response) => {
    const owner = String(req.query.owner ?? '').trim();
    if (!owner || !ADDR_RE.test(owner)) {
      return res.status(400).json({ ok: false, error: 'invalid_owner_address' });
    }
    try {
      new PublicKey(owner);
    } catch {
      return res.status(400).json({ ok: false, error: 'invalid_owner_address' });
    }
    try {
      const scan = await scanOwnerPools(owner);
      return res.json(scan);
    } catch (err) {
      console.error('[tools/mmm-pools] scan error', err);
      return res.status(502).json({ ok: false, error: 'rpc_error', message: String(err) });
    }
  });

  return router;
}
