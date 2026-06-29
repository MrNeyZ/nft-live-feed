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
import { rateLimit }                                 from './rate-limit';

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

async function rpcPost(method: string, params: unknown[]): Promise<unknown> {
  const r = await fetch(rpcUrl(), {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal:  AbortSignal.timeout(RPC_TIMEOUT_MS),
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

  return {
    ok:          true,
    owner,
    total:       merged.length,
    executable:  merged.filter(p => p.executable).length,
    underfunded: merged.filter(p => p.underfunded).length,
    diverged:    merged.filter(p => p.diverged).length,
    pools:       merged,
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

export function createMmmPoolsRouter(): Router {
  const router = Router();
  const limit  = rateLimit({ limit: 10, windowMs: 60_000, label: 'tools/mmm-pools' });

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
