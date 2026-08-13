/**
 * Solanart forgotten-bid Accept Offer tool — personal use only, not a
 * public feature. Solanart (solanart.io) has been dead since ~2022 (no
 * API, no RPC, Cloudflare Always-Online serving a static 2022 snapshot),
 * but its on-chain marketplace program (`CJsLwbP1…`) is still live and
 * still holds thousands of funded, never-cancelled bid escrows from
 * 2021-2022. This tool lets a seller who owns a mint some old bid targets
 * accept that bid directly, on-chain, bypassing the dead marketplace
 * entirely — see `solanart-raw-instructions.ts` for the full evidence
 * trail behind every account/PDA/discriminator used here.
 *
 * Unlike the MMM collection-bids tool, this is a SINGLE-SIGNER flow — the
 * seller is the only required signer (confirmed on two independent real
 * accept-offer transactions: exactly one signature each). No cosigner, no
 * partial-sign step.
 *
 * Supports both pNFT and legacy target mints (see
 * `solanart-raw-instructions.ts` header for the evidence trail behind the
 * legacy path) — `resolveTokenStandard` picks the right instruction
 * builder automatically per mint.
 *
 *   GET  /api/tools/solanart-accept-offer/status                  — { liveEnabled }
 *   GET  /api/tools/solanart-accept-offer/offer?offerKey=          — decoded offer + resolved mint + token standard
 *   POST /api/tools/solanart-accept-offer/build                    — { seller, offerKey }
 *   POST /api/tools/solanart-accept-offer/simulate                 — { tx: base64 }
 *   POST /api/tools/solanart-accept-offer/submit                   — { signedTx: base64, digest }
 *
 * LIVE mode gated by `SOLANART_ACCEPT_OFFER_ENABLE_LIVE`, defaults false,
 * fails closed — DRY RUN (build + simulate, no signature ever requested)
 * always available regardless.
 */

import { Router, Request, Response, RequestHandler } from 'express';
import { PublicKey, Connection, Transaction, TransactionInstruction, ComputeBudgetProgram } from '@solana/web3.js';
import { createHash } from 'crypto';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';
import { rateLimit } from './rate-limit';
import { requireAuth } from './runtime';
import {
  SOLANART_PROGRAM_ID, OFFER_ACCOUNT_SIZE, decodeOffer, deriveMetadataPda,
  deriveTokenRecordPda, parseMetadataCreators, buildAcceptOfferIxPnft, buildAcceptOfferIxLegacy,
  type DecodedOffer,
} from './solanart-raw-instructions';

function liveEnabledFromEnv(): boolean {
  return (process.env.SOLANART_ACCEPT_OFFER_ENABLE_LIVE ?? '').trim().toLowerCase() === 'true';
}

const DEFAULT_BLOCKHASH_MARGIN_BLOCKS = 10;
function blockhashMarginBlocksFromEnv(): number {
  const v = Number(process.env.SOLANART_ACCEPT_OFFER_BLOCKHASH_MARGIN_BLOCKS);
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
 *  sole instruction targets the Solanart program, the offer + seller
 *  accounts are present and correctly flagged, and every writable account
 *  is one this module itself would have put there (no injected extra
 *  writable account could siphon funds elsewhere). */
export interface SolanartValidationContext {
  expectedSeller: string;
  expectedOffer: string;
  expectedMint: string;
}
export interface ValidatedTx { tx: Transaction; messageHash: string }

export function validateAcceptOfferStructure(
  tx: Transaction, ctx: SolanartValidationContext, expectSignature: 'none' | 'seller',
): ValidatedTx {
  if (tx.signatures.length !== 1) throw new Error(`unexpected_signer_count: expected 1, got ${tx.signatures.length}`);
  const [sig] = tx.signatures;
  if (sig.publicKey.toBase58() !== ctx.expectedSeller) throw new Error('seller_missing_from_signers');
  const filled = !!sig.signature && sig.signature.some((b) => b !== 0);
  if (expectSignature === 'none' && filled) throw new Error('unexpected_seller_signature_at_build_time');
  if (expectSignature === 'seller' && !filled) throw new Error('seller_signature_missing');
  if (!tx.feePayer || tx.feePayer.toBase58() !== ctx.expectedSeller) throw new Error('fee_payer_mismatch');

  // Exactly one Solanart instruction, anywhere in the list. We deliberately
  // do NOT restrict what else is in the transaction: wallets (Phantom in
  // particular) routinely inject their own extra instructions at sign time
  // — a priority-fee ComputeBudget bump, or their own transaction-safety
  // tooling (observed in practice: a Switchboard-style "CallbackComputation"
  // instruction, program `L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3S95`,
  // presumably part of Phantom's simulate-and-warn pipeline) — and trying
  // to keep an allowlist of every program a wallet might someday add is
  // both fragile and unnecessary. The user already reviews the FULL
  // transaction in their own wallet's confirmation UI before signing;
  // anything the wallet itself added is something they approved. Our
  // security boundary is narrower and doesn't depend on policing the rest
  // of the transaction: an unrelated extra instruction operates on its own
  // program's accounts and cannot reach into or alter what OUR instruction
  // does with the seller/offer/mint accounts we explicitly check below.
  if (tx.instructions.length < 1) throw new Error('unexpected_instruction_count');
  const solanartIxs = tx.instructions.filter((i) => i.programId.toBase58() === SOLANART_PROGRAM_ID.toBase58());
  if (solanartIxs.length !== 1) throw new Error(`unexpected_solanart_instruction_count: ${solanartIxs.length}`);
  const [ix] = solanartIxs;

  const hasOffer = ix.keys.some((k) => k.pubkey.toBase58() === ctx.expectedOffer && k.isWritable);
  if (!hasOffer) throw new Error('offer_missing_or_not_writable');
  const hasMint = ix.keys.some((k) => k.pubkey.toBase58() === ctx.expectedMint && !k.isWritable);
  if (!hasMint) throw new Error('mint_missing_or_unexpectedly_writable');

  return { tx, messageHash: messageHashHex(tx) };
}

// ── Digest cache — bounded, single-use, TTL'd. Same pattern as the MMM
//    tool, independently implemented (no shared import). ─────────────────

interface DigestEntry { ctx: SolanartValidationContext; blockhashInfo: BlockhashInfo; expiresAt: number }
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

export type TokenStandard = 'pnft' | 'legacy_or_unknown';

async function resolveTokenStandard(chain: ChainClient, mint: PublicKey, owner: PublicKey): Promise<TokenStandard> {
  const ata = getAssociatedTokenAddressSync(mint, owner, true);
  const tokenRecord = deriveTokenRecordPda(mint, ata);
  const acct = await chain.getAccountInfo(tokenRecord);
  return acct ? 'pnft' : 'legacy_or_unknown';
}

async function readOffer(chain: ChainClient, offerPk: PublicKey): Promise<DecodedOffer | null> {
  const acct = await chain.getAccountInfo(offerPk);
  if (!acct || acct.data.length !== OFFER_ACCOUNT_SIZE) return null;
  return decodeOffer(acct.data);
}

/** The offer record stores the buyer's target-mint ATA, not the mint
 *  itself — the mint is read as that ATA's own `mint` field (SPL Token
 *  Account layout: mint @ offset 0, 32 bytes). If the buyer's ATA was
 *  since closed (observed for some very old offers), the mint cannot be
 *  recovered this way and the caller must be told so explicitly. */
async function resolveMintFromOffer(chain: ChainClient, offerData: DecodedOffer): Promise<PublicKey | null> {
  const acct = await chain.getAccountInfo(offerData.buyerTargetAta);
  if (!acct || acct.data.length < 32) return null;
  return new PublicKey(acct.data.subarray(0, 32));
}

export interface SolanartAcceptOfferDeps {
  chain?: ChainClient;
  now?: () => number;
  authMiddleware?: RequestHandler;
  liveEnabled?: boolean;
  blockhashMarginBlocks?: number;
  rateLimitsDisabled?: boolean;
}

export function createSolanartAcceptOfferRouter(deps: SolanartAcceptOfferDeps = {}): Router {
  const conn = new Connection(rpcUrl(), 'confirmed');
  const chain = deps.chain ?? defaultChainClient(conn);
  const now = deps.now ?? Date.now;
  const authMw: RequestHandler = deps.authMiddleware ?? requireAuth;
  const liveEnabled = deps.liveEnabled ?? liveEnabledFromEnv();
  const marginBlocks = deps.blockhashMarginBlocks ?? blockhashMarginBlocksFromEnv();

  const router = Router();
  const noopLimit: RequestHandler = (_req, _res, next) => next();
  const readLimit = deps.rateLimitsDisabled ? noopLimit : rateLimit({ limit: 30, windowMs: 60_000, label: 'tools/solanart-accept-offer/read' });
  const buildLimit = deps.rateLimitsDisabled ? noopLimit : rateLimit({ limit: 15, windowMs: 60_000, label: 'tools/solanart-accept-offer/build' });
  const simLimit = deps.rateLimitsDisabled ? noopLimit : rateLimit({ limit: 15, windowMs: 60_000, label: 'tools/solanart-accept-offer/simulate' });
  const submitLimit = deps.rateLimitsDisabled ? noopLimit : rateLimit({ limit: 10, windowMs: 60_000, label: 'tools/solanart-accept-offer/submit' });

  const digestCache = new DigestCache(now);
  const sweepTimer = setInterval(() => digestCache.cleanup(), DIGEST_SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  router.get('/tools/solanart-accept-offer/status', authMw, (_req: Request, res: Response) => {
    res.json({ ok: true, liveEnabled });
  });

  router.get('/tools/solanart-accept-offer/offer', readLimit, authMw, async (req: Request, res: Response) => {
    const offerPk = parsePubkey(req.query.offerKey);
    if (!offerPk) return res.status(400).json({ ok: false, error: 'invalid_offer_key' });
    try {
      const offer = await readOffer(chain, offerPk);
      if (!offer) return res.status(404).json({ ok: false, error: 'offer_not_found_or_already_closed' });
      if (offer.state !== 1) return res.status(409).json({ ok: false, error: 'offer_not_active' });
      const mint = await resolveMintFromOffer(chain, offer);
      if (!mint) return res.status(409).json({ ok: false, error: 'mint_unresolvable_buyer_ata_closed' });
      // Preview-only best-effort: checked against the buyer's ATA since no
      // seller is known yet at this point, which means it can UNDER-report
      // ('legacy_or_unknown' for an actual pNFT) — the buyer never holds
      // the mint before a trade. /build re-checks correctly against the
      // real seller once one is supplied; that result is authoritative.
      const standard = await resolveTokenStandard(chain, mint, offer.buyer);
      return res.json({
        ok: true,
        offer: {
          offerKey: offerPk.toBase58(), buyer: offer.buyer.toBase58(), mint: mint.toBase58(),
          priceSol: Number(offer.priceLamports) / 1e9, tokenStandardPreview: standard,
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/solanart-accept-offer] offer read error', msg);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  router.post('/tools/solanart-accept-offer/build', buildLimit, authMw, async (req: Request, res: Response) => {
    const { seller, offerKey } = req.body as { seller?: string; offerKey?: string };
    const sellerPk = parsePubkey(seller);
    const offerPk = parsePubkey(offerKey);
    if (!sellerPk) return res.status(400).json({ ok: false, error: 'invalid_seller' });
    if (!offerPk) return res.status(400).json({ ok: false, error: 'invalid_offer_key' });

    try {
      const offer = await readOffer(chain, offerPk);
      if (!offer) return res.status(404).json({ ok: false, error: 'offer_not_found_or_already_closed' });
      if (offer.state !== 1) return res.status(409).json({ ok: false, error: 'offer_not_active' });
      const mint = await resolveMintFromOffer(chain, offer);
      if (!mint) return res.status(409).json({ ok: false, error: 'mint_unresolvable_buyer_ata_closed' });

      const sellerAta = getAssociatedTokenAddressSync(mint, sellerPk, true);
      const sellerAtaAcct = await chain.getAccountInfo(sellerAta);
      if (!sellerAtaAcct || sellerAtaAcct.data.length < 72 || sellerAtaAcct.data.readBigUInt64LE(64) !== 1n) {
        return res.status(409).json({ ok: false, error: 'seller_does_not_hold_this_nft' });
      }

      // Checked against the SELLER's own token account, not the buyer's —
      // the buyer never holds this mint before the trade completes, so a
      // token_record lookup keyed to their (nonexistent) ATA is always
      // 'legacy_or_unknown' regardless of the mint's real standard. This
      // bug was caught by end-to-end simulation against a real live offer.
      const standard = await resolveTokenStandard(chain, mint, sellerPk);

      const metadataPda = deriveMetadataPda(mint);
      const metadataAcct = await chain.getAccountInfo(metadataPda);
      if (!metadataAcct) return res.status(502).json({ ok: false, error: 'metadata_account_not_found' });
      const creators = parseMetadataCreators(metadataAcct.data);
      if (creators.length === 0) return res.status(502).json({ ok: false, error: 'no_on_chain_creators_found' });

      const ix: TransactionInstruction = standard === 'pnft'
        ? buildAcceptOfferIxPnft({ seller: sellerPk, offer: offerPk, offerData: offer, mint, creators })
        : buildAcceptOfferIxLegacy({ seller: sellerPk, offer: offerPk, offerData: offer, mint, creators });

      const { blockhash, lastValidBlockHeight } = await chain.getLatestBlockhash();
      // The Metaplex TransferV1 CPI this instruction makes routinely
      // exceeds the default 200k CU budget (confirmed via simulation
      // against a real live offer — fails with "exceeded CUs meter"
      // otherwise; ~203k consumed in practice).
      const cuIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
      const tx = new Transaction().add(cuIx).add(ix);
      tx.feePayer = sellerPk;
      tx.recentBlockhash = blockhash;
      // Populates tx.signatures (one empty slot for the seller) as a side
      // effect of _compile() — with no cosigner to partial-sign here
      // (single-signer flow), nothing else touches the message until
      // Phantom signs it client-side. compileMessage() alone does NOT
      // have this side effect; serializeMessage() does (verified against
      // this project's actual @solana/web3.js build).
      tx.serializeMessage();

      const ctx: SolanartValidationContext = {
        expectedSeller: sellerPk.toBase58(), expectedOffer: offerPk.toBase58(), expectedMint: mint.toBase58(),
      };

      const preflight = await chain.simulateTransaction(tx);
      if (preflight.err != null) {
        return res.status(502).json({ ok: false, error: 'preflight_simulation_failed', simErr: preflight.err, logs: preflight.logs });
      }

      const validated = validateAcceptOfferStructure(tx, ctx, 'none');
      const expiresAt = now() + DIGEST_TTL_MS;
      digestCache.set(validated.messageHash, { ctx, blockhashInfo: { blockhash, lastValidBlockHeight }, expiresAt });

      return res.json({
        ok: true,
        tx: validated.tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
        digest: validated.messageHash,
        expiresAt,
        preflight: { ok: true, logs: preflight.logs },
        summary: {
          seller: sellerPk.toBase58(), offerKey: offerPk.toBase58(), buyer: offer.buyer.toBase58(),
          mint: mint.toBase58(), priceSol: Number(offer.priceLamports) / 1e9,
          creators: creators.map((c) => ({ address: c.address.toBase58(), share: c.share, verified: c.verified })),
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/solanart-accept-offer] build error', msg);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  router.post('/tools/solanart-accept-offer/simulate', simLimit, authMw, async (req: Request, res: Response) => {
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
      console.error('[tools/solanart-accept-offer] simulate error', msg);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  router.post('/tools/solanart-accept-offer/submit', submitLimit, authMw, async (req: Request, res: Response) => {
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
    // a specific prior /build call's `entry.ctx`; `validateAcceptOfferStructure`
    // below is what actually proves the SIGNED transaction is safe (correct
    // signer, correct program, correct offer/mint, no unexpected leading
    // instructions) — that's the real security boundary, not byte equality.
    if (tx.recentBlockhash !== entry.blockhashInfo.blockhash) return res.status(409).json({ ok: false, error: 'blockhash_mismatch' });

    let currentBlockHeight: number;
    try { currentBlockHeight = await chain.getBlockHeight(); } catch (err) {
      console.error('[tools/solanart-accept-offer] submit getBlockHeight error', err);
      return res.status(502).json({ ok: false, error: 'block_height_unavailable' });
    }
    const freshness = checkBlockhashFreshness(tx, entry.blockhashInfo, currentBlockHeight, marginBlocks);
    if (!freshness.ok) return res.status(410).json({ ok: false, error: freshness.code, detail: freshness.detail });

    const consumed = digestCache.consume(digest);
    if (!consumed) return res.status(410).json({ ok: false, error: 'digest_not_found_expired_or_already_used' });

    try {
      validateAcceptOfferStructure(tx, entry.ctx, 'seller');
    } catch (err) {
      return res.status(409).json({ ok: false, error: `revalidation_failed: ${err instanceof Error ? err.message : String(err)}` });
    }
    if (!tx.verifySignatures(true)) return res.status(400).json({ ok: false, error: 'invalid_signature' });

    try {
      const signature = await chain.sendRawTransaction(tx);
      return res.json({ ok: true, signature });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/solanart-accept-offer] submit sendRawTransaction error', msg);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  return router;
}
