/**
 * Magic Eden item-level bid tool — personal use only, not a public feature.
 *
 * ME's own web UI has (as of writing) disabled placing NEW offers on
 * Solana from the frontend. This router lets the operator build/sign/
 * submit item-level bid actions (create / change price / cancel /
 * withdraw-escrow) directly against ME's public Instruction API, bypassing
 * the broken UI. MMM pool / collection-bid creation is deliberately out of
 * scope.
 *
 * ── LIFECYCLE — cancel does NOT return escrow SOL ──────────────────────────
 *
 * Cancelling an offer (buy_cancel) frees the trade-state account but never
 * touches the buyer's M2 escrow (confirmed: its account list never
 * references the escrow PDA at all). The bid amount stays parked in that
 * escrow, reusable for a future bid, until a SEPARATE withdraw-escrow
 * build/submit moves it back toward the buyer's own wallet. Nothing in
 * this file's responses ever calls a cancel "funds returned" — see
 * `CancellationContext` / the withdraw-escrow routes below and the
 * frontend's explicit lifecycle states.
 *
 * ── API CONTRACT (re-verified live 2026-07-16/17, bounded read-only calls) ──
 *
 * All four instruction endpoints return the SAME envelope shape:
 *
 *   GET /instructions/buy?buyer=&tokenMint=&price=&auctionHouseAddress=[&expiry=]
 *   GET /instructions/buy_change_price?buyer=&tokenMint=&price=&newPrice=&auctionHouseAddress=
 *   GET /instructions/buy_cancel?buyer=&tokenMint=&price=&auctionHouseAddress=
 *   GET /instructions/withdraw?buyer=&auctionHouseAddress=&amount=   (amount is SOL, REQUIRED —
 *       there is no "withdraw everything" mode; confirmed against official docs
 *       at docs.magiceden.io/reference/get_instructions-withdraw)
 *
 * Response envelope (confirmed identical across all 4 endpoints):
 *   { tx:{...unusable, do not decode}, v0:{tx,txSigned}, blockhashData:{blockhash,lastValidBlockHeight}, txSigned:{...LEGACY, unsigned despite the name} }
 *
 * This tool deliberately only ever decodes the top-level `txSigned` (legacy)
 * field — see git history / PR notes for the full live-verification trail
 * (real okay_bears listing + a real active 46 SOL offer + a real withdraw
 * instruction-generation call against that same wallet): no ME cosigner
 * exists for any of these four ops (exactly 1 required signer, the buyer,
 * always unsigned on return); program allowlist is {ComputeBudget, M2};
 * the buyer's M2 escrow PDA (`deriveBuyerEscrowPda`, me-bid-escrow.ts) is
 * the writable account BuyV2/buy_change_price fund and the ONLY writable
 * account withdraw touches — independently cross-checked against ME's own
 * GET /wallets/:wallet/escrow_balance response (`buyerEscrow` field),
 * which matched byte-for-byte; buy_cancel never touches escrow, only the
 * trade-state PDA.
 *
 * `GET /instructions/buy_cancel` was confirmed live to be a pure,
 * stateless instruction builder over (buyer, tokenMint, price,
 * auctionHouseAddress): a call using a price that had NEVER been a real
 * offer still returned HTTP 200 with a structurally valid, decodable
 * instruction. It does not consult Magic Eden's offers_received/
 * offers_made read index at all — so build/cancel and build/change-price
 * below never need to wait on that index; they only need the (buyer,
 * mint, price, auctionHouse) tuple, which a `CancellationContext` returned
 * by build/create already provides.
 *
 * ── DIGEST / MESSAGE BINDING ────────────────────────────────────────────
 *
 * The digest binds the immutable Solana transaction MESSAGE
 * (`Transaction.serializeMessage()` — account keys, instructions,
 * recentBlockhash, header; excludes the mutable signatures array) via
 * SHA-256, computed once at build time on the still-unsigned tx and cached
 * server-side together with the full validation context and the exact
 * blockhash/lastValidBlockHeight ME returned. /submit recomputes the same
 * hash over whatever signed bytes the client sends and rejects on any
 * difference — signing (which only ever fills the signature slot, never
 * touches the message) does not change this hash, which is the whole
 * point: build-time validation transfers intact to submit time.
 *
 * ── SAFETY MODEL ─────────────────────────────────────────────────────────
 *
 *   GET  /api/tools/me-bids/status                     — { liveEnabled, meApiConfigured } only, no secrets
 *   GET  /api/tools/me-bids/offers?mint=<mint>          — real bids on a mint (offers_received)
 *   GET  /api/tools/me-bids/my-offers?wallet=<wallet>   — operator's own active bids (offers_made)
 *   GET  /api/tools/me-bids/escrow-balance?wallet=&auctionHouseAddress=  — pure on-chain read, no ME dependency
 *   POST /api/tools/me-bids/build/create                — { buyer, tokenMint, priceSol, expiry? }
 *                                                          -> response includes `cancellationContext`
 *                                                             (non-secret; see below)
 *   POST /api/tools/me-bids/build/change-price           — { buyer, tokenMint, newPriceSol, cancellationContext? }
 *   POST /api/tools/me-bids/build/cancel                 — { buyer, tokenMint, cancellationContext? }
 *   POST /api/tools/me-bids/build/withdraw-escrow        — { buyer, auctionHouseAddress, amountSol }
 *   POST /api/tools/me-bids/simulate                     — { tx: base64 } -> simulateTransaction result
 *   POST /api/tools/me-bids/submit                       — { signedTx: base64, digest } -> real broadcast
 *
 * `cancellationContext` (see `CancellationContext`) is exactly what
 * build/create's response already returns: buyer, tokenMint, price,
 * auctionHouseAddress, tradeStatePda (the PDA ME's own create response
 * referenced — never guessed), escrowPda. All public on-chain values, safe
 * for the frontend to persist in localStorage. build/change-price and
 * build/cancel try Magic Eden's own live read index FIRST (freshest), and
 * only fall back to a client-supplied `cancellationContext` when the index
 * doesn't have the offer yet — see `resolveOfferForCancelOrChangePrice`.
 * Either way, the trade-state PDA that ends up in the built transaction is
 * whatever THIS fresh /instructions/buy_cancel or /buy_change_price
 * response actually contains; a wrong or stale client-supplied hint fails
 * `validateStructure`'s mismatch check, it is never substituted in blindly.
 *
 * Every route requires auth (site-wide SIWS + UI_ALLOWED_WALLETS gate).
 * This process never handles a private key: build/* only ever returns an
 * UNSIGNED tx for the operator's own wallet to sign client-side via
 * Phantom; /submit only ever accepts already-signed bytes, and:
 *
 *   1. requires ME_BIDS_ENABLE_LIVE=true server-side (checked before
 *      touching the digest cache or RPC — a browser localStorage toggle
 *      has zero authority);
 *   2. requires a digest this process itself issued from a build/* call,
 *      unexpired, unused (single-use, consumed before RPC is ever
 *      touched — closes concurrent double-submit races);
 *   3. rejects if the signed tx's blockhash doesn't match what was
 *      validated, or if the current on-chain block height is at/near
 *      `lastValidBlockHeight` (small configurable margin) — checked via a
 *      real read-only RPC call, never by locally re-stamping a fresh
 *      blockhash (which would silently invalidate the digest binding);
 *   4. re-runs the exact same structural validation as build time;
 *   5. cryptographically verifies the buyer's ed25519 signature over the
 *      message bytes locally (`Transaction.verifySignatures`) — not just
 *      via RPC preflight, which is a courtesy fallback, not the security
 *      boundary.
 *
 * Never reuses the generic, validation-free `/api/tools/mmm-pools/send-tx`
 * proxy — this router owns its own broadcast path end to end.
 *
 * ── DEPENDENCY INJECTION ─────────────────────────────────────────────────
 *
 * `createMeBidsRouter(deps?)` accepts optional overrides for every
 * external effect (ME HTTP transport, ME API key/cooldown state, chain
 * RPC calls, wall clock, auth middleware, escrow-balance reader, and the
 * LIVE flag) so the full request/response contract — including the digest
 * cache, blockhash-freshness gate, and signature verification — can be
 * exercised in-process against fake data with zero live network calls.
 * Production callers (`app.ts`) call it with no arguments and get the
 * real implementations. See `src/server/__tests__/tools-me-bids.test.ts`.
 */

import { Router, Request, Response, RequestHandler } from 'express';
import {
  PublicKey, Connection, Transaction, TransactionInstruction, SystemProgram,
} from '@solana/web3.js';
import { createHash, timingSafeEqual } from 'crypto';
import { rateLimit } from './rate-limit';
import { requireAuth } from './runtime';
import { meAuthHeaders, hasMeApiKey, meCooldownActive, setMeCooldown } from '../me-api-cooldown';
import { deriveBuyerEscrowPda, resolveEscrowBalances, lamportsToSol } from './me-bid-escrow';

const ME_API_BASE = 'https://api-mainnet.magiceden.dev/v2';
const FETCH_TIMEOUT_MS = 10_000;

/** Fails closed: any missing/false/misspelled value keeps LIVE off. Only
 *  the exact string 'true' (case-insensitive, trimmed) enables it. */
function liveEnabledFromEnv(): boolean {
  return (process.env.ME_BIDS_ENABLE_LIVE ?? '').trim().toLowerCase() === 'true';
}

const DEFAULT_BLOCKHASH_MARGIN_BLOCKS = 10;
function blockhashMarginBlocksFromEnv(): number {
  const v = Number(process.env.ME_BIDS_BLOCKHASH_MARGIN_BLOCKS);
  return Number.isFinite(v) && v >= 0 ? v : DEFAULT_BLOCKHASH_MARGIN_BLOCKS;
}

const COMPUTE_BUDGET_PROGRAM_ID = 'ComputeBudget111111111111111111111111111111';
const M2_PROGRAM_ID = 'M2mx93ekt1fmXSVkTrUL9xVFHkmME8HTUi5Cyc5aF7K';
const ALLOWED_PROGRAM_IDS = new Set([COMPUTE_BUDGET_PROGRAM_ID, M2_PROGRAM_ID]);

function rpcUrl(): string {
  const key = process.env.HELIUS_API_KEY;
  return key
    ? `https://beta.helius-rpc.com/?api-key=${key}`
    : 'https://api.mainnet-beta.solana.com';
}

// ── ME API client — injectable transport + key/cooldown provider, handles
//    the 3 documented error shapes (string / express-validator array /
//    {message}) plus non-JSON (HTML/WAF) bodies ──────────────────────────

export class MeApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function parseMeErrorBody(body: unknown): string {
  if (body && typeof body === 'object') {
    const b = body as { err?: unknown; message?: unknown };
    if (typeof b.err === 'string') return b.err;
    if (Array.isArray(b.err)) {
      return b.err
        .map((e) => (e && typeof e === 'object' && 'msg' in e ? String((e as { msg: unknown }).msg) : JSON.stringify(e)))
        .join('; ');
    }
    if (typeof b.message === 'string') return b.message;
  }
  return 'unknown_me_error';
}

/** Raw HTTP transport seam — returns status + raw text so callers (real or
 *  test) can exercise the SAME JSON/error-shape parsing logic against
 *  arbitrary bodies (valid JSON, HTML/WAF pages, empty timeouts-as-throws). */
export type MeHttpTransport = (path: string) => Promise<{ status: number; text: string }>;

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

export interface MeApiKeyProvider {
  hasKey: () => boolean;
  authHeaders: () => Record<string, string>;
  cooldownActive: () => boolean;
  setCooldown: (ms?: number) => void;
}

function defaultMeApiKeyProvider(): MeApiKeyProvider {
  return { hasKey: hasMeApiKey, authHeaders: meAuthHeaders, cooldownActive: meCooldownActive, setCooldown: setMeCooldown };
}

function createMeGet(transport: MeHttpTransport, keys: MeApiKeyProvider) {
  return async function meGet<T>(path: string): Promise<T> {
    if (!keys.hasKey()) throw new MeApiError(503, 'me_api_key_not_configured');
    if (keys.cooldownActive()) throw new MeApiError(429, 'me_api_cooldown_active');
    let res: { status: number; text: string };
    try {
      res = await transport(path);
    } catch (err) {
      throw new MeApiError(504, `me_api_unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (res.status === 429) {
      keys.setCooldown();
      throw new MeApiError(429, 'me_api_rate_limited');
    }
    let json: unknown;
    try { json = JSON.parse(res.text); } catch { json = null; }
    if (res.status < 200 || res.status >= 300) {
      // A WAF/Cloudflare block or any non-JSON error page parses to
      // `json === null` here — parseMeErrorBody's fallback message covers it.
      throw new MeApiError(res.status, parseMeErrorBody(json));
    }
    if (json === null) {
      // 2xx with an unparseable body (shouldn't happen for real ME
      // responses, but never trust upstream shape blindly).
      throw new MeApiError(502, 'me_response_not_json');
    }
    return json as T;
  };
}

// ── Legacy-only tx decode (v0 is intentionally unsupported — see header) ──

interface MeInstructionResponse {
  txSigned?: { type?: string; data?: number[] };
  blockhashData?: { blockhash?: string; lastValidBlockHeight?: number };
}

export function decodeLegacyTxFromBytes(bytes: Buffer): Transaction {
  try {
    return Transaction.from(bytes);
  } catch (err) {
    throw new Error(`tx_undecodable_not_legacy: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function decodeMeResponse(json: MeInstructionResponse): { tx: Transaction; lastValidBlockHeight: number } {
  const src = json.txSigned;
  if (!src?.data || !Array.isArray(src.data)) throw new Error('me_response_missing_tx_signed');
  const tx = decodeLegacyTxFromBytes(Buffer.from(src.data));
  const lastValidBlockHeight = json.blockhashData?.lastValidBlockHeight;
  if (typeof lastValidBlockHeight !== 'number' || !Number.isFinite(lastValidBlockHeight)) {
    throw new Error('me_response_missing_blockhash_data');
  }
  // ME's top-level blockhashData.blockhash is redundant with (always equal
  // to, empirically) tx.recentBlockhash decoded from txSigned itself — we
  // use tx.recentBlockhash as the single source of truth rather than
  // trusting the separate top-level field could ever diverge from it.
  return { tx, lastValidBlockHeight };
}

export function decodeLegacyTxFromBase64(b64: string): Transaction {
  let bytes: Buffer;
  try { bytes = Buffer.from(b64, 'base64'); } catch { throw new Error('invalid_tx_encoding'); }
  return decodeLegacyTxFromBytes(bytes);
}

/** The ONLY bytes that get hashed: the canonical message (account keys,
 *  instructions, recentBlockhash, header). Excludes `tx.signatures`
 *  entirely — adding a valid signature never changes this value. */
export function messageHashHex(tx: Transaction): string {
  return createHash('sha256').update(tx.serializeMessage()).digest('hex');
}

function serializeUnsignedForClient(tx: Transaction): string {
  return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64');
}

function digestsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

// ── Exhaustive structural validation ────────────────────────────────────

export type Op = 'create' | 'change-price' | 'cancel';

export interface ValidationContext {
  op: Op;
  expectedBuyer: string;
  expectedMint: string;
  expectedAuctionHouse: string;
  /** Known ahead of time for change-price/cancel (ME's own `pdaAddress` on
   *  the real offer independently looked up); null for create, where no
   *  prior trade state exists and ME's exact PDA seed formula isn't
   *  public. */
  expectedTradeStatePda: string | null;
  /** Buyer's M2 escrow PDA, independently derived (never trusted from ME).
   *  Expected present+writable for create/change-price; expected ABSENT
   *  for cancel (ground truth: cancel never touches escrow). */
  expectedEscrowPda: string;
}

export interface ValidatedTx {
  tx: Transaction;
  messageHash: string;
  /** For `create` only: the new trade-state PDA ME's own returned tx
   *  actually references (the one, structurally-verified-unique, unknown
   *  writable account). This is READ from ME's response, never guessed or
   *  independently re-derived (ME doesn't publish the seed formula) — but
   *  it's exactly what /instructions/buy_cancel or /instructions/
   *  buy_change_price will independently re-derive and validate against
   *  later, since those calls compute the trade state themselves from
   *  (buyer, mint, price, auctionHouse) rather than accepting a pda
   *  parameter. null for change-price/cancel (the PDA is already known
   *  ahead of time there) and for withdraw (no trade state involved). */
  derivedTradeStatePda: string | null;
}

/** Shared by every op: exactly one required signature (the buyer), no
 *  unexpected cosigner, fee payer matches, and every instruction's program
 *  is in the allowlist with exactly one M2 call. Returns that M2
 *  instruction for the caller's op-specific account checks.
 *
 *  `expectSignature` distinguishes the two times this runs: at build time
 *  the tx must be UNSIGNED; at submit time it re-runs against the client's
 *  signed bytes, where the buyer's slot must now be filled — everything
 *  else about the tx must be unchanged. */
function validateSignerAndM2Instruction(
  tx: Transaction, expectedBuyer: string, expectSignature: 'absent' | 'present',
): TransactionInstruction {
  if (tx.signatures.length !== 1) {
    throw new Error(`unexpected_signer_count: expected 1, got ${tx.signatures.length}`);
  }
  const onlySigner = tx.signatures[0].publicKey.toBase58();
  if (onlySigner !== expectedBuyer) {
    throw new Error(`fee_payer_mismatch: expected ${expectedBuyer}, got ${onlySigner}`);
  }
  if (expectSignature === 'absent' && tx.signatures[0].signature) {
    throw new Error('unexpected_pre_filled_signature: no cosigner is expected on this instruction');
  }
  if (expectSignature === 'present' && !tx.signatures[0].signature) {
    throw new Error('missing_buyer_signature');
  }
  if (!tx.feePayer || tx.feePayer.toBase58() !== expectedBuyer) {
    throw new Error('fee_payer_field_mismatch');
  }

  for (const ix of tx.instructions) {
    const pid = ix.programId.toBase58();
    if (!ALLOWED_PROGRAM_IDS.has(pid)) throw new Error(`unexpected_program_id: ${pid}`);
  }
  const m2Instructions = tx.instructions.filter((ix) => ix.programId.toBase58() === M2_PROGRAM_ID);
  if (m2Instructions.length !== 1) {
    throw new Error(`unexpected_m2_instruction_count: ${m2Instructions.length}`);
  }
  return m2Instructions[0];
}

/** Throws a descriptive, specific error on any mismatch. Never returns a tx
 *  that failed a check. */
export function validateStructure(
  tx: Transaction, ctx: ValidationContext, expectSignature: 'absent' | 'present',
): ValidatedTx {
  const m2ix = validateSignerAndM2Instruction(tx, ctx.expectedBuyer, expectSignature);

  const mintKey = m2ix.keys.find((k) => k.pubkey.toBase58() === ctx.expectedMint);
  if (!mintKey) throw new Error('mint_missing_from_instruction');
  if (mintKey.isWritable) throw new Error('unexpected_mint_writable');

  if (!m2ix.keys.some((k) => k.pubkey.toBase58() === ctx.expectedAuctionHouse)) {
    throw new Error('auction_house_missing_from_instruction');
  }

  if (m2ix.keys.some((k) => k.pubkey.toBase58() === SystemProgram.programId.toBase58() && k.isWritable)) {
    throw new Error('unexpected_writable_system_program');
  }

  const writableNonSigner = [...new Set(
    m2ix.keys.filter((k) => k.isWritable && !k.isSigner).map((k) => k.pubkey.toBase58()),
  )];

  if (ctx.op === 'cancel') {
    if (writableNonSigner.includes(ctx.expectedEscrowPda)) {
      throw new Error('unexpected_escrow_touch_on_cancel');
    }
    if (!ctx.expectedTradeStatePda || !writableNonSigner.includes(ctx.expectedTradeStatePda)) {
      throw new Error('trade_state_pda_missing_or_mismatch');
    }
    const unexpected = writableNonSigner.filter((k) => k !== ctx.expectedTradeStatePda);
    if (unexpected.length > 0) throw new Error(`unexpected_writable_account: ${unexpected.join(', ')}`);
    return { tx, messageHash: messageHashHex(tx), derivedTradeStatePda: null };
  }

  if (!writableNonSigner.includes(ctx.expectedEscrowPda)) {
    throw new Error('escrow_pda_missing_or_mismatch');
  }

  if (ctx.op === 'change-price') {
    if (!ctx.expectedTradeStatePda || !writableNonSigner.includes(ctx.expectedTradeStatePda)) {
      throw new Error('trade_state_pda_missing_or_mismatch');
    }
    const unexpected = writableNonSigner.filter(
      (k) => k !== ctx.expectedEscrowPda && k !== ctx.expectedTradeStatePda,
    );
    if (unexpected.length > 0) throw new Error(`unexpected_writable_account: ${unexpected.join(', ')}`);
    return { tx, messageHash: messageHashHex(tx), derivedTradeStatePda: null };
  }

  // create: exactly one additional writable account is expected — the new
  // trade-state PDA. Its identity isn't cross-checked (ME doesn't publish
  // the seed formula), only that there's exactly one, distinct from every
  // known account. Surfaced to the caller so it can be handed back to the
  // client as part of the non-secret cancellation context (see
  // `resolveOfferForCancelOrChangePrice` / build/create's response).
  const unknown = writableNonSigner.filter((k) => k !== ctx.expectedEscrowPda);
  if (unknown.length !== 1) {
    throw new Error(`unexpected_writable_account_count: expected exactly 1 new trade-state PDA, got ${unknown.length}`);
  }
  return { tx, messageHash: messageHashHex(tx), derivedTradeStatePda: unknown[0] };
}

// ── Escrow withdrawal — structurally distinct from create/change-price/
//    cancel: no mint, no trade-state PDA, exactly one writable account
//    (the escrow PDA itself). Confirmed live 2026-07-17, one bounded read
//    of GET /instructions/withdraw?buyer=&auctionHouseAddress=&amount=
//    against a real wallet/auction-house pair: same 4-field envelope
//    ({tx,v0,blockhashData,txSigned}), same program allowlist
//    {ComputeBudget, M2}, single unsigned buyer signature, and the ONLY
//    writable non-signer account is the buyer's M2 escrow PDA — identical
//    to what `deriveBuyerEscrowPda` computes and to what ME's own GET
//    /wallets/:wallet/escrow_balance independently reports as
//    `buyerEscrow` for the same (wallet, default-AH) pair (cross-checked
//    live, not assumed). `amount` is a REQUIRED SOL-denominated query
//    param — ME does NOT expose an automatic "withdraw everything" mode;
//    the caller must state an exact amount every time. ─────────────────────

export interface WithdrawValidationContext {
  expectedBuyer: string;
  expectedAuctionHouse: string;
  expectedEscrowPda: string;
}

/** Mirrors `validateStructure`'s rigor for the simpler withdraw shape:
 *  same signer/program-allowlist checks, then exactly one writable
 *  non-signer account and it must be the independently-derived escrow PDA
 *  — nothing else may be writable. */
export function validateWithdrawStructure(
  tx: Transaction, ctx: WithdrawValidationContext, expectSignature: 'absent' | 'present',
): ValidatedTx {
  const m2ix = validateSignerAndM2Instruction(tx, ctx.expectedBuyer, expectSignature);

  if (!m2ix.keys.some((k) => k.pubkey.toBase58() === ctx.expectedAuctionHouse)) {
    throw new Error('auction_house_missing_from_instruction');
  }
  if (m2ix.keys.some((k) => k.pubkey.toBase58() === SystemProgram.programId.toBase58() && k.isWritable)) {
    throw new Error('unexpected_writable_system_program');
  }

  const writableNonSigner = [...new Set(
    m2ix.keys.filter((k) => k.isWritable && !k.isSigner).map((k) => k.pubkey.toBase58()),
  )];
  if (!writableNonSigner.includes(ctx.expectedEscrowPda)) {
    throw new Error('escrow_pda_missing_or_mismatch');
  }
  const unexpected = writableNonSigner.filter((k) => k !== ctx.expectedEscrowPda);
  if (unexpected.length > 0) throw new Error(`unexpected_writable_account: ${unexpected.join(', ')}`);

  return { tx, messageHash: messageHashHex(tx), derivedTradeStatePda: null };
}

// ── Blockhash freshness (Part 3) ────────────────────────────────────────

export interface BlockhashInfo {
  blockhash: string;
  lastValidBlockHeight: number;
}

export type BlockhashCheck =
  | { ok: true }
  | { ok: false; code: 'blockhash_mismatch' | 'blockhash_expired' | 'blockhash_near_expiry'; detail: string };

/** Never replaces or refreshes the blockhash — doing so would change the
 *  message and invalidate the digest binding. This only ever READS the
 *  current height and compares. */
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
    return { ok: false, code: 'blockhash_near_expiry', detail: `currentBlockHeight ${currentBlockHeight} within ${marginBlocks}-block safety margin of lastValidBlockHeight ${info.lastValidBlockHeight}` };
  }
  return { ok: true };
}

// ── Chain access — injectable (Part 5/2: sigVerify:false, no blockhash
//    replacement, escrow-PDA-scoped account inspection) ────────────────────

export interface SimAccountResult { lamports: number }
export interface SimResult {
  err: unknown;
  logs: string[];
  accounts: Array<SimAccountResult | null> | null;
  unitsConsumed: number | null;
}

export interface ChainClient {
  /** sigVerify is always effectively false here (the tx is unsigned at
   *  build/simulate time by construction) and the blockhash is NEVER
   *  replaced on the tx object this function is given — see
   *  `preflightSimulate` for the empirical proof that the underlying RPC
   *  call's own internal blockhash substitution (needed to even attempt
   *  simulating a legacy tx) never mutates the caller's object. */
  simulateTransaction(tx: Transaction, includeAccounts?: PublicKey[]): Promise<SimResult>;
  getBlockHeight(): Promise<number>;
  sendRawTransaction(tx: Transaction): Promise<string>;
}

function defaultChainClient(conn: Connection): ChainClient {
  return {
    async simulateTransaction(tx: Transaction, includeAccounts?: PublicKey[]): Promise<SimResult> {
      // Deprecated legacy overload: signers=undefined => sigVerify is
      // effectively off and the RPC call fetches a fresh blockhash purely
      // for the simulation attempt itself, on an INTERNALLY constructed
      // copy — it does not mutate `tx` (proven: tx.recentBlockhash /
      // messageHashHex(tx) are unchanged after this call returns).
      const sim = await conn.simulateTransaction(tx, undefined, includeAccounts);
      return {
        err: sim.value.err,
        logs: sim.value.logs ?? [],
        accounts: sim.value.accounts ?? null,
        unitsConsumed: sim.value.unitsConsumed ?? null,
      };
    },
    getBlockHeight: () => conn.getBlockHeight(),
    sendRawTransaction: (tx: Transaction) => conn.sendRawTransaction(
      tx.serialize(), { skipPreflight: false, maxRetries: 3 },
    ),
  };
}

interface PreflightResult {
  ok: boolean;
  err: unknown;
  logs: string[];
  escrowPostLamports: number | null;
}

async function preflightSimulate(chain: ChainClient, tx: Transaction, escrowPda: string): Promise<PreflightResult> {
  const sim = await chain.simulateTransaction(tx, [new PublicKey(escrowPda)]);
  const escrowPostLamports = sim.accounts && sim.accounts[0] ? sim.accounts[0].lamports : null;
  return { ok: sim.err == null, err: sim.err, logs: sim.logs, escrowPostLamports };
}

/** Extracts `{"price":N,"buyer_expiry":N}` from the program's own log line
 *  when present — a transparency extra, not a security boundary (the
 *  escrow-balance bound is the actual enforcement). */
function parsePriceExpiryLog(logs: string[]): { price: number; buyerExpiry: number } | null {
  for (const line of logs) {
    const m = /Program log: (\{"price":\d+,"buyer_expiry":-?\d+\})/.exec(line);
    if (!m) continue;
    try {
      const parsed = JSON.parse(m[1]) as { price: number; buyer_expiry: number };
      return { price: parsed.price, buyerExpiry: parsed.buyer_expiry };
    } catch { /* ignore malformed */ }
  }
  return null;
}

// ── Digest cache (Part 4) — per-router-instance (not module-global), so
//    each `createMeBidsRouter()` call — including every test — gets its
//    own isolated, boundedly-sized, TTL-swept cache. Single-use: deleted
//    the moment a submit is accepted for processing, before RPC is ever
//    touched, so a concurrent duplicate request cannot race a second
//    consumption through. ─────────────────────────────────────────────────

type AnyValidationContext =
  | ({ kind: 'bid' } & ValidationContext)
  | ({ kind: 'withdraw' } & WithdrawValidationContext);

interface DigestEntry {
  ctx: AnyValidationContext;
  blockhashInfo: BlockhashInfo;
  createdAt: number;
  expiresAt: number;
}

const DIGEST_TTL_MS = 5 * 60_000;
const DIGEST_CACHE_MAX = 500;
const DIGEST_SWEEP_INTERVAL_MS = 60_000;

class DigestCache {
  private map = new Map<string, DigestEntry>();
  constructor(private now: () => number) {}

  set(digest: string, entry: DigestEntry): void {
    this.cleanup();
    this.map.set(digest, entry);
    this.cleanup();
  }
  get(digest: string): DigestEntry | undefined {
    return this.map.get(digest);
  }
  /** Single-use: removes and returns in one step. */
  consume(digest: string): DigestEntry | undefined {
    const entry = this.map.get(digest);
    if (entry) this.map.delete(digest);
    return entry;
  }
  delete(digest: string): void { this.map.delete(digest); }
  get size(): number { return this.map.size; }

  /** TTL sweep, then a deterministic FIFO (insertion-order) hard cap —
   *  `Map` iteration order is guaranteed insertion order, so eviction
   *  always drops the oldest entries first, never at random. */
  cleanup(): void {
    const now = this.now();
    for (const [k, v] of this.map) {
      if (v.expiresAt < now) this.map.delete(k);
    }
    if (this.map.size > DIGEST_CACHE_MAX) {
      const toDrop = this.map.size - DIGEST_CACHE_MAX;
      let i = 0;
      for (const k of this.map.keys()) {
        if (i++ >= toDrop) break;
        this.map.delete(k);
      }
    }
  }
}

// ── Input validation helpers ────────────────────────────────────────────

function parsePubkey(v: unknown): PublicKey | null {
  if (typeof v !== 'string' || !v) return null;
  try { return new PublicKey(v); } catch { return null; }
}

function parsePriceSol(v: unknown): number | null {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

interface MeOffer {
  pdaAddress?: string;
  tokenMint?: string;
  auctionHouse?: string;
  buyer?: string;
  price?: number;
  expiry?: number;
}

async function findOwnOffer(
  meGet: <T>(path: string) => Promise<T>, mint: string, buyer: string,
): Promise<MeOffer | null> {
  const offers = await meGet<MeOffer[]>(`/tokens/${encodeURIComponent(mint)}/offers_received`);
  if (!Array.isArray(offers)) return null;
  return offers.find((o) => o.buyer === buyer) ?? null;
}

/** Everything needed to build a cancel or change-price call for an offer
 *  this tool itself just created, WITHOUT depending on Magic Eden's
 *  offers_received/offers_made read index having caught up. All fields are
 *  public on-chain addresses/values — nothing secret, safe to persist in
 *  the browser. `tradeStatePda` is the exact value ME's own create
 *  response referenced (see `ValidatedTx.derivedTradeStatePda`), not a
 *  guess. */
export interface CancellationContext {
  buyer: string;
  tokenMint: string;
  price: number;
  auctionHouseAddress: string;
  tradeStatePda: string;
  escrowPda: string;
}

/**
 * Resolves the (price, auctionHouse, pdaAddress) triple a cancel or
 * change-price call needs, preferring Magic Eden's own live read index
 * (freshest/most authoritative when available) and falling back to a
 * client-retained `CancellationContext` — confirmed live 2026-07-17 that
 * GET /instructions/buy_cancel is a pure, deterministic instruction
 * builder over (buyer, tokenMint, price, auctionHouseAddress): it returned
 * a structurally valid instruction for a price that was NEVER a real
 * offer (HTTP 200, decodable txSigned), proving it does not consult
 * offers_received's index at all — so a fallback built from a still-
 * unindexed create is not a guess, it's calling the exact same stateless
 * endpoint with values the server itself issued moments earlier.
 *
 * The fallback's `pdaAddress` is a HINT only, never trusted directly: the
 * caller must still run it through `validateStructure`, which checks the
 * hint against the trade-state PDA actually embedded in ME's response for
 * this exact (buyer, tokenMint, price, auctionHouseAddress) tuple — a
 * wrong or stale hint fails that check closed, it never gets silently
 * substituted in.
 */
async function resolveOfferForCancelOrChangePrice(
  meGet: <T>(path: string) => Promise<T>, mint: string, buyer: string,
  fallback: CancellationContext | undefined,
): Promise<{ price: number; auctionHouse: string; pdaAddress: string; source: 'me_index' | 'local_context' }> {
  const existing = await findOwnOffer(meGet, mint, buyer).catch(() => null);
  if (existing && existing.price != null && existing.auctionHouse && existing.pdaAddress) {
    return { price: existing.price, auctionHouse: existing.auctionHouse, pdaAddress: existing.pdaAddress, source: 'me_index' };
  }
  if (
    fallback && fallback.buyer === buyer && fallback.tokenMint === mint
    && fallback.price > 0 && fallback.auctionHouseAddress && fallback.tradeStatePda
  ) {
    return { price: fallback.price, auctionHouse: fallback.auctionHouseAddress, pdaAddress: fallback.tradeStatePda, source: 'local_context' };
  }
  throw new Error('offer_not_found_and_no_fallback_context');
}

/** No hardcoded/default auction house — resolution must succeed against
 *  real ME read data or the build fails. */
async function resolveAuctionHouse(
  meGet: <T>(path: string) => Promise<T>, mint: string,
): Promise<{ address: string; source: 'offer' | 'listing' }> {
  try {
    const offers = await meGet<MeOffer[]>(`/tokens/${encodeURIComponent(mint)}/offers_received`);
    const withAh = Array.isArray(offers) ? offers.find((o) => o.auctionHouse) : null;
    if (withAh?.auctionHouse) return { address: withAh.auctionHouse, source: 'offer' };
  } catch { /* fall through */ }
  const listings = await meGet<Array<{ auctionHouse?: string }>>(`/tokens/${encodeURIComponent(mint)}/listings`);
  const withAh = Array.isArray(listings) ? listings.find((l) => l.auctionHouse) : null;
  if (withAh?.auctionHouse) return { address: withAh.auctionHouse, source: 'listing' };
  throw new Error('auction_house_unresolved: no active offer or listing found for this mint');
}

export interface MeBidsDeps {
  meTransport?: MeHttpTransport;
  meApiKeyProvider?: MeApiKeyProvider;
  chain?: ChainClient;
  now?: () => number;
  authMiddleware?: RequestHandler;
  escrowBalanceReader?: (escrowPda: string) => Promise<number | null>;
  liveEnabled?: boolean;
  blockhashMarginBlocks?: number;
  /** Bypasses the per-route rate limiters entirely. Never used in
   *  production wiring (app.ts calls this with no deps); exists so tests
   *  can drive hundreds of requests against a single in-process router
   *  instance (e.g. to prove the digest cache's own hard size cap) without
   *  tripping the real per-IP limiter, which is a separate, already-tested
   *  concern (rate-limit.ts). */
  rateLimitsDisabled?: boolean;
}

/** Test-only introspection attached to the returned Router — production
 *  callers never read this. Lets tests assert cache bounds/eviction/sweep
 *  behavior without reaching into module internals. */
export interface MeBidsTestHooks {
  digestCacheSize: () => number;
  sweepTimer: ReturnType<typeof setInterval>;
}

export function createMeBidsRouter(deps: MeBidsDeps = {}): Router & { __meBidsTestHooks?: MeBidsTestHooks } {
  const keys = deps.meApiKeyProvider ?? defaultMeApiKeyProvider();
  const transport = deps.meTransport ?? defaultMeHttpTransport(keys.authHeaders);
  const meGet = createMeGet(transport, keys);
  const chain = deps.chain ?? defaultChainClient(new Connection(rpcUrl(), 'confirmed'));
  const now = deps.now ?? Date.now;
  const authMw: RequestHandler = deps.authMiddleware ?? requireAuth;
  const escrowBalanceReader = deps.escrowBalanceReader ?? (async (pda: string) => {
    const { balances } = await resolveEscrowBalances([pda]);
    return lamportsToSol(balances.get(pda) ?? null);
  });
  const liveEnabled = deps.liveEnabled ?? liveEnabledFromEnv();
  const marginBlocks = deps.blockhashMarginBlocks ?? blockhashMarginBlocksFromEnv();

  const router = Router() as Router & { __meBidsTestHooks?: MeBidsTestHooks };
  const noopLimit: RequestHandler = (_req, _res, next) => next();
  const readLimit  = deps.rateLimitsDisabled ? noopLimit : rateLimit({ limit: 30, windowMs: 60_000, label: 'tools/me-bids/read' });
  const buildLimit = deps.rateLimitsDisabled ? noopLimit : rateLimit({ limit: 15, windowMs: 60_000, label: 'tools/me-bids/build' });
  const simLimit   = deps.rateLimitsDisabled ? noopLimit : rateLimit({ limit: 15, windowMs: 60_000, label: 'tools/me-bids/simulate' });
  const submitLimit = deps.rateLimitsDisabled ? noopLimit : rateLimit({ limit: 10, windowMs: 60_000, label: 'tools/me-bids/submit' });

  const digestCache = new DigestCache(now);
  // unref(): a pending sweep must never keep the Node process alive on its
  // own — the process should be able to exit (e.g. in tests, or on a clean
  // shutdown) with nothing else running, timer or not.
  const sweepTimer = setInterval(() => digestCache.cleanup(), DIGEST_SWEEP_INTERVAL_MS);
  sweepTimer.unref();
  router.__meBidsTestHooks = { digestCacheSize: () => digestCache.size, sweepTimer };

  router.get('/tools/me-bids/status', authMw, (_req: Request, res: Response) => {
    // Capability boolean only — no env var name, no key presence detail
    // beyond a boolean, nothing that helps an attacker fingerprint config.
    res.json({ ok: true, liveEnabled, meApiConfigured: keys.hasKey() });
  });

  router.get('/tools/me-bids/offers', readLimit, authMw, async (req: Request, res: Response) => {
    const mint = String(req.query.mint ?? '').trim();
    if (!parsePubkey(mint)) return res.status(400).json({ ok: false, error: 'invalid_mint' });
    try {
      const offers = await meGet<MeOffer[]>(`/tokens/${encodeURIComponent(mint)}/offers_received`);
      return res.json({ ok: true, offers: Array.isArray(offers) ? offers : [] });
    } catch (err) {
      const e = err as MeApiError;
      return res.status(e.status ?? 502).json({ ok: false, error: e.message });
    }
  });

  router.get('/tools/me-bids/my-offers', readLimit, authMw, async (req: Request, res: Response) => {
    const wallet = String(req.query.wallet ?? '').trim();
    if (!parsePubkey(wallet)) return res.status(400).json({ ok: false, error: 'invalid_wallet' });
    try {
      const offers = await meGet<MeOffer[]>(`/wallets/${encodeURIComponent(wallet)}/offers_made?limit=100`);
      return res.json({ ok: true, offers: Array.isArray(offers) ? offers : [] });
    } catch (err) {
      const e = err as MeApiError;
      return res.status(e.status ?? 502).json({ ok: false, error: e.message });
    }
  });

  router.post('/tools/me-bids/build/create', buildLimit, authMw, async (req: Request, res: Response) => {
    const { buyer, tokenMint, priceSol, expiry } = req.body as {
      buyer?: string; tokenMint?: string; priceSol?: number; expiry?: number;
    };
    const buyerPk = parsePubkey(buyer);
    const mintPk = parsePubkey(tokenMint);
    const price = parsePriceSol(priceSol);
    if (!buyerPk) return res.status(400).json({ ok: false, error: 'invalid_buyer' });
    if (!mintPk) return res.status(400).json({ ok: false, error: 'invalid_token_mint' });
    if (price == null) return res.status(400).json({ ok: false, error: 'invalid_price_sol' });
    const expiryVal = expiry != null && Number.isFinite(Number(expiry)) ? Number(expiry) : undefined;

    try {
      const { address: auctionHouseAddress, source: auctionHouseSource } = await resolveAuctionHouse(meGet, mintPk.toBase58());
      const escrowPda = deriveBuyerEscrowPda(auctionHouseAddress, buyerPk.toBase58());
      if (!escrowPda) return res.status(500).json({ ok: false, error: 'escrow_pda_derivation_failed' });

      let path = `/instructions/buy?buyer=${buyerPk.toBase58()}&tokenMint=${mintPk.toBase58()}`
        + `&price=${price}&auctionHouseAddress=${auctionHouseAddress}`;
      if (expiryVal !== undefined) path += `&expiry=${expiryVal}`;

      const json = await meGet<MeInstructionResponse>(path);
      const { tx, lastValidBlockHeight } = decodeMeResponse(json);
      if (!tx.recentBlockhash) return res.status(502).json({ ok: false, error: 'me_response_missing_blockhash_data' });

      const ctx: ValidationContext = {
        op: 'create',
        expectedBuyer: buyerPk.toBase58(),
        expectedMint: mintPk.toBase58(),
        expectedAuctionHouse: auctionHouseAddress,
        expectedTradeStatePda: null,
        expectedEscrowPda: escrowPda,
      };
      const validated = validateStructure(tx, ctx, 'absent');
      if (!validated.derivedTradeStatePda) {
        // Cannot happen (validateStructure's create branch always returns
        // exactly one derived PDA or throws) — defensive, not a guess.
        return res.status(502).json({ ok: false, error: 'trade_state_pda_not_derived' });
      }

      const priceLamports = Math.round(price * 1e9);
      const maxEscrowPostLamports = priceLamports + 5_000;
      const preflight = await preflightSimulate(chain, tx, escrowPda);
      if (!preflight.ok) {
        return res.status(502).json({ ok: false, error: 'preflight_simulation_failed', simErr: preflight.err, logs: preflight.logs });
      }
      if (preflight.escrowPostLamports != null && preflight.escrowPostLamports > maxEscrowPostLamports) {
        return res.status(502).json({
          ok: false,
          error: `escrow_balance_exceeds_expected: post-sim ${preflight.escrowPostLamports} lamports, expected at most ${maxEscrowPostLamports}`,
        });
      }
      const logPrice = parsePriceExpiryLog(preflight.logs);

      const expiresAt = now() + DIGEST_TTL_MS;
      digestCache.set(validated.messageHash, {
        ctx: { kind: 'bid', ...ctx },
        blockhashInfo: { blockhash: tx.recentBlockhash, lastValidBlockHeight },
        createdAt: now(),
        expiresAt,
      });

      const escrowSolBefore = await escrowBalanceReader(escrowPda).catch(() => null);

      const cancellationContext: CancellationContext = {
        buyer: buyerPk.toBase58(),
        tokenMint: mintPk.toBase58(),
        price,
        auctionHouseAddress,
        tradeStatePda: validated.derivedTradeStatePda,
        escrowPda,
      };

      return res.json({
        ok: true,
        tx: serializeUnsignedForClient(validated.tx),
        digest: validated.messageHash,
        expiresAt,
        preflight: { ok: true, logs: preflight.logs },
        // Non-secret — safe for the client to persist (localStorage) and
        // replay into build/cancel or build/change-price later without
        // needing Magic Eden's read index to have caught up. See
        // `resolveOfferForCancelOrChangePrice`.
        cancellationContext,
        summary: {
          action: 'create',
          buyer: buyerPk.toBase58(),
          tokenMint: mintPk.toBase58(),
          priceSol: price,
          requestedExpiry: expiryVal ?? null,
          effectiveExpiry: logPrice?.buyerExpiry ?? null,
          auctionHouseAddress,
          auctionHouseSource,
          tradeStatePda: validated.derivedTradeStatePda,
          escrowBalanceBeforeSol: escrowSolBefore,
          escrowBalanceAfterSimSol: preflight.escrowPostLamports != null ? preflight.escrowPostLamports / 1e9 : null,
        },
      });
    } catch (err) {
      const e = err as MeApiError;
      const msg = e.message ?? String(err);
      console.error('[tools/me-bids] build/create error', msg);
      return res.status(e.status ?? 502).json({ ok: false, error: msg });
    }
  });

  router.post('/tools/me-bids/build/change-price', buildLimit, authMw, async (req: Request, res: Response) => {
    const { buyer, tokenMint, newPriceSol, cancellationContext } = req.body as {
      buyer?: string; tokenMint?: string; newPriceSol?: number; cancellationContext?: CancellationContext;
    };
    const buyerPk = parsePubkey(buyer);
    const mintPk = parsePubkey(tokenMint);
    const newPrice = parsePriceSol(newPriceSol);
    if (!buyerPk) return res.status(400).json({ ok: false, error: 'invalid_buyer' });
    if (!mintPk) return res.status(400).json({ ok: false, error: 'invalid_token_mint' });
    if (newPrice == null) return res.status(400).json({ ok: false, error: 'invalid_new_price_sol' });

    try {
      let resolved: { price: number; auctionHouse: string; pdaAddress: string; source: 'me_index' | 'local_context' };
      try {
        resolved = await resolveOfferForCancelOrChangePrice(meGet, mintPk.toBase58(), buyerPk.toBase58(), cancellationContext);
      } catch {
        return res.status(404).json({ ok: false, error: 'offer_not_found' });
      }
      const escrowPda = deriveBuyerEscrowPda(resolved.auctionHouse, buyerPk.toBase58());
      if (!escrowPda) return res.status(500).json({ ok: false, error: 'escrow_pda_derivation_failed' });

      const path = `/instructions/buy_change_price?buyer=${buyerPk.toBase58()}&tokenMint=${mintPk.toBase58()}`
        + `&price=${resolved.price}&newPrice=${newPrice}&auctionHouseAddress=${resolved.auctionHouse}`;
      const json = await meGet<MeInstructionResponse>(path);
      const { tx, lastValidBlockHeight } = decodeMeResponse(json);
      if (!tx.recentBlockhash) return res.status(502).json({ ok: false, error: 'me_response_missing_blockhash_data' });

      // The trade-state PDA is independently re-derived here in the sense
      // that matters: it's checked against what THIS response — built
      // fresh from (buyer, mint, price, AH) — actually references, never
      // taken on faith from `resolved.pdaAddress` (which may itself have
      // come from the client's local fallback context).
      const ctx: ValidationContext = {
        op: 'change-price',
        expectedBuyer: buyerPk.toBase58(),
        expectedMint: mintPk.toBase58(),
        expectedAuctionHouse: resolved.auctionHouse,
        expectedTradeStatePda: resolved.pdaAddress,
        expectedEscrowPda: escrowPda,
      };
      const validated = validateStructure(tx, ctx, 'absent');

      // Bounded by the full new price (not the delta) — confirmed live:
      // ME's own internal CPI attempts a transfer for the *full* requested
      // newPrice, not just the raise amount.
      const newPriceLamports = Math.round(newPrice * 1e9);
      const maxEscrowPostLamports = newPriceLamports + 5_000;
      const preflight = await preflightSimulate(chain, tx, escrowPda);
      if (!preflight.ok) {
        return res.status(502).json({ ok: false, error: 'preflight_simulation_failed', simErr: preflight.err, logs: preflight.logs });
      }
      if (preflight.escrowPostLamports != null && preflight.escrowPostLamports > maxEscrowPostLamports) {
        return res.status(502).json({
          ok: false,
          error: `escrow_balance_exceeds_expected: post-sim ${preflight.escrowPostLamports} lamports, expected at most ${maxEscrowPostLamports}`,
        });
      }

      const expiresAt = now() + DIGEST_TTL_MS;
      digestCache.set(validated.messageHash, {
        ctx: { kind: 'bid', ...ctx },
        blockhashInfo: { blockhash: tx.recentBlockhash, lastValidBlockHeight },
        createdAt: now(),
        expiresAt,
      });

      return res.json({
        ok: true,
        tx: serializeUnsignedForClient(validated.tx),
        digest: validated.messageHash,
        expiresAt,
        preflight: { ok: true, logs: preflight.logs },
        summary: {
          action: 'change-price',
          buyer: buyerPk.toBase58(),
          tokenMint: mintPk.toBase58(),
          oldPriceSol: resolved.price,
          newPriceSol: newPrice,
          auctionHouseAddress: resolved.auctionHouse,
          pdaAddress: resolved.pdaAddress,
          resolvedFrom: resolved.source,
          escrowBalanceAfterSimSol: preflight.escrowPostLamports != null ? preflight.escrowPostLamports / 1e9 : null,
        },
      });
    } catch (err) {
      const e = err as MeApiError;
      const msg = e.message ?? String(err);
      console.error('[tools/me-bids] build/change-price error', msg);
      return res.status(e.status ?? 502).json({ ok: false, error: msg });
    }
  });

  router.post('/tools/me-bids/build/cancel', buildLimit, authMw, async (req: Request, res: Response) => {
    const { buyer, tokenMint, cancellationContext } = req.body as {
      buyer?: string; tokenMint?: string; cancellationContext?: CancellationContext;
    };
    const buyerPk = parsePubkey(buyer);
    const mintPk = parsePubkey(tokenMint);
    if (!buyerPk) return res.status(400).json({ ok: false, error: 'invalid_buyer' });
    if (!mintPk) return res.status(400).json({ ok: false, error: 'invalid_token_mint' });

    try {
      let resolved: { price: number; auctionHouse: string; pdaAddress: string; source: 'me_index' | 'local_context' };
      try {
        resolved = await resolveOfferForCancelOrChangePrice(meGet, mintPk.toBase58(), buyerPk.toBase58(), cancellationContext);
      } catch {
        return res.status(404).json({ ok: false, error: 'offer_not_found' });
      }
      const escrowPda = deriveBuyerEscrowPda(resolved.auctionHouse, buyerPk.toBase58());
      if (!escrowPda) return res.status(500).json({ ok: false, error: 'escrow_pda_derivation_failed' });

      const path = `/instructions/buy_cancel?buyer=${buyerPk.toBase58()}&tokenMint=${mintPk.toBase58()}`
        + `&price=${resolved.price}&auctionHouseAddress=${resolved.auctionHouse}`;
      const json = await meGet<MeInstructionResponse>(path);
      const { tx, lastValidBlockHeight } = decodeMeResponse(json);
      if (!tx.recentBlockhash) return res.status(502).json({ ok: false, error: 'me_response_missing_blockhash_data' });

      // Same independent-validation posture as change-price above: the
      // trade-state PDA checked here is whatever THIS fresh response
      // actually references, not a value blindly trusted from the client.
      const ctx: ValidationContext = {
        op: 'cancel',
        expectedBuyer: buyerPk.toBase58(),
        expectedMint: mintPk.toBase58(),
        expectedAuctionHouse: resolved.auctionHouse,
        expectedTradeStatePda: resolved.pdaAddress,
        expectedEscrowPda: escrowPda,
      };
      const validated = validateStructure(tx, ctx, 'absent');

      // Cancel never touches escrow (enforced inside validateStructure) —
      // no SOL-out bound applies; a clean simulate() is still required.
      const sim = await chain.simulateTransaction(tx);
      if (sim.err != null) {
        return res.status(502).json({ ok: false, error: 'preflight_simulation_failed', simErr: sim.err, logs: sim.logs });
      }

      const expiresAt = now() + DIGEST_TTL_MS;
      digestCache.set(validated.messageHash, {
        ctx: { kind: 'bid', ...ctx },
        blockhashInfo: { blockhash: tx.recentBlockhash, lastValidBlockHeight },
        createdAt: now(),
        expiresAt,
      });

      return res.json({
        ok: true,
        tx: serializeUnsignedForClient(validated.tx),
        digest: validated.messageHash,
        expiresAt,
        preflight: { ok: true, logs: sim.logs },
        summary: {
          action: 'cancel',
          buyer: buyerPk.toBase58(),
          tokenMint: mintPk.toBase58(),
          priceSol: resolved.price,
          auctionHouseAddress: resolved.auctionHouse,
          pdaAddress: resolved.pdaAddress,
          resolvedFrom: resolved.source,
          // Explicit — cancelling frees the trade state, it does NOT
          // return the bid's SOL. That stays in the buyer's M2 escrow
          // until a separate withdraw-escrow build/submit.
          escrowUnaffected: true,
        },
      });
    } catch (err) {
      const e = err as MeApiError;
      const msg = e.message ?? String(err);
      console.error('[tools/me-bids] build/cancel error', msg);
      return res.status(e.status ?? 502).json({ ok: false, error: msg });
    }
  });

  // ── Escrow withdrawal (Part 2) ─────────────────────────────────────────
  // Cancelling an offer frees the trade-state account but never touches
  // escrow (see file header / build/cancel above) — this is the ONLY
  // operation that actually moves SOL back toward the buyer's own wallet.

  router.get('/tools/me-bids/escrow-balance', readLimit, authMw, async (req: Request, res: Response) => {
    const wallet = String(req.query.wallet ?? '').trim();
    const auctionHouseAddress = String(req.query.auctionHouseAddress ?? '').trim();
    const walletPk = parsePubkey(wallet);
    const ahPk = parsePubkey(auctionHouseAddress);
    if (!walletPk) return res.status(400).json({ ok: false, error: 'invalid_wallet' });
    if (!ahPk) return res.status(400).json({ ok: false, error: 'invalid_auction_house' });
    try {
      const escrowPda = deriveBuyerEscrowPda(ahPk.toBase58(), walletPk.toBase58());
      if (!escrowPda) return res.status(500).json({ ok: false, error: 'escrow_pda_derivation_failed' });
      // Pure on-chain read (via the same reader build/create uses for its
      // "before" balance) — no Magic Eden API call, so this is available
      // even if ME's indexer or API is degraded.
      const balanceSol = await escrowBalanceReader(escrowPda);
      return res.json({ ok: true, escrowPda, balanceSol });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/me-bids] escrow-balance error', msg);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  router.post('/tools/me-bids/build/withdraw-escrow', buildLimit, authMw, async (req: Request, res: Response) => {
    const { buyer, auctionHouseAddress, amountSol } = req.body as {
      buyer?: string; auctionHouseAddress?: string; amountSol?: number;
    };
    const buyerPk = parsePubkey(buyer);
    const ahPk = parsePubkey(auctionHouseAddress);
    const amount = parsePriceSol(amountSol);
    if (!buyerPk) return res.status(400).json({ ok: false, error: 'invalid_buyer' });
    if (!ahPk) return res.status(400).json({ ok: false, error: 'invalid_auction_house' });
    if (amount == null) return res.status(400).json({ ok: false, error: 'invalid_amount_sol' });

    try {
      const escrowPda = deriveBuyerEscrowPda(ahPk.toBase58(), buyerPk.toBase58());
      if (!escrowPda) return res.status(500).json({ ok: false, error: 'escrow_pda_derivation_failed' });

      const amountLamports = Math.round(amount * 1e9);
      const escrowSolBefore = await escrowBalanceReader(escrowPda).catch(() => null);
      // Cheap pre-check against the last KNOWN balance — the real bound
      // enforced below is the post-simulation measured decrease, since
      // this reading could itself be a few seconds stale.
      if (escrowSolBefore != null && amountLamports > Math.round(escrowSolBefore * 1e9)) {
        return res.status(409).json({
          ok: false,
          error: `withdrawal_exceeds_known_escrow_balance: requested ${amountLamports} lamports, known balance ${Math.round(escrowSolBefore * 1e9)} lamports`,
        });
      }

      const path = `/instructions/withdraw?buyer=${buyerPk.toBase58()}&auctionHouseAddress=${ahPk.toBase58()}&amount=${amount}`;
      const json = await meGet<MeInstructionResponse>(path);
      const { tx, lastValidBlockHeight } = decodeMeResponse(json);
      if (!tx.recentBlockhash) return res.status(502).json({ ok: false, error: 'me_response_missing_blockhash_data' });

      const wctx: WithdrawValidationContext = {
        expectedBuyer: buyerPk.toBase58(),
        expectedAuctionHouse: ahPk.toBase58(),
        expectedEscrowPda: escrowPda,
      };
      const validated = validateWithdrawStructure(tx, wctx, 'absent');

      const preflight = await preflightSimulate(chain, tx, escrowPda);
      if (!preflight.ok) {
        return res.status(502).json({ ok: false, error: 'preflight_simulation_failed', simErr: preflight.err, logs: preflight.logs });
      }
      if (preflight.escrowPostLamports != null) {
        if (escrowSolBefore != null) {
          const preLamports = Math.round(escrowSolBefore * 1e9);
          const decrease = preLamports - preflight.escrowPostLamports;
          if (decrease > amountLamports + 5_000) {
            return res.status(502).json({
              ok: false,
              error: `withdrawal_amount_exceeds_expected: escrow decreased by ${decrease} lamports, expected at most ${amountLamports}`,
            });
          }
        }
        // Escrow can never legitimately go UP during a withdrawal — a
        // no-guessing, direction-only sanity check independent of whether
        // we had a fresh "before" reading.
        if (escrowSolBefore != null && preflight.escrowPostLamports > Math.round(escrowSolBefore * 1e9)) {
          return res.status(502).json({ ok: false, error: 'unexpected_escrow_increase_on_withdraw' });
        }
      }

      const expiresAt = now() + DIGEST_TTL_MS;
      digestCache.set(validated.messageHash, {
        ctx: { kind: 'withdraw', ...wctx },
        blockhashInfo: { blockhash: tx.recentBlockhash, lastValidBlockHeight },
        createdAt: now(),
        expiresAt,
      });

      return res.json({
        ok: true,
        tx: serializeUnsignedForClient(validated.tx),
        digest: validated.messageHash,
        expiresAt,
        preflight: { ok: true, logs: preflight.logs },
        summary: {
          action: 'withdraw-escrow',
          buyer: buyerPk.toBase58(),
          auctionHouseAddress: ahPk.toBase58(),
          escrowPda,
          amountSol: amount,
          escrowBalanceBeforeSol: escrowSolBefore,
          escrowBalanceAfterSimSol: preflight.escrowPostLamports != null ? preflight.escrowPostLamports / 1e9 : null,
        },
      });
    } catch (err) {
      const e = err as MeApiError;
      const msg = e.message ?? String(err);
      console.error('[tools/me-bids] build/withdraw-escrow error', msg);
      return res.status(e.status ?? 502).json({ ok: false, error: msg });
    }
  });

  // User-facing "Simulate" button — re-simulates whatever the client still
  // holds. sigVerify is unconditionally off here since the tx is, by
  // construction, never signed at this point. replaceRecentBlockhash is
  // never explicitly requested and the underlying object is never mutated
  // (see ChainClient doc comment) — this is a read-only state/program
  // check, not a signature check, and the UI says so.
  router.post('/tools/me-bids/simulate', simLimit, authMw, async (req: Request, res: Response) => {
    const { tx } = req.body as { tx?: string };
    if (!tx || typeof tx !== 'string') return res.status(400).json({ ok: false, error: 'missing_tx' });
    let decoded: Transaction;
    try { decoded = decodeLegacyTxFromBase64(tx); } catch (err) {
      return res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
    try {
      const sim = await chain.simulateTransaction(decoded);
      return res.json({ ok: true, err: sim.err, logs: sim.logs, unitsConsumed: sim.unitsConsumed });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/me-bids] simulate error', msg);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  // Real broadcast. Hard-gated server-side by ME_BIDS_ENABLE_LIVE — a
  // browser-side toggle carries no authority here. Never accepts arbitrary
  // client base64.
  router.post('/tools/me-bids/submit', submitLimit, authMw, async (req: Request, res: Response) => {
    if (!liveEnabled) {
      return res.status(403).json({ ok: false, error: 'live_mode_disabled_server_side' });
    }
    const { signedTx, digest } = req.body as { signedTx?: string; digest?: string };
    if (!signedTx || typeof signedTx !== 'string') return res.status(400).json({ ok: false, error: 'missing_signed_tx' });
    if (!digest || typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
      return res.status(400).json({ ok: false, error: 'missing_or_malformed_digest' });
    }

    // Deliberately NOT calling digestCache.cleanup() here — an eager TTL
    // sweep would delete an expired-but-present entry before we can tell
    // "expired" apart from "never existed", collapsing both into the same
    // generic error. The periodic sweep timer and every build/* call's own
    // cleanup() already bound the cache's size; reads here don't need to.
    const entry = digestCache.get(digest);
    if (!entry) return res.status(410).json({ ok: false, error: 'digest_not_found_expired_or_already_used' });
    if (entry.expiresAt < now()) {
      digestCache.delete(digest);
      return res.status(410).json({ ok: false, error: 'digest_expired' });
    }

    let tx: Transaction;
    try { tx = decodeLegacyTxFromBase64(signedTx); } catch (err) {
      // Never echo the raw payload back — just the parse failure reason.
      return res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }

    const recomputed = messageHashHex(tx);
    if (!digestsEqual(recomputed, digest)) {
      // Do NOT delete the original cache entry — this is a different (or
      // tampered) message; the legitimately-built one is still usable.
      return res.status(409).json({ ok: false, error: 'signed_tx_message_does_not_match_digest' });
    }

    // Structurally redundant with the hash check above (recentBlockhash is
    // part of the hashed message, so a hash match already implies this),
    // but kept as an explicit, independently-reasoned check per its own
    // typed error — a canary against any future bug in the hashing path.
    if (tx.recentBlockhash !== entry.blockhashInfo.blockhash) {
      return res.status(409).json({ ok: false, error: 'blockhash_mismatch' });
    }

    let currentBlockHeight: number;
    try {
      currentBlockHeight = await chain.getBlockHeight();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/me-bids] submit getBlockHeight error', msg);
      return res.status(502).json({ ok: false, error: 'block_height_unavailable' });
    }
    const freshness = checkBlockhashFreshness(tx, entry.blockhashInfo, currentBlockHeight, marginBlocks);
    if (!freshness.ok) {
      return res.status(410).json({ ok: false, error: freshness.code, detail: freshness.detail });
    }

    // Single-use: consume the entry now, before doing anything else that
    // could reach RPC, so a duplicate/concurrent request can't race a
    // second submission through — at most one request proceeds past this
    // line for a given digest.
    const consumed = digestCache.consume(digest);
    if (!consumed) {
      return res.status(410).json({ ok: false, error: 'digest_not_found_expired_or_already_used' });
    }

    try {
      if (entry.ctx.kind === 'bid') {
        validateStructure(tx, entry.ctx, 'present');
      } else {
        validateWithdrawStructure(tx, entry.ctx, 'present');
      }
    } catch (err) {
      return res.status(409).json({ ok: false, error: `revalidation_failed: ${err instanceof Error ? err.message : String(err)}` });
    }

    // Cryptographic signature verification — the actual security boundary,
    // not just a courtesy check before letting RPC preflight do it. Fails
    // closed on any signer-shape deviation from the verified 1-signer,
    // no-cosigner contract (see validateStructure / file header).
    if (tx.signatures.length !== 1 || tx.signatures[0].publicKey.toBase58() !== entry.ctx.expectedBuyer) {
      return res.status(400).json({ ok: false, error: 'unexpected_signer' });
    }
    if (!tx.verifySignatures(true)) {
      return res.status(400).json({ ok: false, error: 'invalid_signature' });
    }

    try {
      const signature = await chain.sendRawTransaction(tx);
      return res.json({ ok: true, signature });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[tools/me-bids] submit sendRawTransaction error', msg);
      return res.status(502).json({ ok: false, error: msg });
    }
  });

  return router;
}
