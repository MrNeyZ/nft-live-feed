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
  SystemProgram, SYSVAR_RENT_PUBKEY,
}                                                    from '@solana/web3.js';
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
}                                                    from '@solana/spl-token';
import bs58                                          from 'bs58';
import { rateLimit }                                 from './rate-limit';
import { meCooldownActive, setMeCooldown }           from '../me-api-cooldown';

const MMM_PROGRAM_ID = new PublicKey('mmm3XBJg5gk8XJxEKBvdgptZz6SgK4tXvn36sodowMc');
const ESCROW_SEED    = Buffer.from('mmm_buyside_sol_escrow_account');
const POOL_SIZE      = 849;
const RPC_TIMEOUT_MS = 90_000;
const CHUNK_SIZE     = 100;

// Pool layout field offsets (verified empirically, Jun 2026)
const OFF_SPOT     = 8;
const OFF_EXPIRY   = 27;
const OFF_OWNER    = 121;
const OFF_COSIGNER = 153;   // immediately after owner (32 bytes)
const OFF_REFERRAL = 185;   // immediately after cosigner (32 bytes)
const OFF_BPA      = 447;
const OFF_AL       = 249;   // allowlists start

// MMM on-chain constants (verified from live sol_fulfill_buy txs)
const METAPLEX_PROGRAM   = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const ME_COSIGNER_PUBKEY = 'NTYeYJ1wr4bpM5xo6zx5En44SvJFAd35zTxxNoERYqd';
const MMM_FEE_CONSTANT   = new PublicKey('4nGoPfgRW2nkAp6ELx8bYRxLVRrNB3Si8drp4PRuDa3Q');
const SOL_FULFILL_BUY_DISC = Buffer.from('5c10e24f1ff23576', 'hex');
const SELL_STATE_SEED      = Buffer.from('mmm_sell_state');

const ALLOWLIST_TYPE: Record<number, string> = {
  0: 'empty', 1: 'FVCA', 2: 'mint', 3: 'MCC',
  4: 'metadata', 5: 'group', 6: 'core_collection', 255: 'any',
};

const ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  return key
    ? `https://mainnet.helius-rpc.com/?api-key=${key}`
    : 'https://api.mainnet-beta.solana.com';
}

async function rpcPost(method: string, params: unknown[], timeoutMs = RPC_TIMEOUT_MS): Promise<unknown> {
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

function deriveEscrowPda(poolKey: string): string {
  const pool = new PublicKey(poolKey);
  const [pda] = PublicKey.findProgramAddressSync(
    [ESCROW_SEED, pool.toBuffer()],
    MMM_PROGRAM_ID,
  );
  return pda.toBase58();
}

interface Allowlist { type: string; pubkey: string; }

interface MmmPool {
  poolKey:        string;
  escrowPda:      string;
  owner:          string;
  cosigner:       string;
  referral:       string;
  spotPrice:      number;   // lamports
  spotPriceSol:   number;
  bpa:            number;   // tracked buyside_payment_amount, lamports
  bpaSol:         number;
  realEscrow:     number;   // actual lamports in escrow PDA
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
}

function parsePool(pubkey: string, dataB64: string): MmmPool | null {
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
  try { owner    = new PublicKey(raw.subarray(OFF_OWNER,    OFF_OWNER    + 32)).toBase58(); } catch { /* ignore */ }
  try { cosigner = new PublicKey(raw.subarray(OFF_COSIGNER, OFF_COSIGNER + 32)).toBase58(); } catch { /* ignore */ }
  try { referral = new PublicKey(raw.subarray(OFF_REFERRAL, OFF_REFERRAL + 32)).toBase58(); } catch { /* ignore */ }

  return {
    poolKey:       pubkey,
    escrowPda,
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

async function fetchMultipleBalances(pdas: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (let i = 0; i < pdas.length; i += CHUNK_SIZE) {
    const chunk = pdas.slice(i, i + CHUNK_SIZE);
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
  }
  return out;
}

// ── ME API: collection name lookup ──────────────────────────────────────────
const ME_BASE = 'https://api-mainnet.magiceden.dev/v2';

interface MePoolResult {
  collectionSymbol?: string;
  collectionName?:   string;
  poolType?:         string;
  isMIP1?:           boolean;
  poolKey?:          string;
}

async function fetchMeCollectionInfo(owner: string): Promise<Map<string, MePoolResult>> {
  const out = new Map<string, MePoolResult>();
  try {
    const url = `${ME_BASE}/mmm/pools?owner=${encodeURIComponent(owner)}&showInvalid=true&filterOnSide=1&limit=100`;
    const r   = await fetch(url, {
      headers: { 'User-Agent': 'VictoryLabs/1.0' },
      signal:  AbortSignal.timeout(15_000),
    });
    if (!r.ok) return out;
    const data = await r.json() as { results?: MePoolResult[] };
    for (const mp of data.results ?? []) {
      const pk = mp.poolKey;
      if (pk) out.set(pk, mp);
    }
  } catch { /* non-fatal */ }
  return out;
}

export interface MmmPoolWithCollection extends MmmPool {
  collectionName:   string;
  collectionSymbol: string;
  poolType:         string;
  isMIP1:           boolean;
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
  const result = await rpcPost('getProgramAccounts', [
    MMM_PROGRAM_ID.toBase58(),
    {
      encoding:   'base64',
      commitment: 'confirmed',
      filters: [
        { dataSize: POOL_SIZE },
        { memcmp: { offset: OFF_OWNER, bytes: owner, encoding: 'base58' } },
      ],
    },
  ]) as Array<{ pubkey: string; account: { data: [string, string] } }>;

  // 2. Parse all pool configs
  const pools: MmmPool[] = [];
  for (const acct of result) {
    const p = parsePool(acct.pubkey, acct.account.data[0]);
    if (p) pools.push(p);
  }

  // 3. Batch fetch real escrow balances
  const balances = await fetchMultipleBalances(pools.map(p => p.escrowPda));
  const hydrated  = pools.map(p => applyBalance(p, balances.get(p.escrowPda) ?? 0));

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
  content?: {
    metadata?: { name?: string };
    links?: { image?: string };
    files?: Array<{ uri?: string; cdn_uri?: string; mime?: string }>;
  };
  grouping?: Array<{ group_key: string; group_value: string }>;
  creators?: Array<{ address: string; verified: boolean }>;
}

// Fetch ALL wallet assets via getAssetsByOwner (object-params format required by Helius DAS)
async function getAllWalletAssets(wallet: string): Promise<DasAsset[]> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return [];
  const all: DasAsset[] = [];
  const PAGE_LIMIT = 1000;
  for (let page = 1; page <= 20; page++) {
    try {
      const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
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
      if (!r.ok) break;
      const j = await r.json() as { result?: { items?: DasAsset[]; total?: number } };
      const batch = j.result?.items ?? [];
      all.push(...batch);
      if (batch.length < PAGE_LIMIT) break;
    } catch { break; }
  }
  return all;
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

export interface WalletNft { mint: string; name: string; imageUrl: string | null; }

async function fetchWalletNftsForPool(wallet: string, pool: MmmPool): Promise<WalletNft[]> {
  const allowlists = pool.allowlists.filter(al => al.type !== 'empty');
  if (!allowlists.length) return [];

  const allAssets = await getAllWalletAssets(wallet);

  return allAssets
    .filter(asset => allowlists.some(al => assetMatchesAllowlist(asset, al)))
    .map(asset => {
      const img = asset.content?.links?.image
        ?? asset.content?.files?.find(f => f.mime?.startsWith('image/'))?.cdn_uri
        ?? asset.content?.files?.find(f => f.mime?.startsWith('image/'))?.uri
        ?? null;
      return { mint: asset.id, name: asset.content?.metadata?.name ?? asset.id.slice(0, 8), imageUrl: img };
    });

}

// ── On-chain sol_fulfill_buy builder ─────────────────────────────────────────
// Account layout verified from live txs (Jun 2026). 19 accounts, no remaining_accounts.

function buildOnChainFulfillBuyTx(
  pool:     MmmPool,
  poolPk:   PublicKey,
  sellerPk: PublicKey,
  mintPk:   PublicKey,
): Transaction {
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

  // 29-byte Borsh instruction data (verified from live txs)
  const data = Buffer.alloc(29);
  SOL_FULFILL_BUY_DISC.copy(data, 0);
  data.writeBigUInt64LE(BigInt(1), 8);
  data.writeBigUInt64LE(BigInt(minPayment), 16);
  data[24] = 0x00;                   // allowlist_aux = None
  data.writeInt16LE(-100, 25);       // maker_fee_bp
  data.writeInt16LE(200, 27);        // taker_fee_bp

  const ix = new TransactionInstruction({
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
      { pubkey: SystemProgram.programId,  isSigner: false, isWritable: false }, // [12] system_program
      { pubkey: sellStatePk,              isSigner: false, isWritable: true  }, // [13] sell_state
      { pubkey: SystemProgram.programId,  isSigner: false, isWritable: false }, // [14] system_program (duplicate needed)
      { pubkey: TOKEN_PROGRAM_ID,         isSigner: false, isWritable: false }, // [15] token_program
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // [16] associated_token_program
      { pubkey: SYSVAR_RENT_PUBKEY,       isSigner: false, isWritable: false }, // [17] rent
      { pubkey: MMM_FEE_CONSTANT,         isSigner: false, isWritable: false }, // [18] constant (mmm fee account)
    ],
  });

  const tx = new Transaction();
  tx.add(ix);
  return tx;
}

// ── ME bid-accept tx proxy → on-chain fallback ────────────────────────────────

async function fetchBidAcceptTx(
  poolKey: string,
  seller:  string,
  mint:    string,
): Promise<{ txBase64: string; source: 'me_api' | 'onchain' }> {
  // Try ME API first (returns fully cosigned tx)
  try {
    const url = `${ME_BASE}/mmm/pools/${encodeURIComponent(poolKey)}/instruction/sol-fulfill-buy`
      + `?seller=${encodeURIComponent(seller)}`
      + `&assetMint=${encodeURIComponent(mint)}`
      + `&assetAmount=1`
      + `&minPaymentAmount=0`;

    const meApiKey = process.env.ME_API_KEY;
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'VictoryLabs/1.0',
        ...(meApiKey ? { Authorization: `Bearer ${meApiKey}` } : {}),
      },
      signal:  AbortSignal.timeout(15_000),
    });

    if (r.ok) {
      const data = await r.json() as { tx?: { data?: number[] }; txSigned?: { data?: number[] } };
      const src  = data.txSigned ?? data.tx;
      if (src?.data && Array.isArray(src.data)) {
        return { txBase64: Buffer.from(src.data).toString('base64'), source: 'me_api' };
      }
    }
    // ME API failed — fall through to on-chain builder
    console.warn(`[tools/mmm-pools] ME API ${r.status} for ${poolKey}, trying on-chain builder`);
  } catch (e) {
    console.warn(`[tools/mmm-pools] ME API error for ${poolKey}:`, e);
  }

  // On-chain fallback: read pool, verify no ME cosigner required
  console.log('[fallback] PATH=onchain poolKey=%s seller=%s mint=%s', poolKey, seller, mint);

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

  if (pool.cosigner === ME_COSIGNER_PUBKEY) {
    console.log('[fallback] BLOCKED: ME cosigner required, cosigner=%s', pool.cosigner);
    throw new Error('me_cosigner_required: ME API unavailable for this pool and it requires ME cosigner');
  }
  console.log('[fallback] cosigner check passed (not ME cosigner)');

  // Derive all PDAs before building tx so we can log them
  const poolPk   = new PublicKey(poolKey);
  const sellerPk = new PublicKey(seller);
  const mintPk   = new PublicKey(mint);
  const ownerPk  = new PublicKey(pool.owner);

  const [escrowPk] = PublicKey.findProgramAddressSync([ESCROW_SEED, poolPk.toBuffer()], MMM_PROGRAM_ID);
  const [metadataPk] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METAPLEX_PROGRAM.toBuffer(), mintPk.toBuffer()], METAPLEX_PROGRAM);
  const [editionPk] = PublicKey.findProgramAddressSync(
    [Buffer.from('metadata'), METAPLEX_PROGRAM.toBuffer(), mintPk.toBuffer(), Buffer.from('edition')], METAPLEX_PROGRAM);
  const [sellStatePk] = PublicKey.findProgramAddressSync(
    [SELL_STATE_SEED, poolPk.toBuffer(), mintPk.toBuffer()], MMM_PROGRAM_ID);
  const sellerAta = getAssociatedTokenAddressSync(mintPk, sellerPk, false);
  const poolAta   = getAssociatedTokenAddressSync(mintPk, poolPk, true);
  const ownerAta  = getAssociatedTokenAddressSync(mintPk, ownerPk, false);

  console.log('[fallback] derived PDAs:');
  console.log('  escrowPk    = %s', escrowPk.toBase58());
  console.log('  metadataPk  = %s', metadataPk.toBase58());
  console.log('  editionPk   = %s', editionPk.toBase58());
  console.log('  sellStatePk = %s', sellStatePk.toBase58());
  console.log('  sellerAta   = %s', sellerAta.toBase58());
  console.log('  poolAta     = %s', poolAta.toBase58());
  console.log('  ownerAta    = %s', ownerAta.toBase58());
  console.log('[fallback] accounts [0..18]:');
  console.log('  [0] payer(seller)         = %s', sellerPk.toBase58());
  console.log('  [1] owner                 = %s', ownerPk.toBase58());
  console.log('  [2] cosigner              = %s', pool.cosigner);
  console.log('  [3] referral              = %s', pool.referral);
  console.log('  [4] pool                  = %s', poolPk.toBase58());
  console.log('  [5] escrow                = %s', escrowPk.toBase58());
  console.log('  [6] metadata              = %s', metadataPk.toBase58());
  console.log('  [7] edition               = %s', editionPk.toBase58());
  console.log('  [8] mint                  = %s', mintPk.toBase58());
  console.log('  [9] sellerAta             = %s', sellerAta.toBase58());
  console.log('  [10] poolAta              = %s', poolAta.toBase58());
  console.log('  [11] ownerAta             = %s', ownerAta.toBase58());
  console.log('  [12] systemProgram        = %s', SystemProgram.programId.toBase58());
  console.log('  [13] sellState            = %s', sellStatePk.toBase58());
  console.log('  [14] systemProgram(dup)   = %s', SystemProgram.programId.toBase58());

  let tx: Transaction;
  try {
    tx = buildOnChainFulfillBuyTx(pool, poolPk, sellerPk, mintPk);
    console.log('[fallback] buildOnChainFulfillBuyTx OK, ix count=%s', tx.instructions.length);
  } catch (e) {
    console.error('[fallback] buildOnChainFulfillBuyTx threw:', (e instanceof Error ? e.stack : String(e)));
    throw e;
  }

  // Need a recent blockhash so the tx can be serialized and Phantom can sign it
  let bhResult: { value: { blockhash: string; lastValidBlockHeight: number } };
  try {
    bhResult = await rpcPost('getLatestBlockhash', [{ commitment: 'confirmed' }]) as typeof bhResult;
    console.log('[fallback] blockhash=%s lastValidBlockHeight=%s', bhResult.value.blockhash, bhResult.value.lastValidBlockHeight);
  } catch (e) {
    console.error('[fallback] getLatestBlockhash threw:', (e instanceof Error ? e.stack : String(e)));
    throw e;
  }

  tx.feePayer        = sellerPk;
  tx.recentBlockhash = bhResult.value.blockhash;

  let serialized: Buffer;
  try {
    serialized = tx.serialize({ requireAllSignatures: false, verifySignatures: false });
    console.log('[fallback] serialize OK, byteLength=%s', serialized.length);
  } catch (e) {
    console.error('[fallback] serialize threw:', (e instanceof Error ? e.stack : String(e)));
    throw e;
  }

  return { txBase64: serialized.toString('base64'), source: 'onchain' };
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

  const balances = await fetchMultipleBalances([pool.escrowPda]);
  const hydrated  = applyBalance(pool, balances.get(pool.escrowPda) ?? 0);

  const meInfo = await fetchMeCollectionInfo(pool.owner);
  const me     = meInfo.get(pool.poolKey) ?? {};

  return {
    ok: true, type: 'pool',
    pool: {
      ...hydrated,
      collectionName:   me.collectionName   ?? me.collectionSymbol ?? '',
      collectionSymbol: me.collectionSymbol ?? '',
      poolType:         me.poolType         ?? '',
      isMIP1:           me.isMIP1           ?? false,
    },
    scannedAt: new Date().toISOString(),
  };
}

// ── Triage collection types + cache ──────────────────────────────────────────
const COLL_AL_TYPES = new Set(['FVCA', 'MCC', 'core_collection', 'group']);

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
  escrowPda:      string;
  owner:          string;
  spotPriceSol:   number;
  realEscrowSol:  number;
  missingSol:     number;
  pct:            number;    // realEscrow / spotPrice * 100
  alType:         string;
  alKey:          string;
  collectionName: string;
}
let rawPoolsCache: { pools: FlatPool[]; builtAt: number } | null = null;

// FVCA → collection info cache (populated by resolve-slug and batchResolveFvcaNames).
// Keyed by FVCA address; long TTL because creator/name never change post-mint.
const fvcaInfoCache = new Map<string, { name: string; slug: string; cachedAt: number }>();
const FVCA_INFO_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

// ME API fetch helper for bulk name/slug resolution (no auth needed for public endpoints).
async function meFetchBulk(url: string) {
  return fetch(url, {
    headers: { Accept: 'application/json' },
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
    return !hit || Date.now() - hit.cachedAt > FVCA_INFO_TTL_MS;
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
              content?: { metadata?: { name?: string; symbol?: string } };
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
        if (dasName) {
          const existing = fvcaInfoCache.get(fvca);
          fvcaInfoCache.set(fvca, { name: dasName, slug: existing?.slug ?? '', cachedAt: Date.now() });
        }
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
        const res = await fetch(rpcUrl(), {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({
            jsonrpc: '2.0', id: 1, method: 'getAsset',
            params:  { id: colMint },
          }),
          signal: AbortSignal.timeout(8_000),
        });
        const data = await res.json() as {
          result?: { content?: { metadata?: { name?: string } } };
        };
        const colName = data.result?.content?.metadata?.name ?? '';
        if (colName) {
          const existing = fvcaInfoCache.get(fvca);
          fvcaInfoCache.set(fvca, { name: colName, slug: existing?.slug ?? '', cachedAt: Date.now() });
        }
      } catch { /* non-fatal */ }
    }));
  }

  // ── Step 3: ME /v2/tokens/{mint} → ME slug (rate-limit aware) ────────────
  // Skip entirely if the process-wide ME cooldown is active to avoid piling on.
  // Cap at top 30 — we'll hit rate-limit anyway, so prioritise the biggest pools.
  if (meCooldownActive()) return;

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
        fvcaInfoCache.set(fvca, { name: result.name || (fvcaInfoCache.get(fvca)?.name ?? ''), slug: result.slug, cachedAt: Date.now() });
      }
    }));
    if (i + ME_CONCURRENCY < needSlug.length) {
      await new Promise(r => setTimeout(r, ME_BATCH_DELAY));
    }
  }
}

export function createMmmPoolsRouter(): Router {
  const router = Router();
  const limit  = rateLimit({ limit: 10, windowMs: 60_000, label: 'tools/mmm-pools' });

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
        emit('progress', { msg: `Fetching all infinite-lifetime MMM pools${fast ? ' [fast mode]' : ''}...` });

        const accounts = await rpcPost('getProgramAccounts', [
          MMM_PROGRAM_ID.toBase58(),
          {
            encoding:   'base64',
            commitment: 'confirmed',
            // memcmp on expiry field (i64 LE @ OFF_EXPIRY=27): value 0 = 8 zero bytes
            // bs58.encode(Buffer.alloc(8)) = '11111111'
            filters: [
              { dataSize: POOL_SIZE },
              { memcmp: { offset: OFF_EXPIRY, bytes: '11111111' } },
            ],
          },
        ], 180_000) as Array<{ pubkey: string; account: { data: [string, string] } }>;

        emit('progress', { msg: `Got ${accounts.length} infinite-lifetime pools, parsing...` });

        // Pre-filter on bpa (no RPC needed, local parse only)
        const candidates: MmmPool[] = [];
        for (const acct of accounts) {
          const p = parsePool(acct.pubkey, acct.account.data[0]);
          if (!p) continue;
          if (!(p.bpa > 0 && p.bpa < p.spotPrice)) continue;
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
          underfunded = underfunded.filter(p => !p.executable);
        } else {
          // Full mode: fetch real escrow balances via getMultipleAccounts batches.
          // Cost: ceil(candidates.length / 100) RPC calls.
          emit('progress', {
            msg: `${candidates.length} candidates — fetching real escrow balances (${Math.ceil(candidates.length / 100)} batch calls)...`,
          });
          const balances = await fetchMultipleBalances(candidates.map(p => p.escrowPda));
          const hydrated = candidates.map(p => applyBalance(p, balances.get(p.escrowPda) ?? 0));
          underfunded = hydrated.filter(p => p.realEscrow >= 10_000_000 && !p.executable);
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
          pools: underfunded.filter(p => !p.allowlists.some(a => a.type === 'metadata')).map(p => {
            const al = p.allowlists.find(a => COLL_AL_TYPES.has(a.type));
            const info = al ? fvcaInfoCache.get(al.pubkey) : undefined;
            return {
              poolKey:        p.poolKey,
              escrowPda:      p.escrowPda,
              owner:          p.owner,
              spotPriceSol:   p.spotPriceSol,
              realEscrowSol:  p.realEscrowSol,
              missingSol:     p.missingSol,
              pct:            p.spotPrice > 0 ? p.realEscrow / p.spotPrice * 100 : 0,
              alType:         al?.type ?? '',
              alKey:          al?.pubkey ?? '',
              collectionName: info?.name ?? '',
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
  // GET /api/tools/mmm-pools/pool-stream?min_pct=50&fast=1&force=0
  // Returns individual underfunded pools sorted by % funded desc.
  // Reuses rawPoolsCache populated by the most recent triage run (20-min TTL).
  router.get(
    '/tools/mmm-pools/pool-stream',
    limit,
    (req: Request, res: Response) => {
      const minPct = parseFloat(req.query['min_pct'] as string ?? '50') || 50;
      const force  = req.query['force'] === '1';
      const fast   = req.query['fast']  !== '0'; // default true

      res.setHeader('Content-Type',  'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection',    'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      const emit = (type: string, data: Record<string, unknown>) => {
        res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
      };

      void (async () => {
        try {
          // Use rawPoolsCache if fresh
          if (!force && rawPoolsCache && Date.now() - rawPoolsCache.builtAt < TRIAGE_CACHE_TTL_MS) {
            const filtered = rawPoolsCache.pools
              .filter(p => p.pct >= minPct)
              .sort((a, b) => b.pct - a.pct);
            emit('progress', { msg: `Cached (${Math.floor((Date.now() - rawPoolsCache.builtAt) / 60_000)}m ago) — ${filtered.length} pools ≥${minPct}%`, cached: true });
            emit('result', { pools: filtered, cached: true, cacheAgeMs: Date.now() - rawPoolsCache.builtAt });
            return res.end();
          }

          // Fresh scan
          emit('progress', { msg: `Fetching all infinite-lifetime MMM pools${fast ? ' [fast]' : ''}…` });
          const accounts = await rpcPost('getProgramAccounts', [
            MMM_PROGRAM_ID.toBase58(),
            {
              encoding:   'base64',
              commitment: 'confirmed',
              filters: [
                { dataSize: POOL_SIZE },
                { memcmp: { offset: OFF_EXPIRY, bytes: '11111111' } },
              ],
            },
          ], 180_000) as Array<{ pubkey: string; account: { data: [string, string] } }>;

          emit('progress', { msg: `${accounts.length} pools — filtering candidates…` });

          const candidates: MmmPool[] = [];
          for (const acct of accounts) {
            const p = parsePool(acct.pubkey, acct.account.data[0]);
            if (!p) continue;
            if (!(p.bpa > 0 && p.bpa < p.spotPrice)) continue;
            if (!p.allowlists.some(al => COLL_AL_TYPES.has(al.type))) continue;
            candidates.push(p);
          }

          let underfunded: MmmPool[];
          if (fast) {
            underfunded = candidates.map(p => applyBalance(p, p.bpa)).filter(p => !p.executable);
          } else {
            emit('progress', { msg: `Fetching real escrow balances (${Math.ceil(candidates.length / 100)} calls)…` });
            const balances = await fetchMultipleBalances(candidates.map(p => p.escrowPda));
            underfunded = candidates.map(p => applyBalance(p, balances.get(p.escrowPda) ?? 0))
              .filter(p => p.realEscrow >= 10_000_000 && !p.executable);
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
          const flatPools: FlatPool[] = underfunded.map(p => {
            const al   = p.allowlists.find(a => COLL_AL_TYPES.has(a.type));
            const info = al ? fvcaInfoCache.get(al.pubkey) : undefined;
            return {
              poolKey:        p.poolKey,
              escrowPda:      p.escrowPda,
              owner:          p.owner,
              spotPriceSol:   p.spotPriceSol,
              realEscrowSol:  p.realEscrowSol,
              missingSol:     p.missingSol,
              pct:            p.spotPrice > 0 ? p.realEscrow / p.spotPrice * 100 : 0,
              alType:         al?.type ?? '',
              alKey:          al?.pubkey ?? '',
              collectionName: info?.name ?? '',
            };
          });
          const knownFlatPools = flatPools.filter(p => p.collectionName !== '' && p.realEscrowSol >= 0.01);
          rawPoolsCache = { pools: knownFlatPools, builtAt: Date.now() };

          const filtered = knownFlatPools.filter(p => p.pct >= minPct).sort((a, b) => b.pct - a.pct);
          emit('progress', { msg: `${filtered.length} pools ≥${minPct}% funded` });
          emit('result', { pools: filtered, cached: false, cacheAgeMs: 0 });
        } catch (e) {
          emit('error', { msg: String(e) });
        }
        res.end();
      })();
    },
  );

  // Proxy sendRawTransaction through Helius so the browser doesn't hit the public RPC
  // (which returns 403 for sendTransaction from browser origins).
  router.post('/tools/mmm-pools/send-tx', limit, async (req: Request, res: Response) => {
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
  router.get('/tools/mmm-pools/tx-status', limit, async (req: Request, res: Response) => {
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

  router.get('/tools/mmm-pools/wallet-nfts', limit, async (req: Request, res: Response) => {
    const wallet  = String(req.query.wallet ?? '').trim();
    const poolKey = String(req.query.pool   ?? '').trim();
    if (!wallet || !ADDR_RE.test(wallet) || !poolKey || !ADDR_RE.test(poolKey)) {
      return res.status(400).json({ ok: false, error: 'invalid_params' });
    }
    try {
      const result = await lookupSinglePool(poolKey);
      if (result.type !== 'pool') return res.json({ ok: true, nfts: [] });
      const nfts = await fetchWalletNftsForPool(wallet, result.pool);
      return res.json({ ok: true, nfts });
    } catch (err) {
      console.error('[tools/mmm-pools] wallet-nfts error', err);
      return res.status(502).json({ ok: false, error: 'rpc_error', message: String(err) });
    }
  });

  router.get('/tools/mmm-pools/bid-accept-tx', limit, async (req: Request, res: Response) => {
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

  router.get('/tools/mmm-pools/pool', limit, async (req: Request, res: Response) => {
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
  router.get('/tools/mmm-pools/collection-scan', rateLimit({ limit: 6, windowMs: 60_000, label: 'tools/mmm-collection-scan' }), async (req: Request, res: Response) => {
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
        const meResp = await fetch(meUrl, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8_000) });
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

        const balances  = await fetchMultipleBalances(allPools.map(p => p.escrowPda));
        const hydrated  = allPools.map(p => applyBalance(p, balances.get(p.escrowPda) ?? 0));
        const isActive  = (p: MmmPool) => p.expiry === 0 || p.expiry > now;
        const active    = hydrated.filter(isActive);
        const expired   = hydrated.length - active.length;
        const executable   = active.filter(p => p.executable);
        const underfunded  = active.filter(p => !p.executable && p.realEscrow > 0);
        const emptyEscrow  = active.filter(p => p.realEscrow === 0);

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
          const result = await rpcPost('getProgramAccounts', [
            MMM_PROGRAM_ID.toBase58(),
            {
              encoding:   'base64',
              commitment: 'confirmed',
              filters: [
                { dataSize: POOL_SIZE },
                { memcmp: { offset, bytes: matchB58 } },
              ],
            },
          ]) as Array<{ pubkey: string; account: { data: [string, string] } }>;
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
      const balances = await fetchMultipleBalances(allPools.map(p => p.escrowPda));
      const hydrated  = allPools.map(p => applyBalance(p, balances.get(p.escrowPda) ?? 0));

      // Classify
      const isActive      = (p: MmmPool) => p.expiry === 0 || p.expiry > now;
      const active        = hydrated.filter(isActive);
      const expired       = hydrated.length - active.length;
      const executable    = active.filter(p => p.executable);
      const underfunded   = active.filter(p => !p.executable && p.realEscrow > 0);
      const emptyEscrow   = active.filter(p => p.realEscrow === 0);

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
  router.get('/tools/mmm-pools/resolve-slug', limit, async (req: Request, res: Response) => {
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
          { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8_000) },
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
      if (fvca) fvcaInfoCache.set(fvca, { name, slug, cachedAt: Date.now() });
      if (mcc)  fvcaInfoCache.set(mcc,  { name, slug, cachedAt: Date.now() });
      return res.json({ ok: true, fvca: fvca || null, mcc: mcc || null, symbol: null, collectionName: name, slug, cached: false });
    } catch (err) {
      return res.status(502).json({ ok: false, error: 'resolve_failed', message: String(err) });
    }
  });

  router.get('/tools/mmm-pools/scan', limit, async (req: Request, res: Response) => {
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
