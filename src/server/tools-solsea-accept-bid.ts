/**
 * SolSea forgotten-bid Accept Bid tool — personal use only, not a public
 * feature. Mirrors `tools-solanart-accept-offer.ts` architecture exactly
 * (DRY-RUN-first, single-signer, digest-bound build→simulate→submit) — see
 * `solsea-raw-instructions.ts` for the full evidence trail behind every
 * account/discriminator used here.
 *
 * NATIVE SOL BIDS ONLY for now — a bid whose `currency` field isn't the
 * System Program sentinel is refused with a clear error rather than
 * silently mis-built (the multicurrency accept path is a different,
 * unverified instruction).
 *
 * Single signer: only the seller's connected wallet signs. Unlike
 * Solanart's flow, the buyer's NFT-receiving token account does NOT
 * generally pre-exist for SolSea bids — this tool creates it as part of
 * the same transaction (the seller pays its ~0.002 SOL rent, refunded to
 * nobody since it's a real new account, not a temp one).
 *
 *   GET  /api/tools/solsea-accept-bid/status              — { liveEnabled }
 *   GET  /api/tools/solsea-accept-bid/bid?bidKey=          — decoded bid + currency check
 *   POST /api/tools/solsea-accept-bid/build                — { seller, bidKey }
 *   POST /api/tools/solsea-accept-bid/simulate              — { tx: base64 }
 *   POST /api/tools/solsea-accept-bid/submit                — { signedTx: base64, digest }
 *
 * LIVE mode gated by `SOLSEA_ACCEPT_BID_ENABLE_LIVE`, defaults false, fails
 * closed — DRY RUN (build + simulate, no signature ever requested) always
 * available regardless.
 */

import { Router, Request, Response, RequestHandler } from 'express';
import { PublicKey, Connection, Transaction, TransactionInstruction, ComputeBudgetProgram } from '@solana/web3.js';
import { createHash } from 'crypto';
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction } from '@solana/spl-token';
import { rateLimit } from './rate-limit';
import { requireAuth } from './runtime';
import {
  SOLSEA_PROGRAM_ID, BIDDING_ACCOUNT_SIZE, decodeBid, deriveMetadataPda,
  buildAcceptUnlistedBidIx, NATIVE_SOL_CURRENCY_SENTINEL,
  type DecodedBid,
} from './solsea-raw-instructions';

function liveEnabledFromEnv(): boolean {
  return (process.env.SOLSEA_ACCEPT_BID_ENABLE_LIVE ?? '').trim().toLowerCase() === 'true';
}

const DEFAULT_BLOCKHASH_MARGIN_BLOCKS = 10;
function blockhashMarginBlocksFromEnv(): number {
  const v = Number(process.env.SOLSEA_ACCEPT_BID_BLOCKHASH_MARGIN_BLOCKS);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_BLOCKHASH_MARGIN_BLOCKS;
}

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  return key ? `https://beta.helius-rpc.com/?api-key=${key}` : 'https://api.mainnet-beta.solana.com';
}

// ── Chain access — injectable for tests ─────────────────────────────────

export interface SimResult { err: unknown; logs: string[]; unitsConsumed: number | null }
export interface ChainClient {
  simulateTransaction(tx: Transaction): Promise<SimResult>;
  getBlockHeight(): Promise<number>;
  getAccountInfo(pubkey: PublicKey): Promise<{ data: Buffer; lamports: number } | null>;
  sendRawTransaction(tx: Transaction): Promise<string>;
  getLatestBlockhash(): Promise<BlockhashInfo>;
}

function defaultChainClient(conn: Connection): ChainClient {
  return {
    async simulateTransaction(tx) {
      const sim = await conn.simulateTransaction(tx);
      return { err: sim.value.err, logs: sim.value.logs ?? [], unitsConsumed: sim.value.unitsConsumed ?? null };
    },
    getBlockHeight: () => conn.getBlockHeight(),
    async getAccountInfo(pubkey) {
      const info = await conn.getAccountInfo(pubkey, 'confirmed');
      if (!info) return null;
      return { data: Buffer.from(info.data), lamports: info.lamports };
    },
    sendRawTransaction: (tx) => conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 }),
    getLatestBlockhash: () => conn.getLatestBlockhash('confirmed'),
  };
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

export function messageHashHex(tx: Transaction): string {
  return createHash('sha256').update(tx.serializeMessage()).digest('hex');
}

/** Single-signer structural check: exactly one signer (the seller), the
 *  last instruction targets the SolSea program with the bid + mint present
 *  and correctly flagged. Instruction count is 2 or 3 (ComputeBudget +
 *  optional CreateAssociatedTokenAccount + the accept instruction),
 *  depending on whether the buyer's ATA already existed at build time. */
export interface SolseaValidationContext {
  expectedSeller: string;
  expectedBid: string;
  expectedMint: string;
}
export interface ValidatedTx { tx: Transaction; messageHash: string }

export function validateAcceptBidStructure(
  tx: Transaction, ctx: SolseaValidationContext, expectSignature: 'none' | 'seller',
): ValidatedTx {
  if (tx.signatures.length !== 1) throw new Error(`unexpected_signer_count: expected 1, got ${tx.signatures.length}`);
  const [sig] = tx.signatures;
  if (sig.publicKey.toBase58() !== ctx.expectedSeller) throw new Error('seller_missing_from_signers');
  const filled = !!sig.signature && sig.signature.some((b) => b !== 0);
  if (expectSignature === 'none' && filled) throw new Error('unexpected_seller_signature_at_build_time');
  if (expectSignature === 'seller' && !filled) throw new Error('seller_signature_missing');
  if (!tx.feePayer || tx.feePayer.toBase58() !== ctx.expectedSeller) throw new Error('fee_payer_mismatch');

  // Exactly one SolSea instruction, anywhere in the list. We deliberately
  // do NOT restrict what else is in the transaction — normally that's our
  // own ComputeBudget bump plus an optional CreateAssociatedTokenAccount
  // for the buyer, but wallets (Phantom in particular) routinely inject
  // their own extra instructions at sign time (a priority-fee bump, or
  // their own transaction-safety tooling — observed in practice: a
  // Switchboard-style "CallbackComputation" instruction, program
  // `L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95`, presumably part of
  // Phantom's simulate-and-warn pipeline) — and trying to keep an
  // allowlist of every program a wallet might someday add is both fragile
  // and unnecessary. The user already reviews the FULL transaction in
  // their own wallet's confirmation UI before signing; anything the
  // wallet itself added is something they approved. Our security boundary
  // is narrower and doesn't depend on policing the rest of the
  // transaction: an unrelated extra instruction operates on its own
  // program's accounts and cannot reach into or alter what OUR
  // instruction does with the seller/bid/mint accounts we check below.
  if (tx.instructions.length < 1) throw new Error('unexpected_instruction_count');
  const solseaIxs = tx.instructions.filter((i) => i.programId.toBase58() === SOLSEA_PROGRAM_ID.toBase58());
  if (solseaIxs.length !== 1) throw new Error(`unexpected_solsea_instruction_count: ${solseaIxs.length}`);
  const [ix] = solseaIxs;

  const hasBid = ix.keys.some((k) => k.pubkey.toBase58() === ctx.expectedBid && k.isWritable);
  if (!hasBid) throw new Error('bid_missing_or_not_writable');
  const hasMint = ix.keys.some((k) => k.pubkey.toBase58() === ctx.expectedMint && !k.isWritable);
  if (!hasMint) throw new Error('mint_missing_or_unexpectedly_writable');

  return { tx, messageHash: messageHashHex(tx) };
}

// ── Digest cache — bounded, single-use, TTL'd. Same pattern as the
//    Solanart/MMM tools, independently implemented (no shared import). ────

interface DigestEntry { ctx: SolseaValidationContext; blockhashInfo: BlockhashInfo; expiresAt: number }
const DIGEST_TTL_MS = 5 * 60_000;
const DIGEST_CACHE_MAX = 500;
const DIGEST_SWEEP_INTERVAL_MS = 60_000;

class DigestCache {
  private map = new Map<string, DigestEntry>();
  constructor(private now: () => number) {}
  set(digest: string, entry: DigestEntry): void { this.cleanup(); this.map.set(digest, entry); this.cleanup(); }
  get(digest: string): DigestEntry | undefined { return this.map.get(digest); }
  consume(digest: string): DigestEntry | undefined { const e = this.map.get(digest); if (e) this.map.delete(digest); return e; }
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

function parsePubkey(v: unknown): PublicKey | null {
  if (typeof v !== 'string' || !v) return null;
  try { return new PublicKey(v); } catch { return null; }
}

async function readBid(chain: ChainClient, bidPk: PublicKey): Promise<DecodedBid | null> {
  const acct = await chain.getAccountInfo(bidPk);
  if (!acct || acct.data.length !== BIDDING_ACCOUNT_SIZE) return null;
  return decodeBid(acct.data);
}

export interface SolseaAcceptBidDeps {
  chain?: ChainClient;
  now?: () => number;
  authMiddleware?: RequestHandler;
  liveEnabled?: boolean;
  blockhashMarginBlocks?: number;
  rateLimitsDisabled?: boolean;
}

export function createSolseaAcceptBidRouter(deps: SolseaAcceptBidDeps = {}): Router {
  const conn = new Connection(rpcUrl(), 'confirmed');
  const chain = deps.chain ?? defaultChainClient(conn);
  const now = deps.now ?? Date.now;
  const authMw: RequestHandler = deps.authMiddleware ?? requireAuth;
  const liveEnabled = deps.liveEnabled ?? liveEnabledFromEnv();
  const marginBlocks = deps.blockhashMarginBlocks ?? blockhashMarginBlocksFromEnv();

  const router = Router();
  const noopLimit: RequestHandler = (_req, _res, next) => next();
  const readLimit = deps.rateLimitsDisabled ? noopLimit : rateLimit({ limit: 30, windowMs: 60_000, label: 'tools/solsea-accept-bid/read' });
  const buildLimit = deps.rateLimitsDisabled ? noopLimit : rateLimit({ limit: 15, windowMs: 60_000, label: 'tools/solsea-accept-bid/build' });
  const simLimit = deps.rateLimitsDisabled ? noopLimit : rateLimit({ limit: 15, windowMs: 60_000, label: 'tools/solsea-accept-bid/simulate' });
  const submitLimit = deps.rateLimitsDisabled ? noopLimit : rateLimit({ limit: 10, windowMs: 60_000, label: 'tools/solsea-accept-bid/submit' });

  const digestCache = new DigestCache(now);
  const sweepTimer = setInterval(() => digestCache.cleanup(), DIGEST_SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  router.get('/tools/solsea-accept-bid/status', authMw, (_req: Request, res: Response) => {
    res.json({ ok: true, liveEnabled });
  });

  router.get('/tools/solsea-accept-bid/bid', readLimit, authMw, async (req: Request, res: Response) => {
    const bidPk = parsePubkey(req.query.bidKey);
    if (!bidPk) return res.status(400).json({ ok: false, error: 'invalid_bid_key' });
    try {
      const bid = await readBid(chain, bidPk);
      if (!bid) return res.status(404).json({ ok: false, error: 'bid_not_found_or_already_closed' });
      if (bid.header !== '0101') return res.status(409).json({ ok: false, error: 'bid_not_active' });
      const isNativeSol = bid.currency.toBase58() === NATIVE_SOL_CURRENCY_SENTINEL.toBase58();
      return res.json({
        ok: true,
        bid: {
          bidKey: bidPk.toBase58(), bidder: bid.bidder.toBase58(), mint: bid.mint.toBase58(),
          priceSol: isNativeSol ? Number(bid.priceRaw) / 1e9 : null,
          priceRaw: bid.priceRaw.toString(), currency: bid.currency.toBase58(), isNativeSol,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/solsea-accept-bid] bid read error', msg);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  router.post('/tools/solsea-accept-bid/build', buildLimit, authMw, async (req: Request, res: Response) => {
    const { seller, bidKey } = req.body as { seller?: string; bidKey?: string };
    const sellerPk = parsePubkey(seller);
    const bidPk = parsePubkey(bidKey);
    if (!sellerPk) return res.status(400).json({ ok: false, error: 'invalid_seller' });
    if (!bidPk) return res.status(400).json({ ok: false, error: 'invalid_bid_key' });

    try {
      const bid = await readBid(chain, bidPk);
      if (!bid) return res.status(404).json({ ok: false, error: 'bid_not_found_or_already_closed' });
      if (bid.header !== '0101') return res.status(409).json({ ok: false, error: 'bid_not_active' });
      if (bid.currency.toBase58() !== NATIVE_SOL_CURRENCY_SENTINEL.toBase58()) {
        return res.status(409).json({ ok: false, error: 'non_native_currency_not_supported_yet' });
      }

      const bidAcctInfo = await chain.getAccountInfo(bidPk);
      if (!bidAcctInfo) return res.status(404).json({ ok: false, error: 'bid_not_found_or_already_closed' });
      const rentExempt = 5_066_880; // 600-byte account rent-exempt minimum, confirmed constant across the dataset
      if (BigInt(bidAcctInfo.lamports) < bid.priceRaw + BigInt(rentExempt)) {
        return res.status(409).json({ ok: false, error: 'bid_escrow_underfunded' });
      }

      const sellerAta = getAssociatedTokenAddressSync(bid.mint, sellerPk, true);
      const sellerAtaAcct = await chain.getAccountInfo(sellerAta);
      if (!sellerAtaAcct || sellerAtaAcct.data.length < 72 || sellerAtaAcct.data.readBigUInt64LE(64) !== 1n) {
        return res.status(409).json({ ok: false, error: 'seller_does_not_hold_this_nft' });
      }

      const metadataPda = deriveMetadataPda(bid.mint);
      const metadataAcct = await chain.getAccountInfo(metadataPda);
      if (!metadataAcct) return res.status(502).json({ ok: false, error: 'metadata_account_not_found' });

      const buyerAta = getAssociatedTokenAddressSync(bid.mint, bid.bidder, true);
      const buyerAtaAcct = await chain.getAccountInfo(buyerAta);

      const ix: TransactionInstruction = buildAcceptUnlistedBidIx({
        seller: sellerPk, bidAccount: bidPk, bidData: bid, mint: bid.mint,
        currencyPlaceholderAccount: sellerAta,
      });

      const { blockhash, lastValidBlockHeight } = await chain.getLatestBlockhash();
      const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });
      const tx = new Transaction().add(cuIx);
      if (!buyerAtaAcct) {
        tx.add(createAssociatedTokenAccountInstruction(sellerPk, buyerAta, bid.bidder, bid.mint));
      }
      tx.add(ix);
      tx.feePayer = sellerPk;
      tx.recentBlockhash = blockhash;
      tx.serializeMessage(); // populates tx.signatures as a side effect — see solanart tool for the same note

      const ctx: SolseaValidationContext = {
        expectedSeller: sellerPk.toBase58(), expectedBid: bidPk.toBase58(), expectedMint: bid.mint.toBase58(),
      };

      const preflight = await chain.simulateTransaction(tx);
      if (preflight.err != null) {
        return res.status(502).json({ ok: false, error: 'preflight_simulation_failed', simErr: preflight.err, logs: preflight.logs });
      }

      const validated = validateAcceptBidStructure(tx, ctx, 'none');
      const expiresAt = now() + DIGEST_TTL_MS;
      digestCache.set(validated.messageHash, { ctx, blockhashInfo: { blockhash, lastValidBlockHeight }, expiresAt });

      return res.json({
        ok: true,
        tx: validated.tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
        digest: validated.messageHash,
        expiresAt,
        preflight: { ok: true, logs: preflight.logs },
        summary: {
          seller: sellerPk.toBase58(), bidKey: bidPk.toBase58(), bidder: bid.bidder.toBase58(),
          mint: bid.mint.toBase58(), priceSol: Number(bid.priceRaw) / 1e9,
          createsBuyerAta: !buyerAtaAcct,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/solsea-accept-bid] build error', msg);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  router.post('/tools/solsea-accept-bid/simulate', simLimit, authMw, async (req: Request, res: Response) => {
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
      console.error('[tools/solsea-accept-bid] simulate error', msg);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  router.post('/tools/solsea-accept-bid/submit', submitLimit, authMw, async (req: Request, res: Response) => {
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

    // No byte-exact message comparison against the digest here — wallets
    // (Phantom in particular) commonly inject their own priority-fee
    // ComputeBudget instruction at sign time, which legitimately changes
    // the message. The digest still does real work as an unguessable
    // (SHA-256, cache-keyed) single-use lookup token tying this submit to
    // a specific prior /build call's `entry.ctx`; `validateAcceptBidStructure`
    // below is what actually proves the SIGNED transaction is safe (correct
    // signer, correct program, correct bid/mint, no unexpected leading
    // instructions) — that's the real security boundary, not byte equality.
    if (tx.recentBlockhash !== entry.blockhashInfo.blockhash) return res.status(409).json({ ok: false, error: 'blockhash_mismatch' });

    let currentBlockHeight: number;
    try { currentBlockHeight = await chain.getBlockHeight(); } catch (err) {
      console.error('[tools/solsea-accept-bid] submit getBlockHeight error', err);
      return res.status(502).json({ ok: false, error: 'block_height_unavailable' });
    }
    const freshness = checkBlockhashFreshness(tx, entry.blockhashInfo, currentBlockHeight, marginBlocks);
    if (!freshness.ok) return res.status(410).json({ ok: false, error: freshness.code, detail: freshness.detail });

    const consumed = digestCache.consume(digest);
    if (!consumed) return res.status(410).json({ ok: false, error: 'digest_not_found_expired_or_already_used' });

    try {
      validateAcceptBidStructure(tx, entry.ctx, 'seller');
    } catch (err) {
      return res.status(409).json({ ok: false, error: `revalidation_failed: ${err instanceof Error ? err.message : String(err)}` });
    }
    if (!tx.verifySignatures(true)) return res.status(400).json({ ok: false, error: 'invalid_signature' });

    try {
      const signature = await chain.sendRawTransaction(tx);
      return res.json({ ok: true, signature });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/solsea-accept-bid] submit sendRawTransaction error', msg);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  return router;
}
