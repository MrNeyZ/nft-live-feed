/**
 * Magic Eden v2 buyer-escrow PDA helpers.
 *
 * Background — how ME v2 personal offers are funded:
 *   The `pdaAddress` ME returns on /offers_received is a "trade-state"
 *   PDA describing the offer (buyer, price, mint, expiry). The SOL that
 *   would settle the offer does NOT live on that trade state. It lives
 *   in a separate per-(auctionHouse, buyer) escrow PDA derived as:
 *
 *     program = M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K
 *     seeds   = [ "m2", auctionHouse, buyer ]
 *
 *   The escrow is system-owned for SOL purposes — buyers `deposit` /
 *   `withdraw` lamports independently of any specific offer. So an
 *   active trade state can outlive the SOL that backs it: the offer
 *   keeps showing up in /offers_received, but a settle attempt fails
 *   for insufficient funds. This module surfaces that state to the
 *   scanner so the operator can ignore unfundable bids.
 *
 *   `getBalance` on the escrow PDA returns the total lamport balance,
 *   which is what ME spends from when honoring a bid. We compare it
 *   directly against the offer price (the rent-exempt minimum is
 *   ~0.00089 SOL — far below any meaningful bid threshold, so we
 *   don't subtract it).
 */

import { PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';

const M2_PROGRAM_ID = new PublicKey('M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K');
const M2_ESCROW_SEED = Buffer.from('m2');

const BALANCE_TTL_MS    = 60_000;
const RPC_TIMEOUT_MS    = 6_000;
/** getMultipleAccounts caps at 100 keys per call. We chunk defensively
 *  even though typical scans resolve <20 unique buyers. */
const RPC_CHUNK_MAX     = 100;

export type FundingStatus = 'funded' | 'low_balance' | 'empty' | 'unknown';

export interface FundingInfo {
  /** The M2 buyer-escrow PDA (when resolvable). null = unknown. */
  fundingWallet:     string | null;
  /** Lamport balance of the escrow PDA, or null if unresolved/RPC failed. */
  fundingBalanceSol: number | null;
  fundingStatus:     FundingStatus;
}

interface BalanceCacheEntry {
  lamports: number;
  fetchedAt: number;
}

const balanceCache = new Map<string, BalanceCacheEntry>();
/** PDAs we couldn't resolve (RPC failure / chunk error) — short-lived
 *  negative cache so transient errors don't pile up retries. */
const balanceMissCache = new Map<string, number>();
const MISS_CACHE_TTL_MS = 15_000;

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  return key
    ? `https://mainnet.helius-rpc.com/?api-key=${key}`
    : 'https://api.mainnet-beta.solana.com';
}

/** Returns null when either input is not a valid base58 pubkey — the
 *  caller treats that as `unknown` funding. */
export function deriveBuyerEscrowPda(auctionHouse: string, buyer: string): string | null {
  let ahPk: PublicKey;
  let buyerPk: PublicKey;
  try {
    ahPk    = new PublicKey(auctionHouse);
    buyerPk = new PublicKey(buyer);
  } catch {
    return null;
  }
  try {
    const [pda] = PublicKey.findProgramAddressSync(
      [M2_ESCROW_SEED, ahPk.toBuffer(), buyerPk.toBuffer()],
      M2_PROGRAM_ID,
    );
    return pda.toBase58();
  } catch {
    return null;
  }
}

interface MultipleAccountsResp {
  result?: {
    value?: Array<{ lamports?: number } | null>;
  };
}

/** Fetch lamports for up to `RPC_CHUNK_MAX` PDAs in one RPC call.
 *  Returns a map of pda → lamports. PDAs whose accounts don't exist
 *  on-chain (closed escrow) map to 0. PDAs missing from the result
 *  due to RPC error are absent from the map. */
async function fetchLamportsBatch(pdas: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (pdas.length === 0) return out;
  try {
    const r = await fetch(rpcUrl(), {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        jsonrpc: '2.0',
        id:      1,
        method:  'getMultipleAccounts',
        // base64 encoding is fine — we only read .lamports.
        params:  [pdas, { encoding: 'base64', commitment: 'confirmed' }],
      }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    });
    if (!r.ok) return out;
    const data = await r.json() as MultipleAccountsResp;
    const values = data.result?.value;
    if (!Array.isArray(values)) return out;
    for (let i = 0; i < pdas.length && i < values.length; i++) {
      const acct = values[i];
      // null = account doesn't exist (closed / never funded) → 0 lamports.
      out.set(pdas[i], typeof acct?.lamports === 'number' ? acct.lamports : 0);
    }
    return out;
  } catch {
    return out;
  }
}

export interface ResolveEscrowResult {
  /** pda → lamports for every PDA we have a balance for (cache + fresh). */
  balances: Map<string, number>;
  /** Count of PDAs satisfied from the in-process cache. */
  cacheHits: number;
  /** Count of PDAs that required a fresh on-chain fetch (including misses). */
  rpcFetched: number;
  /** Count of distinct getMultipleAccounts RPC calls issued (chunks). */
  rpcCalls: number;
}

/** Resolve cached + on-RPC balances for many escrow PDAs, deduping
 *  internally. Cache TTL = 60 s. Returns balances map + a stats block
 *  the caller logs as `wallets=N rpc=M`. */
export async function resolveEscrowBalances(pdas: readonly string[]): Promise<ResolveEscrowResult> {
  const balances = new Map<string, number>();
  const now = Date.now();
  const todoSet = new Set<string>();
  let cacheHits = 0;

  for (const pda of pdas) {
    if (!pda) continue;
    const hit = balanceCache.get(pda);
    if (hit && now - hit.fetchedAt < BALANCE_TTL_MS) {
      balances.set(pda, hit.lamports);
      cacheHits++;
      continue;
    }
    const miss = balanceMissCache.get(pda);
    if (miss && now - miss < MISS_CACHE_TTL_MS) continue;
    todoSet.add(pda);
  }

  const todo = [...todoSet];
  let rpcCalls = 0;
  if (todo.length === 0) return { balances, cacheHits, rpcFetched: 0, rpcCalls: 0 };

  for (let i = 0; i < todo.length; i += RPC_CHUNK_MAX) {
    const chunk = todo.slice(i, i + RPC_CHUNK_MAX);
    rpcCalls++;
    const fetched = await fetchLamportsBatch(chunk);
    for (const pda of chunk) {
      const lamports = fetched.get(pda);
      if (typeof lamports === 'number') {
        balanceCache.set(pda, { lamports, fetchedAt: Date.now() });
        balances.set(pda, lamports);
      } else {
        balanceMissCache.set(pda, Date.now());
      }
    }
  }

  return { balances, cacheHits, rpcFetched: todo.length, rpcCalls };
}

export function classifyFundingStatus(
  lamports: number | null,
  offerPriceSol: number,
): FundingStatus {
  if (lamports == null)            return 'unknown';
  const requiredLamports = Math.ceil(offerPriceSol * LAMPORTS_PER_SOL);
  if (lamports <= 0)               return 'empty';
  if (lamports >= requiredLamports) return 'funded';
  return 'low_balance';
}

export function lamportsToSol(lamports: number | null): number | null {
  if (lamports == null) return null;
  return lamports / LAMPORTS_PER_SOL;
}
