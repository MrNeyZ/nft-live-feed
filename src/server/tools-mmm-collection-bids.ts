/**
 * Magic Eden MMM collection-bid tool — personal use only, not a public
 * feature. Builds COLLECTION offers (buy-side MMM pools), not item-level
 * offers — see `tools-me-bids.ts` for the separate, unrelated single-mint
 * tool. This module is fully isolated: it does not import from or modify
 * `tools-me-bids.ts`.
 *
 * `GET /instructions/mmm/create-pool` is Cloudflare-blocked (confirmed
 * live, see `mmm-raw-instructions.ts`'s header for the full diagnostic
 * trail). Every instruction in this tool — create, deposit, update,
 * withdraw, close — is therefore built RAW against the open-source MMM
 * program, never via Magic Eden's Instruction API. `mmm-raw-instructions.ts`
 * documents the evidence backing every discriminator/layout/PDA seed used
 * here (open-source Rust source + a real historical transaction, byte-exact
 * cross-checked).
 *
 * ── Quantity model ──────────────────────────────────────────────────────
 *
 * MMM has no native "quantity" field. A buy-side pool's capacity is purely
 * a function of deposited SOL liquidity vs. the bonding curve: each fill
 * needs `escrow_balance >= price_at_k`, and with `curveDelta = 0` both the
 * linear (`spot + delta*k`) and exp (`spot*(1+delta/10000)^k`) formulas
 * collapse to a constant `spot` regardless of k — confirmed against this
 * project's own already-used pricing formula in `listings-store.ts`. So:
 *
 *   requiredLiquidityLamports = pricePerNftLamports * maxQuantity
 *
 * computed server-side, always. The client can request a quantity; it can
 * never independently request a liquidity amount that doesn't match
 * price*quantity for create/deposit.
 *
 * ── Cosigner ─────────────────────────────────────────────────────────────
 *
 * A dedicated, narrowly-scoped keypair (see `loadCosignerKeypair`) held
 * ONLY server-side, used ONLY to co-sign MMM admin instructions for pools
 * this tool creates. It is never the owner, fee payer, treasury, trading
 * wallet, or API key, cannot move funds or act alone (every instruction
 * also requires the pool owner's own Phantom signature — see
 * `mmm-raw-instructions.ts`'s header for the on-chain proof), and the
 * private key never leaves this file's `loadCosignerKeypair` call site.
 *
 * Signing flow: the backend builds the exact validated transaction and
 * partially signs ONLY the cosigner slot before ever returning it — the
 * owner slot is always empty at that point. Phantom then signs the owner
 * slot without altering the message (adding a signature never changes
 * `serializeMessage()`'s output, which is what the digest binds — same
 * invariant as `tools-me-bids.ts`). /submit independently re-verifies BOTH
 * signatures cryptographically before ever calling `sendRawTransaction`.
 *
 * ── Safety model (mirrors tools-me-bids.ts's hardened principles,
 *    independently implemented — no shared state, no shared cache) ───────
 *
 *   GET  /api/tools/mmm-collection-bids/status                — { liveEnabled, cosignerPubkey }
 *   GET  /api/tools/mmm-collection-bids/pool?poolKey=          — decoded pool + escrow balance
 *   POST /api/tools/mmm-collection-bids/build/create           — { owner, collectionSymbol, pricePerNftLamports, maxQuantity, expiry? }
 *   POST /api/tools/mmm-collection-bids/build/deposit           — { poolKey, additionalQuantity }
 *   POST /api/tools/mmm-collection-bids/build/update            — { poolKey, spotPriceLamports?, expiry? }
 *   POST /api/tools/mmm-collection-bids/build/withdraw-sol      — { poolKey, amountLamports }
 *   POST /api/tools/mmm-collection-bids/build/close             — { poolKey }
 *   POST /api/tools/mmm-collection-bids/simulate                — { tx: base64 }
 *   POST /api/tools/mmm-collection-bids/submit                  — { signedTx: base64, digest }
 *
 * LIVE mode gated by `MMM_COLLECTION_BIDS_ENABLE_LIVE`, independent of the
 * item-level tool's flag, defaults false, fails closed.
 */

import { Router, Request, Response, RequestHandler } from 'express';
import {
  PublicKey, Connection, Transaction, Keypair, TransactionInstruction,
} from '@solana/web3.js';
import { createHash, timingSafeEqual } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { rateLimit } from './rate-limit';
import { requireAuth } from './runtime';
import { meAuthHeaders, hasMeApiKey } from '../me-api-cooldown';
import { fetchAsset } from '../enrichment/helius-das';
import {
  MMM_PROGRAM_ID, ALLOWLIST_KIND, CURVE_KIND_LINEAR, ALLOWLIST_MAX_LEN,
  POOL_ACCOUNT_SIZE, derivePoolPda, deriveEscrowPda, generatePoolUuid,
  buildCreatePoolIx, buildUpdatePoolIx, buildSolDepositBuyIx, buildSolWithdrawBuyIx,
  buildSolClosePoolIx, decodePool, normalizeAllowlists,
  type Allowlist, type DecodedPool,
} from './mmm-raw-instructions';

const ME_API_BASE = 'https://api-mainnet.magiceden.dev/v2';
const FETCH_TIMEOUT_MS = 10_000;
const ESCROW_RENT_EXEMPT_LAMPORTS = 890_880; // 0-byte account, verified via getMinimumBalanceForRentExemption(0)

function liveEnabledFromEnv(): boolean {
  return (process.env.MMM_COLLECTION_BIDS_ENABLE_LIVE ?? '').trim().toLowerCase() === 'true';
}

const DEFAULT_BLOCKHASH_MARGIN_BLOCKS = 10;
function blockhashMarginBlocksFromEnv(): number {
  const v = Number(process.env.MMM_COLLECTION_BIDS_BLOCKHASH_MARGIN_BLOCKS);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_BLOCKHASH_MARGIN_BLOCKS;
}

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  return key
    ? `https://beta.helius-rpc.com/?api-key=${key}`
    : 'https://api.mainnet-beta.solana.com';
}

// ── Cosigner loading — fails closed on any check failure. Never logs or
//    returns secret bytes. ──────────────────────────────────────────────

export interface CosignerLoadOptions {
  keypairPath?: string;
  expectedPubkey?: string;
}

/** Throws (never falls back to a default) if the file is missing, has
 *  overly broad permissions, its parent directory has overly broad
 *  permissions, or its derived pubkey doesn't match the configured
 *  expectation. Read-only aside from stat calls; never writes. */
export function loadCosignerKeypair(opts: CosignerLoadOptions = {}): Keypair {
  const keypairPath = opts.keypairPath ?? process.env.MMM_COLLECTION_BIDS_COSIGNER_KEYPAIR_PATH;
  if (!keypairPath) throw new Error('mmm_cosigner_keypair_path_not_configured');
  if (!fs.existsSync(keypairPath)) throw new Error('mmm_cosigner_keypair_file_missing');

  const fileMode = fs.statSync(keypairPath).mode & 0o777;
  if (fileMode !== 0o600) {
    throw new Error(`mmm_cosigner_keypair_file_permissions_too_broad: expected 0600, got 0${fileMode.toString(8)}`);
  }
  const dirMode = fs.statSync(path.dirname(keypairPath)).mode & 0o777;
  if (dirMode !== 0o700) {
    throw new Error(`mmm_cosigner_keypair_dir_permissions_too_broad: expected 0700, got 0${dirMode.toString(8)}`);
  }

  let secretKey: Uint8Array;
  try {
    secretKey = Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf8')));
  } catch {
    throw new Error('mmm_cosigner_keypair_file_unparseable');
  }
  const kp = Keypair.fromSecretKey(secretKey);

  const expected = opts.expectedPubkey ?? process.env.MMM_COLLECTION_BIDS_COSIGNER_PUBKEY;
  if (expected && kp.publicKey.toBase58() !== expected) {
    throw new Error('mmm_cosigner_pubkey_mismatch');
  }
  return kp;
}

// ── ME read API client (allowlist resolution only — never instruction
//    generation, which is entirely raw in this tool) ────────────────────

export type MeHttpTransport = (path: string) => Promise<{ status: number; text: string }>;

function defaultMeHttpTransport(): MeHttpTransport {
  return async (p: string) => {
    const res = await fetch(`${ME_API_BASE}${p}`, {
      headers: { ...meAuthHeaders() },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const text = await res.text();
    return { status: res.status, text };
  };
}

export type AssetGroupingFetcher = (mint: string) => Promise<{ groupKey: string; groupValue: string } | null>;

function defaultAssetGroupingFetcher(): AssetGroupingFetcher {
  return async (mint: string) => {
    const asset = await fetchAsset(mint);
    const grouping = asset?.grouping?.find((g) => g.group_key === 'collection');
    return grouping ? { groupKey: grouping.group_key, groupValue: grouping.group_value } : null;
  };
}

/** Resolves a collection symbol to an MMM Allowlist entry. Always MCC-based
 *  (kind=3): sampled directly against real, currently-listed mints for the
 *  collection (never a single sample — cross-checks a few and requires
 *  they agree, since one sampled NFT's `creators[0]` can be an unrelated
 *  program-controlled account, e.g. a pool-inventory artifact, observed
 *  live for open_solmap — the on-chain `grouping` MCC value is the
 *  reliable signal, not `creators[0]`). */
async function resolveCollectionAllowlist(
  meGet: (path: string) => Promise<unknown>,
  fetchGrouping: AssetGroupingFetcher,
  collectionSymbol: string,
): Promise<Allowlist> {
  const listings = await meGet(`/collections/${encodeURIComponent(collectionSymbol)}/listings?limit=5`) as Array<{ tokenMint?: string }>;
  if (!Array.isArray(listings) || listings.length === 0) {
    throw new Error('collection_allowlist_unresolved: no active listings found for this collection');
  }
  const mints = listings.map((l) => l.tokenMint).filter((m): m is string => !!m).slice(0, 3);
  if (mints.length === 0) throw new Error('collection_allowlist_unresolved: no listed mints found');

  const groupValues = new Set<string>();
  for (const mint of mints) {
    const grouping = await fetchGrouping(mint);
    if (grouping?.groupValue) groupValues.add(grouping.groupValue);
  }
  if (groupValues.size === 0) {
    throw new Error('collection_allowlist_unresolved: no on-chain collection (MCC) grouping found on sampled mints');
  }
  if (groupValues.size > 1) {
    throw new Error('collection_allowlist_unresolved: sampled mints disagree on collection grouping, refusing to guess');
  }
  return { kind: ALLOWLIST_KIND.MCC, value: new PublicKey([...groupValues][0]) };
}

// ── Chain access — injectable ───────────────────────────────────────────

export interface SimAccountResult { lamports: number }
export interface SimResult {
  err: unknown; logs: string[]; accounts: Array<SimAccountResult | null> | null; unitsConsumed: number | null;
}
export interface ChainClient {
  simulateTransaction(tx: Transaction, includeAccounts?: PublicKey[]): Promise<SimResult>;
  getBlockHeight(): Promise<number>;
  getAccountInfo(pubkey: PublicKey): Promise<{ data: Buffer; lamports: number } | null>;
  sendRawTransaction(tx: Transaction): Promise<string>;
  getLatestBlockhash(): Promise<BlockhashInfo>;
  getMinimumBalanceForRentExemption(size: number): Promise<number>;
}

function defaultChainClient(conn: Connection): ChainClient {
  return {
    async simulateTransaction(tx, includeAccounts) {
      const sim = await conn.simulateTransaction(tx, undefined, includeAccounts);
      return {
        err: sim.value.err, logs: sim.value.logs ?? [],
        accounts: sim.value.accounts ?? null, unitsConsumed: sim.value.unitsConsumed ?? null,
      };
    },
    getBlockHeight: () => conn.getBlockHeight(),
    async getAccountInfo(pubkey) {
      const info = await conn.getAccountInfo(pubkey, 'confirmed');
      if (!info) return null;
      return { data: Buffer.from(info.data), lamports: info.lamports };
    },
    sendRawTransaction: (tx) => conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 }),
    getLatestBlockhash: () => conn.getLatestBlockhash('confirmed'),
    getMinimumBalanceForRentExemption: (size) => conn.getMinimumBalanceForRentExemption(size),
  };
}

// ── Digest binding + blockhash freshness — same invariant as
//    tools-me-bids.ts, independently implemented (no shared import). ────

export function messageHashHex(tx: Transaction): string {
  return createHash('sha256').update(tx.serializeMessage()).digest('hex');
}
function digestsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex'); const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export interface BlockhashInfo { blockhash: string; lastValidBlockHeight: number }
export type BlockhashCheck =
  | { ok: true }
  | { ok: false; code: 'blockhash_mismatch' | 'blockhash_expired' | 'blockhash_near_expiry'; detail: string };

export function checkBlockhashFreshness(
  tx: Transaction, info: BlockhashInfo, currentBlockHeight: number, marginBlocks: number,
): BlockhashCheck {
  if (tx.recentBlockhash !== info.blockhash) {
    return { ok: false, code: 'blockhash_mismatch', detail: `tx recentBlockhash ${String(tx.recentBlockhash)} != cached ${info.blockhash}` };
  }
  if (currentBlockHeight >= info.lastValidBlockHeight) {
    return { ok: false, code: 'blockhash_expired', detail: `currentBlockHeight ${currentBlockHeight} >= lastValidBlockHeight ${info.lastValidBlockHeight}` };
  }
  if (currentBlockHeight >= info.lastValidBlockHeight - marginBlocks) {
    return { ok: false, code: 'blockhash_near_expiry', detail: `within ${marginBlocks}-block safety margin` };
  }
  return { ok: true };
}

// ── Structural validation ───────────────────────────────────────────────

export type MmmOp = 'create' | 'deposit' | 'update' | 'withdraw-sol' | 'close';

export interface MmmValidationContext {
  op: MmmOp;
  expectedOwner: string;
  expectedCosigner: string;
  expectedPool: string;
  expectedEscrow: string | null; // null for update (no escrow account touched)
  expectedSpotPriceLamports: bigint | null; // checked when known/relevant
  expectedCurveType: number | null;
  expectedCurveDelta: bigint | null;
  expectedExpiry: bigint | null;
  expectedAllowlists: Allowlist[] | null; // create only
}

export interface ValidatedMmmTx { tx: Transaction; messageHash: string }

/** `expectSignature` mirrors tools-me-bids.ts: at build time the backend
 *  has ALREADY filled the cosigner slot (it holds that key) but the owner
 *  slot must be empty; at submit-time re-validation both must be filled. */
export function validateMmmStructure(
  tx: Transaction, ctx: MmmValidationContext, expectSignature: 'cosigner-only' | 'both',
): ValidatedMmmTx {
  if (tx.signatures.length !== 2) {
    throw new Error(`unexpected_signer_count: expected 2, got ${tx.signatures.length}`);
  }
  const [sig0, sig1] = tx.signatures;
  const owner0 = sig0.publicKey.toBase58() === ctx.expectedOwner;
  const cosignerSlot = owner0 ? sig1 : sig0;
  const ownerSlot = owner0 ? sig0 : sig1;
  if (ownerSlot.publicKey.toBase58() !== ctx.expectedOwner) throw new Error('owner_missing_from_signers');
  if (cosignerSlot.publicKey.toBase58() !== ctx.expectedCosigner) throw new Error('cosigner_missing_from_signers');

  const cosignerFilled = !!cosignerSlot.signature && cosignerSlot.signature.some((b) => b !== 0);
  const ownerFilled = !!ownerSlot.signature && ownerSlot.signature.some((b) => b !== 0);
  if (!cosignerFilled) throw new Error('cosigner_signature_missing');
  if (expectSignature === 'cosigner-only' && ownerFilled) throw new Error('unexpected_owner_signature_at_build_time');
  if (expectSignature === 'both' && !ownerFilled) throw new Error('owner_signature_missing');
  if (!tx.feePayer || tx.feePayer.toBase58() !== ctx.expectedOwner) throw new Error('fee_payer_mismatch');

  for (const ix of tx.instructions) {
    if (ix.programId.toBase58() !== MMM_PROGRAM_ID.toBase58()) {
      throw new Error(`unexpected_program_id: ${ix.programId.toBase58()}`);
    }
  }
  if (tx.instructions.length < 1) throw new Error('no_mmm_instruction');

  const allKeys = tx.instructions.flatMap((ix) => ix.keys);
  const poolKey = allKeys.find((k) => k.pubkey.toBase58() === ctx.expectedPool);
  if (!poolKey) throw new Error('pool_missing_from_instruction');

  if (ctx.expectedEscrow) {
    const escrowKey = allKeys.find((k) => k.pubkey.toBase58() === ctx.expectedEscrow && k.isWritable);
    if (!escrowKey) throw new Error('escrow_missing_or_not_writable');
  } else {
    const strayEscrow = allKeys.find((k) => k.isWritable && k.pubkey.toBase58() !== ctx.expectedPool
      && k.pubkey.toBase58() !== ctx.expectedOwner);
    if (strayEscrow) throw new Error(`unexpected_writable_account: ${strayEscrow.pubkey.toBase58()}`);
  }

  // Every writable account must be one of: pool, escrow (if expected), owner
  // (fee payer / init payer / withdraw destination). Nothing else.
  const allowedWritable = new Set([ctx.expectedPool, ctx.expectedOwner, ...(ctx.expectedEscrow ? [ctx.expectedEscrow] : [])]);
  for (const k of allKeys) {
    if (k.isWritable && !allowedWritable.has(k.pubkey.toBase58())) {
      throw new Error(`unexpected_writable_account: ${k.pubkey.toBase58()}`);
    }
  }

  return { tx, messageHash: messageHashHex(tx) };
}

// ── Digest cache — per-router-instance, TTL + hard-cap bounded, single-use.
//    Same design as tools-me-bids.ts's DigestCache, independently
//    implemented here (no shared import — this module is isolated). ──────

interface DigestEntry {
  ctx: MmmValidationContext;
  blockhashInfo: BlockhashInfo;
  expiresAt: number;
}
const DIGEST_TTL_MS = 5 * 60_000;
const DIGEST_CACHE_MAX = 500;
const DIGEST_SWEEP_INTERVAL_MS = 60_000;

class DigestCache {
  private map = new Map<string, DigestEntry>();
  constructor(private now: () => number) {}
  set(digest: string, entry: DigestEntry): void { this.cleanup(); this.map.set(digest, entry); this.cleanup(); }
  get(digest: string): DigestEntry | undefined { return this.map.get(digest); }
  consume(digest: string): DigestEntry | undefined {
    const e = this.map.get(digest); if (e) this.map.delete(digest); return e;
  }
  delete(digest: string): void { this.map.delete(digest); }
  get size(): number { return this.map.size; }
  cleanup(): void {
    const now = this.now();
    for (const [k, v] of this.map) if (v.expiresAt < now) this.map.delete(k);
    if (this.map.size > DIGEST_CACHE_MAX) {
      let toDrop = this.map.size - DIGEST_CACHE_MAX;
      for (const k of this.map.keys()) { if (toDrop-- <= 0) break; this.map.delete(k); }
    }
  }
}

// ── Input helpers ────────────────────────────────────────────────────────

function parsePubkey(v: unknown): PublicKey | null {
  if (typeof v !== 'string' || !v) return null;
  try { return new PublicKey(v); } catch { return null; }
}
function parsePositiveInt(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return null;
  return n;
}
function parseNonNegativeInt(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return null;
  return n;
}

async function readPool(chain: ChainClient, poolPk: PublicKey): Promise<{ pool: DecodedPool; escrowLamports: number } | null> {
  const acct = await chain.getAccountInfo(poolPk);
  if (!acct || acct.data.length !== POOL_ACCOUNT_SIZE) return null;
  const decoded = decodePool(acct.data);
  if (!decoded) return null;
  const escrowPk = deriveEscrowPda(poolPk);
  const escrowAcct = await chain.getAccountInfo(escrowPk);
  return { pool: decoded, escrowLamports: escrowAcct?.lamports ?? 0 };
}

export interface MmmBidsDeps {
  cosignerKeypair?: Keypair;
  cosignerKeypairPath?: string;
  cosignerExpectedPubkey?: string;
  chain?: ChainClient;
  meGet?: (path: string) => Promise<unknown>;
  fetchGrouping?: AssetGroupingFetcher;
  now?: () => number;
  authMiddleware?: RequestHandler;
  liveEnabled?: boolean;
  blockhashMarginBlocks?: number;
  rateLimitsDisabled?: boolean;
}

export interface MmmBidsTestHooks {
  digestCacheSize: () => number;
  sweepTimer: ReturnType<typeof setInterval>;
  cosignerPublicKey: string;
}

export function createMmmCollectionBidsRouter(deps: MmmBidsDeps = {}): Router & { __mmmBidsTestHooks?: MmmBidsTestHooks } {
  // Lazily loaded and memoized on first real use (not at router
  // construction / app boot time) — a misconfigured or missing cosigner
  // key file must fail closed on THIS tool's own routes only, never take
  // down the whole multi-purpose backend at startup.
  let cosignerCache: { kp: Keypair } | { err: Error } | null = null;
  function getCosigner(): Keypair {
    if (deps.cosignerKeypair) return deps.cosignerKeypair;
    if (!cosignerCache) {
      try {
        cosignerCache = { kp: loadCosignerKeypair({ keypairPath: deps.cosignerKeypairPath, expectedPubkey: deps.cosignerExpectedPubkey }) };
      } catch (err) {
        cosignerCache = { err: err instanceof Error ? err : new Error(String(err)) };
      }
    }
    if ('err' in cosignerCache) throw cosignerCache.err;
    return cosignerCache.kp;
  }

  const conn = new Connection(rpcUrl(), 'confirmed');
  const chain = deps.chain ?? defaultChainClient(conn);
  const now = deps.now ?? Date.now;
  const authMw: RequestHandler = deps.authMiddleware ?? requireAuth;
  const liveEnabled = deps.liveEnabled ?? liveEnabledFromEnv();
  const marginBlocks = deps.blockhashMarginBlocks ?? blockhashMarginBlocksFromEnv();

  const meTransport = defaultMeHttpTransport();
  const meGet = deps.meGet ?? (async (p: string) => {
    if (!hasMeApiKey()) throw new Error('me_api_key_not_configured');
    const res = await meTransport(p);
    if (res.status < 200 || res.status >= 300) throw new Error(`me_api_error_${res.status}`);
    try { return JSON.parse(res.text); } catch { throw new Error('me_response_not_json'); }
  });
  const fetchGrouping = deps.fetchGrouping ?? defaultAssetGroupingFetcher();

  const router = Router() as Router & { __mmmBidsTestHooks?: MmmBidsTestHooks };
  const noopLimit: RequestHandler = (_req, _res, next) => next();
  const readLimit = deps.rateLimitsDisabled ? noopLimit : rateLimit({ limit: 30, windowMs: 60_000, label: 'tools/mmm-bids/read' });
  const buildLimit = deps.rateLimitsDisabled ? noopLimit : rateLimit({ limit: 15, windowMs: 60_000, label: 'tools/mmm-bids/build' });
  const simLimit = deps.rateLimitsDisabled ? noopLimit : rateLimit({ limit: 15, windowMs: 60_000, label: 'tools/mmm-bids/simulate' });
  const submitLimit = deps.rateLimitsDisabled ? noopLimit : rateLimit({ limit: 10, windowMs: 60_000, label: 'tools/mmm-bids/submit' });

  const digestCache = new DigestCache(now);
  const sweepTimer = setInterval(() => digestCache.cleanup(), DIGEST_SWEEP_INTERVAL_MS);
  sweepTimer.unref();
  router.__mmmBidsTestHooks = {
    digestCacheSize: () => digestCache.size,
    sweepTimer,
    get cosignerPublicKey() { return getCosigner().publicKey.toBase58(); },
  } as MmmBidsTestHooks;

  function finalizeBuild(
    tx: Transaction, ctx: MmmValidationContext, lastValidBlockHeight: number,
  ): { txBase64: string; digest: string; expiresAt: number } {
    tx.partialSign(getCosigner());
    const validated = validateMmmStructure(tx, ctx, 'cosigner-only');
    const expiresAt = now() + DIGEST_TTL_MS;
    digestCache.set(validated.messageHash, {
      ctx, blockhashInfo: { blockhash: tx.recentBlockhash!, lastValidBlockHeight }, expiresAt,
    });
    return {
      txBase64: validated.tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
      digest: validated.messageHash,
      expiresAt,
    };
  }

  router.get('/tools/mmm-collection-bids/status', authMw, (_req: Request, res: Response) => {
    res.json({ ok: true, liveEnabled, cosignerPubkey: getCosigner().publicKey.toBase58() });
  });

  router.get('/tools/mmm-collection-bids/pool', readLimit, authMw, async (req: Request, res: Response) => {
    const poolPk = parsePubkey(req.query.poolKey);
    if (!poolPk) return res.status(400).json({ ok: false, error: 'invalid_pool_key' });
    try {
      const result = await readPool(chain, poolPk);
      if (!result) return res.status(404).json({ ok: false, error: 'pool_not_found' });
      const { pool, escrowLamports } = result;
      return res.json({
        ok: true,
        pool: {
          poolKey: poolPk.toBase58(),
          owner: pool.owner,
          cosigner: pool.cosigner,
          spotPriceSol: Number(pool.spotPriceLamports) / 1e9,
          curveType: pool.curveType === CURVE_KIND_LINEAR ? 'linear' : 'exp',
          curveDelta: pool.curveDelta.toString(),
          expiry: pool.expiry.toString(),
          lpFeeBp: pool.lpFeeBp,
          buysideCreatorRoyaltyBp: pool.buysideCreatorRoyaltyBp,
          sellsideAssetAmount: pool.sellsideAssetAmount.toString(),
          escrowPda: deriveEscrowPda(poolPk).toBase58(),
          escrowBalanceSol: escrowLamports / 1e9,
          estimatedRemainingQuantity: pool.spotPriceLamports > 0n
            ? Math.floor(escrowLamports / Number(pool.spotPriceLamports)) : 0,
          allowlists: pool.allowlists.filter((a) => a.kind !== ALLOWLIST_KIND.EMPTY)
            .map((a) => ({ kind: a.kind, value: a.value.toBase58() })),
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/mmm-collection-bids] pool read error', msg);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  router.post('/tools/mmm-collection-bids/build/create', buildLimit, authMw, async (req: Request, res: Response) => {
    const { owner, collectionSymbol, pricePerNftLamports, maxQuantity, expiry } = req.body as {
      owner?: string; collectionSymbol?: string; pricePerNftLamports?: number; maxQuantity?: number; expiry?: number;
    };
    const ownerPk = parsePubkey(owner);
    const price = parsePositiveInt(pricePerNftLamports);
    const quantity = parsePositiveInt(maxQuantity);
    const expiryVal = expiry != null ? parseNonNegativeInt(expiry) : 0;
    if (!ownerPk) return res.status(400).json({ ok: false, error: 'invalid_owner' });
    if (ownerPk.toBase58() === getCosigner().publicKey.toBase58()) return res.status(400).json({ ok: false, error: 'owner_equals_cosigner' });
    if (!collectionSymbol) return res.status(400).json({ ok: false, error: 'invalid_collection_symbol' });
    if (price == null) return res.status(400).json({ ok: false, error: 'invalid_price_per_nft_lamports' });
    if (quantity == null) return res.status(400).json({ ok: false, error: 'invalid_max_quantity' });
    if (expiryVal == null) return res.status(400).json({ ok: false, error: 'invalid_expiry' });

    try {
      const allowlist = await resolveCollectionAllowlist(meGet, fetchGrouping, collectionSymbol);
      const uuid = generatePoolUuid();
      const pool = derivePoolPda(ownerPk, uuid);
      const escrow = deriveEscrowPda(pool);
      const requiredLiquidityLamports = BigInt(price) * BigInt(quantity);

      const createIx = buildCreatePoolIx(
        { owner: ownerPk, cosigner: getCosigner().publicKey, pool },
        {
          spotPriceLamports: BigInt(price), curveType: CURVE_KIND_LINEAR, curveDelta: 0n,
          reinvestFulfillBuy: false, reinvestFulfillSell: false, expiry: BigInt(expiryVal),
          lpFeeBp: 0, referral: PublicKey.default, cosignerAnnotation: Buffer.alloc(32),
          buysideCreatorRoyaltyBp: 0, uuid, allowlists: normalizeAllowlists([allowlist]),
        },
      );
      const depositIx = buildSolDepositBuyIx(
        { owner: ownerPk, cosigner: getCosigner().publicKey, pool, escrow }, requiredLiquidityLamports,
      );

      const { blockhash, lastValidBlockHeight } = await chain.getLatestBlockhash();
      const tx = new Transaction().add(createIx, depositIx);
      tx.feePayer = ownerPk;
      tx.recentBlockhash = blockhash;

      const ctx: MmmValidationContext = {
        op: 'create', expectedOwner: ownerPk.toBase58(), expectedCosigner: getCosigner().publicKey.toBase58(),
        expectedPool: pool.toBase58(), expectedEscrow: escrow.toBase58(),
        expectedSpotPriceLamports: BigInt(price), expectedCurveType: CURVE_KIND_LINEAR, expectedCurveDelta: 0n,
        expectedExpiry: BigInt(expiryVal), expectedAllowlists: normalizeAllowlists([allowlist]),
      };

      const preflight = await chain.simulateTransaction(tx, [escrow]);
      if (preflight.err != null) {
        return res.status(502).json({ ok: false, error: 'preflight_simulation_failed', simErr: preflight.err, logs: preflight.logs });
      }
      const escrowPost = preflight.accounts?.[0]?.lamports ?? null;
      if (escrowPost != null && BigInt(escrowPost) > requiredLiquidityLamports + 5_000n) {
        return res.status(502).json({ ok: false, error: 'escrow_balance_exceeds_expected' });
      }

      const built = finalizeBuild(tx, ctx, lastValidBlockHeight);
      const poolRent = await chain.getMinimumBalanceForRentExemption(POOL_ACCOUNT_SIZE);

      return res.json({
        ok: true, tx: built.txBase64, digest: built.digest, expiresAt: built.expiresAt,
        preflight: { ok: true, logs: preflight.logs },
        summary: {
          action: 'create', owner: ownerPk.toBase58(), collectionSymbol, poolKey: pool.toBase58(),
          escrowPda: escrow.toBase58(), pricePerNftSol: price / 1e9, maxQuantity: quantity,
          requiredLiquiditySol: Number(requiredLiquidityLamports) / 1e9,
          poolRentSol: poolRent / 1e9, escrowRentSol: ESCROW_RENT_EXEMPT_LAMPORTS / 1e9,
          totalRequiredWalletSol: (poolRent + Number(requiredLiquidityLamports)) / 1e9,
          curveType: 'linear', curveDelta: '0', lpFeeBp: 0, buysideCreatorRoyaltyBp: 0,
          expiry: expiryVal, allowlistKind: allowlist.kind, allowlistValue: allowlist.value.toBase58(),
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/mmm-collection-bids] build/create error', msg);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  router.post('/tools/mmm-collection-bids/build/deposit', buildLimit, authMw, async (req: Request, res: Response) => {
    const { poolKey, additionalQuantity } = req.body as { poolKey?: string; additionalQuantity?: number };
    const poolPk = parsePubkey(poolKey);
    const qty = parsePositiveInt(additionalQuantity);
    if (!poolPk) return res.status(400).json({ ok: false, error: 'invalid_pool_key' });
    if (qty == null) return res.status(400).json({ ok: false, error: 'invalid_additional_quantity' });

    try {
      const result = await readPool(chain, poolPk);
      if (!result) return res.status(404).json({ ok: false, error: 'pool_not_found' });
      const { pool } = result;
      const ownerPk = new PublicKey(pool.owner);
      if (pool.cosigner !== getCosigner().publicKey.toBase58()) return res.status(409).json({ ok: false, error: 'pool_not_managed_by_this_tool' });
      const escrow = deriveEscrowPda(poolPk);
      const additionalLamports = pool.spotPriceLamports * BigInt(qty);

      const ix = buildSolDepositBuyIx({ owner: ownerPk, cosigner: getCosigner().publicKey, pool: poolPk, escrow }, additionalLamports);
      const { blockhash, lastValidBlockHeight } = await chain.getLatestBlockhash();
      const tx = new Transaction().add(ix);
      tx.feePayer = ownerPk;
      tx.recentBlockhash = blockhash;

      const ctx: MmmValidationContext = {
        op: 'deposit', expectedOwner: ownerPk.toBase58(), expectedCosigner: getCosigner().publicKey.toBase58(),
        expectedPool: poolPk.toBase58(), expectedEscrow: escrow.toBase58(),
        expectedSpotPriceLamports: pool.spotPriceLamports, expectedCurveType: pool.curveType,
        expectedCurveDelta: pool.curveDelta, expectedExpiry: pool.expiry, expectedAllowlists: null,
      };
      const preflight = await chain.simulateTransaction(tx, [escrow]);
      if (preflight.err != null) return res.status(502).json({ ok: false, error: 'preflight_simulation_failed', simErr: preflight.err, logs: preflight.logs });

      const built = finalizeBuild(tx, ctx, lastValidBlockHeight);
      return res.json({
        ok: true, tx: built.txBase64, digest: built.digest, expiresAt: built.expiresAt,
        preflight: { ok: true, logs: preflight.logs },
        summary: {
          action: 'deposit', poolKey: poolPk.toBase58(), additionalQuantity: qty,
          additionalLiquiditySol: Number(additionalLamports) / 1e9,
          escrowBalanceBeforeSol: result.escrowLamports / 1e9,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/mmm-collection-bids] build/deposit error', msg);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  router.post('/tools/mmm-collection-bids/build/update', buildLimit, authMw, async (req: Request, res: Response) => {
    const { poolKey, spotPriceLamports, expiry } = req.body as { poolKey?: string; spotPriceLamports?: number; expiry?: number };
    const poolPk = parsePubkey(poolKey);
    if (!poolPk) return res.status(400).json({ ok: false, error: 'invalid_pool_key' });
    const newPrice = spotPriceLamports != null ? parsePositiveInt(spotPriceLamports) : null;
    const newExpiry = expiry != null ? parseNonNegativeInt(expiry) : null;

    try {
      const result = await readPool(chain, poolPk);
      if (!result) return res.status(404).json({ ok: false, error: 'pool_not_found' });
      const { pool } = result;
      if (pool.cosigner !== getCosigner().publicKey.toBase58()) return res.status(409).json({ ok: false, error: 'pool_not_managed_by_this_tool' });
      const ownerPk = new PublicKey(pool.owner);

      // Only spotPrice/expiry are ever changeable via this route — every
      // other field is re-read from the pool's OWN current state, never
      // silently altered by a client-supplied value.
      const finalPrice = newPrice ?? pool.spotPriceLamports;
      const finalExpiry = newExpiry ?? pool.expiry;

      const ix = buildUpdatePoolIx(
        { owner: ownerPk, cosigner: getCosigner().publicKey, pool: poolPk },
        {
          spotPriceLamports: BigInt(finalPrice), curveType: pool.curveType, curveDelta: pool.curveDelta,
          reinvestFulfillBuy: pool.reinvestFulfillBuy, reinvestFulfillSell: pool.reinvestFulfillSell,
          expiry: BigInt(finalExpiry), lpFeeBp: pool.lpFeeBp, referral: new PublicKey(pool.referral),
          cosignerAnnotation: Buffer.alloc(32), buysideCreatorRoyaltyBp: pool.buysideCreatorRoyaltyBp,
        },
      );
      const { blockhash, lastValidBlockHeight } = await chain.getLatestBlockhash();
      const tx = new Transaction().add(ix);
      tx.feePayer = ownerPk;
      tx.recentBlockhash = blockhash;

      const ctx: MmmValidationContext = {
        op: 'update', expectedOwner: ownerPk.toBase58(), expectedCosigner: getCosigner().publicKey.toBase58(),
        expectedPool: poolPk.toBase58(), expectedEscrow: null,
        expectedSpotPriceLamports: BigInt(finalPrice), expectedCurveType: pool.curveType,
        expectedCurveDelta: pool.curveDelta, expectedExpiry: BigInt(finalExpiry), expectedAllowlists: null,
      };
      const preflight = await chain.simulateTransaction(tx);
      if (preflight.err != null) return res.status(502).json({ ok: false, error: 'preflight_simulation_failed', simErr: preflight.err, logs: preflight.logs });

      const built = finalizeBuild(tx, ctx, lastValidBlockHeight);
      return res.json({
        ok: true, tx: built.txBase64, digest: built.digest, expiresAt: built.expiresAt,
        preflight: { ok: true, logs: preflight.logs },
        summary: {
          action: 'update', poolKey: poolPk.toBase58(),
          oldPriceSol: Number(pool.spotPriceLamports) / 1e9, newPriceSol: Number(finalPrice) / 1e9,
          oldExpiry: pool.expiry.toString(), newExpiry: finalExpiry.toString(),
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/mmm-collection-bids] build/update error', msg);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  router.post('/tools/mmm-collection-bids/build/withdraw-sol', buildLimit, authMw, async (req: Request, res: Response) => {
    const { poolKey, amountLamports } = req.body as { poolKey?: string; amountLamports?: number };
    const poolPk = parsePubkey(poolKey);
    const amount = parsePositiveInt(amountLamports);
    if (!poolPk) return res.status(400).json({ ok: false, error: 'invalid_pool_key' });
    if (amount == null) return res.status(400).json({ ok: false, error: 'invalid_amount_lamports' });

    try {
      const result = await readPool(chain, poolPk);
      if (!result) return res.status(404).json({ ok: false, error: 'pool_not_found' });
      const { pool, escrowLamports } = result;
      if (pool.cosigner !== getCosigner().publicKey.toBase58()) return res.status(409).json({ ok: false, error: 'pool_not_managed_by_this_tool' });
      if (amount > escrowLamports) return res.status(409).json({ ok: false, error: 'withdrawal_exceeds_known_escrow_balance' });
      const residual = escrowLamports - amount;
      if (residual !== 0 && residual < ESCROW_RENT_EXEMPT_LAMPORTS) {
        return res.status(409).json({
          ok: false,
          error: `withdrawal_leaves_non_rent_exempt_residual: residual ${residual} lamports, must be 0 or >= ${ESCROW_RENT_EXEMPT_LAMPORTS}`,
        });
      }
      const ownerPk = new PublicKey(pool.owner);
      const escrow = deriveEscrowPda(poolPk);

      const ix = buildSolWithdrawBuyIx({ owner: ownerPk, cosigner: getCosigner().publicKey, pool: poolPk, escrow }, BigInt(amount));
      const { blockhash, lastValidBlockHeight } = await chain.getLatestBlockhash();
      const tx = new Transaction().add(ix);
      tx.feePayer = ownerPk;
      tx.recentBlockhash = blockhash;

      const ctx: MmmValidationContext = {
        op: 'withdraw-sol', expectedOwner: ownerPk.toBase58(), expectedCosigner: getCosigner().publicKey.toBase58(),
        expectedPool: poolPk.toBase58(), expectedEscrow: escrow.toBase58(),
        expectedSpotPriceLamports: pool.spotPriceLamports, expectedCurveType: pool.curveType,
        expectedCurveDelta: pool.curveDelta, expectedExpiry: pool.expiry, expectedAllowlists: null,
      };
      const preflight = await chain.simulateTransaction(tx, [escrow]);
      if (preflight.err != null) return res.status(502).json({ ok: false, error: 'preflight_simulation_failed', simErr: preflight.err, logs: preflight.logs });
      const escrowPost = preflight.accounts?.[0]?.lamports ?? null;
      if (escrowPost != null && escrowPost < residual - 1000 && escrowPost !== 0) {
        return res.status(502).json({ ok: false, error: 'withdrawal_amount_exceeds_expected' });
      }

      const built = finalizeBuild(tx, ctx, lastValidBlockHeight);
      return res.json({
        ok: true, tx: built.txBase64, digest: built.digest, expiresAt: built.expiresAt,
        preflight: { ok: true, logs: preflight.logs },
        summary: {
          action: 'withdraw-sol', poolKey: poolPk.toBase58(), amountSol: amount / 1e9,
          escrowBalanceBeforeSol: escrowLamports / 1e9, escrowBalanceAfterSimSol: escrowPost != null ? escrowPost / 1e9 : null,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/mmm-collection-bids] build/withdraw-sol error', msg);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  router.post('/tools/mmm-collection-bids/build/close', buildLimit, authMw, async (req: Request, res: Response) => {
    const { poolKey } = req.body as { poolKey?: string };
    const poolPk = parsePubkey(poolKey);
    if (!poolPk) return res.status(400).json({ ok: false, error: 'invalid_pool_key' });

    try {
      const result = await readPool(chain, poolPk);
      if (!result) return res.status(404).json({ ok: false, error: 'pool_not_found' });
      const { pool, escrowLamports } = result;
      if (pool.cosigner !== getCosigner().publicKey.toBase58()) return res.status(409).json({ ok: false, error: 'pool_not_managed_by_this_tool' });
      if (escrowLamports !== 0) return res.status(409).json({ ok: false, error: 'escrow_not_empty_withdraw_first' });
      if (pool.sellsideAssetAmount !== 0n) return res.status(409).json({ ok: false, error: 'sellside_inventory_not_empty' });

      const ownerPk = new PublicKey(pool.owner);
      const escrow = deriveEscrowPda(poolPk);
      const ix = buildSolClosePoolIx({ owner: ownerPk, cosigner: getCosigner().publicKey, pool: poolPk, escrow });
      const { blockhash, lastValidBlockHeight } = await chain.getLatestBlockhash();
      const tx = new Transaction().add(ix);
      tx.feePayer = ownerPk;
      tx.recentBlockhash = blockhash;

      const ctx: MmmValidationContext = {
        op: 'close', expectedOwner: ownerPk.toBase58(), expectedCosigner: getCosigner().publicKey.toBase58(),
        expectedPool: poolPk.toBase58(), expectedEscrow: null,
        expectedSpotPriceLamports: null, expectedCurveType: null, expectedCurveDelta: null,
        expectedExpiry: null, expectedAllowlists: null,
      };
      const preflight = await chain.simulateTransaction(tx);
      if (preflight.err != null) return res.status(502).json({ ok: false, error: 'preflight_simulation_failed', simErr: preflight.err, logs: preflight.logs });

      const poolRent = await chain.getMinimumBalanceForRentExemption(POOL_ACCOUNT_SIZE);
      const built = finalizeBuild(tx, ctx, lastValidBlockHeight);
      return res.json({
        ok: true, tx: built.txBase64, digest: built.digest, expiresAt: built.expiresAt,
        preflight: { ok: true, logs: preflight.logs },
        summary: { action: 'close', poolKey: poolPk.toBase58(), reclaimedRentSol: poolRent / 1e9 },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/mmm-collection-bids] build/close error', msg);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  router.post('/tools/mmm-collection-bids/simulate', simLimit, authMw, async (req: Request, res: Response) => {
    const { tx } = req.body as { tx?: string };
    if (!tx || typeof tx !== 'string') return res.status(400).json({ ok: false, error: 'missing_tx' });
    let decoded: Transaction;
    try { decoded = Transaction.from(Buffer.from(tx, 'base64')); } catch (err) {
      return res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    try {
      const sim = await chain.simulateTransaction(decoded);
      return res.json({ ok: true, err: sim.err, logs: sim.logs, unitsConsumed: sim.unitsConsumed });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/mmm-collection-bids] simulate error', msg);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  router.post('/tools/mmm-collection-bids/submit', submitLimit, authMw, async (req: Request, res: Response) => {
    if (!liveEnabled) return res.status(403).json({ ok: false, error: 'live_mode_disabled_server_side' });
    const { signedTx, digest } = req.body as { signedTx?: string; digest?: string };
    if (!signedTx || typeof signedTx !== 'string') return res.status(400).json({ ok: false, error: 'missing_signed_tx' });
    if (!digest || typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
      return res.status(400).json({ ok: false, error: 'missing_or_malformed_digest' });
    }

    const entry = digestCache.get(digest);
    if (!entry) return res.status(410).json({ ok: false, error: 'digest_not_found_expired_or_already_used' });
    if (entry.expiresAt < now()) { digestCache.delete(digest); return res.status(410).json({ ok: false, error: 'digest_expired' }); }

    let tx: Transaction;
    try { tx = Transaction.from(Buffer.from(signedTx, 'base64')); } catch (err) {
      return res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    const recomputed = messageHashHex(tx);
    if (!digestsEqual(recomputed, digest)) {
      return res.status(409).json({ ok: false, error: 'signed_tx_message_does_not_match_digest' });
    }
    if (tx.recentBlockhash !== entry.blockhashInfo.blockhash) {
      return res.status(409).json({ ok: false, error: 'blockhash_mismatch' });
    }

    let currentBlockHeight: number;
    try { currentBlockHeight = await chain.getBlockHeight(); } catch (err) {
      console.error('[tools/mmm-collection-bids] submit getBlockHeight error', err);
      return res.status(502).json({ ok: false, error: 'block_height_unavailable' });
    }
    const freshness = checkBlockhashFreshness(tx, entry.blockhashInfo, currentBlockHeight, marginBlocks);
    if (!freshness.ok) return res.status(410).json({ ok: false, error: freshness.code, detail: freshness.detail });

    const consumed = digestCache.consume(digest);
    if (!consumed) return res.status(410).json({ ok: false, error: 'digest_not_found_expired_or_already_used' });

    try {
      validateMmmStructure(tx, entry.ctx, 'both');
    } catch (err) {
      return res.status(409).json({ ok: false, error: `revalidation_failed: ${err instanceof Error ? err.message : String(err)}` });
    }

    if (!tx.verifySignatures(true)) {
      return res.status(400).json({ ok: false, error: 'invalid_signature' });
    }

    try {
      const signature = await chain.sendRawTransaction(tx);
      return res.json({ ok: true, signature });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/mmm-collection-bids] submit sendRawTransaction error', msg);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  return router;
}
