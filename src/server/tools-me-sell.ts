/**
 * Magic Eden item-level offer ACCEPT tool — personal use only, not a public
 * feature. Counterpart to tools-me-bids.ts (which only ever places/cancels/
 * withdraws OUR OWN bids). This router does the opposite side: given an
 * existing personal offer someone else placed on an NFT we hold (or are
 * about to buy), builds+submits the SELL/ExecuteSaleV2 transaction that
 * accepts it. Discovery/scanning for such offers is a SEPARATE tool's job —
 * this router only ever consumes an already-identified (mint, buyer,
 * auctionHouse, price) tuple, exactly the shape ME's own
 * offers_received/offers_made API returns.
 *
 * ── WHY THIS IS A SEPARATE FILE FROM tools-me-bids.ts ───────────────────────
 *
 * Every op in tools-me-bids.ts (buy/buy_change_price/buy_cancel/withdraw) is
 * confirmed to have exactly ONE required signer (the buyer), no ME cosigner
 * — see that file's header. SELL is structurally different: a real on-chain
 * ExecuteSaleV2 always carries TWO signatures (the seller AND a Magic Eden
 * hot-wallet cosigner — confirmed 2026-08-24 by decoding two real settled
 * accept-offer txs; the cosigner pubkey holds tens of thousands of SOL and
 * appears identically across unrelated trades, i.e. a fixed ME authority,
 * not a per-user PDA). tools-me-bids.ts's validateStructure/submit hard-code
 * the 1-signer contract throughout (digest cache ctx kind, signature-count
 * checks) — bolting a 2-signer case onto that would weaken checks that
 * currently hold real money-moving logic. A parallel, independently
 * reasoned validator for the 2-signer shape is safer than a shared branch.
 *
 * ── THE KEY OPEN QUESTION THIS FILE SURFACES, NOT ASSUMES ──────────────────
 *
 * Does `GET /instructions/sell` (called server-side with our own paid
 * ME_API_KEY, exactly like tools-me-bids.ts already does for buy/cancel/
 * withdraw) come back with ME's cosigner slot ALREADY signed? Confirmed only
 * that the endpoint is real and reachable this way (a live call against a
 * genuinely dead/underfunded offer returned a structured
 * `{"err":"failed to generate sell instruction"}` — past auth/rate-limit,
 * real business logic). Whether the cosign comes pre-filled has NOT been
 * confirmed against a real fundable offer yet. buildAccept() below decodes
 * whatever comes back and reports the signature state explicitly rather
 * than assuming either way — `needsBridge: true` in the response means the
 * cosigner slot came back empty and this backend-only path cannot complete
 * the trade (would need a browser-session bridge akin to the MMM
 * Tampermonkey bridge, not yet built here).
 *
 * ── SAFETY MODEL (mirrors tools-me-bids.ts) ─────────────────────────────────
 *
 *   GET  /api/tools/me-sell/resolve-offer?mint=&buyer=
 *        — resolves (price, auctionHouse) for a (mint, buyer) pair via ME's
 *          public offers_made index, so the frontend only needs 2 fields.
 *   GET  /api/tools/me-sell/order-info?mint=&buyer=&auctionHouseAddress=&priceSol=
 *        — pure reads (on-chain escrow balance + DAS royalty bp), no ME
 *          instruction call, no wallet, no signing.
 *   GET  /api/tools/me-sell/build-topup?escrowPda=&fromWallet=&lamports=
 *        — unsigned SystemProgram.transfer, single signer (the caller's own
 *          wallet), no cosign involved. Not security-sensitive beyond
 *          "wallet signs its own transfer" — Phantom is the trust boundary.
 *   POST /api/tools/me-sell/build-accept — { seller, tokenMint, priceSol,
 *          auctionHouseAddress, buyer, sellerReferral? }
 *   POST /api/tools/me-sell/simulate     — { tx: base64 }
 *   POST /api/tools/me-sell/submit       — { signedTx: base64, digest }
 *   POST /api/tools/me-sell/submit-bridge — { signedTx, seller, tokenMint,
 *        auctionHouseAddress, buyer } — for a tx obtained via the
 *        Tampermonkey bridge (real browser session) instead of build-accept;
 *        no prior digest exists, so this validates structurally + verifies
 *        signatures fresh instead of comparing against a build-time snapshot.
 *
 * Same digest-binding / blockhash-freshness / cryptographic-signature-
 * verification chain as tools-me-bids.ts (imports the shared, already-
 * reviewed primitives directly rather than re-deriving them). Gated by the
 * SAME ME_BIDS_ENABLE_LIVE env var — one "operator live trading" switch for
 * both directions, not two independent ones to keep in sync.
 *
 * Every route requires auth (site-wide SIWS + UI_ALLOWED_WALLETS gate). This
 * process never handles a private key: build-accept only ever returns an
 * UNSIGNED (seller slot) tx for the operator's own wallet to sign client-
 * side via Phantom; /submit only ever accepts already-signed bytes.
 */

import { Router, Request, Response, RequestHandler } from 'express';
import {
  PublicKey, Connection, Transaction, SystemProgram,
} from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { rateLimit } from './rate-limit';
import { requireAuth } from './runtime';
import { meAuthHeaders, hasMeApiKey, meCooldownActive, setMeCooldown } from '../me-api-cooldown';
import { deriveBuyerEscrowPda, lamportsToSol } from './me-bid-escrow';

// order-info is called interactively for ONE offer at a time (never a bulk
// scan), right after the user may have just topped up the escrow — the
// shared resolveEscrowBalances() in me-bid-escrow.ts carries a 60s
// in-memory cache built for bulk scanning, which would keep reporting the
// pre-topup balance for up to a minute here. Always read this one account
// fresh instead.
async function fetchEscrowBalanceFresh(escrowPda: string): Promise<number> {
  try {
    const r = await fetch(rpcUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getBalance', params: [escrowPda, { commitment: 'confirmed' }] }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) return 0;
    const j = await r.json() as { result?: { value?: number } };
    return j.result?.value ?? 0;
  } catch { return 0; }
}
import {
  MeApiError, type MeHttpTransport, type MeApiKeyProvider,
  decodeLegacyTxFromBytes, decodeLegacyTxFromBase64, messageHashHex,
  checkBlockhashFreshness, type BlockhashInfo, type ChainClient,
} from './tools-me-bids';

const ME_API_BASE = 'https://api-mainnet.magiceden.dev/v2';
const FETCH_TIMEOUT_MS = 10_000;
const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
const M2_PROGRAM_ID = 'M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K';
const ALLOWED_PROGRAM_IDS = new Set([COMPUTE_BUDGET_PROGRAM_ID, M2_PROGRAM_ID]);
const ME_FEE_BP = 200; // confirmed 2026-08-11 (see project_me_ah_accept_offer_seller_covers_fee memory)

function liveEnabledFromEnv(): boolean {
  return (process.env.ME_BIDS_ENABLE_LIVE ?? '').trim().toLowerCase() === 'true';
}
const DEFAULT_BLOCKHASH_MARGIN_BLOCKS = 10;
function blockhashMarginBlocksFromEnv(): number {
  const v = Number(process.env.ME_BIDS_BLOCKHASH_MARGIN_BLOCKS);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_BLOCKHASH_MARGIN_BLOCKS;
}

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  return key
    ? `https://beta.helius-rpc.com/?api-key=${key}`
    : 'https://api.mainnet-beta.solana.com';
}

// ── ME instructions/sell client (mirrors tools-me-bids.ts's createMeGet,
//    duplicated locally — each tools-*.ts file in this codebase owns its
//    own small transport/rpcUrl helpers rather than sharing a mega-module;
//    see tools-mmm-pools.ts for the same pattern) ──────────────────────────

function parseMeErrorBody(body: unknown): string {
  if (body && typeof body === 'object') {
    const b = body as { err?: unknown; message?: unknown };
    if (typeof b.err === 'string') return b.err;
    if (Array.isArray(b.err)) {
      return b.err.map((e) => (e && typeof e === 'object' && 'msg' in e ? String((e as { msg: unknown }).msg) : JSON.stringify(e))).join('; ');
    }
    if (typeof b.message === 'string') return b.message;
  }
  return 'unknown_me_error';
}

function defaultMeHttpTransport(authHeaders: () => Record<string, string>): MeHttpTransport {
  return async (path: string) => {
    const res = await fetch(`${ME_API_BASE}${path}`, {
      headers: { ...authHeaders() },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const text = await res.text();
    return { status: res.status, text };
  };
}
function defaultMeApiKeyProvider(): MeApiKeyProvider {
  return { hasKey: hasMeApiKey, authHeaders: meAuthHeaders, cooldownActive: meCooldownActive, setCooldown: setMeCooldown };
}
function createMeGet(transport: MeHttpTransport, keys: MeApiKeyProvider) {
  return async function meGet<T>(path: string): Promise<T> {
    if (!keys.hasKey()) throw new MeApiError(503, 'me_api_key_not_configured');
    if (keys.cooldownActive()) throw new MeApiError(429, 'me_api_cooldown_active');
    let res: { status: number; text: string };
    try { res = await transport(path); }
    catch (err) { throw new MeApiError(504, `me_api_unreachable: ${err instanceof Error ? err.message : String(err)}`); }
    if (res.status === 429) { keys.setCooldown(); throw new MeApiError(429, 'me_api_rate_limited'); }
    let json: unknown;
    try { json = JSON.parse(res.text); } catch { json = null; }
    if (res.status < 200 || res.status >= 300) throw new MeApiError(res.status, parseMeErrorBody(json));
    if (json === null) throw new MeApiError(502, 'me_response_not_json');
    return json as T;
  };
}

function defaultChainClient(conn: Connection): ChainClient {
  return {
    async simulateTransaction(tx: Transaction, includeAccounts?: PublicKey[]) {
      const sim = await conn.simulateTransaction(tx, undefined, includeAccounts);
      return {
        err: sim.value.err, logs: sim.value.logs ?? [],
        accounts: sim.value.accounts ?? null, unitsConsumed: sim.value.unitsConsumed ?? null,
      };
    },
    getBlockHeight: () => conn.getBlockHeight(),
    sendRawTransaction: (tx: Transaction) => conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 }),
  };
}

// ── Royalty lookup — Helius DAS getAsset, royalty.basis_points ─────────────
//
// `royalty.basis_points` is the CREATOR-DECLARED metadata value — it exists
// regardless of token standard. It is only actually enforced on-chain for
// pNFTs (Token Metadata's ruleset engine, `interface: "ProgrammableNFT"`).
// Legacy NFTs (`interface: "V1_NFT"`, the vast majority of older
// collections) have zero on-chain mechanism to require royalty payment —
// declaring 500bp in metadata does not make ExecuteSaleV2 charge it.
// Confirmed empirically: a legacy V1_NFT sale (Golem #4904, sig
// KP3Scy1C…CtRc) landed with `"royalty":0` in the program log despite DAS
// reporting royalty.basis_points=500 for that exact mint. Before this fix,
// order-info trusted the declared bp unconditionally, telling sellers to
// top up royalty that was never going to be charged — real SOL sent to the
// buyer's escrow, never consumed by the sale, unrecoverable by the seller.
async function fetchRoyaltyBp(mint: string): Promise<number | null> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return null;
  try {
    const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: mint } }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) return null;
    const j = await r.json() as {
      result?: {
        interface?: string;
        royalty?: { basis_points?: number };
        content?: { metadata?: { name?: string }; links?: { image?: string } };
      };
    };
    if (j.result?.interface !== 'ProgrammableNFT') return 0;
    return typeof j.result?.royalty?.basis_points === 'number' ? j.result.royalty.basis_points : null;
  } catch { return null; }
}

async function fetchNftDisplay(mint: string): Promise<{ name: string | null; image: string | null }> {
  const apiKey = process.env.HELIUS_API_KEY;
  if (!apiKey) return { name: null, image: null };
  try {
    const r = await fetch(`https://mainnet.helius-rpc.com/?api-key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getAsset', params: { id: mint } }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!r.ok) return { name: null, image: null };
    const j = await r.json() as { result?: { content?: { metadata?: { name?: string }; links?: { image?: string } } } };
    return {
      name: j.result?.content?.metadata?.name ?? null,
      image: j.result?.content?.links?.image ?? null,
    };
  } catch { return { name: null, image: null }; }
}

// ── Input validation ────────────────────────────────────────────────────

function parsePubkey(v: unknown): PublicKey | null {
  if (typeof v !== 'string' || !v) return null;
  try { return new PublicKey(v); } catch { return null; }
}
function parsePriceSol(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}
function parseLamports(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) return null;
  return n;
}

// ── Offer resolution — given (mint, buyer), find the matching offer's
//    price/auctionHouse via ME's own offers_made index (public endpoint,
//    same shape confirmed live 2026-08-24). Lets the frontend ask for just
//    two fields instead of four — the caller still has to know WHICH buyer
//    made the offer (that's the discovery tool's job, out of scope here),
//    but doesn't have to also carry price/auctionHouse by hand. ──────────

interface MeOfferMade {
  pdaAddress?: string; tokenMint?: string; auctionHouse?: string;
  buyer?: string; price?: number; tokenSize?: number; expiry?: number;
}

async function resolveOfferForMint(
  meGet: <T>(path: string) => Promise<T>, mint: string, buyer: string,
): Promise<MeOfferMade | null> {
  const offers = await meGet<MeOfferMade[]>(`/wallets/${encodeURIComponent(buyer)}/offers_made?limit=500`);
  if (!Array.isArray(offers)) return null;
  return offers.find((o) => o.tokenMint === mint) ?? null;
}

// ── 2-signer sell-tx structural validation ──────────────────────────────

export interface ValidatedSellTx {
  tx: Transaction;
  messageHash: string;
  cosignerPubkey: string;
  cosignPrefilled: boolean;
}

/** Unlike tools-me-bids.ts's 1-signer validator, this expects exactly 2
 *  signature slots: the seller (unsigned at build time, filled at submit
 *  time) and a second slot (ME's cosigner) which — at BOTH build and submit
 *  time — must already carry a real signature; we never expect to fill it
 *  ourselves (we don't hold that key). `expectSellerSignature` distinguishes
 *  build (seller slot must be empty) from submit (seller slot must be
 *  filled) — the cosigner slot's fullness requirement never changes. */
export interface SellValidationContext {
  kind: 'sell';
  expectedSeller: string;
  expectedMint: string;
  expectedAuctionHouse: string;
  expectedBuyer: string;
}

export function validateSellStructure(
  tx: Transaction, ctx: SellValidationContext, expectSellerSignature: 'absent' | 'present',
): ValidatedSellTx {
  if (tx.signatures.length !== 2) {
    throw new Error(`unexpected_signer_count: expected 2, got ${tx.signatures.length}`);
  }
  const sellerEntry = tx.signatures.find((s) => s.publicKey.toBase58() === ctx.expectedSeller);
  if (!sellerEntry) throw new Error('seller_not_in_signer_set');
  const otherEntry = tx.signatures.find((s) => s.publicKey.toBase58() !== ctx.expectedSeller);
  if (!otherEntry) throw new Error('cosigner_slot_missing');

  const sellerSigned = sellerEntry.signature != null;
  if (expectSellerSignature === 'absent' && sellerSigned) {
    throw new Error('unexpected_pre_filled_seller_signature');
  }
  if (expectSellerSignature === 'present' && !sellerSigned) {
    throw new Error('missing_seller_signature');
  }

  if (!tx.feePayer || tx.feePayer.toBase58() !== ctx.expectedSeller) {
    throw new Error('fee_payer_mismatch');
  }

  for (const ix of tx.instructions) {
    const pid = ix.programId.toBase58();
    if (!ALLOWED_PROGRAM_IDS.has(pid)) throw new Error(`unexpected_program_id: ${pid}`);
  }
  // A real accept-offer bundle is always TWO M2 instructions — the listing
  // half (Sell/Mip1Sell/MplCoreSell) and the execute half (ExecuteSaleV2/
  // Mip1ExecuteSaleV2/MplCoreExecuteSaleV2) — confirmed 2026-08-24 from a
  // real captured ME frontend request/response (HAR): calling the single
  // /instructions/sell_now endpoint directly only ever returns the listing
  // half (empirically verified — a real submitted tx landed on-chain but
  // only delegated the NFT, no SOL moved); /instructions/batch with a
  // single sell_now entry in its `q` array returns the full 2-instruction
  // bundle instead. Every instruction here must reference mint+auctionHouse;
  // the buyer must appear in at least one (the execute half) — otherwise
  // we can't be sure we're accepting the RIGHT buyer's offer.
  const m2Instructions = tx.instructions.filter((ix) => ix.programId.toBase58() === M2_PROGRAM_ID);
  if (m2Instructions.length !== 2) throw new Error(`unexpected_m2_instruction_count: expected 2, got ${m2Instructions.length}`);
  for (const ix of m2Instructions) {
    if (!ix.keys.some((k) => k.pubkey.toBase58() === ctx.expectedMint)) {
      throw new Error('mint_missing_from_instruction');
    }
    if (!ix.keys.some((k) => k.pubkey.toBase58() === ctx.expectedAuctionHouse)) {
      throw new Error('auction_house_missing_from_instruction');
    }
  }
  if (!m2Instructions.some((ix) => ix.keys.some((k) => k.pubkey.toBase58() === ctx.expectedBuyer))) {
    throw new Error('buyer_missing_from_instructions');
  }

  return {
    tx,
    messageHash: messageHashHex(tx),
    cosignerPubkey: otherEntry.publicKey.toBase58(),
    cosignPrefilled: otherEntry.signature != null,
  };
}

// ── Digest cache — same shape/TTL/eviction policy as tools-me-bids.ts,
//    intentionally duplicated (separate router instance, separate cache) ──

interface DigestEntry {
  ctx: SellValidationContext;
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
    const entry = this.map.get(digest);
    if (entry) this.map.delete(digest);
    return entry;
  }
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

// ── Router ───────────────────────────────────────────────────────────────

export interface MeSellDeps {
  meTransport?: MeHttpTransport;
  meApiKeyProvider?: MeApiKeyProvider;
  chain?: ChainClient;
  now?: () => number;
  authMiddleware?: RequestHandler;
  liveEnabled?: boolean;
  blockhashMarginBlocks?: number;
  rateLimitsDisabled?: boolean;
}
export interface MeSellTestHooks {
  digestCacheSize: () => number;
  sweepTimer: ReturnType<typeof setInterval>;
}

export function createMeSellRouter(deps: MeSellDeps = {}): Router & { __meSellTestHooks?: MeSellTestHooks } {
  const keys = deps.meApiKeyProvider ?? defaultMeApiKeyProvider();
  const transport = deps.meTransport ?? defaultMeHttpTransport(keys.authHeaders);
  const meGet = createMeGet(transport, keys);
  const chain = deps.chain ?? defaultChainClient(new Connection(rpcUrl(), 'confirmed'));
  const now = deps.now ?? Date.now;
  const authMw: RequestHandler = deps.authMiddleware ?? requireAuth;
  const liveEnabled = deps.liveEnabled ?? liveEnabledFromEnv();
  const marginBlocks = deps.blockhashMarginBlocks ?? blockhashMarginBlocksFromEnv();

  const router = Router() as Router & { __meSellTestHooks?: MeSellTestHooks };
  const noopLimit: RequestHandler = (_req, _res, next) => next();
  const readLimit   = deps.rateLimitsDisabled ? noopLimit : rateLimit({ limit: 30, windowMs: 60_000, label: 'tools/me-sell/read' });
  const buildLimit  = deps.rateLimitsDisabled ? noopLimit : rateLimit({ limit: 15, windowMs: 60_000, label: 'tools/me-sell/build' });
  const simLimit    = deps.rateLimitsDisabled ? noopLimit : rateLimit({ limit: 15, windowMs: 60_000, label: 'tools/me-sell/simulate' });
  const submitLimit = deps.rateLimitsDisabled ? noopLimit : rateLimit({ limit: 10, windowMs: 60_000, label: 'tools/me-sell/submit' });

  const digestCache = new DigestCache(now);
  const sweepTimer = setInterval(() => digestCache.cleanup(), DIGEST_SWEEP_INTERVAL_MS);
  sweepTimer.unref();
  router.__meSellTestHooks = { digestCacheSize: () => digestCache.size, sweepTimer };

  router.get('/tools/me-sell/status', authMw, (_req: Request, res: Response) => {
    res.json({ ok: true, liveEnabled, meApiConfigured: keys.hasKey() });
  });

  // ── Resolve (price, auctionHouse) for a (mint, buyer) pair via ME's own
  //    offers_made index — lets the frontend collect just 2 fields. ─────
  router.get('/tools/me-sell/resolve-offer', readLimit, authMw, async (req: Request, res: Response) => {
    const mint = parsePubkey(req.query.mint);
    const buyer = parsePubkey(req.query.buyer);
    if (!mint || !buyer) return res.status(400).json({ ok: false, error: 'invalid_or_missing_params: mint, buyer required' });
    try {
      const offer = await resolveOfferForMint(meGet, mint.toBase58(), buyer.toBase58());
      if (!offer || offer.price == null || !offer.auctionHouse) {
        return res.status(404).json({ ok: false, error: 'offer_not_found: this wallet has no active offer on this mint' });
      }
      return res.json({
        ok: true, mint: mint.toBase58(), buyer: buyer.toBase58(),
        auctionHouseAddress: offer.auctionHouse, priceSol: offer.price,
        pdaAddress: offer.pdaAddress ?? null, expiry: offer.expiry ?? 0,
      });
    } catch (err) {
      const status = err instanceof MeApiError ? err.status : 502;
      return res.status(status).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Read-only: escrow funding status + royalty math for a known offer ──
  router.get('/tools/me-sell/order-info', readLimit, authMw, async (req: Request, res: Response) => {
    const mint = parsePubkey(req.query.mint);
    const buyer = parsePubkey(req.query.buyer);
    const auctionHouse = parsePubkey(req.query.auctionHouseAddress);
    const priceSol = parsePriceSol(req.query.priceSol);
    if (!mint || !buyer || !auctionHouse || priceSol == null) {
      return res.status(400).json({ ok: false, error: 'invalid_or_missing_params: mint, buyer, auctionHouseAddress, priceSol required' });
    }
    const escrowPda = deriveBuyerEscrowPda(auctionHouse.toBase58(), buyer.toBase58());
    if (!escrowPda) return res.status(400).json({ ok: false, error: 'escrow_pda_derivation_failed' });

    const [escrowLamports, royaltyBp, display] = await Promise.all([
      fetchEscrowBalanceFresh(escrowPda),
      fetchRoyaltyBp(mint.toBase58()),
      fetchNftDisplay(mint.toBase58()),
    ]);
    const priceLamports = Math.round(priceSol * 1e9);
    const royaltyLamports = royaltyBp != null ? Math.floor(priceLamports * royaltyBp / 10000) : null;
    // Fail conservative when royalty is unknown: treat as 0% for the
    // "required" figure but flag it loudly rather than silently
    // under-reporting how much top-up is actually needed (see
    // project_me_ah_accept_offer_seller_covers_fee memory — royalty is
    // pulled ADDITIONALLY from the buyer's escrow, on top of price).
    const requiredLamports = priceLamports + (royaltyLamports ?? 0);
    const missingLamports = Math.max(0, requiredLamports - escrowLamports);
    const sellerProceedsLamports = Math.floor(priceLamports * (10000 - ME_FEE_BP) / 10000);

    return res.json({
      ok: true,
      mint: mint.toBase58(), buyer: buyer.toBase58(), auctionHouseAddress: auctionHouse.toBase58(),
      priceLamports, priceSol,
      escrowPda, escrowLamports, escrowSol: lamportsToSol(escrowLamports),
      royaltyBp, royaltyBpUnknown: royaltyBp == null, royaltyLamports,
      requiredLamports, requiredSol: requiredLamports / 1e9,
      missingLamports, missingSol: missingLamports / 1e9,
      executable: missingLamports === 0,
      sellerProceedsLamports, sellerProceedsSol: sellerProceedsLamports / 1e9,
      meFeeBp: ME_FEE_BP,
      nft: display,
    });
  });

  // ── Unsigned top-up transfer (plain SystemProgram.transfer, no cosign) ──
  router.get('/tools/me-sell/build-topup', buildLimit, authMw, async (req: Request, res: Response) => {
    const escrowPda = parsePubkey(req.query.escrowPda);
    const fromWallet = parsePubkey(req.query.fromWallet);
    const lamports = parseLamports(req.query.lamports);
    if (!escrowPda || !fromWallet || lamports == null || lamports <= 0) {
      return res.status(400).json({ ok: false, error: 'invalid_or_missing_params: escrowPda, fromWallet, lamports(int>0) required' });
    }
    try {
      const conn = new Connection(rpcUrl(), 'confirmed');
      const { blockhash } = await conn.getLatestBlockhash('confirmed');
      const tx = new Transaction({ feePayer: fromWallet, recentBlockhash: blockhash }).add(
        SystemProgram.transfer({ fromPubkey: fromWallet, toPubkey: escrowPda, lamports }),
      );
      const txBase64 = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
      return res.json({ ok: true, txBase64 });
    } catch (err) {
      return res.status(200).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Build the accept (Sell + ExecuteSaleV2) tx via ME's instruction API ──
  router.post('/tools/me-sell/build-accept', buildLimit, authMw, async (req: Request, res: Response) => {
    const { seller, tokenMint, priceSol: priceSolRaw, auctionHouseAddress, buyer, sellerReferral, buyerExpiry } = req.body as {
      seller?: string; tokenMint?: string; priceSol?: number; auctionHouseAddress?: string;
      buyer?: string; sellerReferral?: string; buyerExpiry?: number;
    };
    const sellerPk = parsePubkey(seller);
    const mintPk = parsePubkey(tokenMint);
    const ahPk = parsePubkey(auctionHouseAddress);
    const buyerPk = parsePubkey(buyer);
    const priceSol = parsePriceSol(priceSolRaw);
    if (!sellerPk || !mintPk || !ahPk || !buyerPk || priceSol == null) {
      return res.status(400).json({ ok: false, error: 'invalid_or_missing_params: seller, tokenMint, auctionHouseAddress, buyer, priceSol required' });
    }
    const tokenAta = getAssociatedTokenAddressSync(mintPk, sellerPk, false, TOKEN_PROGRAM_ID);

    // The single /instructions/sell_now endpoint ONLY builds the listing
    // half (Sell/Mip1Sell) — confirmed the hard way 2026-08-24 (a real
    // submitted tx landed clean on-chain but only delegated the NFT, no SOL
    // moved). ME's own frontend never calls that endpoint directly for this
    // flow: a captured real HAR (2026-08-24) shows it calls
    // /instructions/batch with a single-element `q` array instead, and THAT
    // wrapper returns a full 4-instruction bundle (2x ComputeBudget + the
    // listing half + the execute half, the latter referencing the buyer
    // directly) — the batch wrapper has logic the single endpoint doesn't.
    // Payload shape is `ins`, not top-level query params, and notably has
    // NO `price` field at all — only `newPrice`. `buyerExpiry` (in
    // MILLISECONDS, unlike every other expiry field in this codebase which
    // is seconds) is the root cause of the "bidding too old to be accepted"
    // rejection this router used to hit on EVERY offer whose own ME-recorded
    // expiry is 0 ("no expiry"): omitting the field (or passing literal 0)
    // made ME's backend treat the buyer's authorization as expired at Unix
    // epoch — confirmed empirically 2026-08-24 by replaying an identical
    // request against a real, previously-"too old"-rejected offer with only
    // buyerExpiry changed from omitted to a large future timestamp, which
    // then returned status:"fulfilled" with a fully cosigned tx. So: never
    // send 0/omit for an infinite-expiry offer — send a far-future sentinel
    // instead. `NO_EXPIRY_SENTINEL_MS` = 2100-01-01T00:00:00Z.
    const insPayload: Record<string, unknown> = {
      sellerExpiry: 0,
      auctionHouseAddress: ahPk.toBase58(),
      buyer: buyerPk.toBase58(),
      seller: sellerPk.toBase58(),
      tokenMint: mintPk.toBase58(),
      tokenATA: tokenAta.toBase58(),
      newPrice: priceSol,
    };
    if (sellerReferral && parsePubkey(sellerReferral)) insPayload.sellerReferral = sellerReferral;
    const NO_EXPIRY_SENTINEL_MS = 4102444800000;
    insPayload.buyerExpiry = typeof buyerExpiry === 'number' && buyerExpiry > 0
      ? buyerExpiry * 1000
      : NO_EXPIRY_SENTINEL_MS;
    const q = encodeURIComponent(JSON.stringify([{ type: 'sell_now', ins: insPayload }]));
    const path = `/instructions/batch?q=${q}`;

    interface BatchResult { status: string; value?: { txSigned?: { data?: number[] }; blockhashData?: { lastValidBlockHeight?: number } }; reason?: unknown; }
    let batch: BatchResult[];
    try {
      batch = await meGet(path);
    } catch (err) {
      const status = err instanceof MeApiError ? err.status : 502;
      return res.status(status).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    if (!Array.isArray(batch) || batch.length !== 1) {
      return res.status(200).json({ ok: false, error: 'me_batch_response_shape_unexpected' });
    }
    const entry = batch[0];
    if (entry.status !== 'fulfilled' || !entry.value) {
      return res.status(200).json({ ok: false, error: `me_batch_entry_not_fulfilled: ${JSON.stringify(entry.reason ?? entry.status)}` });
    }
    const src = entry.value.txSigned;
    if (!src?.data || !Array.isArray(src.data)) {
      return res.status(200).json({ ok: false, error: 'me_response_missing_tx_signed' });
    }
    const lastValidBlockHeight = entry.value.blockhashData?.lastValidBlockHeight;
    if (typeof lastValidBlockHeight !== 'number') {
      return res.status(200).json({ ok: false, error: 'me_response_missing_blockhash_data' });
    }

    let tx: Transaction;
    try { tx = decodeLegacyTxFromBytes(Buffer.from(src.data)); }
    catch (err) { return res.status(200).json({ ok: false, error: err instanceof Error ? err.message : String(err) }); }

    const sellCtx: SellValidationContext = {
      kind: 'sell', expectedSeller: sellerPk.toBase58(),
      expectedMint: mintPk.toBase58(), expectedAuctionHouse: ahPk.toBase58(),
      expectedBuyer: buyerPk.toBase58(),
    };
    let validated: ValidatedSellTx;
    try {
      validated = validateSellStructure(tx, sellCtx, 'absent');
    } catch (err) {
      return res.status(422).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    // The one thing this backend-only path cannot supply itself: if ME's
    // cosigner slot came back unsigned, there is no key on this server that
    // can fill it. Surface that plainly instead of caching a digest for a
    // tx that can never pass submit's verifySignatures(true) check.
    if (!validated.cosignPrefilled) {
      return res.status(409).json({
        ok: false, error: 'cosign_not_prefilled',
        needsBridge: true,
        detail: `ME returned an unsigned cosigner slot (${validated.cosignerPubkey}) — this backend-only path cannot complete the trade without a browser-session bridge.`,
      });
    }

    const digest = validated.messageHash;
    digestCache.set(digest, {
      ctx: sellCtx,
      blockhashInfo: { blockhash: tx.recentBlockhash!, lastValidBlockHeight },
      expiresAt: now() + DIGEST_TTL_MS,
    });

    return res.json({
      ok: true,
      digest,
      txBase64: tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64'),
      cosignerPubkey: validated.cosignerPubkey,
      priceSol,
      expiresInMs: DIGEST_TTL_MS,
    });
  });

  router.post('/tools/me-sell/simulate', simLimit, authMw, async (req: Request, res: Response) => {
    const { tx } = req.body as { tx?: string };
    if (!tx || typeof tx !== 'string') return res.status(400).json({ ok: false, error: 'missing_tx' });
    let decoded: Transaction;
    try { decoded = decodeLegacyTxFromBase64(tx); }
    catch (err) { return res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) }); }
    try {
      const sim = await chain.simulateTransaction(decoded);
      return res.json({ ok: true, err: sim.err, logs: sim.logs, unitsConsumed: sim.unitsConsumed });
    } catch (err) {
      return res.status(200).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Submit a tx obtained via the Tampermonkey bridge (real browser
  //    session → /instructions/batch), not our own build-accept ──────────
  //
  // No prior digest exists for this tx (it never passed through this
  // server's build-accept), so there's nothing to bind against — the
  // security boundary here is purely structural validation (right seller/
  // mint/auctionHouse/buyer, right signer shape) plus cryptographic
  // signature verification, exactly like the digest path's own
  // revalidation step, just without the earlier build-time snapshot to
  // compare against. Single-operator personal tool — no multi-tenant
  // digest-forgery concern this is meant to close.
  router.post('/tools/me-sell/submit-bridge', submitLimit, authMw, async (req: Request, res: Response) => {
    if (!liveEnabled) return res.status(403).json({ ok: false, error: 'live_mode_disabled_server_side' });
    const { signedTx, seller, tokenMint, auctionHouseAddress, buyer } = req.body as {
      signedTx?: string; seller?: string; tokenMint?: string; auctionHouseAddress?: string; buyer?: string;
    };
    const sellerPk = parsePubkey(seller);
    const mintPk = parsePubkey(tokenMint);
    const ahPk = parsePubkey(auctionHouseAddress);
    const buyerPk = parsePubkey(buyer);
    if (!signedTx || typeof signedTx !== 'string' || !sellerPk || !mintPk || !ahPk || !buyerPk) {
      return res.status(400).json({ ok: false, error: 'invalid_or_missing_params: signedTx, seller, tokenMint, auctionHouseAddress, buyer required' });
    }
    let tx: Transaction;
    try { tx = decodeLegacyTxFromBase64(signedTx); }
    catch (err) { return res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) }); }

    let validated: ValidatedSellTx;
    try {
      validated = validateSellStructure(tx, {
        kind: 'sell', expectedSeller: sellerPk.toBase58(), expectedMint: mintPk.toBase58(),
        expectedAuctionHouse: ahPk.toBase58(), expectedBuyer: buyerPk.toBase58(),
      }, 'present');
    } catch (err) {
      return res.status(409).json({ ok: false, error: `validation_failed: ${err instanceof Error ? err.message : String(err)}` });
    }
    if (!validated.cosignPrefilled) {
      return res.status(400).json({ ok: false, error: 'cosign_missing' });
    }
    if (!tx.verifySignatures(true)) {
      return res.status(400).json({ ok: false, error: 'invalid_signature' });
    }
    try {
      const signature = await chain.sendRawTransaction(tx);
      return res.json({ ok: true, signature });
    } catch (err) {
      return res.status(200).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post('/tools/me-sell/submit', submitLimit, authMw, async (req: Request, res: Response) => {
    if (!liveEnabled) return res.status(403).json({ ok: false, error: 'live_mode_disabled_server_side' });
    const { signedTx, digest } = req.body as { signedTx?: string; digest?: string };
    if (!signedTx || typeof signedTx !== 'string') return res.status(400).json({ ok: false, error: 'missing_signed_tx' });
    if (!digest || typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
      return res.status(400).json({ ok: false, error: 'missing_or_malformed_digest' });
    }
    const entry = digestCache.get(digest);
    if (!entry) return res.status(410).json({ ok: false, error: 'digest_not_found_expired_or_already_used' });
    if (entry.expiresAt < now()) { digestCache.consume(digest); return res.status(410).json({ ok: false, error: 'digest_expired' }); }

    let tx: Transaction;
    try { tx = decodeLegacyTxFromBase64(signedTx); }
    catch (err) { return res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) }); }

    const recomputed = messageHashHex(tx);
    if (recomputed !== digest) {
      return res.status(409).json({ ok: false, error: 'signed_tx_message_does_not_match_digest' });
    }
    if (tx.recentBlockhash !== entry.blockhashInfo.blockhash) {
      return res.status(409).json({ ok: false, error: 'blockhash_mismatch' });
    }

    let currentBlockHeight: number;
    try { currentBlockHeight = await chain.getBlockHeight(); }
    catch (err) { return res.status(200).json({ ok: false, error: err instanceof Error ? err.message : String(err) }); }
    const freshness = checkBlockhashFreshness(tx, entry.blockhashInfo, currentBlockHeight, marginBlocks);
    if (!freshness.ok) return res.status(410).json({ ok: false, error: freshness.code, detail: freshness.detail });

    const consumed = digestCache.consume(digest);
    if (!consumed) return res.status(410).json({ ok: false, error: 'digest_not_found_expired_or_already_used' });

    let validated: ValidatedSellTx;
    try {
      validated = validateSellStructure(tx, entry.ctx, 'present');
    } catch (err) {
      return res.status(409).json({ ok: false, error: `revalidation_failed: ${err instanceof Error ? err.message : String(err)}` });
    }
    if (!validated.cosignPrefilled) {
      return res.status(400).json({ ok: false, error: 'cosign_missing_at_submit' });
    }
    // The actual security boundary: cryptographically verifies BOTH
    // signature slots (seller's just-added signature AND ME's cosign)
    // against the exact message bytes.
    if (!tx.verifySignatures(true)) {
      return res.status(400).json({ ok: false, error: 'invalid_signature' });
    }

    try {
      const signature = await chain.sendRawTransaction(tx);
      return res.json({ ok: true, signature });
    } catch (err) {
      return res.status(200).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
